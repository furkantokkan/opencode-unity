// Argument parser driven by the registry. Global options may appear anywhere; command options must
// follow the command (and subcommand) name. Values are validated here so commands receive clean input.
import { usageError } from './exit-codes.js';
import { CLI_NAME } from './version.js';
import { COMMANDS, GLOBAL_OPTIONS, findCommand, findSubcommand } from './registry.js';

/** @typedef {import('./registry.js').CommandSpec} CommandSpec */
/** @typedef {import('./registry.js').SubcommandSpec} SubcommandSpec */
/** @typedef {import('./registry.js').OptionSpec} OptionSpec */
/** @typedef {import('./registry.js').PositionalSpec} PositionalSpec */
/** @typedef {boolean | string | number | string[] | undefined} OptionValue */

/**
 * @typedef {object} GlobalOptions
 * @property {boolean} json
 * @property {boolean} yes
 * @property {boolean} dryRun
 * @property {string | undefined} project
 * @property {boolean} experimental
 * @property {boolean} verbose
 * @property {boolean} noColor
 */

/**
 * @typedef {object} CommandRequest
 * @property {'command'} kind
 * @property {CommandSpec} command
 * @property {SubcommandSpec | undefined} subcommand
 * @property {string} label                      'doctor' or 'delegate ask'.
 * @property {Record<string, string>} args       Positionals by name; absent optional ones are missing.
 * @property {Record<string, OptionValue>} options  camelCase keys; booleans default to false.
 * @property {GlobalOptions} global
 */

/**
 * @typedef {object} HelpRequest
 * @property {'help'} kind
 * @property {string[]} topic   [] for global help, [command] or [command, subcommand].
 * @property {GlobalOptions} global
 */

/**
 * @typedef {object} VersionRequest
 * @property {'version'} kind
 * @property {GlobalOptions} global
 */

/** @typedef {CommandRequest | HelpRequest | VersionRequest} ParsedArgv */

const GLOBAL_OPTION_NAMES = new Set(GLOBAL_OPTIONS.map((spec) => spec.name));

/**
 * @param {readonly string[]} argv  Arguments after the executable and script path.
 * @param {{ commands?: readonly CommandSpec[] }} [options]
 * @returns {ParsedArgv}
 */
export function parseArgv(argv, { commands = COMMANDS } = {}) {
  const leading = getTokensBeforeTerminator(argv);
  const words = collectWords(leading);
  if (leading.includes('--help') || leading.includes('-h')) {
    const topic = words[0] === 'help' ? words.slice(1) : words;
    return { kind: 'help', topic: resolveHelpTopic(topic, commands), global: scanGlobalFlags(argv) };
  }
  if (words[0] === 'help') return { kind: 'help', topic: resolveHelpTopic(words.slice(1), commands), global: scanGlobalFlags(argv) };
  if (leading.includes('--version')) return { kind: 'version', global: scanGlobalFlags(argv) };
  return parseCommandLine(argv, commands);
}

/**
 * Best-effort global flags from raw arguments, for output decisions when parsing fails.
 * @param {readonly string[]} argv
 * @returns {GlobalOptions}
 */
export function scanGlobalFlags(argv) {
  const leading = getTokensBeforeTerminator(argv);
  return {
    json: leading.includes('--json'),
    yes: leading.includes('--yes'),
    dryRun: leading.includes('--dry-run'),
    project: undefined,
    experimental: leading.includes('--experimental'),
    verbose: leading.includes('--verbose'),
    noColor: leading.includes('--no-color'),
  };
}

/**
 * @param {string} name  Flag name such as 'dry-run'.
 * @returns {string}     'dryRun'
 */
export function toCamelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Closest known name within an edit distance of 2, for "did you mean" hints.
 * @param {string} input
 * @param {readonly string[]} names
 * @returns {string | undefined}
 */
