// `opencode-unity status` (spec 5.5, 13.3): what the machine is doing right now.
//
// One poll gathers everything from sources that cannot start anything: Ollama's read-only endpoints,
// the guard's own probes, the GPU lock file, the plugin's session log and the Ollama server log. No
// model is loaded, and `/api/chat` is never called.
//
// `--watch` prints the one-line form of 13.3 every `--interval` seconds; that is what the Windows
// Terminal pane runs beside a session. Truncation lines from the Ollama server log are printed as they
// appear, because a silently cut prompt is invisible inside the session itself (E1).
//
// Exit 2 only when Ollama cannot be reached, because then there is nothing to report. A blocked guard
// is a report, not a failure: watching it clear is the reason this command exists.
//
// Extension seams: S39 adds a `net` line and per-component port lines, S41 adds a shaping line.
import { describeGpuLock, readGpuLock } from '../core/lock.js';
import { resolveLogSource } from '../core/paths.js';
import { createOllamaClient, findModel } from '../ollama/client.js';
import { summarizeVerdict } from '../ollama/guarded-chat.js';
import { readProjectsIndex } from '../project/local.js';
import { loadSession, resolveProject } from '../project/session.js';
import { evaluateGuardFor } from './guard.js';
import { formatGiBOrUnknown, padLabel, paintTone } from '../terminal/format.js';
import { createTruncationWatcher, formatStatusLine } from '../terminal/status-view.js';
import { readSessionRecords, summarizeSession } from '../terminal/summary.js';

export const DEFAULT_INTERVAL_SEC = 10;

/**
 * @typedef {object} StatusDependencies
 * @property {typeof fetch} [fetchImpl]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {() => Date} [now]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {number} [maxPolls]     Test seam: stop the watch after this many polls.
 * @property {import('../terminal/status-view.js').TruncationWatcher} [watcher]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {StatusDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const now = dependencies.now ?? (() => new Date());
  const project = await resolveSelectedProject(session, cliContext);
  const gather = () => collectStatus({ session, project, now, ...dependencies });

  // A one-shot run reports the truncations the plugin recorded for the session; following the server
  // log only means something over time, so it belongs to `--watch`.
  if (cliContext.options.watch !== true) {
    const snapshot = await gather();
    if (!cliContext.global.json) for (const line of renderReport(snapshot, { paint: cliContext.output.paint })) cliContext.output.text(line);
    return toResult(snapshot, session.warnings);
  }

  const watcher = dependencies.watcher ?? createTruncationWatcher({
    source: resolveLogSource({ env: session.env, platform: session.platform, configuredPath: session.config.ollama.serverLogPath }),
  });
  // The first poll only marks the log position, so the watch reports what happens from now on.
  await watcher.poll();
  return runWatch({ cliContext, session, gather, watcher, ...dependencies });
}

/**
 * @param {object} options
 * @param {import('../cli/main.js').CommandContext} options.cliContext
 * @param {import('../project/session.js').Session} options.session
 * @param {() => Promise<StatusReport>} options.gather
 * @param {import('../terminal/status-view.js').TruncationWatcher} options.watcher
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {number} [options.maxPolls]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
async function runWatch({ cliContext, session, gather, watcher, sleep = defaultSleep, maxPolls = Number.POSITIVE_INFINITY }) {
  const intervalMs = readInterval(cliContext.options.interval) * 1000;
  /** @type {StatusReport | null} */
  let last = null;
  for (let poll = 0; poll < maxPolls && !cliContext.signal.aborted; poll += 1) {
    last = await gather();
    cliContext.output.text(formatStatusLine(last.line, { paint: cliContext.output.paint }));
    for (const line of watcher.render(await watcher.poll(), { paint: cliContext.output.paint })) cliContext.output.text(line);
    if (poll + 1 >= maxPolls) break;
    await sleep(intervalMs, cliContext.signal);
    if (cliContext.signal.aborted) break;
  }
  if (last === null) return { warnings: session.warnings };
  return toResult(last, session.warnings);
}

