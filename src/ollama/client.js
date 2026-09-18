// Native Ollama API client for the read-only endpoints (version, tags, show, ps) and the unload call
// (spec 4.3, 5.5). It never loads a model: the only POST to /api/chat here is the unload body with empty
// messages and keep_alive 0, which Ollama handles before scheduling (OL server/routes.go L2500-2511).
// Every model load goes through guardedChat() (S1), which uses the body builders exported below.
import { CliError, EXIT } from '../cli/exit-codes.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

const CHAT_ROUTE = '/api/chat';
// Routes that can make Ollama load a model. The generic request path refuses them.
const MODEL_LOAD_ROUTES = ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings'];
const MAX_ERROR_BODY_CHARS = 300;

/**
 * @typedef {object} OllamaClientOptions
 * @property {string} [baseUrl]
 * @property {typeof fetch} [fetch]
 * @property {number} [timeoutMs]  Per request.
 */

/**
 * @typedef {object} InstalledModel
 * @property {string} name
 * @property {string} model
 * @property {number | null} sizeBytes
 * @property {string | null} digest
 * @property {string | null} modifiedAt
 * @property {Record<string, unknown>} details
 */

/**
 * @typedef {object} RunningModel
 * @property {string} name
 * @property {string} model
 * @property {number | null} contextLength
 * @property {string | null} expiresAt       RFC 3339 text as Ollama sent it.
 * @property {number | null} sizeBytes
 * @property {number | null} sizeVramBytes
 */

/**
 * @typedef {object} ShowResult
 * @property {Record<string, Array<string | number | boolean>>} parameters  Every value of each name, in order.
 * @property {string} parametersText
 * @property {string} renderer
 * @property {string} parser
 * @property {string} system
 * @property {string} template
 * @property {string[]} capabilities
 * @property {Record<string, unknown>} details
 * @property {Record<string, unknown>} modelInfo
 */

/**
 * @typedef {object} RequestOptions
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 */

/**
 * @param {OllamaClientOptions} [options]
 */
