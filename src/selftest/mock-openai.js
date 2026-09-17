// Mock OpenAI-compatible endpoint (spec 20.3): records every request and replays scripted assistant
// turns the way Ollama 0.34.1 answers `/v1/chat/completions` (OL `openai/openai.go`): SSE chunks with
// `system_fingerprint: "fp_ollama"`, a separate finish chunk, a usage chunk only when the client asked
// for `stream_options.include_usage`, then `data: [DONE]`. It never forwards anything anywhere.
import { delay, sendJson, startMockServer } from './mock-server.js';

export const OPENAI_CHAT_PATH = '/v1/chat/completions';
export const OPENAI_MODELS_PATH = '/v1/models';

// Qwen tokens per character used for default usage numbers; the same calibration the budget estimator
// starts from (spec 8.8).
const CHARS_PER_TOKEN = 3.5;

// OpenCode 1.18.31 request shapes that are not agent steps. The title prompt is in OC
// `session/prompt.ts` L235; the compaction request has no tools and wraps the history in
// `<conversation>` tags (OC `session/compaction.ts` L424-445 with `buildPrompt` from core).
export const TITLE_PROMPT_PREFIX = 'Generate a title for this conversation';
export const COMPACTION_PROMPT_MARKER = '<conversation>';

export const DEFAULT_TURN = Object.freeze({ text: 'SCRIPT_DONE' });
export const DEFAULT_COMPACTION_SUMMARY = 'Mock summary: the task so far is recorded here in a few lines.';

/**
 * @typedef {'chat' | 'title' | 'compaction'} ChatRequestKind
 */

/**
 * @typedef {object} ToolCallSpec
 * @property {string} name
 * @property {Record<string, unknown> | string} [arguments]  Objects are serialized to a JSON string.
 * @property {string} [id]
 */

/**
 * @typedef {object} UsageSpec
 * @property {number} [promptTokens]      Default: estimated from the request text.
 * @property {number} [completionTokens]  Default: estimated from the reply text.
 * @property {number} [cachedTokens]      Adds `prompt_tokens_details.cached_tokens`.
 */

/**
 * @typedef {object} TurnSpec
 * @property {string} [text]
 * @property {string} [reasoning]
 * @property {ToolCallSpec[]} [toolCalls]
 * @property {string} [finishReason]      Default: `tool_calls` when tool calls exist, else `stop`.
 * @property {UsageSpec | null} [usage]   null leaves usage out entirely.
 * @property {number} [status]            A status >= 400 sends `errorBody` instead of a completion.
 * @property {Record<string, string>} [headers]
 * @property {unknown} [errorBody]
 * @property {number} [delayMs]           Wait before sending headers.
 * @property {number} [chunkDelayMs]      Wait between SSE events.
 * @property {number} [textChunks]        Pieces the text is streamed in (default 3).
 * @property {boolean} [splitArguments]   Stream tool arguments in pieces, OpenAI style (Ollama sends them whole).
 * @property {boolean} [hang]             Send headers and the first events, then never finish.
 * @property {boolean} [dropConnection]   Destroy the socket after the first content event.
 */

/**
 * @typedef {TurnSpec | ((body: ChatBody, context: { index: number, kind: ChatRequestKind }) => TurnSpec)} Turn
 */

/**
 * @typedef {object} ChatBody
 * @property {string} [model]
 * @property {Array<{ role: string, content?: unknown, tool_calls?: unknown[] }>} [messages]
 * @property {Array<{ type?: string, function?: { name?: string } }>} [tools]
 * @property {boolean} [stream]
 * @property {{ include_usage?: boolean }} [stream_options]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {number} [max_tokens]
 */

/**
 * @typedef {object} ChatRecord
 * @property {import('./mock-server.js').MockRequest} request
 * @property {ChatBody} body
 * @property {ChatRequestKind} kind
 * @property {number | null} turnIndex  Script position served, or null for kind turns and the default.
 * @property {number} status
 */

/**
 * @typedef {object} MockOpenAiOptions
 * @property {Turn[]} [turns]
 * @property {Turn} [defaultTurn]           Served when the script is exhausted.
 * @property {Partial<Record<ChatRequestKind, Turn>>} [kindTurns]  Title and compaction replies; they do not consume the script.
 * @property {string[]} [models]            Ids listed by `GET /v1/models`.
 * @property {(body: ChatBody) => void} [onChat]  Called for every chat request before the reply.
 * @property {() => number} [now]
 */

