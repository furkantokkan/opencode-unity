// Assertions over captured OpenAI-compatible `/v1/chat/completions` request bodies (contract tests C1,
// C5, C8 and `doctor --capture`) and over mock server request logs.
//
// Every rule lives once, in the shipped checks of src/selftest/capture-checks.js, which `doctor
// --selftest` also runs. This file only turns a check result into an assertion, so a test and the
// product can never disagree about what a captured request must look like.
import assert from 'node:assert/strict';
import {
  MODEL_LOAD_PATHS,
  checkIncludeUsage,
  checkNoCanaries,
  checkNoModelLoadRequests,
  checkPromptsWithinBudget,
  checkSampling,
  checkSingleSystemMessage,
  checkSystemContains,
  checkToolNames,
  getMessageText,
  getSystemTexts,
  getToolNames,
} from '../../src/selftest/capture-checks.js';

export { MODEL_LOAD_PATHS, getMessageText, getSystemTexts, getToolNames };

/** @typedef {import('../../src/selftest/capture-checks.js').CapturedChatBody} ChatRequest */
/** @typedef {import('../../src/selftest/capture-checks.js').CheckResult} CheckResult */

/**
 * Turns a check result into an assertion.
 * @param {CheckResult} check
 * @returns {void}
 */
function expect(check) {
  assert.ok(check.ok, check.message);
}

/**
 * @param {ChatRequest} request
 * @returns {NonNullable<ChatRequest['messages']>}  The system messages, in order.
 */
export function getSystemMessages(request) {
  return (request.messages ?? []).filter((message) => message.role === 'system');
}

/**
 * @param {ChatRequest} request
 * @returns {string} The system message text.
 */
export function assertSingleSystemMessage(request) {
  expect(checkSingleSystemMessage(request));
  return getSystemTexts(request)[0];
}

/**
 * @param {ChatRequest} request
 * @param {readonly string[]} canaries  Marker strings planted in files that must never reach the model.
 */
export function assertNoCanaries(request, canaries) {
  expect(checkNoCanaries(request, canaries));
}

/**
 * @param {ChatRequest} request
 * @param {string} marker
 */
export function assertSystemContains(request, marker) {
  expect(checkSingleSystemMessage(request));
  expect(checkSystemContains(request, marker));
}

/**
 * @param {ChatRequest} request
 * @param {{ temperature?: number, topP?: number, maxTokens?: number }} expected
 */
export function assertSampling(request, expected) {
  expect(checkSampling(request, expected));
}

/**
 * @param {ChatRequest} request
 * @param {readonly string[]} expected  Exact tool names; order does not matter.
 */
export function assertToolNames(request, expected) {
  expect(checkToolNames(request, expected));
}

/**
 * @param {ChatRequest} request
 */
export function assertIncludesUsage(request) {
  expect(checkIncludeUsage(request));
}

/**
 * @param {ReadonlyArray<{ method?: string, url?: string, path?: string }>} requests  Mock server log entries.
 * @param {readonly string[]} [paths]  Default: every model-load path.
 */
export function assertNoModelLoadRequests(requests, paths = MODEL_LOAD_PATHS) {
  expect(checkNoModelLoadRequests(requests, paths));
}

/**
 * @param {readonly ChatRequest[]} bodies
 * @param {number} budgetTokens
 * @param {(body: ChatRequest) => number} estimateTokens
 */
export function assertPromptsWithinBudget(bodies, budgetTokens, estimateTokens) {
  expect(checkPromptsWithinBudget(bodies, budgetTokens, estimateTokens));
}
