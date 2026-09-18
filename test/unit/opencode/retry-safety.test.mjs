// Spec 7.6 and D9: OpenCode decides whether to retry a failed request from the *text* of the error,
// so the wording of every message this product can emit is a behavioural contract. A stop message
// that happens to contain "503" is retried five times and the user waits a minute for the same
// refusal; a retry message that matches nothing stops the session on the first try.
//
// The vendored rules are the ones the drift job refreshes, so a change in OpenCode fails here first.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUARD_MESSAGE_PREFIX, RETRY_MARKER } from '../../../plugin/opencode-unity-lib/guard/messages.js';
import { catchError } from '../../helpers/catch-error.mjs';
import {
  assertRetrySafe,
  assertStopSafe,
  findRetryTriggers,
  loadRetryRules,
  looksRetryable,
} from '../../../src/opencode/retry-safety.js';
import {
  NON_NEGOTIABLE_TUPLES,
  createVerificationError,
  formatTokens,
  formatVerificationFailure,
  verifyConfigShape,
  verifyEffectiveConfig,
  verifyInstructionFiles,
  verifyNonNegotiableRules,
  verifyPluginLoaded,
  verifyVisibleTools,
} from '../../../src/opencode/effective-config.js';
import { EDITOR_READ_ONLY_TOOLS, EDITOR_TRUSTED_TOOLS, buildConfigLevelPermission, renderProfileAssets } from '../../../src/opencode/render.js';

