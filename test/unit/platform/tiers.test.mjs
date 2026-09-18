import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  TIER_ORDER,
  describePlatform,
  loadTiers,
  readTiersSchema,
  resolveTier,
  resolveTiers,
  selectTierRow,
  validateTiers,
  worstTier,
} from '../../../src/core/platform.js';

const tiers = loadTiers();
const schema = readTiersSchema();

/** Commands that are `full` on every row, because they touch no model and no accelerator (33.4). */
const RUN_ANYWHERE = ['init', 'host', 'shape-no-model', 'upgrade', 'uninstall'];

/** Commands the matrix moves together: they all reach Ollama or the guard. */
const MODEL_COMMANDS = ['setup', 'start', 'status', 'guard', 'warm', 'stop', 'bench', 'delegate', 'shape'];

/**
 * @param {string} doctor
 * @param {string} model
 * @returns {Record<string, string>}
 */
function expectRow(doctor, model) {
  return Object.fromEntries([['doctor', doctor], ...RUN_ANYWHERE.map((name) => [name, 'full']), ...MODEL_COMMANDS.map((name) => [name, model])]);
}

/**
 * @param {Partial<import('../../../src/core/platform.js').PlatformFacts>} overrides
 * @returns {import('../../../src/core/platform.js').PlatformFacts}
 */
function facts(overrides) {
  return {
    os: /** @type {NodeJS.Platform} */ ('linux'),
    arch: 'x64',
    release: '0.0.0',
    osVersionSupported: null,
    virtualization: null,
    virtualizationSignals: [],
    shellFamily: 'posix',
    backend: 'unknown',
    ...overrides,
  };
}

/** One machine per column of the amendment's 33.4 matrix, plus the two rows that override a column. */
const COLUMNS = [
  { row: 'windows', machine: facts({ os: 'win32', arch: 'x64', backend: 'nvidia-smi', osVersionSupported: true, shellFamily: 'powershell' }), expected: expectRow('full', 'full') },
  { row: 'linux-nvidia', machine: facts({ os: 'linux', arch: 'x64', backend: 'nvidia-smi' }), expected: expectRow('full', 'experimental') },
  { row: 'linux-amdgpu', machine: facts({ os: 'linux', arch: 'x64', backend: 'amdgpu-sysfs' }), expected: expectRow('full', 'experimental') },
  { row: 'darwin-apple-silicon', machine: facts({ os: 'darwin', arch: 'arm64', backend: 'darwin-unified', osVersionSupported: true }), expected: expectRow('degraded', 'experimental') },
  { row: 'darwin-intel', machine: facts({ os: 'darwin', arch: 'x64', backend: 'none', osVersionSupported: true }), expected: expectRow('degraded', 'refused') },
  { row: 'linux-arm64', machine: facts({ os: 'linux', arch: 'arm64', backend: 'none' }), expected: expectRow('degraded', 'refused') },
  { row: 'virtualized', machine: facts({ os: 'linux', arch: 'x64', backend: 'nvidia-smi', virtualization: 'wsl' }), expected: expectRow('full', 'refused') },
  { row: 'virtualized', machine: facts({ os: 'linux', arch: 'x64', backend: 'nvidia-smi', virtualization: 'container' }), expected: expectRow('full', 'refused') },
  { row: 'os-version-unsupported', machine: facts({ os: 'win32', arch: 'x64', backend: 'nvidia-smi', osVersionSupported: false }), expected: expectRow('full', 'refused') },
  { row: 'unsupported', machine: facts({ os: /** @type {NodeJS.Platform} */ ('freebsd'), arch: 'x64' }), expected: expectRow('degraded', 'refused') },
];