export function createOllamaClient({ baseUrl = DEFAULT_OLLAMA_BASE_URL, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const send = (/** @type {RequestSpec} */ spec) => sendJsonRequest(fetchImpl, base, { timeoutMs, ...spec });

  return {
    baseUrl: base,

    /**
     * @param {RequestOptions} [options]
     * @returns {Promise<string>}
     */
    async getVersion(options = {}) {
      const body = await send({ method: 'GET', route: '/api/version', ...options });
      if (!isRecord(body) || typeof body.version !== 'string' || body.version === '') throw badResponse('/api/version', 'has no version');
      return body.version;
    },

    /**
     * @param {RequestOptions} [options]
     * @returns {Promise<InstalledModel[]>}
     */
    async listModels(options = {}) {
      const body = await send({ method: 'GET', route: '/api/tags', ...options });
      if (!isRecord(body) || !Array.isArray(body.models)) throw badResponse('/api/tags', 'has no models list');
      return body.models.map((entry) => parseInstalledModel(entry));
    },

    /**
     * @param {string} model
     * @param {RequestOptions} [options]
     * @returns {Promise<ShowResult | null>} Null when the model is not installed.
     */
    async showModel(model, options = {}) {
      assertModelName(model);
      const body = await send({ method: 'POST', route: '/api/show', body: { model }, allowNotFound: true, ...options });
      if (body === NOT_FOUND) return null;
      return parseShowResponse(body);
    },

    /**
     * @param {RequestOptions} [options]
     * @returns {Promise<RunningModel[]>}
     */
    async listRunning(options = {}) {
      const body = await send({ method: 'GET', route: '/api/ps', ...options });
      return parseRunningModels(body);
    },

    /**
     * Frees the model's VRAM. Safe to call when it is not loaded.
     * @param {string} model
     * @param {RequestOptions} [options]
     * @returns {Promise<{ unloaded: boolean }>} unloaded is false when Ollama does not know the model.
     */
    async unload(model, options = {}) {
      assertModelName(model);
      const body = await send({ method: 'POST', route: CHAT_ROUTE, body: buildUnloadBody(model), allowNotFound: true, allowModelLoadRoute: true, ...options });
      return { unloaded: body !== NOT_FOUND };
    },
  };
}

/** @typedef {ReturnType<typeof createOllamaClient>} OllamaClient */

/**
 * The only body this module sends to /api/chat.
 * @param {string} model
 * @returns {{ model: string, messages: [], keep_alive: 0 }}
 */
export function buildUnloadBody(model) {
  return { model, messages: [], keep_alive: 0 };
}

/**
 * Body that loads the model at the preset context without generating (spec 5.5 `warm`; OL
 * server/routes.go L2629-2648). Sent only by guardedChat().
 * @param {{ model: string, numCtx: number, keepAlive: string }} input
 */
export function buildWarmBody({ model, numCtx, keepAlive }) {
  assertModelName(model);
  assertPositiveInteger(numCtx, 'numCtx');
  return { model, messages: [], keep_alive: keepAlive, options: { num_ctx: numCtx } };
}

/**
 * @typedef {object} ChatBodyInput
 * @property {string} model
 * @property {Array<{ role: string, content: string }>} messages
 * @property {number} numCtx
 * @property {string} keepAlive
 * @property {{ temperature: number, topP: number, topK: number, repeatPenalty: number }} sampling
 * @property {number} maxOutputTokens
 */

/**
 * Native chat body (spec 12.3). Only num_ctx, which always equals the profile value, and sampling options
 * are sent: runner options such as num_batch or num_gpu would reload the shared model, and truncate and
 * shift are left to the preflight.
 * @param {ChatBodyInput} input
 */
export function buildChatBody({ model, messages, numCtx, keepAlive, sampling, maxOutputTokens }) {
  assertModelName(model);
  assertPositiveInteger(numCtx, 'numCtx');
  assertPositiveInteger(maxOutputTokens, 'maxOutputTokens');
  if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
  return {
    model,
    messages,
    stream: true,
    keep_alive: keepAlive,
    options: {
      num_ctx: numCtx,
      temperature: sampling.temperature,
      top_p: sampling.topP,
      top_k: sampling.topK,
      repeat_penalty: sampling.repeatPenalty,
      num_predict: maxOutputTokens,
    },
  };
}

/**
 * @typedef {object} ChatResult
 * @property {string} content
 * @property {number} promptTokens
 * @property {number} outputTokens
 * @property {number} totalDurationNs
 * @property {number} loadDurationNs
 * @property {string} doneReason
 */

/**
 * Reads a native NDJSON chat stream to its final `done: true` line.
 * @param {AsyncIterable<Uint8Array | string>} stream
 * @returns {Promise<ChatResult>}
 */
export async function readChatStream(stream) {
  const decoder = new TextDecoder();
  const state = { content: '', final: /** @type {Record<string, any> | null} */ (null) };
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      applyChatLine(buffer.slice(0, newline), state);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  applyChatLine(buffer + decoder.decode(), state);
  if (!state.final) throw badResponse(CHAT_ROUTE, 'stream ended before the final chunk');
  return {
    content: state.content,
    promptTokens: toCount(state.final.prompt_eval_count),
    outputTokens: toCount(state.final.eval_count),
    totalDurationNs: toCount(state.final.total_duration),
    loadDurationNs: toCount(state.final.load_duration),
    doneReason: typeof state.final.done_reason === 'string' ? state.final.done_reason : '',
  };
}

/**
 * `/api/show` returns parameters as `name<padding> value` lines with Go-quoted strings (OL
 * server/routes.go L1499-1511). Repeated names such as `stop` keep every value.
 * @param {string} text
 * @returns {Record<string, Array<string | number | boolean>>}
 */
export function parseShowParameters(text) {
  /** @type {Record<string, Array<string | number | boolean>>} */
  const parameters = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    (parameters[name] ??= []).push(parseParameterValue(raw));
  }
  return parameters;
}

/**
 * @param {unknown} body
 * @returns {ShowResult}
 */
