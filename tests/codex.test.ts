import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexBridge, resolveCodexExecutable, type CodexEvent } from '../electron/codex';
import type { ToolCall, ToolSpec } from '../shared/types';

type Data = Record<string, any>;
function mockServer(options: { account?: Data; authUrl?: string; sandbox?: string; noInitialize?: boolean } = {}) {
  const messages: Data[] = [];
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killCount = 0;
  const send = (message: Data) => stdout.write(`${JSON.stringify(message)}\n`);
  const stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      messages.push(request);
      if (request.id !== undefined && request.method) setImmediate(() => {
        if (request.method === 'initialize' && !options.noInitialize) send({ id: request.id, result: {} });
        if (request.method === 'account/read') send({ id: request.id, result: { account: options.account ?? { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' } } });
        if (request.method === 'account/login/start') send({ id: request.id, result: { authUrl: options.authUrl ?? 'https://auth.openai.com/authorize?state=test', loginId: 'login-1' } });
        if (request.method === 'account/login/cancel') send({ id: request.id, result: {} });
        if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' }, sandbox: { type: options.sandbox ?? 'readOnly' }, approvalPolicy: 'untrusted', approvalsReviewer: 'user' } });
        if (request.method === 'turn/start') {
          send({ id: request.id, result: { turn: { id: 'turn-1' } } });
          send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
        }
        if (request.method === 'turn/interrupt') {
          send({ id: request.id, result: {} });
          send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
        }
      });
    }
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, killed: false, kill: () => { killCount++; Object.assign(child, { killed: true }); return true; } });
  const bridge = new CodexBridge({ spawnProcess: () => child, requestTimeoutMs: 200 });
  return { bridge, child, send, messages, killed: () => killCount,
    event: (method: string, data: Data = {}) => send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...data } }),
    approval: (id: number, method: string, data: Data = {}) => send({ id, method, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', ...data } }),
  };
}
async function until(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 1000) throw new Error('Mock protocol condition timed out');
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const input = { prompt: 'Summarize this folder', workspace: process.cwd(), onApproval: async () => false };

test('Codex uses one initialized connection and reports only ChatGPT subscription auth', async () => {
  const mock = mockServer();
  try {
    assert.deepEqual(await mock.bridge.status(), { authenticated: true, email: 'test@example.invalid', plan: 'plus', method: 'chatgpt' });
    await mock.bridge.status();
    assert.deepEqual(mock.messages.slice(0, 3).map(x => x.method), ['initialize', 'initialized', 'account/read']);
    assert.equal(mock.messages.filter(x => x.method === 'initialize').length, 1);
  } finally { mock.bridge.close(); }
});

test('Codex login delegates OAuth to the official CLI and rejects unexpected login hosts', async () => {
  const mock = mockServer();
  const bad = mockServer({ authUrl: 'https://example.invalid/phishing' });
  try {
    assert.equal((await mock.bridge.login()).loginId, 'login-1');
    assert.deepEqual(mock.messages.find(x => x.method === 'account/login/start')?.params, { type: 'chatgpt' });
    await assert.rejects(bad.bridge.login(), /unexpected login URL/);
  } finally { mock.bridge.close(); bad.bridge.close(); }
});

test('API-key account cannot silently bill a subscription run', async () => {
  const mock = mockServer({ account: { type: 'apiKey' } });
  try {
    await assert.rejects(mock.bridge.run(input), /Connect ChatGPT/);
    assert.equal(mock.messages.some(x => x.method === 'thread/start'), false);
  } finally { mock.bridge.close(); }
});

test('Codex sends prompts as JSON data and preserves restrictive runtime permissions', async () => {
  const mock = mockServer();
  const events: CodexEvent[] = [];
  try {
    const prompt = 'Literal text: $(touch nope); `whoami` & echo hello';
    const result = mock.bridge.run({ ...input, prompt, onEvent: event => events.push(event) });
    await until(() => mock.messages.some(x => x.method === 'turn/start'));
    const thread = mock.messages.find(x => x.method === 'thread/start')!.params;
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.approvalPolicy, 'untrusted');
    assert.equal(thread.approvalsReviewer, 'user');
    assert.equal(thread.modelProvider, 'openai');
    assert.equal(thread.dynamicTools, undefined);
    const turn = mock.messages.find(x => x.method === 'turn/start')!.params;
    assert.equal(turn.input[0].text, prompt);
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    mock.event('item/completed', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'Looking at files.' } });
    mock.event('item/agentMessage/delta', { itemId: 'answer', delta: 'Complete' });
    mock.event('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Completed analysis.' } });
    mock.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    assert.equal(await result, 'Completed analysis.');
    assert.ok(events.some(event => event.type === 'text' && event.message === 'Complete'));
  } finally { mock.bridge.close(); }
});

