// GPU lock (spec 7.8): one product process at a time may cause a model load or run model work (`warm`,
// `bench`, `delegate` jobs). The file is created exclusively and holds the holder's pid, command and a
// heartbeat. A lock whose pid is gone, or whose heartbeat is older than 60 s plus the holder's command
// timeout, is stale and taken over. The plugin never takes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_MARGIN_SEC = 60;
// A lock file that cannot be parsed is a crash between create and write; give a live writer time first.
const UNREADABLE_STALE_MS = 10_000;
// Only the waiter that holds this guard file may delete a stale lock, so two waiters never delete a lock
// the other has just created.
const TAKEOVER_GUARD_SUFFIX = '.takeover';
const TAKEOVER_GUARD_STALE_MS = 10_000;

/**
 * @typedef {object} LockRecord
 * @property {number} pid
 * @property {string} command      For example `warm` or `delegate ask`.
 * @property {string} startedAt    ISO time.
 * @property {string} heartbeatAt  ISO time.
 * @property {number} timeoutSec   The holder's command timeout; part of the stale rule.
 * @property {string} token        Random id, so a holder never removes a lock someone else took over.
 */

/**
 * @typedef {{ state: 'free' }
 *   | { state: 'held', holder: LockRecord }
 *   | { state: 'stale', holder: LockRecord | null, reason: string }
 *   | { state: 'unreadable', ageMs: number }} LockStatus
 */

/**
 * @typedef {object} LockEnvironment
 * @property {() => number} [now]
 * @property {(pid: number) => boolean} [isProcessAlive]
 */

/**
 * @typedef {object} AcquireOptions
 * @property {string} lockPath
 * @property {string} command
 * @property {number} timeoutSec          The command timeout the holder promises to respect.
 * @property {number} waitSec             How long to wait for another holder (exit 6 after that).
 * @property {number} [pollMs]
 * @property {number} [heartbeatMs]
 * @property {AbortSignal} [signal]
 * @property {(previous: LockRecord | null, reason: string) => void} [onTakeover]  Log the takeover.
 * @property {() => number} [now]
 * @property {(pid: number) => boolean} [isProcessAlive]
 */

/**
 * @typedef {object} GpuLock
 * @property {LockRecord} record
 * @property {{ previous: LockRecord | null, reason: string } | null} takeover
 * @property {() => boolean} heartbeat   Updates heartbeatAt; false when the lock is no longer ours.
 * @property {() => void} release         Synchronous, so it can run in an interrupt cleanup.
 */

/**
 * Waits for the lock, taking over a stale one. Throws CliError exit 6 (`lock_timeout`) after `waitSec`.
 * @param {AcquireOptions} options
 * @returns {Promise<GpuLock>}
 */
export async function acquireGpuLock(options) {
  const { lockPath, command, timeoutSec, waitSec, pollMs = 250, heartbeatMs = HEARTBEAT_INTERVAL_MS, signal, onTakeover } = options;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? isPidAlive;
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new TypeError('timeoutSec must be a non-negative number');
  if (!Number.isFinite(waitSec) || waitSec < 0) throw new TypeError('waitSec must be a non-negative number');
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + waitSec * 1000;
  /** @type {{ previous: LockRecord | null, reason: string } | null} */
  let takeover = null;
  for (;;) {
    signal?.throwIfAborted();
    const stamp = new Date(now()).toISOString();
    /** @type {LockRecord} */
    const record = { pid: process.pid, command, startedAt: stamp, heartbeatAt: stamp, timeoutSec, token: crypto.randomUUID() };
    if (tryCreate(lockPath, record)) return createLockHandle(lockPath, record, { heartbeatMs, now, takeover });
    const status = readGpuLock(lockPath, { now, isProcessAlive });
    if (status.state === 'stale' && removeStaleLock(lockPath, status.holder)) {
      takeover = { previous: status.holder, reason: status.reason };
      onTakeover?.(status.holder, status.reason);
      continue;
    }
    if (now() >= deadline) {
      const holder = status.state === 'held' ? status.holder : null;
      const detail = status.state === 'free' ? `${lockPath} could not be created` : describeGpuLock(status);
      throw new CliError(`The GPU lock was not free within ${waitSec} s: ${detail}`, {
        exitCode: EXIT.LOCK_TIMEOUT,
        code: 'lock_timeout',
        data: { holder: holder ? { pid: holder.pid, command: holder.command, startedAt: holder.startedAt } : null },
        hint: 'Another opencode-unity command is using the local model. Wait for it to finish, or run opencode-unity status.',
      });
    }
    // A lock that vanished between the create attempt and the read is retried almost at once.
    await sleep(status.state === 'free' ? 10 : Math.max(10, Math.min(pollMs, deadline - now())), signal);
  }
}

