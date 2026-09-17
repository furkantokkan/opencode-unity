import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertIncludesUsage,
  assertNoCanaries,
  assertNoModelLoadRequests,
  assertSampling,
  assertSingleSystemMessage,
  assertSystemContains,
  assertToolNames,
  getMessageText,
  getToolNames,
} from '../../helpers/capture-assert.mjs';

/** @returns {import('../../helpers/capture-assert.mjs').ChatRequest} */
function createRequest() {
  return {
    model: 'ocu-test-16k',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a Unity agent. FACTS-MARKER' }] },
      { role: 'user', content: 'add a null check' },
    ],
    tools: [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'edit' } }],
    temperature: 0.7,
    top_p: 0.8,
    max_tokens: 4096,
    stream_options: { include_usage: true },
  };
}

describe('capture assertions', () => {
  it('pass for a well-formed request', () => {
    const request = createRequest();
    assert.equal(assertSingleSystemMessage(request), 'You are a Unity agent. FACTS-MARKER');
    assertSystemContains(request, 'FACTS-MARKER');
    assertNoCanaries(request, ['CANARY-CLAUDE', 'CANARY-GLOBAL-AGENTS']);
    assertSampling(request, { temperature: 0.7, topP: 0.8, maxTokens: 4096 });
    assertToolNames(request, ['edit', 'read']);
    assertIncludesUsage(request);
    assert.deepEqual(getToolNames(request), ['read', 'edit']);
  });

  it('fail on a second system message, canaries, sampling and tool drift', () => {
    const twoSystems = createRequest();
    twoSystems.messages.push({ role: 'system', content: 'extra' });
    assert.throws(() => assertSingleSystemMessage(twoSystems), /exactly one system message/);
    const leaked = createRequest();
    leaked.messages[1].content = 'CANARY-CLAUDE here';
    assert.throws(() => assertNoCanaries(leaked, ['CANARY-CLAUDE']), /CANARY-CLAUDE/);
    assert.throws(() => assertSampling({ ...createRequest(), temperature: 1 }, { temperature: 0.7 }), /temperature/);
    assert.throws(() => assertToolNames(createRequest(), ['read']), /unexpected edit/);
    assert.throws(() => assertToolNames(createRequest(), ['read', 'edit', 'grep']), /missing grep/);
    assert.throws(() => assertIncludesUsage({ ...createRequest(), stream_options: undefined }), /include_usage/);
  });

  it('extracts text from string and part-array content', () => {
    assert.equal(getMessageText('plain'), 'plain');
    assert.equal(getMessageText([{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }]), 'ab');
    assert.equal(getMessageText(null), '');
  });

  it('detects model-load requests in a mock log', () => {
    assert.doesNotThrow(() => assertNoModelLoadRequests([{ url: '/api/ps' }, { path: '/api/version' }, { url: '/api/show' }]));
    assert.throws(() => assertNoModelLoadRequests([{ url: '/api/ps' }, { url: '/v1/chat/completions?x=1' }]), /\/v1\/chat\/completions/);
    assert.throws(() => assertNoModelLoadRequests([{ method: 'POST', path: '/api/generate' }]), /\/api\/generate/);
  });
});
