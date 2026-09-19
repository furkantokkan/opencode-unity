// CLI entry: parse, route to the command module, print the result, return the exit code.
// `main` never calls process.exit, so tests run it in-process with injected streams and commands.
import tty from 'node:tty';
import { coversCommand, describePlatform, detectPlatform, resolveTier, resolveTiers } from '../core/platform.js';
import { parseArgv, scanGlobalFlags } from './args.js';
import { createConsent } from './consent.js';
import { createEnvelope, createErrorEnvelope } from './envelope.js';
import { CliError, EXIT } from './exit-codes.js';
import { renderHelp } from './help.js';
import { createOutput, shouldUseColor } from './output.js';
import { COMMANDS, isCommandAvailable, loadCommandModule } from './registry.js';
import { createInterruptController } from './signals.js';
import { CLI_NAME, CLI_VERSION, DISCLAIMER, MIN_NODE_MAJOR, formatVersionLine, isSupportedNodeVersion } from './version.js';

/** @typedef {import('./args.js').GlobalOptions} GlobalOptions */
/** @typedef {import('./args.js').CommandRequest} CommandRequest */
/** @typedef {import('./args.js').OptionValue} OptionValue */
/** @typedef {import('./envelope.js').Envelope} Envelope */
/** @typedef {import('./output.js').Output} Output */
/** @typedef {import('./output.js').TextStream} TextStream */
/** @typedef {import('./registry.js').CommandSpec} CommandSpec */
/** @typedef {import('./registry.js').CommandModule} CommandModule */

/**
 * What a command module's `run` receives.
 * @typedef {object} CommandContext
 * @property {string} command                     Label: 'doctor' or 'delegate ask'.
 * @property {string | undefined} subcommand
 * @property {Record<string, string>} args        Positionals by name.
 * @property {Record<string, OptionValue>} options  Command options with camelCase keys.
 * @property {GlobalOptions} global
 * @property {Output} output
 * @property {import('./consent.js').Consent} consent
 * @property {import('./signals.js').InterruptController} interrupts
 * @property {AbortSignal} signal                  Aborted on Ctrl+C before the cleanups run.
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd
 * @property {NodeJS.Platform} platform
 * @property {string} version
 */

/**
 * What a command module's `run` returns. Every field is optional; returning nothing means success.
 * @typedef {object} CommandResult
 * @property {number} [exitCode]
 * @property {string} [code]
 * @property {string} [message]   One line; printed last in text mode.
 * @property {Record<string, unknown>} [data]
 * @property {string[]} [warnings]
 */

/**
 * @typedef {object} MainDependencies
 * @property {TextStream} [stdout]
 * @property {TextStream} [stderr]
 * @property {NodeJS.ReadableStream} [stdin]      Read only when a consent question is asked.
 * @property {boolean} [interactive]              Default: stdin and stderr are terminals.
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {NodeJS.Platform} [platform]
 * @property {import('../core/platform.js').PlatformFacts} [platformFacts]  The machine the support
 *   matrix judges. Detected from `platform` and `env` when absent; injected by tests, which must not
 *   depend on the architecture or the virtualization of whatever runs them.
 * @property {string} [nodeVersion]
 * @property {readonly CommandSpec[]} [commands]
 * @property {(command: CommandSpec) => Promise<CommandModule>} [loadCommand]
 * @property {(command: CommandSpec) => boolean} [isAvailable]
 * @property {boolean} [installSignals]           Only the real binary installs process signal handlers.
 * @property {(code: number) => void} [exit]       Used by the interrupt handler.
 */

