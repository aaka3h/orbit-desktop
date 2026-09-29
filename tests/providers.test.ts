import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestModel, testConnection } from '../electron/providers';
import type { AgentMessage, ProviderConfig, ProviderKind, ToolSpec } from '../shared/types';

const config = (kind: ProviderKind, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ kind, model: 'test-model', baseUrl: '', apiKey: 'test-secret-key', ...extra });
const signal = () => new AbortController().signal;
const messages: AgentMessage[] = [{ role: 'system', content: 'Help with files.' }, { role: 'user', content: 'Inspect my workspace.' }];
const tools: ToolSpec[] = [{ name: 'list_files', description: 'List workspace files', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }];
const screenshot = 'data:image/png;base64,aW1hZ2U=';
const assistant = (reply: Awaited<ReturnType<typeof requestModel>>): AgentMessage => ({ role: 'assistant', content: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
type Request = { url: string; init: RequestInit; body: any };

function mockFetch(t: any, responses: unknown[], requests: Request[] = []) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    assert.ok(responses.length, 'Unexpected extra HTTP request');
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  });
  return requests;
}

test('OpenAI uses a fixed origin, decodes tools and replays all raw reasoning items', async t => {
  const output = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_files', arguments: '{"path":"."}' },
  ];
  const requests = mockFetch(t, [{ status: 'completed', output }, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found a README.' }] }] }]);
  const provider = config('openai', { baseUrl: 'https://untrusted.invalid' });
  const first = await requestModel(provider, messages, tools, signal());
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'list_files', arguments: { path: '.' } }]);
  const second = await requestModel(provider, [...messages, assistant(first), { role: 'tool', content: '["README.md"]', toolCallId: 'call_1', name: 'list_files' }], tools, signal());
  assert.equal(second.text, 'Found a README.');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer test-secret-key');
  assert.equal(requests[0].body.store, false);
  assert.deepEqual(requests[1].body.input.slice(2, 4), output);
  assert.deepEqual(requests[1].body.input.at(-1), { type: 'function_call_output', call_id: 'call_1', output: '["README.md"]' });
});

test('Claude groups parallel tool results and preserves full assistant content', async t => {
  const content = [
    { type: 'thinking', thinking: 'opaque internal content', signature: 'signed-state' },
    { type: 'tool_use', id: 't1', name: 'list_files', input: { path: '.' } },
    { type: 'tool_use', id: 't2', name: 'list_files', input: { path: 'docs' } },
  ];
  const requests = mockFetch(t, [{ content, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }]);
  const first = await requestModel(config('anthropic'), messages, tools, signal());
  await requestModel(config('anthropic'), [...messages, assistant(first), { role: 'tool', content: 'one', toolCallId: 't1' }, { role: 'tool', content: 'two', toolCallId: 't2' }], tools, signal());
  assert.equal(requests[0].body.system, 'Help with files.');
  assert.deepEqual(requests[1].body.messages[1].content, content);
  assert.deepEqual(requests[1].body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'one' }, { type: 'tool_result', tool_use_id: 't2', content: 'two' }] });
  assert.equal(new Headers(requests[0].init.headers).get('anthropic-version'), '2023-06-01');
});

test('Gemini preserves thoughtSignature position and optional function-call IDs', async t => {
  const content = { role: 'model', parts: [
    { text: 'private summary', thought: true },
    { functionCall: { id: 'g1', name: 'list_files', args: { path: '.' } }, thoughtSignature: 'exact-signed-data' },
    { functionCall: { name: 'list_files', args: { path: 'docs' } } },
  ] };
  const requests = mockFetch(t, [{ candidates: [{ content, finishReason: 'STOP' }] }, { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }]);
  const first = await requestModel(config('gemini'), messages, tools, signal());
  assert.equal(first.text, '');
  await requestModel(config('gemini'), [...messages, assistant(first), ...first.toolCalls.map(call => ({ role: 'tool' as const, content: 'files', name: call.name, toolCallId: call.id }))], tools, signal());
  assert.deepEqual(requests[1].body.contents[1], content);
  assert.equal(requests[1].body.contents[2].parts[0].functionResponse.id, 'g1');
  assert.equal(requests[1].body.contents[2].parts[1].functionResponse.id, undefined);
  assert.equal(requests[1].body.contents[2].parts.length, 2);
  assert.equal(new Headers(requests[0].init.headers).get('x-goog-api-key'), 'test-secret-key');
  assert.equal(new URL(requests[0].url).search, '');
});

