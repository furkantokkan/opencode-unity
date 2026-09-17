// Spike A: does a throw in experimental.chat.system.transform / chat.params abort with 0 requests and a
// readable error, and does the retry wording ("temporarily at capacity") make OpenCode retry?
import { startMockLlm } from './lib/mock-llm.mjs';
import { parseJsonEvents, runOpencode } from './lib/opencode.mjs';
import { startServe } from './lib/serve.mjs';
import { SpikeContext, countHooks } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig, startMockOllama } from './lib/workspace.mjs';
import { tail } from './lib/evidence.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'A',
  title: 'Guard throw semantics in system.transform and chat.params',
  question: 'Does a throw in system.transform/chat.params abort with 0 requests and a readable error in both TUI and run, and does retry wording retry?',
  contractTest: 'C5, C6',
  fallback: 'Build the loopback gate (spec 8.10)',
};

const RUN_ARGS = ['run', '--agent', 'unity-code', '--format', 'json', 'Say OK'];

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {Record<string, unknown>} guard
 * @param {number} [timeoutMs]
 */
async function runScenario(ctx, label, guard, timeoutMs = 120_000) {
  const llm = ctx.track(await startMockLlm());
  const ollama = ctx.track(await startMockOllama({ models: [] }));
  const ws = ctx.track(await createWorkspace({
    label: `a-${label}`,
    opencodeConfig: profileConfig(),
    pluginConfig: providerPluginConfig(llm.baseURL, { guard: { ...guard, ollamaUrl: ollama.url } }),
  }));
  const result = await runOpencode({ args: RUN_ARGS, env: ws.env(), cwd: ws.project, timeoutMs, retryOnTimeout: false });
  const hooks = ws.readHooks();
  const events = parseJsonEvents(result.stdout);
  const guardCalls = hooks.filter((entry) => entry.hook === 'guard');
  const retryStatuses = hooks.filter((entry) => entry.hook === 'event' && entry.type === 'session.status' && entry.properties?.status?.type === 'retry');
  const sessionErrors = hooks.filter((entry) => entry.hook === 'event' && entry.type === 'session.error');
  const errorEvents = events.filter((event) => event.type === 'error');
  return {
    llm,
    ollama,
    result,
    hooks,
    guardCalls,
    retryStatuses,
    sessionErrors,
    errorEvents,
    summary: {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      chatRequests: llm.chatRequests.length,
      ollamaProbeCalls: ollama.calls.length,
      guardCalls: guardCalls.map((call) => ({ via: call.via, verdict: call.verdict, at: call.at - guardCalls[0].at })),
      retryStatuses: retryStatuses.map((entry) => ({ attempt: entry.properties.status.attempt, message: entry.properties.status.message, waitMs: entry.properties.status.next - entry.at })),
      sessionErrors: sessionErrors.map((entry) => entry.properties?.error),
      runErrorEvents: errorEvents.map((event) => event.error ?? event),
      stdoutEventTypes: events.map((event) => event.type),
      stderrTail: tail(result.stderr, 800),
    },
  };
}

/**
 * @param {SpikeContext} ctx
 */
