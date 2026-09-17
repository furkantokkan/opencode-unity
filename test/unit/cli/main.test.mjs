import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { parseEnvelope } from '../../../src/cli/envelope.js';
import { CliError, EXIT } from '../../../src/cli/exit-codes.js';
import { main } from '../../../src/cli/main.js';
import { loadCommandModule } from '../../../src/cli/registry.js';
import { formatVersionLine } from '../../../src/cli/version.js';

/** @typedef {import('../../../src/cli/registry.js').CommandSpec} CommandSpec */
/** @typedef {import('../../../src/cli/main.js').CommandContext} CommandContext */

/** @type {CommandSpec[]} */
const COMMANDS = [
  {
    name: 'probe',
    group: 'everyday',
    summary: 'Probe',
    module: '../commands/probe.js',
    positionals: [{ name: 'path', description: 'Path' }],
    options: [
      { name: 'dry-level', type: 'integer', min: 1, max: 3, description: 'Level' },
      { name: 'mode', type: 'string', description: 'Mode' },
    ],
    exitCodes: [0, 1, 2, 7],
  },
  {
    name: 'winonly',
    group: 'advanced',
    summary: 'Windows only',
    module: '../commands/winonly.js',
    positionals: [],
    options: [],
    platforms: ['win32'],
    exitCodes: [0, 8],
  },
  {
    name: 'absent',
    group: 'advanced',
    summary: 'Not built',
    module: '../commands/__absent__.js',
    positionals: [],
    options: [],
    exitCodes: [0, 8],
  },
];

function createStream() {
  const chunks = /** @type {string[]} */ ([]);
  return { isTTY: false, write: (/** @type {string} */ text) => chunks.push(text), text: () => chunks.join('') };
}

/**
 * @param {string[]} argv
 * @param {(context: CommandContext) => unknown} [run]
 * @param {import('../../../src/cli/main.js').MainDependencies} [overrides]
 */
async function runMain(argv, run = () => undefined, overrides = {}) {
  const stdout = createStream();
  const stderr = createStream();
  /** @type {CommandContext[]} */
  const contexts = [];
  const exitCode = await main(argv, {
    stdout,
    stderr,
    env: {},
    cwd: 'C:/work',
    platform: 'win32',
    nodeVersion: '22.4.0',
    interactive: false,
    commands: COMMANDS,
    isAvailable: () => true,
    loadCommand: async (command) => {
      if (command.name === 'absent') return loadCommandModule(command);
      return { run: async (/** @type {CommandContext} */ context) => {
        contexts.push(context);
        return run(context);
      } };
    },
    ...overrides,
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text(), contexts };
}

describe('main: command execution', () => {
  it('passes parsed arguments, options and globals to the command', async () => {
    const result = await runMain(['probe', 'Game', '--dry-level', '2', '--json', '--yes', '--project', 'P']);
    assert.equal(result.exitCode, 0);
    const [context] = result.contexts;
    assert.equal(context.command, 'probe');
    assert.equal(context.subcommand, undefined);
    assert.deepEqual(context.args, { path: 'Game' });
    assert.deepEqual(context.options, { dryLevel: 2, mode: undefined });
    assert.equal(context.global.json, true);
    assert.equal(context.global.yes, true);
    assert.equal(context.global.project, 'P');
    assert.equal(context.cwd, 'C:/work');
    assert.equal(context.platform, 'win32');
    assert.equal(context.output.json, true);
    assert.equal(context.signal.aborted, false);
    assert.equal(typeof context.consent.request, 'function');
    assert.equal(typeof context.interrupts.addCleanup, 'function');
  });

  it('prints a success envelope under --json', async () => {
    const result = await runMain(['probe', '--json'], (context) => {
      context.output.text('working');
      return { message: 'all good', data: { checks: 3 }, warnings: ['minor'] };
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, 'working\n');
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.command, 'probe');
    assert.equal(envelope.message, 'all good');
    assert.deepEqual(envelope.data, { checks: 3 });
    assert.deepEqual(envelope.warnings, ['minor']);
  });

  it('prints the message and warnings as text without --json', async () => {
    const result = await runMain(['probe'], () => ({ message: 'all good', warnings: ['minor'] }));
    assert.equal(result.stdout, 'all good\n');
    assert.equal(result.stderr, 'warning: minor\n');
  });

  it('treats a missing result as success with an empty message', async () => {
    const result = await runMain(['probe', '--json']);
    assert.equal(result.exitCode, 0);
    assert.equal(parseEnvelope(result.stdout).code, 'ok');
    const text = await runMain(['probe']);
    assert.equal(text.stdout, '');
  });

  it('returns a non-zero result exit code from the command', async () => {
    const result = await runMain(['probe', '--json'], () => ({ exitCode: EXIT.BLOCKED, code: 'gpu_guard_blocked', message: 'import running' }));
    assert.equal(result.exitCode, 2);
    assert.equal(parseEnvelope(result.stdout).ok, false);
  });

  it('maps a thrown CliError to its exit code, with the hint on stderr', async () => {
    const run = () => {
      throw new CliError('Ollama is not reachable', { exitCode: EXIT.BLOCKED, code: 'ollama_unreachable', hint: 'Start Ollama.' });
    };
    const text = await runMain(['probe'], run);
    assert.equal(text.exitCode, 2);
    assert.equal(text.stderr, 'error: Ollama is not reachable\nhint: Start Ollama.\n');
    const json = await runMain(['probe', '--json'], run);
    const envelope = parseEnvelope(json.stdout);
    assert.equal(envelope.code, 'ollama_unreachable');
    assert.equal(envelope.data.hint, 'Start Ollama.');
  });

  it('maps unexpected errors to exit 7 and shows the stack only with --verbose', async () => {
    const run = () => {
      throw new Error('boom');
    };
    const quiet = await runMain(['probe'], run);
    assert.equal(quiet.exitCode, EXIT.RUNTIME);
    assert.equal(quiet.stderr, 'error: boom\n');
    const verbose = await runMain(['probe', '--verbose'], run);
    assert.match(verbose.stderr, /error: boom\n[\s\S]*at /);
  });

  it('refuses invalid command results with exit 7', async () => {
    const bad = await runMain(['probe', '--json'], () => 'done');
    assert.equal(bad.exitCode, EXIT.RUNTIME);
    assert.match(parseEnvelope(bad.stdout).message, /returned an invalid result/);
    const badCode = await runMain(['probe', '--json'], () => ({ exitCode: 42 }));
    assert.equal(badCode.exitCode, EXIT.RUNTIME);
    assert.match(parseEnvelope(badCode.stdout).message, /exitCode 42/);
  });

  it('exits 8 for a command whose module is not built yet', async () => {
    const result = await runMain(['absent', '--json']);
    assert.equal(result.exitCode, EXIT.UNSUPPORTED);
    assert.equal(parseEnvelope(result.stdout).code, 'command_not_available');
  });

  it('exits 8 for a command on an unsupported platform before loading it', async () => {
    const result = await runMain(['winonly', '--json'], () => assert.fail('must not run'), { platform: 'linux' });
    assert.equal(result.exitCode, EXIT.UNSUPPORTED);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.code, 'unsupported_platform');
    assert.deepEqual(envelope.data, { platform: 'linux', supported: ['win32'] });
    assert.equal((await runMain(['winonly'])).exitCode, 0);
  });

  it('on interrupt runs cleanups, prints an interrupted envelope under --json and exits 130', async () => {
    const exits = /** @type {number[]} */ ([]);
    const result = await runMain(['probe', '--json'], (context) => {
      context.interrupts.addCleanup(() => 'released the GPU lock');
      context.interrupts.handleSignal('SIGINT');
      return { message: 'finished after exit was requested' };
    }, { exit: (code) => exits.push(code) });
    assert.deepEqual(exits, [EXIT.INTERRUPTED]);
    assert.equal(result.contexts[0].signal.aborted, true);
    assert.match(result.stderr, /interrupted by SIGINT; released the GPU lock/);
    const [interrupted] = result.stdout.trimEnd().split('\n');
    const envelope = parseEnvelope(interrupted);
    assert.equal(envelope.exitCode, EXIT.INTERRUPTED);
    assert.equal(envelope.code, 'interrupted');
  });

  it('asks for consent through the context and exits 9 when nobody can answer', async () => {
    const result = await runMain(['probe', '--json'], async (context) => {
      await context.consent.request([{ id: 'profile-render', title: 'Render the profile', recommended: true }]);
    });
    assert.equal(result.exitCode, EXIT.CONSENT_REQUIRED);
    assert.deepEqual(parseEnvelope(result.stdout).data.consents, [{ id: 'profile-render', title: 'Render the profile', recommended: true }]);
  });

  it('reads consent answers from stdin in interactive runs', async () => {
    const stdin = new PassThrough();
    stdin.end('n\n');
    const result = await runMain(['probe'], async (context) => {
      const [decision] = await context.consent.request([{ id: 'profile-render', title: 'Render the profile', recommended: true }]);
      return { message: `accepted=${decision.accepted}` };
    }, { interactive: true, stdin });
    assert.equal(result.stdout, 'accepted=false\n');
    assert.match(result.stderr, /Render the profile\nAccept\? \[Y\/n\] /);
  });
});

