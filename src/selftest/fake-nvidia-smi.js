// Fake `nvidia-smi` for guard tests and the self-test (spec 20.3). It answers `--query-gpu` calls from a
// JSON state file the caller can change between calls, the way the real tool formats CSV output, and
// logs each call. `createFakeNvidiaSmi` writes a small launcher next to the state file, so the fake can
// be run by path without environment variables.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} FakeGpu
 * @property {number} index
 * @property {string} [name]
 * @property {string} [uuid]
 * @property {string} [driverVersion]
 * @property {number} memoryTotalMiB
 * @property {number} memoryFreeMiB
 * @property {number[]} [utilizationGpu]  Samples for successive utilization queries; the last repeats.
 */

/**
 * @typedef {object} FakeOutput
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number} [exitCode]
 */

/**
 * @typedef {object} NvidiaSmiState
 * @property {FakeGpu[]} gpus
 * @property {FakeOutput} [override]     Replaces every answer (driver failure, garbage output).
 * @property {number} [delayMs]          Answer late (probe timeout tests).
 */

/**
 * @typedef {object} NvidiaSmiCall
 * @property {string[]} args
 * @property {string[]} fields
 * @property {number} utilizationIndex  Which utilization sample the call used, or -1.
 */

const MOCK_GPU_NAME = 'Mock GPU 24GB';
const DEFAULT_TOTAL_MIB = 24576;

// Header labels and units, matching `nvidia-smi --format=csv` without `noheader` / `nounits`.
const FIELDS = Object.freeze({
  index: { header: 'index', unit: '' },
  name: { header: 'name', unit: '' },
  uuid: { header: 'uuid', unit: '' },
  driver_version: { header: 'driver_version', unit: '' },
  'memory.total': { header: 'memory.total [MiB]', unit: ' MiB' },
  'memory.used': { header: 'memory.used [MiB]', unit: ' MiB' },
  'memory.free': { header: 'memory.free [MiB]', unit: ' MiB' },
  'utilization.gpu': { header: 'utilization.gpu [%]', unit: ' %' },
});

// Real nvidia-smi says this on stdout when the driver cannot be reached.
export const DRIVER_FAILURE_MESSAGE = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\n";

/** @type {Readonly<Record<string, NvidiaSmiState>>} */
export const NVIDIA_SMI_PRESETS = Object.freeze({
  // 21.5 GiB free: enough for a 19,000 MiB model plus the 1,500 MiB minimum (spec 7.3 C2).
  normal: { gpus: [createGpu({ memoryFreeMiB: 22000, utilizationGpu: [3] })] },
  // 19,800 MiB free leaves 0.8 GiB after a 19,000 MiB load: a cold block (spec 7.6 example).
  lowVram: { gpus: [createGpu({ memoryFreeMiB: 19800, utilizationGpu: [3] })] },
  gpuBusy: { gpus: [createGpu({ memoryFreeMiB: 22000, utilizationGpu: [85, 90] })] },
  multiGpu: { gpus: [createGpu({ memoryFreeMiB: 22000 }), createGpu({ index: 1, memoryTotalMiB: 12288, memoryFreeMiB: 11800 })] },
  driverFailure: { gpus: [], override: { stdout: DRIVER_FAILURE_MESSAGE, exitCode: 9 } },
  garbage: { gpus: [], override: { stdout: 'free memory: plenty\n', exitCode: 0 } },
});

/**
 * @param {Partial<FakeGpu>} [overrides]
 * @returns {FakeGpu}
 */
export function createGpu(overrides = {}) {
  const index = overrides.index ?? 0;
  return {
    index,
    name: MOCK_GPU_NAME,
    uuid: `GPU-00000000-0000-0000-0000-00000000000${index}`,
    driverVersion: '580.00',
    memoryTotalMiB: DEFAULT_TOTAL_MIB,
    memoryFreeMiB: DEFAULT_TOTAL_MIB,
    utilizationGpu: [0],
    ...overrides,
  };
}

