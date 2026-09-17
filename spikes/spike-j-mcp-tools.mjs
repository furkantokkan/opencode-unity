// Spike J: does `tool.execute.before` turn an MCP argument-policy violation into a tool error, does an
// argument removed there really stay out of the hub call, and what does a `read` rule for MCP resources
// look like?
import { scriptedToolCalls, startMockLlm, systemText, toolNames, toolResultAfter } from './lib/mock-llm.mjs';
import { HUB_INSTRUCTIONS_MARKER, INSTANCES_URI, startMockMcpHub } from './lib/mock-mcp-hub.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'J',
  title: 'MCP tool argument policy and resource permissions',
  question: 'Does tool.execute.before for MCP tools throw into a tool error, does unity_instance removal reach the hub, and what is the read pattern format for MCP resources?',
  contractTest: 'C11',
  fallback: 'Keep run_tests/refresh_unity on ask with prompt rules only, and document that the argument policy is unenforced',
};

const EDITOR_AGENT = `---
description: Unity Editor check agent (spike)
mode: primary
temperature: 0.7
steps: 20
---
You are the spike editor agent. Use only the allowed tools.
`;

const CODE_AGENT = `---
description: Unity C# coding with a local model (spike)
mode: primary
temperature: 0.7
steps: 20
---
You are the spike code agent.
`;

/** Spec 8.5.2, unityEditorPermission, with the ask rules set to allow so the spike runs unattended. */
const EDITOR_PERMISSION = {
  '*': 'deny',
  unityMCP_read_console: 'allow',
  unityMCP_find_gameobjects: 'allow',
  unityMCP_get_test_job: 'allow',
  unityMCP_refresh_unity: 'allow',
  unityMCP_run_tests: 'allow',
  read: { '*': 'deny', 'mcp:unityMCP:*': 'allow' },
};

/** Spec 8.5.2, the code agent's rule that hides every MCP tool. */
const CODE_PERMISSION = { '*_*': 'deny', read: { 'mcp:*': 'deny' } };

const CASES = [
  { id: 'J1 read_console with action clear', tool: 'unityMCP_read_console', args: { action: 'clear', unity_instance: 'Other@0123456789abcdef' }, expect: 'blocked' },
  { id: 'J2 read_console with action get', tool: 'unityMCP_read_console', args: { action: 'get', unity_instance: 'Other@0123456789abcdef', count: 5 }, expect: 'ran' },
  { id: 'J3 run_tests in PlayMode', tool: 'unityMCP_run_tests', args: { mode: 'PlayMode' }, expect: 'blocked' },
  { id: 'J4 run_tests in EditMode', tool: 'unityMCP_run_tests', args: { mode: 'EditMode' }, expect: 'ran' },
  { id: 'J5 MCP resource read', tool: 'read_mcp_resource', args: { server: 'unityMCP', uri: INSTANCES_URI }, expect: 'ran' },
  { id: 'J6 a tool outside the allow-list', tool: 'unityMCP_manage_script', args: { action: 'create' }, expect: 'blocked' },
];