test('Codex refuses a server permission downgrade before submitting the task', async () => {
  const mock = mockServer({ sandbox: 'dangerFullAccess' });
  try {
    await assert.rejects(mock.bridge.run(input), /protected permission settings/);
    assert.equal(mock.messages.some(x => x.method === 'turn/start'), false);
    assert.equal(mock.killed(), 1);
  } finally { mock.bridge.close(); }
});

test('File approvals include the actual diff and permit only the requested action', async () => {
  const mock = mockServer();
  let approval: Data | undefined;
  try {
    const result = mock.bridge.run({ ...input, onApproval: async request => { approval = request; return true; } });
    await until(() => mock.messages.some(x => x.method === 'turn/start'));
    await new Promise<void>(resolve => setImmediate(resolve));
    mock.event('item/started', { item: { id: 'item-1', type: 'fileChange', changes: [{ path: 'notes.md', diff: '+hello' }] } });
    mock.approval(400, 'item/fileChange/requestApproval', { reason: 'Create the requested note.' });
    await until(() => mock.messages.some(x => x.id === 400));
    assert.equal(approval?.call.arguments.changes[0].diff, '+hello');
    assert.deepEqual(mock.messages.find(x => x.id === 400)?.result, { decision: 'accept' });
    mock.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await result;
  } finally { mock.bridge.close(); }
});

test('Unrelated approval requests and unknown tools fail closed', async () => {
  const mock = mockServer();
  let approvals = 0;
  try {
    const result = mock.bridge.run({ ...input, onApproval: async () => { approvals++; return true; } });
    await until(() => mock.messages.some(x => x.method === 'turn/start'));
    await new Promise<void>(resolve => setImmediate(resolve));
    mock.approval(500, 'item/commandExecution/requestApproval', { threadId: 'unrelated', command: 'delete something' });
    mock.approval(501, 'item/tool/call', { tool: 'unknown' });
    mock.approval(502, 'unknown/server/request');
    await until(() => mock.messages.some(x => x.id === 502));
    assert.deepEqual(mock.messages.find(x => x.id === 500)?.result, { decision: 'decline' });
    assert.equal(mock.messages.find(x => x.id === 501)?.result.success, false);
    assert.equal(mock.messages.find(x => x.id === 502)?.error.code, -32601);
    assert.equal(approvals, 0);
    mock.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await result;
  } finally { mock.bridge.close(); }
});

test('Stopping while an approval is pending declines it and ignores a late approval', async () => {
  const mock = mockServer();
  const controller = new AbortController();
  let decide: ((value: boolean) => void) | undefined;
  try {
    const result = mock.bridge.run({ ...input, signal: controller.signal, onApproval: () => new Promise(resolve => { decide = resolve; }) });
    const rejection = assert.rejects(result, { name: 'AbortError' });
    await until(() => mock.messages.some(x => x.method === 'turn/start'));
    await new Promise<void>(resolve => setImmediate(resolve));
    mock.approval(600, 'item/commandExecution/requestApproval', { command: 'write a file' });
    await until(() => Boolean(decide));
    controller.abort();
    decide!(true);
    await rejection;
    assert.deepEqual(mock.messages.filter(x => x.id === 600).map(x => x.result), [{ decision: 'decline' }]);
    assert.ok(mock.messages.some(x => x.method === 'turn/interrupt'));
  } finally { mock.bridge.close(); }
});

test('Codex protocol failures and exit do not leave requests hanging', async () => {
  const timeout = mockServer({ noInitialize: true });
  try { await assert.rejects(timeout.bridge.start(), /timed out/); }
  finally { timeout.bridge.close(); }
  const mock = mockServer();
  try {
    const result = mock.bridge.run(input);
    const rejection = assert.rejects(result, /exited/);
    await until(() => mock.messages.some(x => x.method === 'turn/start'));
    mock.child.emit('exit', 1);
    await rejection;
  } finally { mock.bridge.close(); }
});

