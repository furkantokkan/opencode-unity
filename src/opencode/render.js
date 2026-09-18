// Renders the OpenCode assets this product installs into `<home>/profile/<cliVersion>/`: the static
// `opencode.jsonc`, the two agent files and the compile command (spec 8.3, 8.5, 8.6). The per-launch
// JSON lives in `content.js`, because only that part depends on the project.
//
// Two rules shape this module:
// - every rendered rule set is an ordered plain object, because OpenCode evaluates permissions with
//   `findLast` and a reordered render is a different policy (spec 8.5.1);
// - nothing here reads a file other than its own template, so a render is reproducible from values.
//
// Extension points, wired but empty in this step:
// - `extensions.unitynet` (owner S37, amendment 38.6) adds the network permission name;
// - `extensions.networkBlock` (owner S37) adds the fetched-content prompt block;
// - `extensions.componentEditDeny` / `componentReadDeny` / `componentBashDeny` / `componentBashAllow`
//   (owner S57, amendment 37.9) add the backend deny fragments;
// - `mcpTools` (owner S61, amendment 38.6a) admits read-only MCP tools to `unity-code`, and ships
//   only if gate G24's prefix measurement allows it.
import fs from 'node:fs';
import { PROTECTED_EDIT_GLOBS, PROTECTED_READ_ALLOW_GLOB, PROTECTED_READ_GLOBS } from '../../plugin/opencode-unity-lib/protected-paths.js';
import { getReadOnlyAllowPatterns, VCS_WRITE_DENY } from '../../plugin/opencode-unity-lib/vcs-tables.js';
import { CLI_VERSION } from '../cli/version.js';
import { PROVIDER_ID } from '../core/profile.js';

export { PROVIDER_ID };
export const DEFAULT_AGENT = 'unity-code';
export const EDITOR_AGENT = 'unity-editor';
export const TOOL_OUTPUT_MAX_LINES = 250;
export const TOOL_OUTPUT_MAX_BYTES = 12000;
export const UNITY_CODE_STEPS = 30;
export const UNITY_EDITOR_STEPS = 15;

export const OPENCODE_JSONC_TEMPLATE_URL = new URL('../../templates/opencode/opencode.jsonc.tpl', import.meta.url);
export const UNITY_CODE_TEMPLATE_URL = new URL('../../templates/opencode/agents/unity-code.md.tpl', import.meta.url);
export const UNITY_EDITOR_TEMPLATE_URL = new URL('../../templates/opencode/agents/unity-editor.md.tpl', import.meta.url);
export const COMPILE_COMMAND_TEMPLATE_URL = new URL('../../templates/opencode/commands/compile.md.tpl', import.meta.url);

/** @typedef {import('./permission-eval.js').PermissionAction} PermissionAction */
/** @typedef {import('./permission-eval.js').PermissionValue} PermissionValue */
/** @typedef {import('./permission-eval.js').PermissionBlock} PermissionBlock */

// Spec 8.5.2's `PROTECTED_EDIT` and `PROTECTED_READ`, re-exported under the names this module has
// always published. The tables live in `plugin/opencode-unity-lib/protected-paths.js` because the shell
// guard and the workspace scanner deny the same paths, and only `plugin/` is copied into the rendered
// profile: the CLI may import the plugin, and the plugin may never import the CLI.
export { PROTECTED_EDIT_GLOBS, PROTECTED_READ_ALLOW_GLOB, PROTECTED_READ_GLOBS };

/** Recursive deletes, denied for every agent (spec 8.5.2 `DESTRUCTIVE_DENY`). */
export const DESTRUCTIVE_DENY_PATTERNS = Object.freeze([
  'rm -r *', 'rm -rf *', 'rm -fr *', 'rmdir /s *', 'rd /s *', 'del /s *', 'Remove-Item *-Recurse*', 'format *',
]);

