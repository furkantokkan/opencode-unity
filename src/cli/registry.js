// The CLI surface (spec sections 5.1, 5.4, 5.5 and 12.2) as data. The parser, help and the generated
// CLI reference all read this table, so a flag exists in exactly one place.
//
// Extension point for command modules: each command lives in `src/commands/<name>.js` and exports
//
//   /** @param {import('../cli/main.js').CommandContext} context */
//   export async function run(context) { return { message, data, warnings, exitCode, code }; }
//
// Every field of the returned object is optional; `undefined` means success. Expected failures throw
// `CliError` from `src/cli/exit-codes.js`. A module that does not exist yet makes its command exit 8
// with code `command_not_available`, so the CLI works while the build is still in progress.
import fs from 'node:fs';
import { CliError, EXIT } from './exit-codes.js';

/**
 * @typedef {'boolean'|'string'|'integer'|'number'|'list'|'variadic'} OptionType
 * - boolean:  `--flag`
 * - string:   `--flag <value>` or `--flag=<value>`
 * - integer, number: numeric value checked against `min` and `max`
 * - list:     comma-separated values (`--delegate claude,codex`); repeating the flag appends
 * - variadic: every following value up to the next option (`--files a.cs b.cs`); repeating appends
 */

/**
 * @typedef {object} OptionSpec
 * @property {string} name               Flag name without dashes, for example 'dry-run'.
 * @property {OptionType} type
 * @property {string} description
 * @property {string} [valueName]        Placeholder in help, for example 'path'.
 * @property {readonly string[]} [choices]
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [required]
 */

/**
 * @typedef {object} PositionalSpec
 * @property {string} name
 * @property {string} description
 * @property {boolean} [required]
 * @property {readonly string[]} [choices]
 */

/**
 * @typedef {object} SubcommandSpec
 * @property {string} name
 * @property {string} summary
 * @property {readonly OptionSpec[]} options
 * @property {readonly PositionalSpec[]} positionals
 */

/**
 * @typedef {object} CommandSpec
 * @property {string} name
 * @property {'everyday'|'advanced'} group
 * @property {string} summary                      One line for the command list.
 * @property {string} [description]                Extra paragraph for command help.
 * @property {string} module                       Module path relative to this file.
 * @property {readonly OptionSpec[]} options
 * @property {readonly PositionalSpec[]} positionals
 * @property {readonly SubcommandSpec[]} [subcommands]
 * @property {Readonly<Record<string, string>>} [refusedOptions]  Flag name -> reason; the flag exits 1.
 * @property {readonly NodeJS.Platform[]} [platforms]             Fallback gate for a command the support
 *   matrix does not name. Every shipped command is in `src/core/tiers.json`, which decides instead
 *   (amendment 33.4), so this field is empty here and exists for a command added without a matrix row.
 * @property {PlatformRefusal} [platformRefusal]   Envelope shape when the matrix refuses this command
 *   on this machine. Defaults to `unsupported_platform` with no extra data.
 * @property {readonly number[]} exitCodes
 */

/**
 * A command whose caller is a program rather than a person states the code and the fields that caller
 * needs, so the refusal reads the same whether the matrix or the command itself produced it.
 * @typedef {object} PlatformRefusal
 * @property {string} code
 * @property {Readonly<Record<string, unknown>>} [data]  Merged beside `data.platform`.
 */

/** @type {readonly OptionSpec[]} */
export const GLOBAL_OPTIONS = Object.freeze([
  { name: 'json', type: 'boolean', description: 'Print a JSON envelope on stdout; human text goes to stderr' },
  { name: 'yes', type: 'boolean', description: 'Accept the recommended consent answers in non-interactive runs' },
  { name: 'dry-run', type: 'boolean', description: 'Print the plan and manifest entries; write nothing' },
  { name: 'project', type: 'string', valueName: 'dir', description: 'Unity project to act on' },
  { name: 'experimental', type: 'boolean', description: 'Allow experimental platforms, versions and presets' },
  { name: 'verbose', type: 'boolean', description: 'More output, including stack traces on errors' },
  { name: 'no-color', type: 'boolean', description: 'Plain output without colors' },
  { name: 'help', type: 'boolean', description: 'Show help' },
  { name: 'version', type: 'boolean', description: 'Show the version' },
  { name: 'print-platform', type: 'boolean', description: 'Print detected platform facts and command support tiers without starting a model' },
]);

