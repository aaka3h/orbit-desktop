import test from 'node:test';
import assert from 'node:assert/strict';
import { HFAuth } from '../electron/hf-auth';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const device = { device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://huggingface.co/oauth/device', expires_in: 900, interval: 5 };
const validToken = { access_token: 'hf_oauth_private', token_type: 'Bearer', scope: 'profile inference-api', expires_in: 60 };
function harness(responses: (Response | (() => Promise<Response>))[], clientId: string | undefined = 'orbit-owned-client') {
  let time = 100000;
  let token: string | undefined;
  const calls: { url: string; init: RequestInit }[] = [];
  const saved: string[] = [];
  const auth = new HFAuth({ clientId, now: () => time, getToken: () => token,
    saveToken: async value => { token = value; saved.push(value); },
    fetch: (async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      return typeof response === 'function' ? response() : response;
    }) as typeof fetch,
  });
  return { auth, calls, saved, advance: (milliseconds: number) => { time += milliseconds; }, setToken: (value: string) => { token = value; } };
}

test('HF browser login needs a publisher-owned client ID and never invents one', async () => {
  const h = harness([], '');
  assert.deepEqual(await h.auth.status(), { configured: false, connected: false });
  await assert.rejects(h.auth.begin(), /publisher must register/);
  assert.equal(h.calls.length, 0);
});

test('HF device login requests only profile and inference scope and keeps device secret private', async () => {
  const h = harness([json(device)]);
  const login = await h.auth.begin();
  assert.deepEqual(login, { verificationUrl: device.verification_uri, userCode: device.user_code, expiresAt: 1000000, intervalSeconds: 5 });
  const body = new URLSearchParams(h.calls[0].init.body as string);
  assert.equal(body.get('client_id'), 'orbit-owned-client');
  assert.equal(body.get('scope'), 'profile inference-api');
  assert.equal(h.calls[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(login).includes(device.device_code));
  assert.deepEqual(await h.auth.poll(), { state: 'pending' });
  assert.equal(h.calls.length, 1);
});

test('HF polling respects interval, authorization_pending, slow_down and saves only verified tokens', async () => {
  const h = harness([json(device), json({ error: 'authorization_pending' }, 400), json({ error: 'slow_down' }, 400), json(validToken), json({ name: 'orbit-user' })]);
  await h.auth.begin();
  h.advance(5000);
  assert.deepEqual(await h.auth.poll(), { state: 'pending' });
  h.advance(5000);
  assert.deepEqual(await h.auth.poll(), { state: 'pending' });
  h.advance(5000);
  assert.deepEqual(await h.auth.poll(), { state: 'pending' });
  assert.equal(h.calls.length, 3);
  h.advance(5000);
  const result = await h.auth.poll();
  assert.deepEqual(result, { state: 'connected', username: 'orbit-user' });
  assert.deepEqual(h.saved, ['hf_oauth_private']);
  assert.equal(h.calls[4].url, 'https://huggingface.co/api/whoami-v2');
  assert.equal((h.calls[4].init.headers as Record<string, string>).Authorization, 'Bearer hf_oauth_private');
  assert.ok(!JSON.stringify(result).includes('hf_oauth_private'));
  h.advance(60000);
  assert.deepEqual(await h.auth.status(), { configured: true, connected: false });
});

test('HF overlapping poll callers share one network request', async () => {
  let release!: (response: Response) => void;
  const h = harness([json(device), () => new Promise(resolve => { release = resolve; })]);
  await h.auth.begin(); h.advance(5000);
  const one = h.auth.poll();
  const two = h.auth.poll();
  assert.equal(one, two);
  assert.equal(h.calls.length, 2);
  release(json({ error: 'authorization_pending' }, 400));
  await one;
  await two;
});

test('HF cancellation ignores a token arriving after cancellation', async () => {
  let release!: (response: Response) => void;
  const h = harness([json(device), () => new Promise(resolve => { release = resolve; })]);
  await h.auth.begin(); h.advance(5000);
  const pending = h.auth.poll();
  h.auth.cancel();
  release(json(validToken));
  assert.deepEqual(await pending, { state: 'expired' });
  assert.deepEqual(h.saved, []);
  assert.equal(h.calls.length, 2);
});

test('HF device expiry never starts another token request', async () => {
  const h = harness([json(device)]);
  await h.auth.begin(); h.advance(900000);
  assert.deepEqual(await h.auth.poll(), { state: 'expired' });
  assert.equal(h.calls.length, 1);
});

test('HF denial gives a useful error without exposing provider diagnostics', async () => {
  const h = harness([json(device), json({ error: 'access_denied', error_description: 'secret-device-code' }, 400)]);
  await h.auth.begin(); h.advance(5000);
  await assert.rejects(h.auth.poll(), error => error instanceof Error && /declined/.test(error.message) && !error.message.includes('secret'));
  assert.deepEqual(h.saved, []);
  assert.deepEqual(await h.auth.poll(), { state: 'expired' });
});

test('HF invalid account identity and missing inference scope cannot create a connection', async () => {
  const invalid = harness([json(device), json(validToken), json({ error: 'invalid_token' }, 401)]);
  await invalid.auth.begin(); invalid.advance(5000);
  await assert.rejects(invalid.auth.poll(), /verify the new login/);
  assert.deepEqual(invalid.saved, []);
  const scope = harness([json(device), json({ ...validToken, scope: 'profile' })]);
  await scope.auth.begin(); scope.advance(5000);
  await assert.rejects(scope.auth.poll(), /Inference Providers/);
  assert.deepEqual(scope.saved, []);
});

test('HF status verifies saved token even when browser OAuth is not configured', async () => {
  const h = harness([json({ name: 'token-user' }), json({ error: 'expired' }, 401)], '');
  h.setToken('hf_user_token');
  assert.deepEqual(await h.auth.status(), { configured: false, connected: true, username: 'token-user' });
  assert.deepEqual(await h.auth.status(), { configured: false, connected: false });
});

test('HF device links cannot send the user to other origins or embedded credentials', async () => {
  for (const verification_uri of ['https://example.invalid/login', 'http://huggingface.co/oauth/device', 'https://user:password@huggingface.co/oauth/device']) {
    const h = harness([json({ ...device, verification_uri })]);
    await assert.rejects(h.auth.begin(), /unexpected sign-in address/);
  }
});

test('HF invalid responses and network failures redact sensitive details', async () => {
  const h = harness([new Response('secret proxy contents', { status: 502 })]);
  await assert.rejects(h.auth.begin(), /invalid response/);
  const failure = harness([async () => { throw new Error('url includes secret token'); }]);
  await assert.rejects(failure.auth.begin(), error => error instanceof Error && !error.message.includes('secret'));
});
