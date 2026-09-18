// Port of OpenCode 1.18.31's permission evaluation, so `start` can decide what the *effective*
// configuration allows before it launches anything (spec 8.2 V-b, 8.5.1).
//
// Ported behaviour, with the source this mirrors:
// - rules are flattened in layer order and the LAST matching rule wins (OC `permission/index.ts`
//   L28-38 `evaluate()`);
// - a tool is removed from the request only when the last rule matching its permission name has
//   pattern `*` and action `deny` (OC `permission/index.ts` L204-214);
// - patterns are globs where `*` matches anything, and a trailing ` *` makes the argument optional
//   (OC `core/src/util/wildcard.ts` L3-14);
// - matching is case-insensitive on Windows;
// - MCP tool ids are `<server>_<tool>` and MCP resource reads evaluate under `read` (spec 8.5.1).
//
// Everything here is pure: callers pass the merged permission layers in, so a hostile project file
// is checked with the same code that checks our own render.

/** @typedef {'allow' | 'ask' | 'deny'} PermissionAction */
/** @typedef {PermissionAction | Record<string, PermissionAction>} PermissionValue */
/** @typedef {Record<string, PermissionValue>} PermissionBlock */

/**
 * @typedef {object} PermissionRule
 * @property {string} name      Permission name, which may itself be a wildcard such as `*_*`.
 * @property {string} pattern   Argument pattern; `*` for a plain string value.
 * @property {PermissionAction} action
 * @property {string} layer     Where the rule came from, used in failure messages.
 * @property {number} index     Position in the flattened ruleset.
 */

/** @type {readonly PermissionAction[]} */
export const PERMISSION_ACTIONS = Object.freeze(['allow', 'ask', 'deny']);

/**
 * OpenCode's built-in defaults, the first layer of spec 8.5.1 (OC `agent/agent.ts` L119-136).
 * @type {PermissionBlock}
 */
export const OPENCODE_DEFAULT_PERMISSION = Object.freeze({
  '*': 'allow',
  doom_loop: 'ask',
  external_directory: 'ask',
  read: Object.freeze({ '*.env': 'ask' }),
});

/** Permission name used for MCP resource reads (spec 8.5.1). */
export const RESOURCE_PERMISSION_NAME = 'read';

/**
 * @param {unknown} value
 * @returns {value is PermissionAction}
 */
export function isPermissionAction(value) {
  return typeof value === 'string' && PERMISSION_ACTIONS.includes(/** @type {PermissionAction} */ (value));
}

/**
 * Flattens one permission block into ordered rules. A string value becomes the pattern `*`.
 * @param {PermissionBlock | undefined | null} permission
 * @param {string} [layer]  Label carried into failure messages.
 * @returns {Array<Omit<PermissionRule, 'index'>>}
 */
export function flattenPermission(permission, layer = 'config') {
  if (permission === null || permission === undefined) return [];
  /** @type {Array<Omit<PermissionRule, 'index'>>} */
  const rules = [];
  for (const [name, value] of Object.entries(permission)) {
    if (isPermissionAction(value)) {
      rules.push({ name, pattern: '*', action: value, layer });
    } else if (value !== null && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value)) {
        if (isPermissionAction(action)) rules.push({ name, pattern, action, layer });
      }
    }
  }
  return rules;
}

/**
 * Flattens the layers of spec 8.5.1 in evaluation order. Later layers win because evaluation takes
 * the last match, which is exactly how OpenCode merges them.
 * @param {Array<{ layer: string, permission: PermissionBlock | undefined | null }>} layers
 * @returns {PermissionRule[]}
 */
export function buildRuleset(layers) {
  return layers
    .flatMap(({ layer, permission }) => flattenPermission(permission, layer))
    .map((rule, index) => ({ ...rule, index }));
}

/**
 * @typedef {object} PermissionRequest
 * @property {string} tool       Tool or permission name, for example `edit`, `bash`, `unityMCP_run_tests`.
 * @property {string} [argument] Path or command; `*` when the tool takes none.
 * @property {boolean} [resource] True for an MCP resource read, which evaluates under `read`.
 */

/**
 * @typedef {object} EvaluateOptions
 * @property {boolean} [caseInsensitive]  True on Windows.
 */

/**
 * @typedef {object} PermissionVerdict
 * @property {PermissionAction} action
 * @property {PermissionRule | null} rule  The rule that decided it, or null when nothing matched.
 * @property {string} name                 The permission name the request was evaluated under.
 */

/**
 * The last matching rule wins (OC `permission/index.ts` L28-38). With no match at all the verdict is
 * `allow`, which is why callers always include OpenCode's defaults as the first layer.
 * @param {PermissionRule[]} rules
 * @param {PermissionRequest} request
 * @param {EvaluateOptions} [options]
 * @returns {PermissionVerdict}
 */
