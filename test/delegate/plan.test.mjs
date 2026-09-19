import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createHarness } from './helpers.mjs';
import { APPLY_JOURNAL_FILE, recoverUnfinishedApplies } from '../../src/delegate/apply.js';
import { sha256Hex } from '../../src/core/hash.js';
import { parseArgv } from '../../src/cli/args.js';

const TASK = 'Summarize each file in three bullets with path:line evidence. Mark missing information explicitly.';
const SOURCE = 'public class Player { public int Health = 100; }\n';

async function plan(harness, overrides = {}) {
  return harness.run('plan', { options: { kind: 'summary', verification: 'targeted', task: TASK, files: ['A.cs'], ...overrides } });
}

describe('delegate plan', () => {
  it('parses explicit categories and verification while rejecting unknown values or missing scope', () => {
    const args = ['delegate', 'plan', '--kind', 'summary', '--task', TASK, '--files', 'A.cs', '--verification', 'targeted', '--source-read', '--json'];
    const parsed = parseArgv(args);
    assert.equal(parsed.options.sourceRead, true);
    assert.equal(parsed.options.verification, 'targeted');
    assert.throws(() => parseArgv([...args, '--verification', 'cheapish']));
    assert.throws(() => parseArgv(['delegate', 'plan', '--kind', 'anything', '--task', TASK, '--files', 'A.cs']));
    assert.throws(() => parseArgv(['delegate', 'plan', '--kind', 'summary', '--task', TASK]));
  });
  for (const kind of ['debug', 'design', 'security', 'deploy', 'review', 'unknown']) {
    it(`keeps ${kind} with the host before reading any source`, async (t) => {
      const h = await createHarness(t);
      const result = await plan(h, { kind, files: ['missing.cs'] });
      assert.equal(result.data.route, 'host');
      assert.equal(result.data.reason, 'host_task');
      assert.equal(result.data.orchestratorAction, 'do_it_yourself');
      assert.equal(result.exitCode, 0);
      assert.deepEqual(h.ollama.requests, []);
    });
  }

  for (const [options, reason] of [
    [{ toolSufficient: true }, 'use_tool'],
    [{ sourceRead: true }, 'source_already_read'],
    [{ verification: 'full' }, 'review_cost'],
    [{ verification: undefined }, 'review_cost'],
  ]) {
    it(`avoids unnecessary labor for ${reason} ${JSON.stringify(options)}`, async (t) => {
      const h = await createHarness(t);
      const result = await plan(h, options);
      assert.equal(result.data.route, 'host');
      assert.equal(result.data.reason, reason);
      assert.deepEqual(h.ollama.requests, []);
    });
  }

  it('keeps several small files with the host instead of using file count as a benefit', async (t) => {
    const h = await createHarness(t);
    for (const name of ['A.cs', 'B.cs', 'C.cs']) await h.writeFile(name, SOURCE);
    const result = await plan(h, { files: ['*.cs'] });
    assert.equal(result.data.route, 'host');
    assert.equal(result.data.reason, 'small_input');
    assert.equal(result.data.fileCount, 3);
  });

  it('selects one ask for a large bounded file without a model call or disk mutation', async (t) => {
    const h = await createHarness(t);
    const text = SOURCE.repeat(220);
    await h.writeFile('A.cs', text);
    const before = await tree(h.home);
    const result = await plan(h);
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.route, 'ask');
    assert.equal(result.data.plannedRequests, 1);
    assert.equal(result.data.sourceChars, text.length);
    assert.equal(result.data.modelCalled, false);
    assert.equal(result.data.advisory, true);
    assert.deepEqual(h.ollama.requests, []);
    assert.deepEqual(await tree(h.home), before);
    assert.equal(await h.readFile('A.cs'), text);
  });

  it('selects edit only for an explicitly mechanical edit', async (t) => {
    const h = await createHarness(t);
    await h.writeFile('A.cs', SOURCE.repeat(220));
    const result = await plan(h, { kind: 'mechanical-edit', task: 'Change Health from 100 to 110 in every declaration; verify the diff and compile.' });
    assert.equal(result.data.route, 'edit');
    assert.equal(result.data.orchestratorAction, 'check_health');
    assert.deepEqual(h.ollama.requests, []);
  });

  it('keeps dependent oversized work with the host and maps only independent files', async (t) => {
    const h = await createHarness(t);
    const files = ['A.cs', 'B.cs', 'C.cs', 'D.cs'];
    for (const name of files) await h.writeFile(name, SOURCE.repeat(220));
    const result = await plan(h, { files });
    assert.equal(result.data.route, 'host');
    assert.equal(result.data.reason, 'needs_scoping');
    const mapped = await plan(h, { files, independent: true });
    assert.equal(mapped.data.route, 'map');
    assert.equal(mapped.data.plannedRequests, files.length);
    assert.equal((await plan(h, { files, kind: 'inventory' })).data.route, 'map');
    assert.equal((await plan(h, { files, kind: 'mechanical-edit', independent: true })).data.route, 'host');
    assert.deepEqual(h.ollama.requests, []);
  });

  it('does not recommend map when a single file cannot fit', async (t) => {
    const h = await createHarness(t);
    await h.writeFile('A.cs', SOURCE.repeat(1200));
    const result = await plan(h, { kind: 'inventory' });
    assert.equal(result.data.route, 'host');
    assert.equal(result.data.reason, 'file_too_large');
    assert.deepEqual(result.data.oversizedFiles, ['A.cs']);
  });

  it('refuses sensitive input without passing it to a model', async (t) => {
    const h = await createHarness(t);
    await h.writeFile('.env', 'PRIVATE_VALUE=fixture');
    const result = await plan(h, { files: ['.env'] });
    assert.equal(result.code, 'sensitive_file_refused');
    assert.deepEqual(h.ollama.requests, []);
  });

  it('keeps Unity serialized files with the host', async (t) => {
    const h = await createHarness(t);
    await h.writeFile('Scene.unity', SOURCE.repeat(220));
    const result = await plan(h, { files: ['Scene.unity'] });
    assert.equal(result.data.route, 'host');
    assert.equal(result.data.reason, 'protected_file');
  });

  it('does not silently omit binary or oversized inputs', async (t) => {
    const h = await createHarness(t);
    await h.writeFile('A.cs', 'binary\0data');
    assert.equal((await plan(h)).exitCode, 1);
    await h.writeFile('A.cs', 'x'.repeat(262145));
    assert.equal((await plan(h)).exitCode, 1);
    assert.deepEqual(h.ollama.requests, []);
  });

  it('honors OFF before accessing files and preserves switches', async (t) => {
    const h = await createHarness(t, { config: { delegate: { enabled: false, monitorWindow: true } } });
    const config = await fs.readFile(h.paths.config, 'utf8');
    const result = await plan(h);
    assert.equal(result.exitCode, 8);
    assert.equal(result.data.orchestratorAction, 'do_it_yourself');
    assert.deepEqual(h.ollama.requests, []);
    assert.equal(await fs.readFile(h.paths.config, 'utf8'), config);
  });

  it('does not recover an unfinished apply journal during planning', async (t) => {
    const h = await createHarness(t);
    // A real abandoned journal would restore source bytes. Planning must not recover it.
    const journalDir = path.join(h.paths.delegateResults, '20260919-120000-apply-000001');
    await fs.mkdir(journalDir, { recursive: true });
    const journal = path.join(journalDir, APPLY_JOURNAL_FILE);
    const changed = SOURCE.repeat(220);
    const original = SOURCE.repeat(221);
    const target = await h.writeFile('A.cs', changed);
    const backupPath = path.join(journalDir, 'original.cs');
    await fs.writeFile(backupPath, original);
    await fs.writeFile(journal, JSON.stringify({ pid: -1, files: [{ relativePath: 'A.cs', target, backupPath, originalSha256: sha256Hex(original), newSha256: sha256Hex(changed) }] }));
    const before = await tree(h.home);
    const result = await plan(h);
    assert.equal(result.data.route, 'ask');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await tree(h.home), before);
    assert.equal(await h.readFile('A.cs'), changed);
    assert.equal(recoverUnfinishedApplies({ resultsDir: h.paths.delegateResults, isProcessAlive: () => false }).length, 1);
    assert.equal(await h.readFile('A.cs'), original, 'the same journal is recoverable by a normal recovery');
  });
});

async function tree(root) {
  const result = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await tree(target) : (await fs.readFile(target)).toString('base64');
  }
  return result;
}
