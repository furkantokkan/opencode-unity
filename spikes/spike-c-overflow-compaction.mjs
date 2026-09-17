// Spike C: does a thrown `{type:"error", error:{code:"context_length_exceeded"}}` object in chat.params
// trigger OpenCode's own compaction without sending the request, is the compaction request itself
// exempt, and does a stop Error in the compaction agent (the loop breaker) halt the session?
import { startMockLlm } from './lib/mock-llm.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, runOutputText, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'C',
  title: 'Budget preflight: thrown overflow object turns into compaction',
  question: 'Does a thrown context_length_exceeded object trigger compaction without sending the request?',
  contractTest: 'C8',
  fallback: 'Preflight becomes a stop message ("send /compact or start a new session") plus detection; gate 413 moves to v0.2',
};

const RUN_ARGS = ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'];
const LOOP_BREAKER = /this session is too large for the local context/;

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {Record<string, unknown>} overflow
 */
async function runScenario(ctx, label, overflow) {
  const llm = ctx.track(await startMockLlm());
  const ws = ctx.track(await createWorkspace({
    label: `c-${label}`,
    opencodeConfig: profileConfig(),
    pluginConfig: providerPluginConfig(llm.baseURL, { overflow }),
  }));
  const result = await runOpencode({ args: RUN_ARGS, env: ws.env(), cwd: ws.project, timeoutMs: 150_000 });
  const hooks = ws.readHooks();
  const overflowLog = hooks.filter((entry) => entry.hook === 'overflow');
  const compactedEvents = hooks.filter((entry) => entry.hook === 'event' && entry.type === 'session.compacted');
  const retryStatuses = hooks.filter((entry) => entry.hook === 'event' && entry.type === 'session.status' && entry.properties?.status?.type === 'retry');
  // chat.params runs immediately before the HTTP request, so its agents, minus the ones that threw,
  // are the agents whose requests reached the mock, in order.
  const paramsAgents = hooks.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent);
  return {
    llm,
    result,
    hooks,
    overflowLog,
    compactedEvents,
    retryStatuses,
    paramsAgents,
    summary: {
      ...summarizeRun(result, llm, hooks),
      overflowActions: overflowLog.map((entry) => entry.action),
      compactedEvents: compactedEvents.length,
      retryCount: retryStatuses.length,
      requestSystemHeads: llm.chatRequests.map((request) => String(request.body?.messages?.[0]?.content ?? '').slice(0, 60)),
    },
  };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const once = await runScenario(ctx, 'once', { mode: 'once' });
    ctx.evidence.overflowOnce = once.summary;
    ctx.checks.add('C1 one overflow throw: the over-budget request is not sent', once.llm.chatRequests.length === 2, once.summary.requestSystemHeads.length);
    ctx.checks.add('C1 chat.params order is unity-code (threw), compaction, unity-code', once.paramsAgents.join(',') === 'unity-code,compaction,unity-code', once.paramsAgents);
    ctx.checks.add('C1 a compaction ran', once.compactedEvents.length >= 1 || once.paramsAgents.includes('compaction'), once.summary.compactedEvents);
    ctx.checks.add('C1 the overflow object is never retried', once.retryStatuses.length === 0, once.summary.retryCount);
    const afterError = once.summary.stdoutEventTypes.slice(once.summary.stdoutEventTypes.indexOf('error') + 1);
    ctx.checks.add('C1 the session continues after compaction and answers', afterError.includes('step_finish'), { exitCode: once.result.exitCode, afterError });

    const loopBreaker = await runScenario(ctx, 'loop-breaker', { mode: 'always', loopBreaker: true });
    ctx.evidence.loopBreaker = loopBreaker.summary;
    ctx.checks.add('C2 loop breaker: only the compaction request is sent', loopBreaker.llm.chatRequests.length === 1, loopBreaker.llm.chatRequests.length);
    ctx.checks.add('C2 loop breaker: the second overflow becomes a stop message', loopBreaker.overflowLog.some((entry) => entry.action === 'loop-breaker'), loopBreaker.summary.overflowActions);
    ctx.checks.add('C2 loop breaker: the run halts with that message', LOOP_BREAKER.test(runOutputText(loopBreaker.result)) && loopBreaker.result.exitCode !== 0, loopBreaker.summary.runErrorEvents);
    ctx.checks.add('C2 loop breaker: no retries', loopBreaker.retryStatuses.length === 0, loopBreaker.summary.retryCount);

    const inCompaction = await runScenario(ctx, 'stop-in-compaction', { mode: 'once', compaction: 'stop' });
    ctx.evidence.stopInCompaction = inCompaction.summary;
    ctx.checks.add('C3 stop inside compaction: 0 requests reach the mock', inCompaction.llm.chatRequests.length === 0, inCompaction.llm.chatRequests.length);
    ctx.checks.add('C3 stop inside compaction: the run halts with the stop message', LOOP_BREAKER.test(runOutputText(inCompaction.result)) && inCompaction.result.exitCode !== 0, inCompaction.summary.runErrorEvents);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep the in-plugin budget preflight (D6): throw the overflow object for normal agents, a stop Error for the compaction agent and for the loop breaker.'
    : 'Budget preflight falls back to a stop message plus after-the-fact truncation detection; the 413 gate path moves to v0.2.';
  ctx.findings.push(
    'A non-Error object thrown from chat.params is parsed as ContextOverflowError: the request is never sent, it is not retried, and OpenCode starts its own compaction.',
    'The compaction request itself runs through the same prepare path, so the plugin must exempt it from the budget and use a stop Error there instead.',
    'A stop Error thrown for the second overflow after a compaction (the loop breaker) halts the session with a readable message.',
    'OpenCode publishes the overflow as a session error even when it recovers, so `opencode run` exits 1 although the answer after compaction is produced. Bench, delegate and contract tests must judge the final assistant text, not the exit code alone.',
  );
  return ctx;
}
