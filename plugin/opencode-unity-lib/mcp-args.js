// The MCP for Unity argument policy (spec 11.2, 11.3). It runs in `tool.execute.before`, which fires
// for MCP tools before the permission ask (OC `session/tools.ts` L401-406), so an argument this module
// rewrites is the argument the user is asked about and the argument the hub receives.
//
// Three rules, in this order:
//   1. every `unityMCP_*` call loses a model-supplied `unity_instance`, because the server middleware
//      routes per call on that value (UM `transport/unity_instance_middleware.py` L336-354) and routing
//      stays the human's choice;
//   2. a tool outside the allow-list is refused here as well as by the permission rules, so a config
//      that ever renders a wider rule set still cannot reach a mutating tool;
//   3. the per-tool rules: `read_console` reads and never clears, `run_tests` runs EditMode with a
//      filter.
//
// Rewriting beats refusing wherever the safe value is unambiguous: a refusal costs the model a turn it
// cannot afford at 16K, and an omitted `action` means "get" upstream anyway (UM `read_console.py` L50).
// Everything else throws, and the message says what to send instead.

export const MCP_ARGS_PREFIX = 'opencode-unity editor policy:';

/** MCP tool ids are `<server>_<tool>`, and the server key matches the configurator (spec 11.1). */
export const MCP_SERVER_KEY = 'unityMCP';
export const MCP_TOOL_PREFIX = `${MCP_SERVER_KEY}_`;

/** The routing argument the model may never set (spec 11.3). */
export const INSTANCE_ARGUMENT = 'unity_instance';

/** Read-only tools (spec 11.2). */
export const READ_ONLY_TOOLS = Object.freeze(['read_console', 'find_gameobjects', 'get_test_job']);

/** Tools that change the Editor, so they ask unless the project trusts the agent (spec 11.2). */
export const TRUSTED_TOOLS = Object.freeze(['refresh_unity', 'run_tests']);

/** Everything the editor agent may call; every other tool id is refused (spec 11.2). */
export const EDITOR_TOOLS = Object.freeze([...READ_ONLY_TOOLS, ...TRUSTED_TOOLS]);

/** `get` is read-only; `clear` modifies ephemeral UI state (UM `read_console.py` L23-29). */
export const CONSOLE_ACTION_ARGUMENT = 'action';
export const CONSOLE_READ_ACTION = 'get';

export const TEST_MODE_ARGUMENT = 'mode';
export const EDIT_MODE = 'EditMode';
export const PLAY_MODE = 'PlayMode';

/** One of these must name at least one test, or `run_tests` runs the whole suite (UM `run_tests.py` L146-170). */
export const TEST_FILTER_ARGUMENTS = Object.freeze(['test_names', 'group_names', 'category_names', 'assembly_names']);

/**
 * @typedef {'mcp_tool_denied' | 'mcp_console_action' | 'mcp_test_mode' | 'mcp_test_filter'} McpDenyCode
 */

/**
 * @typedef {object} McpArgsResult
 * @property {string} tool                 Tool name without the server prefix.
 * @property {string[]} changes            Argument names this policy rewrote or removed, for the session log.
 */

/**
 * @typedef {object} McpArgsOptions
 * @property {readonly string[]} [allowedTools]  Tool names without the server prefix; defaults to the five of spec 11.2.
 * @property {boolean} [allowPlayMode]           The project's `editor.allowPlayMode`; false is the safe default.
 */

/**
 * @typedef {object} McpArgsPolicy
 * @property {(toolId: string, args: unknown) => McpArgsResult | null} check  Null when the tool is not an MCP for Unity tool. Throws on a denial.
 * @property {readonly string[]} allowedTools
 * @property {boolean} allowPlayMode
 */

/**
 * @param {McpArgsOptions} [options]
 * @returns {McpArgsPolicy}
 */
export function createMcpArgsPolicy({ allowedTools = EDITOR_TOOLS, allowPlayMode = false } = {}) {
  const allowed = Object.freeze([...allowedTools]);
  return {
    allowedTools: allowed,
    allowPlayMode: allowPlayMode === true,
    check: (toolId, args) => applyMcpArgsPolicy(toolId, args, { allowedTools: allowed, allowPlayMode: allowPlayMode === true }),
  };
}

/**
 * The server key is matched without case, because OpenCode matches permission patterns without case on
 * Windows (OC `util/wildcard.ts` L3-14): a tool id whose prefix differs only in case must not reach the
 * hub with no policy applied. The tool name after the prefix is compared exactly, so a spelling this
 * module does not know stays denied.
 * @param {string} toolId
 * @returns {boolean}
 */
export function isMcpTool(toolId) {
  return typeof toolId === 'string' && toolId.length > MCP_TOOL_PREFIX.length
    && toolId.slice(0, MCP_TOOL_PREFIX.length).toLowerCase() === MCP_TOOL_PREFIX.toLowerCase();
}

/**
 * @param {string} toolId
 * @returns {string}
 */
export function getMcpToolName(toolId) {
  return isMcpTool(toolId) ? toolId.slice(MCP_TOOL_PREFIX.length) : '';
}

