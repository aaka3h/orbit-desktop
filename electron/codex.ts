import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ToolCall } from '../shared/types';

// Public app-server protocol: https://learn.chatgpt.com/docs/app-server
// Authentication stays in the user's official Codex installation.
export interface CodexEvent {
  type: 'status' | 'text' | 'tool';
  message: string;
  id?: string;
  status?: 'running' | 'done' | 'denied' | 'error';
}
export interface CodexRunInput {
  prompt: string;
  workspace: string;
  model?: string;
  signal?: AbortSignal;
  onEvent?: (event: CodexEvent) => void;
  onApproval: (request: { call: ToolCall; reason: string }) => Promise<boolean>;
}
export interface CodexStatus { authenticated: boolean; email?: string; plan?: string; method?: string }
type Data = Record<string, any>;
type RpcId = string | number;
type Pending = { resolve: (value: Data) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type ActiveRun = {
  input: CodexRunInput; threadId?: string; turnId?: string;
  messages: Map<string, { text: string; phase?: string }>;
  items: Map<string, Data>;
  resolve: (text: string) => void; reject: (error: Error) => void;
  cleanup: () => void;
};
interface BridgeOptions {
  spawnProcess?: () => Promise<ChildProcessWithoutNullStreams> | ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
}

const missingCli = 'Codex CLI was not found. Install the official Codex CLI, restart Orbit, then choose Connect ChatGPT. Setup: https://learn.chatgpt.com/docs/cli';
const aborted = () => Object.assign(new Error('Codex task stopped.'), { name: 'AbortError' });

/** Resolve binaries without a shell. Windows npm .cmd shims are never executed. */
export async function resolveCodexExecutable(options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string;
  isExecutable?: (filename: string) => Promise<boolean>;
} = {}): Promise<{ command: string; args: string[] }> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const check = options.isExecutable ?? (async (filename: string) => {
    try { await access(filename, windows ? constants.F_OK : constants.X_OK); return (await stat(filename)).isFile(); }
    catch { return false; }
  });
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = [...new Set([
    ...envPath.split(windows ? ';' : ':').filter(Boolean),
    paths.join(home, '.local', 'bin'),
    ...(windows ? [env.APPDATA ? paths.join(env.APPDATA, 'npm') : ''] : ['/opt/homebrew/bin', '/usr/local/bin', paths.join(home, '.npm-global', 'bin')]),
  ].filter(Boolean))];
  for (const directory of directories) {
    const executable = paths.join(directory, windows ? 'codex.exe' : 'codex');
    if (await check(executable)) return { command: executable, args: ['app-server'] };
  }
  if (windows) {
    // npm installs codex.js beside codex.cmd. Invoke the script with Node directly.
    for (const directory of directories) {
      const script = paths.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!await check(script)) continue;
      for (const nodeDirectory of directories) {
        const node = paths.join(nodeDirectory, 'node.exe');
        if (await check(node)) return { command: node, args: [script, 'app-server'] };
      }
    }
  }
  throw new Error(missingCli);
}

