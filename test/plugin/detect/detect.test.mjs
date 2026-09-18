// Truncation and text-form tool calls (spec 8.7). Both are read-only detections over data OpenCode
// hands the plugin, so the test's job is mostly to prove that odd shapes read as "nothing found".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TEXT_TOOL_CALL_MARKERS, findTextToolCallMarker, isTruncated, readAssistantUsage } from '../../../plugin/opencode-unity-lib/detect.js';
import { getTruncationLimit } from '../../../plugin/opencode-unity-lib/tokens.js';

/**
 * @param {Record<string, unknown>} info
 */
function messageUpdated(info) {
  return { type: 'message.updated', properties: { info } };
}

describe('truncation detection', () => {
  it('matches the arithmetic signature Ollama leaves at 16K', () => {
    assert.equal(getTruncationLimit(16384, 4), 8194);
    assert.ok(isTruncated({ inputTokens: 8194, numCtx: 16384, numKeep: 4 }));
    assert.ok(isTruncated({ inputTokens: 16383, numCtx: 16384, numKeep: 4 }));
    assert.ok(!isTruncated({ inputTokens: 8193, numCtx: 16384, numKeep: 4 }));
    assert.ok(!isTruncated({ inputTokens: 4000, numCtx: 16384, numKeep: 4 }));
  });
});

describe('assistant usage', () => {
  it('reads the prompt and output counts of a finished assistant message', () => {
    const usage = readAssistantUsage(messageUpdated({ role: 'assistant', id: 'msg1', sessionID: 'ses1', tokens: { input: 5000, output: 120 } }));
    assert.deepEqual(usage, { sessionId: 'ses1', messageId: 'msg1', inputTokens: 5000, outputTokens: 120 });
  });

  it('defaults the output count and the ids it did not get', () => {
    const usage = readAssistantUsage(messageUpdated({ role: 'assistant', tokens: { input: 10 } }));
    assert.deepEqual(usage, { sessionId: null, messageId: null, inputTokens: 10, outputTokens: 0 });
  });

  it('ignores everything that is not an assistant message with a prompt count', () => {
    const cases = [
      null,
      undefined,
      {},
      { type: 'session.error' },
      messageUpdated({ role: 'user', tokens: { input: 10 } }),
      messageUpdated({ role: 'assistant' }),
      messageUpdated({ role: 'assistant', tokens: { input: 0 } }),
      messageUpdated({ role: 'assistant', tokens: { input: '5000' } }),
      { type: 'message.updated', properties: {} },
    ];
    for (const event of cases) assert.equal(readAssistantUsage(event), null, JSON.stringify(event));
  });
});

describe('tool calls written as text', () => {
  it('finds every marker the small models emit', () => {
    for (const marker of TEXT_TOOL_CALL_MARKERS) {
      assert.equal(findTextToolCallMarker(`I will now ${marker}read>...`), marker);
    }
  });

  it('finds nothing in ordinary text', () => {
    assert.equal(findTextToolCallMarker('Here is the patch for Player.cs.'), null);
    assert.equal(findTextToolCallMarker(''), null);
    assert.equal(findTextToolCallMarker(/** @type {any} */ (null)), null);
    assert.equal(findTextToolCallMarker(/** @type {any} */ (42)), null);
  });
});
