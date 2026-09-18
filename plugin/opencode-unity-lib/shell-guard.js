// The shell guard the plugin installs on `tool.execute.before` (spec 8.7, 8.7.1). It holds the
// per-project inputs the classifier needs — the detected VCS, the protected globs and the local MCP
// hub — and turns a deny into the Error OpenCode hands back to the model as the tool result (C3).
//
// It is defense in depth behind the permission rules, not a replacement for them: an allowed command
// still runs a program that can do anything (S14).
//
// It also picks the shell family the classifier reads the command with (amendment 33.7). The platform
// alone is not enough: OpenCode prefers pwsh, then powershell, then bash on Windows (claim 146), and
// bash read with PowerShell's rules is weaker than either - a backslash escape joins two words there,
// so `g\it push` would reach the shell as a version control write that the classifier never saw.
import { PROTECTED_EDIT_GLOBS } from './protected-paths.js';
import { classifyShellCommand, familyForShell, getDefaultFamily } from './shell-classify.js';

export const SHELL_GUARD_PREFIX = 'opencode-unity shell guard:';

/** Tool ids that run a shell command; `bash` is the id in OpenCode 1.18.31 (C3). */
export const SHELL_TOOL_IDS = Object.freeze(['bash', 'shell']);

// PROTECTED_EDIT of spec 8.5.2, re-exported under the name the guard and the renderer already use. The
// table itself sits in `protected-paths.js` beside the read table, which the workspace scanner needs
// too, so no boundary can restate a glob and drift.
export { PROTECTED_EDIT_GLOBS };

/**
 * @typedef {object} ShellGuardOptions
 * @property {string | null} [vcsKind]              `vcs.kind` from project.json, or null when none was detected.
 * @property {string | null} [mcpHubUrl]            Hub URL from local.json; HTTP clients may not reach it.
 * @property {string[]} [extraProtectedEditGlobs]   `safety.extraProtectedEditGlobs` from the runtime profile.
 * @property {string[]} [blockedPrograms]           Extra denied first tokens (the network list of S36).
 * @property {string[]} [allowExactCommands]        Verify commands, allowed by full-string equality only.
 * @property {import('./shell-classify.js').ShellFamily} [family]
 * @property {string | null} [shell]                The shell OpenCode runs the command with, when it is known.
 * @property {string} [platform]
 */

/**
 * @typedef {object} ShellGuard
 * @property {(command: string) => import('./shell-classify.js').ShellClassification} classify
 * @property {(args: unknown) => import('./shell-classify.js').ShellClassification} check  Throws on a deny.
 * @property {import('./shell-classify.js').ShellFamily} family
 */

/**
 * @param {ShellGuardOptions} [options]
 * @returns {ShellGuard}
 */
export function createShellGuard({
  vcsKind = null,
  mcpHubUrl = null,
  extraProtectedEditGlobs = [],
  blockedPrograms = [],
  allowExactCommands = [],
  family,
  shell = null,
  platform = process.platform,
} = {}) {
  const resolvedFamily = selectShellFamily({ family, shell, platform });
  const classifyOptions = {
    family: resolvedFamily,
    vcsKind,
    protectedWriteGlobs: [...PROTECTED_EDIT_GLOBS, ...extraProtectedEditGlobs],
    mcpHub: parseHubEndpoint(mcpHubUrl),
    blockedPrograms,
    allowExactCommands,
  };
  return {
    family: resolvedFamily,
    classify: (command) => classifyShellCommand(command, classifyOptions),
    check(args) {
      const command = readCommand(args);
      const result = classifyShellCommand(command, classifyOptions);
      if (result.decision === 'deny') throw createShellGuardError(result);
      return result;
    },
  };
}

/**
 * The family the classifier reads a command with. A caller that states the family outright wins,
 * because a test and a rendered profile both mean exactly what they say; a shell this product models
 * picks its own family next; and only then does the platform decide. An unrecognised shell falls back
 * to the platform rather than to a guess, and the POSIX family is already the union of the POSIX
 * shells, so the fallback never reads a command with rules looser than the shell's own.
 * @param {{ family?: import('./shell-classify.js').ShellFamily, shell?: string | null, platform?: string }} [input]
 * @returns {import('./shell-classify.js').ShellFamily}
 */
export function selectShellFamily({ family, shell = null, platform = process.platform } = {}) {
  return family ?? familyForShell(shell) ?? getDefaultFamily(platform);
}

/**
 * The tool result the model reads. It never repeats the command, because the session log and the
 * model transcript both stay free of file content (P5). The deny code rides on the Error, so a caller
 * that logs the refusal logs the code rather than a message that can name the model's own arguments.
 * @param {import('./shell-classify.js').ShellClassification} result
 * @returns {Error & { code: import('./shell-classify.js').ShellDenyCode | null }}
 */
export function createShellGuardError(result) {
  const reason = result.reason ?? 'the command is not allowed';
  const error = /** @type {Error & { code: import('./shell-classify.js').ShellDenyCode | null }} */ (new Error(`${SHELL_GUARD_PREFIX} ${reason}. ${describeNextStep(result.code)}`));
  error.code = result.code;
  return error;
}

/**
 * @param {string} toolId
 * @returns {boolean}
 */
export function isShellTool(toolId) {
  return SHELL_TOOL_IDS.includes(toolId);
}

/**
 * @param {string | null} url
 * @returns {{ host: string, port: string } | null}
 */
export function parseHubEndpoint(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return null;
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} args
 * @returns {string}
 */
function readCommand(args) {
  const value = /** @type {{ command?: unknown } | null} */ (args)?.command;
  return typeof value === 'string' ? value : '';
}

/**
 * @param {import('./shell-classify.js').ShellDenyCode | null} code
 * @returns {string}
 */
function describeNextStep(code) {
  switch (code) {
    case 'shell_unmodelled':
    case 'shell_no_command_node':
    case 'shell_unparsable':
      return 'Run one plain command with plain arguments instead.';
    case 'shell_wrapper':
      return 'Run the inner command directly.';
    case 'shell_vcs_write':
      return 'Ask the human to run version control commands.';
    case 'shell_recursive_delete':
      return 'Ask the human to delete directories.';
    case 'shell_protected_write':
      return 'Change C# source instead, and ask the human for asset changes.';
    case 'shell_network_hub':
      return 'Use the editor agent for Unity editor checks.';
    default:
      return 'Use the file and build tools instead.';
  }
}