const PATH_POSITIONAL = Object.freeze({ name: 'path', description: 'Project directory (default: --project or the current directory)' });

const AUTO_APPROVAL_REASON =
  'start refuses auto-approval flags: dangerous actions are denied and every remaining ask must reach you';

/** @type {readonly OptionSpec[]} */
const HOST_OPTIONS = [
  { name: 'host', type: 'list', choices: ['claude', 'codex', 'auto'], required: true, description: 'Host skills to manage' },
  { name: 'host-home', type: 'string', valueName: 'dir', description: 'Host home directory (default: the user home)' },
];

/** @type {readonly CommandSpec[]} */
export const COMMANDS = Object.freeze([
  {
    name: 'host', group: 'advanced', module: '../commands/host.js',
    summary: 'Install, verify, update or remove managed Claude and Codex skills',
    positionals: [], options: [],
    subcommands: ['install', 'verify', 'update', 'uninstall'].map((name) => ({ name, summary: `${name} the selected host skills`, positionals: [], options: HOST_OPTIONS })),
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.VALIDATION, EXIT.CHECK_FAILED, EXIT.RUNTIME, EXIT.CONSENT_REQUIRED, EXIT.INTERRUPTED],
  },
  {
    name: 'shape',
    group: 'everyday',
    summary: 'Check a request and, when needed, rewrite it once with the guarded local model',
    description: 'Returns the original request if rewriting fails. Writes no files. --no-model checks readiness without calling Ollama.',
    module: '../commands/shape.js',
    positionals: [{ name: 'text', required: true, description: 'Request text, @file, or - for standard input' }],
    options: [{ name: 'no-model', type: 'boolean', description: 'Check readiness without calling the model' }],
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.RUNTIME, EXIT.UNSUPPORTED],
  },
  {
    name: 'doctor',
    group: 'everyday',
    summary: 'Diagnose an OpenCode + Ollama setup without loading a model',
    description: 'Static analysis by default. Only --deep, --capture and --selftest start OpenCode, and they say so first.',
    module: '../commands/doctor.js',
    positionals: [PATH_POSITIONAL],
    options: [
      { name: 'profile', type: 'boolean', description: 'Analyze the opencode-unity clean-room profile for this project' },
      { name: 'deep', type: 'boolean', description: 'Also run opencode debug config and debug agent' },
      { name: 'capture', type: 'boolean', description: 'Capture redacted request metadata with real OpenCode and a local mock endpoint' },
      { name: 'selftest', type: 'boolean', description: 'Run bounded mock end-to-end scenarios with the installed OpenCode' },
      { name: 'logs', type: 'string', valueName: 'path', description: 'Ollama server log to read' },
      { name: 'markdown', type: 'boolean', description: 'Issue-ready report (implies --redact)' },
      { name: 'redact', type: 'boolean', description: 'Remove user, machine, path, project, email and key values' },
      { name: 'strict', type: 'boolean', description: 'Warnings also fail' },
      { name: 'explain', type: 'string', valueName: 'check-id', description: "Print one check's rationale and fix" },
    ],
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.CHECK_FAILED, EXIT.RUNTIME, EXIT.UNSUPPORTED],
  },
  {
    name: 'setup',
    group: 'everyday',
    summary: 'Install the clean-room profile and the local model, asking before each change',
    module: '../commands/setup.js',
    positionals: [],
    options: [
      { name: 'preset', type: 'string', valueName: 'id', description: 'Model preset (default: recommended from detected VRAM)' },
      { name: 'no-model', type: 'boolean', description: 'Skip the model pull and create' },
      { name: 'ollama-env', type: 'boolean', description: 'Preselect the Ollama server environment item' },
      { name: 'terminal', type: 'boolean', description: 'Preselect the Windows Terminal fragment' },
      { name: 'host', type: 'list', valueName: 'ids', choices: ['claude', 'codex', 'antigravity', 'auto'], description: 'Install managed Claude/Codex skills; Antigravity prints manual installation guidance' },
      { name: 'delegate', type: 'list', valueName: 'targets', choices: ['claude', 'codex'], description: 'Deprecated alias of --host' },
      { name: 'migrate', type: 'boolean', description: 'Migrate an earlier installation (used by upgrade)' },
    ],
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.BLOCKED, EXIT.VALIDATION, EXIT.RUNTIME, EXIT.UNSUPPORTED, EXIT.CONSENT_REQUIRED],
  },
  {
    name: 'init',
    group: 'everyday',
    summary: 'Scan a Unity project (read-only) and write its facts',
    module: '../commands/init.js',
    positionals: [PATH_POSITIONAL],
    options: [
      { name: 'editor', type: 'boolean', description: 'Enable the editor-check agent (needs MCP for Unity)' },
      { name: 'in-project', type: 'boolean', description: 'Write the facts into the project under .opencode-unity/' },
      { name: 'refresh', type: 'boolean', description: 'Scan again' },
      { name: 'print', type: 'boolean', description: 'Print the facts only' },
    ],
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.RUNTIME, EXIT.CONSENT_REQUIRED],
  },
  {
    name: 'start',
    group: 'everyday',
    summary: 'Launch OpenCode for a Unity project in the clean room',
    module: '../commands/start.js',
    positionals: [PATH_POSITIONAL],
    options: [
      { name: 'agent', type: 'string', valueName: 'name', choices: ['unity-code', 'unity-editor'], description: 'Agent to open' },
      { name: 'warm', type: 'boolean', description: 'Guarded warm-up before launch' },
      { name: 'no-pane', type: 'boolean', description: 'No Windows Terminal status pane' },
      { name: 'no-project-config', type: 'boolean', description: 'Ignore project opencode.json and .opencode folders' },
      { name: 'print-env', type: 'boolean', description: 'Print the launch environment and content; do not launch' },
      { name: 'continue', type: 'boolean', description: 'Forwarded to OpenCode' },
      { name: 'session', type: 'string', valueName: 'id', description: 'Forwarded to OpenCode' },
      { name: 'prompt', type: 'string', valueName: 'text', description: 'Forwarded to OpenCode' },
    ],
    refusedOptions: {
      auto: AUTO_APPROVAL_REASON,
      yolo: AUTO_APPROVAL_REASON,
      'dangerously-skip-permissions': AUTO_APPROVAL_REASON,
    },
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.BLOCKED, EXIT.VALIDATION, EXIT.RUNTIME, EXIT.UNSUPPORTED],
  },
  {
    name: 'status',
    group: 'advanced',
    summary: 'Show model, VRAM, guard, lock and session state',
    module: '../commands/status.js',
    positionals: [],
    options: [
      { name: 'watch', type: 'boolean', description: 'Refresh continuously' },
      { name: 'interval', type: 'integer', valueName: 'seconds', min: 1, max: 3600, description: 'Refresh interval (default 10)' },
    ],
    exitCodes: [EXIT.OK, EXIT.BLOCKED, EXIT.RUNTIME],
  },
  {
    name: 'guard',
    group: 'advanced',
    summary: 'Evaluate the GPU guard without loading a model',
    module: '../commands/guard.js',
    positionals: [],
    options: [{ name: 'cold', type: 'boolean', description: 'Ignore the loaded state' }],
    exitCodes: [EXIT.OK, EXIT.BLOCKED],
  },
  {
    name: 'warm',
    group: 'advanced',
    summary: 'Load the model after the guard passes',
    module: '../commands/warm.js',
    positionals: [],
    options: [{ name: 'keep-alive', type: 'string', valueName: 'duration', description: 'How long Ollama keeps the model loaded' }],
    exitCodes: [EXIT.OK, EXIT.BLOCKED, EXIT.LOCK_TIMEOUT, EXIT.RUNTIME],
  },
  {
    name: 'stop',
    group: 'advanced',
    summary: 'Unload the model to free VRAM',
    module: '../commands/stop.js',
    positionals: [],
    options: [],
    exitCodes: [EXIT.OK, EXIT.BLOCKED, EXIT.RUNTIME],
  },
  {
    name: 'bench',
    group: 'advanced',
    summary: 'Measure guarded local edits or run explicit mock protocol checks',
    module: '../commands/bench.js',
    positionals: [
      { name: 'suite', required: true, choices: ['toolcalls', 'edits', 'editor', 'guard', 'budget', 'all'], description: 'Benchmark suite' },
    ],
    options: [
      { name: 'runs', type: 'integer', valueName: 'n', min: 1, max: 1000, description: 'Runs per task (default 20)' },
      { name: 'temperature', type: 'number', valueName: 't', min: 0, max: 2, description: 'Sampling temperature override' },
      { name: 'mock', type: 'boolean', description: 'Run guard, budget or all protocol scenarios with real OpenCode and mock endpoints; no model reliability claim' },
    ],
    exitCodes: [EXIT.OK, EXIT.USAGE, EXIT.BLOCKED, EXIT.VALIDATION, EXIT.CHECK_FAILED, EXIT.RUNTIME, EXIT.UNSUPPORTED, EXIT.INTERRUPTED],
  },
  {
    name: 'delegate',
    group: 'advanced',
    summary: 'Hand bulk, low-ambiguity work to the guarded local model (Claude Code, Codex)',
    module: '../commands/delegate.js',
    positionals: [],
    options: [],
    subcommands: [
      { name: 'on', summary: 'Allow new delegated jobs (user-controlled, persistent)', positionals: [], options: [] },
      { name: 'off', summary: 'Refuse new delegated jobs without cancelling work already running', positionals: [], options: [] },
      { name: 'status', summary: 'Show the switches, active jobs and recent results without contacting Ollama', positionals: [], options: [] },
      {
        name: 'monitor', summary: 'Watch delegated jobs, or configure the optional Windows CMD window', positionals: [],
        options: [
          { name: 'window', type: 'boolean', description: 'Open one visible Windows CMD monitor and return' },
          { name: 'auto', type: 'string', valueName: 'on|off', choices: ['on', 'off'], description: 'Persist the automatic monitor-window preference (user-controlled)' },
          { name: 'interval', type: 'integer', valueName: 'seconds', min: 1, max: 3600, description: 'Watch interval (default 2)' },
        ],
      },
      { name: 'health', summary: 'Check Ollama, the model tag, the guard verdict and the lock holder', positionals: [], options: [] },
      {
        name: 'ask',
        summary: 'One request over the task and the named files',
        positionals: [],
        options: [
          { name: 'task', type: 'string', valueName: 'text|@file', required: true, description: 'Task text, or @file to read it from a file' },
          { name: 'files', type: 'variadic', valueName: 'paths...', description: 'Files passed as untrusted data' },
          { name: 'max-output', type: 'integer', valueName: 'n', min: 1, max: 1_000_000, description: 'Maximum output tokens' },
          { name: 'allow-sensitive', type: 'boolean', description: 'Allow files that match sensitive patterns' },
        ],
      },
      {
        name: 'map',
        summary: 'One request per file, then an optional reduce request',
        positionals: [],
        options: [
          { name: 'task', type: 'string', valueName: 'text|@file', required: true, description: 'Task text, or @file to read it from a file' },
          { name: 'files', type: 'variadic', valueName: 'paths|globs...', required: true, description: 'Files or globs to map over' },
          { name: 'reduce', type: 'string', valueName: 'instruction', description: 'Instruction for the reduce request' },
        ],
      },
      {
        name: 'edit',
        summary: 'Dry run: validated SEARCH/REPLACE blocks and a review id',
        positionals: [],
        options: [
          { name: 'task', type: 'string', valueName: 'text|@file', required: true, description: 'Task text, or @file to read it from a file' },
          { name: 'files', type: 'variadic', valueName: 'paths...', required: true, description: 'Files the edit may touch' },
          { name: 'check', type: 'string', valueName: 'auto|command', description: 'Check command to run after apply' },
        ],
      },
      {
        name: 'apply',
        summary: 'Apply exactly the reviewed blocks, then run the check',
        positionals: [{ name: 'reviewId', required: true, description: 'Review id printed by edit' }],
        options: [{ name: 'check', type: 'string', valueName: 'auto|command', description: 'Check command to run after apply' }],
      },
      {
        name: 'restore',
        summary: 'Restore the backups of a job',
        positionals: [{ name: 'jobId', required: true, description: 'Job id' }],
        options: [],
      },
      {
        name: 'ledger',
        summary: 'Job counts, local tokens and estimated source-input reduction before review overhead',
        positionals: [],
        options: [{ name: 'since', type: 'string', valueName: 'duration', description: 'Only jobs newer than this, for example 7d' }],
      },
    ],
    // The caller here is an orchestrator, and amendment 36.6 gives it one code and one action for
    // "delegation is not available on this machine", whichever layer decided that.
    platformRefusal: { code: 'delegate_unsupported', data: { orchestratorAction: 'do_it_yourself' } },
    exitCodes: [
      EXIT.OK, EXIT.USAGE, EXIT.BLOCKED, EXIT.BUDGET, EXIT.VALIDATION, EXIT.CHECK_FAILED, EXIT.LOCK_TIMEOUT, EXIT.RUNTIME, EXIT.UNSUPPORTED,
    ],
  },
  {
    name: 'upgrade',
    group: 'advanced',
    summary: 'Migrate the config and profile after a package update',
    module: '../commands/upgrade.js',
    positionals: [],
    options: [
      { name: 'rollback', type: 'boolean', description: 'Switch back to the previous profile' },
      { name: 'prune-models', type: 'boolean', description: 'Remove model tags of older presets' },
    ],
    exitCodes: [EXIT.OK, EXIT.VALIDATION, EXIT.RUNTIME, EXIT.CONSENT_REQUIRED],
  },
  {
    name: 'uninstall',
    group: 'advanced',
    summary: 'Remove what setup installed, from the install manifest',
    module: '../commands/uninstall.js',
    positionals: [],
    options: [
      { name: 'keep-data', type: 'boolean', description: 'Keep state and project facts' },
      { name: 'remove-models', type: 'boolean', description: 'Remove created model tags' },
      { name: 'remove-base-model', type: 'boolean', description: 'Also remove the base model if setup pulled it' },
      { name: 'projects', type: 'boolean', description: 'Also remove unchanged in-project folders' },
    ],
    exitCodes: [EXIT.OK, EXIT.VALIDATION, EXIT.RUNTIME, EXIT.CONSENT_REQUIRED],
  },
]);

