// Writing the reviewed edit, and getting the files back (spec 12.2). Every case here is a way the
// write can be interrupted, and each one has to leave the tree in a state a developer can explain.
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import {
  APPLY_JOURNAL_FILE,
  APPLY_RECORD_FILE,
  applyChanges,
  describeRestoreReport,
  recoverUnfinishedApplies,
  restoreBackupsSync,
  restoreJob,
} from '../../src/delegate/apply.js';
import { decodeTextFile } from '../../src/delegate/edit-blocks.js';
import { createJob } from '../../src/delegate/results.js';
import { useSandbox } from '../helpers/sandbox.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} files
 */
async function setup(t, files) {
  const sandbox = await useSandbox(t, 'delegate-apply');
  const work = path.join(sandbox.root, 'work');
  const resultsDir = path.join(sandbox.root, 'results');
  await fs.mkdir(work, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(work, name), content, 'utf8');
  const job = await createJob({ resultsDir, command: 'apply', cwd: work, randomHex: () => 'aaaaaa' });
  return { sandbox, work, resultsDir, job };
}

/**
 * @param {string} work
 * @param {string} name
 * @param {string} newText
 * @returns {Promise<import('../../src/delegate/edit-blocks.js').FileChange>}
 */
async function change(work, name, newText) {
  const absolutePath = path.join(work, name);
  const bytes = await fs.readFile(absolutePath);
  return { relativePath: name, absolutePath, bytes, decoded: decodeTextFile(bytes), newText, newBytes: Buffer.from(newText, 'utf8') };
}

describe('applyChanges', () => {
  it('writes the new bytes, keeps a backup and leaves an apply record', async (t) => {
    const { work, job } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    applied.finish();
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'new\n');
    assert.equal(await fs.readFile(path.join(job.dir, 'backup', 'a.cs'), 'utf8'), 'old\n');
    const record = JSON.parse(await fs.readFile(path.join(job.dir, APPLY_RECORD_FILE), 'utf8'));
    assert.equal(record.files.length, 1);
    await assert.rejects(fs.access(path.join(job.dir, APPLY_JOURNAL_FILE)));
  });

  it('refuses when a file changed between validation and the write', async (t) => {
    const { work, job } = await setup(t, { 'a.cs': 'old\n' });
    const pending = await change(work, 'a.cs', 'new\n');
    await fs.writeFile(path.join(work, 'a.cs'), 'someone else was here\n', 'utf8');
    const error = await applyChanges({ job, changes: [pending] }).catch((thrown) => thrown);
    assert.equal(error.exitCode, EXIT.VALIDATION);
    assert.equal(error.code, 'review_stale');
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'someone else was here\n');
  });

  it('puts every file back when the caller rolls the apply back', async (t) => {
    const { work, job } = await setup(t, { 'a.cs': 'a old\n', 'b.cs': 'b old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'a new\n'), await change(work, 'b.cs', 'b new\n')] });
    const report = applied.restore();
    applied.finish();
    assert.deepEqual(report.restored, ['a.cs', 'b.cs']);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'a old\n');
    assert.equal(await fs.readFile(path.join(work, 'b.cs'), 'utf8'), 'b old\n');
  });

  it('leaves a file alone when someone changed it after this job wrote it', async (t) => {
    const { work, job } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    await fs.writeFile(path.join(work, 'a.cs'), 'edited by hand\n', 'utf8');
    const report = applied.restore();
    applied.finish();
    assert.deepEqual(report.restored, []);
    assert.equal(report.conflicts.length, 1);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'edited by hand\n');
    assert.match(describeRestoreReport(report), /not restored because they changed/);
  });

  it('registers a rollback with the interrupt handler and removes it when the job ends', async (t) => {
    const { work, job } = await setup(t, { 'a.cs': 'old\n' });
    /** @type {Array<() => void>} */
    const cleanups = [];
    const applied = await applyChanges({
      job,
      changes: [await change(work, 'a.cs', 'new\n')],
      track: (cleanup) => {
        cleanups.push(cleanup);
        return () => cleanups.splice(cleanups.indexOf(cleanup), 1);
      },
    });
    assert.equal(cleanups.length, 1);
    cleanups[0]();
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'old\n');
    applied.finish();
    assert.equal(cleanups.length, 0);
  });

  it('says nothing was changed when the report is empty', () => {
    assert.equal(describeRestoreReport({ restored: [], conflicts: [], failures: [] }), 'no file had been changed');
  });
});

