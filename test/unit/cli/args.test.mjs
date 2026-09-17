import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgv, scanGlobalFlags, suggestName, toCamelCase } from '../../../src/cli/args.js';
import { CliError, EXIT } from '../../../src/cli/exit-codes.js';

/** @typedef {import('../../../src/cli/registry.js').CommandSpec} CommandSpec */

/** A small registry so generic parser behavior does not depend on the product command table. */
/** @type {CommandSpec[]} */
const TEST_COMMANDS = [
  {
    name: 'scan',
    group: 'everyday',
    summary: 'Scan',
    module: '../commands/scan.js',
    positionals: [{ name: 'path', description: 'Directory' }],
    options: [
      { name: 'deep', type: 'boolean', description: 'Deep' },
      { name: 'logs', type: 'string', valueName: 'path', description: 'Logs' },
      { name: 'mode', type: 'string', choices: ['fast', 'full'], description: 'Mode' },
      { name: 'runs', type: 'integer', min: 1, max: 50, description: 'Runs' },
      { name: 'ratio', type: 'number', min: 0, max: 2, description: 'Ratio' },
      { name: 'targets', type: 'list', choices: ['claude', 'codex'], description: 'Targets' },
      { name: 'files', type: 'variadic', description: 'Files' },
      { name: 'no-cache', type: 'boolean', description: 'No cache' },
    ],
    refusedOptions: { auto: 'auto-approval is refused' },
    exitCodes: [0, 1],
  },
  {
    name: 'run',
    group: 'advanced',
    summary: 'Run',
    module: '../commands/run.js',
    positionals: [{ name: 'suite', required: true, choices: ['a', 'b'], description: 'Suite' }],
    options: [{ name: 'label', type: 'string', required: true, description: 'Label' }],
    exitCodes: [0, 1],
  },
  {
    name: 'job',
    group: 'advanced',
    summary: 'Jobs',
    module: '../commands/job.js',
    positionals: [],
    options: [],
    subcommands: [
      { name: 'list', summary: 'List', positionals: [], options: [{ name: 'since', type: 'string', description: 'Since' }] },
      { name: 'show', summary: 'Show', positionals: [{ name: 'jobId', required: true, description: 'Id' }], options: [] },
    ],
    exitCodes: [0, 1],
  },
];

/**
 * @param {string[]} argv
 */
function parse(argv) {
  return parseArgv(argv, { commands: TEST_COMMANDS });
}

/**
 * @param {string[]} argv
 */
function parseCommand(argv) {
  const parsed = parse(argv);
  assert.equal(parsed.kind, 'command');
  return /** @type {import('../../../src/cli/args.js').CommandRequest} */ (parsed);
}

/**
 * @param {() => unknown} action
 * @param {RegExp} message
 * @param {string} [code]
 */
function assertUsageError(action, message, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CliError, `expected CliError, got ${error}`);
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, message);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

