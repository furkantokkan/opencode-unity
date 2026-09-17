// A fake OpenCode for the scenario-runner tests: it talks to the mocks the way OpenCode 1.18.31 plus
// the product plugin would (guard probes, one system message, sampling, the budget preflight, the
// compaction path, the MCP argument policy), so the runner and its checks are exercised without the
// real binary and without a model. Contract tests use the real binary instead (spec 20.3).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { NVIDIA_SMI_QUERY_ARGS, parseNvidiaSmiOutput } from '../../../plugin/opencode-unity-lib/guard/probes/nvidia-smi.js';
import { estimatePromptTokens } from '../../../src/selftest/mock-openai.js';
import {
  EDITOR_MCP_TOOL_PREFIX,
  FACTS_MARKER,
  GUARD_MESSAGE_PREFIX,
  SESSION_TOO_LARGE_TEXT,
} from '../../../src/selftest/scenarios.js';
import { foldChunks, postChat, readSseEvents } from './sse.mjs';

const run = promisify(execFile);

// Mirrors OpenCode's read tool: 200 lines (clamped by the plugin) and 50 KB.
const READ_MAX_LINES = 200;
const READ_MAX_BYTES = 50_000;

// The measured prefix of the shipped code agent: system 1,673 tokens and tools 3,318 tokens at 3.5
// characters per token (spec 3.3, 18.3 E9). The fake pads to it, so budget scenarios behave as they do
// with the real agent.
const SYSTEM_PREFIX_CHARS = Math.round(1673 * 3.5);
const TOOLS_PREFIX_CHARS = Math.round(3318 * 3.5);

/**
 * @param {object} options
 * @param {readonly string[]} options.codeTools
 * @param {Record<string, string>} [options.faults]  Scenario id to fault name; `hang-once` hangs the first attempt only.
 * @returns {(request: import('../../../src/selftest/scenarios.js').LaunchRequest) => Promise<import('../../../src/selftest/scenarios.js').LaunchResult>}
 */
export function createFakeOpenCode({ codeTools, faults = {} }) {
  /** @type {Record<string, number>} */
  const attempts = {};
  return async function launch(request) {
    const fault = faults[request.scenario.id];
    attempts[request.scenario.id] = (attempts[request.scenario.id] ?? 0) + 1;
    if (fault === 'hang' || (fault === 'hang-once' && attempts[request.scenario.id] === 1)) return new Promise(() => {});
    const setup = request.setup;
    const session = { out: [], err: [] };
    const cold = !request.scenario.guard.modelLoaded;
    const guard = await probeGuard(setup, cold);
    if (!guard.ok) {
      session.err.push(`${GUARD_MESSAGE_PREFIX} the model was not loaded because ${guard.reason}.`);
      if (fault !== 'guard-sends-request') return finish(session, 2);
    }
    if (request.run.plugin === 'deleted' || request.run.plugin === 'syntax-error' || request.run.env?.OPENCODE_PURE === '1') {
      session.err.push('Error: Model not found: opencode-unity/ocu-qwen3-coder-30b-16k');
      return finish(session, 1);
    }
    const tools = await buildTools(request, codeTools);
    const systemText = buildSystemText(request, fault);
    const loop = await runAgentLoop(request, { tools, systemText, session, fault });
    session.out.push(loop.text ?? '');
    return finish(session, loop.exitCode);
  };
}

/**
 * @param {import('../../../src/selftest/scenarios.js').LaunchRequest} request
 * @param {readonly string[]} codeTools
 */
async function buildTools(request, codeTools) {
  const perTool = Math.round(TOOLS_PREFIX_CHARS / codeTools.length);
  const tools = codeTools.map((name) => ({
    type: 'function',
    function: { name, description: pad(`mock schema for ${name}. `, perTool), parameters: { type: 'object', properties: {} } },
  }));
  if (request.run.agent !== 'unity-editor' || !request.setup.hubUrl) return tools;
  const hubTools = await hubCall(request.setup.hubUrl, 'tools/list');
  const allowed = new Set(['read_console', 'find_gameobjects', 'get_test_job', 'refresh_unity', 'run_tests']);
  for (const tool of hubTools.result.tools.filter((tool) => allowed.has(tool.name))) {
    tools.push({ type: 'function', function: { name: `${EDITOR_MCP_TOOL_PREFIX}${tool.name}`, description: tool.description, parameters: tool.inputSchema } });
  }
  return tools;
}

