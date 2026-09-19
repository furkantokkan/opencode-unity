// Unity process probe for Windows (spec section 7.2).
// - detect: `tasklist /FI "IMAGENAME eq Unity.exe" /FO CSV /NH`, which starts no PowerShell, so the
//   loaded path stays fast while Unity is closed.
// - sample: the shipped win32-probe.ps1, piped as text to `powershell.exe -NoProfile -NonInteractive
//   -Command -` (no -EncodedCommand, no execution policy change). Each process in the snapshot gets
//   its `program`, the image name without `.exe`, so the analysis never spells a Windows name.
// Both are read-only. Every failure is an error result, and the guard blocks on it.
import fs from 'node:fs/promises';
import { validateProcessSnapshot } from '../unity-processes.js';
import { readEnv, runCommand, summarizeOutput } from './run-command.js';

const k_scriptUrl = new URL('./win32-probe.ps1', import.meta.url);
const k_unityImage = 'Unity.exe';

/**
 * @typedef {object} Win32ProbeOptions
 * @property {import('./run-command.js').RunCommand} [run]
 * @property {Record<string, string | undefined>} [env]
 * @property {() => Promise<string>} [readScript]
 */

/**
 * @param {Win32ProbeOptions} [options]
 * @returns {import('../unity-processes.js').ProcessProbe}
 */
export function createWin32ProcessProbe({ run = runCommand, env = process.env, readScript = readProbeScript } = {}) {
  const systemRoot = readEnv(env, 'SystemRoot');
  // Full paths keep a same-named program earlier on PATH from answering for Windows.
  const tasklist = systemRoot ? `${systemRoot}\\System32\\tasklist.exe` : 'tasklist.exe';
  const powershell = systemRoot ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  return {
    platform: 'win32',
    async detect({ timeoutMs, signal }) {
      const result = await run(tasklist, ['/FI', `IMAGENAME eq ${k_unityImage}`, '/FO', 'CSV', '/NH'], { timeoutMs, env, signal, platform: 'win32' });
      if (!result.ok) return { ok: false, error: `tasklist ${result.error}${describeOutput(result)}` };
      return parseTasklistOutput(result.stdout);
    },
    async sample({ patterns, sampleMs, sampleCpu, timeoutMs, signal }) {
      let script;
      try {
        script = await readScript();
      } catch (error) {
        return { ok: false, error: `the process probe script could not be read (${error instanceof Error ? error.message : String(error)})` };
      }
      const input = buildProbeInput(script, { patterns, sampleMs, sampleCpu });
      const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', '-'], { timeoutMs, env, signal, input, platform: 'win32' });
      return parseProbeResult(result);
    },
  };
}

/**
 * Parses `tasklist /FO CSV /NH` output filtered to Unity.exe. With no match, tasklist prints one
 * localized line such as `INFO: No tasks are running which match the specified criteria.`
 * @param {string} text
 * @returns {import('../unity-processes.js').UnityPresence}
 */
export function parseTasklistOutput(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.filter((line) => line.startsWith('"'));
  if (rows.length === 0) {
    if (lines.length === 1 && /^[^\s",]+:\s/.test(lines[0])) return { ok: true, running: false, count: 0 };
    return { ok: false, error: `unexpected tasklist output '${summarizeOutput(text, 80)}'` };
  }
  if (rows.length !== lines.length) return { ok: false, error: `unexpected tasklist output '${summarizeOutput(text, 80)}'` };
  for (const row of rows) {
    const match = /^"([^"]*)","(\d+)",/.exec(row);
    if (!match || match[1].toLowerCase() !== k_unityImage.toLowerCase()) {
      return { ok: false, error: `unexpected tasklist row '${summarizeOutput(row, 80)}'` };
    }
  }
  return { ok: true, running: true, count: rows.length };
}

/**
 * Builds the stdin text for `powershell.exe -Command -`: settings first, script without blank and
 * comment lines, then the blank line that makes PowerShell run the block. Patterns travel as base64,
 * so no character in them needs PowerShell quoting.
 * @param {string} script
 * @param {{ patterns: readonly string[], sampleMs: number, sampleCpu: boolean }} settings
 * @returns {string}
 */
export function buildProbeInput(script, { patterns, sampleMs, sampleCpu }) {
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 0) throw new Error('sampleMs must be a non-negative integer');
  const encoded = patterns.map((pattern) => `'${Buffer.from(pattern, 'utf8').toString('base64')}'`);
  const settings = `$ocuSampleMs = ${sampleMs}; $ocuSampleCpu = $${sampleCpu ? 'true' : 'false'}; $ocuPatterns = @(${encoded.join(', ')})`;
  const body = script
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n');
  return `${settings}\n${body}\n\n`;
}

/**
 * @param {import('./run-command.js').CommandResult} result
 * @returns {import('../unity-processes.js').SnapshotReading}
 */
export function parseProbeResult(result) {
  const parsed = readLastJsonLine(result.stdout);
  if (!result.ok) {
    const reported = isRecord(parsed) && typeof parsed.error === 'string' ? `: ${parsed.error}` : describeOutput(result);
    return { ok: false, error: `powershell.exe process probe ${result.error}${reported}` };
  }
  if (parsed === undefined) {
    return { ok: false, error: `powershell.exe process probe printed no JSON${describeOutput(result)}` };
  }
  const reading = validateProcessSnapshot(parsed);
  if (!reading.ok) return reading;
  const processes = reading.snapshot.processes.map((entry) => ({ ...entry, program: readWin32ProgramName(entry.name) }));
  return { ok: true, snapshot: { ...reading.snapshot, processes } };
}

/**
 * The program a Windows process runs: its image name without the `.exe` suffix, compared without
 * case the way Windows compares image names, so `UNITY.EXE` and `Unity` are both the Unity program.
 * @param {string} imageName  `Win32_Process.Name`
 * @returns {string}
 */
export function readWin32ProgramName(imageName) {
  return imageName.toLowerCase().replace(/\.exe$/, '');
}

/**
 * @returns {Promise<string>}
 */
export function readProbeScript() {
  return fs.readFile(k_scriptUrl, 'utf8');
}

/**
 * @param {string} text
 * @returns {unknown}  Undefined when no line parses as a JSON object.
 */
function readLastJsonLine(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // An earlier line may still be the answer.
    }
  }
  return undefined;
}

/**
 * @param {{ stdout: string, stderr: string }} result
 * @returns {string}
 */
function describeOutput(result) {
  const output = summarizeOutput(`${result.stdout} ${result.stderr}`, 120);
  return output ? `: ${output}` : '';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
