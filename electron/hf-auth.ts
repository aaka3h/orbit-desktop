// Official public-app device flow: https://huggingface.co/docs/hub/oauth
// The release owner must register their own public OAuth application. No client
// secret, borrowed app identity, browser cookie, or password belongs in Orbit.
const ORIGIN = 'https://huggingface.co';
const SCOPE = 'profile inference-api';
export interface HFAuthOptions {
  clientId?: string;
  getToken: () => string | undefined;
  saveToken: (token: string) => Promise<void>;
  fetch?: typeof fetch;
  /** Injectable clock for deterministic protocol tests. */
  now?: () => number;
}
export interface HFAuthStatus { configured: boolean; connected: boolean; username?: string }
export interface HFDeviceLogin { verificationUrl: string; userCode: string; expiresAt: number; intervalSeconds: number }
export interface HFPollResult { state: 'pending' | 'connected' | 'expired'; username?: string }
interface DeviceSession {
  deviceCode: string; expiresAt: number; nextPollAt: number; intervalMs: number;
  controller: AbortController;
}
type Json = Record<string, unknown>;

export class HFAuth {
  private clientId?: string;
  private fetcher: typeof fetch;
  private now: () => number;
  private session?: DeviceSession;
  private beginning?: AbortController;
  private polling?: Promise<HFPollResult>;
  private connected?: { token: string; username: string; expiresAt?: number };

  constructor(private options: HFAuthOptions) {
    this.clientId = options.clientId?.trim() || undefined;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(endpoint: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; body: Json }> {
    const timeout = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await this.fetcher(`${ORIGIN}${endpoint}`, {
        ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw new Error('Hugging Face sign-in was cancelled.');
      throw new Error('Could not reach Hugging Face. Check your connection and try again.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Hugging Face returned an empty response. Please try again.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new Error('response size'); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('response shape');
      return { response, body: value as Json };
    } catch { throw new Error('Hugging Face returned an invalid response. Please try again.'); }
    finally { reader.releaseLock(); }
  }

  private async username(token: string, signal?: AbortSignal): Promise<string | undefined> {
    const { response, body } = await this.request('/api/whoami-v2', { headers: { Authorization: `Bearer ${token}` } }, signal);
    if (response.status === 401 || response.status === 403) return undefined;
    if (!response.ok) throw new Error('Hugging Face could not verify this account. Please try again.');
    if (typeof body.name !== 'string' || !body.name || body.name.length > 200) throw new Error('Hugging Face did not return a valid account name.');
    return body.name;
  }

  async status(): Promise<HFAuthStatus> {
    const configured = Boolean(this.clientId);
    const token = this.options.getToken();
    if (!token || this.connected?.token === token && this.connected.expiresAt !== undefined && this.now() >= this.connected.expiresAt) {
      return { configured, connected: false };
    }
    const username = await this.username(token);
    return { configured, connected: Boolean(username), ...(username ? { username } : {}) };
  }

  async begin(): Promise<HFDeviceLogin> {
    if (!this.clientId) throw new Error('Browser sign-in is not configured in this build. The app publisher must register a public Hugging Face OAuth app and set ORBIT_HF_CLIENT_ID. You can connect with your own Hugging Face access token instead.');
    this.cancel();
    const controller = new AbortController();
    this.beginning = controller;
    try {
      const { response, body } = await this.request('/oauth/device', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, scope: SCOPE }).toString(),
      }, controller.signal);
      if (!response.ok) throw new Error(body.error === 'invalid_client'
        ? 'Hugging Face rejected this app’s client ID. The publisher must register a public OAuth application.'
        : 'Hugging Face could not start sign-in. Please try again.');
      if (controller.signal.aborted || this.beginning !== controller) throw new Error('Hugging Face sign-in was cancelled.');
      const deviceCode = body.device_code;
      const userCode = body.user_code;
      const expiresIn = body.expires_in;
      const interval = body.interval ?? 5;
      if (typeof deviceCode !== 'string' || !deviceCode || deviceCode.length > 4096 || typeof userCode !== 'string' || !userCode || userCode.length > 128
        || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86400
        || typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0 || interval > 3600) {
        throw new Error('Hugging Face returned invalid device sign-in details.');
      }
      const verificationUrl = new URL(String(body.verification_uri));
      if (verificationUrl.origin !== ORIGIN || verificationUrl.username || verificationUrl.password) throw new Error('Hugging Face returned an unexpected sign-in address.');
      const now = this.now();
      this.session = { deviceCode, expiresAt: now + expiresIn * 1000, nextPollAt: now + interval * 1000, intervalMs: interval * 1000, controller };
      return { verificationUrl: verificationUrl.toString(), userCode, expiresAt: this.session.expiresAt, intervalSeconds: interval };
    } finally { if (this.beginning === controller) this.beginning = undefined; }
  }