/** MCP resource reads are denied for the coding agent; only the editor agent reads them (spec 8.5.2). */
export const MCP_RESOURCE_DENY_PATTERN = 'mcp:*';

/** Editor tools that only read (spec 8.5.2, 11.2). */
export const EDITOR_READ_ONLY_TOOLS = Object.freeze(['unityMCP_read_console', 'unityMCP_find_gameobjects', 'unityMCP_get_test_job']);

/** Editor tools that change the Editor, so they ask unless the project trusts the agent (spec 8.5.2). */
export const EDITOR_TRUSTED_TOOLS = Object.freeze(['unityMCP_refresh_unity', 'unityMCP_run_tests']);

/**
 * The three read-only MCP tools amendment 38.6a admits into `unity-code`. Exported as data because the
 * decision to render them belongs to gate G24's prefix measurement, not to this module.
 * @type {readonly string[]}
 */
export const UNITY_CODE_MCP_TOOLS = Object.freeze([...EDITOR_READ_ONLY_TOOLS]);

/**
 * @typedef {object} SafetyGlobs
 * @property {string[]} [extraProtectedEditGlobs]
 * @property {string[]} [extraProtectedReadGlobs]
 */

/**
 * @typedef {object} RenderExtensions
 * @property {PermissionValue} [unitynet]          S37: the rules of the `unitynet` permission name.
 * @property {Record<string, PermissionAction>} [componentEditDeny]  S57: `BACKEND_EDIT_DENY`.
 * @property {Record<string, PermissionAction>} [componentReadDeny]  S57: `BACKEND_READ_DENY`.
 * @property {Record<string, PermissionAction>} [componentBashDeny]  S57: package-manager denies.
 * @property {Record<string, PermissionAction>} [componentBashAllow] S57: per-component verify commands.
 * @property {string} [networkBlock]               S37: the fetched-content prompt block.
 * @property {string} [mcpToolsBlock]              S61: the admitted-MCP-tools prompt block.
 */

/**
 * `PROTECTED_EDIT` with the user's and the component steps' extra globs appended, so a later rule can
 * only ever add a deny.
 * @param {SafetyGlobs} [safety]
 * @param {RenderExtensions} [extensions]
 * @returns {Record<string, PermissionAction>}
 */
export function buildProtectedEdit(safety = {}, extensions = {}) {
  return {
    ...denyAll(PROTECTED_EDIT_GLOBS),
    ...denyAll(safety.extraProtectedEditGlobs ?? []),
    ...(extensions.componentEditDeny ?? {}),
  };
}

/**
 * `PROTECTED_READ`. The `*.env.example` allow is rendered after the `*.env.*` deny so it wins, and the
 * component fragment comes last because amendment 37.9 ends it with its own allow rows.
 * @param {SafetyGlobs} [safety]
 * @param {RenderExtensions} [extensions]
 * @returns {Record<string, PermissionAction>}
 */
export function buildProtectedRead(safety = {}, extensions = {}) {
  return {
    ...denyAll(PROTECTED_READ_GLOBS),
    [PROTECTED_READ_ALLOW_GLOB]: 'allow',
    ...denyAll(safety.extraProtectedReadGlobs ?? []),
    ...(extensions.componentReadDeny ?? {}),
  };
}

/**
 * Config-level rules, which apply to every agent including the built-ins and compaction (spec 8.5.2).
 * @param {object} [input]
 * @param {SafetyGlobs} [input.safety]
 * @param {RenderExtensions} [input.extensions]
 * @returns {PermissionBlock}
 */
export function buildConfigLevelPermission({ safety = {}, extensions = {} } = {}) {
  return {
    '*_*': 'deny',
    task: 'deny',
    todowrite: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    skill: 'deny',
    question: 'deny',
    doom_loop: 'deny',
    external_directory: { '*': 'deny' },
    bash: { '*': 'deny' },
    read: buildProtectedRead(safety, extensions),
    edit: buildProtectedEdit(safety, extensions),
    ...(extensions.unitynet ? { unitynet: extensions.unitynet } : {}),
  };
}

