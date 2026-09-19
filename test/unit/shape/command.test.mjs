// `opencode-unity shape` in process: input forms, output streams, exit codes, and the promise that it
// writes nothing (S-SH4), proved by snapshotting the workspace and the product home around each run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { createConsent } from '../../../src/cli/consent.js';
import { createOutput } from '../../../src/cli/output.js';
import { createInterruptController } from '../../../src/cli/signals.js';
import { CLI_VERSION } from '../../../src/cli/version.js';
import { run } from '../../../src/commands/shape.js';
import { DEFAULT_CONFIG } from '../../../src/core/config.js';
import { getHomePaths } from '../../../src/core/paths.js';
import { loadSession, resolveProject } from '../../../src/project/session.js';
import { diffSnapshots, snapshotTree, writeTree } from '../../helpers/fixture-fs.mjs';
import { CLOSED_PORT_URL, useSandbox } from '../../helpers/sandbox.mjs';
import { SHAPE_FIXTURES_DIR, createProbes, createRecordingFetch, createThrowingFetch, readModelReply } from './helpers.mjs';

/**
 * @typedef {object} ShapeHarness
 * @property {string} workspace
 * @property {string} home
 * @property {Record<string, string>} env
 * @property {(input?: RunInput) => Promise<RunOutcome>} run
 * @property {() => Promise<Record<string, any>>} snapshot
 */

/**
 * @typedef {object} RunInput
 * @property {string} [text]
 * @property {Record<string, unknown>} [options]
 * @property {boolean} [json]
 * @property {string} [cwd]
 * @property {string} [project]
 * @property {Record<string, unknown>} [deps]
 */

/**
 * @typedef {object} RunOutcome
 * @property {number} exitCode
 * @property {string | undefined} code
 * @property {string} message
 * @property {Record<string, any>} data
 * @property {string[]} warnings
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * A sandbox home with a config, the shaping fixture project copied to a real directory whose own `.git`
 * pins the workspace root, and a runner with separate stdout and stderr.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<ShapeHarness>}
 */
async function createHarness(t) {
  const sandbox = await useSandbox(t, 'shape-command');
  const home = sandbox.productHome;
  const paths = getHomePaths(home);
  await fs.mkdir(path.dirname(paths.gpuLock), { recursive: true });
  await fs.writeFile(paths.config, `${JSON.stringify({ schemaVersion: DEFAULT_CONFIG.schemaVersion, ollama: { baseUrl: CLOSED_PORT_URL } }, null, 2)}\n`, 'utf8');
  const workspace = path.join(sandbox.root, 'workspace');
  await fs.cp(path.join(SHAPE_FIXTURES_DIR, 'projects', 'inventory-game'), workspace, { recursive: true });
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });

  /** @param {RunInput} [input] */
  const runShape = async (input = {}) => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const json = input.json ?? false;
    const out = { write: (/** @type {string} */ text) => (stdout.push(text), true) };
    const err = { write: (/** @type {string} */ text) => (stderr.push(text), true) };
    /** @type {import('../../../src/cli/main.js').CommandContext} */
    const context = {
      command: 'shape',
      subcommand: undefined,
      args: input.text === undefined ? {} : { text: input.text },
      options: /** @type {any} */ ({ noModel: false, ...input.options }),
      global: { json, yes: false, dryRun: false, project: input.project, experimental: false, verbose: false, noColor: true },
      output: createOutput({ stdout: out, stderr: err, json }),
      consent: createConsent({ interactive: false, yes: false, getInput: () => /** @type {any} */ ({}), prompts: err }),
      interrupts: createInterruptController({ exit: () => {}, stderr: err }),
      signal: new AbortController().signal,
      env: sandbox.env,
      cwd: input.cwd ?? workspace,
      platform: process.platform,
      version: CLI_VERSION,
    };
    try {
      const result = await run(context, { probes: createProbes(), fetchImpl: createThrowingFetch(), ...input.deps });
      return {
        exitCode: result.exitCode ?? 0,
        code: result.code,
        message: result.message ?? '',
        data: result.data ?? {},
        warnings: result.warnings ?? [],
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      };
    } catch (error) {
      const failure = /** @type {any} */ (error);
      return { exitCode: failure.exitCode ?? 7, code: failure.code, message: failure.message, data: failure.data ?? {}, warnings: [], stdout: stdout.join(''), stderr: stderr.join('') };
    }
  };

  return {
    workspace,
    home,
    env: sandbox.env,
    run: runShape,
    snapshot: async () => ({ workspace: await snapshotTree(workspace), home: await snapshotTree(home) }),
  };
}

