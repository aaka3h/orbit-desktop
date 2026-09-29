import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { BrowserController, publicBrowserAddress } from '../electron/browser';
import type { ToolCall } from '../shared/types';

const signal = () => new AbortController().signal;
const call = (args: Record<string, unknown>): ToolCall => ({ id: 'fixture-call', name: 'browser', arguments: args });

async function browserBinary(): Promise<string | undefined> {
  const candidates = [process.env.ORBIT_TEST_BROWSER, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ...(process.env.PROGRAMFILES ? [path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    ...(process.env['PROGRAMFILES(X86)'] ? [path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
  ].filter((value): value is string => !!value);
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch { /* Missing optional local browser. */ } }
  return undefined;
}

test('browser network checks reject private, reserved and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.2', '169.254.169.254', '100.64.1.2', '0.0.0.0', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(publicBrowserAddress(ip), false, ip);
  assert.equal(publicBrowserAddress('8.8.8.8'), true);
  assert.equal(publicBrowserAddress('2606:4700:4700::1111'), true);
});

test('local origin and custom binary overrides require explicit isolated-test mode', () => {
  const root = path.resolve(os.tmpdir(), 'orbit-browser-options');
  assert.throws(() => new BrowserController(root, { testOrigins: ['http://127.0.0.1:1234'] }), /isolated tests/);
  assert.throws(() => new BrowserController(root, { executablePath: '/some/browser' }), /isolated tests/);
  assert.throws(() => new BrowserController(root, { testing: true, testOrigins: ['https://example.com'] }), /loopback/);
  assert.throws(() => new BrowserController('relative-profile'), /absolute/);
});

test('real browser fixture: approvals, sanitized reads, stale refs, private redirects, and cancellation', async t => {
  const executablePath = await browserBinary();
  if (!executablePath) {
    if (process.env.ORBIT_BROWSER_REQUIRE === '1') throw new Error('Browser smoke requires an installed Chrome/Edge/Chromium. Set ORBIT_TEST_BROWSER to its executable.');
    t.skip('No installed browser available; run npm browser smoke with ORBIT_TEST_BROWSER on a desktop.'); return;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-browser-test-'));
  let privateRequests = 0, submissions = 0;
  const privateServer = http.createServer((_request, response) => { privateRequests++; response.end('Private destination must remain unreachable'); });
  privateServer.listen(0, '127.0.0.1'); await once(privateServer, 'listening');
  const privatePort = (privateServer.address() as import('node:net').AddressInfo).port;
  let origin = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', origin || 'http://fixture.invalid');
    if (url.pathname === '/slow') return;
    if (url.pathname === '/private-redirect') { response.writeHead(302, { Location: `http://127.0.0.1:${privatePort}/private` }); response.end(); return; }
    if (url.pathname === '/submit') { submissions++; response.end('<h1>Fixture order submitted</h1>'); return; }
    if (url.pathname === '/second') { response.end('<h1>Second page</h1><a href="/">Home</a>'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><title>Phone research fixture</title></head><body>
      <main><h1>Test phone shop</h1><p>Phone A costs 100 test credits.</p>
      <input id="search" aria-label="Search phones" value="HIDDEN-INPUT-VALUE">
      <button id="search-button" onclick="document.querySelector('#results').textContent='Search completed'">Search</button><p id="results"></p>
      <a id="product" href="/second">Phone details</a><a href="/second" target="_blank">Open phone in new tab</a>
      <button id="change" onclick="document.querySelector('#product').textContent='Changed target';document.querySelector('#product').href='/submit'">Change target</button>
      <label>Password<input type="password" value="PASSWORD-FIXTURE-SECRET"></label>
      <input aria-label="Card number" autocomplete="cc-number" value="CARD-FIXTURE-SECRET">
      <textarea aria-label="Notes">TEXTAREA-FIXTURE-SECRET</textarea>
      <div contenteditable="true">EDITABLE-FIXTURE-SECRET</div>
      <div style="display:none">DISPLAY-HIDDEN-SECRET</div><div style="opacity:0">OPACITY-HIDDEN-SECRET</div>
      <input type="file" aria-label="Upload a file"><a href="/second" download>Download receipt</a>
      <form action="/submit"><p>Total: 100 test credits.</p><button type="submit">Place order</button></form>
      <a href="http://127.0.0.1:${privatePort}/private">Private link</a>
      <a href="/private-redirect">Private redirect</a>
      <button onclick="window.open('http://127.0.0.1:${privatePort}/private','_blank')">Private popup</button>
      <button onclick="fetch('http://127.0.0.1:${privatePort}/private').catch(()=>{})">Private request</button>
      </main></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const browser = new BrowserController(directory, { testing: true, headless: true, executablePath, testOrigins: [origin] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); privateServer.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => privateServer.close(() => resolve()))]); await fs.rm(directory, { recursive: true, force: true }); });
  const act = async (args: Record<string, unknown>, abort = signal()) => browser.executePrepared(await browser.prepare(call(args), abort), abort);
  const read = async () => JSON.parse((await act({ action: 'read' })).content);
  const find = (snapshot: any, label: string) => {
    const element = snapshot.elements.find((item: any) => item.label === label);
    assert.ok(element, `Missing fixture element ${label}`); return element.ref as string;
  };
  await browser.open('chromium');

  await t.test('prepare does not navigate; execution consumes one exact approved token', async () => {
    const prepared = await browser.prepare(call({ action: 'navigate', url: origin }), signal());
    assert.match(prepared.details, /Open:/);
    assert.equal((await browser.status()).tabs[0].url, 'about:blank');
    await browser.executePrepared(prepared, signal());
    assert.equal(new URL((await browser.status()).tabs[0].url).origin, origin);
    await assert.rejects(browser.executePrepared(prepared, signal()), /invalid or expired/);
    const second = await browser.prepare(call({ action: 'read' }), signal());
    await assert.rejects(browser.executePrepared({ ...second, details: 'tampered' }, signal()), /invalid or expired/);
  });

  await t.test('snapshot exposes visible text and refs, omitting every field value and sensitive control', async () => {
    const snapshot = await read();
    assert.match(snapshot.text, /Phone A costs 100 test credits/);
    for (const secret of ['HIDDEN-INPUT-VALUE', 'PASSWORD-FIXTURE-SECRET', 'CARD-FIXTURE-SECRET', 'TEXTAREA-FIXTURE-SECRET', 'EDITABLE-FIXTURE-SECRET', 'DISPLAY-HIDDEN-SECRET', 'OPACITY-HIDDEN-SECRET']) assert.ok(!JSON.stringify(snapshot).includes(secret), secret);
    assert.ok(snapshot.elements.every((item: any) => !['Password', 'Card number', 'Upload a file', 'Download receipt'].includes(item.label)));
    assert.ok(find(snapshot, 'Search phones'));
    assert.ok(find(snapshot, 'Phone details'));
  });

  await t.test('typing is approval-bound and stale refs are invalidated after a change', async () => {
    const snapshot = await read(), ref = find(snapshot, 'Search phones');
    const prepared = await browser.prepare(call({ action: 'type', ref, text: 'phone under 100' }), signal());
    assert.match(prepared.details, /phone under 100/);
    await browser.executePrepared(prepared, signal());
    await assert.rejects(browser.prepare(call({ action: 'type', ref, text: 'changed again' }), signal()), /stale/);
    const refreshed = await read();
    assert.ok(!JSON.stringify(refreshed).includes('phone under 100'));
    await act({ action: 'click', ref: find(refreshed, 'Search') });
    assert.match((await read()).text, /Search completed/);
  });

  await t.test('target changes while awaiting approval fail closed', async () => {
    await act({ action: 'navigate', url: origin });
    const snapshot = await read();
    const prepared = await browser.prepare(call({ action: 'click', ref: find(snapshot, 'Phone details') }), signal());
    await act({ action: 'click', ref: find(snapshot, 'Change target') });
    await assert.rejects(browser.executePrepared(prepared, signal()), /target changed/);
    assert.equal(submissions, 0);
  });

  await t.test('checkout actions carry purchase classification and exact visible context', async () => {
    await act({ action: 'navigate', url: origin });
    const snapshot = await read();
    const prepared = await browser.prepare(call({ action: 'click', ref: find(snapshot, 'Place order') }), signal());
    assert.equal(prepared.kind, 'purchase');
    assert.match(prepared.details, /Total: 100 test credits/);
    assert.equal(submissions, 0, 'Preparing purchase must not submit a form');
    // The local fixture purchase is intentionally left unapproved/unexecuted.
  });

  await t.test('non-web protocols, private destinations, downloads and fabricated refs cannot be approved', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,bad', `http://127.0.0.1:${privatePort}/private`, 'http://169.254.169.254/', 'http://localhost.invalid.local/', 'https://name:password@example.com/']) await assert.rejects(browser.prepare(call({ action: 'navigate', url }), signal()), /public|private|blocked/);
    await assert.rejects(browser.prepare(call({ action: 'click', ref: 'el-invented' }), signal()), /stale/);
    const snapshot = await read();
    await assert.rejects(browser.prepare(call({ action: 'click', ref: find(snapshot, 'Private link') }), signal()), /private/);
  });

  await t.test('background fetches, popups and redirects to non-allowlisted loopback never reach the server', async () => {
    await act({ action: 'click', ref: find(await read(), 'Private request') });
    await act({ action: 'click', ref: find(await read(), 'Private popup') });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(privateRequests, 0);
    await assert.rejects(act({ action: 'navigate', url: `${origin}/private-redirect` }));
    assert.equal(privateRequests, 0);
    await act({ action: 'navigate', url: origin });
  });

  await t.test('tabs expose stable IDs, and back approval resolves the actual destination', async () => {
    await act({ action: 'navigate', url: `${origin}/second` });
    const prepared = await browser.prepare(call({ action: 'back' }), signal());
    assert.match(prepared.details, new RegExp(`Back to: ${origin}/`));
    await browser.executePrepared(prepared, signal());
    assert.match((await read()).text, /Test phone shop/);
    await act({ action: 'click', ref: find(await read(), 'Open phone in new tab') });
    const tabs = JSON.parse((await act({ action: 'tabs' })).content).tabs;
    const second = tabs.find((tab: any) => tab.url === `${origin}/second`);
    assert.ok(second);
    await act({ action: 'select_tab', tabId: second.id });
    assert.match((await read()).text, /Second page/);
  });

  await t.test('cancelling an in-flight navigation closes the owned browser', async () => {
    const controller = new AbortController();
    const prepared = await browser.prepare(call({ action: 'navigate', url: `${origin}/slow` }), controller.signal);
    const running = browser.executePrepared(prepared, controller.signal);
    const rejection = assert.rejects(running, /cancelled/);
    setTimeout(() => controller.abort(), 100);
    await rejection;
    assert.equal((await browser.status()).running, false);
  });
});