describe('tiers.json as data', () => {
  it('validates against schema/tiers.schema.json', () => {
    assert.deepEqual(validateTiers(tiers), []);
  });

  it('covers every command the schema requires, and nothing else', () => {
    const required = schema.$defs.row.properties.tiers.required;
    assert.deepEqual([...tiers.commands].sort(), [...required].sort());
    assert.deepEqual([...tiers.capabilities].sort(), [...schema.$defs.capability.enum].sort());
  });

  it('states a tier for every command on every row, because a missing cell is a failure and not a default', () => {
    for (const row of tiers.rows) {
      assert.deepEqual(Object.keys(row.tiers).sort(), [...tiers.commands].sort(), `row '${row.id}'`);
      for (const command of tiers.commands) assert.ok(TIER_ORDER.includes(row.tiers[command].tier), `row '${row.id}' command '${command}'`);
    }
  });

  it('has unique row ids and exactly one fallback row, last', () => {
    const ids = tiers.rows.map((/** @type {{ id: string }} */ row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
    const fallbacks = tiers.rows.filter((/** @type {{ match: object }} */ row) => Object.keys(row.match).length === 0);
    assert.equal(fallbacks.length, 1);
    assert.equal(tiers.rows.at(-1), fallbacks[0]);
  });

  it('gives every refusal a reason with shipped text, and never leaves a degraded cell unexplained', () => {
    for (const row of tiers.rows) {
      for (const command of tiers.commands) {
        const cell = row.tiers[command];
        const where = `row '${row.id}' command '${command}'`;
        if (cell.tier === 'refused') assert.ok(cell.reason, `${where} must name a reason`);
        if (cell.reason) assert.ok(typeof tiers.reasons[cell.reason] === 'string', `${where} names an unknown reason`);
        if (cell.tier === 'degraded' || cell.degraded === true) {
          assert.ok((cell.notMeasured ?? []).length > 0 || typeof cell.note === 'string', `${where} degrades without saying what is missing`);
        }
      }
    }
  });

  it('keeps the refusal sentences verbatim, so no caller writes its own', () => {
    assert.equal(tiers.reasons.darwin_intel, 'Ollama runs on CPU only on Intel Macs, so a 30B model is not usable for agent work. doctor and init still run.');
    assert.equal(tiers.reasons.linux_arm64, 'The Unity Editor is not available for Linux on arm64, so there is no project for this command to act on. doctor and init still run.');
    assert.equal(tiers.reasons.virtualized_host, 'The Unity Editor runs outside this environment, so the GPU guard cannot see it. Run opencode-unity on the host instead.');
    assert.equal(tiers.reasons.os_version, 'Ollama does not support this OS version.');
    assert.equal(tiers.reasons.no_shipped_preset, 'No shipped preset matches this hardware. Re-run with --experimental --preset custom, or open a hardware report.');
  });

  it('is the file the module reads, not a copy', () => {
    const onDisk = JSON.parse(fs.readFileSync(new URL('../../../src/core/tiers.json', import.meta.url), 'utf8'));
    assert.deepEqual(tiers, onDisk);
  });
});

describe('selectTierRow', () => {
  it('picks the documented row for every column of the matrix', () => {
    for (const column of COLUMNS) assert.equal(selectTierRow(column.machine).id, column.row, JSON.stringify(column.machine));
  });

  it('lets virtualization win over the platform row, because every probe succeeds there and lies', () => {
    assert.equal(selectTierRow(facts({ os: 'win32', arch: 'x64', osVersionSupported: true, virtualization: 'container' })).id, 'virtualized');
  });

  it('treats an undetermined OS version as not a refusal', () => {
    assert.equal(selectTierRow(facts({ os: 'win32', arch: 'x64', osVersionSupported: null })).id, 'windows');
    assert.equal(selectTierRow(facts({ os: 'win32', arch: 'x64', osVersionSupported: false })).id, 'os-version-unsupported');
  });

  it('sends an architecture the matrix never measured to the fallback row rather than to the nearest one', () => {
    assert.equal(selectTierRow(facts({ os: 'win32', arch: 'arm64', osVersionSupported: true })).id, 'unsupported');
  });

  it('separates the two Linux accelerator columns only by backend', () => {
    assert.equal(selectTierRow(facts({ os: 'linux', backend: 'amdgpu-sysfs' })).id, 'linux-amdgpu');
    assert.equal(selectTierRow(facts({ os: 'linux', backend: 'none' })).id, 'linux-nvidia');
    assert.equal(selectTierRow(facts({ os: 'linux', backend: 'unknown' })).id, 'linux-nvidia');
  });
});

describe('resolveTier (amendment 33.4)', () => {
  for (const column of COLUMNS) {
    it(`matches the printed cell for ${column.row} (${column.machine.os}/${column.machine.arch}/${column.machine.backend}/${column.machine.virtualization ?? 'host'})`, () => {
      const resolved = resolveTiers(column.machine);
      assert.deepEqual(Object.keys(resolved).sort(), [...tiers.commands].sort());
      for (const [command, tier] of Object.entries(column.expected)) {
        assert.equal(resolved[command].tier, tier, `${column.row}: ${command}`);
        assert.equal(resolved[command].row, column.row);
      }
    });
  }

  it('reports macOS as degraded for the capability it cannot measure', () => {
    const doctor = resolveTier('doctor', COLUMNS[3].machine);
    assert.equal(doctor.tier, 'degraded');
    assert.equal(doctor.degraded, true);
    assert.deepEqual(doctor.notMeasured, ['accelerator.utilization']);
    const start = resolveTier('start', COLUMNS[3].machine);
    assert.equal(start.tier, 'experimental');
    assert.equal(start.degraded, true, 'experimental and degraded compose');
    assert.deepEqual(start.notMeasured, ['accelerator.utilization']);
  });

  it('marks Apple silicon setup as having no shipped preset', () => {
    assert.equal(resolveTier('setup', COLUMNS[3].machine).noShippedPreset, true);
    assert.equal(resolveTier('setup', COLUMNS[0].machine).noShippedPreset, false);
  });

  it('labels the Linux amdgpu backend experimental while doctor itself stays full', () => {
    const doctor = resolveTier('doctor', COLUMNS[2].machine);
    assert.equal(doctor.tier, 'full');
    assert.equal(doctor.experimentalBackend, true);
    assert.equal(resolveTier('doctor', COLUMNS[1].machine).experimentalBackend, false);
  });

  it('carries the verbatim refusal text on a refused cell', () => {
    const start = resolveTier('start', COLUMNS[4].machine);
    assert.equal(start.tier, 'refused');
    assert.equal(start.reason, 'darwin_intel');
    assert.equal(start.message, tiers.reasons.darwin_intel);
  });

  it('keeps doctor running inside WSL and asks it to raise an ERROR finding', () => {
    const doctor = resolveTier('doctor', COLUMNS[6].machine);
    assert.equal(doctor.tier, 'full');
    assert.equal(doctor.errorFinding, true);
    assert.equal(doctor.message, tiers.reasons.virtualized_host);
    assert.equal(resolveTier('shape-no-model', COLUMNS[6].machine).tier, 'full');
    assert.equal(resolveTier('shape', COLUMNS[6].machine).tier, 'refused');
  });

  it('never refuses upgrade or uninstall, so an install can always be removed', () => {
    for (const column of COLUMNS) {
      for (const command of ['upgrade', 'uninstall', 'init', 'host']) {
        assert.equal(resolveTier(command, column.machine).tier, 'full', `${column.row}: ${command}`);
      }
    }
  });

  it('refuses a command the matrix does not cover instead of guessing one', () => {
    assert.throws(() => resolveTier('teleport', COLUMNS[0].machine), /does not cover the command 'teleport'/);
  });

  it('returns a copy of notMeasured, so a caller cannot edit the shipped matrix', () => {
    const first = resolveTier('doctor', COLUMNS[3].machine);
    first.notMeasured.push('process.classify');
    assert.deepEqual(resolveTier('doctor', COLUMNS[3].machine).notMeasured, ['accelerator.utilization']);
  });
});

describe('worstTier and describePlatform', () => {
  it('orders the tiers from full to refused', () => {
    assert.deepEqual([...TIER_ORDER], ['full', 'degraded', 'experimental', 'refused']);
    assert.equal(worstTier('full', 'degraded'), 'degraded');
    assert.equal(worstTier('experimental', 'degraded'), 'experimental');
    assert.equal(worstTier('refused', 'full'), 'refused');
    assert.equal(worstTier('full', 'full'), 'full');
  });

  it('builds the data.platform object an exit 8 envelope carries', () => {
    const machine = COLUMNS[4].machine;
    assert.deepEqual(describePlatform(machine, resolveTier('start', machine)), {
      os: 'darwin',
      arch: 'x64',
      backend: 'none',
      tier: 'refused',
      reason: 'darwin_intel',
      notMeasured: [],
    });
  });
});
