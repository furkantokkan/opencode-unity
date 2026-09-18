// Two failure modes a 16K local model shows that OpenCode has no opinion about (spec 8.7, 8.8).
//
// 1. Ollama cuts an oversized prompt instead of refusing it, so the model answers confidently from
//    half a conversation. The only signal is the prompt token count it reports back, which lands on
//    an exact arithmetic signature (OL llm/llama_server.go L291-331).
// 2. A small model sometimes writes a tool call as text. OpenCode streams that as ordinary output, so
//    the step quietly does nothing.
//
// Both are read-only detections: they toast and log, and never change the request.
import { isTruncationSignature } from './tokens.js';

/** Markers Qwen-family models emit when they write a call instead of making one. */
export const TEXT_TOOL_CALL_MARKERS = Object.freeze(['<function=', '<tool_call>', '<|tool_call_start|>']);

/**
 * @typedef {object} AssistantUsage
 * @property {string | null} sessionId
 * @property {string | null} messageId
 * @property {number} inputTokens
 * @property {number} outputTokens
 */

/**
 * The prompt of this response was silently cut.
 * @param {{ inputTokens: number, numCtx: number, numKeep: number }} input
 * @returns {boolean}
 */
export function isTruncated(input) {
  return isTruncationSignature(input);
}

/**
 * @param {string} text
 * @returns {string | null} The marker that matched, or null.
 */
export function findTextToolCallMarker(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return TEXT_TOOL_CALL_MARKERS.find((marker) => text.includes(marker)) ?? null;
}

/**
 * Pulls the prompt and output token counts out of a `message.updated` event, ignoring every event
 * that is not a finished assistant message with usage. Shapes vary between OpenCode versions, so
 * anything unexpected reads as "no usage" instead of throwing.
 * @param {unknown} event
 * @returns {AssistantUsage | null}
 */
export function readAssistantUsage(event) {
  const typed = /** @type {{ type?: unknown, properties?: { info?: Record<string, any> } } | null} */ (event);
  if (typed?.type !== 'message.updated') return null;
  const info = typed.properties?.info;
  if (!info || info.role !== 'assistant') return null;
  const tokens = info.tokens;
  const inputTokens = readCount(tokens?.input);
  if (inputTokens === null) return null;
  return {
    sessionId: typeof info.sessionID === 'string' ? info.sessionID : null,
    messageId: typeof info.id === 'string' ? info.id : null,
    inputTokens,
    outputTokens: readCount(tokens?.output) ?? 0,
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
