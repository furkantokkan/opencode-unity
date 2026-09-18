// Build step S18 and spec 26 item 8: the package round trip. The tarball npm would publish is packed,
// installed globally into a temp prefix, and driven through its own bin shim: `setup`, `init`,
// `start --print-env`, `doctor`, `uninstall`, then `npm uninstall`. Afterwards the sandbox home must hold
// exactly what it held before, which is the residue check of safety rule S11.
//
// Everything is sandboxed and mocked: the home, XDG and AppData directories are temp directories, Ollama
// is the loopback mock from src/selftest, and `opencode` and `nvidia-smi` are fakes on PATH. No model is
// pulled, created or loaded, no registry is reached, and OpenCode itself never starts.
//
// It packs and installs a package, so it runs only when OPENCODE_UNITY_TEST_PACKAGE_ROUNDTRIP=1 (the CI
// package job sets it). On Windows the product refuses to start batch files, so each fake gets a tiny
// console executable, compiled with the C# compiler that ships with the .NET Framework, which forwards to
// the Node fake.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveNpmInvocation } from '../../scripts/check-package-files.mjs';
import { parseEnvelope } from '../../src/cli/envelope.js';
import { startMockOllama } from '../../src/selftest/mock-ollama.js';
import { createFakeNvidiaSmi } from '../../src/selftest/fake-nvidia-smi.js';
import { createFakeBin } from '../helpers/fake-bin.mjs';
import { diffSnapshots, snapshotTree } from '../helpers/fixture-fs.mjs';
import { assertSafeEnv, mergeEnv, useSandbox } from '../helpers/sandbox.mjs';
import { materializeFixtureProject } from '../unit/unity/fixture-projects.mjs';

export const ROUNDTRIP_ENV = 'OPENCODE_UNITY_TEST_PACKAGE_ROUNDTRIP';
const ENABLED = process.env[ROUNDTRIP_ENV] === '1';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const COMPAT = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'compat.json'), 'utf8'));
const PRESET = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'presets', 'nvidia-24gb-qwen3-coder-30b-16k.json'), 'utf8'));

const IS_WINDOWS = process.platform === 'win32';
const STEP_TIMEOUT_MS = 180_000;

/** Files the published tarball must carry for a GitHub install to be usable. */
const SHIPPED_FILES = [
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'NOTICE.md',
  'compat.json',
  'hosts/claude/skills/opencode-unity-delegate/SKILL.md',
  'hosts/codex/skills/opencode-unity-delegate/SKILL.md',
  'hosts/antigravity/opencode-unity-delegate.md',
];

/** Development-only trees that must never be installed. */
const UNSHIPPED_DIRS = ['test', 'scripts', 'spikes', 'docs', '.github', 'node_modules'];

/** Ollama routes that write models; the round trip runs setup with --no-model, so none may be called. */
const MODEL_WRITE_PATHS = ['/api/pull', '/api/create', '/api/delete', '/api/copy', '/api/push'];

/**
 * Windows PowerShell keeps a startup cache under the user's local AppData the first time it runs there.
 * The guard's process probe starts it, so the cache is PowerShell's residue, not this product's.
 */
const POWERSHELL_CACHE = 'AppData/Local/Microsoft/Windows/PowerShell';

/**
 * The residue diff without PowerShell's own cache and the folders that exist only to hold it.
 * @param {{ added: string[], removed: string[], changed: string[] }} diff
 * @returns {{ added: string[], removed: string[], changed: string[] }}
 */
function withoutPowerShellCache(diff) {
  if (!IS_WINDOWS) return diff;
  const owned = (/** @type {string} */ entry) => entry === POWERSHELL_CACHE || entry.startsWith(`${POWERSHELL_CACHE}/`);
  const added = diff.added.filter((entry) => !owned(entry));
  // A parent folder of the cache counts as residue only when something else was added inside it.
  const onlyForCache = (/** @type {string} */ entry) => POWERSHELL_CACHE.startsWith(`${entry}/`) && !added.some((other) => other !== entry && other.startsWith(`${entry}/`) && !POWERSHELL_CACHE.startsWith(`${other}/`));
  return { ...diff, added: added.filter((entry) => !onlyForCache(entry)) };
}

/**
 * A console program that runs the command line stored next to it in `<name>.run.txt` (one argument per
 * line, the executable first), appends its own arguments, relays both output streams byte for byte and
 * exits with the child's code. C# 5, so the compiler in every .NET Framework 4 install builds it.
 */