test('Ollama uses native tools, preserves thinking and sends tool names', async t => {
  const message = { role: 'assistant', content: '', thinking: 'provider context', tool_calls: [{ function: { name: 'list_files', arguments: { path: '.' } } }] };
  const requests = mockFetch(t, [{ message }, { message: { role: 'assistant', content: 'Finished.' } }]);
  const first = await requestModel(config('ollama', { apiKey: undefined }), messages, tools, signal());
  await requestModel(config('ollama', { apiKey: undefined }), [...messages, assistant(first), { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'list_files', content: '[]' }], tools, signal());
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(requests[0].body.stream, false);
  assert.deepEqual(requests[1].body.messages[2], message);
  assert.deepEqual(requests[1].body.messages.at(-1), { role: 'tool', content: '[]', tool_name: 'list_files' });
});

test('compatible providers preserve the base path and stringify tool arguments', async t => {
  const requests = mockFetch(t, [{ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }] }]);
  const result = await requestModel(config('compatible', { baseUrl: 'https://models.example/proxy/v1/' }), messages, tools, signal());
  assert.equal(requests[0].url, 'https://models.example/proxy/v1/chat/completions');
  assert.deepEqual(result.toolCalls[0].arguments, { path: '.' });
});

test('screenshot payloads are mapped to each provider without interrupting parallel tool results', async t => {
  const history: AgentMessage[] = [...messages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'computer', arguments: { action: 'screenshot' } }, { id: 'two', name: 'list_files', arguments: { path: '.' } }] },
    { role: 'tool', name: 'computer', toolCallId: 'one', content: 'Screenshot size 10x10', images: [screenshot] },
    { role: 'tool', name: 'list_files', toolCallId: 'two', content: '[]' },
  ];
  const requests = mockFetch(t, [
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Viewed.' }] }] },
    { content: [{ type: 'text', text: 'Viewed.' }] },
    { candidates: [{ content: { parts: [{ text: 'Viewed.' }] } }] },
    { choices: [{ message: { content: 'Viewed.' } }] },
    { message: { content: 'Viewed.' } },
  ]);
  for (const kind of ['openai', 'anthropic', 'gemini', 'compatible', 'ollama'] as const) await requestModel(config(kind), history, tools, signal());
  assert.equal(requests[0].body.input.at(-1).content[0].image_url, screenshot);
  assert.deepEqual(requests[0].body.input.slice(-3, -1).map((m: any) => m.type), ['function_call_output', 'function_call_output']);
  assert.deepEqual(requests[1].body.messages.at(-1).content[0].content[1].source, { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' });
  assert.deepEqual(requests[2].body.contents.at(-1).parts[1].inlineData, { mimeType: 'image/png', data: 'aW1hZ2U=' });
  assert.equal(requests[3].body.messages.at(-1).content[0].image_url.url, screenshot);
  assert.deepEqual(requests[3].body.messages.slice(-3).map((m: any) => m.role), ['tool', 'tool', 'user']);
  assert.deepEqual(requests[4].body.messages.at(-1).images, ['aW1hZ2U=']);
});