/**
 * Applies the policy to one call, mutating `args` in place: the hook has no other way to change what
 * the tool receives.
 * @param {string} toolId
 * @param {unknown} args
 * @param {McpArgsOptions} [options]
 * @returns {McpArgsResult | null}
 */
export function applyMcpArgsPolicy(toolId, args, { allowedTools = EDITOR_TOOLS, allowPlayMode = false } = {}) {
  if (!isMcpTool(toolId)) return null;
  const tool = getMcpToolName(toolId);
  if (!allowedTools.includes(tool)) {
    throw createMcpArgsError('mcp_tool_denied', `${tool} is not one of the editor checks this agent may run`);
  }
  // A call with no argument object still passes the allow-list, because the tool may take no arguments.
  // An array is not one either: writing a named argument into it would produce a shape no tool accepts.
  const target = args !== null && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : null;
  /** @type {string[]} */
  const changes = [];
  if (target && Object.hasOwn(target, INSTANCE_ARGUMENT)) {
    delete target[INSTANCE_ARGUMENT];
    changes.push(INSTANCE_ARGUMENT);
  }
  if (tool === 'read_console') applyConsoleRules(target, changes);
  if (tool === 'run_tests') applyTestRules(target, changes, allowPlayMode);
  return { tool, changes };
}

/**
 * @param {Record<string, unknown> | null} args
 * @param {string[]} changes
 */
function applyConsoleRules(args, changes) {
  const action = args ? args[CONSOLE_ACTION_ARGUMENT] : undefined;
  if (action === CONSOLE_READ_ACTION) return;
  if (action !== undefined && action !== null) {
    throw createMcpArgsError('mcp_console_action', `read_console may only ${CONSOLE_READ_ACTION} the console, so drop the action argument`);
  }
  // Upstream defaults a missing or null action to `get`; writing it out keeps the hub record unambiguous.
  if (args) {
    args[CONSOLE_ACTION_ARGUMENT] = CONSOLE_READ_ACTION;
    changes.push(CONSOLE_ACTION_ARGUMENT);
  }
}

/**
 * @param {Record<string, unknown> | null} args
 * @param {string[]} changes
 * @param {boolean} allowPlayMode
 */
function applyTestRules(args, changes, allowPlayMode) {
  if (!args) {
    throw createMcpArgsError('mcp_test_filter', `run_tests needs one of ${TEST_FILTER_ARGUMENTS.join(', ')} so it runs named tests instead of the whole suite`);
  }
  const mode = resolveTestMode(args[TEST_MODE_ARGUMENT], allowPlayMode);
  if (args[TEST_MODE_ARGUMENT] !== mode) {
    args[TEST_MODE_ARGUMENT] = mode;
    changes.push(TEST_MODE_ARGUMENT);
  }
  if (!TEST_FILTER_ARGUMENTS.some((name) => hasTestFilter(args[name]))) {
    throw createMcpArgsError('mcp_test_filter', `run_tests needs one of ${TEST_FILTER_ARGUMENTS.join(', ')} so it runs named tests instead of the whole suite`);
  }
}

/**
 * @param {unknown} value
 * @param {boolean} allowPlayMode
 * @returns {string}
 */
function resolveTestMode(value, allowPlayMode) {
  // Upstream defaults a missing mode to EditMode, and the spelling is matched case-insensitively here so
  // a lower-case `editmode` costs the model a rewritten argument rather than a refused turn.
  if (value === undefined || value === null) return EDIT_MODE;
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (name === EDIT_MODE.toLowerCase()) return EDIT_MODE;
  if (name === PLAY_MODE.toLowerCase() && allowPlayMode) return PLAY_MODE;
  throw createMcpArgsError('mcp_test_mode', `this project runs ${EDIT_MODE} tests only, so send mode ${EDIT_MODE}`);
}

/**
 * Mirrors the upstream coercion (UM `run_tests.py` L182-191): a string counts when it is not blank, a
 * list counts when it holds at least one non-blank entry.
 * @param {unknown} value
 * @returns {boolean}
 */
function hasTestFilter(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!Array.isArray(value)) return false;
  return value.some((entry) => entry !== null && entry !== undefined && String(entry).trim().length > 0);
}

/**
 * The policy options a parsed `local.json` carries. Only `allowPlayMode` is a project choice: the
 * allow-list itself is fixed by spec 11.2, so no file can widen it. Anything unreadable leaves the
 * policy in its strictest state.
 * @param {unknown} local
 * @returns {McpArgsOptions}
 */
export function readEditorPolicyOptions(local) {
  const editor = /** @type {{ editor?: { allowPlayMode?: unknown } } | null} */ (local)?.editor;
  return { allowPlayMode: editor?.allowPlayMode === true };
}

/**
 * The tool result the model reads: one line that says what is not allowed and what to send instead.
 * @param {McpDenyCode} code
 * @param {string} reason
 * @returns {Error & { code: McpDenyCode }}
 */
export function createMcpArgsError(code, reason) {
  const error = /** @type {Error & { code: McpDenyCode }} */ (new Error(`${MCP_ARGS_PREFIX} ${reason}.`));
  error.code = code;
  return error;
}