export function suggestName(input, names) {
  let best;
  let bestDistance = 3;
  for (const name of names) {
    const distance = getEditDistance(input, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * @param {readonly string[]} argv
 * @param {readonly CommandSpec[]} commands
 * @returns {ParsedArgv}
 */
function parseCommandLine(argv, commands) {
  /** @type {Map<string, OptionSpec>} */
  const specs = new Map(GLOBAL_OPTIONS.map((spec) => [spec.name, spec]));
  /** @type {Map<string, OptionValue>} */
  const values = new Map();
  /** @type {string[]} */
  const words = [];
  /** @type {CommandSpec | undefined} */
  let command;
  /** @type {SubcommandSpec | undefined} */
  let subcommand;
  let terminated = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!terminated && token === '--') {
      terminated = true;
      index += 1;
    } else if (!terminated && isOptionLike(token)) {
      index = readOption(argv, index, specs, values, command);
    } else {
      index += 1;
      if (!command) {
        command = requireCommand(token, commands);
        addSpecs(specs, command.options);
      } else if (command.subcommands && !subcommand) {
        subcommand = requireSubcommand(command, token);
        addSpecs(specs, subcommand.options);
      } else {
        words.push(token);
      }
    }
  }
  const global = buildGlobalOptions(values);
  if (!command) return { kind: 'help', topic: [], global };
  if (command.subcommands && !subcommand) {
    const names = command.subcommands.map((entry) => entry.name).join(', ');
    throw usageError(`'${command.name}' needs a subcommand: ${names}`, { code: 'missing_subcommand', hint: getHelpHint(command.name) });
  }
  const label = subcommand ? `${command.name} ${subcommand.name}` : command.name;
  const target = subcommand ?? command;
  const args = mapPositionals(words, target.positionals, label);
  requireOptions(target.options, values, label);
  return { kind: 'command', command, subcommand, label, args, options: buildCommandOptions(target.options, values), global };
}

/**
 * @param {readonly string[]} argv
 * @param {number} index
 * @param {Map<string, OptionSpec>} specs
 * @param {Map<string, OptionValue>} values
 * @param {CommandSpec | undefined} command
 * @returns {number} Index of the next unread token.
 */
function readOption(argv, index, specs, values, command) {
  const token = argv[index];
  if (!token.startsWith('--')) throw usageError(`Unknown option '${token}'`, { code: 'unknown_option', hint: getHelpHint(command?.name) });
  const equals = token.indexOf('=');
  const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
  const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
  const refusal = command?.refusedOptions?.[name];
  if (refusal) throw usageError(`${refusal} (--${name})`, { code: 'refused_option', data: { option: name } });
  const spec = specs.get(name);
  if (!spec) throw createUnknownOptionError(name, specs, command);

  if (spec.type === 'boolean') {
    if (inlineValue !== undefined) throw usageError(`Option '--${name}' does not take a value`);
    setValueOnce(values, spec, true);
    return index + 1;
  }
  if (spec.type === 'variadic') {
    const items = inlineValue === undefined ? [] : [inlineValue];
    let next = index + 1;
    while (inlineValue === undefined && next < argv.length && !isOptionLike(argv[next])) {
      items.push(argv[next]);
      next += 1;
    }
    if (!items.length) throw usageError(`Option '--${name}' needs at least one value`);
    appendValues(values, spec, items.map((item) => requireNonEmpty(spec, item)));
    return next;
  }
  const raw = inlineValue ?? argv[index + 1];
  if (raw === undefined || (inlineValue === undefined && isOptionLike(raw))) {
    throw usageError(`Option '--${name}' needs a value`, { hint: getHelpHint(command?.name) });
  }
  const converted = convertValue(spec, raw);
  if (Array.isArray(converted)) appendValues(values, spec, converted);
  else setValueOnce(values, spec, converted);
  return inlineValue === undefined ? index + 2 : index + 1;
}

/**
 * @param {OptionSpec} spec
 * @param {string} raw
 * @returns {string | number | string[]}
 */
function convertValue(spec, raw) {
  const text = requireNonEmpty(spec, raw).trim();
  if (spec.type === 'integer') {
    if (!/^-?\d+$/.test(text)) throw usageError(`Option '--${spec.name}' needs a whole number, got '${raw}'`);
    return requireRange(spec, Number(text));
  }
  if (spec.type === 'number') {
    if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(text)) throw usageError(`Option '--${spec.name}' needs a number, got '${raw}'`);
    return requireRange(spec, Number(text));
  }
  if (spec.type === 'list') {
    const items = text.split(',').map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw usageError(`Option '--${spec.name}' needs at least one value`);
    for (const item of items) requireChoice(`--${spec.name}`, spec.choices, item);
    return items;
  }
  requireChoice(`--${spec.name}`, spec.choices, raw);
  return raw;
}

