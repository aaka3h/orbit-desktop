import { randomUUID } from 'node:crypto';
import type { AgentMessage, ModelReply, ProviderConfig, ToolCall, ToolSpec } from '../shared/types';

// This module runs only in Electron's main process. Never expose provider keys to the renderer.
// Provider wire formats: https://developers.openai.com/api/docs/guides/function-calling
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
// https://docs.ollama.com/api/chat
type Json = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const CONNECTION_TIMEOUT_MS = 15_000;

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function required(value: unknown, label: string): string {
  const result = string(value);
  if (!result.trim()) throw new Error(`Provider returned a missing ${label}.`);
  return result;
}
function argumentsObject(value: unknown): Json {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new Error('The model returned invalid JSON tool arguments. Please retry.'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model returned tool arguments that are not a JSON object.');
  }
  return parsed as Json;
}
function toolCall(id: unknown, name: unknown, args: unknown): ToolCall {
  return { id: required(id, 'tool-call ID'), name: required(name, 'tool name'), arguments: argumentsObject(args) };
}
function apiKey(config: ProviderConfig): string {
  const key = config.apiKey?.trim();
  if (!key) throw new Error('Add a provider API key in Connections. A chat subscription is not an API key.');
  if (/[\r\n]/.test(key)) throw new Error('API keys cannot contain line breaks.');
  return key;
}

function localEndpoint(baseUrl: string, suffix: string, fallback: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim() || fallback); } catch { throw new Error('Enter a valid provider base URL.'); }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Provider URLs require HTTPS, except HTTP on localhost or a loopback IP.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The base URL cannot contain credentials, a query string, or a fragment.');
  }
  // Keep a user-specified API path (for example /v1); never resolve suffixes as another host.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  return url.toString();
}