test('malformed tool JSON is rejected before any execution', async t => {
  mockFetch(t, [{ output: [{ type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{broken' }] }]);
  await assert.rejects(requestModel(config('openai'), messages, tools, signal()), /invalid JSON tool arguments/);
});

test('non-object arguments and duplicate call IDs are rejected', async t => {
  mockFetch(t, [
    { output: [{ type: 'function_call', call_id: 'c1', name: 'list_files', arguments: '[]' }] },
    { output: [{ type: 'function_call', call_id: 'c1', name: 'list_files', arguments: '{}' }, { type: 'function_call', call_id: 'c1', name: 'list_files', arguments: '{}' }] },
  ]);
  await assert.rejects(requestModel(config('openai'), messages, tools, signal()), /not a JSON object/);
  await assert.rejects(requestModel(config('openai'), messages, tools, signal()), /duplicate tool-call IDs/);
});

test('an incomplete response never exposes its partial tools for execution', async t => {
  mockFetch(t, [{ status: 'incomplete', output: [{ type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{}' }] }]);
  await assert.rejects(requestModel(config('openai'), messages, tools, signal()), /stopped before completing/);
});

test('non-loopback HTTP, embedded credentials, queries and fragments are blocked', async t => {
  const requests = mockFetch(t, []);
  for (const baseUrl of ['http://example.com/v1', 'http://localhost.evil.test/v1', 'http://192.168.1.10/v1', 'https://user:pass@example.com', 'https://example.com/v1?key=secret', 'https://example.com/#secret', 'file:///etc/passwd']) {
    const result = await testConnection(config('compatible', { baseUrl }));
    assert.equal(result.ok, false, baseUrl);
  }
  assert.equal(requests.length, 0);
});

test('IPv6 loopback and prefixed HTTPS APIs are accepted', async t => {
  const requests = mockFetch(t, [{ data: [{ id: 'test-model' }] }, { data: [{ id: 'test-model' }] }]);
  assert.equal((await testConnection(config('compatible', { baseUrl: 'http://[::1]:1234/v1' }))).ok, true);
  assert.equal((await testConnection(config('compatible', { baseUrl: 'https://models.example/local/v1' }))).ok, true);
  assert.equal(requests[0].url, 'http://[::1]:1234/v1/models');
  assert.equal(requests[1].url, 'https://models.example/local/v1/models');
});

test('connection checks list models without generation and filter Gemini non-chat models', async t => {
  const requests = mockFetch(t, [
    { models: [{ name: 'llama:latest' }] },
    { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-test', supportedGenerationMethods: ['embedContent'] }] },
    { data: [{ id: 'claude-test' }] },
  ]);
  const ollama = await testConnection(config('ollama', { model: 'llama' }));
  assert.equal(ollama.ok, true);
  assert.deepEqual(ollama.models, ['llama:latest']);
  const gemini = await testConnection(config('gemini'));
  assert.deepEqual(gemini.models, ['gemini-test']);
  assert.equal((await testConnection(config('anthropic'))).ok, true);
  for (const request of requests) assert.equal(request.init.method, undefined);
});

test('missing keys fail locally and server error details redact the supplied key', async t => {
  const requests = mockFetch(t, [Response.json({ error: { message: 'Bad key test-secret-key' } }, { status: 401 })]);
  const missing = await testConnection(config('openai', { apiKey: '' }));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /API key/);
  assert.equal(requests.length, 0);
  const invalid = await testConnection(config('openai'));
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /401/);
  assert.ok(!invalid.message.includes('test-secret-key'));
});

test('oversized streaming responses are stopped even without content-length', async t => {
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  mockFetch(t, [new Response(body)]);
  await assert.rejects(requestModel(config('openai'), messages, tools, signal()), /too large/);
  assert.equal(cancelled, true);
  assert.ok(reads <= 11);
});

test('aborting a run cancels the provider fetch', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    queueMicrotask(() => controller.abort());
  }));
  await assert.rejects(requestModel(config('openai'), messages, tools, controller.signal), /cancelled/);
});

test('demo walks through list, proposed write, and honest success or denial without network', async t => {
  const requests = mockFetch(t, []);
  const provider = config('demo');
  const first = await requestModel(provider, messages, tools, signal());
  assert.equal(first.toolCalls[0].name, 'list_files');
  const history: AgentMessage[] = [...messages, assistant(first), { role: 'tool', content: '[]' }];
  const second = await requestModel(provider, history, tools, signal());
  assert.equal(second.toolCalls[0].name, 'write_file');
  assert.equal(second.toolCalls[0].arguments.path, 'orbit-demo.md');
  const denied = await requestModel(provider, [...history, assistant(second), { role: 'tool', content: '{"error":"User denied"}' }], tools, signal());
  assert.match(denied.text, /not created/);
  const success = await requestModel(provider, [...history, assistant(second), { role: 'tool', content: '{"written":"orbit-demo.md"}' }], tools, signal());
  assert.match(success.text, /created orbit-demo.md/);
  assert.equal(requests.length, 0);
});
