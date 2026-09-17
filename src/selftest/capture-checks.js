// Checks over captured OpenAI-compatible `/v1/chat/completions` request bodies and mock request logs
// (spec 20.3 C1, C5, C7, C8, C11; 20.4 self-test; 8.8 `doctor --capture`). They return results
// instead of throwing, so `doctor --selftest` can report every failed rule at once.
import { NATIVE_LOAD_PATHS } from './mock-ollama.js';

// Endpoints that make a real server load a model. A no-load scenario that records one broke a rule.
export const MODEL_LOAD_PATHS = Object.freeze([...NATIVE_LOAD_PATHS, '/v1/chat/completions', '/v1/completions', '/v1/embeddings']);

/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {boolean} ok
 * @property {string} message  What was checked, and on failure what was found.
 */

/**
 * @typedef {object} CapturedChatBody
 * @property {string} [model]
 * @property {Array<{ role: string, content?: unknown }>} [messages]
 * @property {Array<{ type?: string, function?: { name?: string } }>} [tools]
 * @property {number} [temperature]
 * @property {number} [top_p]
 * @property {number} [max_tokens]
 * @property {{ include_usage?: boolean }} [stream_options]
 */

/**
 * Text of an OpenAI message `content`: a string or an array of parts with `text`.
 * @param {unknown} content
 * @returns {string}
 */
export function getMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
}

/**
 * @param {CapturedChatBody} body
 * @returns {string[]}
 */
export function getToolNames(body) {
  return (body.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean);
}

/**
 * @param {CapturedChatBody} body
 * @returns {string[]}  Text of each system message, in order.
 */
export function getSystemTexts(body) {
  return (body.messages ?? []).filter((message) => message.role === 'system').map((message) => getMessageText(message.content));
}

/**
 * @param {CapturedChatBody} body
 * @returns {CheckResult}
 */
export function checkSingleSystemMessage(body) {
  const count = getSystemTexts(body).length;
  const first = body.messages?.[0]?.role;
  const ok = count === 1 && first === 'system';
  return result('single-system-message', ok, ok
    ? 'exactly one system message, sent first'
    : `expected exactly one system message first; found ${count}, first role ${first ?? 'none'}`);
}

/**
 * @param {CapturedChatBody} body
 * @param {string} marker
 * @returns {CheckResult}
 */
export function checkSystemContains(body, marker) {
  const ok = getSystemTexts(body).some((text) => text.includes(marker));
  return result('system-contains-marker', ok, ok ? `system message contains ${marker}` : `system message does not contain ${marker}`);
}

/**
 * @param {unknown} value  Any captured value; it is searched as JSON text.
 * @param {readonly string[]} canaries
 * @param {string} [id]
 * @returns {CheckResult}
 */
export function checkNoCanaries(value, canaries, id = 'no-canaries') {
  const text = JSON.stringify(value) ?? '';
  const found = canaries.filter((canary) => text.includes(canary));
  return result(id, found.length === 0, found.length === 0 ? `none of ${canaries.length} canary markers present` : `canary content present: ${found.join(', ')}`);
}

/**
 * @param {CapturedChatBody} body
 * @param {{ temperature?: number, topP?: number, maxTokens?: number }} expected
 * @returns {CheckResult}
 */
export function checkSampling(body, { temperature, topP, maxTokens }) {
  const problems = [];
  if (temperature !== undefined && body.temperature !== temperature) problems.push(`temperature ${body.temperature} (expected ${temperature})`);
  if (topP !== undefined && body.top_p !== topP) problems.push(`top_p ${body.top_p} (expected ${topP})`);
  if (maxTokens !== undefined && body.max_tokens !== maxTokens) problems.push(`max_tokens ${body.max_tokens} (expected ${maxTokens})`);
  return result('sampling', problems.length === 0, problems.length === 0 ? 'temperature, top_p and max_tokens as expected' : problems.join('; '));
}

/**
 * @param {CapturedChatBody} body
 * @param {readonly string[]} expected  Exact tool names; order does not matter.
 * @param {string} [id]
 * @returns {CheckResult}
 */
export function checkToolNames(body, expected, id = 'tool-names') {
  const actual = new Set(getToolNames(body));
  const wanted = new Set(expected);
  const missing = [...wanted].filter((name) => !actual.has(name)).sort();
  const unexpected = [...actual].filter((name) => !wanted.has(name)).sort();
  const ok = missing.length === 0 && unexpected.length === 0;
  const details = [missing.length ? `missing ${missing.join(', ')}` : '', unexpected.length ? `unexpected ${unexpected.join(', ')}` : ''].filter(Boolean);
  return result(id, ok, ok ? `tool names equal the expected ${wanted.size}` : details.join('; '));
}

/**
 * @param {CapturedChatBody} body
 * @returns {CheckResult}
 */
export function checkIncludeUsage(body) {
  const ok = body.stream_options?.include_usage === true;
  return result('include-usage', ok, ok ? 'stream_options.include_usage is true' : 'stream_options.include_usage is not true');
}

/**
 * @param {ReadonlyArray<{ method?: string, path?: string, url?: string }>} requests  Mock server log entries.
 * @param {readonly string[]} [paths]  Default: every model-load path. Pass `NATIVE_LOAD_PATHS` when
 *   `/v1/chat/completions` is expected and only native calls are forbidden.
 * @param {string} [id]
 * @returns {CheckResult}
 */
export function checkNoModelLoadRequests(requests, paths = MODEL_LOAD_PATHS, id = 'no-model-load-requests') {
  const loads = requests
    .map((request) => ({ method: request.method ?? 'GET', pathname: new URL(request.path ?? request.url ?? '/', 'http://mock').pathname }))
    .filter((request) => paths.includes(request.pathname))
    .map((request) => `${request.method} ${request.pathname}`);
  return result(id, loads.length === 0, loads.length === 0 ? 'no request could load a model' : `model-load requests were sent: ${loads.join(', ')}`);
}

/**
 * @param {readonly CapturedChatBody[]} bodies
 * @param {number} budgetTokens
 * @param {(body: CapturedChatBody) => number} estimateTokens
 * @returns {CheckResult}
 */
export function checkPromptsWithinBudget(bodies, budgetTokens, estimateTokens) {
  const sizes = bodies.map(estimateTokens);
  const over = sizes.filter((size) => size > budgetTokens);
  const largest = sizes.length ? Math.max(...sizes) : 0;
  return result('prompts-within-budget', over.length === 0, over.length === 0
    ? `${sizes.length} requests, largest about ${largest} tokens, budget ${budgetTokens}`
    : `${over.length} of ${sizes.length} requests exceed the budget of ${budgetTokens} tokens (largest about ${largest})`);
}

/**
 * @param {string} id
 * @param {boolean} ok
 * @param {string} message
 * @returns {CheckResult}
 */
export function result(id, ok, message) {
  return { id, ok, message };
}