describe('main: parsing, help and version', () => {
  it('prints usage errors as an envelope under --json with exit 1', async () => {
    const result = await runMain(['probe', '--bogus', '--json']);
    assert.equal(result.exitCode, EXIT.USAGE);
    const envelope = parseEnvelope(result.stdout);
    assert.equal(envelope.command, 'probe');
    assert.equal(envelope.code, 'unknown_option');
  });

  it('prints usage errors as text with a hint', async () => {
    const result = await runMain(['prob']);
    assert.equal(result.exitCode, EXIT.USAGE);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, "error: Unknown command 'prob'\nhint: Did you mean 'probe'?\n");
  });

  it('prints the version line with the disclaimer', async () => {
    const text = await runMain(['--version']);
    assert.equal(text.exitCode, 0);
    assert.equal(text.stdout, `${formatVersionLine()}\n`);
    const json = await runMain(['--version', '--json']);
    const envelope = parseEnvelope(json.stdout);
    assert.equal(envelope.command, 'version');
    assert.equal(envelope.data.node, '22.4.0');
    assert.match(String(envelope.data.disclaimer), /unofficial/);
  });

  it('prints help for no arguments and for a command', async () => {
    const global = await runMain([]);
    assert.equal(global.exitCode, 0);
    assert.match(global.stdout, /^Everyday\n {2}probe \[path\]/m);
    assert.match(global.stdout, /^Advanced\n/m);
    const command = await runMain(['help', 'probe', '--json']);
    const envelope = parseEnvelope(command.stdout);
    assert.deepEqual(envelope.data.topic, ['probe']);
    assert.match(String(envelope.data.text), /--dry-level <value>/);
  });

  it('refuses Node versions older than 22 with exit 8', async () => {
    const result = await runMain(['probe', '--json'], () => assert.fail('must not run'), { nodeVersion: '20.18.0' });
    assert.equal(result.exitCode, EXIT.UNSUPPORTED);
    assert.equal(parseEnvelope(result.stdout).code, 'unsupported_node');
  });
});