export async function run() {
  const ctx = new SpikeContext();
  try {
    const hub = ctx.track(await startMockMcpHub());
    const llm = ctx.track(await startMockLlm({ respond: scriptedToolCalls(CASES.map((item) => ({ name: item.tool, arguments: item.args }))) }));
    const ws = ctx.track(await createWorkspace({
      label: 'j-mcp',
      opencodeConfig: profileConfig({ default_agent: 'unity-editor' }),
      agents: { 'unity-editor': EDITOR_AGENT, 'unity-code': CODE_AGENT },
      pluginConfig: providerPluginConfig(llm.baseURL, {
        toolBefore: { stripUnityInstance: true, readConsoleGetOnly: true, runTestsEditModeOnly: true, clampRead: 200 },
      }),
    }));
    const content = {
      mcp: { unityMCP: { type: 'remote', url: hub.url, enabled: true, timeout: 120_000 } },
      agent: {
        'unity-editor': { permission: EDITOR_PERMISSION },
        'unity-code': { permission: CODE_PERMISSION },
      },
    };
    const env = ws.env({ OPENCODE_CONFIG_CONTENT: JSON.stringify(content) });
    const editorRun = await runOpencode({
      args: ['run', '--print-logs', '--log-level', 'INFO', '--format', 'json', '--agent', 'unity-editor', 'Check the editor'],
      env,
      cwd: ws.project,
      timeoutMs: 300_000,
    });
    const hooks = ws.readHooks();
    const first = llm.chatRequests[0];
    const visibleTools = toolNames(first?.body);
    const hubCalls = hub.messages.filter((message) => message.method === 'tools/call');
    const resourceReads = hub.messages.filter((message) => message.method === 'resources/read');
    const permissionLines = editorRun.stderr.split(/\r?\n/).filter((line) => line.includes('message=evaluated') || line.includes('message=asking'));

    const cases = CASES.map((item, index) => {
      const output = String(toolResultAfter(llm.chatRequests, index) ?? '');
      const ran = !/rule which prevents you|opencode-unity:|unavailable tool|AI_NoSuchToolError|No such tool/i.test(output) && output.length > 0;
      return { id: item.id, tool: item.tool, expected: item.expect, actual: ran ? 'ran' : 'blocked', output: output.slice(0, 200) };
    });
    cases.forEach((item) => ctx.checks.add(`${item.id}: ${item.expected}`, item.actual === item.expected, item.output));

    ctx.evidence.editorRun = summarizeRun(editorRun, llm, hooks);
    ctx.evidence.cases = cases;
    ctx.evidence.visibleTools = visibleTools;
    ctx.evidence.hubToolCalls = hubCalls.map((message) => ({ name: message.params?.name, args: message.params?.arguments }));
    ctx.evidence.hubResourceReads = resourceReads.map((message) => message.params?.uri);
    ctx.evidence.hubMethods = [...new Set(hub.messages.map((message) => message.method))];
    ctx.evidence.permissionLines = permissionLines.map((line) => line.replace(/^.*message=/, 'message=').slice(0, 220));

    const readConsoleCall = ctx.evidence.hubToolCalls.find((call) => call.name === 'read_console');
    ctx.checks.add('J7 unity_instance is removed before the hub sees the call', Boolean(readConsoleCall) && !('unity_instance' in (readConsoleCall?.args ?? {})), readConsoleCall);
    ctx.checks.add('J8 a blocked call never reaches the hub', hubCalls.every((message) => message.params?.arguments?.action !== 'clear' && message.params?.arguments?.mode !== 'PlayMode'), ctx.evidence.hubToolCalls);
    ctx.checks.add('J9 the visible MCP tools are exactly the allow-list', visibleTools.filter((name) => name.startsWith('unityMCP_')).sort().join(',') === 'unityMCP_find_gameobjects,unityMCP_get_test_job,unityMCP_read_console,unityMCP_refresh_unity,unityMCP_run_tests', visibleTools);
    ctx.checks.add('J10 the MCP resource read is allowed by the `mcp:<server>:<uri>` pattern', resourceReads.length === 1 && resourceReads[0].params?.uri === INSTANCES_URI, ctx.evidence.hubResourceReads);
    ctx.checks.add('J11 the argument policy runs before the permission ask', permissionLines.every((line) => !line.includes('read_console') || !line.includes('"clear"')), ctx.evidence.permissionLines.slice(0, 6));
    ctx.checks.add('J12 the editor agent gets the hub instructions', systemText(first?.body).includes(HUB_INSTRUCTIONS_MARKER), systemText(first?.body).slice(-200));

    // The code agent hides every MCP tool through `*_*: deny`.
    await ws.clearHooks();
    const codeLlm = ctx.track(await startMockLlm());
    await ws.setPluginConfig(providerPluginConfig(codeLlm.baseURL, { toolBefore: { clampRead: 200 } }));
    const codeRun = await runOpencode({
      args: ['run', '--format', 'json', '--agent', 'unity-code', 'Say OK'],
      env: ws.env({ OPENCODE_CONFIG_CONTENT: JSON.stringify(content) }),
      cwd: ws.project,
      timeoutMs: 150_000,
    });
    const codeRequest = codeLlm.chatRequests[0];
    ctx.evidence.codeAgent = {
      exitCode: codeRun.exitCode,
      toolNames: toolNames(codeRequest?.body),
      hasHubInstructions: systemText(codeRequest?.body).includes(HUB_INSTRUCTIONS_MARKER),
    };
    ctx.checks.add('J13 the code agent sees no MCP tool and no hub instructions', !toolNames(codeRequest?.body).some((name) => name.startsWith('unityMCP_')) && !ctx.evidence.codeAgent.hasHubInstructions, ctx.evidence.codeAgent);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Enforce the MCP argument policy in the plugin `tool.execute.before` hook (spec 11.3), and keep the editor agent behind the exact-name allow-list plus `read: { "mcp:<server>:*": "allow" }`.'
    : 'Keep run_tests and refresh_unity on ask with prompt rules only, and document the argument policy as unenforced.';
  ctx.findings.push(
    'For MCP tools, `tool.execute.before` receives the same arguments object that is forwarded to the hub, so deleting a key there (unity_instance) really removes it from the JSON-RPC call, and throwing there fails the tool call before the permission ask, with the message returned to the model.',
    'MCP resources are reached through the built-in tools list_mcp_resources, list_mcp_resource_templates and read_mcp_resource; they all map to the `read` permission, and read_mcp_resource asks with pattern `mcp:<server>:<uri>` (always `mcp:<server>:*`), which is exactly the rule format spec 8.5.2 renders.',
    'A tool whose last matching rule is `*: deny` disappears from the request tool list, so the code agent\'s `*_*: deny` hides every MCP tool and the hub instructions stay out of its system prompt.',
    'A hidden tool the model still tries to call comes back as "Model tried to call unavailable tool" plus the list of available tools, so hiding a tool is itself a usable guard.',
    'The mock hub answers the streamable HTTP transport with plain JSON responses (no SSE stream) and a 405 on GET, which is enough for OpenCode 1.18.31.',
  );
  return ctx;
}
