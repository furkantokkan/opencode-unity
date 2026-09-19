// Opt-in integration executable: OPENCODE_UNITY_TEST_OPENCODE must name the real binary.
// Uses no real Ollama, credentials, project, GPU or external HTTP endpoint.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSelftestLauncher } from '../../../src/selftest/launch.js';
import { runScenario, SELFTEST_SCENARIOS } from '../../../src/selftest/scenarios.js';
import { EXPECTED_CODE_TOOLS } from '../../../src/selftest/diagnostics.js';
import { checkToolNames, result } from '../../../src/selftest/capture-checks.js';
import { startMockServer } from '../../../src/selftest/mock-server.js';

const binary = process.env.OPENCODE_UNITY_TEST_OPENCODE;
assert.ok(binary, 'Set OPENCODE_UNITY_TEST_OPENCODE; this contract never silently skips.');
const root = process.env.OPENCODE_UNITY_TEST_SOURCE
  ? pathToFileURL(`${path.resolve(process.env.OPENCODE_UNITY_TEST_SOURCE)}${path.sep}`)
  : new URL('../../../', import.meta.url);
const { DEFAULT_CONFIG, DEFAULT_PROJECT_SETTINGS } = await import(new URL('src/core/config.js', root));
const { renderProfileFiles } = await import(new URL('src/install/profile.js', root));
const { buildNetworkPolicy, NETWORK_ENV, NETWORK_BASH_ENV } = await import(new URL('src/network/render.js', root));
const { CLI_VERSION } = await import(new URL('src/cli/version.js', root));
const marker = 'OCU_NETWORK_FIXTURE_RESPONSE';
const server = await startMockServer({ handlers: [{ name: 'fixture', handle: (request, response) => {
  if (request.path !== '/fixture') return false;
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end(marker);
  return true;
} }] });
try {
  const launcher = { binary, cliVersion: CLI_VERSION, renderFiles: renderProfileFiles };
  const disabled = await runScenario(SELFTEST_SCENARIOS[0], {
    launch: createSelftestLauncher(launcher), expectations: { codeTools: EXPECTED_CODE_TOOLS }, attempts: 1, timeoutMs: 60000,
  });
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  const config = structuredClone(DEFAULT_CONFIG);
  config.network.enabled = true;
  config.network.profile = 'standard';
  const policy = buildNetworkPolicy({ config, settings: DEFAULT_PROJECT_SETTINGS });
  const tools = [...EXPECTED_CODE_TOOLS, 'unitynet'];
  const enabled = await runScenario({
    id: 'network', contract: 'network', title: 'native unitynet execution against a loopback fixture',
    guard: { nvidiaSmi: 'normal', modelLoaded: true },
    runs: [{ agent: 'unity-code', prompt: 'Read the fixture once, then finish.' }],
    turns: () => [{ toolCalls: [{ name: 'unitynet', arguments: { url: `${server.url}/fixture`, method: 'GET', body: '' } }] }, { text: 'DONE' }],
    verify: (observation) => [
      checkToolNames(observation.chats[0]?.body ?? {}, tools),
      result('one-http-request', server.requests.filter((request) => request.path === '/fixture').length === 1, 'exactly one request reaches the loopback fixture'),
      result('tool-result-returned', JSON.stringify(observation.chats[1]?.body.messages).includes(marker), 'the HTTP response is returned to the next model turn'),
      result('run-succeeded', observation.runs[0]?.exitCode === 0, 'OpenCode exits successfully'),
    ],
  }, {
    launch: createSelftestLauncher({ ...launcher, configureLaunch: ({ env, content }) => {
      env[NETWORK_ENV] = JSON.stringify(policy.policy);
      env[NETWORK_BASH_ENV] = policy.bash;
      content.agent['unity-code'].permission.unitynet = policy.permission;
    } }),
    expectations: { codeTools: tools }, attempts: 1, timeoutMs: 60000,
  });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  console.log(JSON.stringify({ ok: true, scope: 'real OpenCode; mock model; loopback HTTP only', disabled, enabled }, null, 2));
} finally {
  await server.close();
}