const TRAMPOLINE_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class Trampoline
{
    private static int Main(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(self);
        string name = Path.GetFileNameWithoutExtension(self);
        string[] stored = File.ReadAllLines(Path.Combine(dir, name + ".run.txt"));
        StringBuilder line = new StringBuilder();
        for (int index = 1; index < stored.Length; index++)
        {
            if (stored[index].Length == 0) continue;
            line.Append(' ').Append(Quote(stored[index]));
        }
        foreach (string arg in args) line.Append(' ').Append(Quote(arg));
        ProcessStartInfo info = new ProcessStartInfo(stored[0], line.ToString());
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;
        using (Process child = Process.Start(info))
        {
            Stream stderr = Console.OpenStandardError();
            Thread relay = new Thread(() => child.StandardError.BaseStream.CopyTo(stderr));
            relay.Start();
            Stream stdout = Console.OpenStandardOutput();
            child.StandardOutput.BaseStream.CopyTo(stdout);
            relay.Join();
            child.WaitForExit();
            stdout.Flush();
            stderr.Flush();
            return child.ExitCode;
        }
    }

    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') quoted.Append('\\', backslashes * 2 + 1).Append('"');
            else quoted.Append('\\', backslashes).Append(c);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }
}
`;

/**
 * @typedef {object} ProcessResult
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Asynchronous on purpose: the mock Ollama answers from this process, so a synchronous spawn would
 * leave every CLI request waiting on a server that cannot run.
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, windowsVerbatimArguments?: boolean, timeoutMs?: number }} options
 * @returns {Promise<ProcessResult>}
 */
function runProcess(file, args, { cwd, env, windowsVerbatimArguments = false, timeoutMs = STEP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { cwd, env, windowsVerbatimArguments, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(file)} ${args.join(' ')} did not finish within ${timeoutMs} ms\n${stderr}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/**
 * npm's own CLI script, run by this Node, so no shell is involved in packing or installing.
 * @param {readonly string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined> }} options
 * @returns {Promise<ProcessResult>}
 */
async function runNpm(args, { cwd, env }) {
  const npm = resolveNpmInvocation({ env: process.env });
  const result = await runProcess(npm.file, [...npm.args, ...args], { cwd, env });
  assert.equal(result.exitCode, 0, `npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

/**
 * Runs the installed CLI through the shim npm wrote, the way a user's shell does.
 * @param {string} prefix
 * @param {readonly string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined> }} options
 * @returns {Promise<ProcessResult & { envelope: import('../../src/cli/envelope.js').Envelope }>}
 */
async function runInstalledCli(prefix, args, { cwd, env }) {
  const result = IS_WINDOWS
    ? await runProcess(env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', `"${[`"${path.join(prefix, 'opencode-unity.cmd')}"`, ...args].join(' ')}"`], { cwd, env, windowsVerbatimArguments: true })
    : await runProcess(path.join(prefix, 'bin', 'opencode-unity'), args, { cwd, env });
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  /** @type {import('../../src/cli/envelope.js').Envelope} */
  let envelope;
  try {
    envelope = parseEnvelope(lastLine);
  } catch (error) {
    throw new Error(`opencode-unity ${args.join(' ')} printed no envelope (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`, { cause: error });
  }
  return { ...result, envelope };
}

/**
 * @param {string} dir
 * @returns {Promise<string>} The compiled trampoline.
 */
async function compileTrampoline(dir) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map((flavor) => path.join(systemRoot, 'Microsoft.NET', flavor, 'v4.0.30319', 'csc.exe'));
  const csc = candidates.find((candidate) => fsSync.existsSync(candidate));
  assert.ok(csc, `the round trip needs the .NET Framework C# compiler to build its Windows fakes; looked in ${candidates.join(', ')}`);
  const source = path.join(dir, 'trampoline.cs');
  const output = path.join(dir, 'trampoline.exe');
  await fs.writeFile(source, TRAMPOLINE_SOURCE);
  const result = await runProcess(csc, ['/nologo', '/target:exe', `/out:${output}`, source], { cwd: dir, env: process.env });
  assert.equal(result.exitCode, 0, `csc failed:\n${result.stdout}\n${result.stderr}`);
  return output;
}

/**
 * Puts a Node fake on PATH as `<name>`: the launcher `createFakeBin` or `createFakeNvidiaSmi` wrote on
 * POSIX, and a trampoline executable on Windows, where the product refuses batch launchers.
 * @param {{ dir: string, name: string, commandLine: string[], trampoline: string | null }} input
 */
