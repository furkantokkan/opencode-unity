// Help text rendered from the registry. Commands are grouped under "Everyday" and "Advanced" (D15).
import { EXIT_CODES, getExitCodeInfo } from './exit-codes.js';
import { CLI_NAME, formatVersionLine } from './version.js';
import { COMMANDS, GLOBAL_OPTIONS, isCommandAvailable } from './registry.js';

/** @typedef {import('./registry.js').CommandSpec} CommandSpec */
/** @typedef {import('./registry.js').SubcommandSpec} SubcommandSpec */
/** @typedef {import('./registry.js').OptionSpec} OptionSpec */
/** @typedef {import('./registry.js').PositionalSpec} PositionalSpec */

/**
 * @typedef {object} HelpOptions
 * @property {readonly CommandSpec[]} [commands]
 * @property {(command: CommandSpec) => boolean} [isAvailable]
 * @property {string} [version]
 */

/** @type {ReadonlyArray<{ id: CommandSpec['group'], title: string }>} */
export const HELP_GROUPS = Object.freeze([
  { id: 'everyday', title: 'Everyday' },
  { id: 'advanced', title: 'Advanced' },
]);

const NOT_AVAILABLE = ' (not available in this build)';

// Outcomes no command can rule out: a usage error, an unexpected failure and Ctrl+C.
const UNIVERSAL_EXIT_CODES = Object.freeze([1, 7, 130]);

/**
 * @param {readonly CommandSpec[]} [commands]
 * @returns {Array<{ id: string, title: string, commands: CommandSpec[] }>}
 */
export function getCommandGroups(commands = COMMANDS) {
  return HELP_GROUPS.map((group) => ({ ...group, commands: commands.filter((command) => command.group === group.id) }));
}

/**
 * @param {readonly string[]} topic  [] for global help, [command] or [command, subcommand].
 * @param {HelpOptions} [options]
 * @returns {string}
 */
export function renderHelp(topic, options = {}) {
  const commands = options.commands ?? COMMANDS;
  const command = topic[0] === undefined ? undefined : commands.find((entry) => entry.name === topic[0]);
  if (!command) return renderGlobalHelp(options);
  const subcommand = topic[1] === undefined ? undefined : command.subcommands?.find((entry) => entry.name === topic[1]);
  return renderCommandHelp(command, subcommand, options);
}

/**
 * @param {HelpOptions} [options]
 * @returns {string}
 */