  poll(): Promise<HFPollResult> {
    if (this.polling) return this.polling;
    const session = this.session;
    if (!session) {
      const state: HFPollResult = this.connected && this.options.getToken() === this.connected.token
        && (this.connected.expiresAt === undefined || this.now() < this.connected.expiresAt)
        ? { state: 'connected', username: this.connected.username } : { state: 'expired' };
      return Promise.resolve(state);
    }
    if (session.controller.signal.aborted || this.now() >= session.expiresAt) { this.cancel(); return Promise.resolve({ state: 'expired' }); }
    if (this.now() < session.nextPollAt) return Promise.resolve({ state: 'pending' });
    session.nextPollAt = this.now() + session.intervalMs;
    const pending = this.pollSession(session);
    this.polling = pending;
    void pending.finally(() => { if (this.polling === pending) this.polling = undefined; }).catch(() => {});
    return pending;
  }

  private async pollSession(session: DeviceSession): Promise<HFPollResult> {
    try {
      const { response, body } = await this.request('/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: session.deviceCode, client_id: this.clientId! }).toString(),
      }, session.controller.signal);
      if (this.session !== session || session.controller.signal.aborted) return { state: 'expired' };
      if (body.error === 'authorization_pending') return { state: 'pending' };
      if (body.error === 'slow_down' || response.status === 429) {
        session.intervalMs += 5000;
        const retryAfter = Number(response.headers.get('retry-after')) * 1000;
        session.nextPollAt = this.now() + Math.max(session.intervalMs, Number.isFinite(retryAfter) ? retryAfter : 0);
        return { state: 'pending' };
      }
      if (body.error === 'expired_token') { this.cancel(); return { state: 'expired' }; }
      if (body.error === 'access_denied') { this.session = undefined; throw new Error('Hugging Face sign-in was declined. You can try again when ready.'); }
      if (!response.ok || body.error) { this.session = undefined; throw new Error('Hugging Face sign-in failed. Start a new sign-in and try again.'); }
      const token = body.access_token;
      const expiry = body.expires_in;
      if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/.test(token)
        || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
        || expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0)) {
        this.session = undefined; throw new Error('Hugging Face returned an invalid access token. Please sign in again.');
      }
      if (typeof body.scope === 'string' && !body.scope.split(/\s+/).includes('inference-api')) {
        this.session = undefined; throw new Error('Allow Inference Providers access when signing in so Orbit can use hosted models.');
      }
      const username = await this.username(token, session.controller.signal);
      if (this.session !== session || session.controller.signal.aborted) return { state: 'expired' };
      if (!username) { this.session = undefined; throw new Error('Hugging Face could not verify the new login. Please sign in again.'); }
      if (this.now() >= session.expiresAt) { this.cancel(); return { state: 'expired' }; }
      // Refresh credentials are deliberately not collected. Expired OAuth sessions
      // reconnect through this explicit device flow; status also verifies with HF.
      try { await this.options.saveToken(token); }
      catch { this.session = undefined; throw new Error('Orbit could not save the Hugging Face connection securely. Please try again.'); }
      this.connected = { token, username, ...(typeof expiry === 'number' ? { expiresAt: this.now() + expiry * 1000 } : {}) };
      if (this.session === session) this.session = undefined;
      return { state: 'connected', username };
    } catch (error) {
      if (session.controller.signal.aborted) return { state: 'expired' };
      // Back off after connection failures instead of rapid polling.
      session.nextPollAt = this.now() + Math.max(session.intervalMs, 5000);
      throw error instanceof Error ? error : new Error('Hugging Face sign-in failed. Please try again.');
    }
  }

  cancel(): void {
    this.beginning?.abort(); this.beginning = undefined;
    this.session?.controller.abort(); this.session = undefined;
    this.polling = undefined;
    // Cancel stops only the current login, never logs the user out or deletes keys.
  }
}