/**
 * @param {{ workspace: Record<string, any>, home: Record<string, any> }} before
 * @param {{ workspace: Record<string, any>, home: Record<string, any> }} after
 */
function assertUnchanged(before, after) {
  assert.deepEqual(diffSnapshots(before.workspace, after.workspace), { added: [], removed: [], changed: [] });
  assert.deepEqual(diffSnapshots(before.home, after.home), { added: [], removed: [], changed: [] });
}

describe('shape: outcomes and exit codes', () => {
  it('ready: exit 0, the request alone on stdout, nothing on stderr, no model call', async (t) => {
    const harness = await createHarness(t);
    const text = 'add a null check in Assets/Game/Inventory/InventoryView.cs';
    const result = await harness.run({ text });
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, 'ready');
    assert.equal(result.stdout, `${text}\n`);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.message, '');
    assert.equal(result.data.request, text);
    assert.equal(result.data.modelCall, false);
  });

  it('--json: the envelope data of 36.6, a summary message and no human text on stdout', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run({ text: 'rename Refresh in InventoryView.cs to RefreshSlots', json: true });
    assert.equal(result.code, 'ready');
    assert.equal(result.message, 'Ready as written; no model call.');
    assert.equal(result.stdout, '');
    assert.deepEqual(Object.keys(result.data).sort(), [
      'durationMs', 'fields', 'modelCall', 'note', 'outputTokens', 'promptTokensActual', 'reason', 'request', 'rule', 'status', 'unresolved', 'verdict',
    ]);
    assert.equal(result.data.status, 'ready');
  });

  it('shaped: exit 0, the fixed form on stdout, and Keep built from the facts init wrote', async (t) => {
    const harness = await createHarness(t);
    const context = { platform: process.platform, env: harness.env, cwd: harness.workspace, version: CLI_VERSION };
    const session = await loadSession(/** @type {any} */ (context));
    const project = await resolveProject(session, { path: harness.workspace });
    await fs.mkdir(project.paths.dir, { recursive: true });
    await fs.writeFile(project.paths.facts, '# Project facts\n- UI: uGUI (2 scripts). Follow the screen you edit; ask before a new screen.\n- Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input.\n', 'utf8');
    const recording = createRecordingFetch(readModelReply('good'));
    const result = await harness.run({ text: 'the inventory is broken', json: true, deps: { fetchImpl: recording.fetch } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, 'shaped');
    assert.equal(result.message, 'Rewritten once; 1 open question.');
    assert.equal(recording.calls.length, 1);
    assert.match(result.data.fields.keep, /^scenes, prefabs, assets, meta and project files unchanged; no new packages; no VCS writes; UI: uGUI/);
    assert.equal(result.data.request.split('\n')[0], 'Goal: Stop the inventory grid from re-allocating every frame.');
  });

  it('--no-model: readiness only, the transport is never touched, the original text comes back', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run({ text: 'the inventory is broken', options: { noModel: true } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, 'passthrough');
    assert.equal(result.data.verdict, 'needs_shaping');
    assert.equal(result.data.reason, 'no_model');
    assert.equal(result.stdout, 'the inventory is broken\n');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /--no-model/);
  });

  it('every passthrough is exit 0 with the original text on stdout and the note on stderr only', async (t) => {
    const harness = await createHarness(t);
    const text = 'fix the crash and commit it';
    const result = await harness.run({ text });
    assert.equal(result.exitCode, 0);
    assert.equal(result.code, 'passthrough');
    assert.equal(result.stdout, `${text}\n`);
    assert.match(result.warnings.join('\n'), /VCS_WRITE_DENY/);
  });

  it('a model that is not there is a passthrough, not a failure', async (t) => {
    const harness = await createHarness(t);
    const refused = /** @type {typeof fetch} */ (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const result = await harness.run({ text: 'inventory grid', deps: { fetchImpl: refused } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.data.reason, 'model_unavailable');
    assert.equal(result.stdout, 'inventory grid\n');
  });

  it('prints one final newline whatever the request ends with', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run({ text: 'add a null check in InventoryView.cs\n' });
    assert.equal(result.stdout, 'add a null check in InventoryView.cs\n');
    assert.equal(result.data.request, 'add a null check in InventoryView.cs\n');
  });

  it('exit 1: an empty request, a missing request, and a directory without a component', async (t) => {
    const harness = await createHarness(t);
    assert.equal((await harness.run({ text: '  ' })).exitCode, 1);
    assert.equal((await harness.run({})).exitCode, 1);
    const empty = path.join(path.dirname(harness.workspace), 'empty');
    await writeTree(empty, { '.git': null, 'notes.md': '# notes\n' });
    const none = await harness.run({ text: 'add a null check in notes.md', cwd: empty });
    assert.equal(none.exitCode, 1);
    assert.equal(none.code, 'no_workspace_component');
  });
});