export function parseShowResponse(body) {
  if (!isRecord(body)) throw badResponse('/api/show', 'is not an object');
  const parametersText = typeof body.parameters === 'string' ? body.parameters : '';
  return {
    parameters: parseShowParameters(parametersText),
    parametersText,
    renderer: stringOrEmpty(body.renderer),
    parser: stringOrEmpty(body.parser),
    system: stringOrEmpty(body.system),
    template: stringOrEmpty(body.template),
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.filter((item) => typeof item === 'string') : [],
    details: isRecord(body.details) ? body.details : {},
    modelInfo: isRecord(body.model_info) ? body.model_info : {},
  };
}

/**
 * @param {unknown} body
 * @returns {RunningModel[]}
 */
export function parseRunningModels(body) {
  if (!isRecord(body) || !Array.isArray(body.models)) throw badResponse('/api/ps', 'has no models list');
  return body.models.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') throw badResponse('/api/ps', 'lists a model without a name');
    return {
      name: entry.name,
      model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : entry.name,
      contextLength: Number.isSafeInteger(entry.context_length) ? /** @type {number} */ (entry.context_length) : null,
      expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : null,
      sizeBytes: toSize(entry.size),
      sizeVramBytes: toSize(entry.size_vram),
    };
  });
}

/**
 * Ollama treats `name` and `name:latest` as the same model.
 * @param {string} name
 * @returns {string}
 */
export function normalizeModelName(name) {
  const trimmed = String(name).trim().toLowerCase();
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? trimmed : `${trimmed}:latest`;
}

/**
 * @template {{ name: string, model?: string }} T
 * @param {readonly T[]} models
 * @param {string} name
 * @returns {T | undefined}
 */
export function findModel(models, name) {
  const wanted = normalizeModelName(name);
  return models.find((entry) => normalizeModelName(entry.name) === wanted || (entry.model !== undefined && normalizeModelName(entry.model) === wanted));
}

/**
 * Compares dotted numeric versions such as `0.34.1`. Pre-release suffixes sort before the release.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative, zero or positive.
 */