/**
 * The lock state for `status` and for waiters. Never throws for a missing or damaged file.
 * @param {string} lockPath
 * @param {LockEnvironment} [environment]
 * @returns {LockStatus}
 */
export function readGpuLock(lockPath, { now = Date.now, isProcessAlive = isPidAlive } = {}) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return { state: 'free' };
    return { state: 'unreadable', ageMs: 0 };
  }
  const holder = parseLockRecord(text);
  if (!holder) {
    const ageMs = Math.max(0, now() - mtimeMs);
    return ageMs > UNREADABLE_STALE_MS ? { state: 'stale', holder: null, reason: 'the lock file is damaged' } : { state: 'unreadable', ageMs };
  }
  if (!isProcessAlive(holder.pid)) return { state: 'stale', holder, reason: `process ${holder.pid} is gone` };
  const heartbeatAgeMs = now() - Date.parse(holder.heartbeatAt);
  if (heartbeatAgeMs > (STALE_MARGIN_SEC + holder.timeoutSec) * 1000) {
    return { state: 'stale', holder, reason: `no heartbeat for ${Math.round(heartbeatAgeMs / 1000)} s` };
  }
  return { state: 'held', holder };
}

/**
 * One line for messages and `status`.
 * @param {LockStatus} status
 * @returns {string}
 */
export function describeGpuLock(status) {
  switch (status.state) {
    case 'free':
      return 'free';
    case 'held':
      return `held by ${status.holder.command} (pid ${status.holder.pid}) since ${status.holder.startedAt}`;
    case 'stale':
      return `stale (${status.reason}); the next command takes it over`;
    default:
      return 'being written by another process';
  }
}

/**
 * @param {string} text
 * @returns {LockRecord | null}
 */
export function parseLockRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const { pid, command, startedAt, heartbeatAt, timeoutSec, token } = value;
  const valid =
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof command === 'string' &&
    typeof token === 'string' &&
    token !== '' &&
    typeof timeoutSec === 'number' &&
    Number.isFinite(timeoutSec) &&
    timeoutSec >= 0 &&
    !Number.isNaN(Date.parse(startedAt)) &&
    !Number.isNaN(Date.parse(heartbeatAt));
  return valid ? { pid, command, startedAt, heartbeatAt, timeoutSec, token } : null;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
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
 * @param {string} lockPath
 * @param {LockRecord} record
 * @returns {boolean}
 */
function tryCreate(lockPath, record) {
  try {
    fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
    return true;
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    // Windows reports EPERM or EBUSY while another process deletes or holds the file.
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') return false;
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {LockRecord | null} staleHolder  Null for a damaged file.
 * @returns {boolean} True when the caller should try to create the lock again.
 */
function removeStaleLock(lockPath, staleHolder) {
  const guardPath = `${lockPath}${TAKEOVER_GUARD_SUFFIX}`;
  try {
    fs.writeFileSync(guardPath, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'EEXIST') removeAbandonedGuard(guardPath);
    return false;
  }
  try {
    const current = readLockText(lockPath);
    const unchanged = staleHolder ? parseLockRecord(current ?? '')?.token === staleHolder.token : current !== null && parseLockRecord(current) === null;
    if (unchanged) removeFile(lockPath);
    return true;
  } finally {
    removeFile(guardPath);
  }
}

/**
 * @param {string} guardPath
 */
function removeAbandonedGuard(guardPath) {
  const stat = fs.statSync(guardPath, { throwIfNoEntry: false });
  if (stat && Date.now() - stat.mtimeMs > TAKEOVER_GUARD_STALE_MS) removeFile(guardPath);
}

/**
 * @param {string} lockPath
 * @param {LockRecord} record
 * @param {{ heartbeatMs: number, now: () => number, takeover: { previous: LockRecord | null, reason: string } | null }} options
 * @returns {GpuLock}
 */
function createLockHandle(lockPath, record, { heartbeatMs, now, takeover }) {
  let released = false;
  const isOurs = () => parseLockRecord(readLockText(lockPath) ?? '')?.token === record.token;
  const heartbeat = () => {
    if (released || !isOurs()) return false;
    record.heartbeatAt = new Date(now()).toISOString();
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record));
      return true;
    } catch {
      // A missed heartbeat is retried on the next tick; one miss never makes the lock stale.
      return false;
    }
  };
  const timer = heartbeatMs > 0 ? setInterval(heartbeat, heartbeatMs) : undefined;
  timer?.unref();
  return {
    record,
    takeover,
    heartbeat,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (isOurs()) removeFile(lockPath);
    },
  };
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readLockText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 */
function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone, or removed by another process.
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