async function serveScenario(ctx) {
  const llm = ctx.track(await startMockLlm());
  const ws = ctx.track(await createWorkspace({
    label: 'a-serve',
    opencodeConfig: profileConfig(),
    pluginConfig: providerPluginConfig(llm.baseURL, { guard: { hook: 'system', sequence: ['stop'] } }),
  }));
  const server = ctx.track(await startServe({ env: ws.env(), cwd: ws.project }));
  const session = await server.request('POST', '/session', {});
  const prompt = await server.request('POST', `/session/${session.json?.id}/message`, {
    agent: 'unity-code',
    parts: [{ type: 'text', text: 'Say OK' }],
  });
  const messages = await server.request('GET', `/session/${session.json?.id}/message`);
  const assistant = (messages.json ?? []).map((/** @type {any} */ message) => message.info).filter((/** @type {any} */ info) => info.role === 'assistant');
  server.stop();
  return { llm, ws, prompt, assistant };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const stop = await runScenario(ctx, 'stop-system', { hook: 'system', sequence: ['stop'] });
    ctx.evidence.stopInSystemTransform = stop.summary;
    ctx.checks.add('A1 stop in system.transform: 0 requests reach the mock LLM', stop.llm.chatRequests.length === 0, stop.llm.chatRequests.length);
    ctx.checks.add('A1 stop in system.transform: guard evaluated once (not retried)', stop.guardCalls.length === 1, stop.guardCalls.length);
    ctx.checks.add('A1 async loopback probe inside the hook works', stop.ollama.calls.length >= 1, stop.ollama.calls.length);
    const stopText = JSON.stringify(stop.summary.runErrorEvents) + JSON.stringify(stop.summary.sessionErrors) + stop.result.stderr;
    ctx.checks.add('A1 stop message is readable in run output', stopText.includes('opencode-unity GPU guard'), stop.summary.runErrorEvents);

    const stopParams = await runScenario(ctx, 'stop-params', { hook: 'params', sequence: ['stop'] });
    ctx.evidence.stopInChatParams = stopParams.summary;
    ctx.checks.add('A2 stop in chat.params: 0 requests', stopParams.llm.chatRequests.length === 0, stopParams.llm.chatRequests.length);
    ctx.checks.add('A2 stop in chat.params: guard evaluated once', stopParams.guardCalls.length === 1, stopParams.guardCalls.length);
    const stopParamsText = JSON.stringify(stopParams.summary.runErrorEvents) + JSON.stringify(stopParams.summary.sessionErrors) + stopParams.result.stderr;
    ctx.checks.add('A2 stop message is readable in run output', stopParamsText.includes('opencode-unity GPU guard'), stopParams.summary.runErrorEvents);

    const retry = await runScenario(ctx, 'retry-then-pass', { hook: 'system', sequence: ['retry', 'retry', 'pass'] });
    ctx.evidence.retryTwiceThenPass = retry.summary;
    ctx.checks.add('A3 retry wording: exactly one request arrives after the retries', retry.llm.chatRequests.length === 1, retry.llm.chatRequests.length);
    ctx.checks.add('A3 retry wording: guard re-evaluated on each retry (3 calls)', retry.guardCalls.length === 3, retry.guardCalls.length);
    ctx.checks.add('A3 retry status events observed (2)', retry.retryStatuses.length === 2, retry.summary.retryStatuses);
    ctx.checks.add('A3 run exits 0 after the retries', retry.result.exitCode === 0, retry.result.exitCode);

    const exhausted = await runScenario(ctx, 'retry-exhausted', { hook: 'system', sequence: ['retry'] }, 180_000);
    ctx.evidence.retryExhausted = exhausted.summary;
    ctx.checks.add('A4 retry exhaustion: 0 requests', exhausted.llm.chatRequests.length === 0, exhausted.llm.chatRequests.length);
    ctx.checks.add('A4 retry exhaustion: 1 attempt + 5 retries = 6 guard calls', exhausted.guardCalls.length === 6, exhausted.guardCalls.length);
    const exhaustedText = JSON.stringify(exhausted.summary.runErrorEvents) + JSON.stringify(exhausted.summary.sessionErrors) + exhausted.result.stderr;
    ctx.checks.add('A4 retry exhaustion: final error stored and readable', exhaustedText.includes('temporarily at capacity'), exhausted.summary.runErrorEvents);

    const serve = await serveScenario(ctx);
    const assistantError = serve.assistant.map((/** @type {any} */ info) => info.error).filter(Boolean);
    ctx.evidence.serverPath = { promptStatus: serve.prompt.status, chatRequests: serve.llm.chatRequests.length, assistantErrors: assistantError };
    ctx.checks.add('A5 server/TUI session path: 0 requests', serve.llm.chatRequests.length === 0, serve.llm.chatRequests.length);
    ctx.checks.add('A5 server/TUI session path: error stored on the assistant message', JSON.stringify(assistantError).includes('opencode-unity GPU guard'), assistantError);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Run the guard in the plugin hooks (D1, D8): a stop Error for blocking verdicts and a "temporarily at capacity" Error for retryable ones. No loopback gate.'
    : 'Build the loopback gate (spec 8.10) and move the guard there.';
  ctx.findings.push(
    'A thrown Error in experimental.chat.system.transform or chat.params is caught by the session processor; no HTTP request is sent because prepare() runs before streamText.',
    'Retry wording containing "temporarily at capacity" re-runs prepare() (and so the guard) on each retry; after 5 retries the error is stored on the assistant message.',
    'TUI rendering of the stored error is a manual check; the TUI uses the same server session path verified through `opencode serve`.',
  );
  return ctx;
}
