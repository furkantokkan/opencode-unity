// Effective-configuration verification, run by `start` before every launch (spec 8.2).
//
// The launch environment of 8.1 keeps the user's global OpenCode config out of the session, but six
// config sources still merge: project `opencode.json(c)`, project `.opencode/`, `~/.opencode/`,
// well-known remote config, managed config and nested `AGENTS.md`. Because rules are evaluated with
// `findLast` and `mergeDeep` keeps an earlier key's position, any of them can re-allow an action we
// denied. So the product does not trust its own render: it asks the binary what the effective
// configuration is and checks the answer.
//
// Everything here is pure. `start` runs `opencode debug agent` and `opencode debug config`, parses
// them, and passes the values in; the same functions check recorded fixtures in tests (C14 keeps the
// fixtures honest).
//
// Extension points: `extraTuples` (owner S37, amendment 38.6) adds the `unitynet` and network-capable
// bash rows to V-b; `expected.policyHash` (S37) and `expected.componentsHash` (S57) add their V-d rows.
//
// On message wording: these lines are CLI output behind exit 4, never the message of an Error thrown
// from a plugin hook, so OpenCode's retry classifier never reads them (spec 7.6 governs that path).
// Product-authored wording here is still held to the same rule by `unit/opencode/retry-safety`, but a
// name a merged config chose is printed verbatim: the user cannot find the offending entry otherwise.
import path from 'node:path';
import { sha256Hex } from '../core/hash.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { buildRuleset, evaluatePermission, flattenPermission, isPermissionAction } from './permission-eval.js';
import { DEFAULT_AGENT, PROVIDER_ID } from './render.js';
import { MCP_SERVER_ID } from './content.js';

export const VERIFY_CACHE_VERSION = 2;
/** Spec 8.2 V-a: `opencode debug agent` gets 60 s and one retry. */
export const AGENT_PROBE_TIMEOUT_MS = 60000;

/** @typedef {import('./permission-eval.js').PermissionBlock} PermissionBlock */
/** @typedef {import('./permission-eval.js').PermissionRule} PermissionRule */
/** @typedef {'V-a' | 'V-b' | 'V-c' | 'V-d' | 'V-e'} CheckId */

/**
 * @typedef {object} Tuple
 * @property {string} group      Grouping from spec 8.5.4, used in reports.
 * @property {string} tool
 * @property {string} [argument]
 */

/**
 * Spec 8.5.4: each of these must evaluate to `deny` for `unity-code`. They are the rules the product
 * refuses to ship without, so they are checked against the *effective* configuration, not our render.
 * @type {readonly Tuple[]}
 */
export const NON_NEGOTIABLE_TUPLES = Object.freeze([
  { group: 'edit', tool: 'edit', argument: 'Assets/Scenes/Main.unity' },
  { group: 'edit', tool: 'edit', argument: 'Assets/UI/Menu.prefab' },
  { group: 'edit', tool: 'edit', argument: 'Assets/Data/Config.asset' },
  { group: 'edit', tool: 'edit', argument: 'Assets/X.cs.meta' },
  { group: 'edit', tool: 'edit', argument: 'ProjectSettings/ProjectSettings.asset' },
  { group: 'edit', tool: 'edit', argument: 'Packages/manifest.json' },
  { group: 'edit', tool: 'edit', argument: 'Assembly-CSharp.csproj' },
  { group: 'edit', tool: 'edit', argument: 'Assets/Game/Game.asmdef' },
  { group: 'read', tool: 'read', argument: 'Assets/Scenes/Main.unity' },
  { group: 'read', tool: 'read', argument: '.env' },
  { group: 'bash', tool: 'bash', argument: 'git push origin main' },
  { group: 'bash', tool: 'bash', argument: 'git commit -m x' },
  { group: 'bash', tool: 'bash', argument: 'git reset --hard' },
  { group: 'bash', tool: 'bash', argument: 'cm checkin -c x' },
  { group: 'bash', tool: 'bash', argument: 'p4 submit' },
  { group: 'bash', tool: 'bash', argument: 'svn commit' },
  { group: 'bash', tool: 'bash', argument: 'hg push' },
  { group: 'bash', tool: 'bash', argument: 'rm -rf Assets' },
  { group: 'bash', tool: 'bash', argument: 'Remove-Item -Recurse -Force Assets' },
  { group: 'other', tool: 'external_directory', argument: 'C:/Windows/x' },
  { group: 'other', tool: 'webfetch', argument: '*' },
  { group: 'other', tool: 'task', argument: '*' },
  { group: 'other', tool: 'doom_loop', argument: '*' },
]);