/**
 * @param {MockOpenAiOptions} [options]
 */
export function createMockOpenAi(options = {}) {
  const now = options.now ?? Date.now;
  /** @type {Turn[]} */
  let script = [...(options.turns ?? [])];
  let served = 0;
  /** @type {Partial<Record<ChatRequestKind, Turn>>} */
  const kindTurns = {
    compaction: { text: DEFAULT_COMPACTION_SUMMARY },
    title: { text: 'Mock session' },
    ...options.kindTurns,
  };
  /** @type {import('./mock-server.js').MockRequest[]} */
  const requests = [];
  /** @type {ChatRecord[]} */
  const chats = [];
  let completionCount = 0;

  /**
   * @param {ChatBody} body
   * @param {ChatRequestKind} kind
   * @returns {{ turn: TurnSpec, turnIndex: number | null }}
   */
  function takeTurn(body, kind) {
    const kindTurn = kind === 'chat' ? undefined : kindTurns[kind];
    if (kindTurn) return { turn: resolveTurn(kindTurn, body, chats.length, kind), turnIndex: null };
    if (served < script.length) {
      const turnIndex = served;
      served += 1;
      return { turn: resolveTurn(script[turnIndex], body, chats.length, kind), turnIndex };
    }
    return { turn: resolveTurn(options.defaultTurn ?? DEFAULT_TURN, body, chats.length, kind), turnIndex: null };
  }

  return {
    name: 'openai',
    requests,
    chats,
    /** Replaces the script and restarts it; recorded requests are kept. */
    setScript(/** @type {Turn[]} */ turns) {
      script = [...turns];
      served = 0;
    },
    enqueue(/** @type {Turn[]} */ ...turns) {
      script.push(...turns);
    },
    setKindTurn(/** @type {ChatRequestKind} */ kind, /** @type {Turn} */ turn) {
      kindTurns[kind] = turn;
    },
    get servedTurns() {
      return served;
    },
    get remainingTurns() {
      return script.length - served;
    },
    /** @param {ChatRequestKind} [kind] */
    getChatBodies(kind) {
      return chats.filter((chat) => kind === undefined || chat.kind === kind).map((chat) => chat.body);
    },
    /**
     * @param {import('./mock-server.js').MockRequest} request
     * @param {import('node:http').ServerResponse} response
     */
    async handle(request, response) {
      if (!request.path.startsWith('/v1/')) return false;
      requests.push(request);
      if (request.method === 'GET' && request.path === OPENAI_MODELS_PATH) {
        const created = Math.floor(now() / 1000);
        const data = (options.models ?? []).map((id) => ({ id, object: 'model', created, owned_by: 'library' }));
        sendJson(response, 200, { object: 'list', data });
        return true;
      }
      if (request.method !== 'POST' || request.path !== OPENAI_CHAT_PATH) {
        sendJson(response, 404, { error: { message: `mock: ${request.method} ${request.path} is not served`, type: 'not_found_error' } });
        return true;
      }
      const body = /** @type {ChatBody | undefined} */ (request.body);
      if (!body || !Array.isArray(body.messages)) {
        sendJson(response, 400, { error: { message: 'mock: body must be JSON with a messages array', type: 'invalid_request_error' } });
        return true;
      }
      const kind = classifyChatRequest(body);
      const { turn, turnIndex } = takeTurn(body, kind);
      const status = turn.status ?? 200;
      chats.push({ request, body, kind, turnIndex, status });
      options.onChat?.(body);
      completionCount += 1;
      await sendTurn(response, body, turn, `chatcmpl-${completionCount}`, now);
      return true;
    },
  };
}

/**
 * @param {MockOpenAiOptions & { port?: number }} [options]
 */
export async function startMockOpenAi(options = {}) {
  const mock = createMockOpenAi(options);
  const server = await startMockServer({ handlers: [mock], port: options.port });
  return { mock, server, url: server.url, baseUrl: `${server.url}/v1`, close: server.close };
}

/**
 * @param {ChatBody} body
 * @returns {ChatRequestKind}
 */
