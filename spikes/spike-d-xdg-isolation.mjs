// Spike D: do the XDG isolation canaries stay out of an isolated launch, and does `shell.env` restore
// the user's original XDG_CONFIG_HOME (plus the dotnet variables) for agent shell commands?
import fs from 'node:fs/promises';
import path from 'node:path';

import { scriptedToolCalls, startMockLlm, systemText, toolNames, toolResultAfter } from './lib/mock-llm.mjs';
import { startMockMcpHub } from './lib/mock-mcp-hub.mjs';
import { parseFirstJson, runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'D',
  title: 'XDG isolation canaries and shell.env restoration',
  question: 'Do the XDG isolation canaries stay out, and does shell.env restore XDG_CONFIG_HOME for shell commands?',
  contractTest: 'C1, C10',
  fallback: 'Run without XDG isolation and refuse launch when the global config has plugins, MCP servers, agents or permission keys unless --accept-global-config',
};

/** Strings that must never reach a request or the effective config of an isolated launch. */
const CANARIES = Object.freeze({
  instructions: 'CANARY_GLOBAL_INSTRUCTIONS',
  agentsMd: 'CANARY_GLOBAL_AGENTS_MD',
  agentPrompt: 'CANARY_GLOBAL_AGENT_PROMPT',
  fileAgent: 'CANARY_GLOBAL_FILE_AGENT',
  claudeMd: 'CANARY_CLAUDE_MD',
  skill: 'CANARY_EXTERNAL_SKILL',
  command: 'CANARY_GLOBAL_COMMAND',
});
const FACTS_MARKER = 'SPIKE_FACTS_MARKER';
const ENV_PROBE = 'node -e "console.log(\'XDG=\' + process.env.XDG_CONFIG_HOME + \' TELEMETRY=\' + process.env.DOTNET_CLI_TELEMETRY_OPTOUT + \' NOLOGO=\' + process.env.DOTNET_NOLOGO)"';

/**
 * Writes the canary files into the sandbox's own (unisolated) home and XDG config dir.
 * @param {Awaited<ReturnType<typeof createWorkspace>>} ws
 * @param {string} hubUrl
 */
