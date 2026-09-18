// The registry is the single source for the run order, `--explain` and docs/doctor-checks.md, so its
// shape is tested here and the generated page is compared byte for byte (spec 19, 21.1).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS, CHECK_ID_PATTERN, findCheck, listCheckIds, validateRegistry } from '../../src/doctor/checks/index.js';
import { checkBannedPhrases, checkExperimentalLabels, checkNumbersHaveEvidence, hasMeasurement, parseMarkdown } from '../../scripts/check-claims.mjs';
import { OUTPUT_URL, main as generate, renderDoctorChecks } from '../../scripts/gen-doctor-docs.mjs';

/** Spec 5.4's table, by id. Every one of them ships in this step. */
const SPEC_5_4_IDS = Object.freeze([
  'ollama.reachable', 'ollama.version', 'ollama.loopback',
  'model.installed', 'model.system-ignored', 'model.num-ctx', 'model.renderer',
  'opencode.version', 'opencode.no-limit', 'opencode.limit-exceeds-numctx', 'opencode.temperature-capability',
  'instructions.injected', 'instructions.nested',
  'tools.mcp-schema', 'mcp.duplicate-server',
  'budget.fixed-prefix',
  'logs.truncation', 'logs.sampling-default',
  'vram.headroom', 'gpu.guard', 'gpu.driver-resets',
  'permissions.serialized-assets', 'permissions.vcs-writes', 'permissions.auto-approve-risk',
  'privacy.cloud-keys', 'terminal.host',
  'unity.compile-check', 'unity.facts-stale', 'unity.opencode-dir',
  'delegate.codex-legacy-path',
]);

/** Amendment 38.3a rows this step owns: the six platform checks and the node prefix check (33.9). */
const AMENDMENT_PLATFORM_IDS = Object.freeze([
  'platform.tier', 'platform.accelerator-backend', 'platform.probe-missing', 'platform.virtualized-host',
  'platform.unified-memory-cap', 'platform.linux-ollama-journal', 'node.global-prefix-writable',
]);

/** Area prefixes that belong to later steps (38.3a owners S39, S58, S41, and host checks). */
const LATER_STEP_PREFIXES = Object.freeze(['network.', 'component.', 'firebase.', 'db.', 'multiplayer.', 'shape.', 'host.']);

describe('the check registry', () => {
  it('is structurally valid', () => {
    assert.deepEqual(validateRegistry(), []);
  });

  it('ships every check spec 5.4 names and every platform check of 38.3a', () => {
    const ids = new Set(listCheckIds());
    for (const id of [...SPEC_5_4_IDS, ...AMENDMENT_PLATFORM_IDS]) assert.ok(ids.has(id), `missing ${id}`);
  });

  it('leaves the later steps\' areas to them', () => {
    const early = listCheckIds().filter((id) => LATER_STEP_PREFIXES.some((prefix) => id.startsWith(prefix)));
    assert.deepEqual(early, []);
  });

  it('finds a check by id', () => {
    assert.equal(findCheck('gpu.guard')?.group, 'gpu');
    assert.equal(findCheck('nope'), undefined);
  });

  it('reports duplicate ids, unknown groups, bad ids, outcome severities and empty text', () => {
    const base = CHECKS[0];
    const problems = validateRegistry([
      base,
      base,
      { ...base, id: 'x.unknown-group', group: 'nowhere' },
      { ...base, id: 'BadId' },
      { ...base, id: 'x.no-range', severities: [] },
      { ...base, id: 'x.outcome', severities: ['pass'] },
      { ...base, id: 'x.empty', why: '  ' },
    ]);
    assert.equal(problems.length, 6);
    assert.ok(problems.some((problem) => problem.includes('duplicate')));
    assert.ok(problems.some((problem) => problem.includes('unknown group')));
    assert.ok(problems.some((problem) => problem.includes('<area>.<kebab-case>')));
    assert.ok(problems.some((problem) => problem.includes('no severity range')));
    assert.ok(problems.some((problem) => problem.includes('outcome rather than a range')));
    assert.ok(problems.some((problem) => problem.includes('empty why')));
  });

  it('accepts dotted kebab-case ids only', () => {
    assert.ok(CHECK_ID_PATTERN.test('permissions.auto-approve-risk'));
    assert.ok(!CHECK_ID_PATTERN.test('permissions'));
    assert.ok(!CHECK_ID_PATTERN.test('Permissions.x'));
    assert.ok(!CHECK_ID_PATTERN.test('a.b-'));
  });

  it('writes check text without measured numbers, so the docs page needs no evidence links', () => {
    for (const check of CHECKS) {
      for (const text of [check.why, check.fix, check.title]) {
        assert.equal(hasMeasurement(text), false, `${check.id}: '${text}'`);
      }
    }
  });
});

describe('docs/doctor-checks.md', () => {
  it('is exactly what the generator renders from the registry', () => {
    const committed = fs.readFileSync(fileURLToPath(OUTPUT_URL), 'utf8');
    assert.equal(committed, renderDoctorChecks(), 'run node scripts/gen-doctor-docs.mjs');
  });

  it('documents every check id with its fix and source', () => {
    const page = renderDoctorChecks();
    for (const check of CHECKS) {
      assert.ok(page.includes(`### \`${check.id}\``), check.id);
      assert.ok(page.includes(`- Fix: ${check.fix}`), check.id);
    }
    assert.match(page, new RegExp(`Checks in this build: ${CHECKS.length}\\.`));
  });

  it('passes the claims lint rules that apply to documentation pages', () => {
    const file = 'docs/doctor-checks.md';
    const blocks = parseMarkdown(renderDoctorChecks());
    assert.deepEqual(checkNumbersHaveEvidence(file, blocks), []);
    assert.deepEqual(checkBannedPhrases(file, blocks), []);
    assert.deepEqual(checkExperimentalLabels(file, blocks), []);
  });

  it('refuses to render an invalid registry', () => {
    assert.throws(() => renderDoctorChecks([CHECKS[0], CHECKS[0]]), /duplicate check id/);
  });

  it('reports a current page from the generator with --check, writing nothing', (t) => {
    const writes = /** @type {string[]} */ ([]);
    t.mock.method(process.stdout, 'write', (/** @type {string} */ text) => { writes.push(text); return true; });
    assert.equal(generate(['--check']), 0);
    assert.match(writes.join(''), /is current/);
  });
});