/**
 * Pure answer for one call.
 * @param {string[]} args
 * @param {NvidiaSmiState} state
 * @param {number} utilizationIndex  Count of earlier calls that queried utilization.
 * @returns {Required<FakeOutput> & { fields: string[] }}
 */
export function respondToNvidiaSmi(args, state, utilizationIndex = 0) {
  const parsed = parseArgs(args);
  if (state.override) return { stdout: state.override.stdout ?? '', stderr: state.override.stderr ?? '', exitCode: state.override.exitCode ?? 0, fields: parsed.fields };
  if (parsed.error) return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 2, fields: parsed.fields };
  if (parsed.fields.length === 0) return { stdout: '', stderr: 'fake nvidia-smi: only --query-gpu calls are supported\n', exitCode: 2, fields: [] };
  const unknown = parsed.fields.find((field) => !(field in FIELDS));
  if (unknown) return { stdout: `Field "${unknown}" is not a valid field to query.\n\n`, stderr: '', exitCode: 2, fields: parsed.fields };
  const gpus = parsed.id === null ? state.gpus : state.gpus.filter((gpu) => gpu.index === parsed.id);
  if (gpus.length === 0) return { stdout: 'No devices were found\n', stderr: '', exitCode: 6, fields: parsed.fields };
  const lines = parsed.header ? [parsed.fields.map((field) => FIELDS[/** @type {keyof typeof FIELDS} */ (field)].header).join(', ')] : [];
  for (const gpu of gpus) {
    lines.push(parsed.fields.map((field) => formatField(gpu, field, parsed.units, utilizationIndex)).join(', '));
  }
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0, fields: parsed.fields };
}

/**
 * @typedef {object} FakeNvidiaSmi
 * @property {string} scriptPath   Node launcher (`<name>.mjs`); run it with a Node binary.
 * @property {{ file: string, args: string[] }} invocation  Shell-free form: spawn `file` with `args` plus the call arguments.
 * @property {string} command      `<name>.cmd` on Windows (needs a shell or `cmd.exe /d /c`), an executable sh script elsewhere.
 * @property {string} statePath
 * @property {string} callsPath
 * @property {(state: NvidiaSmiState) => Promise<void>} setState  Replaces the state and clears the call log.
 * @property {() => Promise<NvidiaSmiCall[]>} readCalls
 */

/**
 * @param {string} dir
 * @param {NvidiaSmiState} [state]
 * @param {{ name?: string, nodePath?: string }} [options]
 * @returns {Promise<FakeNvidiaSmi>}
 */
export async function createFakeNvidiaSmi(dir, state = NVIDIA_SMI_PRESETS.normal, { name = 'nvidia-smi', nodePath = process.execPath } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, `${name}.mjs`);
  const statePath = path.join(dir, `${name}.state.json`);
  const callsPath = path.join(dir, `${name}.calls.jsonl`);
  await fsp.writeFile(
    scriptPath,
    `import { runFakeNvidiaSmiProcess } from ${JSON.stringify(import.meta.url)};\nawait runFakeNvidiaSmiProcess(${JSON.stringify(statePath)}, process.argv.slice(2));\n`,
  );
  const command = await writeLauncher(dir, name, nodePath, scriptPath);
  const setState = async (/** @type {NvidiaSmiState} */ next) => {
    await fsp.writeFile(statePath, JSON.stringify(next, null, 2));
    await fsp.rm(callsPath, { force: true });
  };
  await setState(state);
  return {
    scriptPath,
    invocation: { file: nodePath, args: [scriptPath] },
    command,
    statePath,
    callsPath,
    setState,
    readCalls: () => readCallLog(callsPath),
  };
}

/**
 * Entry point used by the generated launcher.
 * @param {string} statePath
 * @param {string[]} args
 */