/**
 * @param {readonly Tuple[]} [extraTuples]  Added by S37 for the network surface.
 * @returns {Tuple[]}
 */
export function buildNonNegotiableTuples(extraTuples = []) {
  return [...NON_NEGOTIABLE_TUPLES, ...extraTuples];
}

/**
 * @typedef {object} CheckResult
 * @property {CheckId} id
 * @property {string} title
 * @property {boolean} ok
 * @property {Failure[]} failures
 */

/**
 * @typedef {object} Failure
 * @property {CheckId} check
 * @property {string} rule          What was violated, in the user's words.
 * @property {string} [effective]   The effective action or value we found.
 * @property {string} [expected]
 * @property {string} [source]      Likely source file or config layer.
 */

/**
 * V-a: the agent probe finished successfully. OpenCode can exit cleanly even when the plugin is
 * missing; V-d separately requires the profile plugin and its injected provider/model.
 * @param {object} probe
 * @param {number} probe.exitCode
 * @param {boolean} [probe.timedOut]
 * @param {string} [probe.stderr]
 * @returns {CheckResult}
 */
export function verifyPluginLoaded({ exitCode, timedOut = false, stderr = '' }) {
  /** @type {Failure[]} */
  const failures = [];
  if (timedOut) {
    failures.push({ check: 'V-a', rule: 'the agent probe finished in time', effective: 'it did not finish', source: 'the OpenCode binary' });
  } else if (exitCode !== 0) {
    const detail = /model not found/i.test(stderr) ? 'the model did not resolve, so the plugin injected no provider' : `the probe ended with status ${exitCode}`;
    failures.push({ check: 'V-a', rule: 'the agent probe succeeds', effective: detail, source: 'plugins/opencode-unity.js in the profile directory' });
  }
  return toCheck('V-a', 'Plugin loaded and provider injected', failures);
}

/**
 * V-b: the non-negotiable tuples, evaluated with the port of OpenCode's own `evaluate()` over the
 * permission the binary reports for the agent.
 * @param {object} input
 * @param {unknown} input.permission          `permission` as `debug agent` returned it.
 * @param {readonly Tuple[]} [input.tuples]
 * @param {boolean} [input.caseInsensitive]   True on Windows.
 * @returns {CheckResult}
 */
export function verifyNonNegotiableRules({ permission, tuples = NON_NEGOTIABLE_TUPLES, caseInsensitive = false }) {
  const rules = toRuleset(permission, 'effective config');
  /** @type {Failure[]} */
  const failures = [];
  for (const tuple of tuples) {
    const verdict = evaluatePermission(rules, { tool: tuple.tool, argument: tuple.argument }, { caseInsensitive });
    if (verdict.action !== 'deny') {
      failures.push({
        check: 'V-b',
        rule: `${tuple.tool} ${tuple.argument ?? '*'} is denied`,
        effective: verdict.action,
        expected: 'deny',
        source: verdict.rule ? `the rule ${verdict.rule.name} -> ${verdict.rule.pattern} from ${verdict.rule.layer}` : 'no rule matched, so OpenCode allows it',
      });
    }
  }
  return toCheck('V-b', 'Non-negotiable rules', failures);
}

/**
 * V-c: the visible tool set equals what this OpenCode version is expected to show, plus the editor
 * allow-list when the editor agent is on (`agent.handler.ts` L60-64).
 * @param {object} input
 * @param {unknown} input.tools               `tools` as `debug agent` returned it.
 * @param {readonly string[]} input.expected  From `expected-tools-<version>.json`.
 * @param {readonly string[]} [input.editorTools]
 * @returns {CheckResult}
 */