describe('parseArgv: commands and options', () => {
  it('parses a command with a positional, booleans and camelCase keys', () => {
    const parsed = parseCommand(['scan', 'MyGame', '--deep', '--no-cache']);
    assert.equal(parsed.command.name, 'scan');
    assert.equal(parsed.label, 'scan');
    assert.equal(parsed.subcommand, undefined);
    assert.deepEqual(parsed.args, { path: 'MyGame' });
    assert.equal(parsed.options.deep, true);
    assert.equal(parsed.options.noCache, true);
    assert.equal(parsed.options.logs, undefined);
    assert.equal(parsed.options.files, undefined);
  });

  it('defaults declared booleans to false and omits missing optional positionals', () => {
    const parsed = parseCommand(['scan']);
    assert.equal(parsed.options.deep, false);
    assert.deepEqual(parsed.args, {});
  });

  it('accepts global options before and after the command', () => {
    const parsed = parseCommand(['--json', 'scan', '--yes', '--dry-run', '--project', 'Game Dir', '--experimental', '--verbose', '--no-color']);
    assert.deepEqual(parsed.global, {
      json: true,
      yes: true,
      dryRun: true,
      project: 'Game Dir',
      experimental: true,
      verbose: true,
      noColor: true,
    });
  });

  it('reads values separated by a space or an equals sign', () => {
    assert.equal(parseCommand(['scan', '--logs', 'C:\\logs\\server.log']).options.logs, 'C:\\logs\\server.log');
    assert.equal(parseCommand(['scan', '--logs=a=b.log']).options.logs, 'a=b.log');
    assert.equal(parseCommand(['scan', '--project=x']).global.project, 'x');
  });

  it('converts and range-checks integers and numbers', () => {
    const parsed = parseCommand(['scan', '--runs', '20', '--ratio', '0.7']);
    assert.equal(parsed.options.runs, 20);
    assert.equal(parsed.options.ratio, 0.7);
    assert.equal(parseCommand(['scan', '--ratio=.5']).options.ratio, 0.5);
    assertUsageError(() => parse(['scan', '--runs', '0']), /between 1 and 50/);
    assertUsageError(() => parse(['scan', '--runs', '2.5']), /whole number/);
    assertUsageError(() => parse(['scan', '--runs=abc']), /whole number/);
    assertUsageError(() => parse(['scan', '--ratio', '3']), /between 0 and 2/);
    assertUsageError(() => parse(['scan', '--ratio', '1e3']), /needs a number/);
  });

  it('checks choices for strings and list items', () => {
    assert.equal(parseCommand(['scan', '--mode', 'full']).options.mode, 'full');
    assertUsageError(() => parse(['scan', '--mode', 'slow']), /expected one of: fast, full/);
    assert.deepEqual(parseCommand(['scan', '--targets', 'claude, codex']).options.targets, ['claude', 'codex']);
    assert.deepEqual(parseCommand(['scan', '--targets', 'codex', '--targets=claude,codex']).options.targets, ['codex', 'claude']);
    assertUsageError(() => parse(['scan', '--targets', 'claude,gemini']), /gemini/);
    assertUsageError(() => parse(['scan', '--targets', ',']), /at least one value/);
  });

  it('collects variadic values until the next option', () => {
    const parsed = parseCommand(['scan', '--files', 'A.cs', 'Sub Dir/B.cs', '--deep', '--files', 'C.cs', 'A.cs']);
    assert.deepEqual(parsed.options.files, ['A.cs', 'Sub Dir/B.cs', 'C.cs']);
    assert.equal(parsed.options.deep, true);
    assert.deepEqual(parseCommand(['scan', '--files=A.cs']).options.files, ['A.cs']);
    assertUsageError(() => parse(['scan', '--files', '--deep']), /at least one value/);
  });

  it('refuses missing and empty values', () => {
    assertUsageError(() => parse(['scan', '--logs']), /needs a value/);
    assertUsageError(() => parse(['scan', '--logs', '--deep']), /needs a value/);
    assertUsageError(() => parse(['scan', '--logs', '']), /must not be empty/);
    assertUsageError(() => parse(['scan', '--project=']), /must not be empty/);
    assertUsageError(() => parse(['scan', '  ']), /must not be empty/);
    assertUsageError(() => parse(['scan', '--files', 'A.cs', '']), /must not be empty/);
  });

  it('refuses a value on a boolean flag and repeated single-value options', () => {
    assertUsageError(() => parse(['scan', '--deep=true']), /does not take a value/);
    assertUsageError(() => parse(['scan', '--deep', '--deep']), /more than once/);
    assertUsageError(() => parse(['scan', '--logs', 'a', '--logs', 'b']), /more than once/);
  });

  it('refuses unknown options with a suggestion or a placement hint', () => {
    assert.throws(() => parse(['scan', '--dep']), (error) => {
      assert.equal(error.code, 'unknown_option');
      assert.match(error.message, /Unknown option '--dep' for 'scan'/);
      assert.match(error.hint, /Did you mean '--deep'\?/);
      return true;
    });
    assert.throws(() => parse(['--deep', 'scan']), (error) => {
      assert.equal(error.code, 'unknown_option');
      assert.match(error.hint, /Command options go after the command name/);
      return true;
    });
    assertUsageError(() => parse(['scan', '-x']), /Unknown option '-x'/, 'unknown_option');
  });

  it('refuses unknown commands with a suggestion', () => {
    assert.throws(() => parse(['scna']), (error) => {
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.equal(error.code, 'unknown_command');
      assert.match(error.hint, /Did you mean 'scan'\?/);
      return true;
    });
  });

  it('checks positionals: required, choices and extras', () => {
    assert.deepEqual(parseCommand(['run', 'a', '--label', 'x']).args, { suite: 'a' });
    assertUsageError(() => parse(['run', '--label', 'x']), /needs <suite>/);
    assertUsageError(() => parse(['run', 'c', '--label', 'x']), /expected one of: a, b/);
    assertUsageError(() => parse(['scan', 'one', 'two']), /Unexpected argument 'two'/, 'unexpected_argument');
  });

  it('requires required options', () => {
    assertUsageError(() => parse(['run', 'a']), /'run' needs --label/, 'missing_option');
  });

  it('treats everything after -- as positionals', () => {
    assert.deepEqual(parseCommand(['scan', '--', '--deep']).args, { path: '--deep' });
    assert.deepEqual(parseCommand(['scan', '-']).args, { path: '-' });
  });

  it('refuses options listed as refused with their reason', () => {
    assert.throws(() => parse(['scan', '--auto']), (error) => {
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.equal(error.code, 'refused_option');
      assert.match(error.message, /auto-approval is refused \(--auto\)/);
      return true;
    });
    assertUsageError(() => parse(['scan', '--auto=true']), /auto-approval is refused/, 'refused_option');
  });
});