/**
 * @param {readonly string[]} argv
 * @param {MainDependencies} [dependencies]
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, dependencies = {}) {
  const deps = resolveDependencies(dependencies);
  const scanned = scanGlobalFlags(argv);
  if (!isSupportedNodeVersion(deps.nodeVersion)) {
    const error = new CliError(`Node ${deps.nodeVersion} is not supported; ${CLI_NAME} needs Node ${MIN_NODE_MAJOR} or newer`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'unsupported_node',
    });
    return report(createOutputFor(scanned, deps), createErrorEnvelope(CLI_NAME, error));
  }

  let parsed;
  try {
    parsed = parseArgv(argv, { commands: deps.commands });
  } catch (error) {
    const envelope = createErrorEnvelope(guessCommandLabel(argv, deps.commands), error, { verbose: scanned.verbose });
    return report(createOutputFor(scanned, deps), envelope);
  }

  const output = createOutputFor(parsed.global, deps);
  if (parsed.global.printPlatform) {
    const facts = deps.platformFacts ?? detectPlatform({ platform: deps.platform, env: deps.env });
    const data = { platform: facts, tiers: resolveTiers(facts) };
    return report(output, createEnvelope({ command: CLI_NAME, exitCode: EXIT.OK, message: JSON.stringify(data, null, 2), data }));
  }
  if (parsed.kind === 'version') return printVersion(output, deps);
  if (parsed.kind === 'help') return printHelp(output, parsed.topic, deps);
  return runCommand(parsed, output, deps);
}

/**
 * @param {MainDependencies} dependencies
 */
function resolveDependencies(dependencies) {
  const stderr = dependencies.stderr ?? process.stderr;
  return {
    stdout: dependencies.stdout ?? process.stdout,
    stderr,
    // process.stdin is created lazily: touching it opens a handle that only consent needs.
    getStdin: () => dependencies.stdin ?? process.stdin,
    interactive: dependencies.interactive ?? (tty.isatty(0) && tty.isatty(2)),
    env: dependencies.env ?? process.env,
    cwd: dependencies.cwd ?? process.cwd(),
    platform: dependencies.platform ?? process.platform,
    platformFacts: dependencies.platformFacts,
    nodeVersion: dependencies.nodeVersion ?? process.versions.node,
    commands: dependencies.commands ?? COMMANDS,
    loadCommand: dependencies.loadCommand ?? loadCommandModule,
    isAvailable: dependencies.isAvailable ?? isCommandAvailable,
    installSignals: dependencies.installSignals ?? false,
    exit: dependencies.exit ?? ((/** @type {number} */ code) => process.exit(code)),
  };
}

/** @typedef {ReturnType<typeof resolveDependencies>} ResolvedDependencies */

/**
 * @param {CommandRequest} request
 * @param {Output} output
 * @param {ResolvedDependencies} deps
 * @returns {Promise<number>}
 */
async function runCommand(request, output, deps) {
  const interrupts = createInterruptController({
    platform: deps.platform,
    exit: deps.exit,
    stderr: deps.stderr,
    onInterrupt: (signalName) => {
      if (!output.json) return;
      output.envelope(createEnvelope({ command: request.label, exitCode: EXIT.INTERRUPTED, message: `Interrupted by ${signalName}` }));
    },
  });
  const uninstallSignals = deps.installSignals ? interrupts.install() : undefined;
  try {
    requireSupportedPlatform(request.command, deps, request.options);
    const module = await deps.loadCommand(request.command);
    /** @type {CommandContext} */
    const context = {
      command: request.label,
      subcommand: request.subcommand?.name,
      args: request.args,
      options: request.options,
      global: request.global,
      output,
      consent: createConsent({ interactive: deps.interactive, yes: request.global.yes, getInput: deps.getStdin, prompts: deps.stderr }),
      interrupts,
      signal: interrupts.signal,
      env: deps.env,
      cwd: deps.cwd,
      platform: deps.platform,
      version: CLI_VERSION,
    };
    const result = await module.run(context);
    return report(output, createResultEnvelope(request.label, result));
  } catch (error) {
    return report(output, createErrorEnvelope(request.label, error, { verbose: request.global.verbose }));
  } finally {
    uninstallSignals?.();
  }
}

/**
 * The support matrix decides (amendment 33.4): a `refused` tier exits 8 before the module is loaded,
 * with the matrix's own sentence and the `data.platform` block of 33.9. An `experimental` tier is not
 * refused here - acknowledging it is a consent item the commands own, so the gate never turns a
 * platform the matrix calls usable into an exit 8.
 *
 * `command.platforms` remains for a command the matrix does not name, which in the shipped registry is
 * none of them. Test doubles use it, and it keeps a command added without a matrix row from running
 * everywhere by accident.
 * @param {CommandSpec} command
 * @param {ResolvedDependencies} deps
 * @param {Record<string, unknown>} options
 */