/**
 * @typedef {object} UnityCodePermissionInput
 * @property {string | null} [vcsKind]        Detected VCS, or null/`none`.
 * @property {'allowlist' | 'ask'} [bashMode] `ask` replaces the bash `*` deny with `ask` (spec 8.5.2).
 * @property {string[]} [csprojNames]         One allow per csproj in the compile map.
 * @property {SafetyGlobs} [safety]
 * @property {readonly string[]} [mcpTools]   Admitted MCP tool ids (amendment 38.6a); empty by default.
 * @property {RenderExtensions} [extensions]
 */

/**
 * Agent-level rules for `unity-code` (spec 8.5.2). `*_*` is first so the explicit rules after it win,
 * which is what lets an admitted MCP tool id escape the blanket MCP deny.
 * @param {UnityCodePermissionInput} [input]
 * @returns {PermissionBlock}
 */
export function buildUnityCodePermission({
  vcsKind = null,
  bashMode = 'allowlist',
  csprojNames = [],
  safety = {},
  mcpTools = [],
  extensions = {},
} = {}) {
  return {
    '*_*': 'deny',
    ...allowAll(mcpTools),
    task: 'deny',
    todowrite: 'deny',
    webfetch: 'deny',
    skill: 'deny',
    question: 'deny',
    doom_loop: 'deny',
    external_directory: { '*': 'deny' },
    read: { [MCP_RESOURCE_DENY_PATTERN]: 'deny', ...buildProtectedRead(safety, extensions) },
    edit: buildProtectedEdit(safety, extensions),
    bash: buildBashPermission({ vcsKind, bashMode, csprojNames, extensions }),
    ...(extensions.unitynet ? { unitynet: extensions.unitynet } : {}),
  };
}

/**
 * @param {object} input
 * @param {string | null} input.vcsKind
 * @param {'allowlist' | 'ask'} input.bashMode
 * @param {string[]} input.csprojNames
 * @param {RenderExtensions} input.extensions
 * @returns {Record<string, PermissionAction>}
 */
export function buildBashPermission({ vcsKind, bashMode, csprojNames, extensions }) {
  return {
    '*': bashMode === 'ask' ? 'ask' : 'deny',
    ...VCS_WRITE_DENY,
    ...denyAll(DESTRUCTIVE_DENY_PATTERNS),
    ...(extensions.componentBashDeny ?? {}),
    'dotnet --version': 'allow',
    ...allowAll(csprojNames.map((csproj) => `dotnet build ${csproj} *`)),
    ...allowAll(getReadOnlyAllowPatterns(vcsKind)),
    ...(extensions.componentBashAllow ?? {}),
  };
}

/**
 * Agent-level rules for `unity-editor` (spec 8.5.2). Rendered only when the project enables it.
 * @param {object} [input]
 * @param {boolean} [input.trust]  True lets the two Editor-changing tools run without asking.
 * @returns {PermissionBlock}
 */
export function buildUnityEditorPermission({ trust = false } = {}) {
  /** @type {PermissionAction} */
  const trusted = trust ? 'allow' : 'ask';
  return {
    '*': 'deny',
    ...allowAll(EDITOR_READ_ONLY_TOOLS),
    ...Object.fromEntries(EDITOR_TRUSTED_TOOLS.map((tool) => [tool, trusted])),
    read: { '*': 'deny', 'mcp:unityMCP:*': 'allow' },
  };
}

/**
 * @typedef {object} OpencodeJsoncInput
 * @property {string} modelTag
 * @property {PermissionBlock} permission
 * @property {string} [version]
 * @property {number} [toolOutputMaxLines]
 * @property {number} [toolOutputMaxBytes]
 * @property {string} [template]
 */

/**
 * The static profile config (spec 8.3). There is deliberately no `provider` block: the plugin injects
 * it, so a plugin that fails to load leaves the model unresolvable instead of silently unguarded (D3).
 * @param {OpencodeJsoncInput} input
 * @returns {string}
 */