export class CodexBridge {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<RpcId, Pending>();
  private approvals = new Map<RpcId, { run: ActiveRun; decline: Data }>();
  private active?: ActiveRun;
  private nextId = 1;
  private buffer = '';
  private loginId?: string;
  private loginError?: string;
  constructor(private options: BridgeOptions = {}) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.launch();
    try { await this.starting; }
    catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  private async launch(): Promise<void> {
    const child = this.options.spawnProcess ? await this.options.spawnProcess() : await (async () => {
      const executable = await resolveCodexExecutable();
      const env = { ...process.env };
      // This connector must never fall back to API billing because Orbit inherited a key.
      for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_FEDERATION_RULE_ID']) delete env[name];
      return spawn(executable.command, executable.args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    })();
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.close(new Error('Codex response exceeded the protocol size limit.')); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.close(new Error('Codex returned invalid app-server JSON. Update the official Codex CLI and try again.')); return; }
      }
    });
    // Drain diagnostics, but do not forward raw stderr (which may contain credentials).
    child.stderr.resume();
    child.stdin.on('error', () => { if (this.child === child) this.close(new Error('Codex connection closed. Please retry.')); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child === child) this.close(new Error(error.code === 'ENOENT' ? missingCli : `Codex could not start: ${error.message}`));
    });
    child.on('exit', () => { if (this.child === child) this.close(new Error('Codex exited before the task finished. Restart or update the official Codex CLI.')); });
    await this.request('initialize', { clientInfo: { name: 'orbit_desktop', title: 'Orbit', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }

  private send(message: Data): void {
    if (!this.child?.stdin.writable) throw new Error('Codex is not connected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Data = {}): Promise<Data> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Check the official CLI and try again.`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async login(): Promise<{ url: string; loginId: string }> {
    await this.start();
    if (this.active) throw new Error('Finish or stop the current Codex task before signing in.');
    if (this.loginId) await this.request('account/login/cancel', { loginId: this.loginId }).catch(() => {});
    this.loginError = undefined;
    const result = await this.request('account/login/start', { type: 'chatgpt' });
    const url = new URL(result.authUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) {
      throw new Error('Codex returned an unexpected login URL. Update the official Codex CLI.');
    }
    if (typeof result.loginId !== 'string') throw new Error('Codex did not return a login session.');
    this.loginId = result.loginId;
    return { url: url.toString(), loginId: result.loginId };
  }

  async status(): Promise<CodexStatus> {
    await this.start();
    if (this.loginError) throw new Error(this.loginError);
    const result = await this.request('account/read', { refreshToken: false });
    const account = result.account;
    return { authenticated: account?.type === 'chatgpt', email: account?.email ?? undefined, plan: account?.planType ?? undefined, method: account?.type ?? undefined };
  }

  async run(input: CodexRunInput): Promise<string> {
    if (!input.prompt.trim()) throw new Error('Enter a task for Codex.');
    if (!path.isAbsolute(input.workspace)) throw new Error('Choose a workspace folder before using Codex.');
    if (input.signal?.aborted) throw aborted();
    if (this.active) throw new Error('A Codex task is already running.');
    await this.start();
    if (input.signal?.aborted) throw aborted();
    if (this.active) throw new Error('A Codex task is already running.');
    const status = await this.status();
    if (!status.authenticated) throw new Error('Connect ChatGPT in Settings first. This provider uses your ChatGPT subscription through the official Codex CLI.');
    if (input.signal?.aborted) throw aborted();
    if (this.active) throw new Error('A Codex task is already running.');

    return new Promise<string>((resolve, reject) => {
      const run: ActiveRun = { input, messages: new Map(), items: new Map(), resolve, reject, cleanup: () => {} };
      this.active = run;
      const abort = () => this.cancel(run);
      input.signal?.addEventListener('abort', abort, { once: true });
      run.cleanup = () => input.signal?.removeEventListener('abort', abort);
      if (input.signal?.aborted) { abort(); return; }
      input.onEvent?.({ type: 'status', message: 'Codex is starting a protected session. Trusted read commands may run automatically; requested changes need your approval.' });
      void (async () => {
        // Read-only by default. Never weaken to danger-full-access or approvalPolicy: never.
        const thread = await this.request('thread/start', {
          cwd: input.workspace, ...(input.model ? { model: input.model } : {}),
          modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user',
        });
        if (this.active !== run) return;
        if (thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess === true || thread.approvalPolicy !== 'untrusted' || thread.approvalsReviewer && thread.approvalsReviewer !== 'user') {
          throw new Error('Codex did not apply Orbit’s protected permission settings. Update the CLI or review managed Codex policies before continuing.');
        }
        run.threadId = thread.thread?.id;
        if (!run.threadId) throw new Error('Codex did not create a conversation.');
        const result = await this.request('turn/start', {
          threadId: run.threadId, input: [{ type: 'text', text: input.prompt }],
          cwd: input.workspace, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
        });
        if (this.active !== run) return;
        run.turnId = result.turn?.id;
        if (!run.turnId) throw new Error('Codex did not start a task.');
        if (input.signal?.aborted) this.cancel(run);
      })().catch(error => { if (this.active === run) this.close(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  private cancel(run: ActiveRun): void {
    if (this.active !== run) return;
    for (const [id, approval] of this.approvals) {
      if (approval.run === run) { this.send({ id, result: approval.decline }); this.approvals.delete(id); }
    }
    if (run.threadId && run.turnId) {
      void this.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
      const timer = setTimeout(() => { if (this.active === run) this.close(aborted()); }, 1500);
      const previous = run.cleanup;
      run.cleanup = () => { clearTimeout(timer); previous(); };
    } else this.close(aborted());
  }

  private receive(message: Data): void {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex: ${message.error.message ?? 'Request failed'}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    const params: Data = message.params ?? {};
    if (message.method === 'account/login/completed') {
      this.loginId = undefined;
      this.loginError = params.success ? undefined : String(params.error ?? 'ChatGPT sign-in did not complete.');
    }
    if (message.id !== undefined && message.method) {
      void this.handleRequest(message.id, message.method, params).catch(() => this.close(new Error('Codex disconnected during a permission request.')));
      return;
    }
    const run = this.active;
    if (!run || params.threadId && params.threadId !== run.threadId) return;
    if (params.turnId && run.turnId && params.turnId !== run.turnId) return;
    if (message.method === 'turn/started' && params.turn?.id) run.turnId = params.turn.id;
    if (message.method === 'item/agentMessage/delta') {
      const id = String(params.itemId ?? 'response');
      const old = run.messages.get(id) ?? { text: '' };
      const delta = String(params.delta ?? '');
      run.messages.set(id, { ...old, text: old.text + delta });
      run.input.onEvent?.({ type: 'text', message: delta, id });
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item: Data = params.item ?? {};
      if (typeof item.id !== 'string') return;
      run.items.set(item.id, item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        run.messages.set(item.id, { text: item.text, phase: item.phase });
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) {
        const status = message.method === 'item/started' ? 'running' : item.status === 'declined' ? 'denied' : item.status === 'failed' ? 'error' : 'done';
        run.input.onEvent?.({ type: 'tool', id: item.id, status, message: String(item.command ?? item.tool ?? (item.type === 'fileChange' ? 'Codex file changes' : 'Codex web search')) });
      }
    }
    if (message.method === 'warning') run.input.onEvent?.({ type: 'status', message: String(params.message ?? 'Codex warning') });
    if (message.method === 'turn/completed') {
      if (run.turnId && params.turn?.id && params.turn.id !== run.turnId) return;
      run.cleanup(); this.active = undefined;
      for (const [id, approval] of this.approvals) if (approval.run === run) this.approvals.delete(id);
      if (run.input.signal?.aborted || params.turn?.status === 'interrupted') run.reject(aborted());
      else if (params.turn?.status === 'failed') run.reject(new Error(params.turn.error?.message ?? 'Codex task failed.'));
      else {
        const messages = [...run.messages.values()];
        const finals = messages.filter(item => item.phase === 'final_answer');
        run.resolve((finals.length ? finals : messages).map(item => item.text).filter(Boolean).join('\n\n') || 'Codex completed the task without a text response.');
      }
    }
  }

  private async handleRequest(id: RpcId, method: string, params: Data): Promise<void> {
    const run = this.active;
    const command = method === 'item/commandExecution/requestApproval';
    const file = method === 'item/fileChange/requestApproval';
    const permission = method === 'item/permissions/requestApproval';
    const decline = permission ? { permissions: {} } : { decision: 'decline' };
    if (!(command || file || permission)) {
      // Fail closed: unsupported tools, forms, and server requests never execute in Orbit.
      this.send({ id, error: { code: -32601, message: `Orbit does not support ${method}.` } });
      return;
    }
    if (!run || run.input.signal?.aborted || params.threadId !== run.threadId || run.turnId && params.turnId !== run.turnId) {
      this.send({ id, result: decline }); return;
    }
    const item = run.items.get(params.itemId) ?? {};
    if (file && !Array.isArray(item.changes) || command && !params.command && !item.command && !params.networkApprovalContext || permission && (!params.permissions || typeof params.permissions !== 'object')) {
      this.send({ id, result: decline });
      run.input.onEvent?.({ type: 'status', message: 'A Codex permission request was declined because its action preview was incomplete.' });
      return;
    }
    const call: ToolCall = {
      id: `codex-${id}`, name: command ? 'codex_command' : file ? 'codex_file_change' : 'codex_permissions',
      arguments: command ? { command: params.command ?? item.command, cwd: params.cwd ?? item.cwd, network: params.networkApprovalContext, additionalPermissions: params.additionalPermissions }
        : file ? { changes: item.changes ?? [], grantRoot: params.grantRoot }
        : { permissions: params.permissions, cwd: params.cwd },
    };
    this.approvals.set(id, { run, decline });
    let approved = false;
    try { approved = await run.input.onApproval({ call, reason: String(params.reason ?? 'Codex is requesting permission for this action. Review its full scope before allowing it.') }); }
    catch { approved = false; }
    if (!this.approvals.has(id) || this.active !== run) return;
    this.approvals.delete(id);
    try {
      this.send({ id, result: permission ? { permissions: approved ? (params.permissions ?? {}) : {}, scope: 'turn' } : { decision: approved ? 'accept' : 'decline' } });
    } catch { this.close(new Error('Codex disconnected while waiting for approval.')); }
  }

  close(error = new Error('Codex connection closed.')): void {
    const child = this.child;
    this.child = undefined; this.starting = undefined; this.buffer = ''; this.loginId = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.approvals.clear();
    const run = this.active; this.active = undefined;
    if (run) { run.cleanup(); run.reject(error); }
    if (child && !child.killed) { child.stdin.end(); child.kill(); }
  }
}

const bridge = new CodexBridge();
export const codexLogin = () => bridge.login();
export const codexStatus = () => bridge.status();
export const runCodex = (input: CodexRunInput) => bridge.run(input);
export const closeCodex = () => bridge.close();
