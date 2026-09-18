// The editor-check agent resolution (spec 11, 8.4). The cases that matter are the ones where the agent
// must NOT be configured: no package, no hub URL, a URL nobody confirmed. M0 spikes L and M are still
// manual-pending, so their fallbacks are asserted here rather than assumed away.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EDITOR_TOOLS, MCP_TOOL_PREFIX } from '../../../plugin/opencode-unity-lib/mcp-args.js';
import { buildLaunchContent } from '../../../src/opencode/content.js';
import {
  EDITOR_AGENT,
  EDITOR_READ_ONLY_TOOL_IDS,
  EDITOR_STATUS,
  EDITOR_TOOL_IDS,
  EDITOR_TRUSTED_TOOL_IDS,
  INSTANCE_CHECK_MODE,
  buildEditorLaunchInput,
  buildEditorLocalRecord,
  isConfirmedHub,
  readInstanceName,
  requireEditorAgent,
  resolveEditorAgent,
  resolveRecordedEditorAgent,
} from '../../../src/opencode/editor.js';
import { EDITOR_READ_ONLY_TOOLS, EDITOR_TRUSTED_TOOLS } from '../../../src/opencode/render.js';

const HUB_URL = 'http://127.0.0.1:8080/mcp';
const FACTS_PATH = '/home/user/.local/share/opencode-unity/projects/sample-1a2b3c4d/facts.md';
const INSTANCE_ID = 'SampleProject@0123456789abcdef';
const PRESENT = { present: true, version: '10.1.0', testedVersion: true };
const CONFIRMED = { hubUrl: HUB_URL, hubUrlSource: 'opencode-config', hubUrlConfirmed: true, expectedInstanceId: INSTANCE_ID };
const ENABLED = { enabled: true };

/**
 * @param {object} [overrides]
 * @returns {import('../../../src/opencode/editor.js').EditorAgentState}
 */
function resolve(overrides = {}) {
  return resolveEditorAgent({ mcp: PRESENT, local: CONFIRMED, settings: ENABLED, ...overrides });
}

describe('editor agent: when it stays off', () => {
  it('is off when it is asked about nothing at all', () => {
    const state = resolveEditorAgent();
    assert.equal(state.enabled, false);
    assert.equal(state.reason, 'disabled');
    assert.deepEqual(state.instanceCheck, { mode: INSTANCE_CHECK_MODE, expectedName: null, expectedId: null });
  });

  it('is off until the project turns it on', () => {
    const state = resolve({ settings: {} });
    assert.equal(state.enabled, false);
    assert.equal(state.reason, 'disabled');
    assert.equal(state.hubUrl, null);
    assert.match(state.warnings[0], /init --editor/);
  });

  it('needs MCP for Unity in the Unity project', () => {
    for (const mcp of [{}, { present: false }, { present: 'yes' }]) {
      const state = resolve({ mcp });
      assert.equal(state.enabled, false, JSON.stringify(mcp));
      assert.equal(state.reason, 'package_missing');
    }
  });

  it('refuses to guess a hub URL (spike M fallback)', () => {
    for (const hubUrl of [undefined, null, '', '   ', 0]) {
      const state = resolve({ local: { ...CONFIRMED, hubUrl } });
      assert.equal(state.reason, 'hub_missing', String(hubUrl));
      assert.match(state.warnings[0], /MCP for Unity window/);
    }
  });

  it('refuses a recorded value that is not an http URL', () => {
    for (const hubUrl of ['127.0.0.1:8080/mcp', 'not a url', 'ftp://127.0.0.1/mcp', 'file:///mcp', 'javascript:1']) {
      assert.equal(resolve({ local: { ...CONFIRMED, hubUrl } }).reason, 'hub_invalid', hubUrl);
    }
  });

  it('refuses a derived URL the user never confirmed (spec 11.1)', () => {
    for (const local of [
      { ...CONFIRMED, hubUrlConfirmed: false },
      { ...CONFIRMED, hubUrlConfirmed: undefined },
      { hubUrl: HUB_URL, hubUrlSource: 'package-default' },
    ]) {
      const state = resolve({ local });
      assert.equal(state.reason, 'hub_unconfirmed');
      assert.equal(state.enabled, false);
    }
  });

  it('keeps the instance facts even while it is off, so the caller can explain why', () => {
    const state = resolve({ settings: {} });
    assert.deepEqual(state.instanceCheck, { mode: INSTANCE_CHECK_MODE, expectedName: 'SampleProject', expectedId: INSTANCE_ID });
    assert.deepEqual([...state.toolIds], [...EDITOR_TOOL_IDS]);
  });
});

