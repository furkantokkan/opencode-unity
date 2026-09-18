// The collector against a mock Ollama, a sandbox home and a copied fixture project. The central
// assertion is the spec 5.4 invariant: a doctor run asks the Ollama API only for read-only routes and
// the mock records zero model-load requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { loadPreset } from '../../src/core/presets.js';
import { collectDoctorContext, buildRedactionTargets, resolveWorktreeRoot } from '../../src/doctor/context.js';
import { CHECKS } from '../../src/doctor/checks/index.js';
import { runChecks } from '../../src/doctor/engine.js';
import { NATIVE_LOAD_PATHS, startMockOllama } from '../../src/selftest/mock-ollama.js';
import { copyFixture } from '../helpers/fixture-fs.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';

const READ_ONLY_ROUTES = new Set(['/api/version', '/api/tags', '/api/show', '/api/ps']);
const PRESET = loadPreset(DEFAULT_CONFIG.preset);

/** Guard probes that answer like a quiet machine, so no real process or GPU tool is touched. */
function quietProbes() {
  return {
    readOllamaPs: async () => ({ ok: true, models: [] }),
    readNvidiaSmi: async () => ({ ok: true, gpuCount: 1, memory: { ok: true, totalMiB: 24576, freeMiB: 23000 }, utilization: { ok: true, percent: 2 } }),
    processes: {
      platform: 'test',
      detect: async () => ({ ok: true, running: false, count: 0 }),
      sample: async () => ({ ok: true, snapshot: { probePid: 1, ancestors: [], sampleMs: 1500, elapsedMs: 1500, processes: [] } }),
    },
    sleep: async () => {},
    now: () => Date.parse('2026-09-18T10:00:00.000Z'),
  };
}

/** A process runner that starts nothing: every executable is reported missing. */
async function noProcess() {
  return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), durationMs: 0 };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ installed: boolean, baseUrl?: string }} options
 */
async function prepare(t, { installed, baseUrl }) {
  const sandbox = await useSandbox(t, 'doctor-context');
  const project = await copyFixture('unity-projects/u6-urp-ugui-git', sandbox.path('project'));
  await fs.mkdir(sandbox.productHome, { recursive: true });
  if (installed) {
    await fs.writeFile(path.join(sandbox.productHome, 'config.json'), JSON.stringify({ schemaVersion: 1, ollama: { baseUrl } }));
  }
  const env = { ...sandbox.env, OPENCODE_UNITY_HOME: sandbox.productHome };
  return { sandbox, project, env };
}

/**
 * @param {{ env: Record<string, string>, project: string, sandbox: import('../helpers/sandbox.mjs').Sandbox }} prepared
 * @param {Record<string, any>} [deps]
 */
function collect({ env, project, sandbox }, deps = {}) {
  return collectDoctorContext({
    cliVersion: '0.1.0',
    env,
    platform: process.platform,
    options: { projectPath: project, profile: null, deep: false, strict: false, redact: false, logsOverride: null },
    deps: {
      run: noProcess,
      locate: () => null,
      probes: quietProbes(),
      homedir: sandbox.dirs.home,
      readLogFile: async () => null,
      readSystemFile: () => null,
      isWritable: () => true,
      ...deps,
    },
  });
}

