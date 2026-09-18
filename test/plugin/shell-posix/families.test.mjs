// The shell family table (amendment 33.7). The grammars live in `shell-families.json` so a family is
// described rather than branched on, which is what stops a second family from silently inheriting the
// first one's quote handling. What this file pins down is the shape the classifier depends on, the
// rule that no family may be more permissive than the shared set, and the refusal to load a table that
// does not describe a usable grammar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  COMMAND_PREFIXES,
  SHELL_FAMILIES,
  SHELL_FAMILIES_URL,
  SHELL_FAMILY_IDS,
  SHELL_PROGRAM_FAMILIES,
  WRAPPER_PROGRAMS,
  loadShellFamilies,
} from '../../../plugin/opencode-unity-lib/shell-classify.js';
import { catchError } from '../../helpers/catch-error.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';

const SHIPPED_TEXT = fs.readFileSync(SHELL_FAMILIES_URL, 'utf8');
const SHIPPED = JSON.parse(SHIPPED_TEXT);

/**
 * Writes a family table into the sandbox and loads it, so a malformed shape is proved to be refused
 * rather than assumed to be.
 * @param {import('../../helpers/sandbox.mjs').Sandbox} sandbox
 * @param {unknown} value
 * @param {string} name
 */
function loadTable(sandbox, value, name) {
  const file = sandbox.path(`${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return loadShellFamilies(pathToFileURL(file));
}

/** A deep copy of the shipped table, so a test can break exactly one field of a valid file. */
function validTable() {
  return JSON.parse(SHIPPED_TEXT);
}

describe('the shipped shell family table', () => {
  it('models the three families the classifier names', () => {
    assert.deepEqual([...SHELL_FAMILY_IDS].sort(), ['cmd', 'posix', 'powershell']);
    for (const id of SHELL_FAMILY_IDS) {
      const family = SHELL_FAMILIES[id];
      assert.equal(family.id, id);
      assert.ok(family.label.length > 0);
      assert.ok(family.separators.length > 0);
      assert.ok(family.unmodelled.length > 0);
      assert.ok(Object.isFrozen(family));
    }
  });

  it('spells every control character as an escape sequence, so the file stays scannable text', () => {
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(SHIPPED_TEXT));
  });

  it('gives every family the shared metacharacter set, so no family is more permissive than another', () => {
    const shared = SHIPPED.common.unmodelled.map((entry) => new RegExp(entry.pattern, entry.flags ?? '').source);
    for (const id of SHELL_FAMILY_IDS) {
      const sources = SHELL_FAMILIES[id].unmodelled.map((entry) => entry.pattern.source);
      for (const source of shared) assert.ok(sources.includes(source), `${id} is missing ${source}`);
    }
  });

  it('puts the family entries first, so a family keeps its own wording for the shapes that matter to it', () => {
    // `::` is shared, but on PowerShell it is the static member operator and the message says so.
    const powershell = SHELL_FAMILIES.powershell.unmodelled.find((entry) => entry.pattern.source === '::');
    assert.equal(powershell?.what, 'the static member operator');
    assert.equal(SHELL_FAMILIES.posix.unmodelled.find((entry) => entry.pattern.source === '::')?.what, 'a label or member operator');
  });

  it('keeps the regular expression flags a pattern asks for', () => {
    const insensitive = SHELL_FAMILIES.powershell.unmodelled.find((entry) => entry.pattern.flags.includes('i'));
    assert.ok(insensitive, 'the string construction operator is matched case-insensitively');
    assert.ok(insensitive.pattern.test(' -JOIN '));
  });

  it('describes the quoting of each family instead of leaving it to the tokenizer', () => {
    // Nothing expands inside a single-quoted run on posix or powershell; cmd has no literal quote.
    assert.equal(SHELL_FAMILIES.posix.quoting.escape, 'backslash');
    assert.deepEqual([...SHELL_FAMILIES.posix.quoting.escapeInQuotes], ['"']);
    assert.equal(SHELL_FAMILIES.posix.quoting.expands["'"], '');
    assert.ok(SHELL_FAMILIES.posix.quoting.expands['"'].includes('$'));
    assert.equal(SHELL_FAMILIES.powershell.quoting.escape, 'doubled');
    assert.equal(SHELL_FAMILIES.cmd.quoting.expands["'"], '%');
    for (const id of SHELL_FAMILY_IDS) {
      assert.deepEqual([...SHELL_FAMILIES[id].quoteChars], ['"', "'"]);
    }
  });

  it('marks the leading slash as a switch only where a leading slash is not a path', () => {
    assert.ok(!SHELL_FAMILIES.posix.switchPrefixes.includes('/'));
    assert.ok(SHELL_FAMILIES.powershell.switchPrefixes.includes('/'));
    assert.ok(SHELL_FAMILIES.cmd.switchPrefixes.includes('/'));
  });
});

describe('the shell names the table knows', () => {
  it('maps every shell it names to a family it models', () => {
    assert.ok(Object.keys(SHELL_PROGRAM_FAMILIES).length >= 10);
    for (const [name, id] of Object.entries(SHELL_PROGRAM_FAMILIES)) {
      assert.ok(SHELL_FAMILY_IDS.includes(id), `${name} names ${id}`);
    }
    // Every POSIX shell a host can hand the agent reads its commands with one grammar.
    for (const name of ['sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'busybox']) {
      assert.equal(SHELL_PROGRAM_FAMILIES[name], 'posix', name);
    }
    assert.equal(SHELL_PROGRAM_FAMILIES.pwsh, 'powershell');
    assert.equal(SHELL_PROGRAM_FAMILIES.cmd, 'cmd');
  });

  it('treats every shell and every command prefix as a wrapper', () => {
    for (const name of [...Object.keys(SHELL_PROGRAM_FAMILIES), ...COMMAND_PREFIXES]) {
      assert.ok(WRAPPER_PROGRAMS.includes(name), name);
    }
    assert.equal(WRAPPER_PROGRAMS.length, new Set(WRAPPER_PROGRAMS).size, 'wrappers are listed once');
  });
});

describe('a family table that does not describe a usable grammar', () => {
  it('loads the shipped table as itself', async (t) => {
    const sandbox = await useSandbox(t, 'shell-families');
    const loaded = loadTable(sandbox, validTable(), 'valid');
    assert.deepEqual(Object.keys(loaded.families).sort(), ['cmd', 'posix', 'powershell']);
    assert.ok(Object.isFrozen(loaded.families));
  });

  const breakages = [
    ['an unsupported schema version', (table) => { table.schemaVersion = 2; }, /schemaVersion/],
    ['no families at all', (table) => { table.families = {}; }, /no families/],
    ['a shared set that is not an array', (table) => { table.common.unmodelled = 'everything'; }, /common\.unmodelled/],
    ['a pattern with no description', (table) => { table.common.unmodelled[0] = { pattern: '!' }; }, /pattern and a description/],
    ['a family with no separators', (table) => { table.families.posix.separators = []; }, /no separators/],
    ['separators that are not strings', (table) => { table.families.posix.separators = [1]; }, /separators/],
    ['a family with no label', (table) => { delete table.families.posix.label; }, /label/],
    ['an unknown escape rule', (table) => { table.families.posix.quoting.escape = 'caret'; }, /backslash or doubled/],
    ['a quote map that is empty', (table) => { table.families.posix.quoting.expands = {}; }, /expands/],
    ['a quote whose expansions are not a string', (table) => { table.families.posix.quoting.expands["'"] = null; }, /expands/],
    ['escape targets that are not strings', (table) => { table.families.posix.quoting.escapeInQuotes = [3]; }, /escapeInQuotes/],
    ['switch prefixes that are not an array', (table) => { table.families.posix.switchPrefixes = '-'; }, /switchPrefixes/],
    ['a shell map that is not an object', (table) => { table.shells = ['bash']; }, /shells must be an object/],
    ['a shell that names a family that does not exist', (table) => { table.shells.nu = 'nushell'; }, /does not exist/],
    ['command prefixes that are not strings', (table) => { table.commandPrefixes = [null]; }, /commandPrefixes/],
    ['a keyword list that is missing', (table) => { delete table.unmodelledCommands; }, /unmodelledCommands/],
    ['keywords that are not strings', (table) => { table.unmodelledCommands = [1]; }, /unmodelledCommands/],
    ['argument patterns that are not an array', (table) => { table.common.unmodelledArguments = 'alias:'; }, /unmodelledArguments/],
  ];

  for (const [label, breakIt, message] of breakages) {
    it(`refuses ${label}`, async (t) => {
      const sandbox = await useSandbox(t, 'shell-families');
      const table = validTable();
      breakIt(table);
      const error = catchError(() => loadTable(sandbox, table, 'broken'));
      assert.ok(error instanceof TypeError, `${label}: ${error}`);
      assert.match(error.message, message);
    });
  }
});