export function compareVersions(a, b) {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let index = 0; index < Math.max(coreA.length, coreB.length); index += 1) {
    const difference = (coreA[index] ?? 0) - (coreB[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (preA === preB) return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;
  return preA < preB ? -1 : 1;
}

/**
 * Normalizes a base URL: no trailing slash and no `/v1` suffix, so OpenAI-style URLs from a runtime
 * profile work too. A refusal never repeats the value: the reason to refuse it is most often a password
 * or a key in it, and this message reaches `doctor --markdown`, which users paste into public issues.
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    throw new CliError('Invalid Ollama base URL: it is not a URL; use http(s)://host:port', { exitCode: EXIT.USAGE, code: 'ollama_base_url_invalid' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`Invalid Ollama base URL: the scheme '${url.protocol}' is not http or https; use http(s)://host:port`, { exitCode: EXIT.USAGE, code: 'ollama_base_url_invalid' });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError(`Invalid Ollama base URL for ${url.origin}: a user name, password, query or fragment is not allowed; use http(s)://host:port`, { exitCode: EXIT.USAGE, code: 'ollama_base_url_invalid' });
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * A base URL as far as it is safe to print: the origin only, without a user, a password, a path, a
 * query or a fragment; or a placeholder when it does not parse at all.
 * @param {unknown} baseUrl
 * @returns {string}
 */
export function describeBaseUrlSafely(baseUrl) {
  try {
    const url = new URL(String(baseUrl).trim());
    return url.origin === 'null' ? '(an invalid URL)' : url.origin;
  } catch {
    return '(an invalid URL)';
  }
}

const NOT_FOUND = Symbol('not-found');

/**
 * @typedef {object} RequestSpec
 * @property {'GET' | 'POST'} method
 * @property {string} route
 * @property {unknown} [body]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [allowNotFound]
 * @property {boolean} [allowModelLoadRoute]  Only the unload call sets this.
 */

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} base
 * @param {RequestSpec} spec
 * @returns {Promise<unknown>}
 */
async function sendJsonRequest(fetchImpl, base, { method, route, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, allowNotFound = false, allowModelLoadRoute = false }) {
  if (MODEL_LOAD_ROUTES.includes(route) && !(allowModelLoadRoute && isUnloadBody(body))) {
    throw new TypeError(`${route} can load a model; only guardedChat() may call it`);
  }
  const url = `${base}${route}`;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (timeoutSignal.aborted) {
      throw new CliError(`Ollama did not answer ${route} within ${formatSeconds(timeoutMs)} at ${base}`, { exitCode: EXIT.BLOCKED, code: 'ollama_timeout', cause: error, hint: 'Check that Ollama is running and not busy loading a model.' });
    }
    throw new CliError(`Ollama is not reachable at ${base}: ${describeNetworkError(error)}`, {
      exitCode: EXIT.BLOCKED,
      code: 'ollama_unreachable',
      cause: error,
      hint: 'Start the Ollama app, or set ollama.baseUrl in config.json.',
    });
  }
  if (response.status === 404 && allowNotFound) return NOT_FOUND;
  if (!response.ok) {
    throw new CliError(`Ollama ${method} ${route} returned HTTP ${response.status}: ${describeErrorBody(text)}`, {
      exitCode: EXIT.RUNTIME,
      code: 'ollama_http_error',
      data: { status: response.status, route },
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw badResponse(route, 'is not JSON', error);
  }
}

/**
 * @param {unknown} body
 * @returns {boolean}
 */
function isUnloadBody(body) {
  return isRecord(body) && body.keep_alive === 0 && Array.isArray(body.messages) && body.messages.length === 0 && Object.keys(body).length === 3;
}

/**
 * @param {string} line
 * @param {{ content: string, final: Record<string, any> | null }} state
 */
function applyChatLine(line, state) {
  if (line.trim() === '') return;
  let chunk;
  try {
    chunk = JSON.parse(line);
  } catch (error) {
    throw badResponse(CHAT_ROUTE, `stream has a line that is not JSON: ${truncate(line, 120)}`, error);
  }
  if (!isRecord(chunk)) throw badResponse(CHAT_ROUTE, 'stream has a line that is not an object');
  if (typeof chunk.error === 'string') {
    throw new CliError(`Ollama error: ${truncate(chunk.error, MAX_ERROR_BODY_CHARS)}`, { exitCode: EXIT.RUNTIME, code: 'ollama_stream_error' });
  }
  if (isRecord(chunk.message) && typeof chunk.message.content === 'string') state.content += chunk.message.content;
  if (chunk.done === true) state.final = chunk;
}

/**
 * @param {unknown} entry
 * @returns {InstalledModel}
 */
function parseInstalledModel(entry) {
  if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') throw badResponse('/api/tags', 'lists a model without a name');
  return {
    name: entry.name,
    model: typeof entry.model === 'string' && entry.model !== '' ? entry.model : entry.name,
    sizeBytes: toSize(entry.size),
    digest: typeof entry.digest === 'string' ? entry.digest : null,
    modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : null,
    details: isRecord(entry.details) ? entry.details : {},
  };
}

/**
 * @param {string} raw
 * @returns {string | number | boolean}
 */
function parseParameterValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(raw)) return Number(raw);
  return raw;
}

/**
 * @param {string} version
 * @returns {[number[], string]}
 */
function splitVersion(version) {
  const text = String(version).trim().replace(/^v/i, '');
  const dash = text.indexOf('-');
  const core = dash === -1 ? text : text.slice(0, dash);
  const pre = dash === -1 ? '' : text.slice(dash + 1);
  return [core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0)), pre];
}

/**
 * @param {string} route
 * @param {string} problem
 * @param {unknown} [cause]
 * @returns {CliError}
 */
function badResponse(route, problem, cause) {
  return new CliError(`Unexpected answer from Ollama: ${route} ${problem}`, { exitCode: EXIT.RUNTIME, code: 'ollama_bad_response', cause });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeNetworkError(error) {
  const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (error)?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

/**
 * @param {string} text
 * @returns {string}
 */
function describeErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string') return truncate(parsed.error, MAX_ERROR_BODY_CHARS);
  } catch {
    // Not JSON: show the text.
  }
  return truncate(text.trim() || '(empty body)', MAX_ERROR_BODY_CHARS);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/**
 * @param {string} model
 */
function assertModelName(model) {
  if (typeof model !== 'string' || model.trim() === '' || /[\s"]/.test(model)) throw new TypeError(`Invalid model name '${model}'`);
}

/**
 * @param {number} value
 * @param {string} name
 */
function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer, got ${value}`);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