export function renderOpencodeJsonc({
  modelTag,
  permission,
  version = CLI_VERSION,
  toolOutputMaxLines = TOOL_OUTPUT_MAX_LINES,
  toolOutputMaxBytes = TOOL_OUTPUT_MAX_BYTES,
  template = readTemplate(OPENCODE_JSONC_TEMPLATE_URL),
}) {
  return fillTemplate(template, {
    version,
    modelTag,
    toolOutputMaxLines: String(toolOutputMaxLines),
    toolOutputMaxBytes: String(toolOutputMaxBytes),
    configLevelPermission: indentJson(permission, 2),
  });
}

/**
 * The config object `opencode.jsonc` renders, for key checking and for tests that compare values
 * rather than bytes. Keep it equal to the template.
 * @param {Omit<OpencodeJsoncInput, 'template' | 'version'>} input
 * @returns {Record<string, unknown>}
 */
export function buildOpencodeConfig({
  modelTag,
  permission,
  toolOutputMaxLines = TOOL_OUTPUT_MAX_LINES,
  toolOutputMaxBytes = TOOL_OUTPUT_MAX_BYTES,
}) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    lsp: false,
    enabled_providers: [PROVIDER_ID],
    model: `${PROVIDER_ID}/${modelTag}`,
    small_model: `${PROVIDER_ID}/${modelTag}`,
    default_agent: DEFAULT_AGENT,
    compaction: { auto: true, prune: true },
    tool_output: { max_lines: toolOutputMaxLines, max_bytes: toolOutputMaxBytes },
    agent: { build: { disable: true }, plan: { disable: true }, title: { disable: true } },
    permission,
  };
}

/**
 * @typedef {object} Sampling
 * @property {number} temperature
 * @property {number} topP
 */

/**
 * @typedef {object} AgentRenderInput
 * @property {Sampling} sampling
 * @property {boolean} [editorAgent]   Adds the `/ue` block (spec 8.6 section 8).
 * @property {RenderExtensions} [extensions]
 * @property {string} [template]
 */

/** The `/ue` block, rendered only when the editor agent is enabled for the project (spec 8.6). */
export const EDITOR_PROMPT_BLOCK = ['# Editor checks', '', 'For console output or EditMode tests, suggest `/ue <goal>` instead of guessing.'].join('\n');

/**
 * `agents/unity-code.md` (spec 8.6). The file carries prompt and sampling only; permissions come from
 * the per-launch content, so the rule order is defined in exactly one place.
 * @param {AgentRenderInput} input
 * @returns {string}
 */
export function renderUnityCodeAgent({ sampling, editorAgent = false, extensions = {}, template = readTemplate(UNITY_CODE_TEMPLATE_URL) }) {
  return fillTemplate(template, {
    temperature: formatNumber(sampling.temperature),
    topP: formatNumber(sampling.topP),
    editorBlock: optionalBlock(editorAgent ? EDITOR_PROMPT_BLOCK : ''),
    mcpToolsBlock: optionalBlock(extensions.mcpToolsBlock ?? ''),
    networkBlock: optionalBlock(extensions.networkBlock ?? ''),
  });
}

/**
 * `agents/unity-editor.md` (spec 8.6).
 * @param {{ sampling: Sampling, template?: string }} input
 * @returns {string}
 */
export function renderUnityEditorAgent({ sampling, template = readTemplate(UNITY_EDITOR_TEMPLATE_URL) }) {
  return fillTemplate(template, { temperature: formatNumber(sampling.temperature), topP: formatNumber(sampling.topP) });
}

/**
 * `commands/compile.md` (spec 8.6). Static: the compile commands themselves live in the project facts.
 * @param {{ template?: string }} [input]
 * @returns {string}
 */