describe('editor agent: when it is on', () => {
  it('trims the recorded URL, so the value that was validated is the value that is rendered', () => {
    assert.equal(resolve({ local: { ...CONFIRMED, hubUrl: `  ${HUB_URL}\n` } }).hubUrl, HUB_URL);
  });

  it('carries the confirmed hub URL and stays labelled experimental', () => {
    const state = resolve();
    assert.equal(state.enabled, true);
    assert.equal(state.reason, null);
    assert.equal(state.hubUrl, HUB_URL);
    assert.equal(state.status, EDITOR_STATUS);
    assert.equal(EDITOR_STATUS, 'experimental');
    assert.match(state.warnings[0], /experimental/);
    assert.match(state.warnings[0], /refresh_unity|run_tests/);
  });

  it('says out loud that the instance check compares names only (spike L fallback)', () => {
    const state = resolve();
    assert.equal(state.instanceCheck.mode, 'name-only');
    assert.ok(state.warnings.some((line) => /name only/.test(line)), state.warnings.join(' | '));
  });

  it('derives the expected name from the instance id when no project name was recorded', () => {
    assert.equal(resolve({ local: { ...CONFIRMED, projectName: 'Renamed' } }).instanceCheck.expectedName, 'Renamed');
    assert.equal(resolve().instanceCheck.expectedName, 'SampleProject');
  });

  it('warns about an untested MCP for Unity version, named or not', () => {
    const named = resolve({ mcp: { present: true, version: '10.2.0', testedVersion: false } });
    assert.ok(named.warnings.some((line) => line.includes('10.2.0')), named.warnings.join(' | '));
    const unnamed = resolve({ mcp: { present: true, version: null, testedVersion: false } });
    assert.ok(unnamed.warnings.some((line) => /unknown version/.test(line)), unnamed.warnings.join(' | '));
  });

  it('warns when the hub is not on this machine, and stays quiet when it is', () => {
    const remote = resolve({ local: { ...CONFIRMED, hubUrl: 'http://build-host.invalid:8080/mcp' } });
    assert.ok(remote.warnings.some((line) => /loopback/.test(line)), remote.warnings.join(' | '));
    assert.equal(resolve().warnings.some((line) => /loopback/.test(line)), false);
    assert.equal(resolve({ local: { ...CONFIRMED, hubUrl: 'http://localhost:8080/mcp' } }).warnings.some((line) => /loopback/.test(line)), false);
  });

  it('passes the project trust and PlayMode choices through untouched', () => {
    const state = resolve({ settings: { enabled: true, trust: true, allowPlayMode: true } });
    assert.equal(state.trust, true);
    assert.equal(state.allowPlayMode, true);
    const strict = resolve({ settings: { enabled: true, trust: 'yes', allowPlayMode: 1 } });
    assert.equal(strict.trust, false);
    assert.equal(strict.allowPlayMode, false);
  });
});

describe('editor agent: the refusal path', () => {
  it('returns the state unchanged when the agent is available', () => {
    const state = resolve();
    assert.equal(requireEditorAgent(state), state);
  });

  it('stops with a usage error that names the reason', () => {
    /** @type {Array<[object, string]>} */
    const cases = [
      [{ settings: {} }, 'disabled'],
      [{ mcp: { present: false } }, 'package_missing'],
      [{ local: { ...CONFIRMED, hubUrl: '' } }, 'hub_missing'],
      [{ local: { ...CONFIRMED, hubUrl: 'not a url' } }, 'hub_invalid'],
      [{ local: { ...CONFIRMED, hubUrlConfirmed: false } }, 'hub_unconfirmed'],
    ];
    for (const [overrides, reason] of cases) {
      const state = resolve(overrides);
      /** @type {any} */
      let error = null;
      try {
        requireEditorAgent(state);
      } catch (thrown) {
        error = thrown;
      }
      assert.ok(error instanceof Error, reason);
      assert.equal(error.name, 'CliError', reason);
      assert.equal(error.exitCode, 1, reason);
      assert.equal(error.code, `editor_${reason}`, reason);
      assert.deepEqual(error.data, { agent: EDITOR_AGENT, reason, status: EDITOR_STATUS });
      assert.ok(error.message.length > 0, reason);
      assert.equal(error.hint, state.warnings[0], reason);
    }
  });

  it('carries no hint when there is nothing useful to add', () => {
    const state = resolve({ mcp: { present: false }, settings: {} });
    assert.deepEqual(state.warnings, []);
    assert.throws(() => requireEditorAgent(state), (/** @type {any} */ error) => error.hint === undefined && error.code === 'editor_disabled');
  });
});

