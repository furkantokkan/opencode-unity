// Turns a Unity process snapshot into the numbers the guard decides on (spec section 7.2):
// - import processes: name or command line matches `assetImportProcessPatterns`, plus every
//   UnityShaderCompiler, whatever started it (a main editor compiles shaders during its own imports;
//   idle standby compilers read 0%), plus windowless Unity processes whose command line Windows does
//   not expose (they may be workers, so their CPU use counts);
// - editors: Unity processes with a main window, each measured on its own, because projects that
//   import in-process do the work inside the editor process;
// - CPU percent: delta CPU time over the measured wall time, 100% = one logical core.
// The probe's own process tree is skipped: its command lines may name an import log.
// Which executable a process runs is the platform probe's answer (`program`), so no platform's
// spelling of an executable name appears here (amendment 33.6).

/**
 * @typedef {object} CpuReading
 * @property {'ok' | 'exited' | 'error'} state
 * @property {number | null} seconds   Kernel plus user CPU time.
 * @property {number | null} startMs   Process start time; a change means the pid was reused.
 * @property {string | null} error
 */

/**
 * @typedef {object} ProcessEntry
 * @property {number} pid
 * @property {number} parentPid
 * @property {string} name                The name the platform reports, shown as is.
 * @property {string | null} commandLine  Null when Windows does not expose it.
 * @property {boolean} hasWindow
 * @property {CpuReading | null} first
 * @property {CpuReading | null} second
 */

/**
 * @typedef {ProcessEntry & { program: string }} SnapshotProcess
 * `program` is the executable the process runs, lowercased and without the platform's executable
 * suffix, as the platform probe derives it from `name`.
 */

/**
 * @typedef {object} ProcessSnapshot
 * @property {number} probePid
 * @property {number[]} ancestors      The probe's parent chain.
 * @property {number} sampleMs         Requested gap between the CPU readings.
 * @property {number | null} elapsedMs Measured gap; null when CPU time was not sampled.
 * @property {SnapshotProcess[]} processes
 */

/**
 * @typedef {Omit<ProcessSnapshot, 'processes'> & { processes: ProcessEntry[] }} ScriptSnapshot
 * A snapshot as the probe script prints it, before the platform probe names each program.
 */

/**
 * @typedef {{ ok: true, running: boolean, count: number } | { ok: false, error: string }} UnityPresence
 * @typedef {{ ok: true, snapshot: ProcessSnapshot } | { ok: false, error: string }} SnapshotReading
 * @typedef {{ ok: true, snapshot: ScriptSnapshot } | { ok: false, error: string }} ScriptSnapshotReading
 */

/**
 * @typedef {object} SampleRequest
 * @property {string[]} patterns
 * @property {number} sampleMs
 * @property {boolean} sampleCpu
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ProcessProbe
 * @property {string} platform
 * @property {(options: { timeoutMs: number, signal?: AbortSignal }) => Promise<UnityPresence>} detect  Fast check: is any Unity process running?
 * @property {(request: SampleRequest) => Promise<SnapshotReading>} sample                               Process details and CPU readings.
 */

/**
 * @typedef {object} ProcessUsage
 * @property {number} pid
 * @property {string} name
 * @property {number | null} cpuPercent  Rounded to 0.1; null when CPU time was not sampled.
 */

/**
 * @typedef {object} UnreadableProcess
 * @property {number} pid
 * @property {string} name
 * @property {'import' | 'editor'} kind
 * @property {string} error
 */

/**
 * @typedef {object} UnityFactsOk
 * @property {true} ok
 * @property {boolean} running
 * @property {boolean} detailsRead                Process details were read (always when running, unless no check needed them).
 * @property {number | null} editorCount          Unity processes with a main window; null when not read.
 * @property {boolean} cpuSampled
 * @property {number | null} elapsedMs
 * @property {ProcessUsage[]} importProcesses
 * @property {number | null} importCpuPercent     Sum over import processes, rounded to 0.1.
 * @property {ProcessUsage[]} editors
 * @property {number | null} busiestEditorCpuPercent
 * @property {UnreadableProcess[]} unreadable
 */

/**
 * @typedef {UnityFactsOk | { ok: false, error: string }} UnityFacts
 */

const k_unityName = 'unity';
const k_shaderCompilerName = 'unityshadercompiler';