/**
 * @param {import('../../../src/selftest/scenarios.js').LaunchRequest} request
 * @param {string | undefined} fault
 */
function buildSystemText(request, fault) {
  const parts = [`You are the ${request.run.agent} agent.`, `# Project facts (${FACTS_MARKER})`];
  if (request.run.agent === 'unity-editor' && request.setup.hubUrl) parts.push('OCU-MOCK-HUB-INSTRUCTIONS');
  if (fault === 'canary-leak') parts.push('OCU_CANARY_CLAUDE_MD_41C7');
  if (fault === 'missing-facts') parts.splice(1, 1);
  const text = parts.join('\n');
  return `${text}\n${pad('mock agent prompt. ', Math.max(0, SYSTEM_PREFIX_CHARS - text.length))}`;
}

/**
 * @param {string} unit
 * @param {number} chars
 * @returns {string}
 */
function pad(unit, chars) {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

/**
 * @param {import('../../../src/selftest/scenarios.js').ScenarioSetup} setup
 * @param {boolean} cold
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function probeGuard(setup, cold) {
  const loaded = await (await fetch(`${setup.backend.url}/api/ps`)).json();
  const running = loaded.models.find((entry) => entry.name.startsWith(setup.profile.modelTag));
  if (running && running.context_length === setup.profile.numCtx) return { ok: true, reason: 'the model is loaded' };
  if (!cold) return { ok: false, reason: 'the model is not loaded at the expected context' };
  const smi = await run(process.execPath, [setup.nvidiaSmiCommand, ...NVIDIA_SMI_QUERY_ARGS]);
  const reading = parseNvidiaSmiOutput(smi.stdout);
  if (!reading.ok || !reading.memory.ok) return { ok: false, reason: 'nvidia-smi could not report GPU memory' };
  const freeAfterLoad = reading.memory.freeMiB - 19_000;
  if (freeAfterLoad < 1500) return { ok: false, reason: `free video memory would drop to ${(freeAfterLoad / 1024).toFixed(1)} GiB (minimum 1.5 GiB)` };
  return { ok: true, reason: 'enough free video memory' };
}

/**
 * @param {import('../../../src/selftest/scenarios.js').LaunchRequest} request
 * @param {{ tools: any[], systemText: string, session: { out: string[], err: string[] }, fault: string | undefined }} options
 */
async function runAgentLoop(request, { tools, systemText, session, fault }) {
  const { setup, run: scenarioRun } = request;
  const budget = setup.profile.promptBudget;
  let messages = [{ role: 'system', content: systemText }, { role: 'user', content: scenarioRun.prompt }];
  let compacted = false;
  for (let step = 0; step < 8; step += 1) {
    const body = buildRequestBody(setup, messages, tools, fault);
    if (estimatePromptTokens(body) > budget) {
      if (compacted) {
        session.err.push(`opencode-unity: this session is too large for the local context; ${SESSION_TOO_LARGE_TEXT}.`);
        return { exitCode: 1, text: '' };
      }
      messages = [{ role: 'system', content: systemText }, { role: 'user', content: await compact(setup, messages) }];
      compacted = true;
      continue;
    }
    const turn = foldChunks((await readSseEvents(await postChat(setup.backend.openAiBaseUrl, body))).events);
    if (turn.toolCalls.length === 0) return { exitCode: 0, text: turn.text };
    messages.push({ role: 'assistant', content: '', tool_calls: turn.toolCalls.map((call, index) => ({ id: call.id, index, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
    for (const call of turn.toolCalls) {
      const result = await executeTool(setup, call, session);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { exitCode: 1, text: 'the fake agent ran out of steps' };
}

/**
 * @param {import('../../../src/selftest/scenarios.js').ScenarioSetup} setup
 * @param {any[]} messages
 * @param {any[]} tools
 * @param {string | undefined} fault
 */
function buildRequestBody(setup, messages, tools, fault) {
  const body = {
    model: setup.profile.modelTag,
    messages: fault === 'second-system-message' ? [...messages, { role: 'system', content: 'a second system message' }] : messages,
    tools,
    temperature: setup.profile.temperature,
    top_p: setup.profile.topP,
    max_tokens: setup.profile.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (fault === 'wrong-sampling') body.temperature = 1;
  return body;
}

/**
 * A compaction request: no tools, and the history wrapped in `<conversation>` tags the way OpenCode
 * builds it (OC `session/compaction.ts`).
 * @param {import('../../../src/selftest/scenarios.js').ScenarioSetup} setup
 * @param {any[]} messages
 * @returns {Promise<string>}
 */
async function compact(setup, messages) {
  const conversation = messages.map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`).join('\n');
  const body = {
    model: setup.profile.modelTag,
    messages: [{ role: 'user', content: `Summarize.\n<conversation>\n${conversation}\n</conversation>` }],
    temperature: setup.profile.temperature,
    top_p: setup.profile.topP,
    max_tokens: setup.profile.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  const turn = foldChunks((await readSseEvents(await postChat(setup.backend.openAiBaseUrl, body))).events);
  return `Summary of the earlier conversation:\n${turn.text}`;
}

/**
 * @param {import('../../../src/selftest/scenarios.js').ScenarioSetup} setup
 * @param {{ name: string, arguments: string }} call
 * @param {{ out: string[], err: string[] }} session
 * @returns {Promise<string>}
 */
async function executeTool(setup, call, session) {
  const args = call.arguments ? JSON.parse(call.arguments) : {};
  if (call.name === 'read') return readFileLikeOpenCode(String(args.filePath ?? ''));
  if (!call.name.startsWith(EDITOR_MCP_TOOL_PREFIX) || !setup.hubUrl) return `mock result for ${call.name}`;
  const hubName = call.name.slice(EDITOR_MCP_TOOL_PREFIX.length);
  const policy = applyMcpArgumentPolicy(hubName, args);
  if (policy.error) {
    session.err.push(`tool rejected: ${policy.error}`);
    return `Error: ${policy.error}`;
  }
  const answer = await hubCall(setup.hubUrl, 'tools/call', { name: hubName, arguments: policy.args });
  return JSON.stringify(answer.result);
}

/**
 * Spec 11.3: `unity_instance` is deleted, `read_console` must use `get`, `run_tests` must stay in
 * EditMode and name at least one filter.
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export function applyMcpArgumentPolicy(name, args) {
  const cleaned = { ...args };
  delete cleaned.unity_instance;
  if (name === 'read_console' && cleaned.action !== undefined && cleaned.action !== 'get') {
    return { error: 'read_console only supports action get in this session' };
  }
  if (name === 'run_tests') {
    if (cleaned.mode !== undefined && cleaned.mode !== 'EditMode') return { error: 'run_tests only supports EditMode in this session' };
    const filters = ['test_names', 'group_names', 'category_names', 'assembly_names'];
    if (!filters.some((filter) => Array.isArray(cleaned[filter]) && cleaned[filter].length > 0)) {
      return { error: 'run_tests needs at least one test, group, category or assembly filter' };
    }
  }
  return { args: cleaned };
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileLikeOpenCode(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text.split('\n').slice(0, READ_MAX_LINES).join('\n').slice(0, READ_MAX_BYTES);
}

/**
 * @param {string} hubUrl
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 */
async function hubCall(hubUrl, method, params) {
  const response = await fetch(hubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, ...(params ? { params } : {}) }),
  });
  return JSON.parse(await response.text());
}

/**
 * @param {{ out: string[], err: string[] }} session
 * @param {number} exitCode
 */
function finish(session, exitCode) {
  return { exitCode, stdout: session.out.join('\n'), stderr: session.err.join('\n') };
}