export function renderCompileCommand({ template = readTemplate(COMPILE_COMMAND_TEMPLATE_URL) } = {}) {
  return template;
}

/**
 * Every asset a profile directory holds, keyed by its path relative to that directory.
 * @param {object} input
 * @param {string} input.modelTag
 * @param {Sampling} input.sampling
 * @param {PermissionBlock} input.permission
 * @param {boolean} [input.editorAgent]
 * @param {string} [input.version]
 * @param {RenderExtensions} [input.extensions]
 * @returns {Record<string, string>}
 */
export function renderProfileAssets({ modelTag, sampling, permission, editorAgent = false, version = CLI_VERSION, extensions = {} }) {
  return {
    'opencode.jsonc': renderOpencodeJsonc({ modelTag, permission, version }),
    'agents/unity-code.md': renderUnityCodeAgent({ sampling, editorAgent, extensions }),
    'agents/unity-editor.md': renderUnityEditorAgent({ sampling }),
    'commands/compile.md': renderCompileCommand(),
  };
}

/** Paths whose keys are chosen by the user or by us, not by OpenCode's schema. */
export const MAP_KEY_PATHS = Object.freeze(['agent', 'mcp', 'command', 'provider']);

/** Below these paths the keys are match patterns, so they are values and not schema keys (spec 8.9). */
export const OPAQUE_KEY_PATHS = Object.freeze(['permission']);

/**
 * Dotted key paths of a rendered config, with map keys collapsed to `*`, for the schema-key check of
 * spec 8.9. OpenCode drops unknown keys silently, so a typo here is invisible without this list.
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function listSchemaKeyPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  /** @type {string[]} */
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const isMapKey = MAP_KEY_PATHS.includes(lastSegment(prefix));
    const path = prefix ? `${prefix}.${isMapKey ? '*' : key}` : key;
    if (!paths.includes(path)) paths.push(path);
    if (!OPAQUE_KEY_PATHS.includes(lastSegment(path))) paths.push(...listSchemaKeyPaths(child, path));
  }
  return [...new Set(paths)];
}

/**
 * @param {string[]} paths
 * @param {readonly string[]} allowList  From `schema-keys-1.18.31.json`.
 * @returns {string[]} Paths OpenCode would drop, in render order.
 */
export function findUnknownSchemaKeys(paths, allowList) {
  const known = new Set(allowList);
  return paths.filter((path) => !known.has(path));
}

/**
 * @param {string} url
 * @returns {string}
 */
function lastSegment(url) {
  const index = url.lastIndexOf('.');
  return index === -1 ? url : url.slice(index + 1);
}

/**
 * @param {URL} url
 * @returns {string}
 */
export function readTemplate(url) {
  return fs.readFileSync(url, 'utf8');
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) throw new TypeError(`The template uses {{${key}}}, which the renderer does not supply`);
    return values[key];
  });
}

/**
 * An optional prompt section renders as a blank line, the block, and a newline, so an absent block
 * leaves the surrounding text byte-identical.
 * @param {string} block
 * @returns {string}
 */
function optionalBlock(block) {
  const text = block.trim();
  return text ? `\n${text}\n` : '';
}

/**
 * JSON.stringify keeps insertion order, which is the rule order OpenCode evaluates.
 * @param {unknown} value
 * @param {number} indent  Spaces added to every line after the first.
 * @returns {string}
 */
export function indentJson(value, indent) {
  const padding = ' '.repeat(indent);
  return JSON.stringify(value, null, 2).split('\n').join(`\n${padding}`);
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/**
 * @param {readonly string[]} patterns
 * @returns {Record<string, PermissionAction>}
 */
function denyAll(patterns) {
  return Object.fromEntries(patterns.map((pattern) => [pattern, 'deny']));
}

/**
 * @param {readonly string[]} patterns
 * @returns {Record<string, PermissionAction>}
 */
function allowAll(patterns) {
  return Object.fromEntries(patterns.map((pattern) => [pattern, 'allow']));
}