async function exposeFake({ dir, name, commandLine, trampoline }) {
  if (!IS_WINDOWS) return;
  await fs.rm(path.join(dir, `${name}.cmd`), { force: true });
  await fs.writeFile(path.join(dir, `${name}.run.txt`), `${commandLine.join('\r\n')}\r\n`);
  await fs.copyFile(/** @type {string} */ (trampoline), path.join(dir, `${name}.exe`));
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listEntries(dir) {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe('package round trip (build step S18)', { skip: ENABLED ? false : `set ${ROUNDTRIP_ENV}=1 to run it (the CI package job does)` }, () => {
  it('packs, installs, sets up, initializes, prints the launch, diagnoses and uninstalls, and leaves no residue', { timeout: 900_000 }, async (t) => {
    const sandbox = await useSandbox(t, 'roundtrip');
    const work = sandbox.path('work');
    const prefix = sandbox.path('prefix');
    const fakeBin = sandbox.dirs.bin;
    await fs.mkdir(work, { recursive: true });
    await fs.mkdir(prefix, { recursive: true });

    // Mocks: Ollama on loopback with the preset's tag, a fake OpenCode at the tested version, and a
    // fake nvidia-smi with an idle 24 GB card.
    const ollama = await startMockOllama({
      models: [
        PRESET.model.base,
        {
          name: `${PRESET.model.tag}:latest`,
          renderer: PRESET.model.renderer,
          parser: PRESET.model.parser,
          parameters: {
            num_ctx: PRESET.model.numCtx,
            num_keep: PRESET.model.numKeep,
            num_batch: PRESET.model.numBatch,
            temperature: PRESET.model.sampling.temperature,
            top_p: PRESET.model.sampling.topP,
            top_k: PRESET.model.sampling.topK,
            repeat_penalty: PRESET.model.sampling.repeatPenalty,
          },
        },
      ],
    });
    t.after(() => ollama.close());
    const trampoline = IS_WINDOWS ? await compileTrampoline(work) : null;
    const opencode = await createFakeBin(fakeBin, 'opencode', { routes: [{ args: ['--version'], responses: [{ stdout: `${COMPAT.opencode.tested}\n` }] }] });
    await exposeFake({ dir: fakeBin, name: 'opencode', commandLine: [opencode.invocation.file, ...opencode.invocation.args], trampoline });
    const nvidiaSmi = await createFakeNvidiaSmi(fakeBin);
    await exposeFake({ dir: fakeBin, name: 'nvidia-smi', commandLine: [nvidiaSmi.invocation.file, ...nvidiaSmi.invocation.args], trampoline });

    const systemDirs = IS_WINDOWS
      ? [path.join(sandbox.env.SystemRoot ?? sandbox.env.SYSTEMROOT ?? 'C:\\Windows', 'System32')]
      : ['/usr/bin', '/bin'];
    const binDir = IS_WINDOWS ? prefix : path.join(prefix, 'bin');
    const env = mergeEnv(sandbox.env, { PATH: [fakeBin, binDir, path.dirname(process.execPath), ...systemDirs].join(path.delimiter) });
    assertSafeEnv(env);

    // The user's own settings: the mock server, and never start an Ollama application.
    await fs.mkdir(sandbox.productHome, { recursive: true });
    const userConfig = `${JSON.stringify({ schemaVersion: 1, ollama: { baseUrl: ollama.url, startAppIfDown: 'never' } }, null, 2)}\n`;
    await fs.writeFile(path.join(sandbox.productHome, 'config.json'), userConfig);
    const homeBefore = await snapshotTree(sandbox.dirs.home);

    // 1. Pack exactly what npm would publish, and install it globally into the temp prefix.
    const packed = await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: REPO_ROOT, env });
    const tarballName = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename;
    assert.equal(tarballName, `${PACKAGE.name}-${PACKAGE.version}.tgz`);
    await runNpm(['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', path.join(work, tarballName)], { cwd: work, env });
    const installed = IS_WINDOWS ? path.join(prefix, 'node_modules', PACKAGE.name) : path.join(prefix, 'lib', 'node_modules', PACKAGE.name);
    for (const file of SHIPPED_FILES) assert.ok(fsSync.existsSync(path.join(installed, file)), `the package ships ${file}`);
    const installedEntries = await listEntries(installed);
    for (const dir of UNSHIPPED_DIRS) assert.ok(!installedEntries.includes(dir), `the package does not ship ${dir}/`);

    const version = await runInstalledCli(prefix, ['--version', '--json'], { cwd: work, env });
    assert.equal(version.envelope.data.version, PACKAGE.version);

    // 2. setup, without a model: the profile only.
    const setup = await runInstalledCli(prefix, ['setup', '--no-model', '--yes', '--json'], { cwd: work, env });
    assert.equal(setup.envelope.exitCode, 0, `${setup.envelope.message}\n${setup.stderr}`);
    const applied = /** @type {Array<{ id: string, status: string }>} */ (setup.envelope.data.steps).filter((step) => step.status === 'applied').map((step) => step.id);
    assert.ok(applied.includes('profile-render'), `applied steps: ${applied.join(', ')}`);
    assert.ok(fsSync.existsSync(path.join(sandbox.productHome, 'profile', PACKAGE.version, 'opencode-unity.runtime.json')), 'the runtime profile was rendered');

    // 3. init in a Unity project: read-only on the project.
    const project = materializeFixtureProject('u6-urp-ugui-git', sandbox.path('MyGame'));
    const projectBefore = await snapshotTree(project);
    const init = await runInstalledCli(prefix, ['init', '--yes', '--json'], { cwd: project, env });
    assert.equal(init.envelope.exitCode, 0, `${init.envelope.message}\n${init.stderr}`);

    // 4. start --print-env: the launch as it would run, with nothing written and OpenCode never started.
    await opencode.setSpec({ routes: [{ args: ['--version'], responses: [{ stdout: `${COMPAT.opencode.tested}\n` }] }] });
    const start = await runInstalledCli(prefix, ['start', '--print-env', '--json'], { cwd: project, env });
    assert.equal(start.envelope.exitCode, 0, `${start.envelope.message}\n${start.stderr}`);
    assert.equal(start.envelope.data.agent, 'unity-code');
    assert.ok(start.envelope.data.content && typeof start.envelope.data.content === 'object', 'the per-launch content is printed');
    assert.ok(!fsSync.existsSync(/** @type {string} */ (start.envelope.data.launchJson)), 'print-env writes no launch.json');
    assert.deepEqual((await opencode.readCalls()).map((call) => call.args), [['--version']], 'OpenCode is asked for its version and nothing else');

    // 5. doctor: a full report, and still no model load.
    const doctor = await runInstalledCli(prefix, ['doctor', '--json'], { cwd: project, env });
    assert.equal(doctor.envelope.command, 'doctor');
    assert.ok([0, 5].includes(doctor.envelope.exitCode), `doctor exit ${doctor.envelope.exitCode}: ${doctor.envelope.message}\n${doctor.stderr}`);
    assert.deepEqual(diffSnapshots(projectBefore, await snapshotTree(project)), { added: [], removed: [], changed: [] }, 'init, start --print-env and doctor never write into the project');

    // 6. uninstall, then remove the package itself.
    const uninstall = await runInstalledCli(prefix, ['uninstall', '--yes', '--json'], { cwd: work, env });
    assert.equal(uninstall.envelope.exitCode, 0, `${uninstall.envelope.message}\n${uninstall.stderr}`);
    await runNpm(['uninstall', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', PACKAGE.name], { cwd: work, env });

    // Residue: the product home holds only the user's own config.json, byte for byte, and nothing else
    // in the sandbox home changed; the prefix no longer has the package or its shims.
    assert.deepEqual(await listEntries(sandbox.productHome), ['config.json']);
    assert.equal(await fs.readFile(path.join(sandbox.productHome, 'config.json'), 'utf8'), userConfig);
    assert.deepEqual(withoutPowerShellCache(diffSnapshots(homeBefore, await snapshotTree(sandbox.dirs.home))), { added: [], removed: [], changed: [] }, 'no residue in the sandbox home');
    assert.ok(!fsSync.existsSync(installed), 'npm uninstall removed the package');
    assert.deepEqual((await listEntries(binDir)).filter((entry) => entry.startsWith(PACKAGE.name)), [], 'npm uninstall removed the shims');

    // The mock saw reads only: nothing loaded, pulled, created or deleted a model.
    assert.deepEqual(ollama.mock.loadRequests, []);
    assert.deepEqual(ollama.mock.requests.filter((request) => MODEL_WRITE_PATHS.includes(request.path)), []);
  });
});