/**
 * @param {OptionSpec} spec
 * @param {string} value
 * @returns {string}
 */
function requireNonEmpty(spec, value) {
  // An unset shell variable expands to '' and must not silently mean "current folder" or "no task".
  if (value.trim() === '') throw usageError(`Option '--${spec.name}' must not be empty`);
  return value;
}

/**
 * @param {OptionSpec} spec
 * @param {number} value
 * @returns {number}
 */
function requireRange(spec, value) {
  const tooLow = spec.min !== undefined && value < spec.min;
  const tooHigh = spec.max !== undefined && value > spec.max;
  if (!Number.isFinite(value) || tooLow || tooHigh) {
    throw usageError(`Option '--${spec.name}' must be between ${spec.min ?? '-inf'} and ${spec.max ?? 'inf'}, got ${value}`);
  }
  return value;
}

/**
 * @param {string} label
 * @param {readonly string[] | undefined} choices
 * @param {string} value
 */
function requireChoice(label, choices, value) {
  if (choices && !choices.includes(value)) {
    throw usageError(`Invalid value '${value}' for ${label}; expected one of: ${choices.join(', ')}`);
  }
}

/**
 * @param {Map<string, OptionValue>} values
 * @param {OptionSpec} spec
 * @param {OptionValue} value
 */
function setValueOnce(values, spec, value) {
  if (values.has(spec.name)) throw usageError(`Option '--${spec.name}' was given more than once`);
  values.set(spec.name, value);
}

/**
 * @param {Map<string, OptionValue>} values
 * @param {OptionSpec} spec
 * @param {string[]} items
 */
function appendValues(values, spec, items) {
  const existing = /** @type {string[] | undefined} */ (values.get(spec.name)) ?? [];
  values.set(spec.name, [...new Set([...existing, ...items])]);
}

/**
 * @param {string} name
 * @param {Map<string, OptionSpec>} specs
 * @param {CommandSpec | undefined} command
 */
function createUnknownOptionError(name, specs, command) {
  const suggestion = suggestName(name, [...specs.keys()]);
  const where = command ? ` for '${command.name}'` : '';
  const placement = command ? '' : ' Command options go after the command name.';
  const hint = suggestion ? `Did you mean '--${suggestion}'?${placement}` : `${getHelpHint(command?.name)}${placement}`;
  return usageError(`Unknown option '--${name}'${where}`, { code: 'unknown_option', hint });
}

/**
 * @param {string} name
 * @param {readonly CommandSpec[]} commands
 * @returns {CommandSpec}
 */
function requireCommand(name, commands) {
  const command = findCommand(name, commands);
  if (command) return command;
  const suggestion = suggestName(name, commands.map((entry) => entry.name));
  const hint = suggestion ? `Did you mean '${suggestion}'?` : getHelpHint();
  throw usageError(`Unknown command '${name}'`, { code: 'unknown_command', hint });
}

/**
 * @param {CommandSpec} command
 * @param {string} name
 * @returns {SubcommandSpec}
 */
function requireSubcommand(command, name) {
  const subcommand = findSubcommand(command, name);
  if (subcommand) return subcommand;
  const names = (command.subcommands ?? []).map((entry) => entry.name);
  const suggestion = suggestName(name, names);
  const hint = suggestion ? `Did you mean '${command.name} ${suggestion}'?` : getHelpHint(command.name);
  throw usageError(`Unknown subcommand '${command.name} ${name}'`, { code: 'unknown_command', hint });
}

