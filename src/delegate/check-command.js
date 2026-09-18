// The check command that runs after `delegate apply` (spec 12.2, 12.3).
//
// A host agent may hold a standing approval for `opencode-unity delegate ...`, so an arbitrary check
// command would be an unreviewed shell. A command must therefore start with an allowed prefix, be one
// plain command without shell operators, and it is executed without a shell.
import path from 'node:path';
import { usageError } from '../cli/exit-codes.js';
import { runProcess } from '../core/exec.js';
import { lookupCompileRow } from '../facts/compile-map.js';
import { toPosix } from './sensitive.js';

// Outside double quotes these start a second command, a pipe or a redirect in every shell family.
const SHELL_OPERATORS = /[&|<>;()]/;
// Anywhere: a line break is a command separator, and a backtick or `$(` is a substitution.
const FORBIDDEN_ANYWHERE = /[`\r\n\0]|\$\(/;
// MSBuild switches that can run a command or load an assembly while the build runs.
const MSBUILD_CODE_SWITCHES = /^"?[-/]{1,2}(p|property|l|logger|dl|distributedlogger)[:=]/i;
const MSBUILD_CODE_SWITCH_WORDS = /^"?--?(property|logger)"?$/i;

/**
 * @typedef {object} CheckCommand
 * @property {string} text   The command as written, for messages and records.
 * @property {string} file   Executable.
 * @property {string[]} args
 */

/**
 * @param {string} command
 * @param {readonly string[]} prefixes
 * @returns {CheckCommand}
 */
export function validateCheckCommand(command, prefixes) {
  const text = String(command).trim();
  const refuse = (/** @type {string} */ reason) => {
    throw usageError(
      `--check refused: ${reason}. It must be one plain command starting with ${prefixes.map((prefix) => `'${prefix.trim()}'`).join(', ')} ` +
        '(delegate.checkCommandPrefixes in config.json).',
    );
  };
  if (text === '') refuse('it is empty');
  if (!prefixes.some((prefix) => text === prefix.trim() || text.startsWith(`${prefix.trim()} `))) refuse('it does not start with an allowed prefix');
  const forbidden = FORBIDDEN_ANYWHERE.exec(text);
  if (forbidden) refuse(`it contains ${JSON.stringify(forbidden[0])}`);
  const argv = splitCommand(text, refuse);
  for (const word of text.split(/\s+/)) {
    if (MSBUILD_CODE_SWITCHES.test(word) || MSBUILD_CODE_SWITCH_WORDS.test(word)) {
      refuse(`the switch ${JSON.stringify(word.replace(/"/g, ''))} can run commands or load code during the build`);
    }
  }
  return { text, file: argv[0], args: argv.slice(1) };
}

/**
 * `--check auto`: the compile commands of the assemblies that own the changed files (spec 9.3, 12.3).
 * @param {object} input
 * @param {readonly string[]} input.changedPaths   Paths relative to the working directory.
 * @param {readonly import('../facts/compile-map.js').CompileRow[]} input.compileMap
 * @param {string} input.cwd
 * @param {string} input.projectRoot
 * @param {readonly string[]} input.prefixes
 * @returns {CheckCommand[]}
 */
export function resolveAutoCheck({ changedPaths, compileMap, cwd, projectRoot, prefixes }) {
  if (compileMap.length === 0) {
    throw usageError("--check auto needs the project facts; run 'opencode-unity init' for this project first");
  }
  /** @type {Map<string, CheckCommand>} */
  const commands = new Map();
  /** @type {string[]} */
  const unmapped = [];
  for (const changedPath of changedPaths) {
    const absolute = path.resolve(cwd, changedPath);
    const projectRelative = toPosix(path.relative(projectRoot, absolute));
    if (projectRelative === '' || projectRelative.startsWith('../') || path.isAbsolute(projectRelative)) {
      unmapped.push(changedPath);
      continue;
    }
    const row = lookupCompileRow(/** @type {import('../facts/compile-map.js').CompileRow[]} */ (compileMap), projectRelative);
    if (!row) {
      unmapped.push(changedPath);
      continue;
    }
    if (!commands.has(row.csproj)) commands.set(row.csproj, validateCheckCommand(row.command, prefixes));
  }
  if (commands.size === 0) {
    throw usageError(`--check auto found no compile command for ${unmapped.join(', ')}; pass an explicit --check "<command>"`);
  }
  return [...commands.values()];
}

/**
 * @typedef {object} CheckResult
 * @property {CheckCommand} command
 * @property {number | null} exitCode
 * @property {string} output      stdout and stderr, in the order they were produced per stream.
 * @property {boolean} timedOut
 * @property {boolean} ok
 */

/**
 * Runs the checks in order and stops at the first failure.
 * @param {readonly CheckCommand[]} commands
 * @param {{ cwd: string, timeoutMs: number, signal?: AbortSignal, onSpawn?: import('../core/exec.js').RunOptions['onSpawn'], env?: Record<string, string | undefined> }} options
 * @returns {Promise<CheckResult[]>}
 */
export async function runCheckCommands(commands, { cwd, timeoutMs, signal, onSpawn, env }) {
  /** @type {CheckResult[]} */
  const results = [];
  for (const command of commands) {
    const run = await runProcess(command.file, command.args, { cwd, timeoutMs, signal, onSpawn, env });
    const parts = [run.stdout, run.stderr].filter((part) => part !== '');
    let output = parts.join('\n');
    if (run.error) output += `\n[could not start '${command.file}' in ${cwd}: ${run.error.message}]`;
    if (run.timedOut) output += `\n[stopped after the ${Math.round(timeoutMs / 1000)} s check timeout]`;
    const exitCode = run.error ? null : run.exitCode;
    results.push({ command, exitCode, output, timedOut: run.timedOut, ok: exitCode === 0 && !run.timedOut });
    if (!results[results.length - 1].ok) break;
  }
  return results;
}

/**
 * Splits a validated command into argv. Double quotes group a value and are removed; there is no shell,
 * so nothing else is expanded.
 * @param {string} text
 * @param {(reason: string) => never} refuse
 * @returns {string[]}
 */
function splitCommand(text, refuse) {
  /** @type {string[]} */
  const argv = [];
  let current = '';
  let hasCurrent = false;
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      hasCurrent = true;
      continue;
    }
    if (!quoted && SHELL_OPERATORS.test(char)) refuse(`it contains the shell operator ${JSON.stringify(char)} outside double quotes`);
    if (!quoted && /\s/.test(char)) {
      if (hasCurrent) argv.push(current);
      current = '';
      hasCurrent = false;
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (quoted) refuse('its double quotes are not balanced');
  if (hasCurrent) argv.push(current);
  if (argv.length === 0) refuse('it is empty');
  return argv;
}