function requireSupportedPlatform(command, deps, options) {
  if (!coversCommand(command.name)) {
    if (!command.platforms || command.platforms.includes(deps.platform)) return;
    throw new CliError(`'${command.name}' runs only on ${command.platforms.join(', ')} in this version (this is ${deps.platform})`, {
      exitCode: EXIT.UNSUPPORTED,
      code: 'unsupported_platform',
      data: { platform: deps.platform, supported: [...command.platforms] },
    });
  }
  const facts = deps.platformFacts ?? detectPlatform({ platform: deps.platform, env: deps.env });
  const tierCommand = command.name === 'shape' && options.noModel === true ? 'shape-no-model' : command.name;
  const result = resolveTier(tierCommand, facts);
  if (result.tier !== 'refused') return;
  throw new CliError(result.message ?? `'${command.name}' is not supported on ${deps.platform} in this version`, {
    exitCode: EXIT.UNSUPPORTED,
    code: command.platformRefusal?.code ?? 'unsupported_platform',
    data: { ...command.platformRefusal?.data, platform: describePlatform(facts, result) },
  });
}

/**
 * @param {string} label
 * @param {unknown} result
 * @returns {Envelope}
 */
function createResultEnvelope(label, result) {
  if (result === undefined) return createEnvelope({ command: label });
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new TypeError(`'${label}' returned an invalid result; expected an object or nothing`);
  }
  const { exitCode, code, message, data, warnings } = /** @type {CommandResult} */ (result);
  try {
    return createEnvelope({ command: label, exitCode, code, message, data, warnings });
  } catch (error) {
    throw new TypeError(`'${label}' returned an invalid result: ${error.message}`);
  }
}

/**
 * @param {Output} output
 * @param {Envelope} envelope
 * @returns {number}
 */
function report(output, envelope) {
  if (output.json) {
    output.envelope(envelope);
    return envelope.exitCode;
  }
  for (const warning of envelope.warnings) output.warn(warning);
  if (envelope.ok) {
    if (envelope.message) output.text(envelope.message);
    return envelope.exitCode;
  }
  output.error(envelope.message);
  if (typeof envelope.data.hint === 'string') output.hint(envelope.data.hint);
  if (typeof envelope.data.stack === 'string') output.debug(envelope.data.stack);
  return envelope.exitCode;
}

/**
 * @param {Output} output
 * @param {ResolvedDependencies} deps
 * @returns {number}
 */
function printVersion(output, deps) {
  if (output.json) {
    output.envelope(createEnvelope({ command: 'version', data: { version: CLI_VERSION, disclaimer: DISCLAIMER, node: deps.nodeVersion } }));
  } else {
    output.text(formatVersionLine());
  }
  return EXIT.OK;
}

/**
 * @param {Output} output
 * @param {string[]} topic
 * @param {ResolvedDependencies} deps
 * @returns {number}
 */
function printHelp(output, topic, deps) {
  const text = renderHelp(topic, { commands: deps.commands, isAvailable: deps.isAvailable });
  if (output.json) output.envelope(createEnvelope({ command: 'help', data: { topic, text } }));
  else output.text(text.trimEnd());
  return EXIT.OK;
}

/**
 * @param {GlobalOptions} global
 * @param {ResolvedDependencies} deps
 * @returns {Output}
 */
function createOutputFor(global, deps) {
  const humanStream = global.json ? deps.stderr : deps.stdout;
  const color = shouldUseColor({ stream: humanStream, env: deps.env, noColor: global.noColor });
  return createOutput({ stdout: deps.stdout, stderr: deps.stderr, json: global.json, verbose: global.verbose, color });
}

/**
 * The command named in arguments that failed to parse, for the envelope `command` field.
 * @param {readonly string[]} argv
 * @param {readonly CommandSpec[]} commands
 * @returns {string}
 */
function guessCommandLabel(argv, commands) {
  const words = argv.filter((token) => !token.startsWith('-'));
  const command = commands.find((entry) => entry.name === words[0]);
  if (!command) return CLI_NAME;
  const subcommand = command.subcommands?.find((entry) => entry.name === words[1]);
  return subcommand ? `${command.name} ${subcommand.name}` : command.name;
}
