// The generated reference pages (spec 19, build step S19) must equal what their generators render from
// the registry, the support matrix, the config schema and the doctor checks. CI's lint job regenerates
// them and fails on a diff; this suite fails the same way locally, before a push.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { escapeProse, renderCliReference, OUTPUT_URL as CLI_OUTPUT_URL } from '../../scripts/gen-cli-docs.mjs';
import { collectRows, describeType, readSchema, renderConfigReference, resolve, OUTPUT_URL as CONFIG_OUTPUT_URL } from '../../scripts/gen-config-docs.mjs';
import { renderDoctorChecks, OUTPUT_URL as DOCTOR_OUTPUT_URL } from '../../scripts/gen-doctor-docs.mjs';
import { COMMANDS, GLOBAL_OPTIONS } from '../../src/cli/registry.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { loadTiers } from '../../src/core/platform.js';

/**
 * @param {URL} url
 * @returns {string}
 */
function readCommitted(url) {
  return fs.readFileSync(fileURLToPath(url), 'utf8');
}

describe('generated docs are current', () => {
  it('docs/cli-reference.md equals the registry rendering (node scripts/gen-cli-docs.mjs)', () => {
    assert.equal(readCommitted(CLI_OUTPUT_URL), renderCliReference());
  });

  it('docs/configuration.md equals the schema rendering (node scripts/gen-config-docs.mjs)', () => {
    assert.equal(readCommitted(CONFIG_OUTPUT_URL), renderConfigReference());
  });

  it('docs/doctor-checks.md equals the check registry rendering (node scripts/gen-doctor-docs.mjs)', () => {
    assert.equal(readCommitted(DOCTOR_OUTPUT_URL), renderDoctorChecks());
  });
});

describe('scripts/gen-cli-docs.mjs', () => {
  const page = renderCliReference();

  it('documents every command, subcommand, flag and exit code of the registry', () => {
    for (const command of COMMANDS) {
      assert.match(page, new RegExp(`^## ${command.name}$`, 'm'), command.name);
      for (const option of command.options) assert.ok(page.includes(`\`--${option.name}`), `${command.name} --${option.name}`);
      for (const subcommand of command.subcommands ?? []) {
        assert.match(page, new RegExp(`^### ${command.name} ${subcommand.name}$`, 'm'));
        for (const option of subcommand.options) assert.ok(page.includes(`\`--${option.name}`), `${command.name} ${subcommand.name} --${option.name}`);
      }
    }
    for (const option of GLOBAL_OPTIONS) assert.ok(page.includes(`\`--${option.name}`), `--${option.name}`);
    for (const info of EXIT_CODES) assert.match(page, new RegExp(`^\\| ${info.exitCode} \\| \`${info.name}\``, 'm'));
  });

  it('marks a command whose module is not in this build instead of leaving it out', () => {
    const page2 = renderCliReference({ isAvailable: (command) => command.name !== 'guard' });
    const guardSection = page2.slice(page2.indexOf('## guard'), page2.indexOf('## warm'));
    assert.match(guardSection, /Not available in this build/);
  });

  it('renders one support-matrix row per tiers.json row, with only the commands the registry has', () => {
    const tiers = loadTiers();
    for (const row of tiers.rows) assert.ok(page.includes(`| ${escapeProse(row.label)} |`), row.label);
    const header = page.split('\n').find((line) => line.startsWith('| Platform |')) ?? '';
    assert.ok(header.includes('`shape`'), 'the shipped shape command is in the support matrix');
    assert.ok(header.includes('`delegate`'));
  });

  it('escapes pipes inside table cells and angle brackets outside code', () => {
    assert.match(page, /`--agent <unity-code\\\|unity-editor>`/);
    assert.equal(escapeProse('keyed by <id> and `<code>`'), 'keyed by &lt;id&gt; and `<code>`');
  });
});

describe('scripts/gen-config-docs.mjs', () => {
  const schema = readSchema();
  const page = renderConfigReference(schema);

  it('lists every leaf key of the schema once, with its default', () => {
    const rows = Object.entries(schema.properties).flatMap(([name, property]) => collectRows(schema, name, /** @type {any} */ (property)));
    assert.ok(rows.length > 40, `only ${rows.length} rows`);
    for (const row of rows) {
      const matches = page.split('\n').filter((line) => line.startsWith(`| \`${row.key}\` |`));
      assert.equal(matches.length, 1, row.key);
    }
    assert.ok(rows.some((row) => row.key === 'projects.<project-id>.editor.enabled'), 'keyed objects are expanded under a placeholder');
    const target = rows.find((row) => row.key === 'budget.prefixTargetTokens.unity-code');
    assert.equal(target?.defaultValue, '`5000`', "a parent object's default reaches the keys below it");
  });

  it('describes types from the schema keywords', () => {
    assert.equal(describeType(schema, { enum: ['a', 'b'] }), 'one of `"a"`, `"b"`');
    assert.equal(describeType(schema, { type: 'integer', minimum: 0, maximum: 5 }), 'integer (0 to 5)');
    assert.equal(describeType(schema, { type: 'number', exclusiveMinimum: 0, maximum: 10 }), 'number (above 0, at most 10)');
    assert.equal(describeType(schema, { type: ['string', 'null'] }), 'string or null');
    assert.equal(describeType(schema, { type: 'array', items: { type: 'string' } }), 'array of strings');
    assert.equal(describeType(schema, { const: 1 }), '`1` (fixed)');
  });

  it('resolves a $ref and keeps the referring keywords', () => {
    const resolved = resolve(schema, { $ref: '#/$defs/maxGpuUtilPercent', default: 60 });
    assert.equal(resolved.type, 'integer');
    assert.equal(resolved.default, 60);
    assert.throws(() => resolve(schema, { $ref: '#/$defs/doesNotExist' }), /Unresolvable/);
  });
});