test('Windows npm launch resolves Node and codex.js without invoking a .cmd shell', async () => {
  const available = new Set([
    'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
    'C:\\Program Files\\nodejs\\node.exe',
  ]);
  const executable = await resolveCodexExecutable({
    platform: 'win32', home: 'C:\\Users\\test',
    env: { Path: 'C:\\Program Files\\nodejs', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    isExecutable: async filename => available.has(filename),
  });
  assert.equal(executable.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(executable.args, ['C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'app-server']);
  await assert.rejects(resolveCodexExecutable({ env: { PATH: '' }, isExecutable: async () => false }), /Install the official Codex CLI/);
});

const readTool: ToolSpec = { name: 'read_file', description: 'Read a workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
async function ready(mock: ReturnType<typeof mockServer>) {
  await until(() => mock.messages.some(x => x.method === 'turn/start'));
  await new Promise<void>(resolve => setImmediate(resolve));
}
function toolRequest(mock: ReturnType<typeof mockServer>, id: number, data: Data = {}) {
  mock.approval(id, 'item/tool/call', { namespace: 'orbit', callId: `call-${id}`, tool: 'read_file', arguments: { path: 'sample.txt' }, ...data });
}
function complete(mock: ReturnType<typeof mockServer>) {
  mock.event('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
}

test('Codex registers the enabled Orbit namespace and returns actual text and screenshot content', async () => {
  const mock = mockServer();
  const calls: ToolCall[] = [];
  const screenshot = 'data:image/png;base64,aGVsbG8=';
  try {
    const result = mock.bridge.run({ ...input, dynamicTools: [readTool], onToolCall: async (call, signal) => {
      assert.equal(signal.aborted, false);
      calls.push(call); return { content: 'Fixture content: BLUE-PINE-42', images: [screenshot] };
    } });
    await ready(mock);
    assert.deepEqual(mock.messages.find(x => x.method === 'initialize')?.params.capabilities, { experimentalApi: true });
    assert.deepEqual(mock.messages.find(x => x.method === 'thread/start')?.params.config, { 'features.shell_tool': false, 'features.multi_agent': false, 'features.apps': false, web_search: 'disabled' });
    assert.deepEqual(mock.messages.find(x => x.method === 'thread/start')?.params.dynamicTools, [{ type: 'namespace', name: 'orbit', description: 'Enabled tools provided by the Orbit desktop host. Each action follows Orbit permissions and approval prompts.', tools: [{ type: 'function', name: 'read_file', description: readTool.description, inputSchema: readTool.parameters }] }]);
    toolRequest(mock, 700);
    await until(() => mock.messages.some(x => x.id === 700));
    assert.deepEqual(calls, [{ id: 'codex-tool-call-700', name: 'read_file', arguments: { path: 'sample.txt' } }]);
    assert.deepEqual(mock.messages.find(x => x.id === 700)?.result, { success: true, contentItems: [{ type: 'inputText', text: 'Fixture content: BLUE-PINE-42' }, { type: 'inputImage', imageUrl: screenshot }] });
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});

test('Codex rejects disabled, cross-turn, malformed and replayed tool calls before host execution', async () => {
  const mock = mockServer();
  let calls = 0;
  try {
    const result = mock.bridge.run({ ...input, dynamicTools: [readTool], onToolCall: async () => { calls++; return { content: 'read' }; } });
    await ready(mock);
    const invalid: Data[] = [
      { tool: 'computer' }, { namespace: null }, { namespace: 'other' }, { threadId: 'other' }, { turnId: 'other' },
      { arguments: null }, { arguments: [] }, { arguments: {} }, { arguments: { path: 42 } },
      { arguments: { path: 'sample.txt', command: 'write something' } }, { callId: '' },
      { arguments: JSON.parse('{"path":"sample.txt","__proto__":{"bad":true}}') },
    ];
    invalid.forEach((data, index) => toolRequest(mock, 710 + index, data));
    await until(() => invalid.every((_, index) => mock.messages.some(x => x.id === 710 + index)));
    assert.equal(calls, 0);
    assert.ok(invalid.every((_, index) => mock.messages.find(x => x.id === 710 + index)?.result.success === false));
    toolRequest(mock, 730, { callId: 'once-only' });
    await until(() => mock.messages.some(x => x.id === 730));
    toolRequest(mock, 731, { callId: 'once-only' });
    await until(() => mock.messages.some(x => x.id === 731));
    assert.equal(calls, 1);
    assert.equal(mock.messages.find(x => x.id === 731)?.result.success, false);
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});

test('Codex snapshots enabled tools so later settings edits cannot expand a running task', async () => {
  const mock = mockServer();
  const schema: ToolSpec = structuredClone(readTool);
  const dynamicTools = [schema];
  let calls = 0;
  try {
    const result = mock.bridge.run({ ...input, dynamicTools, onToolCall: async () => { calls++; return { content: 'ok' }; } });
    schema.parameters.required = [];
    dynamicTools.push({ ...readTool, name: 'write_file' });
    await ready(mock);
    const registered = mock.messages.find(x => x.method === 'thread/start')!.params.dynamicTools[0].tools;
    assert.equal(registered.length, 1);
    assert.deepEqual(registered[0].inputSchema.required, ['path']);
    toolRequest(mock, 740, { tool: 'write_file' });
    toolRequest(mock, 741, { arguments: {} });
    await until(() => mock.messages.some(x => x.id === 741));
    assert.equal(calls, 0);
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});

test('Codex serializes dynamic calls and stopping prevents queued execution and late success', async () => {
  const mock = mockServer();
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const calls: string[] = [];
  let toolSignal: AbortSignal | undefined;
  try {
    const result = mock.bridge.run({ ...input, signal: controller.signal, dynamicTools: [readTool], onToolCall: async (call, signal) => {
      calls.push(call.id); toolSignal = signal;
      await new Promise<void>(resolve => { release = resolve; });
      signal.throwIfAborted();
      return { content: 'late output' };
    } });
    const rejection = assert.rejects(result, { name: 'AbortError' });
    await ready(mock);
    toolRequest(mock, 750); toolRequest(mock, 751);
    await until(() => Boolean(release));
    assert.equal(calls.length, 1);
    controller.abort();
    assert.equal(toolSignal?.aborted, true);
    release!();
    await rejection;
    assert.equal(calls.length, 1);
    for (const id of [750, 751]) {
      const replies = mock.messages.filter(x => x.id === id);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].result.success, false);
    }
  } finally { mock.bridge.close(); }
});

test('Codex runs queued calls in order and a denied action does not become successful output', async () => {
  const mock = mockServer();
  let release: (() => void) | undefined;
  const calls: string[] = [];
  try {
    const result = mock.bridge.run({ ...input, dynamicTools: [readTool], onToolCall: async call => {
      calls.push(call.id);
      if (calls.length === 1) { await new Promise<void>(resolve => { release = resolve; }); throw new Error('User declined this action.'); }
      return { content: 'second completed' };
    } });
    await ready(mock);
    toolRequest(mock, 760); toolRequest(mock, 761);
    await until(() => Boolean(release));
    assert.equal(calls.length, 1);
    release!();
    await until(() => mock.messages.some(x => x.id === 761));
    assert.deepEqual(calls, ['codex-tool-call-760', 'codex-tool-call-761']);
    assert.equal(mock.messages.find(x => x.id === 760)?.result.success, false);
    assert.match(mock.messages.find(x => x.id === 760)?.result.contentItems[0].text, /declined/);
    assert.equal(mock.messages.find(x => x.id === 761)?.result.success, true);
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});

test('Turn completion aborts the host tool signal and discards its late output', async () => {
  const mock = mockServer();
  let release: (() => void) | undefined;
  let toolSignal: AbortSignal | undefined;
  try {
    const result = mock.bridge.run({ ...input, dynamicTools: [readTool], onToolCall: async (_call, signal) => {
      toolSignal = signal; await new Promise<void>(resolve => { release = resolve; }); return { content: 'late' };
    } });
    await ready(mock); toolRequest(mock, 770);
    await until(() => Boolean(release));
    complete(mock); await result;
    assert.equal(toolSignal?.aborted, true);
    release!(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(mock.messages.some(x => x.id === 770), false);
  } finally { mock.bridge.close(); }
});

test('Remote screenshot URLs and invalid tool registries fail closed', async () => {
  const mock = mockServer();
  try {
    await assert.rejects(mock.bridge.run({ ...input, dynamicTools: [readTool] }), /callback/);
    await assert.rejects(mock.bridge.run({ ...input, dynamicTools: [readTool, readTool], onToolCall: async () => ({ content: '' }) }), /duplicate/);
    const result = mock.bridge.run({ ...input, dynamicTools: [readTool], onToolCall: async () => ({ content: 'image', images: ['https://example.invalid/private'] }) });
    await ready(mock); toolRequest(mock, 780);
    await until(() => mock.messages.some(x => x.id === 780));
    assert.equal(mock.messages.find(x => x.id === 780)?.result.success, false);
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});

test('An explicit empty Orbit registry still disables documented alternate native tool routes', async () => {
  const mock = mockServer();
  try {
    const result = mock.bridge.run({ ...input, dynamicTools: [] });
    await ready(mock);
    const thread = mock.messages.find(x => x.method === 'thread/start')!.params;
    assert.equal(thread.config['features.shell_tool'], false);
    assert.equal(thread.config['features.multi_agent'], false);
    assert.equal(thread.config['features.apps'], false);
    assert.equal(thread.config.web_search, 'disabled');
    assert.equal(thread.dynamicTools, undefined);
    toolRequest(mock, 790);
    await until(() => mock.messages.some(x => x.id === 790));
    assert.equal(mock.messages.find(x => x.id === 790)?.result.success, false);
    complete(mock); await result;
  } finally { mock.bridge.close(); }
});
