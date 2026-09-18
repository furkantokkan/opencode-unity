// The request half of the guarded path (spec 8.8, 12.3): what goes on the wire, and what each failure
// on the wire becomes. The mock Ollama from src/selftest answers; no real server, model or GPU is used.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { getOrchestratorAction } from '../../../src/delegate/results.js';
import { guardedChat } from '../../../src/ollama/guarded-chat.js';
import { startMockOllama } from '../../../src/selftest/mock-ollama.js';
import { CLOSED_PORT_URL, useSandbox } from '../../helpers/sandbox.mjs';
import { MODEL_TAG, NUM_CTX, catchAsync, makeProbes, makeProfile } from './fixtures.mjs';

const MESSAGES = [
  { role: 'system', content: 'You work on a Unity project.' },
  { role: 'user', content: 'Name the file that draws the grid.' },
];

/**
 * A mock Ollama and a profile pointed at it, each test in its own home so the GPU lock is its own.
 * @param {import('node:test').TestContext} t
 * @param {{ mock?: Parameters<typeof startMockOllama>[0], profile?: Partial<Parameters<typeof makeProfile>[0]> }} [options]
 */
async function setup(t, { mock: mockOptions = {}, profile: profileOptions = {} } = {}) {
  const sandbox = await useSandbox(t, 'guarded-chat');
  const started = await startMockOllama({ models: [MODEL_TAG], ...mockOptions });
  t.after(() => started.close());
  return { mock: started.mock, profile: makeProfile({ baseUrl: started.url, home: sandbox.productHome, ...profileOptions }) };
}

describe('guardedChat request', () => {
  it('sends one native chat request at the profile tag, context and sampling', async (t) => {
    const { mock, profile } = await setup(t, { mock: { chatReplies: [{ content: 'a file name', promptTokens: 210, outputTokens: 12 }] } });

    const result = await guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(result.response.content, 'a file name');
    assert.equal(result.response.promptTokens, 210);
    assert.equal(result.response.outputTokens, 12);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.warnings, []);
    assert.equal(mock.loadRequests.length, 1);
    assert.equal(mock.loadRequests[0].path, '/api/chat');
    assert.deepEqual(mock.chatRequests[0], {
      model: MODEL_TAG,
      messages: MESSAGES,
      stream: true,
      keep_alive: '15m',
      options: { num_ctx: NUM_CTX, temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05, num_predict: 4096 },
    });
  });

  it('merges a sampling override and passes a JSON schema through as format', async (t) => {
    const { mock, profile } = await setup(t);
    const format = { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } } };

    await guardedChat({ profile, command: 'shape', messages: MESSAGES, sampling: { temperature: 0 }, maxOutputTokens: 256, format, probes: makeProbes(), lockWaitSec: 5 });

    const body = mock.chatRequests[0];
    assert.equal(body.options.temperature, 0);
    assert.equal(body.options.top_p, 0.8, 'an override replaces one value, not the whole block');
    assert.equal(body.options.num_ctx, NUM_CTX, 'a constrained answer never changes the context');
    assert.equal(body.options.num_predict, 256);
    assert.deepEqual(body.format, format);
  });

  it('caps the answer at the profile output limit', async (t) => {
    const { mock, profile } = await setup(t);

    await guardedChat({ profile, command: 'bench', messages: MESSAGES, maxOutputTokens: 99_000, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(mock.chatRequests[0].options.num_predict, 4096);
  });

  it('honours the keep-alive the caller asks for', async (t) => {
    const { mock, profile } = await setup(t);

    await guardedChat({ profile, command: 'warm', messages: MESSAGES, keepAlive: '30m', probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(mock.chatRequests[0].keep_alive, '30m');
  });

  it('reports a prompt Ollama truncated', async (t) => {
    // 8,194 is what a 16K context with num_keep 4 cuts an oversized prompt down to (OL llm/llama_server.go).
    const { profile } = await setup(t, { mock: { chatReplies: [{ promptTokens: 8194 }] } });

    const result = await guardedChat({ profile, command: 'bench', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(result.truncated, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /cut the prompt to 8194 tokens/);
  });

  it('refuses to load the model as a side effect of an empty request', async (t) => {
    const { mock, profile } = await setup(t);

    await assert.rejects(() => guardedChat({ profile, command: 'delegate ask', messages: [], probes: makeProbes() }), /use guardedWarm/);
    await assert.rejects(
      () => guardedChat({ profile, command: 'delegate ask', messages: [/** @type {any} */ ({ role: 'user' })], probes: makeProbes(), lockWaitSec: 5 }),
      /role and string content/,
    );
    assert.deepEqual(mock.loadRequests, []);
  });

  it('refuses an unusable profile, command label, timeout or answer size', async (t) => {
    const { profile } = await setup(t);
    const probes = makeProbes();

    await assert.rejects(() => guardedChat({ profile: /** @type {any} */ ({}), command: 'warm', messages: MESSAGES, probes }), /complete runtime profile/);
    await assert.rejects(() => guardedChat({ profile, command: '  ', messages: MESSAGES, probes }), /non-empty label/);
    await assert.rejects(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, timeoutMs: 0, probes }), /timeoutMs must be a positive number/);
    await assert.rejects(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, maxOutputTokens: 0, probes }), /maxOutputTokens must be a positive integer/);
  });
});