export async function runFakeNvidiaSmiProcess(statePath, args) {
  const state = /** @type {NvidiaSmiState} */ (JSON.parse(fs.readFileSync(statePath, 'utf8')));
  const callsPath = statePath.replace(/\.state\.json$/, '.calls.jsonl');
  const earlier = await readCallLog(callsPath);
  const utilizationIndex = earlier.filter((call) => call.utilizationIndex >= 0).length;
  const answer = respondToNvidiaSmi(args, state, utilizationIndex);
  /** @type {NvidiaSmiCall} */
  const call = { args, fields: answer.fields, utilizationIndex: answer.fields.includes('utilization.gpu') ? utilizationIndex : -1 };
  fs.appendFileSync(callsPath, `${JSON.stringify(call)}\n`);
  if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  process.stdout.write(answer.stdout);
  process.stderr.write(answer.stderr);
  process.exitCode = answer.exitCode;
}

/**
 * @param {string[]} args
 * @returns {{ fields: string[], header: boolean, units: boolean, id: number | null, error: string | null }}
 */
function parseArgs(args) {
  /** @type {string[]} */
  let fields = [];
  /** @type {string[] | null} */
  let format = null;
  /** @type {number | null} */
  let id = null;
  for (let position = 0; position < args.length; position += 1) {
    const arg = args[position];
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const takeValue = () => inlineValue ?? args[++position];
    if (flag === '--query-gpu') fields = splitList(takeValue());
    else if (flag === '--format') format = splitList(takeValue());
    else if (flag === '-i' || flag === '--id') id = Number(takeValue());
    else return { fields, header: false, units: false, id: null, error: `Invalid combination of input arguments: ${arg}` };
  }
  if (id !== null && !Number.isInteger(id)) return { fields, header: false, units: false, id: null, error: 'Invalid GPU id' };
  if (fields.length > 0 && (!format || !format.includes('csv'))) {
    return { fields, header: false, units: false, id, error: '--query-gpu requires --format=csv' };
  }
  return { fields, header: !format?.includes('noheader'), units: !format?.includes('nounits'), id, error: null };
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function splitList(value) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * @param {FakeGpu} gpu
 * @param {string} field
 * @param {boolean} units
 * @param {number} utilizationIndex
 * @returns {string}
 */
function formatField(gpu, field, units, utilizationIndex) {
  const unit = units ? FIELDS[/** @type {keyof typeof FIELDS} */ (field)].unit : '';
  switch (field) {
    case 'index': return String(gpu.index);
    case 'name': return gpu.name ?? MOCK_GPU_NAME;
    case 'uuid': return gpu.uuid ?? `GPU-${gpu.index}`;
    case 'driver_version': return gpu.driverVersion ?? '580.00';
    case 'memory.total': return `${gpu.memoryTotalMiB}${unit}`;
    case 'memory.free': return `${gpu.memoryFreeMiB}${unit}`;
    case 'memory.used': return `${gpu.memoryTotalMiB - gpu.memoryFreeMiB}${unit}`;
    default: {
      const samples = gpu.utilizationGpu?.length ? gpu.utilizationGpu : [0];
      return `${samples[Math.min(utilizationIndex, samples.length - 1)]}${unit}`;
    }
  }
}

/**
 * @param {string} callsPath
 * @returns {Promise<NvidiaSmiCall[]>}
 */
async function readCallLog(callsPath) {
  const text = await fsp.readFile(callsPath, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} nodePath
 * @param {string} scriptPath
 * @returns {Promise<string>}
 */
async function writeLauncher(dir, name, nodePath, scriptPath) {
  if (process.platform === 'win32') {
    const launcher = path.join(dir, `${name}.cmd`);
    await fsp.writeFile(launcher, `@"${nodePath}" "${scriptPath}" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(dir, name);
  await fsp.writeFile(launcher, `#!/bin/sh\nexec "${nodePath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return launcher;
}