export function verifyVisibleTools({ tools, expected, editorTools = [] }) {
  const visible = listVisibleToolNames(tools);
  const allowed = new Set([...expected, ...editorTools]);
  /** @type {Failure[]} */
  const failures = [];
  for (const name of visible) {
    if (!allowed.has(name)) failures.push({ check: 'V-c', rule: `the tool ${name} is not visible`, effective: 'visible', expected: 'hidden', source: 'a merged config re-allowed it' });
  }
  for (const name of allowed) {
    if (!visible.includes(name)) failures.push({ check: 'V-c', rule: `the tool ${name} is visible`, effective: 'hidden', expected: 'visible', source: 'the rendered permission rules' });
  }
  return toCheck('V-c', 'Visible tools', failures);
}

/**
 * @typedef {object} ConfigExpectations
 * @property {string} modelTag             Expected `model` and `small_model` value, without the provider.
 * @property {string} factsPath            Absolute path that must appear in `instructions`.
 * @property {string} profileDir           Every plugin origin must be inside this directory.
 * @property {boolean} [editorAgent]       True allows exactly one `unityMCP` server.
 * @property {string} [policyHash]         S37: expected network `policyHash`.
 * @property {string} [componentsHash]     S57: expected `componentsHash`.
 * @property {boolean} [expectUnitynet]    S37: require a `unitynet` permission whose first rule denies.
 * @property {boolean} [caseInsensitivePaths]  True on Windows, where the binary may echo another case.
 */

/**
 * V-d: the shape of `opencode debug config` (OC `cli/cmd/debug/config.ts` L5-14).
 * @param {object} input
 * @param {Record<string, any>} input.config
 * @param {ConfigExpectations} input.expected
 * @returns {CheckResult}
 */
export function verifyConfigShape({ config, expected }) {
  /** @type {Failure[]} */
  const failures = [];
  const model = `${PROVIDER_ID}/${expected.modelTag}`;
  addValueFailure(failures, 'model', config.model, model);
  addValueFailure(failures, 'share', config.share, 'disabled');
  addValueFailure(failures, 'autoupdate', config.autoupdate, false);
  addValueFailure(failures, 'enabled_providers', config.enabled_providers, [PROVIDER_ID]);

  const fold = expected.caseInsensitivePaths ?? false;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const pluginPaths = plugins.map((entry) => pluginFilePath(Array.isArray(entry) ? entry[0] : entry));
  const requiredPlugin = `${expected.profileDir}/plugins/opencode-unity.js`;
  if (!pluginPaths.some((file) => samePath(file, requiredPlugin, fold))) {
    failures.push({ check: 'V-d', rule: 'the guard plugin is present in the resolved config', effective: 'missing', expected: requiredPlugin, source: 'the profile plugins directory' });
  }
  for (let index = 0; index < pluginPaths.length; index += 1) {
    const file = pluginPaths[index];
    if (file === null || !isInsideDirectory(file, expected.profileDir, fold)) {
      failures.push({ check: 'V-d', rule: 'every plugin comes from the profile directory', effective: file ?? describe(plugins[index]), expected: expected.profileDir, source: file ?? 'the resolved plugin list' });
    }
  }
  // OpenCode 1.18.31 reports an array of {spec, source, scope}, not a name-to-paths map.
  const origins = Array.isArray(config.plugin_origins) ? config.plugin_origins : [];
  for (const origin of origins) {
    const file = pluginFilePath(origin?.spec);
    const source = origin?.source;
    if (file === null || !isInsideDirectory(file, expected.profileDir, fold)
      || typeof source !== 'string' || (!samePath(source, expected.profileDir, fold) && !isInsideDirectory(source, expected.profileDir, fold))) {
      failures.push({ check: 'V-d', rule: 'every plugin origin comes from the profile directory', effective: file ?? describe(origin), expected: expected.profileDir, source: typeof source === 'string' ? source : 'the resolved plugin origins' });
    }
  }
  if (!config.provider?.[PROVIDER_ID]?.models?.[expected.modelTag]) {
    failures.push({ check: 'V-d', rule: 'the local provider includes the preset model', effective: 'missing', expected: model, source: 'the guard plugin provider hook' });
  }

  const instructions = Array.isArray(config.instructions) ? config.instructions : [];
  if (!instructions.some((entry) => samePath(entry, expected.factsPath, fold))) {
    failures.push({ check: 'V-d', rule: 'instructions include the project facts', effective: instructions.length === 0 ? 'no instructions' : instructions.join(', '), expected: expected.factsPath, source: 'the per-launch config content' });
  }

  const servers = Object.keys(config.mcp ?? {});
  const allowedServers = expected.editorAgent ? [MCP_SERVER_ID] : [];
  for (const server of servers) {
    if (!allowedServers.includes(server)) {
      failures.push({ check: 'V-d', rule: `no MCP server other than ${allowedServers.join(', ') || 'none'}`, effective: server, expected: allowedServers.join(', ') || 'none', source: 'a project or user config file' });
    }
  }

  if (expected.expectUnitynet) failures.push(...checkUnitynetFirstRule(config));
  addHashFailure(failures, 'policyHash', config.policyHash, expected.policyHash);
  addHashFailure(failures, 'componentsHash', config.componentsHash, expected.componentsHash);
  return toCheck('V-d', 'Config shape', failures);
}