export function classifyChatRequest(body) {
  const userTexts = (body.messages ?? []).filter((message) => message.role === 'user').map((message) => getContentText(message.content));
  if (userTexts.some((text) => text.startsWith(TITLE_PROMPT_PREFIX))) return 'title';
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools && userTexts.some((text) => text.includes(COMPACTION_PROMPT_MARKER))) return 'compaction';
  return 'chat';
}

/**
 * Text of an OpenAI message `content`: a string or an array of parts with `text`.
 * @param {unknown} content
 * @returns {string}
 */
export function getContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
}

/**
 * Deterministic prompt-size estimate over message text and tool definitions. It is a mock default
 * for `usage.prompt_tokens`, not the product estimator.
 * @param {ChatBody} body
 * @returns {number}
 */
export function estimatePromptTokens(body) {
  let chars = JSON.stringify(body.tools ?? []).length;
  for (const message of body.messages ?? []) {
    chars += getContentText(message.content).length;
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 503 with `Retry-After`, the loopback gate's guard-block answer (spec 8.10). OpenCode retries 5xx and
 * honors the header (OC `session/retry.ts` L59-64, L92-98).
 * @param {{ retryAfterSec?: number, message?: string, type?: string }} [options]
 * @returns {TurnSpec}
 */
export function createServiceUnavailableTurn({ retryAfterSec = 30, message = 'mock backend is busy', type = 'gpu_guard_blocked' } = {}) {
  return {
    status: 503,
    headers: { 'retry-after': String(retryAfterSec) },
    errorBody: { error: { type, message } },
  };
}

/**
 * 413 with `context_length_exceeded`, which OpenCode classifies as context overflow
 * (OC `provider/error.ts` L172-181).
 * @param {{ message?: string }} [options]
 * @returns {TurnSpec}
 */
export function createContextOverflowTurn({ message = 'mock: the prompt does not fit the context window' } = {}) {
  return { status: 413, errorBody: { error: { message, type: 'invalid_request_error', param: null, code: 'context_length_exceeded' } } };
}

/**
 * A tool call written as plain text in the qwen3-coder XML form, which the parser only treats as a
 * call after a literal `<tool_call>` (OL `model/parsers/qwen3coder.go` L22). Used to test text-form
 * call detection.
 * @param {string} name
 * @param {Record<string, string | number | boolean>} [args]
 * @param {{ withToolCallTag?: boolean }} [options]
 * @returns {TurnSpec}
 */
export function createTextToolCallTurn(name, args = {}, { withToolCallTag = false } = {}) {
  const parameters = Object.entries(args).map(([key, value]) => `<parameter=${key}>\n${value}\n</parameter>\n`).join('');
  const call = `<function=${name}>\n${parameters}</function>`;
  return { text: withToolCallTag ? `<tool_call>\n${call}\n</tool_call>` : call };
}

/**
 * @param {Turn} turn
 * @param {ChatBody} body
 * @param {number} index
 * @param {ChatRequestKind} kind
 * @returns {TurnSpec}
 */
function resolveTurn(turn, body, index, kind) {
  return typeof turn === 'function' ? turn(body, { index, kind }) : turn;
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {ChatBody} body
 * @param {TurnSpec} turn
 * @param {string} id
 * @param {() => number} now
 */
async function sendTurn(response, body, turn, id, now) {
  if (turn.delayMs) await delay(turn.delayMs);
  if (response.destroyed) return;
  const status = turn.status ?? 200;
  if (status >= 400) {
    sendJson(response, status, turn.errorBody ?? { error: { message: `mock status ${status}`, type: 'api_error' } }, turn.headers);
    return;
  }
  if (body.stream === true) {
    await streamTurn(response, body, turn, id, now);
    return;
  }
  sendJson(response, status, buildCompletion(body, turn, id, now), turn.headers);
}

/**
 * @param {ChatBody} body
 * @param {TurnSpec} turn
 * @param {string} id
 * @param {() => number} now
 */
function buildCompletion(body, turn, id, now) {
  const toolCalls = buildToolCalls(turn, id);
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: turn.text ?? '' };
  if (turn.reasoning) message.reasoning = turn.reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls.map(({ index, ...call }) => call);
  /** @type {Record<string, unknown>} */
  const completion = {
    id,
    object: 'chat.completion',
    created: Math.floor(now() / 1000),
    model: body.model ?? 'mock',
    system_fingerprint: 'fp_ollama',
    choices: [{ index: 0, message, finish_reason: getFinishReason(turn) }],
  };
  const usage = buildUsage(body, turn);
  if (usage) completion.usage = usage;
  return completion;
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {ChatBody} body
 * @param {TurnSpec} turn
 * @param {string} id
 * @param {() => number} now
 */
async function streamTurn(response, body, turn, id, now) {
  const created = Math.floor(now() / 1000);
  const chunk = (/** @type {Record<string, unknown>} */ fields) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model ?? 'mock',
    system_fingerprint: 'fp_ollama',
    ...fields,
  });
  const deltaChunk = (/** @type {Record<string, unknown>} */ delta) => chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
  const events = [];
  let roleSent = false;
  const withRole = (/** @type {Record<string, unknown>} */ delta) => {
    if (roleSent) return delta;
    roleSent = true;
    return { role: 'assistant', ...delta };
  };
  if (turn.reasoning) events.push(deltaChunk(withRole({ content: '', reasoning: turn.reasoning })));
  for (const piece of splitText(turn.text ?? '', turn.textChunks ?? 3)) events.push(deltaChunk(withRole({ content: piece })));
  for (const call of buildToolCalls(turn, id)) {
    for (const part of splitToolCall(call, turn.splitArguments === true)) events.push(deltaChunk(withRole({ tool_calls: [part] })));
  }
  if (!roleSent) events.push(deltaChunk(withRole({ content: '' })));
  events.push(chunk({ choices: [{ index: 0, delta: {}, finish_reason: getFinishReason(turn) }] }));
  const usage = body.stream_options?.include_usage === true ? buildUsage(body, turn) : null;
  if (usage) events.push(chunk({ choices: [], usage }));

  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...turn.headers });
  for (const [position, event] of events.entries()) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (position === 0 && turn.dropConnection) {
      response.destroy();
      return;
    }
    if (position === 0 && turn.hang) return;
    if (turn.chunkDelayMs) await delay(turn.chunkDelayMs);
  }
  if (!response.destroyed) response.end('data: [DONE]\n\n');
}