export function evaluatePermission(rules, request, options = {}) {
  const name = getPermissionName(request);
  const argument = request.argument ?? '*';
  /** @type {PermissionRule | null} */
  let decided = null;
  for (const rule of rules) {
    if (matchesRule(rule, name, argument, options)) decided = rule;
  }
  return { action: decided ? decided.action : 'allow', rule: decided, name };
}

/**
 * True when OpenCode removes the tool from the request instead of asking: the last rule matching the
 * permission name has pattern `*` and action `deny` (OC `permission/index.ts` L204-214).
 * @param {PermissionRule[]} rules
 * @param {string} toolName
 * @param {EvaluateOptions} [options]
 * @returns {boolean}
 */
export function isToolRemoved(rules, toolName, options = {}) {
  /** @type {PermissionRule | null} */
  let decided = null;
  for (const rule of rules) {
    if (matchesName(rule.name, toolName, options)) decided = rule;
  }
  return decided !== null && decided.pattern === '*' && decided.action === 'deny';
}

/**
 * Tool names that survive a ruleset, in the order given.
 * @param {PermissionRule[]} rules
 * @param {string[]} toolNames
 * @param {EvaluateOptions} [options]
 * @returns {string[]}
 */
export function listVisibleTools(rules, toolNames, options = {}) {
  return toolNames.filter((name) => !isToolRemoved(rules, name, options));
}

/**
 * True when the name is denied outright somewhere in the ruleset, which is what stops OpenCode from
 * appending its own `external_directory` allow for the tool-output folder (OC `agent/agent.ts` L296-310).
 * @param {PermissionRule[]} rules
 * @param {string} name
 * @returns {boolean}
 */
export function isExplicitlyDenied(rules, name) {
  return rules.some((rule) => rule.name === name && rule.action === 'deny');
}

/**
 * Layer 4 of spec 8.5.1: OpenCode appends an allow for its own tool-output directory unless
 * `external_directory` is explicitly denied. Returns a new ruleset.
 * @param {PermissionRule[]} rules
 * @param {string} toolOutputDirectory  Absolute path, or an empty string to append nothing.
 * @returns {PermissionRule[]}
 */
export function appendToolOutputAllow(rules, toolOutputDirectory) {
  if (!toolOutputDirectory || isExplicitlyDenied(rules, 'external_directory')) return [...rules];
  const appended = { name: 'external_directory', pattern: `${toolOutputDirectory}*`, action: /** @type {PermissionAction} */ ('allow'), layer: 'opencode-tool-output' };
  return [...rules, { ...appended, index: rules.length }];
}

/**
 * @param {PermissionRequest} request
 * @returns {string}
 */
export function getPermissionName(request) {
  return request.resource ? RESOURCE_PERMISSION_NAME : request.tool;
}

/**
 * @param {PermissionRule} rule
 * @param {string} name
 * @param {string} argument
 * @param {EvaluateOptions} options
 * @returns {boolean}
 */
function matchesRule(rule, name, argument, options) {
  return matchesName(rule.name, name, options) && wildcardMatch(rule.pattern, argument, options);
}

/**
 * Permission names are matched as wildcards too, which is what makes `*_*` cover every MCP tool id.
 * @param {string} rulePattern
 * @param {string} name
 * @param {EvaluateOptions} [options]
 * @returns {boolean}
 */
export function matchesName(rulePattern, name, options = {}) {
  return wildcardMatch(rulePattern, name, options);
}

/** @type {Map<string, RegExp>} */
const k_wildcardCache = new Map();

/**
 * Port of OC `core/src/util/wildcard.ts` L3-14: `*` matches any run of characters, everything else is
 * literal, and a trailing ` *` also matches the command with no argument at all.
 * @param {string} pattern
 * @param {string} value
 * @param {EvaluateOptions} [options]
 * @returns {boolean}
 */
export function wildcardMatch(pattern, value, { caseInsensitive = false } = {}) {
  const key = `${caseInsensitive ? 'i' : 's'}\u0000${pattern}`;
  let expression = k_wildcardCache.get(key);
  if (!expression) {
    expression = compileWildcard(pattern, caseInsensitive);
    k_wildcardCache.set(key, expression);
  }
  expression.lastIndex = 0;
  return expression.test(value);
}

/**
 * @param {string} pattern
 * @param {boolean} caseInsensitive
 * @returns {RegExp}
 */
function compileWildcard(pattern, caseInsensitive) {
  const optionalArgument = pattern.endsWith(' *');
  const head = optionalArgument ? pattern.slice(0, -2) : pattern;
  const source = optionalArgument ? `^${toSource(head)}(?: [\\s\\S]*)?$` : `^${toSource(head)}$`;
  return new RegExp(source, caseInsensitive ? 'iu' : 'u');
}

/**
 * @param {string} pattern
 * @returns {string}
 */
function toSource(pattern) {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '[\\s\\S]*' : `\\${char}`));
}