/**
 * @param {string} name
 * @param {readonly CommandSpec[]} [commands]
 * @returns {CommandSpec | undefined}
 */
export function findCommand(name, commands = COMMANDS) {
  return commands.find((command) => command.name === name);
}

/**
 * @param {CommandSpec} command
 * @param {string} name
 * @returns {SubcommandSpec | undefined}
 */
export function findSubcommand(command, name) {
  return command.subcommands?.find((subcommand) => subcommand.name === name);
}

/**
 * @param {CommandSpec} command
 * @returns {URL}
 */
export function getCommandModuleUrl(command) {
  return new URL(command.module, import.meta.url);
}

/**
 * @param {CommandSpec} command
 * @returns {boolean}
 */
export function isCommandAvailable(command) {
  return fs.existsSync(getCommandModuleUrl(command));
}

/**
 * @typedef {object} CommandModule
 * @property {(context: import('./main.js').CommandContext) => Promise<import('./main.js').CommandResult | void> | import('./main.js').CommandResult | void} run
 */

/**
 * Loads a command module. A missing file is an expected state during the build (exit 8); a file that
 * exists but fails to import is a real defect and keeps its original error.
 * @param {CommandSpec} command
 * @returns {Promise<CommandModule>}
 */
export async function loadCommandModule(command) {
  if (!isCommandAvailable(command)) {
    throw new CliError(`'${command.name}' is not available in this build yet`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'command_not_available',
      data: { command: command.name },
    });
  }
  const module = await import(getCommandModuleUrl(command).href);
  if (typeof module.run !== 'function') {
    throw new CliError(`The module for '${command.name}' does not export run()`, { code: 'invalid_command_module' });
  }
  return module;
}
