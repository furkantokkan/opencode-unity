// Writing the reviewed edit to disk, and getting the files back if anything goes wrong (spec 12.2).
//
// Backups and a journal are written before the first target file. A normal end (applied or restored)
// turns the journal into the job's apply record; an interrupt restores in process; a forced kill from
// an orchestrator's own timeout leaves the journal behind, and the next delegate run restores from it.
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { sha256Hex } from '../core/hash.js';
import { writeJobFile } from './results.js';

export const APPLY_JOURNAL_FILE = 'apply-pending.json';
export const APPLY_RECORD_FILE = 'applied.json';
export const BACKUP_DIR = 'backup';

// How many job folders a recovery scan looks at, newest first: enough for any interrupted run, small
// enough that a long-lived results folder never slows a command down.
const RECOVERY_SCAN_LIMIT = 50;
// A journal is abandoned once its process is gone, or once it outlived its own check timeout by this.
const APPLY_STALE_MARGIN_SEC = 120;

/**
 * @typedef {object} BackupEntry
 * @property {string} relativePath
 * @property {string} target        Absolute path of the edited file.
 * @property {string} backupPath    Absolute path of the copy inside the job folder.
 * @property {Buffer} [originalBytes]
 * @property {Buffer} [newBytes]
 * @property {string} [newSha256]   Known instead of `newBytes` when the entry comes from a record.
 * @property {'unwritten' | 'writing' | 'written'} state
 */

/**
 * @typedef {object} RestoreReport
 * @property {string[]} restored
 * @property {string[]} conflicts   Changed after this job wrote them, so they were left alone.
 * @property {string[]} failures
 */

/**
 * @typedef {object} AppliedHandle
 * @property {BackupEntry[]} backups
 * @property {() => RestoreReport} restore   Synchronous, so it also works from an interrupt handler.
 * @property {() => void} finish             Turns the journal into the apply record.
 */

/**
 * @param {object} input
 * @param {import('./results.js').Job} input.job
 * @param {readonly import('./edit-blocks.js').FileChange[]} input.changes
 * @param {number} [input.maxRunSec]   The check timeout, so recovery can tell a slow run from a dead one.
 * @param {(cleanup: () => void) => (() => void) | void} [input.track]  Registers the rollback with the
 *   interrupt handler.
 * @returns {Promise<AppliedHandle>}
 */
export async function applyChanges({ job, changes, maxRunSec = 0, track }) {
  for (const change of changes) {
    const current = await fs.readFile(change.absolutePath);
    if (!current.equals(change.bytes)) {
      throw new CliError(`${change.relativePath} changed on disk after it was validated; nothing was applied`, {
        exitCode: EXIT.VALIDATION,
        code: 'review_stale',
        data: { file: change.relativePath },
        hint: 'Run delegate edit again and review the new diff.',
      });
    }
  }
  /** @type {BackupEntry[]} */
  const backups = [];
  for (const change of changes) {
    const backupPath = await writeJobFile(job, path.join(BACKUP_DIR, change.relativePath), change.bytes);
    backups.push({
      relativePath: change.relativePath,
      target: change.absolutePath,
      backupPath,
      originalBytes: change.bytes,
      newBytes: change.newBytes,
      state: 'unwritten',
    });
  }
  const journalPath = writeApplyJournal(job, backups, maxRunSec);
  const restore = () => restoreBackupsSync(backups.filter((backup) => backup.state !== 'unwritten'));
  const untrack = track?.(() => {
    restore();
    removeFileSync(journalPath);
  });
  const finish = () => {
    untrack?.();
    renameSync(journalPath, path.join(job.dir, APPLY_RECORD_FILE));
  };
  try {
    for (const backup of backups) {
      backup.state = 'writing';
      await fs.writeFile(backup.target, /** @type {Buffer} */ (backup.newBytes));
      backup.state = 'written';
    }
  } catch (error) {
    restore();
    finish();
    throw error;
  }
  return { backups, restore, finish };
}

/**
 * Restores each file on its own. A file that no longer holds exactly the bytes this job wrote was
 * changed by someone else (another job, an editor), so it is left alone and reported as a conflict. A
 * file whose write was still in progress may hold partial bytes, so it is always restored.
 * @param {readonly BackupEntry[]} backups
 * @param {{ force?: boolean }} [options]
 * @returns {RestoreReport}
 */