describe('retry-safety vendored rules', () => {
  it('is pinned to the OpenCode version this release was built against', () => {
    const rules = loadRetryRules();
    assert.equal(rules.opencodeVersion, '1.18.31');
    assert.equal(rules.retryableMessagePatterns.length, 7);
    assert.equal(rules.retryableLowercaseSubstrings.length, 3);
    assert.equal(rules.retryPolicy.maxRetries, 5);
  });

  it('classifies the strings OpenCode is known to retry', () => {
    const retryable = [
      'Request failed with status 503',
      'rate limit exceeded',
      'service unavailable',
      'connection refused',
      'request timed out',
      'please try your request again',
      'the provider is temporarily at capacity',
      'Too Many Requests',
      'resource exhausted',
    ];
    for (const message of retryable) {
      assert.ok(looksRetryable(message), `OpenCode would retry "${message}" and the checker missed it`);
    }
  });

  it('names which rule fired, so a failing test says which word to change', () => {
    const triggers = findRetryTriggers('the model is temporarily at capacity');
    assert.equal(triggers.length, 1);
    assert.match(triggers[0], /^pattern \//);
    assert.deepEqual(findRetryTriggers('the model was not loaded'), []);
  });

  it('refuses a stop message that would be retried, and a retry message that would not', () => {
    assert.match(catchError(() => assertStopSafe('the GPU is at 503 degrees', 'guard message')).message, /guard message would be retried/);
    assert.match(catchError(() => assertRetrySafe('the model was not loaded', 'guard message')).message, /matches no retry rule/);
    assert.doesNotThrow(() => assertStopSafe('the model was not loaded'));
    assert.doesNotThrow(() => assertRetrySafe(`${GUARD_MESSAGE_PREFIX} the local model is ${RETRY_MARKER}.`));
  });
});

describe('retry-safety of the verification messages', () => {
  it('holds for every non-negotiable tuple and every effective action', () => {
    for (const tuple of NON_NEGOTIABLE_TUPLES) {
      for (const action of ['allow', 'ask']) {
        const permission = { [tuple.tool]: { [tuple.argument ?? '*']: action } };
        const check = verifyNonNegotiableRules({ permission, tuples: [tuple] });
        for (const failure of check.failures) assertStopSafe(formatVerificationFailure(failure), `V-b line for ${tuple.tool}`);
      }
    }
  });

  it('holds for every exit status the agent probe can report', () => {
    assertStopSafe(formatVerificationFailure(verifyPluginLoaded({ exitCode: 0, timedOut: true }).failures[0]), 'V-a timeout line');
    for (let exitCode = 1; exitCode <= 255; exitCode += 1) {
      const [failure] = verifyPluginLoaded({ exitCode }).failures;
      assertStopSafe(formatVerificationFailure(failure), `V-a line for status ${exitCode}`);
    }
  });

  it('holds for every token count a project instruction file can reach', () => {
    for (let tokens = 0; tokens <= 200000; tokens += 1) {
      assertStopSafe(`about ${formatTokens(tokens)} tokens`, `token count ${tokens}`);
    }
    const check = verifyInstructionFiles({ files: [{ path: 'AGENTS.md', tokens: 8503 }], prefixTokens: 5024, failTokens: 6000 });
    assertStopSafe(formatVerificationFailure(check.failures[0]), 'V-e line');
  });

  it('holds for every tool name this product knows about', () => {
    const names = ['read', 'edit', 'write', 'bash', 'glob', 'grep', 'list', 'patch', 'webfetch', 'websearch', 'codesearch', 'task', 'todowrite', 'skill', 'question', 'doom_loop', 'external_directory', 'unitynet', ...EDITOR_READ_ONLY_TOOLS, ...EDITOR_TRUSTED_TOOLS];
    for (const name of names) {
      const extra = verifyVisibleTools({ tools: { [name]: true }, expected: [] });
      const missing = verifyVisibleTools({ tools: {}, expected: [name] });
      for (const failure of [...extra.failures, ...missing.failures]) {
        assertStopSafe(formatVerificationFailure(failure), `V-c line for ${name}`);
      }
    }
  });

  it('prints a name a merged config chose verbatim, even when it reads like a retryable failure', () => {
    // A hostile config can name a tool `internal_error`, and the user has to see that exact name to
    // find it. Doing so is safe because a V-check line is CLI output behind exit 4: it is never the
    // message of an Error thrown from a plugin hook, which is the only text OpenCode's retry
    // classifier reads. Only product-authored wording is held to spec 7.6.
    const line = formatVerificationFailure(verifyVisibleTools({ tools: { internal_error: true }, expected: [] }).failures[0]);
    assert.match(line, /the tool internal_error is not visible/);
    assert.ok(looksRetryable(line), 'this test exists to record the boundary, not to hide it');
    assertStopSafe(line.replace('internal_error', 'toolname'), 'V-c wording without the borrowed name');
  });

  it('holds for every V-d failure a hostile config can produce', () => {
    const check = verifyConfigShape({
      config: {
        model: 'anthropic/claude', share: 'auto', autoupdate: true, enabled_providers: ['anthropic'],
        instructions: [], plugin_origins: { x: ['/project/.opencode/plugins/helper.js'] },
        mcp: { exfil: {} }, permission: { unitynet: { 'GET https://x/*': 'allow' } },
      },
      expected: { modelTag: 'ocu-qwen3-coder-30b-16k', factsPath: '/p/facts.md', profileDir: '/profile', expectUnitynet: true, policyHash: 'abc', componentsHash: 'def' },
    });
    assert.ok(check.failures.length >= 8);
    for (const failure of check.failures) assertStopSafe(formatVerificationFailure(failure), 'V-d line');
  });

  it('holds for the whole exit-4 error, message and hint', () => {
    const result = verifyEffectiveConfig({
      probe: { exitCode: 3 },
      permission: {},
      tools: { webfetch: true },
      expectedTools: ['read'],
      config: {},
      expected: { modelTag: 'ocu-qwen3-coder-30b-16k', factsPath: '/p/facts.md', profileDir: '/profile' },
      instructionFiles: [{ path: 'AGENTS.md', tokens: 9504 }],
      prefixTokens: 5000,
      failTokens: 6000,
    });
    const error = createVerificationError(result);
    assertStopSafe(error.message, 'exit 4 message');
    assertStopSafe(error.hint ?? '', 'exit 4 hint');
  });
});

describe('retry-safety of the rendered assets', () => {
  it('holds for every line of every profile asset', () => {
    for (const editorAgent of [false, true]) {
      const assets = renderProfileAssets({
        modelTag: 'ocu-qwen3-coder-30b-16k',
        sampling: { temperature: 0.7, topP: 0.8 },
        permission: buildConfigLevelPermission(),
        editorAgent,
      });
      for (const [name, text] of Object.entries(assets)) {
        for (const line of text.split('\n')) assertStopSafe(line, `line of ${name}`);
      }
    }
  });
});