describe('collectDoctorContext', () => {
  it('asks Ollama only for read-only routes and never loads a model (spec 5.4 invariant)', async (t) => {
    const ollama = await startMockOllama({
      models: [{ name: PRESET.model.tag, parameters: { num_ctx: PRESET.model.numCtx }, renderer: PRESET.model.renderer, parser: PRESET.model.parser }],
    });
    t.after(() => ollama.close());
    const prepared = await prepare(t, { installed: true, baseUrl: ollama.url });
    /** @type {string[]} */
    const origins = [];
    const recordingFetch = (/** @type {any} */ input, /** @type {any} */ init) => {
      origins.push(new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url).origin);
      return globalThis.fetch(input, init);
    };
    const context = await collect(prepared, { fetchImpl: recordingFetch });
    runChecks(context, { checks: CHECKS });

    // D-M27: no HTTP request to any destination outside the configured Ollama endpoint.
    assert.ok(origins.length > 0);
    assert.deepEqual([...new Set(origins)], [new URL(ollama.url).origin]);
    assert.equal(context.ollama.reachable, true);
    assert.equal(ollama.mock.loadRequests.length, 0);
    const paths = ollama.server.requests.map((request) => request.path);
    assert.ok(paths.length > 0);
    for (const route of paths) assert.ok(READ_ONLY_ROUTES.has(route), `doctor asked for ${route}`);
    for (const route of context.ollama.requestedRoutes) assert.ok(!NATIVE_LOAD_PATHS.includes(route), route);
    assert.equal(context.ollama.show?.renderer, PRESET.model.renderer);
  });

  it('describes an uninstalled machine without failing, and scans the project', async (t) => {
    const prepared = await prepare(t, { installed: false });
    const failingFetch = async () => { throw new TypeError('fetch failed'); };
    const context = await collect(prepared, { fetchImpl: failingFetch });
    assert.equal(context.home.installed, false);
    assert.equal(context.ollama.reachable, false);
    assert.match(context.ollama.error ?? '', /fetch failed/);
    assert.equal(path.resolve(context.project.root ?? ''), path.resolve(prepared.project));
    assert.ok(context.project.scan);
    assert.equal(context.project.initialized, false);
    assert.equal(context.opencode.binary.path, null);
    assert.equal(context.logs.read, false);

    const report = runChecks(context, { checks: CHECKS });
    const crashed = report.findings.filter((finding) => finding.data.checkError !== undefined);
    assert.deepEqual(crashed.map((finding) => finding.message), []);
    const errors = report.findings.filter((finding) => finding.severity === 'error');
    assert.deepEqual(errors.map((finding) => finding.id), []);
  });

  it('records a broken config.json as an installed machine with a config error', async (t) => {
    const prepared = await prepare(t, { installed: false });
    await fs.writeFile(path.join(prepared.sandbox.productHome, 'config.json'), '{ not json');
    const context = await collect(prepared, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(context.home.installed, true);
    assert.ok(context.home.configError);
  });

  it('reads the facts and project.json that init wrote for this project', async (t) => {
    const prepared = await prepare(t, { installed: false });
    const first = await collect(prepared, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const projectPaths = first.home.paths.project(/** @type {string} */ (first.project.projectId));
    await fs.mkdir(projectPaths.dir, { recursive: true });
    await fs.writeFile(projectPaths.facts, '# Project facts\n');
    await fs.writeFile(projectPaths.projectJson, JSON.stringify({ inputsHash: 'x', generator: { factsVersion: 1 } }));
    const second = await collect(prepared, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(second.project.initialized, true);
    assert.equal(second.project.factsText, '# Project facts\n');
    assert.equal(typeof second.project.inputsHash, 'string');
  });

  it('reports no Unity project for a directory without one', async (t) => {
    const prepared = await prepare(t, { installed: false });
    const context = await collect({ ...prepared, project: prepared.sandbox.dirs.tmp }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(context.project.root, null);
    assert.equal(context.project.scan, null);
  });

  it('reads the Ollama version, the dotnet SDKs and the log through the injected runners', async (t) => {
    const prepared = await prepare(t, { installed: false });
    /** @type {string[][]} */
    const spawned = [];
    const run = async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      spawned.push([path.basename(file), ...args]);
      const stdout = args[0] === '--list-sdks' ? '8.0.100 [/usr/share/dotnet/sdk]\n' : 'opencode 1.18.31\n';
      return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, aborted: false, truncated: false, error: null, durationMs: 1 };
    };
    const locate = (/** @type {string} */ name) => (name === 'nvidia-smi' ? null : path.join(prepared.sandbox.dirs.bin, name));
    const context = await collect(prepared, {
      run,
      locate,
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
      readLogFile: async () => 'time=2026-09-18T09:00:00.000Z level=WARN source=runner.go:1 msg="truncating input prompt" limit=16384 prompt=20000 keep=4 new=8194\n',
    });
    assert.equal(context.opencode.binary.version, '1.18.31');
    assert.deepEqual(context.project.scan?.dotnet.sdks, ['8.0.100']);
    assert.ok(spawned.some((entry) => entry[1] === '--version'));
    if (context.logs.source.kind === 'file') assert.equal(context.logs.read, true);
  });

  it('builds redaction targets from the project and the home directory', async (t) => {
    const prepared = await prepare(t, { installed: false });
    const context = await collect(prepared, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    const targets = buildRedactionTargets(context, { env: {}, homedir: prepared.sandbox.dirs.home, hostname: 'test-host' });
    assert.ok(targets.projectPaths?.includes(/** @type {string} */ (context.project.root)));
    assert.ok(targets.homeDirs?.includes(context.home.dir));
    assert.ok(targets.projectNames?.includes(/** @type {string} */ (context.project.scan?.projectName)));
  });
});

describe('resolveWorktreeRoot', () => {
  it('walks up as many directories as the VCS marker was found above the project', () => {
    const project = /** @type {any} */ ({ root: path.join(path.sep, 'repo', 'client', 'Game'), scan: { vcs: { depth: 2 } } });
    assert.equal(resolveWorktreeRoot(project, process.platform), path.join(path.sep, 'repo'));
  });

  it('is null without a project or a marker', () => {
    assert.equal(resolveWorktreeRoot(/** @type {any} */ ({ root: null, scan: null }), process.platform), null);
    assert.equal(resolveWorktreeRoot(/** @type {any} */ ({ root: '/x', scan: { vcs: { depth: null } } }), 'linux'), null);
  });
});
