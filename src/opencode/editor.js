// The Unity editor-check agent (spec 11), which is the one place that decides whether a launch gets
// `unity-editor` at all. `init` asks the questions, `start` renders the answer, and both call this
// module so a project cannot end up with an MCP server configured and no agent, or an agent and no hub.
//
// Three properties this module exists to keep:
// - **The hub is never guessed.** Spec 11.1 has the user confirm the URL. M0 spike M — which endpoint
//   path the hub serves when no configurator entry exists — is still manual-pending, so its documented
//   fallback holds: the user pastes the URL from the MCP for Unity window, and a URL nobody confirmed
//   disables the agent instead of being tried.
// - **The instance check is honest.** M0 spike L — whether the derived instance id matches on Windows —
//   is manual-pending too, so its fallback holds: names are compared, the derived id is carried for
//   diagnostics only, and the residual risk (one connected Editor belonging to another project) is a
//   warning rather than silence (spec 11.4).
// - **The label stays experimental.** `refresh_unity` imports and compiles and `run_tests` changes
//   Editor state, so nothing here calls the agent read-only.
import { CliError, EXIT } from '../cli/exit-codes.js';
import { EDITOR_TOOLS, MCP_TOOL_PREFIX, READ_ONLY_TOOLS, TRUSTED_TOOLS } from '../../plugin/opencode-unity-lib/mcp-args.js';
import { MCP_PACKAGE_ID, isLoopbackUrl } from '../unity/mcp.js';
import { EDITOR_AGENT, buildUnityEditorPermission } from './render.js';

export { EDITOR_AGENT, MCP_PACKAGE_ID };

/** Spec 11.4: not read-only, and measured only at 32K so far. */
export const EDITOR_STATUS = 'experimental';

/** M0 spike L fallback: compare the instance name and warn (spec 24.3). */
export const INSTANCE_CHECK_MODE = 'name-only';

/** Tool ids as OpenCode names them, derived from the policy's list so the two cannot drift. */
export const EDITOR_READ_ONLY_TOOL_IDS = Object.freeze(READ_ONLY_TOOLS.map(toToolId));
export const EDITOR_TRUSTED_TOOL_IDS = Object.freeze(TRUSTED_TOOLS.map(toToolId));
export const EDITOR_TOOL_IDS = Object.freeze(EDITOR_TOOLS.map(toToolId));

/**
 * @typedef {'disabled' | 'package_missing' | 'hub_missing' | 'hub_unconfirmed' | 'hub_invalid'} EditorDisabledReason
 */

/**
 * @typedef {object} EditorSettings
 * @property {boolean} [enabled]        `config.projects.<id>.editor.enabled` (spec 6.2).
 * @property {boolean} [trust]          True lets `refresh_unity` and `run_tests` run without an ask.
 * @property {boolean} [allowPlayMode]  True lets `run_tests` run PlayMode; the policy denies it otherwise.
 */

/**
 * @typedef {object} EditorLocalFacts
 * @property {string | null} [hubUrl]              From `local.json`; machine data, never in the project (P6).
 * @property {string | null} [hubUrlSource]        `opencode-config` when the configurator wrote it, `package-default` otherwise.
 * @property {boolean} [hubUrlConfirmed]           True once the user confirmed the URL (spec 11.1).
 * @property {string | null} [expectedInstanceId]  `<name>@<16 hex>`, carried for diagnostics only.
 * @property {string | null} [projectName]         The Unity project folder name the agent compares against.
 */

/**
 * @typedef {object} EditorMcpFacts
 * @property {boolean} [present]
 * @property {string | null} [version]
 * @property {boolean} [testedVersion]
 */

/**
 * @typedef {object} InstanceCheck
 * @property {'name-only'} mode
 * @property {string | null} expectedName
 * @property {string | null} expectedId
 */

/**
 * @typedef {object} EditorAgentState
 * @property {boolean} enabled
 * @property {'experimental'} status
 * @property {EditorDisabledReason | null} reason   Why it is off; null when it is on.
 * @property {string | null} hubUrl
 * @property {boolean} trust
 * @property {boolean} allowPlayMode
 * @property {InstanceCheck} instanceCheck
 * @property {readonly string[]} toolIds
 * @property {string[]} warnings                    Printed by the caller; never written into the project.
 */