/**
 * V-e: the project instruction files OpenCode attaches (a static mirror of OC `instruction.ts`
 * L110-133; `CLAUDE.md` is already skipped by `OPENCODE_DISABLE_CLAUDE_CODE`). Over budget, the user
 * is told to shorten the file or to start with `--no-project-config`.
 * @param {object} input
 * @param {Array<{ path: string, tokens: number }>} input.files
 * @param {number} input.prefixTokens   Measured fixed prefix for the agent.
 * @param {number} input.failTokens     `budget.prefixFailTokens` for the agent.
 * @returns {CheckResult}
 */
export function verifyInstructionFiles({ files, prefixTokens, failTokens }) {
  const total = files.reduce((sum, file) => sum + file.tokens, 0);
  const room = failTokens - prefixTokens;
  /** @type {Failure[]} */
  const failures = [];
  if (total > room) {
    const largest = [...files].sort((a, b) => b.tokens - a.tokens)[0];
    failures.push({
      check: 'V-e',
      rule: 'the project instruction files fit the prompt budget',
      effective: `about ${formatTokens(total)} tokens`,
      expected: `at most ${formatTokens(Math.max(room, 0))} tokens`,
      source: largest ? largest.path : 'the project instruction files',
    });
  }
  return toCheck('V-e', 'Instruction files', failures);
}

/**
 * @typedef {object} VerifyInput
 * @property {Parameters<typeof verifyPluginLoaded>[0]} probe
 * @property {unknown} permission
 * @property {unknown} tools
 * @property {readonly string[]} expectedTools
 * @property {Record<string, any>} config
 * @property {ConfigExpectations} expected
 * @property {Array<{ path: string, tokens: number }>} [instructionFiles]
 * @property {number} [prefixTokens]
 * @property {number} [failTokens]
 * @property {readonly Tuple[]} [tuples]
 * @property {readonly string[]} [editorTools]
 * @property {boolean} [caseInsensitive]
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} ok
 * @property {CheckResult[]} checks
 * @property {Failure[]} failures
 */

/**
 * Runs V-a through V-e in order. Every check runs even when an earlier one failed, because a user
 * fixing a hostile repository wants the whole list, not one line at a time.
 * @param {VerifyInput} input
 * @returns {VerifyResult}
 */