export function restoreBackupsSync(backups, { force = false } = {}) {
  /** @type {RestoreReport} */
  const report = { restored: [], conflicts: [], failures: [] };
  for (const backup of backups) {
    const label = `${backup.relativePath} (backup: ${backup.backupPath})`;
    try {
      const current = fsSync.readFileSync(backup.target);
      // A write that was still in progress may hold partial bytes, so it is always restored.
      if (!force && backup.state !== 'writing' && !holdsJobBytes(current, backup)) {
        report.conflicts.push(label);
        continue;
      }
      writeBytesWithRetrySync(backup.target, fsSync.readFileSync(backup.backupPath));
      report.restored.push(backup.relativePath);
    } catch (error) {
      report.failures.push(`${label}: ${/** @type {{ code?: string, message: string }} */ (error).code ?? /** @type {Error} */ (error).message}`);
    }
  }
  return report;
}

/**
 * Whether the file on disk still holds exactly what this job wrote. Unknown counts as yes, so a record
 * without either form of the new bytes still restores.
 * @param {Buffer} current
 * @param {BackupEntry} backup
 * @returns {boolean}
 */
function holdsJobBytes(current, backup) {
  if (backup.newBytes) return current.equals(backup.newBytes);
  if (backup.newSha256) return sha256Hex(current) === backup.newSha256;
  return true;
}

/**
 * @param {RestoreReport} report
 * @returns {string}
 */
export function describeRestoreReport(report) {
  const parts = [];
  if (report.restored.length > 0) parts.push(`restored ${report.restored.join(', ')}`);
  if (report.conflicts.length > 0) parts.push(`not restored because they changed after this job wrote them: ${report.conflicts.join('; ')}`);
  if (report.failures.length > 0) parts.push(`RESTORE FAILED, still changed: ${report.failures.join('; ')}`);
  return parts.length > 0 ? parts.join('; ') : 'no file had been changed';
}

/**
 * `delegate restore <jobId>`: puts back the backups an earlier apply wrote. A file that no longer holds
 * what that job wrote is reported as a conflict instead of being overwritten.
 * @param {{ resultsDir: string, jobId: string }} input
 * @returns {{ report: RestoreReport, files: number }}
 */
export function restoreJob({ resultsDir, jobId }) {
  const jobDir = path.join(resultsDir, jobId);
  const record = readJsonSync(path.join(jobDir, APPLY_RECORD_FILE)) ?? readJsonSync(path.join(jobDir, APPLY_JOURNAL_FILE));
  if (!record || !Array.isArray(record.files)) {
    throw new CliError(`Job '${jobId}' has no applied edit to restore`, {
      exitCode: EXIT.USAGE,
      code: 'job_not_found',
      data: { jobId },
      hint: `Only a delegate apply job writes backups. Look in ${resultsDir} for the job id.`,
    });
  }
  /** @type {BackupEntry[]} */
  const backups = record.files.map((/** @type {any} */ file) => ({
    relativePath: String(file.relativePath),
    target: String(file.target),
    backupPath: String(file.backupPath),
    newSha256: typeof file.newSha256 === 'string' ? file.newSha256 : undefined,
    state: /** @type {'written'} */ ('written'),
  }));
  return { report: restoreBackupsSync(backups), files: backups.length };
}

/**
 * A forced kill runs no handler, so an unfinished apply leaves its journal behind. Every later delegate
 * run restores those files when they still hold exactly the job's unchecked bytes, and says so.
 * @param {{ resultsDir: string, now?: number, isProcessAlive?: (pid: number) => boolean }} input
 * @returns {string[]} One note per recovered job.
 */