describe('parseArgv: subcommands', () => {
  it('parses a subcommand with its own options and positionals', () => {
    const list = parseCommand(['job', 'list', '--since', '7d']);
    assert.equal(list.label, 'job list');
    assert.equal(list.subcommand?.name, 'list');
    assert.equal(list.options.since, '7d');
    const show = parseCommand(['job', 'show', 'abc']);
    assert.deepEqual(show.args, { jobId: 'abc' });
  });

  it('refuses a missing or unknown subcommand and options of a sibling subcommand', () => {
    assertUsageError(() => parse(['job']), /needs a subcommand: list, show/, 'missing_subcommand');
    assertUsageError(() => parse(['job', 'lst']), /Unknown subcommand 'job lst'/, 'unknown_command');
    assertUsageError(() => parse(['job', 'show', 'abc', '--since', '1d']), /Unknown option '--since'/);
  });
});

describe('parseArgv: help and version', () => {
  it('returns global help for no arguments or only global flags', () => {
    assert.deepEqual(parse([]), { kind: 'help', topic: [], global: parseGlobal([]) });
    const parsed = parse(['--json']);
    assert.equal(parsed.kind, 'help');
    assert.equal(parsed.global.json, true);
  });

  it('resolves help topics from --help, -h and the help word', () => {
    assert.deepEqual(helpTopic(['--help']), []);
    assert.deepEqual(helpTopic(['scan', '--help']), ['scan']);
    assert.deepEqual(helpTopic(['scan', '--logs', 'x', '-h']), ['scan']);
    assert.deepEqual(helpTopic(['job', 'show', '--help']), ['job', 'show']);
    assert.deepEqual(helpTopic(['job', 'nope', '--help']), ['job']);
    assert.deepEqual(helpTopic(['help']), []);
    assert.deepEqual(helpTopic(['help', 'job', 'list']), ['job', 'list']);
    assert.deepEqual(helpTopic(['--project', 'Dir', 'help', 'scan']), ['scan']);
    assert.deepEqual(helpTopic(['--project', 'Dir', '--help']), []);
  });

  it('shows help even when other flags are invalid, but not for unknown commands', () => {
    assert.deepEqual(helpTopic(['scan', '--bogus', '--help']), ['scan']);
    assertUsageError(() => parse(['nope', '--help']), /Unknown command 'nope'/);
    assertUsageError(() => parse(['help', 'nope']), /Unknown command 'nope'/);
  });

  it('ignores --help after the -- terminator', () => {
    assert.deepEqual(parseCommand(['scan', '--', '--help']).args, { path: '--help' });
  });

  it('returns a version request for --version anywhere', () => {
    assert.equal(parse(['--version']).kind, 'version');
    assert.equal(parse(['scan', '--version', '--json']).kind, 'version');
    assert.equal(parse(['--version', '--json']).global.json, true);
  });

  /**
   * @param {string[]} argv
   */
  function helpTopic(argv) {
    const parsed = parse(argv);
    assert.equal(parsed.kind, 'help');
    return /** @type {import('../../../src/cli/args.js').HelpRequest} */ (parsed).topic;
  }

  /**
   * @param {string[]} argv
   */
  function parseGlobal(argv) {
    return scanGlobalFlags(argv);
  }
});