export function verifyEffectiveConfig(input) {
  const checks = [
    verifyPluginLoaded(input.probe),
    verifyNonNegotiableRules({ permission: input.permission, tuples: input.tuples ?? NON_NEGOTIABLE_TUPLES, caseInsensitive: input.caseInsensitive }),
    verifyVisibleTools({ tools: input.tools, expected: input.expectedTools, editorTools: input.editorTools }),
    verifyConfigShape({ config: input.config, expected: input.expected }),
  ];
  if (input.instructionFiles && input.prefixTokens !== undefined && input.failTokens !== undefined) {
    checks.push(verifyInstructionFiles({ files: input.instructionFiles, prefixTokens: input.prefixTokens, failTokens: input.failTokens }));
  }
  const failures = checks.flatMap((check) => check.failures);
  return { ok: failures.length === 0, checks, failures };
}

/**
 * One line per failure: the rule, what the effective configuration does instead, and where it most
 * likely came from (spec 8.2).
 * @param {Failure} failure
 * @returns {string}
 */
export function formatVerificationFailure(failure) {
  const parts = [`${failure.check} ${failure.rule}`];
  if (failure.effective !== undefined) parts.push(`effective: ${failure.effective}`);
  if (failure.expected !== undefined) parts.push(`expected: ${failure.expected}`);
  if (failure.source !== undefined) parts.push(`likely source: ${failure.source}`);
  return parts.join('; ');
}

/**
 * Exit 4 with every failing rule named (spec 5.2, 8.2).
 * @param {VerifyResult} result
 * @param {{ agent?: string }} [options]
 * @returns {CliError}
 */
export function createVerificationError(result, { agent = DEFAULT_AGENT } = {}) {
  const lines = result.failures.map((failure) => formatVerificationFailure(failure));
  return new CliError(`The effective OpenCode configuration for ${agent} does not match this product's rules: ${lines.join(' | ')}`, {
    exitCode: EXIT.VALIDATION,
    code: 'effective_config_rejected',
    hint: 'Remove the rule from the project config, or start with --no-project-config.',
    data: { failures: result.failures },
  });
}

/**
 * @typedef {object} VerifyCacheKeyInput
 * @property {string} opencodeVersion
 * @property {string} profileHash
 * @property {string} contentHash
 * @property {Array<{ path: string, hash: string, mtimeMs: number }>} projectConfigFiles
 * @property {Record<string, string[]>} directoryListings  Project `.opencode`, `~/.opencode`, managed config.
 * @property {number} authMtimeMs                          OpenCode's `auth.json`.
 */

/**
 * The cache key of spec 8.2: everything that could change the effective configuration without
 * changing our render. Sorted, so two equal states always produce one key.
 * @param {VerifyCacheKeyInput} input
 * @returns {string}
 */
export function buildVerifyCacheKey(input) {
  const files = [...input.projectConfigFiles]
    .map((file) => `${file.path}\u0000${file.hash}\u0000${file.mtimeMs}`)
    .sort(compareOrdinal);
  const listings = Object.keys(input.directoryListings)
    .sort(compareOrdinal)
    .map((directory) => `${directory}\u0000${[...input.directoryListings[directory]].sort(compareOrdinal).join('\u0001')}`);
  return sha256Hex([
    `version:${VERIFY_CACHE_VERSION}`,
    `opencode:${input.opencodeVersion}`,
    `profile:${input.profileHash}`,
    `content:${input.contentHash}`,
    `auth:${input.authMtimeMs}`,
    ...files,
    ...listings,
  ].join('\n'));
}

/**
 * Accepts either the permission block we render or the resolved rule array `debug agent` returns, so
 * the same checks run over a fixture and over our own output.
 * @param {unknown} permission
 * @param {string} layer
 * @returns {PermissionRule[]}
 */
export function toRuleset(permission, layer) {
  if (Array.isArray(permission)) {
    return permission
      .map((entry, index) => normalizeRuleEntry(entry, layer, index))
      .filter((rule) => rule !== null)
      .map((rule, index) => ({ .../** @type {PermissionRule} */ (rule), index }));
  }
  if (permission !== null && typeof permission === 'object') {
    return buildRuleset([{ layer, permission: /** @type {PermissionBlock} */ (permission) }]);
  }
  return [];
}

/**
 * @param {unknown} tools
 * @returns {string[]}
 */