export function recoverUnfinishedApplies({ resultsDir, now = Date.now(), isProcessAlive = isPidAlive }) {
  /** @type {string[]} */
  let names;
  try {
    names = fsSync.readdirSync(resultsDir);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const notes = [];
  const candidates = names.filter((name) => name.includes('-apply-')).sort().reverse().slice(0, RECOVERY_SCAN_LIMIT);
  for (const jobId of candidates) {
    const journalPath = path.join(resultsDir, jobId, APPLY_JOURNAL_FILE);
    const journal = readJsonSync(journalPath);
    if (!journal || !isAbandonedApply(journal, now, isProcessAlive)) continue;
    // Renaming claims the journal, so two runs that start together never recover the same job twice.
    const claimedPath = `${journalPath}.recovering-${process.pid}`;
    try {
      fsSync.renameSync(journalPath, claimedPath);
    } catch {
      continue;
    }
    notes.push(recoverApply(resultsDir, jobId, journal));
    removeFileSync(claimedPath);
  }
  return notes;
}

/**
 * @param {import('./results.js').Job} job
 * @param {readonly BackupEntry[]} backups
 * @param {number} maxRunSec
 * @returns {string}
 */
function writeApplyJournal(job, backups, maxRunSec) {
  const journal = {
    pid: process.pid,
    jobId: job.id,
    cwd: job.cwd,
    startedAt: new Date().toISOString(),
    maxRunSec,
    files: backups.map((backup) => ({
      relativePath: backup.relativePath,
      target: backup.target,
      backupPath: backup.backupPath,
      originalSha256: sha256Hex(/** @type {Buffer} */ (backup.originalBytes)),
      newSha256: sha256Hex(/** @type {Buffer} */ (backup.newBytes)),
    })),
  };
  const journalPath = path.join(job.dir, APPLY_JOURNAL_FILE);
  // Written under a temporary name first, so a kill during the write never leaves a torn journal.
  fsSync.writeFileSync(`${journalPath}.tmp`, `${JSON.stringify(journal, null, 2)}\n`);
  fsSync.renameSync(`${journalPath}.tmp`, journalPath);
  return journalPath;
}

/**
 * @param {string} resultsDir
 * @param {string} jobId
 * @param {any} journal
 * @returns {string}
 */
function recoverApply(resultsDir, jobId, journal) {
  /** @type {RestoreReport} */
  const report = { restored: [], conflicts: [], failures: [] };
  for (const file of Array.isArray(journal.files) ? journal.files : []) {
    const label = `${file.relativePath} (backup: ${file.backupPath})`;
    try {
      const currentHash = sha256Hex(fsSync.readFileSync(file.target));
      if (currentHash === file.originalSha256) continue;
      if (currentHash !== file.newSha256) report.conflicts.push(label);
      else {
        writeBytesWithRetrySync(file.target, fsSync.readFileSync(file.backupPath));
        report.restored.push(file.relativePath);
      }
    } catch (error) {
      report.failures.push(`${label}: ${/** @type {{ code?: string, message: string }} */ (error).code ?? /** @type {Error} */ (error).message}`);
    }
  }
  const status = report.failures.length > 0
    ? 'interrupted_restore_incomplete'
    : report.conflicts.length > 0
      ? 'interrupted_restore_conflict'
      : 'interrupted_restored';
  try {
    fsSync.writeFileSync(
      path.join(resultsDir, jobId, 'recovered.json'),
      `${JSON.stringify({ status, recoveredAt: new Date().toISOString(), ...report }, null, 2)}\n`,
    );
  } catch {
    // The note is still returned.
  }
  return `delegate apply job ${jobId} was stopped before it finished (${status}): ${describeRestoreReport(report)}`;
}

/**
 * @param {any} journal
 * @param {number} now
 * @param {(pid: number) => boolean} isProcessAlive
 * @returns {boolean}
 */
function isAbandonedApply(journal, now, isProcessAlive) {
  if (!isProcessAlive(Number(journal.pid))) return true;
  const startedMs = Date.parse(journal.startedAt);
  const maxRunMs = ((Number(journal.maxRunSec) || 0) + APPLY_STALE_MARGIN_SEC) * 1000;
  return Number.isFinite(startedMs) && now - startedMs > maxRunMs;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return /** @type {{ code?: string }} */ (error)?.code === 'EPERM';
  }
}

/**
 * Writes the bytes instead of copying the backup file: a copy keeps the backup's older write time on
 * Windows, and an incremental build would then treat outputs of the rejected edit as current.
 * @param {string} target
 * @param {Buffer} bytes
 */
function writeBytesWithRetrySync(target, bytes) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsSync.writeFileSync(target, bytes);
      return;
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (attempt >= 3 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
      sleepSync(200);
    }
  }
}

/**
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} target
 * @returns {any}
 */
function readJsonSync(target) {
  try {
    return JSON.parse(fsSync.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} target
 */
function removeFileSync(target) {
  try {
    fsSync.unlinkSync(target);
  } catch {
    // Already gone.
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function renameSync(from, to) {
  try {
    fsSync.renameSync(from, to);
  } catch {
    // The journal was already claimed by a recovery run, or removed.
  }
}
