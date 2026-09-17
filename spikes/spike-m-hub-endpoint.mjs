// Spike M: what is the MCP for Unity HTTP endpoint path when no configurator entry exists?
//
// The hub itself must never be contacted from here, so the spike verifies the client half against a
// mock hub: OpenCode's remote MCP transport is pointed at `<base>/mcp` (the path MCP for Unity's
// HttpEndpointUtility builds) and at a base without that path, and both outcomes are recorded.
import { startMockLlm, systemText, toolNames } from './lib/mock-llm.mjs';
import { HUB_INSTRUCTIONS_MARKER, startMockMcpHub } from './lib/mock-mcp-hub.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'M',
  title: 'MCP for Unity HTTP endpoint path',
  question: 'What is the MCP for Unity HTTP endpoint path when no configurator entry exists?',
  contractTest: 'Manual',
  fallback: 'Require the user to paste the URL from the MCP for Unity window',
};

/** From UM v10.1.0 HttpEndpointUtility: the stored value is a base URL and the RPC path is appended. */
const DOCUMENTED_DEFAULT_BASE = 'http://127.0.0.1:8080';
const RPC_PATH = '/mcp';

const EDITOR_AGENT = `---
description: Unity Editor check agent (spike)
mode: primary
steps: 10
---
You are the spike editor agent.
`;

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {(hubUrl: string) => string} toUrl
 */
async function runScenario(ctx, label, toUrl) {
  const hub = ctx.track(await startMockMcpHub({ path: RPC_PATH }));
  const llm = ctx.track(await startMockLlm());
  const ws = ctx.track(await createWorkspace({
    label: `m-${label}`,
    opencodeConfig: profileConfig({ default_agent: 'unity-editor' }),
    agents: { 'unity-editor': EDITOR_AGENT },
    pluginConfig: providerPluginConfig(llm.baseURL),
  }));
  const env = ws.env({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      mcp: { unityMCP: { type: 'remote', url: toUrl(hub.url), enabled: true, timeout: 20_000 } },
      agent: { 'unity-editor': { permission: { '*': 'deny', unityMCP_read_console: 'allow', read: { '*': 'deny', 'mcp:unityMCP:*': 'allow' } } } },
    }),
  });
  const result = await runOpencode({ args: ['run', '--format', 'json', '--agent', 'unity-editor', 'Say OK'], env, cwd: ws.project, timeoutMs: 180_000 });
  const request = llm.chatRequests[0];
  return {
    hub,
    llm,
    result,
    summary: {
      ...summarizeRun(result, llm, ws.readHooks()),
      url: toUrl(hub.url).replace(/:\d+/, ':<port>'),
      hubPaths: [...new Set(hub.httpRequests.map((entry) => entry.url))],
      hubMethods: [...new Set(hub.messages.map((message) => message.method))],
      mcpTools: toolNames(request?.body).filter((name) => name.startsWith('unityMCP_')),
      hasHubInstructions: systemText(request?.body).includes(HUB_INSTRUCTIONS_MARKER),
    },
  };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const withPath = await runScenario(ctx, 'with-mcp-path', (url) => url);
    ctx.evidence.withRpcPath = withPath.summary;
    ctx.checks.add('M1 a remote MCP URL ending in /mcp connects and lists tools', withPath.summary.hubMethods.includes('initialize') && withPath.summary.hubMethods.includes('tools/list'), withPath.summary.hubMethods);
    ctx.checks.add('M2 every hub request goes to the /mcp path', withPath.summary.hubPaths.every((entry) => entry.startsWith(RPC_PATH)), withPath.summary.hubPaths);
    ctx.checks.add('M3 the allowed tool and the hub instructions reach the session', withPath.summary.mcpTools.join(',') === 'unityMCP_read_console' && withPath.summary.hasHubInstructions, { tools: withPath.summary.mcpTools, instructions: withPath.summary.hasHubInstructions });

    const withoutPath = await runScenario(ctx, 'base-only', (url) => url.replace(/\/mcp$/, ''));
    ctx.evidence.baseUrlOnly = withoutPath.summary;
    ctx.checks.add('M4 the base URL without /mcp reaches no MCP method', withoutPath.summary.hubMethods.length === 0, withoutPath.summary.hubMethods);
    ctx.checks.add('M5 a wrong URL costs the session its MCP tools but not the session itself', withoutPath.summary.mcpTools.length === 0 && withoutPath.result.exitCode === 0, { tools: withoutPath.summary.mcpTools, exitCode: withoutPath.result.exitCode });
  } finally {
    await ctx.closeAll();
  }
  ctx.outcome = ctx.checks.allPass ? 'partial' : 'fail';
  ctx.decision = `Build the hub URL as <base>/mcp, default base ${DOCUMENTED_DEFAULT_BASE}, and take the spec fallback for discovery: the user pastes the HTTP base URL from the MCP for Unity window (doctor pre-fills the documented default and the URL of an existing configurator entry when one is there). Nothing outside the Editor's own preferences reveals a changed port.`;
  ctx.findings.push(
    `MCP for Unity stores an HTTP BASE url in EditorPrefs (default ${DOCUMENTED_DEFAULT_BASE}) and appends "${RPC_PATH}" for the JSON-RPC endpoint; its OpenCode configurator writes { "type": "remote", "url": "<base>${RPC_PATH}" } into the user's global opencode.json, and it strips a trailing "/mcp" from whatever the user types.`,
    `OpenCode 1.18.31 talks to such a URL over the streamable HTTP transport: initialize, notifications/initialized, tools/list and tools/call all POST to ${RPC_PATH}, and a GET answered with 405 is accepted.`,
    'Pointing the same configuration at the base URL without the path yields no MCP method at all: the session still runs, but with no MCP tools, which is the failure mode doctor must name.',
    'The port is only in the Editor\'s preferences, so when no configurator entry exists the user has to paste the URL from the MCP for Unity window; the live confirmation against a real hub stays a manual check.',
  );
  return ctx;
}
