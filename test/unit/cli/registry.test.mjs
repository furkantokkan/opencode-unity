import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError, EXIT, isExitCode } from '../../../src/cli/exit-codes.js';
import {
  COMMANDS,
  GLOBAL_OPTIONS,
  findCommand,
  findSubcommand,
  getCommandModuleUrl,
  isCommandAvailable,
  loadCommandModule,
} from '../../../src/cli/registry.js';
import { coversCommand } from '../../../src/core/platform.js';

/** @typedef {import('../../../src/cli/registry.js').CommandSpec} CommandSpec */

const OPTION_NAME = /^[a-z][a-z0-9-]*$/;

describe('command registry', () => {
  it('matches the spec command surface (sections 5.4 and 5.5)', () => {
    assert.deepEqual(COMMANDS.map((command) => command.name), [
      'doctor', 'setup', 'init', 'start', 'status', 'guard', 'warm', 'stop', 'bench', 'delegate', 'upgrade', 'uninstall',
    ]);
    assert.deepEqual(findCommand('delegate')?.subcommands?.map((entry) => entry.name), ['health', 'ask', 'map', 'edit', 'apply', 'restore', 'ledger']);
  });

  it('keeps names, descriptions and exit codes well formed', () => {
    const globalNames = new Set(GLOBAL_OPTIONS.map((option) => option.name));
    for (const command of COMMANDS) {
      assert.equal(command.module, `../commands/${command.name}.js`, command.name);
      assert.ok(command.summary.length > 0, command.name);
      assert.ok(command.exitCodes.includes(EXIT.OK), `${command.name} lists exit 0`);
      for (const exitCode of command.exitCodes) assert.ok(isExitCode(exitCode), `${command.name}: ${exitCode}`);
      const targets = [command, ...(command.subcommands ?? [])];
      for (const target of targets) {
        const names = target.options.map((option) => option.name);
        assert.equal(new Set(names).size, names.length, `${target.name}: duplicate option`);
        for (const option of target.options) {
          assert.match(option.name, OPTION_NAME, `${target.name}: ${option.name}`);
          assert.ok(option.description.length > 0, `${target.name}: --${option.name} has a description`);
          assert.equal(globalNames.has(option.name), false, `${target.name}: --${option.name} redefines a global option`);
        }
      }
    }
  });

  it('refuses auto-approval flags on start (S6, D17)', () => {
    const start = /** @type {CommandSpec} */ (findCommand('start'));
    assert.deepEqual(Object.keys(start.refusedOptions ?? {}).sort(), ['auto', 'dangerously-skip-permissions', 'yolo']);
  });

  it('leaves platform support to the matrix and names every command in it (amendment 33.4)', () => {
    for (const command of COMMANDS) {
      assert.equal(command.platforms, undefined, `${command.name}: platform support belongs to src/core/tiers.json`);
      assert.equal(coversCommand(command.name), true, `${command.name}: the support matrix has no column for it`);
    }
  });

  it('finds commands and subcommands by name', () => {
    assert.equal(findCommand('nope'), undefined);
    const delegate = /** @type {CommandSpec} */ (findCommand('delegate'));
    assert.equal(findSubcommand(delegate, 'ask')?.name, 'ask');
    assert.equal(findSubcommand(delegate, 'nope'), undefined);
    assert.equal(findSubcommand(/** @type {CommandSpec} */ (findCommand('guard')), 'ask'), undefined);
  });

  it('resolves command modules under src/commands', () => {
    const url = getCommandModuleUrl(/** @type {CommandSpec} */ (findCommand('doctor')));
    assert.match(url.href, /\/src\/commands\/doctor\.js$/);
  });
});

describe('loadCommandModule', () => {
  /** @type {CommandSpec} */
  const missing = {
    name: 'missing',
    group: 'advanced',
    summary: 'Missing',
    module: '../commands/__does-not-exist__.js',
    positionals: [],
    options: [],
    exitCodes: [0],
  };

  it('reports a module that is not in the build yet as exit 8', async () => {
    assert.equal(isCommandAvailable(missing), false);
    await assert.rejects(loadCommandModule(missing), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, EXIT.UNSUPPORTED);
      assert.equal(error.code, 'command_not_available');
      return true;
    });
  });

  it('refuses a module without run()', async () => {
    // Any existing module without a run export works; the registry module itself is one.
    const notACommand = { ...missing, name: 'registry', module: './registry.js' };
    assert.equal(isCommandAvailable(notACommand), true);
    await assert.rejects(loadCommandModule(notACommand), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, EXIT.RUNTIME);
      assert.equal(error.code, 'invalid_command_module');
      return true;
    });
  });
});
