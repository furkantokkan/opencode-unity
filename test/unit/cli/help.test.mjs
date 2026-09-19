import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HELP_GROUPS, formatUsage, getCommandGroups, renderCommandHelp, renderGlobalHelp, renderHelp } from '../../../src/cli/help.js';
import { COMMANDS, findCommand, findSubcommand } from '../../../src/cli/registry.js';
import { DISCLAIMER, formatVersionLine } from '../../../src/cli/version.js';

const allAvailable = () => true;

/**
 * @param {string} text
 * @param {string} heading
 * @returns {string[]} Non-empty lines between the heading and the next blank line.
 */
function getSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/**
 * @param {string[]} rows
 * @returns {string[]} First word of each row.
 */
function getFirstWords(rows) {
  return rows.map((row) => row.trim().split(/\s+/)[0]);
}

describe('help groups (D15)', () => {
  it('groups the four everyday verbs first, then the advanced verbs', () => {
    assert.deepEqual(HELP_GROUPS.map((group) => group.title), ['Everyday', 'Advanced']);
    const groups = getCommandGroups();
    assert.deepEqual(groups[0].commands.map((command) => command.name), ['doctor', 'setup', 'init', 'start']);
    assert.deepEqual(groups[1].commands.map((command) => command.name), [
      'status', 'guard', 'warm', 'stop', 'bench', 'delegate', 'upgrade', 'uninstall',
    ]);
  });

  it('lists every registered command exactly once', () => {
    const listed = getCommandGroups().flatMap((group) => group.commands.map((command) => command.name));
    assert.deepEqual([...listed].sort(), COMMANDS.map((command) => command.name).sort());
  });

  it('renders the groups in order in the global help', () => {
    const text = renderGlobalHelp({ isAvailable: allAvailable });
    assert.deepEqual(getFirstWords(getSection(text, 'Everyday')), ['doctor', 'setup', 'init', 'start']);
    assert.deepEqual(getFirstWords(getSection(text, 'Advanced')), ['status', 'guard', 'warm', 'stop', 'bench', 'delegate', 'upgrade', 'uninstall']);
    assert.ok(text.indexOf('Everyday') < text.indexOf('Advanced'));
  });
});

describe('renderGlobalHelp', () => {
  it('starts with the version line and its unofficial disclaimer', () => {
    const text = renderGlobalHelp({ isAvailable: allAvailable, version: '9.9.9' });
    assert.equal(text.split('\n')[0], formatVersionLine('9.9.9'));
    assert.ok(text.split('\n')[0].includes(DISCLAIMER));
  });

  it('lists global options and every exit code', () => {
    const text = renderGlobalHelp({ isAvailable: allAvailable });
    const options = getFirstWords(getSection(text, 'Global options'));
    assert.deepEqual(options, ['--json', '--yes', '--dry-run', '--project', '--experimental', '--verbose', '--no-color', '--help', '--version']);
    assert.deepEqual(getFirstWords(getSection(text, 'Exit codes')), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '130']);
  });

  it('marks commands whose module is not in the build', () => {
    const text = renderGlobalHelp({ isAvailable: (command) => command.name !== 'bench' });
    const benchRow = getSection(text, 'Advanced').find((row) => row.trim().startsWith('bench'));
    assert.match(String(benchRow), /\(not available in this build\)$/);
    const doctorRow = getSection(text, 'Everyday').find((row) => row.trim().startsWith('doctor'));
    assert.doesNotMatch(String(doctorRow), /not available/);
  });

  it('aligns summaries across both groups', () => {
    const text = renderGlobalHelp({ isAvailable: allAvailable });
    const rows = [...getSection(text, 'Everyday'), ...getSection(text, 'Advanced')];
    const columns = new Set(COMMANDS.map((command, index) => {
      const row = rows.find((candidate) => candidate.includes(command.summary));
      assert.ok(row, `row for ${command.name} (${index})`);
      return row.indexOf(command.summary);
    }));
    assert.equal(columns.size, 1);
  });
});

describe('renderCommandHelp', () => {
  it('shows usage, arguments, options and exit codes for a command', () => {
    const doctor = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('doctor'));
    const text = renderCommandHelp(doctor, undefined, { isAvailable: allAvailable });
    assert.match(text, /^ {2}opencode-unity doctor \[path\] \[options\]$/m);
    assert.deepEqual(getFirstWords(getSection(text, 'Arguments')), ['[path]']);
    assert.ok(getSection(text, 'Options').some((row) => /--logs <path>/.test(row)));
    const exitRows = getSection(text, 'Exit codes');
    // 8 is --capture and --selftest reporting prerequisite_missing until they land.
    assert.deepEqual(getFirstWords(exitRows.filter((row) => /^\s*\d/.test(row))), ['0', '1', '5', '7', '8']);
    // The command's own table never names every outcome, so help must not read as exhaustive.
    assert.ok(exitRows.some((row) => row.includes('Any command can also exit 130 (INTERRUPTED).')));
  });

  it('names the universal exit codes a command table leaves out', () => {
    const guard = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('guard'));
    const text = renderCommandHelp(guard, undefined, { isAvailable: allAvailable });
    assert.ok(getSection(text, 'Exit codes').some((row) => row.includes('Any command can also exit 1 (USAGE), 7 (RUNTIME) or 130 (INTERRUPTED).')));
  });

  it('lists subcommands for delegate and options for one subcommand', () => {
    const delegate = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('delegate'));
    const text = renderCommandHelp(delegate, undefined, { isAvailable: allAvailable });
    assert.deepEqual(getFirstWords(getSection(text, 'Subcommands')), ['on', 'off', 'status', 'monitor', 'health', 'ask', 'map', 'edit', 'apply', 'restore', 'ledger']);
    const apply = findSubcommand(delegate, 'apply');
    const applyText = renderCommandHelp(delegate, apply, { isAvailable: allAvailable });
    assert.match(applyText, /opencode-unity delegate apply <reviewId> \[options\]/);
    assert.ok(getSection(applyText, 'Options').some((row) => row.includes('--check <auto|command>')));
  });

  it('shows choices, list values and required markers', () => {
    const start = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('start'));
    assert.match(renderCommandHelp(start, undefined, { isAvailable: allAvailable }), /--agent <unity-code\|unity-editor>/);
    const setup = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('setup'));
    assert.match(renderCommandHelp(setup, undefined, { isAvailable: allAvailable }), /--delegate <targets> .*comma-separated: claude, codex/);
    const delegate = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('delegate'));
    assert.match(renderCommandHelp(delegate, findSubcommand(delegate, 'ask'), { isAvailable: allAvailable }), /--task <text\|@file> .*\(required\)/);
  });

  it('formats usage lines', () => {
    const bench = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('bench'));
    assert.equal(formatUsage(bench), 'opencode-unity bench <suite> [options]');
    const delegate = /** @type {import('../../../src/cli/registry.js').CommandSpec} */ (findCommand('delegate'));
    assert.equal(formatUsage(delegate), 'opencode-unity delegate <subcommand> [options]');
  });
});

describe('renderHelp', () => {
  it('routes topics to global, command and subcommand help', () => {
    const options = { isAvailable: allAvailable };
    assert.equal(renderHelp([], options), renderGlobalHelp(options));
    assert.match(renderHelp(['warm'], options), /opencode-unity warm \[options\]/);
    assert.match(renderHelp(['delegate', 'ledger'], options), /--since <duration>/);
  });
});