/**
 * @param {readonly string[]} words
 * @param {readonly PositionalSpec[]} positionals
 * @param {string} label
 * @returns {Record<string, string>}
 */
function mapPositionals(words, positionals, label) {
  if (words.length > positionals.length) {
    throw usageError(`Unexpected argument '${words[positionals.length]}' for '${label}'`, {
      code: 'unexpected_argument',
      hint: 'Quote values that contain spaces.',
    });
  }
  /** @type {Record<string, string>} */
  const args = {};
  positionals.forEach((spec, position) => {
    const value = words[position];
    if (value === undefined) {
      if (spec.required) throw usageError(`'${label}' needs <${spec.name}>`, { hint: getHelpHint(label) });
      return;
    }
    if (value.trim() === '') throw usageError(`<${spec.name}> must not be empty`);
    requireChoice(`<${spec.name}>`, spec.choices, value);
    args[spec.name] = value;
  });
  return args;
}

/**
 * @param {readonly OptionSpec[]} specs
 * @param {Map<string, OptionValue>} values
 * @param {string} label
 */
function requireOptions(specs, values, label) {
  const missing = specs.filter((spec) => spec.required && !values.has(spec.name));
  if (missing.length) {
    const names = missing.map((spec) => `--${spec.name}`).join(', ');
    throw usageError(`'${label}' needs ${names}`, { code: 'missing_option', hint: getHelpHint(label) });
  }
}

/**
 * @param {Map<string, OptionSpec>} specs
 * @param {readonly OptionSpec[]} additions
 */
function addSpecs(specs, additions) {
  for (const spec of additions) specs.set(spec.name, spec);
}

/**
 * @param {Map<string, OptionValue>} values
 * @returns {GlobalOptions}
 */
function buildGlobalOptions(values) {
  return {
    json: values.get('json') === true,
    yes: values.get('yes') === true,
    dryRun: values.get('dry-run') === true,
    project: /** @type {string | undefined} */ (values.get('project')),
    experimental: values.get('experimental') === true,
    verbose: values.get('verbose') === true,
    noColor: values.get('no-color') === true,
  };
}

/**
 * @param {readonly OptionSpec[]} specs
 * @param {Map<string, OptionValue>} values
 * @returns {Record<string, OptionValue>}
 */
function buildCommandOptions(specs, values) {
  /** @type {Record<string, OptionValue>} */
  const options = {};
  for (const spec of specs) {
    options[toCamelCase(spec.name)] = values.get(spec.name) ?? (spec.type === 'boolean' ? false : undefined);
  }
  return options;
}

/**
 * @param {readonly string[]} words
 * @param {readonly CommandSpec[]} commands
 * @returns {string[]}
 */
function resolveHelpTopic(words, commands) {
  if (!words.length) return [];
  const command = requireCommand(words[0], commands);
  const subcommand = words[1] === undefined ? undefined : findSubcommand(command, words[1]);
  return subcommand ? [command.name, subcommand.name] : [command.name];
}

/**
 * Non-option tokens, skipping the values of global options that take one.
 * @param {readonly string[]} tokens
 * @returns {string[]}
 */
function collectWords(tokens) {
  const words = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isOptionLike(token)) {
      words.push(token);
      continue;
    }
    const name = token.slice(2);
    const spec = GLOBAL_OPTION_NAMES.has(name) ? GLOBAL_OPTIONS.find((entry) => entry.name === name) : undefined;
    if (spec && spec.type !== 'boolean') index += 1;
  }
  return words;
}

/**
 * @param {readonly string[]} argv
 * @returns {readonly string[]}
 */
function getTokensBeforeTerminator(argv) {
  const terminator = argv.indexOf('--');
  return terminator === -1 ? argv : argv.slice(0, terminator);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isOptionLike(token) {
  return token.startsWith('-') && token !== '-';
}

/**
 * @param {string} [label]
 * @returns {string}
 */
function getHelpHint(label) {
  return label ? `Run '${CLI_NAME} help ${label}' for usage.` : `Run '${CLI_NAME} help' for usage.`;
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function getEditDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}