describe('editor agent: what a launch renders', () => {
  it('renders nothing but the disabled agent when it is off', () => {
    const input = buildEditorLaunchInput(resolve({ settings: {} }));
    assert.deepEqual(input, { editorAgent: false });
    const content = buildLaunchContent({ factsPath: FACTS_PATH, unityCodePermission: { '*_*': 'deny' }, ...input });
    assert.deepEqual(content.agent[EDITOR_AGENT], { disable: true });
    assert.equal(Object.hasOwn(content, 'mcp'), false);
    assert.equal(Object.hasOwn(content, 'command'), false);
  });

  it('renders the server, the command and the ordered permission block when it is on', () => {
    const input = buildEditorLaunchInput(resolve());
    const content = buildLaunchContent({ factsPath: FACTS_PATH, unityCodePermission: { '*_*': 'deny' }, ...input });
    assert.equal(content.mcp.unityMCP.url, HUB_URL);
    assert.equal(content.command.ue.agent, EDITOR_AGENT);
    const permission = content.agent[EDITOR_AGENT].permission;
    assert.deepEqual(Object.keys(permission), ['*', ...EDITOR_TOOL_IDS, 'read']);
    assert.equal(permission['*'], 'deny');
    for (const tool of EDITOR_READ_ONLY_TOOL_IDS) assert.equal(permission[tool], 'allow', tool);
    for (const tool of EDITOR_TRUSTED_TOOL_IDS) assert.equal(permission[tool], 'ask', tool);
  });

  it('lets a trusted project skip the ask for the two Editor-changing tools', () => {
    const input = buildEditorLaunchInput(resolve({ settings: { enabled: true, trust: true } }));
    const permission = /** @type {Record<string, string>} */ (input.unityEditorPermission);
    for (const tool of EDITOR_TRUSTED_TOOL_IDS) assert.equal(permission[tool], 'allow', tool);
  });

  it('writes the machine-local editor record init stores and the plugin reads back', () => {
    assert.deepEqual(buildEditorLocalRecord(resolve({ settings: { enabled: true, allowPlayMode: true } })), {
      enabled: true,
      status: EDITOR_STATUS,
      hubUrl: HUB_URL,
      hubUrlConfirmed: true,
      trust: false,
      allowPlayMode: true,
      instanceCheck: INSTANCE_CHECK_MODE,
      expectedInstanceId: INSTANCE_ID,
    });
    const off = buildEditorLocalRecord(resolve({ settings: {} }));
    assert.equal(off.enabled, false);
    assert.equal(off.hubUrl, null);
    assert.equal(off.hubUrlConfirmed, false);
  });
});

describe('editor agent: one tool list', () => {
  it('derives the rendered tool ids from the policy list, so the two cannot drift', () => {
    assert.deepEqual([...EDITOR_TOOL_IDS], EDITOR_TOOLS.map((name) => `${MCP_TOOL_PREFIX}${name}`));
    assert.deepEqual([...EDITOR_READ_ONLY_TOOL_IDS], [...EDITOR_READ_ONLY_TOOLS]);
    assert.deepEqual([...EDITOR_TRUSTED_TOOL_IDS], [...EDITOR_TRUSTED_TOOLS]);
  });

  it('reads the project name out of an instance id, including a name that holds an @', () => {
    assert.equal(readInstanceName(INSTANCE_ID), 'SampleProject');
    assert.equal(readInstanceName('Sample@Project@0123456789abcdef'), 'Sample@Project');
    assert.equal(readInstanceName('SampleProject'), 'SampleProject');
    for (const value of [null, undefined, '', '@0123456789abcdef', 42]) assert.equal(readInstanceName(value), null, String(value));
  });
});

describe('editor agent: the recorded state start reads', () => {
  const LOCAL = { hubUrl: HUB_URL, hubUrlSource: 'package-default', expectedInstanceId: INSTANCE_ID };

  it('counts a confirmation only for the URL it was given for', () => {
    assert.equal(isConfirmedHub({ hubUrl: HUB_URL, hubUrlConfirmed: true }, HUB_URL), true);
    assert.equal(isConfirmedHub({ hubUrl: `${HUB_URL} `, hubUrlConfirmed: true }, HUB_URL), true);
    assert.equal(isConfirmedHub({ hubUrl: HUB_URL, hubUrlConfirmed: true }, 'http://127.0.0.1:8090/mcp'), false);
    assert.equal(isConfirmedHub({ hubUrl: HUB_URL, hubUrlConfirmed: 'yes' }, HUB_URL), false);
    for (const record of [null, undefined, {}, 'confirmed', { hubUrlConfirmed: true }]) assert.equal(isConfirmedHub(record, HUB_URL), false);
    assert.equal(isConfirmedHub({ hubUrl: HUB_URL, hubUrlConfirmed: true }, null), false);
  });

  it('enables the agent from project.json, local.json and the choice, and stays off for anything missing', () => {
    const record = buildEditorLocalRecord(resolveEditorAgent({ mcp: PRESENT, local: CONFIRMED, settings: ENABLED }));
    const on = resolveRecordedEditorAgent({ mcp: PRESENT, local: { ...LOCAL, editor: record }, settings: ENABLED });
    assert.equal(on.enabled, true);
    assert.equal(on.hubUrl, HUB_URL);
    assert.equal(on.instanceCheck.expectedName, 'SampleProject');

    assert.equal(resolveRecordedEditorAgent({ mcp: PRESENT, local: LOCAL, settings: ENABLED }).reason, 'hub_unconfirmed');
    assert.equal(resolveRecordedEditorAgent({ mcp: null, local: { ...LOCAL, editor: record }, settings: ENABLED }).reason, 'package_missing');
    assert.equal(resolveRecordedEditorAgent({ mcp: PRESENT, local: null, settings: ENABLED }).reason, 'hub_missing');
    assert.equal(resolveRecordedEditorAgent({ mcp: PRESENT, local: { ...LOCAL, editor: record } }).reason, 'disabled');
  });
});
