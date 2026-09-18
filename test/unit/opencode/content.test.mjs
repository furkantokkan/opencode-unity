// Spec 8.4: the per-launch `OPENCODE_CONFIG_CONTENT`. It is merged last, so it is the only place the
// complete rule order is defined; a golden byte comparison is what stops a refactor from quietly
// reordering it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { catchError } from '../../helpers/catch-error.mjs';
import {
  EDITOR_COMMAND_DESCRIPTION,
  EDITOR_COMMAND_NAME,
  EDITOR_COMMAND_TEMPLATE,
  MCP_SERVER_ID,
  MCP_TIMEOUT_MS,
  buildLaunchContent,
  renderLaunchContentEnv,
  renderLaunchContentFile,
  toPosixPath,
} from '../../../src/opencode/content.js';
import { buildUnityCodePermission, buildUnityEditorPermission } from '../../../src/opencode/render.js';
import { looksRetryable } from '../../../src/opencode/retry-safety.js';

const WINDOWS_FACTS = 'C:\\opencode-unity\\projects\\sample-1a2b3c4d\\facts.md';
const POSIX_FACTS = '/home/user/.local/share/opencode-unity/projects/sample-1a2b3c4d/facts.md';
const HUB_URL = 'http://127.0.0.1:8081/mcp';

/**
 * @param {string} name
 * @returns {string}
 */
function golden(name) {
  return fs.readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
}

/**
 * @param {object} [overrides]
 * @returns {Record<string, unknown>}
 */
function editorContent(overrides = {}) {
  return buildLaunchContent({
    factsPath: WINDOWS_FACTS,
    unityCodePermission: buildUnityCodePermission({ vcsKind: 'git', csprojNames: ['Assembly-CSharp.csproj', 'Game.Runtime.csproj'] }),
    unityEditorPermission: buildUnityEditorPermission({ trust: false }),
    editorAgent: true,
    hubUrl: HUB_URL,
    ...overrides,
  });
}

describe('opencode/content golden', () => {
  it('renders the editor launch content byte for byte', () => {
    assert.equal(renderLaunchContentFile(editorContent()), golden('launch-content.json'));
  });

  it('renders the launch content without the editor agent byte for byte', () => {
    const content = buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: buildUnityCodePermission() });
    assert.equal(renderLaunchContentFile(content), golden('launch-content-minimal.json'));
  });

  it('puts one line in the environment and the readable copy in launch.json', () => {
    const content = editorContent();
    const env = renderLaunchContentEnv(content);
    assert.ok(!env.includes('\n'));
    assert.deepEqual(JSON.parse(env), JSON.parse(renderLaunchContentFile(content)));
    assert.ok(renderLaunchContentFile(content).endsWith('}\n'));
  });
});

describe('opencode/content shape', () => {
  it('replaces the instructions array with the project facts', () => {
    const content = buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: buildUnityCodePermission() });
    assert.deepEqual(content.instructions, [POSIX_FACTS]);
  });

  it('sends absolute paths with forward slashes on every platform', () => {
    const content = buildLaunchContent({ factsPath: WINDOWS_FACTS, unityCodePermission: buildUnityCodePermission() });
    assert.deepEqual(content.instructions, ['C:/opencode-unity/projects/sample-1a2b3c4d/facts.md']);
    assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
    assert.equal(toPosixPath('a/b/c'), 'a/b/c');
    // No escape sequence reaches the environment variable, on either platform.
    assert.ok(!renderLaunchContentEnv(content).includes('\\\\'));
  });

  it('disables the editor agent instead of configuring it when the project did not enable it', () => {
    const content = buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: buildUnityCodePermission() });
    const agents = /** @type {Record<string, any>} */ (content.agent);
    assert.deepEqual(agents['unity-editor'], { disable: true });
    assert.equal(content.mcp, undefined, 'no MCP server without the editor agent');
    assert.equal(content.command, undefined, 'no /ue command without the editor agent');
    assert.ok(agents['unity-code'].permission);
  });

  it('configures exactly one MCP server and the /ue command when the editor agent is on', () => {
    const content = editorContent();
    const mcp = /** @type {Record<string, any>} */ (content.mcp);
    assert.deepEqual(Object.keys(mcp), [MCP_SERVER_ID]);
    assert.deepEqual(mcp[MCP_SERVER_ID], { type: 'remote', url: HUB_URL, enabled: true, timeout: MCP_TIMEOUT_MS });
    // OpenCode's default is 5,000 ms, which a cold Editor refresh exceeds.
    assert.ok(MCP_TIMEOUT_MS > 5000);
    const command = /** @type {Record<string, any>} */ (content.command);
    assert.deepEqual(Object.keys(command), [EDITOR_COMMAND_NAME]);
    assert.deepEqual(command[EDITOR_COMMAND_NAME], {
      description: EDITOR_COMMAND_DESCRIPTION,
      template: EDITOR_COMMAND_TEMPLATE,
      agent: 'unity-editor',
      subtask: true,
    });
  });

  it('honours a project timeout override', () => {
    const content = editorContent({ mcpTimeoutMs: 90000 });
    assert.equal(/** @type {Record<string, any>} */ (content.mcp)[MCP_SERVER_ID].timeout, 90000);
  });

  it('keeps the agent permission blocks in the order the renderer produced', () => {
    const permission = buildUnityCodePermission({ vcsKind: 'git' });
    const content = buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: permission });
    const rendered = /** @type {Record<string, any>} */ (content.agent)['unity-code'].permission;
    assert.deepEqual(Object.keys(rendered), Object.keys(permission));
    assert.equal(Object.keys(JSON.parse(renderLaunchContentEnv(content)).agent['unity-code'].permission)[0], '*_*');
  });
});

describe('opencode/content refusals', () => {
  it('refuses to render without the facts path', () => {
    assert.match(catchError(() => buildLaunchContent({ factsPath: '', unityCodePermission: {} })).message, /facts\.md/);
  });

  it('refuses to enable the editor agent without a hub URL or its rules', () => {
    assert.match(catchError(() => buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: {}, editorAgent: true })).message, /hub URL/);
    assert.match(
      catchError(() => buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: {}, editorAgent: true, hubUrl: HUB_URL })).message,
      /permission block/,
    );
  });

  it('emits no message OpenCode would read as a retryable failure', () => {
    const messages = [
      catchError(() => buildLaunchContent({ factsPath: '', unityCodePermission: {} })).message,
      catchError(() => buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: {}, editorAgent: true })).message,
      catchError(() => buildLaunchContent({ factsPath: POSIX_FACTS, unityCodePermission: {}, editorAgent: true, hubUrl: HUB_URL })).message,
    ];
    for (const message of messages) assert.ok(!looksRetryable(message), message);
  });
});