async function writeCanaries(ws, hubUrl) {
  const { dirs, root } = ws.sandbox;
  const globalConfig = path.join(dirs.xdgConfig, 'opencode');
  const marker = path.join(root, 'canary-plugin-loaded.txt');
  await fs.mkdir(path.join(globalConfig, 'plugins'), { recursive: true });
  await fs.mkdir(path.join(globalConfig, 'agents'), { recursive: true });
  await fs.mkdir(path.join(globalConfig, 'command'), { recursive: true });
  await fs.mkdir(path.join(dirs.home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(dirs.home, '.agents', 'skills', 'canary'), { recursive: true });
  await fs.writeFile(path.join(globalConfig, 'canary-instructions.md'), `${CANARIES.instructions}: the user's global instructions.\n`);
  await fs.writeFile(path.join(globalConfig, 'opencode.json'), JSON.stringify({
    instructions: [path.join(globalConfig, 'canary-instructions.md').replace(/\\/g, '/')],
    agent: { 'canary-agent': { description: 'canary agent', prompt: CANARIES.agentPrompt } },
    mcp: { canaryMCP: { type: 'remote', url: hubUrl, enabled: true } },
    plugin: [`file://${path.join(globalConfig, 'plugins', 'canary-plugin.js').replace(/\\/g, '/')}`],
  }, null, 2));
  await fs.writeFile(path.join(globalConfig, 'AGENTS.md'), `${CANARIES.agentsMd}\n`);
  await fs.writeFile(path.join(globalConfig, 'agents', 'canary-file-agent.md'), `---\ndescription: canary file agent\nmode: primary\n---\n${CANARIES.fileAgent}\n`);
  await fs.writeFile(path.join(globalConfig, 'command', 'canary.md'), `---\ndescription: canary command\n---\n${CANARIES.command}\n`);
  await fs.writeFile(path.join(globalConfig, 'plugins', 'canary-plugin.js'), [
    "import fs from 'node:fs';",
    `export default { id: 'canary-plugin', server: async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'loaded'); return {}; } };`,
    '',
  ].join('\n'));
  await fs.writeFile(path.join(dirs.home, '.claude', 'CLAUDE.md'), `${CANARIES.claudeMd}\n`);
  await fs.writeFile(path.join(dirs.home, '.agents', 'skills', 'canary', 'SKILL.md'), `---\nname: canary\ndescription: ${CANARIES.skill}\n---\n${CANARIES.skill}\n`);
  return { marker, globalConfig };
}

/**
 * @param {SpikeContext} ctx
 * @param {object} options
 * @param {boolean} options.isolated
 */
async function runScenario(ctx, { isolated }) {
  const llm = ctx.track(await startMockLlm({ respond: scriptedToolCalls([{ name: 'bash', arguments: { command: ENV_PROBE, description: 'print environment' } }], 'done') }));
  const hub = ctx.track(await startMockMcpHub({ instructions: 'CANARY_MCP_SERVER_INSTRUCTIONS' }));
  const ws = ctx.track(await createWorkspace({
    label: `d-${isolated ? 'isolated' : 'control'}`,
    opencodeConfig: profileConfig({ permission: { bash: 'allow' } }),
    pluginConfig: providerPluginConfig(llm.baseURL),
  }));
  const canaries = await writeCanaries(ws, hub.url);
  // The plugin's shell.env hook restores the XDG_CONFIG_HOME the user had before the clean-room launch.
  const originalXdg = ws.sandbox.dirs.xdgConfig;
  await ws.setPluginConfig(providerPluginConfig(llm.baseURL, {
    shellEnv: { set: { XDG_CONFIG_HOME: originalXdg, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } },
  }));
  const facts = ws.sandbox.path('facts.md');
  await fs.writeFile(facts, `# Project facts\n${FACTS_MARKER}\n`);
  const env = ws.env({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: [facts.replace(/\\/g, '/')] }),
    ...(isolated ? {} : { XDG_CONFIG_HOME: ws.sandbox.dirs.xdgConfig }),
  });
  const result = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'], env, cwd: ws.project, timeoutMs: 150_000 });
  const debugConfig = await runOpencode({ args: ['debug', 'config'], env, cwd: ws.project, timeoutMs: 90_000 });
  const config = parseFirstJson(debugConfig.stdout) ?? {};
  const hooks = ws.readHooks();
  const first = llm.chatRequests[0];
  const requestText = JSON.stringify(first?.body ?? {});
  const leaked = Object.entries(CANARIES).filter(([, value]) => requestText.includes(value)).map(([name]) => name);
  const pluginLoaded = await fs.stat(canaries.marker).then(() => true, () => false);
  return {
    llm,
    hub,
    hooks,
    result,
    leaked,
    originalXdg,
    isolatedXdg: ws.isolatedXdg,
    pluginLoaded,
    config,
    summary: {
      ...summarizeRun(result, llm, hooks),
      leakedCanaries: leaked,
      canaryPluginLoaded: pluginLoaded,
      canaryHubRequests: hub.httpRequests.length,
      systemMessages: (first?.body?.messages ?? []).filter((/** @type {any} */ message) => message.role === 'system').length,
      systemHasFacts: systemText(first?.body).includes(FACTS_MARKER),
      toolNames: toolNames(first?.body),
      configAgents: Object.keys(config.agent ?? {}),
      configMcp: Object.keys(config.mcp ?? {}),
      configInstructions: (config.instructions ?? []).length,
      configPluginOrigins: (config.plugin_origins ?? []).map((/** @type {any} */ origin) => (String(origin.spec).includes('canary') ? 'canary' : 'profile')),
      configCommands: Object.keys(config.command ?? {}),
      shellEnvHooks: hooks.filter((entry) => entry.hook === 'shell.env').length,
      envProbeResult: toolResultAfter(llm.chatRequests, 0),
    },
  };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const isolated = await runScenario(ctx, { isolated: true });
    ctx.evidence.isolated = isolated.summary;
    ctx.checks.add('D1 no canary string reaches the request', isolated.leaked.length === 0, isolated.leaked);
    ctx.checks.add('D1 the canary global plugin never loads', isolated.pluginLoaded === false, isolated.pluginLoaded);
    ctx.checks.add('D1 the canary MCP server is never contacted', isolated.hub.httpRequests.length === 0, isolated.hub.httpRequests.length);
    ctx.checks.add('D1 no canary tool in the request tool list', !isolated.summary.toolNames.some((name) => name.startsWith('canaryMCP')), isolated.summary.toolNames);
    ctx.checks.add('D1 effective config has no canary agent, MCP server, command or plugin', isolated.summary.configAgents.every((name) => !name.startsWith('canary')) && isolated.summary.configMcp.length === 0 && isolated.summary.configCommands.every((name) => !name.startsWith('canary')) && !isolated.summary.configPluginOrigins.includes('canary'), {
      agents: isolated.summary.configAgents,
      mcp: isolated.summary.configMcp,
      commands: isolated.summary.configCommands,
      pluginOrigins: isolated.summary.configPluginOrigins,
    });
    ctx.checks.add('D2 exactly one system message, carrying the facts file', isolated.summary.systemMessages === 1 && isolated.summary.systemHasFacts, { systemMessages: isolated.summary.systemMessages, systemHasFacts: isolated.summary.systemHasFacts });
    ctx.checks.add('D3 shell.env fires for the agent shell command', isolated.summary.shellEnvHooks >= 1, isolated.summary.shellEnvHooks);
    const probe = String(isolated.summary.envProbeResult ?? '');
    ctx.checks.add('D3 the shell sees the original XDG_CONFIG_HOME, not the isolated one', probe.includes(`XDG=${isolated.originalXdg}`) && !probe.includes(isolated.isolatedXdg), probe.slice(0, 300));
    ctx.checks.add('D3 the shell sees DOTNET_CLI_TELEMETRY_OPTOUT=1 and DOTNET_NOLOGO=1', probe.includes('TELEMETRY=1') && probe.includes('NOLOGO=1'), probe.slice(0, 300));

    const control = await runScenario(ctx, { isolated: false });
    ctx.evidence.control = control.summary;
    ctx.checks.add('D4 control run without isolation: the canaries are live', control.leaked.length > 0 || control.pluginLoaded || control.hub.httpRequests.length > 0 || control.summary.configAgents.some((name) => name.startsWith('canary')), {
      leaked: control.leaked,
      pluginLoaded: control.pluginLoaded,
      hubRequests: control.hub.httpRequests.length,
      agents: control.summary.configAgents,
      mcp: control.summary.configMcp,
    });
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep the isolated XDG_CONFIG_HOME plus OPENCODE_CONFIG_DIR clean room (D2), with shell.env restoring the original XDG_CONFIG_HOME for agent commands.'
    : 'If isolation breaks OpenCode, run without it and refuse a launch whose global config carries plugins, MCP servers, agents or permission keys unless --accept-global-config.';
  ctx.findings.push(
    'With XDG_CONFIG_HOME pointed at an empty profile-owned directory, the global opencode.json, its agents, commands, instructions, plugins and MCP servers are all out of the session.',
    'The per-launch OPENCODE_CONFIG_CONTENT instructions array puts the facts file into the single system message.',
    'The shell.env hook is the only way agent shell commands see the user\'s real XDG_CONFIG_HOME again.',
  );
  return ctx;
}