/**
 * @param {object} [input]
 * @param {EditorMcpFacts} [input.mcp]            `mcpForUnity` from `project.json`.
 * @param {EditorLocalFacts} [input.local]        The editor fields of `local.json`.
 * @param {EditorSettings} [input.settings]       `config.projects.<id>.editor`.
 * @returns {EditorAgentState}
 */
export function resolveEditorAgent({ mcp = {}, local = {}, settings = {} } = {}) {
  // One normalized URL: a value that is validated trimmed and then rendered untrimmed is a value that
  // was never validated.
  const hubUrl = typeof local.hubUrl === 'string' ? local.hubUrl.trim() : '';
  const instanceCheck = /** @type {InstanceCheck} */ ({
    mode: INSTANCE_CHECK_MODE,
    expectedName: local.projectName ?? readInstanceName(local.expectedInstanceId),
    expectedId: local.expectedInstanceId ?? null,
  });
  const base = {
    status: /** @type {'experimental'} */ (EDITOR_STATUS),
    hubUrl: null,
    trust: settings.trust === true,
    allowPlayMode: settings.allowPlayMode === true,
    instanceCheck,
    toolIds: EDITOR_TOOL_IDS,
  };
  const reason = findDisabledReason({ mcp, local, settings, hubUrl });
  if (reason) return { ...base, enabled: false, reason, warnings: describeDisabled(reason, { mcp }) };

  /** @type {string[]} */
  const warnings = [`The editor agent is ${EDITOR_STATUS}: refresh_unity imports and compiles, and run_tests changes Editor state.`];
  warnings.push('The connected Editor is matched by name only, so a single Editor open on another project would pass the check.');
  if (mcp.testedVersion === false) {
    warnings.push(`MCP for Unity ${mcp.version ?? 'of an unknown version'} is not the tested version, so tool names and arguments may differ.`);
  }
  if (!isLoopbackUrl(hubUrl)) warnings.push('The hub URL is not a loopback address, so editor checks leave this machine.');
  return { ...base, enabled: true, reason: null, hubUrl, warnings };
}

/**
 * @param {{ mcp: EditorMcpFacts, local: EditorLocalFacts, settings: EditorSettings, hubUrl: string }} input
 * @returns {EditorDisabledReason | null}
 */
function findDisabledReason({ mcp, local, settings, hubUrl }) {
  if (settings.enabled !== true) return 'disabled';
  if (mcp.present !== true) return 'package_missing';
  if (hubUrl.length === 0) return 'hub_missing';
  if (!isHttpUrl(hubUrl)) return 'hub_invalid';
  // Spike M is manual-pending, so a URL the user has not confirmed is not tried (spec 24.3).
  if (local.hubUrlConfirmed !== true) return 'hub_unconfirmed';
  return null;
}

/**
 * @param {EditorDisabledReason} reason
 * @param {{ mcp: EditorMcpFacts }} input
 * @returns {string[]}
 */
function describeDisabled(reason, { mcp }) {
  switch (reason) {
    case 'disabled':
      return mcp.present === true ? ['MCP for Unity is installed; `init --editor` turns the editor agent on for this project.'] : [];
    case 'package_missing':
      return [`The editor agent needs the ${MCP_PACKAGE_ID} package in the Unity project.`];
    case 'hub_missing':
      return ['No MCP for Unity hub URL is recorded for this project; copy it from the MCP for Unity window and run `init --editor`.'];
    case 'hub_invalid':
      return ['The recorded hub URL is not an http or https URL; copy it again from the MCP for Unity window.'];
    default:
      return ['The hub URL was derived, not confirmed; run `init --editor` and confirm the URL from the MCP for Unity window.'];
  }
}

/**
 * The refusal path: `start --agent unity-editor` and `/ue` have nowhere to send a tool call when the
 * hub is absent, so they stop with a usage error instead of launching an agent that cannot work.
 * @param {EditorAgentState} state
 * @returns {EditorAgentState}
 */
export function requireEditorAgent(state) {
  if (state.enabled) return state;
  const reason = state.reason ?? 'disabled';
  throw new CliError(REFUSALS[reason], {
    exitCode: EXIT.USAGE,
    code: `editor_${reason}`,
    data: { agent: EDITOR_AGENT, reason, status: state.status },
    ...(state.warnings[0] ? { hint: state.warnings[0] } : {}),
  });
}

