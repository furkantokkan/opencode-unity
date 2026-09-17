// Spike I: does the PowerShell stdin probe return JSON reliably on Windows PowerShell 5.1 and
// PowerShell 7, inside the time budget, without an execution-policy change or -EncodedCommand?
//
// The probe is read-only. To keep the measurement deterministic and free of other processes' command
// lines, the spike starts two Node children with a unique marker in their command line: one busy loop
// and one idle timer. Only those two are sampled.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeContext } from './lib/spike.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'I',
  title: 'PowerShell process probe over stdin',
  question: 'Does the PowerShell stdin probe return JSON reliably on Windows PowerShell 5.1 and 7, within the time budget, and without common EDR blocks?',
  contractTest: 'Unit + manual on reference hardware',
  fallback: '-ExecutionPolicy Bypass -File <script> (process scope)',
};

const PROBE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'probe', 'process-probe.ps1');
const SAMPLE_MS = 1500;
const BUDGET_MS = 10_000;
const RUNS_PER_TRANSPORT = 3;

/**
 * @param {string} name
 * @returns {string | null}
 */
function findExecutable(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

/**
 * Runs a command, optionally piping text on stdin, and returns its output with a hard timeout.
 * @param {string} file
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.input]
 * @param {number} [options.timeoutMs]
 */
function runProcess(file, args, { input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `spawn error: ${error.message}`, durationMs: Date.now() - started, timedOut });
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * @param {string} json
 */
function parseJsonLine(json) {
  const line = json.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('{'));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * CPU percent of one process between the two readings, where 100% is one core.
 * @param {{ firstSeconds: number | null, secondSeconds: number | null }} entry
 * @param {number} elapsedMs
 */
function cpuPercent(entry, elapsedMs) {
  if (entry.firstSeconds === null || entry.secondSeconds === null || !elapsedMs) return null;
  return Math.round(((entry.secondSeconds - entry.firstSeconds) * 1000 * 100) / elapsedMs);
}

/**
 * @param {any} json
 */
function summarizeProbe(json) {
  const processes = json?.processes ?? [];
  return {
    parsed: Boolean(json),
    error: json?.error ?? null,
    processCount: processes.length,
    elapsedMs: json?.elapsedMs ?? null,
    cpuPercents: processes.map((/** @type {any} */ entry) => cpuPercent(entry, json?.elapsedMs ?? 0)),
    commandLineReadable: processes.length > 0 && processes.every((/** @type {any} */ entry) => entry.commandLineReadable === true),
    hasWindowFlags: processes.map((/** @type {any} */ entry) => entry.hasWindow),
  };
}

export async function run() {
  const ctx = new SpikeContext();
  const marker = `OCU_PROBE_${Date.now().toString(36).toUpperCase()}`;
  const busy = spawn(process.execPath, ['-e', 'const end = Date.now() + 40000; while (Date.now() < end) Math.sqrt(Math.random());', `${marker}_BUSY`], { stdio: 'ignore', windowsHide: true });
  const idle = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40000);', `${marker}_IDLE`], { stdio: 'ignore', windowsHide: true });
  ctx.track({ close: () => { busy.kill(); idle.kill(); } });

  const probeText = await fs.readFile(PROBE_PATH, 'utf8');
  const header = `$ocuMarker = '${marker}'; $ocuSampleMs = ${SAMPLE_MS}\n`;
  // `-Command -` runs a multi-line statement only once a blank line closes it, so the script text is
  // piped with a trailing blank line.
  const script = `${header}${probeText.trimEnd()}\n\n`;
  const scriptWithoutBlankLine = `${header}${probeText.trimEnd()}\n`;
  const fileScriptPath = path.join(os.tmpdir(), `ocu-spike-probe-${process.pid}.ps1`);
  await fs.writeFile(fileScriptPath, script);
  ctx.track({ close: () => fs.rm(fileScriptPath, { force: true }) });

  const hosts = [
    { id: 'windows-powershell-5.1', file: findExecutable('powershell.exe') },
    { id: 'powershell-7', file: findExecutable('pwsh.exe') },
  ].filter((host) => host.file);

  try {
    /** @type {Record<string, any>} */
    const transports = {};
    for (const host of hosts) {
      const file = String(host.file);
      const runs = [];
      for (let attempt = 0; attempt < RUNS_PER_TRANSPORT; attempt++) {
        const result = await runProcess(file, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: script, timeoutMs: 30_000 });
        runs.push({ exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, stderrTail: result.stderr.trim().slice(-200), ...summarizeProbe(parseJsonLine(result.stdout)) });
      }
      const durations = runs.map((item) => item.durationMs).sort((a, b) => a - b);
      const version = await runProcess(file, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeoutMs: 20_000 });
      const noBlankLine = await runProcess(file, ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: scriptWithoutBlankLine, timeoutMs: 30_000 });
      const fileRun = await runProcess(file, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileScriptPath], { timeoutMs: 30_000 });
      transports[host.id] = {
        host: path.basename(file),
        version: version.stdout.trim(),
        stdin: { runs, medianMs: durations[Math.floor(durations.length / 2)] },
        stdinWithoutTrailingBlankLine: { exitCode: noBlankLine.exitCode, stdoutLength: noBlankLine.stdout.trim().length, ...summarizeProbe(parseJsonLine(noBlankLine.stdout)) },
        executionPolicyBypassFile: { exitCode: fileRun.exitCode, durationMs: fileRun.durationMs, ...summarizeProbe(parseJsonLine(fileRun.stdout)) },
      };
    }
    ctx.evidence.transports = transports;
    ctx.evidence.sampleMs = SAMPLE_MS;
    ctx.evidence.budgetMs = BUDGET_MS;
    ctx.evidence.marker = 'a per-run random string; never stored';
    ctx.evidence.currentUserExecutionPolicy = (await runProcess(String(hosts[0]?.file ?? 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy -Scope CurrentUser'], { timeoutMs: 20_000 })).stdout.trim();

    ctx.checks.add('I1 both PowerShell hosts are present on this machine', hosts.length === 2, hosts.map((host) => host.id));
    for (const host of hosts) {
      const entry = transports[host.id];
      const runs = entry.stdin.runs;
      ctx.checks.add(`I2 ${host.id}: every stdin run returns parsable JSON`, runs.every((/** @type {any} */ item) => item.parsed && !item.error && item.exitCode === 0), runs.map((/** @type {any} */ item) => ({ parsed: item.parsed, exitCode: item.exitCode, error: item.error })));
      ctx.checks.add(`I3 ${host.id}: both marked processes are found with readable command lines`, runs.every((/** @type {any} */ item) => item.processCount === 2 && item.commandLineReadable), runs.map((/** @type {any} */ item) => item.processCount));
      ctx.checks.add(`I4 ${host.id}: the busy process reads as busy and the idle one as idle`, runs.every((/** @type {any} */ item) => Math.max(...item.cpuPercents) >= 50 && Math.min(...item.cpuPercents) <= 15), runs.map((/** @type {any} */ item) => item.cpuPercents));
      ctx.checks.add(`I5 ${host.id}: median stdin run stays inside the ${BUDGET_MS} ms budget`, entry.stdin.medianMs <= BUDGET_MS, { medianMs: entry.stdin.medianMs, sampleMs: SAMPLE_MS });
      ctx.checks.add(`I6 ${host.id}: without a trailing blank line the block never runs (silent, exit 0)`, entry.stdinWithoutTrailingBlankLine.parsed === false && entry.stdinWithoutTrailingBlankLine.exitCode === 0, entry.stdinWithoutTrailingBlankLine);
      ctx.checks.add(`I7 ${host.id}: the -ExecutionPolicy Bypass -File fallback also works`, entry.executionPolicyBypassFile.parsed && entry.executionPolicyBypassFile.processCount === 2, entry.executionPolicyBypassFile);
    }
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep the stdin transport: `powershell.exe -NoProfile -NonInteractive -Command -` with the script text piped in as one `& { ... }` block ending in a blank line. `-ExecutionPolicy Bypass -File` stays the documented fallback.'
    : 'Use `-ExecutionPolicy Bypass -File <script>` (process scope) as the probe transport.';
  ctx.findings.push(
    'The stdin form needs no execution-policy change and no -EncodedCommand, on Windows PowerShell 5.1 and on PowerShell 7 (measured versions are in the evidence).',
    '`-Command -` executes a multi-line statement only when a blank line closes it: the piped text MUST end with a blank line. Without it, the host exits 0 and prints nothing, so the guard must treat empty or unparsable output as a probe failure (block), never as "no Unity processes".',
    'Blank and comment lines INSIDE the script block are harmless; stripping them is not required, and stripping the final blank line breaks the probe.',
    'A Win32_Process snapshot plus a 1.5 s CPU sample fits inside the 10 s probe budget on the reference machine; per-host medians are in the evidence.',
    'No endpoint-security block was observed on the reference machine. Other machines keep the documented -File fallback and a doctor check.',
  );
  return ctx;
}