function redact(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600);
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out. Check your model server and try again.')), timeoutMs);
  const headers = new Headers(init.headers);
  const secrets = [headers.get('authorization')?.replace(/^Bearer /, '') || '', headers.get('x-api-key') || '', headers.get('x-goog-api-key') || ''];
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('Provider response is too large (maximum 8 MB).');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error('Provider response is too large (maximum 8 MB).');
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check the endpoint, API key, and model.`);
      throw new Error('Provider did not return valid JSON. Check the base URL.');
    }
    const result = record(parsed);
    if (!response.ok) {
      const detail = string(record(result.error).message) || string(result.error) || string(result.message);
      throw new Error(`Provider returned HTTP ${response.status}${detail ? `: ${redact(detail, secrets)}` : '.'}`);
    }
    if (result.error) throw new Error(redact(string(record(result.error).message) || string(result.error) || 'Provider returned an error.', secrets));
    return result;
  } catch (error) {
    if (signal?.aborted) throw new Error('Run cancelled.');
    if (controller.signal.aborted) throw controller.signal.reason;
    const message = error instanceof Error ? error.message : 'Could not connect to the provider.';
    if (message === 'fetch failed') throw new Error('Could not connect to the provider. Check the URL, internet connection, or local model server.');
    throw new Error(redact(message, secrets));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function post(body: Json, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

function rawFor(message: AgentMessage, provider: string): unknown {
  const raw = record(message.raw);
  return raw.provider === provider ? raw.content : undefined;
}

function images(message: AgentMessage): { url: string; data: string; mimeType: string }[] {
  return (message.images || []).map(url => {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || match[2].length > Math.ceil(7 * 1024 * 1024 / 3) * 4) throw new Error('Screenshots must be PNG, JPEG, or WebP data images up to 7 MB.');
    return { url, mimeType: match[1], data: match[2] };
  });
}

function openaiInput(messages: AgentMessage[]): unknown[] {
  const output: unknown[] = [], pendingImages: unknown[] = [];
  const flushImages = () => { if (pendingImages.length) output.push({ role: 'user', content: pendingImages.splice(0) }); };
  for (const message of messages) {
    if (message.role === 'tool') {
      output.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      pendingImages.push(...images(message).map(image => ({ type: 'input_image', image_url: image.url, detail: 'auto' })));
      continue;
    }
    flushImages();
    const raw = rawFor(message, 'openai');
    if (message.role === 'assistant' && Array.isArray(raw)) { output.push(...raw); continue; }
    if (message.content) output.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls || []) output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
  }
  flushImages();
  return output;
}

async function openai(config: ProviderConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
  const result = await fetchJson('https://api.openai.com/v1/responses', post({
    model: config.model, input: openaiInput(messages), store: false, include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool, strict: false })) } : {}),
  }, { authorization: `Bearer ${apiKey(config)}` }), signal);
  if (result.status === 'incomplete' || result.status === 'failed') throw new Error('The model stopped before completing its response. Try a shorter request or another model.');
  const output = list(result.output);
  const toolCalls = output.filter(item => record(item).type === 'function_call').map(item => {
    const call = record(item);
    return toolCall(call.call_id, call.name, call.arguments);
  });
  const text = output.filter(item => record(item).type === 'message').flatMap(item => list(record(item).content)).map(item => {
    const part = record(item);
    return part.type === 'output_text' ? string(part.text) : part.type === 'refusal' ? string(part.refusal) : '';
  }).filter(Boolean).join('\n');
  return { text, toolCalls, raw: { provider: 'openai', content: output } };
}

function chatMessages(messages: AgentMessage[], provider: 'ollama' | 'compatible'): unknown[] {
  const output: unknown[] = [], pendingImages: ReturnType<typeof images> = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    output.push(provider === 'ollama'
      ? { role: 'user', content: 'Screenshot returned by the desktop tool.', images: pendingImages.map(image => image.data) }
      : { role: 'user', content: pendingImages.map(image => ({ type: 'image_url', image_url: { url: image.url } })) });
    pendingImages.length = 0;
  };
  for (const message of messages) {
    if (message.role !== 'tool') flushImages();
    const raw = rawFor(message, provider);
    if (message.role === 'assistant' && raw) { output.push(raw); continue; }
    if (message.role === 'tool') {
      const result = provider === 'ollama'
        ? { role: 'tool', content: message.content, tool_name: message.name }
        : { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
      output.push(result);
      pendingImages.push(...images(message));
      continue;
    }
    output.push({
      role: message.role, content: message.content,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
        ...(provider === 'compatible' ? { id: call.id, type: 'function' } : {}),
        function: { name: call.name, arguments: provider === 'compatible' ? JSON.stringify(call.arguments) : call.arguments },
      })) } : {}),
    });
  }
  flushImages();
  return output;
}

async function chat(config: ProviderConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
  const ollama = config.kind === 'ollama';
  const endpoint = localEndpoint(config.baseUrl, ollama ? 'api/chat' : 'chat/completions', ollama ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1');
  const result = await fetchJson(endpoint, post({
    model: config.model, messages: chatMessages(messages, ollama ? 'ollama' : 'compatible'), stream: false,
    ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}),
  }, config.apiKey?.trim() ? { authorization: `Bearer ${apiKey(config)}` } : {}), signal);
  const choice = record(list(result.choices)[0]);
  if (choice.finish_reason === 'length' || result.done_reason === 'length') throw new Error('The model reached its output limit. Try a shorter request or increase the model server output limit.');
  const message = record(ollama ? result.message : choice.message);
  if (!Object.keys(message).length) throw new Error('Provider returned no assistant message. Check the selected model.');
  const toolCalls = list(message.tool_calls).map(item => {
    const call = record(item), fn = record(call.function);
    return toolCall(ollama ? string(call.id) || randomUUID() : call.id, fn.name, fn.arguments);
  });
  return { text: string(message.content) || string(message.refusal), toolCalls, raw: { provider: config.kind, content: message } };
}

function anthropicMessages(messages: AgentMessage[]): unknown[] {
  const output: { role: string; content: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    let content: unknown[];
    const role = message.role === 'tool' ? 'user' : message.role;
    const raw = rawFor(message, 'anthropic');
    if (message.role === 'tool') content = [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.images?.length
      ? [{ type: 'text', text: message.content }, ...images(message).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))]
      : message.content }];
    else if (Array.isArray(raw)) content = raw;
    else content = [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...(message.toolCalls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
    ];
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content });
  }
  return output;
}

async function anthropic(config: ProviderConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
  const result = await fetchJson('https://api.anthropic.com/v1/messages', post({
    model: config.model, max_tokens: 8192,
    system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: anthropicMessages(messages),
    ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
  }, { 'x-api-key': apiKey(config), 'anthropic-version': '2023-06-01' }), signal);
  if (result.stop_reason === 'max_tokens') throw new Error('Claude reached its output limit. Try a shorter request.');
  const content = list(result.content);
  return {
    text: content.filter(item => record(item).type === 'text').map(item => string(record(item).text)).join('\n'),
    toolCalls: content.filter(item => record(item).type === 'tool_use').map(item => {
      const call = record(item);
      return toolCall(call.id, call.name, call.input);
    }),
    raw: { provider: 'anthropic', content },
  };
}

function geminiMessages(messages: AgentMessage[]): unknown[] {
  const output: { role: string; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const raw = record(rawFor(message, 'gemini'));
    if (message.role === 'assistant' && Array.isArray(raw.parts)) {
      // Keep every part in its original position, including encrypted thoughtSignature metadata.
      output.push({ ...raw, role: 'model', parts: raw.parts });
      continue;
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const hasWireId = messages.some(previous => list(record(rawFor(previous, 'gemini')).parts).some(part => record(record(part).functionCall).id === message.toolCallId && !!message.toolCallId));
    const parts: unknown[] = message.role === 'tool'
      ? [{ functionResponse: { name: message.name, ...(hasWireId ? { id: message.toolCallId } : {}), response: { result: message.content } } }, ...images(message).map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))]
      : [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls || []).map(call => ({ functionCall: { id: call.id, name: call.name, args: call.arguments } })),
      ];
    const previous = output.at(-1);
    if (message.role === 'tool' && previous?.role === 'user' && previous.parts.some(part => record(part).functionResponse)) previous.parts.push(...parts);
    else output.push({ role, parts });
  }
  return output;
}

async function gemini(config: ProviderConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
  const model = config.model.replace(/^models\//, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Enter a valid Gemini model ID, such as the ID shown in Google AI Studio.');
  const result = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, post({
    contents: geminiMessages(messages),
    systemInstruction: { parts: messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) },
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }] } : {}),
  }, { 'x-goog-api-key': apiKey(config) }), signal);
  const candidate = record(list(result.candidates)[0]);
  if (!Object.keys(candidate).length) throw new Error(`Gemini returned no answer${record(result.promptFeedback).blockReason ? ' because the prompt was blocked' : ''}.`);
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new Error(`Gemini stopped with ${string(candidate.finishReason)}. No actions were run from this response.`);
  const content = record(candidate.content), parts = list(content.parts);
  return {
    text: parts.filter(item => !record(item).thought).map(item => string(record(item).text)).filter(Boolean).join('\n'),
    toolCalls: parts.filter(item => record(item).functionCall).map(item => {
      const call = record(record(item).functionCall);
      return toolCall(string(call.id) || randomUUID(), call.name, call.args ?? {});
    }),
    raw: { provider: 'gemini', content },
  };
}

function toolFailed(content: string): boolean {
  try { return !!record(JSON.parse(content)).error; }
  catch { return /^(?:error|denied|cancelled)\b/i.test(content.trim()); }
}

function demo(messages: AgentMessage[]): ModelReply {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== 'user') start--;
  const currentTurn = messages.slice(start + 1);
  const results = currentTurn.filter(message => message.role === 'tool');
  if (!results.length) return {
    text: 'This is the offline demo. I will list the workspace, then ask permission to create orbit-demo.md.',
    toolCalls: [{ id: randomUUID(), name: 'list_files', arguments: { path: '.' } }],
  };
  if (results.length === 1) {
    if (toolFailed(results[0].content)) return { text: 'The demo could not read the workspace. Select an accessible folder and try again.', toolCalls: [] };
    return {
      text: 'The workspace was inspected. Please review the proposed demo file before approving it.',
      toolCalls: [{ id: randomUUID(), name: 'write_file', arguments: {
        path: 'orbit-demo.md',
        content: '# Your first Orbit task\n\nThis file was created by the offline demo after your approval.\n\n1. Orbit inspected your workspace.\n2. You approved this file.\n3. Orbit wrote the result.\n\nConnect a local model or provider API in Connections to work on your own tasks.\n',
      } }],
    };
  }
  const failed = toolFailed(results.at(-1)?.content || '');
  return {
    text: failed ? 'The file was not created. The write was denied or failed. You remain in control of every change.' : 'Demo complete. I created orbit-demo.md in your workspace after your approval. Open Connections and choose a local model or a provider API to give Orbit your own tasks.',
    toolCalls: [],
  };
}

/** Each returned raw object must be preserved in the next assistant AgentMessage. */
export async function requestModel(config: ProviderConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply> {
  signal.throwIfAborted();
  if (config.kind === 'demo') return demo(messages);
  if (!config.model?.trim()) throw new Error('Choose a model in Connections before starting a task.');
  let reply: ModelReply;
  switch (config.kind) {
    case 'huggingface': apiKey(config); reply = await chat({...config,kind:'compatible',baseUrl:'https://router.huggingface.co/v1'},messages,tools,signal); break;
    case 'openai': reply = await openai(config, messages, tools, signal); break;
    case 'anthropic': reply = await anthropic(config, messages, tools, signal); break;
    case 'gemini': reply = await gemini(config, messages, tools, signal); break;
    case 'ollama': case 'compatible': reply = await chat(config, messages, tools, signal); break;
    case 'codex': throw new Error('Codex uses its own agent engine. Use the ChatGPT subscription connection.');
    default: throw new Error('Choose a supported provider in Connections.');
  }
  if (!reply.text && !reply.toolCalls.length) throw new Error('The provider returned an empty answer. Check that the selected model supports chat and tool calling.');
  if (reply.toolCalls.length > 32) throw new Error('The model requested too many tools in one response. Try a smaller task.');
  const ids = new Set<string>();
  for (const call of reply.toolCalls) {
    if (ids.has(call.id)) throw new Error('The model returned duplicate tool-call IDs. Please retry.');
    ids.add(call.id);
  }
  return reply;
}

/** Lists models without generating text or spending inference tokens. */
export async function testConnection(config: ProviderConfig, signal?: AbortSignal): Promise<{ ok: boolean; message: string; models?: string[] }> {
  try {
    if (config.kind === 'demo') return { ok: true, message: 'Offline demo is ready. No account or model download needed.' };
    if (config.kind === 'codex') return { ok: false, message: 'Use the ChatGPT subscription sign-in control to check the Codex connection.' };
    let url: string, headers: Record<string, string> = {};
    switch (config.kind) {
      case 'huggingface': url = 'https://router.huggingface.co/v1/models'; headers.authorization = `Bearer ${apiKey(config)}`; break;
      case 'openai': url = 'https://api.openai.com/v1/models'; headers.authorization = `Bearer ${apiKey(config)}`; break;
      case 'anthropic': url = 'https://api.anthropic.com/v1/models'; headers = { 'x-api-key': apiKey(config), 'anthropic-version': '2023-06-01' }; break;
      case 'gemini': url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'; headers['x-goog-api-key'] = apiKey(config); break;
      case 'ollama': url = localEndpoint(config.baseUrl, 'api/tags', 'http://127.0.0.1:11434'); break;
      case 'compatible': url = localEndpoint(config.baseUrl, 'models', 'http://127.0.0.1:1234/v1'); break;
      default: throw new Error('Choose a supported provider.');
    }
    if ((config.kind === 'ollama' || config.kind === 'compatible') && config.apiKey?.trim()) headers.authorization = `Bearer ${apiKey(config)}`;
    const result = await fetchJson(url, { headers }, signal, CONNECTION_TIMEOUT_MS);
    const source = config.kind === 'gemini' || config.kind === 'ollama' ? result.models : result.data;
    if (!Array.isArray(source)) throw new Error('Provider returned an unexpected model list. Check its API base URL.');
    const models = source.filter(item => config.kind !== 'gemini' || !record(item).supportedGenerationMethods || list(record(item).supportedGenerationMethods).includes('generateContent'))
      .map(item => string(record(item).id) || string(record(item).name)).filter(Boolean).map(name => config.kind === 'gemini' ? name.replace(/^models\//, '') : name).sort();
    const modelFound = models.includes(config.model) || (config.kind === 'ollama' && models.includes(`${config.model}:latest`));
    return {
      ok: true, models,
      message: !models.length ? 'Connected, but no models were listed. Install or enable a chat model first.' : config.model && !modelFound ? 'Connected. The selected model was not in the returned list; verify its ID before running.' : 'Connected. Model listing succeeded; tool support is checked when you run a task.',
    };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Connection failed.' }; }
}
