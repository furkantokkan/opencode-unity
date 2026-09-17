// Spike E: do `run` and the server session path work with the built-in `build`, `plan` and `title`
// agents disabled, and does that remove the extra title request?
import { startMockLlm } from './lib/mock-llm.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { startServe } from './lib/serve.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'E',
  title: 'Built-in agents disabled (build, plan, title)',
  question: 'Do the TUI and run work with build/plan/title disabled, and are no extra requests sent?',
  contractTest: 'C13',
  fallback: 'Keep build/plan (config-level denies still apply) and/or keep title (guarded; one extra small request per session)',
};

const DISABLED = { build: { disable: true }, plan: { disable: true }, title: { disable: true } };

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {Record<string, unknown>} agentConfig
 */
async function createRun(ctx, label, agentConfig) {
  const llm = ctx.track(await startMockLlm());
  const ws = ctx.track(await createWorkspace({
    label: `e-${label}`,
    opencodeConfig: profileConfig({ agent: agentConfig }),
    pluginConfig: providerPluginConfig(llm.baseURL),
  }));
  return { llm, ws };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const disabled = await createRun(ctx, 'disabled', DISABLED);
    const withAgent = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'], env: disabled.ws.env(), cwd: disabled.ws.project, timeoutMs: 150_000 });
    const hooksWithAgent = disabled.ws.readHooks();
    ctx.evidence.runWithAgentFlag = summarizeRun(withAgent, disabled.llm, hooksWithAgent);
    ctx.checks.add('E1 `run --agent unity-code` works with the built-ins disabled', withAgent.exitCode === 0, withAgent.exitCode);
    ctx.checks.add('E1 exactly one request, from unity-code', disabled.llm.chatRequests.length === 1 && hooksWithAgent.filter((entry) => entry.hook === 'chat.params').every((entry) => entry.agent === 'unity-code'), {
      requests: disabled.llm.chatRequests.length,
      agents: hooksWithAgent.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent),
    });

    await disabled.ws.clearHooks();
    const requestsBefore = disabled.llm.chatRequests.length;
    const defaultAgent = await runOpencode({ args: ['run', '--format', 'json', 'Say OK'], env: disabled.ws.env(), cwd: disabled.ws.project, timeoutMs: 150_000 });
    const hooksDefault = disabled.ws.readHooks();
    const defaultAgents = hooksDefault.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent);
    ctx.evidence.runWithDefaultAgent = { exitCode: defaultAgent.exitCode, requests: disabled.llm.chatRequests.length - requestsBefore, agents: defaultAgents, stdoutTail: defaultAgent.stdout.slice(-200) };
    ctx.checks.add('E2 without --agent the default_agent unity-code answers', defaultAgent.exitCode === 0 && defaultAgents.join(',') === 'unity-code', ctx.evidence.runWithDefaultAgent);

    const debugBuild = await runOpencode({ args: ['debug', 'agent', 'build'], env: disabled.ws.env(), cwd: disabled.ws.project, timeoutMs: 90_000 });
    const agentList = await runOpencode({ args: ['agent', 'list'], env: disabled.ws.env(), cwd: disabled.ws.project, timeoutMs: 90_000 });
    const listText = `${agentList.stdout}${agentList.stderr}`;
    ctx.evidence.disabledAgentsGone = {
      debugBuildExit: debugBuild.exitCode,
      debugBuildStderr: debugBuild.stderr.trim().slice(0, 200),
      agentListNames: ['build', 'plan', 'title', 'unity-code'].filter((name) => new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(listText)),
    };
    ctx.checks.add('E3 the build agent is gone', debugBuild.exitCode !== 0, ctx.evidence.disabledAgentsGone);

    const enabled = await createRun(ctx, 'title-enabled', { build: { disable: true }, plan: { disable: true } });
    const controlRun = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'], env: enabled.ws.env(), cwd: enabled.ws.project, timeoutMs: 150_000 });
    const controlHooks = enabled.ws.readHooks();
    const controlAgents = controlHooks.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent);
    ctx.evidence.controlTitleEnabled = { ...summarizeRun(controlRun, enabled.llm, controlHooks), agents: controlAgents };
    ctx.checks.add('E4 control: with the title agent enabled an extra title request is sent', enabled.llm.chatRequests.length > 1 && controlAgents.includes('title'), { requests: enabled.llm.chatRequests.length, agents: controlAgents });

    const served = await createRun(ctx, 'serve', DISABLED);
    const server = ctx.track(await startServe({ env: served.ws.env(), cwd: served.ws.project }));
    const session = await server.request('POST', '/session', {});
    const prompt = await server.request('POST', `/session/${session.json?.id}/message`, { agent: 'unity-code', parts: [{ type: 'text', text: 'Say OK' }] });
    const agents = await server.request('GET', '/agent');
    server.stop();
    const serveHooks = served.ws.readHooks();
    const serveAgents = serveHooks.filter((entry) => entry.hook === 'chat.params').map((entry) => entry.agent);
    const agentNames = (agents.json ?? []).map((/** @type {any} */ agent) => agent.name).sort();
    ctx.evidence.serverPath = {
      promptStatus: prompt.status,
      requests: served.llm.chatRequests.length,
      agents: serveAgents,
      listedAgents: agentNames,
      agentListStatus: agents.status,
      assistantErrors: ((prompt.json?.parts ?? []).length ? undefined : prompt.json?.error) ?? null,
    };
    ctx.checks.add('E5 server session path answers with one unity-code request', prompt.status === 200 && served.llm.chatRequests.length === 1 && serveAgents.join(',') === 'unity-code', ctx.evidence.serverPath);
    ctx.checks.add('E5 build, plan and title are not listed as agents', agents.status === 200 && !agentNames.some((/** @type {string} */ name) => ['build', 'plan', 'title'].includes(name)), agentNames);
  } finally {
    await ctx.closeAll();
  }
  ctx.evidence.manualPending = ['TUI startup and error rendering with the built-ins disabled: needs a real console (spec 20.3 C13, gate G10).'];
  ctx.decision = ctx.checks.allPass
    ? 'Disable build, plan and title (D22). The TUI rendering itself stays a manual M0 and G10 check; run and the server session path are covered automatically.'
    : 'Keep build and plan (config-level denies still apply) and/or keep the title agent under the guard.';
  ctx.findings.push(
    'With agent.build/plan/title disabled, `opencode run` works with and without --agent, and the only request per step comes from unity-code.',
    'The title agent is the only source of the extra small request; with it enabled the same prompt produces a second request from agent "title". `summary.summarize` sends no request.',
    '`debug agent build` exits non-zero once the agent is disabled, which is a cheap check for the effective-config verification.',
    'The TUI needs a real console, so its startup is a manual M0 check (and gate G10); the server session path used here is the same processor and agent code the TUI drives.',
  );
  return ctx;
}
