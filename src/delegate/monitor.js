// Local metadata only: no prompts, file contents, model calls or host-session access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../core/config.js';
import { acquireGpuLock, describeGpuLock, isPidAlive, readGpuLock } from '../core/lock.js';
import { readLedger } from './ledger.js';

/** @param {string} ledgerPath */
export function monitorPaths(ledgerPath) {
  const dir = path.dirname(ledgerPath);
  return { active: path.join(dir, 'active'), lock: path.join(dir, 'monitor.lock'), launchLock: path.join(dir, 'monitor-launch.lock') };
}

/**
 * @param {string} ledgerPath
 * @param {import('./results.js').Job} job
 * @param {string} model
 */
export async function markActive(ledgerPath, job, model) {
  const dir = monitorPaths(ledgerPath).active;
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${job.id}.json`);
  await fs.writeFile(target, JSON.stringify({ jobId: job.id, command: job.command, cwd: job.cwd, model, pid: process.pid, startedMs: job.startedMs }));
  return () => fs.rm(target, { force: true });
}

/**
 * @param {import('../core/paths.js').HomePaths} paths
 * @param {{ now?: () => number, isAlive?: (pid: number) => boolean }} [dependencies]
 */
export async function readDelegateStatus(paths, { now = Date.now, isAlive = isPidAlive } = {}) {
  const { config } = await loadConfig(paths.config);
  const entries = await readLedger(paths.delegateLedger);
  const locations = monitorPaths(paths.delegateLedger);
  const names = await fs.readdir(locations.active).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  /** @type {Array<{ jobId: string, command: string, cwd: string, model: string, pid: number, seconds: number, state: string }>} */
  const active = [];
  const finished = new Set(entries.map((entry) => entry.jobId));
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    try {
      const item = JSON.parse(await fs.readFile(path.join(locations.active, name), 'utf8'));
      if (typeof item.jobId !== 'string' || !Number.isInteger(item.pid) || item.pid <= 0 || !Number.isFinite(item.startedMs)) continue;
      if (finished.has(item.jobId)) continue;
      active.push({ jobId: item.jobId, command: String(item.command), cwd: String(item.cwd), model: String(item.model), pid: item.pid,
        seconds: Math.max(0, Math.floor((now() - item.startedMs) / 1000)), state: isAlive(item.pid) ? 'running' : 'interrupted' });
    } catch {
      // An atomic completion or a marker still being written is retried on the next refresh.
    }
  }
  return {
    enabled: config.delegate.enabled, monitorWindow: config.delegate.monitorWindow,
    monitorOpen: readGpuLock(locations.lock).state === 'held',
    lock: describeGpuLock(readGpuLock(paths.gpuLock)), active,
    recent: entries.slice(-5), ledgerPath: paths.delegateLedger,
  };
}

/** @param {Awaited<ReturnType<typeof readDelegateStatus>>} state */
export function renderDelegateStatus(state) {
  // Strip terminal controls from paths and any hand-edited records.
  const clean = (/** @type {unknown} */ text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  return [
    `Delegation: ${state.enabled ? 'ON' : 'OFF'} | automatic CMD: ${state.monitorWindow ? 'ON' : 'OFF'} | monitor: ${state.monitorOpen ? 'open' : 'closed'}`,
    `GPU lock: ${clean(state.lock)}`,
    ...state.active.map((job) => `${job.state.toUpperCase()} ${clean(job.jobId)} | ${clean(job.command)} | ${job.seconds}s | ${clean(job.model)} | ${clean(job.cwd)}`),
    ...(state.active.length ? [] : ['No active delegate jobs.']),
    ...state.recent.map((job) => `RESULT ${clean(job.jobId)} | ${clean(job.status)} | ${job.seconds}s | tokens ${job.promptTokens}/${job.outputTokens} | ${clean(job.cwd)}`),
    'Controls (in another terminal): opencode-unity delegate on | off | monitor --auto on | monitor --auto off',
    'Ctrl+C or close this window to stop watching; this does not stop a job.',
  ].join('\n');
}

/**
 * @param {import('../cli/main.js').CommandContext} cli
 * @param {import('../core/paths.js').HomePaths} paths
 * @param {{ maxPolls?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function watchDelegate(cli, paths, { maxPolls = Infinity, sleep = monitorSleep } = {}) {
  const lock = await acquireGpuLock({ lockPath: monitorPaths(paths.delegateLedger).lock, command: 'delegate monitor', timeoutSec: 0, waitSec: 0, signal: cli.signal });
  const removeCleanup = cli.interrupts.addCleanup(lock.release);
  let previous = '';
  try {
    for (let poll = 0; poll < maxPolls && !cli.signal.aborted; poll += 1) {
      const text = renderDelegateStatus(await readDelegateStatus(paths));
      if (text !== previous) cli.output.text(`[${new Date().toLocaleTimeString()}]\n${text}\n`);
      previous = text;
      if (poll + 1 < maxPolls) await sleep(Number(cli.options.interval ?? 2) * 1000, cli.signal);
    }
    return { message: 'Delegate monitor stopped.' };
  } finally {
    removeCleanup();
    lock.release();
  }
}

/** @param {number} ms @param {AbortSignal} [signal] */
export async function monitorSleep(ms, signal) {
  try { await delay(ms, undefined, { signal }); } catch (error) {
    if (!signal?.aborted) throw error;
  }
}