describe('restoreJob', () => {
  it('puts back the files of a finished apply', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    applied.finish();
    const { report, files } = restoreJob({ resultsDir, jobId: job.id });
    assert.equal(files, 1);
    assert.deepEqual(report.restored, ['a.cs']);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'old\n');
  });

  it('reports a conflict instead of overwriting later work', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    applied.finish();
    await fs.writeFile(path.join(work, 'a.cs'), 'later work\n', 'utf8');
    const { report } = restoreJob({ resultsDir, jobId: job.id });
    assert.equal(report.conflicts.length, 1);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'later work\n');
  });

  it('refuses a job id that never applied anything', async (t) => {
    const { resultsDir, job } = await setup(t, {});
    const error = (() => {
      try {
        restoreJob({ resultsDir, jobId: job.id });
      } catch (thrown) {
        return /** @type {any} */ (thrown);
      }
      throw new Error('expected a refusal');
    })();
    assert.equal(error.code, 'job_not_found');
  });
});

describe('recoverUnfinishedApplies', () => {
  it('restores the files of a job that was killed mid-apply', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    // The journal stays behind, exactly as a forced kill would leave it.
    assert.ok(fsSync.existsSync(path.join(job.dir, APPLY_JOURNAL_FILE)));
    const notes = recoverUnfinishedApplies({ resultsDir, isProcessAlive: () => false });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /was stopped before it finished \(interrupted_restored\): restored a\.cs/);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'old\n');
    assert.ok(fsSync.existsSync(path.join(job.dir, 'recovered.json')));
    applied.finish();
  });

  it('leaves a journal of a live job alone', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')], maxRunSec: 1800 });
    assert.deepEqual(recoverUnfinishedApplies({ resultsDir, isProcessAlive: () => true }), []);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'new\n');
    applied.finish();
  });

  it('reports a conflict when the file no longer holds what the killed job wrote', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    await fs.writeFile(path.join(work, 'a.cs'), 'someone continued\n', 'utf8');
    const notes = recoverUnfinishedApplies({ resultsDir, isProcessAlive: () => false });
    assert.match(notes[0], /interrupted_restore_conflict/);
    assert.equal(await fs.readFile(path.join(work, 'a.cs'), 'utf8'), 'someone continued\n');
    applied.finish();
  });

  it('does nothing when there is no results folder yet', () => {
    assert.deepEqual(recoverUnfinishedApplies({ resultsDir: path.join('does', 'not', 'exist') }), []);
  });

  it('recovers each job once, even when two runs start together', async (t) => {
    const { work, job, resultsDir } = await setup(t, { 'a.cs': 'old\n' });
    const applied = await applyChanges({ job, changes: [await change(work, 'a.cs', 'new\n')] });
    const first = recoverUnfinishedApplies({ resultsDir, isProcessAlive: () => false });
    const second = recoverUnfinishedApplies({ resultsDir, isProcessAlive: () => false });
    assert.equal(first.length, 1);
    assert.deepEqual(second, []);
    applied.finish();
  });
});

describe('restoreBackupsSync', () => {
  it('reports a file it cannot read as a failure instead of throwing', () => {
    const report = restoreBackupsSync([
      { relativePath: 'gone.cs', target: path.join('no', 'such', 'file.cs'), backupPath: path.join('no', 'such', 'backup.cs'), state: 'written' },
    ]);
    assert.deepEqual(report.restored, []);
    assert.equal(report.failures.length, 1);
    assert.match(describeRestoreReport(report), /RESTORE FAILED/);
  });
});