export function renderGlobalHelp({ commands = COMMANDS, isAvailable = isCommandAvailable, version } = {}) {
  const lines = [formatVersionLine(version), '', 'Set up and launch OpenCode for Unity C# work with a local model.', ''];
  lines.push('Usage', `  ${CLI_NAME} <command> [options]`, '');
  // One column width for both groups keeps the summaries aligned across the whole list.
  const nameWidth = Math.max(0, ...commands.map((command) => formatCommandName(command).length));
  for (const group of getCommandGroups(commands)) {
    const rows = group.commands.map((command) => [
      formatCommandName(command),
      `${command.summary}${isAvailable(command) ? '' : NOT_AVAILABLE}`,
    ]);
    lines.push(group.title, ...formatRows(rows, nameWidth), '');
  }
  lines.push('Global options', ...formatRows(GLOBAL_OPTIONS.map(formatOptionRow)), '');
  lines.push('Exit codes', ...formatRows(EXIT_CODES.map((info) => [String(info.exitCode), info.summary])), '');
  lines.push(`Run '${CLI_NAME} help <command>' for command options.`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {CommandSpec} command
 * @param {SubcommandSpec | undefined} subcommand
 * @param {HelpOptions} [options]
 * @returns {string}
 */
export function renderCommandHelp(command, subcommand, { isAvailable = isCommandAvailable, version } = {}) {
  const target = subcommand ?? command;
  const lines = [formatVersionLine(version), '', 'Usage', `  ${formatUsage(command, subcommand)}`, ''];
  lines.push(`${subcommand ? subcommand.summary : command.summary}${isAvailable(command) ? '' : NOT_AVAILABLE}`);
  if (!subcommand && command.description) lines.push(command.description);
  lines.push('');
  if (target.positionals.length) {
    lines.push('Arguments', ...formatRows(target.positionals.map(formatPositionalRow)), '');
  }
  if (!subcommand && command.subcommands?.length) {
    const rows = command.subcommands.map((entry) => [entry.name, entry.summary]);
    lines.push('Subcommands', ...formatRows(rows), '');
  }
  if (target.options.length) lines.push('Options', ...formatRows(target.options.map(formatOptionRow)), '');
  lines.push('Global options', ...formatRows(GLOBAL_OPTIONS.map(formatOptionRow)), '');
  const exitRows = command.exitCodes.map((exitCode) => [String(exitCode), getExitCodeInfo(exitCode)?.name ?? '']);
  lines.push('Exit codes', ...formatRows(exitRows));
  // The registry lists what each command's own table names. Bad flags, an unexpected failure and
  // Ctrl+C can end any command, so help says so rather than letting the list read as exhaustive.
  const universal = UNIVERSAL_EXIT_CODES.filter((exitCode) => !command.exitCodes.includes(exitCode));
  if (universal.length) {
    const named = universal.map((exitCode) => `${exitCode} (${getExitCodeInfo(exitCode)?.name ?? ''})`);
    lines.push(`  Any command can also exit ${formatList(named)}.`);
  }
  if (!subcommand && command.subcommands?.length) {
    lines.push('', `Run '${CLI_NAME} help ${command.name} <subcommand>' for subcommand options.`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {CommandSpec} command
 * @param {SubcommandSpec} [subcommand]
 * @returns {string}
 */
export function formatUsage(command, subcommand) {
  const parts = [CLI_NAME, command.name];
  if (subcommand) {
    parts.push(subcommand.name, ...subcommand.positionals.map(formatPositionalName));
  } else if (command.subcommands?.length) {
    parts.push('<subcommand>');
  } else {
    parts.push(...command.positionals.map(formatPositionalName));
  }
  parts.push('[options]');
  return parts.join(' ');
}

/**
 * @param {CommandSpec} command
 * @returns {string}
 */
function formatCommandName(command) {
  if (command.subcommands?.length) return `${command.name} <subcommand>`;
  return [command.name, ...command.positionals.map(formatPositionalName)].join(' ');
}

/**
 * @param {PositionalSpec} positional
 * @returns {string}
 */
function formatPositionalName(positional) {
  return positional.required ? `<${positional.name}>` : `[${positional.name}]`;
}

/**
 * @param {PositionalSpec} positional
 * @returns {[string, string]}
 */
function formatPositionalRow(positional) {
  const choices = positional.choices ? ` (${positional.choices.join(', ')})` : '';
  return [formatPositionalName(positional), `${positional.description}${choices}`];
}

/**
 * @param {OptionSpec} option
 * @returns {[string, string]}
 */
function formatOptionRow(option) {
  const valueName = option.choices && option.type !== 'list' ? option.choices.join('|') : (option.valueName ?? 'value');
  const flag = option.type === 'boolean' ? `--${option.name}` : `--${option.name} <${valueName}>`;
  const notes = [];
  if (option.required) notes.push('required');
  if (option.type === 'list' && option.choices) notes.push(`comma-separated: ${option.choices.join(', ')}`);
  return [flag, notes.length ? `${option.description} (${notes.join('; ')})` : option.description];
}

/**
 * @param {ReadonlyArray<readonly string[]>} rows  Pairs of left and right cells.
 * @param {number} [width]  Left column width; defaults to the widest left cell.
 * @returns {string[]}
 */
function formatRows(rows, width = Math.max(0, ...rows.map(([left]) => left.length))) {
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd());
}

/**
 * @param {readonly string[]} items
 * @returns {string}  `a`, `a or b`, `a, b or c`.
 */
function formatList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