describe('shape: input forms', () => {
  it('reads @file relative to the working directory', async (t) => {
    const harness = await createHarness(t);
    const file = path.join(path.dirname(harness.workspace), 'request.txt');
    await fs.writeFile(file, 'add a null check in InventoryView.cs', 'utf8');
    const result = await harness.run({ text: '@../request.txt' });
    assert.equal(result.code, 'ready');
    assert.equal(result.data.request, 'add a null check in InventoryView.cs');
  });

  it('refuses a sensitive @file and a missing one with exit 1', async (t) => {
    const harness = await createHarness(t);
    await fs.writeFile(path.join(harness.workspace, '.env'), 'TOKEN=value\n', 'utf8');
    const sensitive = await harness.run({ text: '@.env' });
    assert.equal(sensitive.exitCode, 1);
    assert.equal(sensitive.code, 'sensitive_file_refused');
    assert.equal((await harness.run({ text: '@missing.txt' })).exitCode, 1);
  });

  it('reads - from standard input, BOM stripped, text otherwise untouched', async (t) => {
    const harness = await createHarness(t);
    const stdin = Readable.from([Buffer.from('\u{FEFF}add a null check in InventoryView.cs\r\n', 'utf8')]);
    const result = await harness.run({ text: '-', deps: { stdin } });
    assert.equal(result.code, 'ready');
    assert.equal(result.data.request, 'add a null check in InventoryView.cs\r\n');
  });

  it('uses --project for the workspace', async (t) => {
    const harness = await createHarness(t);
    const result = await harness.run({ text: 'add a null check in InventoryView.cs', cwd: path.dirname(harness.workspace), project: 'workspace' });
    assert.equal(result.code, 'ready');
  });
});

describe('shape writes nothing (S-SH4)', () => {
  for (const [label, text, deps] of /** @type {Array<[string, string, (() => Record<string, unknown>) | null]>} */ ([
    ['ready', 'add a null check in InventoryView.cs', null],
    ['ready through rule 5', 'the RefreshSlots call allocates, cache the list', null],
    ['passthrough', 'fix the crash and commit it', null],
    ['shaped, with the GPU lock taken and released', 'the inventory is broken', () => ({ fetchImpl: createRecordingFetch(readModelReply('good')).fetch })],
  ])) {
    it(label, async (t) => {
      const harness = await createHarness(t);
      const before = await harness.snapshot();
      const result = await harness.run({ text, deps: deps?.() });
      assert.equal(result.exitCode, 0);
      assertUnchanged(before, await harness.snapshot());
    });
  }

  it('--no-model', async (t) => {
    const harness = await createHarness(t);
    const before = await harness.snapshot();
    await harness.run({ text: 'the inventory is broken', options: { noModel: true } });
    assertUnchanged(before, await harness.snapshot());
  });
});