describe('guardedChat budget preflight', () => {
  it('refuses a prompt that cannot fit, before the lock and the probes', async (t) => {
    const { mock, profile } = await setup(t);
    let probeCalls = 0;
    const probes = makeProbes({
      readOllamaPs: async () => {
        probeCalls += 1;
        return { ok: true, models: [] };
      },
    });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: [{ role: 'user', content: 'x'.repeat(200_000) }], probes, lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BUDGET);
    assert.equal(error.code, 'context_budget_exceeded');
    assert.equal(error.data.promptBudget, 11_776);
    assert.ok(error.data.estimate > error.data.promptBudget);
    assert.equal(error.data.overBy, error.data.estimate - error.data.promptBudget);
    assert.match(error.hint, /delegate map/);
    assert.equal(probeCalls, 0, 'the guard should not run for a request that cannot fit');
    assert.deepEqual(mock.loadRequests, []);
  });

  it('widens the budget when the caller asks for a shorter answer', async (t) => {
    const { profile } = await setup(t);
    // About 14,000 tokens of prompt: over the 11,776 budget with a 4,096-token answer, under the
    // 15,616 one a 256-token answer leaves.
    const messages = [{ role: 'user', content: 'x'.repeat(14_000 * 3) }];
    const probes = makeProbes();

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages, probes, lockWaitSec: 5 }));
    assert.equal(error.code, 'context_budget_exceeded');

    const result = await guardedChat({ profile, command: 'delegate ask', messages, maxOutputTokens: 256, probes, lockWaitSec: 5 });
    assert.equal(result.budget?.promptBudget, NUM_CTX - 256 - 512);
    assert.ok(result.budget !== null && result.budget.estimate <= result.budget.promptBudget);
  });

  it('uses the estimate the caller brings, tool tokens included', async (t) => {
    const { profile } = await setup(t);

    const error = await catchAsync(() =>
      guardedChat({
        profile,
        command: 'delegate map',
        messages: [{ role: 'user', content: 'short' }],
        budget: { systemChars: 20_000, historyChars: 20_000, toolsTokens: 3400 },
        probes: makeProbes(),
        lockWaitSec: 5,
      }),
    );

    assert.equal(error.code, 'context_budget_exceeded');
    assert.ok(error.data.estimate > 11_776);
  });
});

