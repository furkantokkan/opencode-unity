// Setup item 0 (spec 14.1): what is on this machine before anything is asked. Everything here is
// read-only and nothing here loads a model - Ollama is asked for `/api/version` and `/api/tags` only, and
// the two programs that are started (`opencode --version`, `nvidia-smi`) print and exit.
//
// Nothing throws: a preflight that fails is information the plan uses, not a reason to stop before the
// user has seen the platform block.
import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, getFirstOutputLine, runProcess } from '../core/exec.js';
import { findOpencode } from '../opencode/locate.js';
import { compareVersions } from './manifest.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const NVIDIA_NAME_ARGS = Object.freeze(['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);

/**
 * @typedef {import('./plan.js').Preflight} Preflight
 */

/**
 * @typedef {object} PreflightInput
 * @property {NodeJS.Platform} platform
 * @property {Record<string, string | undefined>} env
 * @property {string} nodeVersion
 * @property {{ opencode: { tested: string }, ollama: { tested: string, min: string } }} compat
 * @property {import('../ollama/client.js').OllamaClient} ollama
 * @property {typeof runProcess} [run]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {typeof findOpencode} [locate]
 */

/**
 * The machine's state, without the two model checks: which preset - and therefore which model names - to
 * ask about is decided from the VRAM this call measures, so the caller finishes the object with
 * `withModelState` once it has chosen one.
 * @typedef {Omit<Preflight, 'baseModelInstalled'|'taggedModelInstalled'> & { powershell7: boolean, models: string[] }} PreflightFacts
 */

/**
 * @param {PreflightInput} input
 * @returns {Promise<PreflightFacts>}
 */
export async function runPreflight(input) {
  const [opencode, ollama, gpu] = await Promise.all([detectOpencode(input), detectOllama(input), detectGpu(input)]);
  return {
    node: input.nodeVersion,
    opencode,
    ollama: ollama.state,
    gpu,
    models: ollama.models,
    windowsTerminal: detectWindowsTerminal(input),
    powershell7: findExecutable('pwsh', { env: input.env, platform: input.platform }) !== null,
    dotnetSdk: findExecutable('dotnet', { env: input.env, platform: input.platform }) !== null,
  };
}

/**
 * @param {PreflightFacts} facts
 * @param {{ base: string, tag: string }} model
 * @returns {Preflight & { powershell7: boolean, models: string[] }}
 */
export function withModelState(facts, model) {
  const installed = new Set(facts.models);
  return { ...facts, baseModelInstalled: hasModel(installed, model.base), taggedModelInstalled: hasModel(installed, model.tag) };
}

/**
 * Ollama reports `qwen3-coder:30b` for a model pulled as `qwen3-coder:30b`, and `name:latest` for one
 * pulled without a tag, so both spellings have to count as installed.
 * @param {Set<string>} installed
 * @param {string} name
 * @returns {boolean}
 */
export function hasModel(installed, name) {
  return installed.has(name) || installed.has(`${name}:latest`) || (name.endsWith(':latest') && installed.has(name.slice(0, -':latest'.length)));
}

/**
 * @param {PreflightInput} input
 * @returns {Promise<Preflight['opencode']>}
 */
async function detectOpencode({ env, platform, compat, run = runProcess, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal, locate = findOpencode }) {
  const tested = compat.opencode.tested;
  // The same resolution `start` and `doctor` use: on Windows npm puts a batch shim on PATH, which
  // `runProcess` refuses to start, so probing the shim itself would read every install as missing.
  /** @type {import('../opencode/locate.js').OpencodeLocation | null} */
  let binary;
  try {
    binary = locate({ env, platform });
  } catch {
    return { state: 'unreadable', version: null, tested };
  }
  if (binary === null) return { state: 'missing', version: null, tested };
  const result = await run(binary.file, ['--version'], { timeoutMs, env, signal, platform });
  // Something is installed; a probe that failed says nothing about which version, and planning a
  // global install over it would replace a version the user chose (spec 14.1, 5.1).
  if (result.error || result.timedOut || result.exitCode !== 0) return { state: 'unreadable', version: null, tested };
  const version = parseVersion(getFirstOutputLine(result));
  if (version === null) return { state: 'other', version: 'unknown', tested };
  return { state: version === tested ? 'tested' : 'other', version, tested };
}

/**
 * @param {PreflightInput} input
 * @returns {Promise<{ state: Preflight['ollama'], models: string[] }>}
 */
async function detectOllama({ ollama, compat, signal }) {
  const tested = compat.ollama.tested;
  /** @type {string} */
  let version;
  try {
    version = await ollama.getVersion({ signal });
  } catch {
    return { state: { state: 'down', version: null, tested }, models: [] };
  }
  const order = compareVersions(version, tested);
  const state = order === 0 ? 'tested' : order < 0 ? 'older' : 'newer';
  /** @type {string[]} */
  let models = [];
  try {
    models = (await ollama.listModels({ signal })).map((model) => model.name);
  } catch {
    models = [];
  }
  return { state: { state, version, tested }, models };
}

/**
 * @param {PreflightInput} input
 * @returns {Promise<Preflight['gpu']>}
 */
async function detectGpu({ env, platform, run = runProcess, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal }) {
  const binary = findExecutable('nvidia-smi', { env, platform });
  if (binary === null) return { name: null, totalVramMiB: null };
  const result = await run(binary, [...NVIDIA_NAME_ARGS], { timeoutMs, env, signal, platform });
  if (result.error || result.timedOut || result.exitCode !== 0) return { name: null, totalVramMiB: null };
  return parseGpuLine(result.stdout);
}

/**
 * `name, memory.total` for GPU 0, in whole MiB because of `nounits`.
 * @param {string} text
 * @returns {Preflight['gpu']}
 */
export function parseGpuLine(text) {
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== '');
  if (!line) return { name: null, totalVramMiB: null };
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 2) return { name: null, totalVramMiB: null };
  const total = Number.parseInt(parts[1], 10);
  return { name: parts[0] || null, totalVramMiB: Number.isSafeInteger(total) && total > 0 ? total : null };
}

/**
 * Windows Terminal is per-user and not always on PATH, so the fragment directory's parent is the reliable
 * signal; `wt.exe` on PATH is the second.
 * @param {PreflightInput} input
 * @returns {boolean}
 */
function detectWindowsTerminal({ env, platform }) {
  if (platform !== 'win32') return false;
  if (findExecutable('wt', { env, platform }) !== null) return true;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return false;
  // A real filesystem probe, so the host's own path rules apply; in production they are Windows's.
  return existsSync(path.join(localAppData, 'Microsoft', 'Windows Terminal'));
}

/**
 * @param {string} line
 * @returns {string | null}
 */
export function parseVersion(line) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line);
  return match ? match[1] : null;
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function existsSync(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