/**
 * @typedef {object} StatusReport
 * @property {string} ollamaVersion
 * @property {import('../ollama/client.js').RunningModel[]} running
 * @property {import('../ollama/guarded-chat.js').GuardSummary} guard
 * @property {{ freeMiB: number | null, totalMiB: number | null, utilizationPercent: number | null }} gpu
 * @property {{ editors: number | null, imports: 'idle' | 'busy' | 'unknown', importCpuPercent: number | null }} unity
 * @property {string} lock
 * @property {import('../terminal/summary.js').SessionSummary} session
 * @property {{ id: string, name: string, root: string } | null} project
 * @property {import('../terminal/status-view.js').StatusSnapshot} line
 */

/**
 * @param {object} options
 * @param {import('../project/session.js').Session} options.session
 * @param {{ id: string, name: string, root: string } | null} options.project
 * @param {() => Date} options.now
 * @param {typeof fetch} [options.fetchImpl]
 * @param {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [options.probes]
 * @returns {Promise<StatusReport>}
 */
export async function collectStatus({ session, project, now, fetchImpl, probes }) {
  const client = createOllamaClient({ baseUrl: session.profile.ollama.baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const modelTag = session.profile.provider.modelTag;
  // An unreachable server is exit 2 and nothing else is worth gathering, so this one is not caught.
  const [version, running] = await Promise.all([
    client.getVersion(),
    client.listRunning().catch(() => /** @type {import('../ollama/client.js').RunningModel[]} */ ([])),
  ]);
  const verdict = await evaluateGuardFor(session, { cold: true, ...(probes ? { probes } : {}) });
  const guard = summarizeVerdict(verdict);
  const memory = verdict.measurements.gpu?.memory;
  const samples = verdict.measurements.gpu?.utilization.samples ?? [];
  const unity = verdict.measurements.unity;
  const records = await readSessionRecords({ sessionsDir: session.paths.sessionsDir, sinceMs: findSessionStart(now()) });
  const summary = summarizeSession(records);
  const loaded = findModel(running, modelTag) ?? null;

  const report = {
    ollamaVersion: version,
    running,
    guard,
    gpu: {
      freeMiB: memory?.ok ? memory.freeMiB : null,
      totalMiB: memory?.ok ? memory.totalMiB : null,
      utilizationPercent: samples.length === 0 ? null : Math.max(...samples),
    },
    unity: {
      editors: unity?.ok ? unity.editorCount : null,
      imports: describeImports(unity),
      importCpuPercent: unity?.ok ? unity.importCpuPercent : null,
    },
    lock: describeGpuLock(readGpuLock(session.paths.gpuLock)),
    session: summary,
    project,
  };
  return {
    ...report,
    line: {
      at: now(),
      guardVerdict: verdict.verdict,
      guardReason: verdict.reasons[0]?.id ?? null,
      modelLoaded: verdict.model.loaded || loaded !== null,
      modelContextLength: verdict.model.contextLength ?? loaded?.contextLength ?? null,
      modelExpiresInSec: verdict.model.expiresInSec,
      freeVramMiB: report.gpu.freeMiB,
      imports: report.unity.imports,
      editors: report.unity.editors,
      lock: report.lock === 'free' ? '-' : report.lock,
      requests: summary.requests,
      overflows: summary.overflows,
      truncations: summary.truncations,
      textToolCalls: summary.textToolCalls,
    },
  };
}

/**
 * The multi-line form, for a one-shot run.
 * @param {StatusReport} report
 * @param {{ paint: import('../cli/output.js').Painter }} options
 * @returns {string[]}
 */
export function renderReport(report, { paint }) {
  const passed = report.guard.verdict.startsWith('pass');
  /** @type {Array<[string, string, import('../terminal/format.js').Tone]>} */
  const rows = [
    ['ollama', report.ollamaVersion === null ? 'version unknown' : `version ${report.ollamaVersion}`, 'plain'],
    ['model', report.running.length === 0 ? 'nothing loaded' : report.running.map(describeRunning).join(', '), report.running.length === 0 ? 'plain' : 'good'],
    ['guard', passed ? report.guard.verdict : `${report.guard.verdict}: ${report.guard.reasons.map((reason) => reason.detail).join('; ')}`, passed ? 'good' : 'bad'],
    ['gpu', `free ${formatGiBOrUnknown(report.gpu.freeMiB)} of ${formatGiBOrUnknown(report.gpu.totalMiB)}${report.gpu.utilizationPercent === null ? '' : `, utilization ${report.gpu.utilizationPercent}%`}`, 'plain'],
    ['unity', `editors ${report.unity.editors ?? 'unknown'}, imports ${report.unity.imports}`, report.unity.imports === 'busy' ? 'warn' : 'plain'],
    ['lock', report.lock, report.lock === 'free' ? 'plain' : 'warn'],
    ['session', `${report.session.requests} requests, ${report.session.overflows} overflows, ${report.session.truncations} truncated prompts, ${report.session.textToolCalls} text-form tool calls`, report.session.truncations > 0 ? 'warn' : 'plain'],
  ];
  if (report.project !== null) rows.unshift(['project', `${report.project.name} (${report.project.id})`, 'plain']);
  return rows.map(([label, text, tone]) => paintTone(paint, tone, `${padLabel(label)}${text}`));
}

/**
 * The window the session counters cover: the current UTC day, which is exactly one session-log file.
 * @param {Date} now
 * @returns {number}
 */
export function findSessionStart(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * `--project` names a directory, and the status pane is launched with one. An id is accepted too, so a
 * line copied out of `status --json` can be pasted back in.
 * @param {import('../project/session.js').Session} session
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @returns {Promise<{ id: string, name: string, root: string } | null>}
 */
async function resolveSelectedProject(session, cliContext) {
  const requested = cliContext.global.project;
  if (requested !== undefined && isProjectId(requested)) {
    const index = await readProjectsIndex(session.paths.projectsIndex);
    const entry = index.projects.find((candidate) => candidate.id === requested);
    if (entry) return { id: entry.id, name: entry.name, root: entry.path };
  }
  if (requested === undefined) return null;
  const project = await resolveProject(session, { path: requested });
  return { id: project.id, name: project.name, root: project.root };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isProjectId(value) {
  return /^[A-Za-z0-9._-]{1,64}-[0-9a-f]{8}$/.test(value) && !value.includes('/') && !value.includes('\\');
}

/**
 * @param {import('../ollama/client.js').RunningModel} model
 * @returns {string}
 */
function describeRunning(model) {
  const context = model.contextLength === null ? '' : ` at ${model.contextLength} context`;
  const vram = model.sizeVramBytes === null ? '' : `, ${formatGiBOrUnknown(Math.round(model.sizeVramBytes / 1048576))} VRAM`;
  const expires = model.expiresAt === null ? '' : `, until ${model.expiresAt}`;
  return `${model.name}${context}${vram}${expires}`;
}

/**
 * @param {import('../../plugin/opencode-unity-lib/guard/unity-processes.js').UnityFacts | null | undefined} unity
 * @returns {'idle' | 'busy' | 'unknown'}
 */
function describeImports(unity) {
  if (!unity?.ok) return 'unknown';
  if (unity.importCpuPercent === null) return unity.running ? 'unknown' : 'idle';
  return unity.importProcesses.length > 0 && unity.importCpuPercent > 0 ? 'busy' : 'idle';
}

/**
 * @param {StatusReport} report
 * @param {string[]} warnings
 * @returns {import('../cli/main.js').CommandResult}
 */
function toResult(report, warnings) {
  const { line, ...data } = report;
  return { message: `guard ${report.guard.verdict}, ${report.running.length === 0 ? 'no model loaded' : `${report.running.length} model(s) loaded`}`, data, warnings };
}

/**
 * @param {import('../cli/args.js').OptionValue} value
 * @returns {number}
 */
export function readInterval(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_SEC;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
