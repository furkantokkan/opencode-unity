import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
  MODEL_LOAD_PATHS,
} from '../../../src/selftest/capture-checks.js';
import { NATIVE_LOAD_PATHS } from '../../../src/selftest/mock-ollama.js';

const goodBody = {
  model: 'ocu-qwen3-coder-30b-16k',
  messages: [
    { role: 'system', content: 'You are a Unity C# agent. facts: OCU_MARKER' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ],
  tools: [{ type: 'function', function: { name: 'read' } }, { type: 'function', function: { name: 'edit' } }],
  temperature: 0.7,
  top_p: 0.8,
  max_tokens: 4096,
  stream_options: { include_usage: true },
};

test('capture checks: text, system messages and tool names are read from either content form', () => {
  assert.equal(getMessageText('plain'), 'plain');
  assert.equal(getMessageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(getMessageText(null), '');
  assert.deepEqual(getSystemTexts(goodBody), ['You are a Unity C# agent. facts: OCU_MARKER']);
  assert.deepEqual(getToolNames(goodBody), ['read', 'edit']);
  assert.deepEqual(getToolNames({}), []);
});

test('capture checks: a well-formed request passes every rule of C1', () => {
  const checks = [
    checkSingleSystemMessage(goodBody),
    checkSystemContains(goodBody, 'OCU_MARKER'),
    checkSampling(goodBody, { temperature: 0.7, topP: 0.8, maxTokens: 4096 }),
    checkToolNames(goodBody, ['edit', 'read']),
    checkIncludeUsage(goodBody),
    checkNoCanaries(goodBody, ['OCU_CANARY_CLAUDE_MD_41C7']),
  ];

  assert.deepEqual(checks.filter((check) => !check.ok), []);
  assert.deepEqual(checks.map((check) => check.id), ['single-system-message', 'system-contains-marker', 'sampling', 'tool-names', 'include-usage', 'no-canaries']);
});

test('capture checks: a second system message, a missing marker and wrong sampling are reported', () => {
  const twoSystems = { ...goodBody, messages: [...goodBody.messages, { role: 'system', content: 'extra' }] };
  const failed = checkSingleSystemMessage(twoSystems);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /found 2/);

  assert.equal(checkSingleSystemMessage({ messages: [{ role: 'user', content: 'x' }] }).ok, false);

  const marker = checkSystemContains(goodBody, 'MISSING_MARKER');
  assert.equal(marker.ok, false);
  assert.match(marker.message, /does not contain MISSING_MARKER/);

  const sampling = checkSampling({ ...goodBody, temperature: 1, max_tokens: 32000 }, { temperature: 0.7, topP: 0.8, maxTokens: 4096 });
  assert.equal(sampling.ok, false);
  assert.match(sampling.message, /temperature 1 \(expected 0.7\)/);
  assert.match(sampling.message, /max_tokens 32000 \(expected 4096\)/);
  assert.equal(checkSampling(goodBody, {}).ok, true);

  assert.equal(checkIncludeUsage({ ...goodBody, stream_options: {} }).ok, false);
});

test('capture checks: tool-name differences name what is missing and what is extra', () => {
  const check = checkToolNames(goodBody, ['read', 'write'], 'editor-mcp-tools');

  assert.equal(check.id, 'editor-mcp-tools');
  assert.equal(check.ok, false);
  assert.match(check.message, /missing write/);
  assert.match(check.message, /unexpected edit/);
});

test('capture checks: canary content is found anywhere in the captured value', () => {
  const leaked = checkNoCanaries([{ messages: [{ role: 'system', content: 'OCU_CANARY_CLAUDE_MD_41C7 leaked' }] }], ['OCU_CANARY_CLAUDE_MD_41C7', 'OCU_CANARY_AGENTS_SKILL_6D19']);

  assert.equal(leaked.ok, false);
  assert.match(leaked.message, /OCU_CANARY_CLAUDE_MD_41C7/);
  assert.doesNotMatch(leaked.message, /AGENTS_SKILL/);
  assert.equal(checkNoCanaries(undefined, ['OCU_CANARY_CLAUDE_MD_41C7']).ok, true);
});

test('capture checks: model-load paths are detected, and the native list can be checked alone', () => {
  const requests = [
    { method: 'GET', path: '/api/ps' },
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'POST', url: '/api/chat?stream=true' },
  ];

  const all = checkNoModelLoadRequests(requests);
  assert.equal(all.ok, false);
  assert.match(all.message, /POST \/v1\/chat\/completions/);
  assert.match(all.message, /POST \/api\/chat/);

  const nativeOnly = checkNoModelLoadRequests(requests, NATIVE_LOAD_PATHS, 'no-native-load-calls');
  assert.equal(nativeOnly.id, 'no-native-load-calls');
  assert.equal(nativeOnly.ok, false);
  assert.doesNotMatch(nativeOnly.message, /v1/);

  assert.equal(checkNoModelLoadRequests([{ method: 'GET', path: '/api/ps' }]).ok, true);
  assert.ok(MODEL_LOAD_PATHS.includes('/v1/chat/completions'));
});

test('capture checks: the budget check reports the largest request it saw', () => {
  const estimate = (body) => body.messages[0].content.length;

  const inside = checkPromptsWithinBudget([{ messages: [{ role: 'user', content: 'x'.repeat(100) }] }], 200, estimate);
  assert.equal(inside.ok, true);
  assert.match(inside.message, /largest about 100 tokens, budget 200/);

  const outside = checkPromptsWithinBudget(
    [{ messages: [{ role: 'user', content: 'x'.repeat(100) }] }, { messages: [{ role: 'user', content: 'x'.repeat(300) }] }],
    200,
    estimate,
  );
  assert.equal(outside.ok, false);
  assert.match(outside.message, /1 of 2 requests exceed the budget of 200 tokens \(largest about 300\)/);

  assert.equal(checkPromptsWithinBudget([], 200, estimate).ok, true);
});
