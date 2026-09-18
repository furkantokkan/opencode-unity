// The per-launch `OPENCODE_CONFIG_CONTENT` (spec 8.4). It is merged last of all config sources, so it
// is where the complete, ordered permission rule sets live: the agent `.md` files carry prompt and
// sampling only, and a project file can therefore never reorder our rules by defining an agent.
//
// The same object is written to `<home>/projects/<id>/launch.json`, so a user can read exactly what a
// session ran with.
import { stringifyJson } from '../core/jsonc.js';
import { DEFAULT_AGENT, EDITOR_AGENT } from './render.js';

export const MCP_SERVER_ID = 'unityMCP';
/** OpenCode's own default is 5,000 ms, which a cold Editor refresh exceeds (OC `config/mcp.ts` L56). */
export const MCP_TIMEOUT_MS = 120000;
export const EDITOR_COMMAND_NAME = 'ue';
export const EDITOR_COMMAND_DESCRIPTION = 'Ask the Unity Editor check agent (console, refresh, EditMode tests)';
export const EDITOR_COMMAND_TEMPLATE = 'Editor check requested by the user: $ARGUMENTS';

/** @typedef {import('./permission-eval.js').PermissionBlock} PermissionBlock */

/**
 * @typedef {object} LaunchContentInput
 * @property {string} factsPath                  Absolute path of the project's `facts.md`.
 * @property {PermissionBlock} unityCodePermission
 * @property {PermissionBlock} [unityEditorPermission]  Required when the editor agent is enabled.
 * @property {boolean} [editorAgent]             False disables `unity-editor` instead of configuring it.
 * @property {string} [hubUrl]                   MCP for Unity hub URL; required when `editorAgent`.
 * @property {number} [mcpTimeoutMs]
 */

/**
 * @param {LaunchContentInput} input
 * @returns {Record<string, unknown>}
 */
export function buildLaunchContent({
  factsPath,
  unityCodePermission,
  unityEditorPermission,
  editorAgent = false,
  hubUrl,
  mcpTimeoutMs = MCP_TIMEOUT_MS,
}) {
  if (!factsPath) throw new TypeError('buildLaunchContent needs the absolute path of facts.md');
  if (editorAgent && !hubUrl) throw new TypeError('The editor agent needs the MCP for Unity hub URL');
  if (editorAgent && !unityEditorPermission) throw new TypeError('The editor agent needs its permission block');

  /** @type {Record<string, unknown>} */
  const content = {
    // A plain merge replaces arrays, so this replaces any earlier `instructions` (OC `config.ts` L46-52).
    instructions: [toPosixPath(factsPath)],
    agent: {
      [DEFAULT_AGENT]: { permission: unityCodePermission },
      [EDITOR_AGENT]: editorAgent ? { permission: unityEditorPermission } : { disable: true },
    },
  };
  if (editorAgent) {
    content.mcp = { [MCP_SERVER_ID]: { type: 'remote', url: hubUrl, enabled: true, timeout: mcpTimeoutMs } };
    content.command = {
      [EDITOR_COMMAND_NAME]: {
        description: EDITOR_COMMAND_DESCRIPTION,
        template: EDITOR_COMMAND_TEMPLATE,
        agent: EDITOR_AGENT,
        subtask: true,
      },
    };
  }
  return content;
}

/**
 * The value of `OPENCODE_CONFIG_CONTENT`: one line, because it travels through the environment.
 * @param {Record<string, unknown>} content
 * @returns {string}
 */
export function renderLaunchContentEnv(content) {
  return JSON.stringify(content);
}

/**
 * The `launch.json` a user can read; pretty-printed with a trailing newline like every other file we
 * write.
 * @param {Record<string, unknown>} content
 * @returns {string}
 */
export function renderLaunchContentFile(content) {
  return stringifyJson(content);
}

/**
 * Absolute paths reach OpenCode with forward slashes on every platform: it accepts them on Windows,
 * and it keeps the rendered JSON free of escape sequences that differ per platform.
 * @param {string} value
 * @returns {string}
 */
export function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}