/**
 * @param {UnityPresence} presence
 * @param {SnapshotReading | null} reading  Null when no check needed process details.
 * @param {{ patterns: readonly string[], cpuSampled: boolean, selfPid?: number }} options
 * @returns {UnityFacts}
 */
export function analyzeUnityProcesses(presence, reading, { patterns, cpuSampled, selfPid }) {
  if (!presence.ok) return { ok: false, error: presence.error };
  if (!presence.running) return createIdleFacts(false, true, 0);
  if (reading === null) return createIdleFacts(true, false, null);
  if (!reading.ok) return { ok: false, error: reading.error };

  const snapshot = reading.snapshot;
  const skipped = new Set([snapshot.probePid, ...snapshot.ancestors]);
  if (selfPid !== undefined) skipped.add(selfPid);
  const processes = snapshot.processes.filter((entry) => !skipped.has(entry.pid));
  const importEntries = processes.filter((entry) => isImportProcess(entry, patterns));
  const windowed = processes.filter((entry) => entry.hasWindow && entry.program === k_unityName);
  const editorEntries = windowed.filter((entry) => !importEntries.includes(entry));

  /** @type {UnreadableProcess[]} */
  const unreadable = [];
  const measure = (/** @type {SnapshotProcess} */ entry, /** @type {'import' | 'editor'} */ kind) => {
    if (!cpuSampled) return { pid: entry.pid, name: entry.name, cpuPercent: null, raw: 0 };
    const result = measureCpuPercent(entry.first, entry.second, snapshot.elapsedMs);
    if (result.state === 'gone') return null;
    if (result.state === 'unreadable') {
      unreadable.push({ pid: entry.pid, name: entry.name, kind, error: result.error });
      return null;
    }
    return { pid: entry.pid, name: entry.name, cpuPercent: roundPercent(result.percent), raw: result.percent };
  };
  const importUsage = importEntries.map((entry) => measure(entry, 'import')).filter((entry) => entry !== null);
  const editorUsage = editorEntries.map((entry) => measure(entry, 'editor')).filter((entry) => entry !== null);
  const importTotal = importUsage.reduce((sum, entry) => sum + entry.raw, 0);
  const busiestEditor = editorUsage.reduce((highest, entry) => Math.max(highest, entry.cpuPercent ?? 0), 0);
  return {
    ok: true,
    running: true,
    detailsRead: true,
    editorCount: windowed.length,
    cpuSampled,
    elapsedMs: cpuSampled ? snapshot.elapsedMs : null,
    importProcesses: importUsage.map(toUsage),
    importCpuPercent: cpuSampled ? roundPercent(importTotal) : null,
    editors: editorUsage.map(toUsage),
    busiestEditorCpuPercent: cpuSampled ? busiestEditor : null,
    unreadable,
  };
}

/**
 * CPU use of one process between two readings.
 * @param {CpuReading | null} first
 * @param {CpuReading | null} second
 * @param {number | null} elapsedMs
 * @returns {{ state: 'measured', percent: number } | { state: 'gone' } | { state: 'unreadable', error: string }}
 */
export function measureCpuPercent(first, second, elapsedMs) {
  if (!first || !second) return { state: 'unreadable', error: 'no CPU time reading' };
  if (first.state === 'exited') return { state: 'gone' };
  if (first.state === 'error' || first.seconds === null) return { state: 'unreadable', error: first.error ?? 'CPU time unreadable' };
  if (second.state === 'error') return { state: 'unreadable', error: second.error ?? 'CPU time unreadable' };
  if (elapsedMs === null || !(elapsedMs > 0)) return { state: 'unreadable', error: 'no measured sampling window' };
  // Exited during the window: the CPU time it used before exiting is unknown, and it is gone now.
  if (second.state === 'exited' || second.seconds === null) return { state: 'gone' };
  // A new start time or a lower CPU time is another process that reused the pid.
  if (first.startMs !== null && second.startMs !== null && first.startMs !== second.startMs) return { state: 'gone' };
  if (second.seconds < first.seconds) return { state: 'gone' };
  return { state: 'measured', percent: ((second.seconds - first.seconds) / (elapsedMs / 1000)) * 100 };
}

/**
 * Patterns match anywhere in the process name or command line, case-insensitively; `*` is any run of
 * characters and `?` one character.
 * @param {{ name: string, commandLine: string | null }} entry
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesProcessPattern(entry, pattern) {
  const source = [...pattern].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExp(char))).join('');
  const matcher = new RegExp(source, 'i');
  return matcher.test(entry.name) || matcher.test(entry.commandLine ?? '');
}

/**
 * @param {number} value
 * @returns {number}
 */