describe('parseArgv: product command table', () => {
  it('refuses auto-approval flags on start with exit 1 (S6)', () => {
    for (const flag of ['--auto', '--yolo', '--dangerously-skip-permissions']) {
      assert.throws(() => parseArgv(['start', flag]), (error) => {
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.equal(error.code, 'refused_option');
        assert.match(error.message, /start refuses auto-approval flags/);
        return true;
      }, flag);
    }
  });

  it('parses start forwarding flags and agent choices', () => {
    const parsed = parseArgv(['start', 'MyGame', '--agent', 'unity-editor', '--prompt', 'add a null check', '--continue']);
    assert.equal(parsed.kind, 'command');
    if (parsed.kind !== 'command') return;
    assert.deepEqual(parsed.args, { path: 'MyGame' });
    assert.equal(parsed.options.agent, 'unity-editor');
    assert.equal(parsed.options.prompt, 'add a null check');
    assert.equal(parsed.options.continue, true);
    assert.throws(() => parseArgv(['start', '--agent', 'build']), /expected one of: unity-code, unity-editor/);
  });

  it('parses delegate subcommands with required options', () => {
    const parsed = parseArgv(['delegate', 'edit', '--task', '@task.md', '--files', 'Assets/A.cs', 'Assets/B.cs', '--check', 'auto', '--json']);
    assert.equal(parsed.kind, 'command');
    if (parsed.kind !== 'command') return;
    assert.equal(parsed.label, 'delegate edit');
    assert.deepEqual(parsed.options.files, ['Assets/A.cs', 'Assets/B.cs']);
    assert.equal(parsed.global.json, true);
    assert.throws(() => parseArgv(['delegate', 'map', '--task', 'x']), /needs --files/);
    assert.throws(() => parseArgv(['delegate', 'apply']), /needs <reviewId>/);
  });

  it('parses bench suites and setup delegate targets', () => {
    const bench = parseArgv(['bench', 'toolcalls', '--runs', '20', '--temperature', '0.2']);
    assert.equal(bench.kind === 'command' && bench.options.runs, 20);
    assert.throws(() => parseArgv(['bench', 'speed']), /expected one of/);
    const setup = parseArgv(['setup', '--delegate', 'claude,codex', '--no-model']);
    assert.equal(setup.kind, 'command');
    if (setup.kind !== 'command') return;
    assert.deepEqual(setup.options.delegate, ['claude', 'codex']);
    assert.equal(setup.options.noModel, true);
  });
});

describe('small helpers', () => {
  it('converts flag names to camelCase', () => {
    assert.equal(toCamelCase('dry-run'), 'dryRun');
    assert.equal(toCamelCase('dangerously-skip-permissions'), 'dangerouslySkipPermissions');
    assert.equal(toCamelCase('json'), 'json');
  });

  it('suggests names within an edit distance of 2', () => {
    assert.equal(suggestName('stat', ['start', 'status', 'stop']), 'start');
    assert.equal(suggestName('unistall', ['uninstall', 'upgrade']), 'uninstall');
    assert.equal(suggestName('completely-different', ['doctor']), undefined);
  });

  it('scans global flags loosely and stops at --', () => {
    assert.deepEqual(scanGlobalFlags(['x', '--json', '--no-color', '--', '--verbose']), {
      json: true,
      yes: false,
      dryRun: false,
      project: undefined,
      experimental: false,
      verbose: false,
      noColor: true,
    });
  });
});
