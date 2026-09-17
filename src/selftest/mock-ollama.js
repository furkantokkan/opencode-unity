// Mock of the native Ollama API (spec 20.3): `/api/version`, `/api/tags`, `/api/show`, `/api/ps`, plus
// the endpoints that load or change models. Load-path calls are recorded so tests can prove a command
// never loads a model (spec 5.4 doctor invariant, 4.5). Shapes follow Ollama 0.34.1 (OL `api/types.go`
// L741-747, L853-876; `server/routes.go` L1500-1511, L2264-2296, L2500-2511, L2629-2648).
import { delay, sendJson, startMockServer } from './mock-server.js';

export const MOCK_OLLAMA_VERSION = '0.34.1';

// Native paths whose call makes a real server load (or try to load) a model.
export const NATIVE_LOAD_PATHS = Object.freeze(['/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);

// Ollama pads parameter names to 30 columns in `/api/show` (OL `server/routes.go` L1500-1511).
const PARAMETER_NAME_WIDTH = 30;
const MIB = 1024 * 1024;
const DEFAULT_KEEP_ALIVE_SEC = 300;

/**
 * @typedef {object} RouteResponse
 * @property {number} [status]
 * @property {unknown} [body]            JSON value; a string is sent as plain text.
 * @property {Record<string, string>} [headers]
 * @property {number} [delayMs]
 * @property {boolean} [hang]            Never answer.
 * @property {boolean} [destroy]         Destroy the socket without an answer.
 */

/**
 * @typedef {object} ModelSpec
 * @property {string} name
 * @property {number} [sizeBytes]
 * @property {string} [digest]
 * @property {Record<string, string | number | boolean | string[]>} [parameters]  Rendered like `/api/show`.
 * @property {string} [renderer]
 * @property {string} [parser]
 * @property {string} [system]           A Modelfile SYSTEM line (spec E4).
 * @property {string} [family]
 * @property {string} [parameterSize]
 * @property {string} [quantizationLevel]
 * @property {string[]} [capabilities]
 */

/**
 * @typedef {object} RunningSpec
 * @property {string} name
 * @property {number} contextLength
 * @property {number} [sizeVramMiB]
 * @property {number} [sizeMiB]
 * @property {string | number} [expiresAt]  ISO string or epoch ms. Default: now + keepAliveSec at each `/api/ps`.
 * @property {number} [keepAliveSec]
 */

/**
 * @typedef {object} ChatReply
 * @property {string} [content]
 * @property {number} [promptTokens]
 * @property {number} [outputTokens]
 * @property {string} [doneReason]
 * @property {number} [httpStatus]
 * @property {unknown} [httpBody]
 * @property {string} [streamError]      Adds `{"error": ...}` as a stream line.
 * @property {number} [delayMs]
 * @property {boolean} [omitFinal]       Leaves out the `done: true` line.
 * @property {boolean} [malformed]       Adds a line that is not JSON.
 */

/**
 * @typedef {object} MockOllamaOptions
 * @property {string} [version]
 * @property {Array<string | ModelSpec>} [models]
 * @property {RunningSpec[]} [running]
 * @property {Array<ChatReply | ((body: any, index: number) => ChatReply)>} [chatReplies]
 * @property {() => number} [now]
 */

/**
 * @param {MockOllamaOptions} [options]
 */
export function createMockOllama(options = {}) {
  const now = options.now ?? Date.now;
  const version = options.version ?? MOCK_OLLAMA_VERSION;
  /** @type {Map<string, ModelSpec>} */
  const models = new Map();
  /** @type {Map<string, RunningSpec>} */
  const running = new Map();
  /** @type {Map<string, { responses: Array<RouteResponse | null>, count: number }>} */
  const overrides = new Map();
  /** @type {Array<ChatReply | ((body: any, index: number) => ChatReply)>} */
  const chatReplies = [...(options.chatReplies ?? [])];
  /** @type {import('./mock-server.js').MockRequest[]} */
  const requests = [];
  /** @type {any[]} */
  const chatRequests = [];

  const setModels = (/** @type {Array<string | ModelSpec>} */ list) => {
    models.clear();
    for (const entry of list) addModel(entry);
  };
  const addModel = (/** @type {string | ModelSpec} */ entry) => {
    const spec = typeof entry === 'string' ? { name: entry } : entry;
    models.set(normalizeModelName(spec.name), spec);
  };
  const setRunning = (/** @type {RunningSpec[]} */ list) => {
    running.clear();
    for (const entry of list) running.set(normalizeModelName(entry.name), entry);
  };
  setModels(options.models ?? []);
  setRunning(options.running ?? []);

  /** @type {Record<string, (request: import('./mock-server.js').MockRequest, response: import('node:http').ServerResponse) => void | Promise<void>>} */
  const routes = {
    'GET /api/version': (_request, response) => sendJson(response, 200, { version }),
    'GET /api/tags': (_request, response) => sendJson(response, 200, { models: [...models.values()].map((spec) => toTagEntry(spec, now)) }),
    'GET /api/ps': (_request, response) => sendJson(response, 200, { models: listRunning(running, models, now) }),
    'POST /api/show': (request, response) => {
      const name = getModelField(request.body);
      const spec = models.get(normalizeModelName(name));
      if (!spec) return sendJson(response, 404, { error: `model '${name}' not found` });
      sendJson(response, 200, toShowResponse(spec, now));
    },
    'POST /api/chat': (request, response) => handleGenerate(request, response, 'chat'),
    'POST /api/generate': (request, response) => handleGenerate(request, response, 'generate'),
    'POST /api/embed': (_request, response) => sendJson(response, 400, { error: 'mock: embeddings are not served' }),
    'POST /api/embeddings': (_request, response) => sendJson(response, 400, { error: 'mock: embeddings are not served' }),
    'POST /api/pull': (request, response) => {
      const name = getModelField(request.body);
      addModel({ name });
      sendProgress(response, request.body, ['pulling manifest', 'verifying sha256 digest', 'writing manifest', 'success']);
    },
    'POST /api/create': (request, response) => {
      const body = /** @type {any} */ (request.body) ?? {};
      const name = getModelField(body);
      addModel({ name, parameters: body.parameters, renderer: body.renderer, parser: body.parser, system: body.system });
      sendProgress(response, body, ['using existing layer', 'writing manifest', 'success']);
    },
    'DELETE /api/delete': (request, response) => {
      const name = getModelField(request.body);
      if (!models.delete(normalizeModelName(name))) return sendJson(response, 404, { error: `model '${name}' not found` });
      running.delete(normalizeModelName(name));
      response.writeHead(200).end();
    },
  };

  /**
   * @param {import('./mock-server.js').MockRequest} request
   * @param {import('node:http').ServerResponse} response
   * @param {'chat' | 'generate'} kind
   */
  async function handleGenerate(request, response, kind) {
    const body = /** @type {any} */ (request.body) ?? {};
    const name = getModelField(body);
    const key = normalizeModelName(name);
    if (!models.has(key)) return sendJson(response, 404, { error: `model '${name}' not found` });
    const isEmpty = kind === 'chat' ? !Array.isArray(body.messages) || body.messages.length === 0 : !body.prompt;
    if (isEmpty && isZeroKeepAlive(body.keep_alive)) {
      running.delete(key);
      return sendJson(response, 200, doneLine(name, now, 'unload', kind));
    }
    const contextLength = Number(body.options?.num_ctx) || getNumCtx(models.get(key)) || 4096;
    running.set(key, { name, contextLength, keepAliveSec: parseKeepAliveSec(body.keep_alive), expiresAt: undefined });
    if (isEmpty) return sendJson(response, 200, doneLine(name, now, 'load', kind));
    chatRequests.push(body);
    const next = chatReplies.length > 0 ? chatReplies.shift() : { content: 'mock answer' };
    const reply = typeof next === 'function' ? next(body, chatRequests.length - 1) : next ?? {};
    await sendChatReply(response, body, reply, kind, now);
  }

  return {
    name: 'ollama',
    requests,
    chatRequests,
    setModels,
    addModel,
    setRunning,
    /**
     * @param {string} name
     * @param {{ contextLength: number, keepAliveSec?: number }} state
     */
    loadModel(name, { contextLength, keepAliveSec }) {
      running.set(normalizeModelName(name), { name, contextLength, keepAliveSec });
    },
    /** @param {string} name */
    unloadModel(name) {
      running.delete(normalizeModelName(name));
    },
    /** @param {string} name */
    getNumCtx(name) {
      return getNumCtx(models.get(normalizeModelName(name)));
    },
    /** @param {...(ChatReply | ((body: any, index: number) => ChatReply))} replies */
    enqueueChat(...replies) {
      chatReplies.push(...replies);
    },
    /**
     * The n-th matching request gets the n-th response; the last repeats. `null` means the normal route.
     * @param {string} pathname  For example '/api/ps'.
     * @param {RouteResponse | Array<RouteResponse | null> | null} responses  null removes the override.
     */
    overrideRoute(pathname, responses) {
      if (responses === null) overrides.delete(pathname);
      else overrides.set(pathname, { responses: Array.isArray(responses) ? responses : [responses], count: 0 });
    },
    /** Requests that would load a model on a real server. */
    get loadRequests() {
      return requests.filter((request) => NATIVE_LOAD_PATHS.includes(request.path));
    },
    /**
     * @param {import('./mock-server.js').MockRequest} request
     * @param {import('node:http').ServerResponse} response
     */
    async handle(request, response) {
      if (!request.path.startsWith('/api/')) return false;
      requests.push(request);
      const override = overrides.get(request.path);
      if (override) {
        const planned = override.responses[Math.min(override.count, override.responses.length - 1)];
        override.count += 1;
        if (planned) {
          await sendRouteResponse(response, planned);
          return true;
        }
      }
      const route = routes[`${request.method} ${request.path}`];
      if (!route) sendJson(response, 404, { error: `mock: ${request.method} ${request.path} is not served` });
      else await route(request, response);
      return true;
    },
  };
}

/**
 * @param {MockOllamaOptions & { port?: number }} [options]
 */
export async function startMockOllama(options = {}) {
  const mock = createMockOllama(options);
  const server = await startMockServer({ handlers: [mock], port: options.port });
  return { mock, server, url: server.url, close: server.close };
}

/**
 * `/api/show` parameter text, one `name value` line per value with Go `%#v` quoting for strings.
 * @param {Record<string, string | number | boolean | string[]>} parameters
 * @returns {string}
 */
export function formatShowParameters(parameters) {
  const lines = [];
  for (const [name, value] of Object.entries(parameters)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name.padEnd(PARAMETER_NAME_WIDTH)} ${typeof item === 'string' ? JSON.stringify(item) : String(item)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Ollama treats a bare name as `<name>:latest`.
 * @param {string} name
 * @returns {string}
 */
export function normalizeModelName(name) {
  const trimmed = String(name ?? '').trim();
  const lastSegment = trimmed.split('/').at(-1) ?? '';
  return lastSegment.includes(':') ? trimmed : `${trimmed}:latest`;
}

/**
 * @param {unknown} body
 * @returns {string}
 */
function getModelField(body) {
  const value = /** @type {any} */ (body)?.model ?? /** @type {any} */ (body)?.name;
  return typeof value === 'string' ? value : '';
}

/**
 * @param {ModelSpec | undefined} spec
 * @returns {number | null}
 */
function getNumCtx(spec) {
  const value = Number(spec?.parameters?.num_ctx);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * @param {ModelSpec} spec
 * @param {() => number} now
 */
function toTagEntry(spec, now) {
  const name = normalizeModelName(spec.name);
  return {
    name,
    model: name,
    modified_at: new Date(now()).toISOString(),
    size: spec.sizeBytes ?? 18_556_700_000,
    digest: spec.digest ?? mockDigest(spec.name),
    details: toDetails(spec),
  };
}

/**
 * @param {ModelSpec} spec
 */
function toDetails(spec) {
  const family = spec.family ?? 'qwen3moe';
  return {
    parent_model: '',
    format: 'gguf',
    family,
    families: [family],
    parameter_size: spec.parameterSize ?? '30.5B',
    quantization_level: spec.quantizationLevel ?? 'Q4_K_M',
  };
}

/**
 * @param {ModelSpec} spec
 * @param {() => number} now
 */
function toShowResponse(spec, now) {
  const parameters = spec.parameters ? formatShowParameters(spec.parameters) : '';
  const modelfileLines = [`FROM ${spec.name}`];
  if (spec.system) modelfileLines.push(`SYSTEM ${JSON.stringify(spec.system)}`);
  for (const line of parameters.split('\n').filter(Boolean)) modelfileLines.push(`PARAMETER ${line.replace(/\s+/, ' ')}`);
  if (spec.renderer) modelfileLines.push(`RENDERER ${spec.renderer}`);
  if (spec.parser) modelfileLines.push(`PARSER ${spec.parser}`);
  /** @type {Record<string, unknown>} */
  const response = {
    modelfile: `${modelfileLines.join('\n')}\n`,
    parameters,
    template: '{{ .Prompt }}',
    details: toDetails(spec),
    model_info: { 'general.architecture': spec.family ?? 'qwen3moe' },
    capabilities: spec.capabilities ?? ['completion', 'tools'],
    modified_at: new Date(now()).toISOString(),
  };
  if (spec.system) response.system = spec.system;
  if (spec.renderer) response.renderer = spec.renderer;
  if (spec.parser) response.parser = spec.parser;
  return response;
}

/**
 * @param {Map<string, RunningSpec>} running
 * @param {Map<string, ModelSpec>} models
 * @param {() => number} now
 */
function listRunning(running, models, now) {
  const entries = [...running.values()].map((entry) => {
    const spec = models.get(normalizeModelName(entry.name)) ?? { name: entry.name };
    const sizeVram = Math.round((entry.sizeVramMiB ?? 19_000) * MIB);
    const name = normalizeModelName(entry.name);
    return {
      name,
      model: name,
      size: Math.round((entry.sizeMiB ?? entry.sizeVramMiB ?? 19_000) * MIB),
      digest: spec.digest ?? mockDigest(entry.name),
      details: toDetails(spec),
      expires_at: resolveExpiresAt(entry, now),
      size_vram: sizeVram,
      context_length: entry.contextLength,
    };
  });
  // Longest remaining keep-alive first, as Ollama sorts them.
  return entries.sort((left, right) => Date.parse(right.expires_at) - Date.parse(left.expires_at));
}

/**
 * @param {RunningSpec} entry
 * @param {() => number} now
 * @returns {string}
 */
function resolveExpiresAt(entry, now) {
  if (typeof entry.expiresAt === 'string') return entry.expiresAt;
  if (typeof entry.expiresAt === 'number') return new Date(entry.expiresAt).toISOString();
  return new Date(now() + (entry.keepAliveSec ?? DEFAULT_KEEP_ALIVE_SEC) * 1000).toISOString();
}

/**
 * @param {unknown} keepAlive
 * @returns {boolean}
 */
function isZeroKeepAlive(keepAlive) {
  return keepAlive === 0 || keepAlive === '0' || keepAlive === '0s' || keepAlive === '0m';
}

/**
 * Seconds for `keep_alive` values the mock understands: numbers (seconds) and `<n>s|m|h` strings.
 * @param {unknown} keepAlive
 * @returns {number | undefined}
 */
function parseKeepAliveSec(keepAlive) {
  if (typeof keepAlive === 'number') return keepAlive;
  const match = typeof keepAlive === 'string' ? /^(-?\d+(?:\.\d+)?)(s|m|h)?$/.exec(keepAlive.trim()) : null;
  if (!match) return undefined;
  const factor = { s: 1, m: 60, h: 3600 }[match[2] ?? 's'] ?? 1;
  return Number(match[1]) * factor;
}

/**
 * @param {string} name
 * @param {() => number} now
 * @param {string} doneReason
 * @param {'chat' | 'generate'} kind
 */
function doneLine(name, now, doneReason, kind) {
  const base = { model: name, created_at: new Date(now()).toISOString(), done: true, done_reason: doneReason };
  return kind === 'chat' ? { ...base, message: { role: 'assistant', content: '' } } : { ...base, response: '' };
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} body
 * @param {string[]} statuses
 */
function sendProgress(response, body, statuses) {
  if (/** @type {any} */ (body)?.stream === false) {
    sendJson(response, 200, { status: statuses.at(-1) });
    return;
  }
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.end(statuses.map((status) => `${JSON.stringify({ status })}\n`).join(''));
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {any} body
 * @param {ChatReply} reply
 * @param {'chat' | 'generate'} kind
 * @param {() => number} now
 */
async function sendChatReply(response, body, reply, kind, now) {
  if (reply.delayMs) await delay(reply.delayMs);
  if (response.destroyed) return;
  if (reply.httpStatus) {
    sendJson(response, reply.httpStatus, reply.httpBody ?? { error: 'mock failure' });
    return;
  }
  const model = getModelField(body);
  const content = reply.content ?? '';
  const piece = (/** @type {string} */ text) => (kind === 'chat'
    ? { model, created_at: new Date(now()).toISOString(), message: { role: 'assistant', content: text }, done: false }
    : { model, created_at: new Date(now()).toISOString(), response: text, done: false });
  const final = {
    ...doneLine(model, now, reply.doneReason ?? 'stop', kind),
    total_duration: 1_500_000_000,
    load_duration: 100_000_000,
    prompt_eval_count: reply.promptTokens ?? 123,
    eval_count: reply.outputTokens ?? 45,
  };
  if (body.stream === false) {
    sendJson(response, 200, kind === 'chat' ? { ...final, message: { role: 'assistant', content } } : { ...final, response: content });
    return;
  }
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const text of splitIntoPieces(content, 4)) {
    const line = JSON.stringify(piece(text));
    // Each line is split across two writes so clients must buffer partial lines.
    const cut = Math.floor(line.length / 2);
    response.write(line.slice(0, cut));
    response.write(`${line.slice(cut)}\n`);
  }
  if (reply.malformed) response.write('{not json}\n');
  if (reply.streamError) response.write(`${JSON.stringify({ error: reply.streamError })}\n`);
  if (!reply.omitFinal) response.write(`${JSON.stringify(final)}\n`);
  response.end();
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {RouteResponse} planned
 */
async function sendRouteResponse(response, planned) {
  if (planned.delayMs) await delay(planned.delayMs);
  if (planned.hang || response.destroyed) return;
  if (planned.destroy) {
    response.destroy();
    return;
  }
  const status = planned.status ?? 200;
  if (typeof planned.body === 'string') {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...planned.headers });
    response.end(planned.body);
    return;
  }
  sendJson(response, status, planned.body ?? {}, planned.headers);
}

/**
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function splitIntoPieces(text, count) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / count));
  const pieces = [];
  for (let start = 0; start < text.length; start += size) pieces.push(text.slice(start, start + size));
  return pieces;
}

/**
 * @param {string} name
 * @returns {string}
 */
function mockDigest(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, '0').repeat(8);
}