/**
 * @param {TurnSpec} turn
 * @param {string} id
 * @returns {Array<{ index: number, id: string, type: 'function', function: { name: string, arguments: string } }>}
 */
function buildToolCalls(turn, id) {
  return (turn.toolCalls ?? []).map((call, index) => ({
    index,
    id: call.id ?? `call_${id.replace(/[^a-z0-9]/gi, '')}_${index}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
    },
  }));
}

/**
 * @param {{ index: number, id: string, type: 'function', function: { name: string, arguments: string } }} call
 * @param {boolean} split
 * @returns {Array<Record<string, unknown>>}
 */
function splitToolCall(call, split) {
  if (!split || call.function.arguments.length < 2) return [call];
  const [head, ...rest] = splitText(call.function.arguments, 3);
  return [
    { ...call, function: { name: call.function.name, arguments: head } },
    ...rest.map((piece) => ({ index: call.index, function: { arguments: piece } })),
  ];
}

/**
 * @param {TurnSpec} turn
 * @returns {string}
 */
function getFinishReason(turn) {
  if (turn.finishReason) return turn.finishReason;
  return turn.toolCalls && turn.toolCalls.length > 0 ? 'tool_calls' : 'stop';
}

/**
 * @param {ChatBody} body
 * @param {TurnSpec} turn
 * @returns {Record<string, unknown> | null}
 */
function buildUsage(body, turn) {
  if (turn.usage === null) return null;
  const spec = turn.usage ?? {};
  const outputChars = (turn.text ?? '').length + (turn.reasoning ?? '').length + JSON.stringify(turn.toolCalls ?? []).length;
  const promptTokens = spec.promptTokens ?? estimatePromptTokens(body);
  const completionTokens = spec.completionTokens ?? Math.max(1, Math.ceil(outputChars / CHARS_PER_TOKEN));
  /** @type {Record<string, unknown>} */
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  if (spec.cachedTokens !== undefined) usage.prompt_tokens_details = { cached_tokens: spec.cachedTokens };
  return usage;
}

/**
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function splitText(text, count) {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, count)));
  const pieces = [];
  for (let start = 0; start < text.length; start += size) pieces.push(text.slice(start, start + size));
  return pieces;
}