/** @type {Record<EditorDisabledReason, string>} */
const REFUSALS = {
  disabled: 'The editor agent is not enabled for this project',
  package_missing: 'MCP for Unity is not installed in this Unity project',
  hub_missing: 'No MCP for Unity hub URL is recorded for this project',
  hub_invalid: 'The recorded MCP for Unity hub URL is not usable',
  hub_unconfirmed: 'The MCP for Unity hub URL has not been confirmed',
};

/**
 * The editor half of the per-launch content (spec 8.4), in the shape `buildLaunchContent` takes. A
 * disabled agent renders `{ disable: true }` there, so the MCP server and the `/ue` command are never
 * configured without it.
 * @param {EditorAgentState} state
 * @returns {{ editorAgent: boolean, hubUrl?: string, unityEditorPermission?: import('./permission-eval.js').PermissionBlock }}
 */
export function buildEditorLaunchInput(state) {
  if (!state.enabled) return { editorAgent: false };
  return {
    editorAgent: true,
    hubUrl: /** @type {string} */ (state.hubUrl),
    unityEditorPermission: buildUnityEditorPermission({ trust: state.trust }),
  };
}

/**
 * The editor fields `init` writes into `local.json` and `start` and the plugin read back. Machine data
 * only lives here, never in the project (P6).
 * @param {EditorAgentState} state
 * @returns {Record<string, unknown>}
 */
export function buildEditorLocalRecord(state) {
  return {
    enabled: state.enabled,
    status: state.status,
    hubUrl: state.hubUrl,
    hubUrlConfirmed: state.enabled,
    trust: state.trust,
    allowPlayMode: state.allowPlayMode,
    instanceCheck: state.instanceCheck.mode,
    expectedInstanceId: state.instanceCheck.expectedId,
  };
}

/**
 * A recorded confirmation counts only for the URL it was given for, so a hub that moved is asked about
 * again instead of being trusted on an old answer.
 * @param {unknown} record   The `editor` block of `local.json`.
 * @param {string | null | undefined} hubUrl
 * @returns {boolean}
 */
export function isConfirmedHub(record, hubUrl) {
  const value = /** @type {{ hubUrlConfirmed?: unknown, hubUrl?: unknown } | null | undefined} */ (record);
  return value?.hubUrlConfirmed === true
    && typeof value.hubUrl === 'string'
    && typeof hubUrl === 'string'
    && value.hubUrl.trim() === hubUrl.trim();
}

/**
 * The state for a project `init` already recorded: the package from `project.json`, the hub and its
 * confirmation from `local.json`, the choices from `config.json`. `start` reads it this way so a launch
 * and the scan that preceded it cannot disagree about the rules.
 * @param {{ mcp?: EditorMcpFacts | null, local?: { hubUrl?: unknown, hubUrlSource?: unknown, expectedInstanceId?: unknown, editor?: unknown } | null, settings?: EditorSettings }} input
 * @returns {EditorAgentState}
 */
export function resolveRecordedEditorAgent({ mcp, local, settings }) {
  const hubUrl = typeof local?.hubUrl === 'string' ? local.hubUrl : null;
  return resolveEditorAgent({
    mcp: mcp ?? {},
    local: {
      hubUrl,
      hubUrlSource: typeof local?.hubUrlSource === 'string' ? local.hubUrlSource : null,
      hubUrlConfirmed: isConfirmedHub(local?.editor, hubUrl),
      expectedInstanceId: typeof local?.expectedInstanceId === 'string' && local.expectedInstanceId !== '' ? local.expectedInstanceId : null,
    },
    ...(settings ? { settings } : {}),
  });
}

/**
 * @param {string} name
 * @returns {string}
 */
function toToolId(name) {
  return `${MCP_TOOL_PREFIX}${name}`;
}

/**
 * The instance id is `<project folder name>@<16 hex>` (UM `ProjectIdentityUtility.cs` L88-125), and the
 * folder name may itself contain `@`, so the hash is split off from the end.
 * @param {string | null | undefined} instanceId
 * @returns {string | null}
 */
export function readInstanceName(instanceId) {
  if (typeof instanceId !== 'string') return null;
  const at = instanceId.lastIndexOf('@');
  const name = at === -1 ? instanceId : instanceId.slice(0, at);
  return name.length > 0 ? name : null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