export function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Validates a probe snapshot; anything malformed is an error, so the guard fails closed.
 * @param {unknown} value
 * @returns {ScriptSnapshotReading}
 */
export function validateProcessSnapshot(value) {
  const invalid = (/** @type {string} */ what) => /** @type {ScriptSnapshotReading} */ ({ ok: false, error: `process probe output is malformed (${what})` });
  if (!isRecord(value)) return invalid('not an object');
  if (typeof value.error === 'string') return { ok: false, error: `process probe failed: ${value.error}` };
  if (value.schema !== 1) return invalid('unknown schema');
  if (!isPid(value.probePid)) return invalid('probePid');
  if (!Array.isArray(value.ancestors) || !value.ancestors.every(isPid)) return invalid('ancestors');
  if (!isPid(value.sampleMs)) return invalid('sampleMs');
  if (value.elapsedMs !== null && !isNonNegativeNumber(value.elapsedMs)) return invalid('elapsedMs');
  if (!Array.isArray(value.processes)) return invalid('processes');
  /** @type {ProcessEntry[]} */
  const processes = [];
  for (const entry of value.processes) {
    if (!isProcessEntry(entry)) return invalid('process entry');
    const first = readCpuReading(entry.first);
    const second = readCpuReading(entry.second);
    if (first === undefined || second === undefined) return invalid(`CPU reading of pid ${entry.pid}`);
    processes.push({ pid: entry.pid, parentPid: entry.parentPid, name: entry.name, commandLine: entry.commandLine, hasWindow: entry.hasWindow, first, second });
  }
  return {
    ok: true,
    snapshot: {
      probePid: /** @type {number} */ (value.probePid),
      ancestors: /** @type {number[]} */ (value.ancestors),
      sampleMs: /** @type {number} */ (value.sampleMs),
      elapsedMs: /** @type {number | null} */ (value.elapsedMs),
      processes,
    },
  };
}

/**
 * @param {boolean} running
 * @param {boolean} detailsRead
 * @param {number | null} count
 * @returns {UnityFactsOk}
 */
function createIdleFacts(running, detailsRead, count) {
  const zero = running ? null : 0;
  return {
    ok: true,
    running,
    detailsRead,
    editorCount: count,
    cpuSampled: false,
    elapsedMs: null,
    importProcesses: [],
    importCpuPercent: zero,
    editors: [],
    busiestEditorCpuPercent: zero,
    unreadable: [],
  };
}

/**
 * @param {SnapshotProcess} entry
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
function isImportProcess(entry, patterns) {
  if (entry.program === k_shaderCompilerName) return true;
  if (entry.program === k_unityName && !entry.hasWindow && entry.commandLine === null) return true;
  return patterns.some((pattern) => matchesProcessPattern(entry, pattern));
}

/**
 * @param {{ pid: number, name: string, cpuPercent: number | null }} entry
 * @returns {ProcessUsage}
 */
function toUsage(entry) {
  return { pid: entry.pid, name: entry.name, cpuPercent: entry.cpuPercent };
}

/**
 * @param {unknown} entry
 * @returns {entry is { pid: number, parentPid: number, name: string, commandLine: string | null, hasWindow: boolean, first: unknown, second: unknown }}
 */
function isProcessEntry(entry) {
  return isRecord(entry)
    && isPid(entry.pid)
    && isPid(entry.parentPid)
    && typeof entry.name === 'string'
    && (typeof entry.commandLine === 'string' || entry.commandLine === null)
    && typeof entry.hasWindow === 'boolean';
}

/**
 * @param {unknown} value
 * @returns {CpuReading | null | undefined}  Undefined when malformed.
 */
function readCpuReading(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const { state, seconds, startMs, error } = value;
  if (state !== 'ok' && state !== 'exited' && state !== 'error') return undefined;
  if (seconds !== null && !isNonNegativeNumber(seconds)) return undefined;
  if (startMs !== null && !(typeof startMs === 'number' && Number.isFinite(startMs))) return undefined;
  if (error !== null && typeof error !== 'string') return undefined;
  if (state === 'ok' && seconds === null) return undefined;
  return { state, seconds, startMs, error };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPid(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {string} char
 * @returns {string}
 */
function escapeRegExp(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
