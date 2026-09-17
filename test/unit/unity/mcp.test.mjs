import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import {
  DEFAULT_HUB_URL,
  detectHubUrl,
  detectMcpForUnity,
  getExpectedInstanceId,
  getOpenCodeUserConfigPath,
  isLoopbackUrl,
  MCP_PACKAGE_ID,
  MCP_TESTED_VERSION,
} from '../../../src/unity/mcp.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\example' : '/home/example';
const ROOT = path.join(process.platform === 'win32' ? 'C:\\mcp-tests' : '/mcp-tests', 'SampleGame');

/**
 * @param {string} id
 * @param {string | null} version
 */
const packageOf = (id, version) => ({ id, version, reference: version, direct: true, embedded: false, folder: null });

test('MCP for Unity is detected with its version', () => {
  assert.deepEqual(detectMcpForUnity([packageOf(MCP_PACKAGE_ID, MCP_TESTED_VERSION)]), {
    present: true,
    version: '10.1.0',
    testedVersion: true,
    folder: null,
  });
  assert.equal(detectMcpForUnity([packageOf(MCP_PACKAGE_ID, '9.0.0')]).testedVersion, false);
  assert.deepEqual(detectMcpForUnity([]), { present: false, version: null, testedVersion: false, folder: null });
});

test('the OpenCode user config path follows XDG_CONFIG_HOME, then the user profile', () => {
  assert.equal(getOpenCodeUserConfigPath({ XDG_CONFIG_HOME: path.join(HOME, '.config') }), path.join(HOME, '.config', 'opencode', 'opencode.json'));
  assert.equal(getOpenCodeUserConfigPath({ USERPROFILE: HOME }), path.join(HOME, '.config', 'opencode', 'opencode.json'));
  assert.equal(getOpenCodeUserConfigPath({ HOME }), path.join(HOME, '.config', 'opencode', 'opencode.json'));
  assert.equal(getOpenCodeUserConfigPath({}), null);
});

test('the hub URL is read from the user config, read-only', () => {
  const configPath = path.join(HOME, '.config', 'opencode', 'opencode.json');
  const view = createMemoryFsView({
    [configPath]: JSON.stringify({ mcp: { unityMCP: { type: 'remote', url: 'http://127.0.0.1:8090/mcp', enabled: true } } }),
  });
  const result = detectHubUrl(view, { env: { USERPROFILE: HOME } });
  assert.deepEqual(result, { url: 'http://127.0.0.1:8090/mcp', source: 'opencode-config', configPath, loopback: true });
});

test('without a config entry the package default is used', () => {
  const configPath = path.join(HOME, '.config', 'opencode', 'opencode.json');
  const missing = detectHubUrl(createMemoryFsView({}), { env: { USERPROFILE: HOME } });
  assert.equal(missing.url, DEFAULT_HUB_URL);
  assert.equal(missing.source, 'package-default');
  const local = createMemoryFsView({ [configPath]: JSON.stringify({ mcp: { unityMCP: { type: 'local', command: ['uv', 'run'] } } }) });
  assert.equal(detectHubUrl(local, { env: { USERPROFILE: HOME } }).source, 'package-default');
  const broken = createMemoryFsView({ [configPath]: '{ "mcp": ' });
  assert.equal(detectHubUrl(broken, { env: { USERPROFILE: HOME } }).source, 'package-default');
  assert.equal(detectHubUrl(createMemoryFsView({}), {}).configPath, null);
});

test('a non-loopback hub URL is flagged', () => {
  const configPath = path.join(HOME, '.config', 'opencode', 'opencode.json');
  const view = createMemoryFsView({ [configPath]: JSON.stringify({ mcp: { unityMCP: { url: 'http://192.0.2.10:8080/mcp' } } }) });
  assert.equal(detectHubUrl(view, { env: { USERPROFILE: HOME } }).loopback, false);
  assert.equal(isLoopbackUrl('http://localhost:8080/mcp'), true);
  assert.equal(isLoopbackUrl('not a url'), false);
});

test('the expected instance id is the project name and a SHA-1 of the data path', () => {
  const instance = getExpectedInstanceId(ROOT);
  const expectedHash = crypto.createHash('sha1').update(instance.dataPath, 'utf8').digest('hex').slice(0, 16);
  assert.equal(instance.name, 'SampleGame');
  assert.equal(instance.dataPath.endsWith('/SampleGame/Assets'), true);
  assert.equal(instance.dataPath.includes('\\'), false);
  assert.equal(instance.id, `SampleGame@${expectedHash}`);
  assert.match(instance.id, /^SampleGame@[0-9a-f]{16}$/);
});