export function listVisibleToolNames(tools) {
  if (Array.isArray(tools)) return tools.filter((name) => typeof name === 'string');
  if (tools !== null && typeof tools === 'object') {
    return Object.entries(tools).filter(([, enabled]) => enabled !== false).map(([name]) => name);
  }
  return [];
}

/**
 * @param {unknown} entry
 * @param {string} layer
 * @param {number} index
 * @returns {Omit<PermissionRule, 'index'> | null}
 */
function normalizeRuleEntry(entry, layer, index) {
  if (entry === null || typeof entry !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (entry);
  const name = firstString(record.name, record.type, record.permission, record.tool);
  const action = firstString(record.action, record.value, record.level);
  if (!name || !isPermissionAction(action)) return null;
  const pattern = firstString(record.pattern, record.argument, record.glob) ?? '*';
  return { name, pattern, action, layer: `${layer} rule ${index + 1}` };
}

/**
 * @param {...unknown} values
 * @returns {string | undefined}
 */
function firstString(...values) {
  return /** @type {string | undefined} */ (values.find((value) => typeof value === 'string' && value.length > 0));
}

/**
 * @param {Record<string, any>} config
 * @returns {Failure[]}
 */
function checkUnitynetFirstRule(config) {
  const block = config.permission?.unitynet;
  if (block === undefined) {
    return [{ check: 'V-d', rule: 'the network permission exists', effective: 'it is missing', source: 'the rendered network policy' }];
  }
  const [first] = flattenPermission({ unitynet: block }, 'effective config');
  if (!first || first.pattern !== '*' || first.action !== 'deny') {
    return [{ check: 'V-d', rule: 'the network permission denies everything first', effective: first ? `${first.pattern} -> ${first.action}` : 'it has no rules', expected: '* -> deny', source: 'a merged config file' }];
  }
  return [];
}

/**
 * @param {Failure[]} failures
 * @param {string} key
 * @param {unknown} actual
 * @param {unknown} expected
 */
function addValueFailure(failures, key, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failures.push({ check: 'V-d', rule: `${key} is what this product set`, effective: describe(actual), expected: describe(expected), source: 'a merged config file' });
}

/**
 * @param {Failure[]} failures
 * @param {string} key
 * @param {unknown} actual
 * @param {string | undefined} expected
 */
function addHashFailure(failures, key, actual, expected) {
  if (expected === undefined) return;
  if (actual !== expected) failures.push({ check: 'V-d', rule: `${key} matches the rendered policy`, effective: describe(actual), expected, source: 'the runtime profile' });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

/**
 * @param {string} candidate
 * @param {string} directory
 * @param {boolean} fold
 * @returns {boolean}
 */
function isInsideDirectory(candidate, directory, fold) {
  const normalizedDirectory = normalizePath(directory, fold).replace(/\/+$/, '');
  return normalizePath(candidate, fold).startsWith(`${normalizedDirectory}/`);
}

/**
 * @param {unknown} a
 * @param {string} b
 * @param {boolean} fold
 * @returns {boolean}
 */
function samePath(a, b, fold) {
  return typeof a === 'string' && normalizePath(a, fold) === normalizePath(b, fold);
}

/**
 * Separators are normalized everywhere, because the binary may echo a path back with either one. Case
 * is folded only where the file system ignores it; folding on Linux would make two different files
 * compare equal and weaken the check.
 * @param {string} value
 * @param {boolean} fold
 * @returns {string}
 */
function normalizePath(value, fold) {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return fold ? normalized.toLowerCase() : normalized;
}

/** @param {unknown} spec @returns {string | null} */
function pluginFilePath(spec) {
  if (typeof spec !== 'string') return null;
  try {
    const url = new URL(spec);
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
    return decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, '');
  } catch {
    return null;
  }
}

/**
 * Token counts are printed in thousands so no three-digit run can make OpenCode read a message as a
 * retryable HTTP status (spec 7.6).
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * @param {CheckId} id
 * @param {string} title
 * @param {Failure[]} failures
 * @returns {CheckResult}
 */
function toCheck(id, title, failures) {
  return { id, title, ok: failures.length === 0, failures };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareOrdinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