describe('guardedChat wire failures', () => {
  it('turns HTTP 413 into a context overflow', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ httpStatus: 413, httpBody: { error: 'request entity too large' } }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BUDGET);
    assert.equal(error.code, 'context_overflow');
    assert.equal(error.data.status, 413);
    assert.match(error.message, /request entity too large/);
    assert.match(error.hint, /delegate map/);
  });

  it('turns a context_length_exceeded body into a context overflow', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ httpStatus: 400, httpBody: { error: 'context_length_exceeded: the prompt is longer than the context' } }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BUDGET);
    assert.equal(error.code, 'context_overflow');
  });

  // Amendment 36.6's refusal table: "Ollama unreachable, or preset tag missing" is exit 2,
  // `ollama_unreachable`, `do_it_yourself`. This is the expected state after an incomplete `setup`,
  // and exit 7 would be the one class an orchestrator has no rule for.
  it('turns a missing preset tag into the unreachable refusal, not an unexpected error', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ httpStatus: 404, httpBody: { error: 'model "ocu-test-16k" not found, try pulling it first' } }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'ollama_unreachable');
    assert.equal(getOrchestratorAction(error.code), 'do_it_yourself');
    assert.equal(error.data.model, profile.provider.modelTag);
    assert.match(error.hint, /opencode-unity setup/);
  });

  it('leaves a 404 that is not about a model as an HTTP error', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ httpStatus: 404, httpBody: { error: 'no route for /api/chat' } }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.code, 'ollama_http_error');
    assert.equal(error.data.status, 404);
  });

  it('turns any other HTTP failure into a runtime error', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ httpStatus: 500, httpBody: { error: 'the model runner stopped' } }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'ollama_http_error');
    assert.equal(error.data.status, 500);
    assert.match(error.message, /the model runner stopped/);
  });

  it('turns a stream error into a runtime error', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ content: 'partial', streamError: 'the GPU driver reported a fault', omitFinal: true }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'bench', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'ollama_stream_error');
  });

  it('reports an unreachable server as blocked', async (t) => {
    const sandbox = await useSandbox(t, 'guarded-chat-down');
    // Nothing listens on the discard port, so the connection is refused without leaving this machine.
    const profile = makeProfile({ baseUrl: CLOSED_PORT_URL, home: sandbox.productHome });

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.BLOCKED);
    assert.equal(error.code, 'ollama_unreachable');
    assert.match(error.hint, /Start the Ollama app/);
  });

  it('stops waiting for an answer that never comes', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ delayMs: 5000, content: 'too late' }] } });

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, timeoutMs: 60, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.exitCode, EXIT.RUNTIME);
    assert.equal(error.code, 'chat_timeout');
    assert.equal(error.data.timeoutMs, 60);
    assert.match(error.message, /did not answer within 0\.1 s/);
  });

  it('shows an error body that is not JSON', async (t) => {
    const { mock, profile } = await setup(t);
    mock.overrideRoute('/api/chat', { status: 502, body: 'the proxy in front of Ollama refused' });

    const error = await catchAsync(() => guardedChat({ profile, command: 'warm', messages: MESSAGES, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.code, 'ollama_http_error');
    assert.match(error.message, /the proxy in front of Ollama refused/);
  });

  it('reads the answer from a fetch implementation that has no streaming body', async (t) => {
    const { profile } = await setup(t);
    const line = JSON.stringify({ model: 'm', done: true, done_reason: 'stop', message: { role: 'assistant', content: 'whole answer' }, prompt_eval_count: 7, eval_count: 2 });
    const fetchImpl = /** @type {any} */ (async () => ({ ok: true, status: 200, body: null, text: async () => `${line}\n` }));

    const result = await guardedChat({ profile, command: 'bench', messages: MESSAGES, fetch: fetchImpl, probes: makeProbes(), lockWaitSec: 5 });

    assert.equal(result.response.content, 'whole answer');
    assert.equal(result.response.promptTokens, 7);
  });

  it('lets an interrupt through with its own reason', async (t) => {
    const { profile } = await setup(t, { mock: { chatReplies: [{ delayMs: 5000, content: 'too late' }] } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('interrupted by SIGINT')), 40);
    t.after(() => clearTimeout(timer));

    const error = await catchAsync(() => guardedChat({ profile, command: 'delegate ask', messages: MESSAGES, signal: controller.signal, probes: makeProbes(), lockWaitSec: 5 }));

    assert.equal(error.message, 'interrupted by SIGINT');
    assert.equal(error.exitCode, undefined, 'an interrupt is not one of our failures');
  });
});
