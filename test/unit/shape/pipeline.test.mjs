// shapeRequest() end to end over the fixture matrix, with a stubbed transport (S-SH1, S-SH2). The
// transport throws by default, so "no model call" is an assertion about a throw.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireGpuLock } from '../../../src/core/lock.js';
import { discoverComponents } from '../../../src/project/discover.js';
import { SHAPE_DEFAULTS, shapeRequest, toShapeLogRow } from '../../../src/shape/index.js';
import { MISSING_PATH_QUESTION } from '../../../src/shape/validate.js';
import { catchAsync } from '../../helpers/catch-error.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';
import {
  createHeldLock,
  createProbes,
  createProfile,
  createRecordingFetch,
  createStatusFetch,
  createThrowingFetch,
  listRequestFixtures,
  mountShapeProject,
  readModelReply,
  readRequestFixture,
  requestTextOf,
  settingsWith,
} from './helpers.mjs';

const KEEP = Object.freeze({
  vcsKind: 'git',
  uiRule: 'UI: uGUI (2 scripts). Follow the screen you edit; ask before a new screen',
  inputRule: 'Input: Input System only (activeInputHandler 1). Never use UnityEngine.Input',
});

/**
 * @param {string} text
 * @param {{ fetch?: typeof fetch, settings?: Partial<import('../../../src/shape/verdict.js').ShapeSettings>, noModel?: boolean, probes?: any, profile?: any, mounted?: ReturnType<typeof mountShapeProject>, lockPath?: string }} [options]
 */
async function shape(text, options = {}) {
  const mounted = options.mounted ?? mountShapeProject();
  const discovery = discoverComponents(mounted.view, mounted.root);
  const result = await shapeRequest({
    text,
    settings: settingsWith(options.settings),
    noModel: options.noModel,
    project: {
      view: mounted.view,
      root: mounted.root,
      componentDirs: [...discovery.anchors, ...discovery.overlays].map((component) => component.dir),
      keep: KEEP,
    },
    profile: options.profile ?? createProfile(),
    lock: options.lockPath ? undefined : createHeldLock(),
    lockPath: options.lockPath,
    lockWaitSec: 0,
    probes: options.probes ?? createProbes(),
    fetch: options.fetch ?? createThrowingFetch(),
  });
  return { result, mounted };
}

describe('the request fixtures', () => {
  for (const name of listRequestFixtures()) {
    const fixture = readRequestFixture(name);
    it(`${name}: ${fixture.note}`, async () => {
      const text = requestTextOf(fixture);
      const reply = fixture.reply === undefined ? null : typeof fixture.reply === 'string' ? readModelReply(fixture.reply) : JSON.stringify(fixture.reply);
      const recording = reply === null ? null : createRecordingFetch(reply);
      const { result, mounted } = await shape(text, { fetch: recording?.fetch });
      assert.equal(result.status, fixture.expect.status, JSON.stringify(result));
      assert.equal(result.verdict, fixture.expect.verdict);
      assert.equal(result.reason, fixture.expect.reason);
      if (fixture.expect.rule) assert.equal(result.rule, fixture.expect.rule);
      if (result.status !== 'shaped') {
        // Byte for byte: not trimmed, not normalised, not re-encoded.
        assert.equal(result.request, text);
        assert.equal(result.modelCall, false);
        assert.equal(recording?.calls.length ?? 0, 0);
      } else {
        assert.equal(recording?.calls.length, 1);
        assert.ok(result.request.length <= 600);
        assert.ok(result.fields?.files.every((file) => mounted.view.stat(`${mounted.root}/${file}`)?.isFile), 'an invented path survived');
      }
      assert.ok(!mounted.reads.some((file) => /\.(?:unity|prefab|asset)$/.test(file)), 'a scene, prefab or asset was opened');
    });
  }
});

describe('ready: no model call and the original text', () => {
  it('returns the request byte for byte, whitespace and line endings included', async () => {
    const text = '  add a null check in InventoryView.cs\r\n\ttoo\n';
    const { result } = await shape(text);
    assert.equal(result.status, 'ready');
    assert.equal(result.request, text);
    assert.equal(result.note, null);
    assert.equal(result.modelCall, false);
  });

  it('never opens a file unless rule 5 has to', async () => {
    const { result, mounted } = await shape('add a null check in Assets/Game/Inventory/InventoryView.cs');
    assert.equal(result.status, 'ready');
    assert.deepEqual(mounted.reads, []);
  });
});

describe('shaped: one call, validated, rendered with a local Keep line', () => {
  it('renders the fixed form, with Keep from the facts and not from the model', async () => {
    const recording = createRecordingFetch(readModelReply('good'));
    const { result } = await shape('the inventory is broken', { fetch: recording.fetch });
    assert.equal(result.status, 'shaped');
    assert.equal(result.verdict, 'needs_shaping');
    assert.equal(result.modelCall, true);
    assert.equal(result.promptTokensActual, 812);
    assert.equal(result.outputTokens, 96);
    assert.equal(
      result.request,
      [
        'Goal: Stop the inventory grid from re-allocating every frame.',
        'Files: Assets/Game/Inventory/InventoryView.cs, Assets/Game/Inventory/InventoryGrid.cs',
        'Search: "RefreshSlots"',
        'Done: No per-frame allocation in the grid refresh path; Game.Runtime builds.',
        `Keep: scenes, prefabs, assets, meta and project files unchanged; no new packages; no VCS writes; ${KEEP.uiRule}; ${KEEP.inputRule}`,
        'Open: should empty slots still be rebuilt, or reused?',
      ].join('\n'),
    );
    assert.equal(result.fields?.keep.startsWith('scenes, prefabs'), true);
  });

  it('offers only paths, never file content, and names the unresolved literals', async () => {
    const recording = createRecordingFetch(JSON.stringify({ goal: 'Fix the inventory slot lookup.', files: [], search: '', done: 'Slots resolve.', open: [] }));
    const { result } = await shape('fix Assets/Game/Inventory/InventorySlots.cs', { fetch: recording.fetch });
    const user = recording.calls[0].body.messages[1].content;
    assert.ok(user.includes('- Assets/Game/Inventory/InventorySlot.cs'));
    assert.ok(user.includes('LITERALS THAT DID NOT RESOLVE: "Assets/Game/Inventory/InventorySlots.cs"'));
    assert.ok(!user.includes('readonly struct'));
    assert.deepEqual(result.unresolved, ['Assets/Game/Inventory/InventorySlots.cs']);
    assert.match(String(result.note), /^not found in this project: /);
  });

  it('removes an invented path and asks which file instead', async () => {
    const { result } = await shape('the inventory is broken', { fetch: createRecordingFetch(readModelReply('invented-path')).fetch });
    assert.equal(result.status, 'shaped');
    assert.ok(!result.request.includes('Nope.cs'));
    assert.ok(result.request.includes(`Open: ${MISSING_PATH_QUESTION}`));
  });

  it('never names a protected file and never lets an @ or a shell block through', async () => {
    const protectedResult = (await shape('the inventory is broken', { fetch: createRecordingFetch(readModelReply('protected-path')).fetch })).result;
    assert.ok(!/^Files:.*Main\.unity/m.test(protectedResult.request), protectedResult.request);
    const mention = (await shape('the inventory is broken', { fetch: createRecordingFetch(readModelReply('at-mention')).fetch })).result;
    assert.equal(mention.status, 'shaped');
    assert.ok(!mention.request.includes('@'));
    assert.ok(!mention.request.includes('!`'));
  });

  it('adds a note when four asks were kept as one', async () => {
    const fixture = readRequestFixture('multi-outcome');
    const { result } = await shape(requestTextOf(fixture), { fetch: createRecordingFetch(JSON.stringify(fixture.reply)).fetch });
    assert.equal(result.status, 'shaped');
    assert.match(String(result.note), /4 separate asks were kept as one request/);
    assert.equal(result.request.split('\n').filter((line) => line.startsWith('Goal: ')).length, 1);
  });

  it('shapes everything in mode always, even a ready request, and reads no file for rule 5', async () => {
    const recording = createRecordingFetch(JSON.stringify({ goal: 'Add a null check in the inventory view.', files: ['Assets/Game/Inventory/InventoryView.cs'], search: '', done: 'No null reference.', open: [] }));
    const { result, mounted } = await shape('add a null check in InventoryView.cs', { fetch: recording.fetch, settings: { mode: 'always' } });
    assert.equal(result.status, 'shaped');
    assert.equal(recording.calls.length, 1);
    assert.deepEqual(mounted.reads, []);
  });
});

describe('fall-through: every row passes the original text on, byte for byte', () => {
  const text = 'the inventory is broken \n';
  /** @type {Array<[string, Parameters<typeof shape>[1], string]>} */
  const rows = [
    ['too_long', { settings: { maxInputChars: 10 } }, 'too_long'],
    ['denied_intent', {}, 'denied_intent'],
    ['disabled', { settings: { mode: 'off' } }, 'disabled'],
    ['no_model', { noModel: true }, 'no_model'],
    ['guard_blocked', { probes: createProbes({ blocked: true }) }, 'guard_blocked'],
    ['model_unavailable', { fetch: createStatusFetch(404, '{"error":"model \\"x\\" not found, try pulling it first"}') }, 'model_unavailable'],
    ['budget', { profile: createProfile({ context: 400 }) }, 'budget'],
    ['invalid_output (not JSON)', { fetch: createRecordingFetch(readModelReply('not-json')).fetch }, 'invalid_output'],
    ['invalid_output (off topic)', { fetch: createRecordingFetch(readModelReply('off-topic')).fetch }, 'invalid_output'],
    ['invalid_output (over-long goal)', { fetch: createRecordingFetch(readModelReply('over-long-goal')).fetch }, 'invalid_output'],
    ['denied_intent (in the rewrite)', { fetch: createRecordingFetch(readModelReply('shell-block')).fetch }, 'denied_intent'],
  ];
  for (const [label, options, reason] of rows) {
    it(label, async () => {
      const input = label === 'denied_intent' ? 'fix the crash and commit it \n' : text;
      const { result } = await shape(input, options);
      assert.equal(result.status, 'passthrough');
      assert.equal(result.reason, reason);
      assert.equal(result.request, input);
      assert.equal(result.fields, null);
      if (reason !== 'disabled') assert.equal(typeof result.note, 'string');
      else assert.equal(result.note, null);
    });
  }

  it('lock_timeout', async (t) => {
    const sandbox = await useSandbox(t, 'shape-pipeline-lock');
    const lockPath = path.join(sandbox.root, 'state', 'gpu.lock');
    const holder = await acquireGpuLock({ lockPath, command: 'warm', timeoutSec: 60, waitSec: 0 });
    t.after(() => holder.release());
    const { result } = await shape(text, { lockPath });
    assert.deepEqual([result.status, result.reason, result.request], ['passthrough', 'lock_timeout', text]);
  });

  it('timeout', async (t) => {
    const transportHandle = setInterval(() => {}, 1000);
    t.after(() => clearInterval(transportHandle));
    const hanging = /** @type {typeof fetch} */ (
      (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    );
    const { result } = await shape(text, { fetch: hanging, settings: { timeoutSec: 1 } });
    assert.deepEqual([result.status, result.reason, result.request, result.modelCall], ['passthrough', 'timeout', text, true]);
  });

  it('an empty request is the one hard stop', async () => {
    const error = await catchAsync(() => shape('  '));
    assert.equal(error.exitCode, 1);
  });

  it('names the deny rule, and does not call the model, for a denied intent', async () => {
    const { result } = await shape('move the spawn point in Main.unity');
    assert.equal(result.rule, 'PROTECTED_EDIT');
    assert.match(String(result.note), /PROTECTED_EDIT/);
  });

  it('keeps the guard wording out of a guard block', async () => {
    const { result } = await shape(text, { probes: createProbes({ blocked: true }) });
    assert.equal(result.note, 'shaping skipped: the GPU guard did not allow a model call; the request goes on unchanged');
  });
});

describe('the session-log row (P16)', () => {
  it('holds counters and verdict ids, never text, names or paths', async () => {
    const recording = createRecordingFetch(readModelReply('good'));
    const { result } = await shape('the inventory is broken', { fetch: recording.fetch });
    const row = toShapeLogRow(result);
    assert.deepEqual(Object.keys(row).sort(), ['durationMs', 'kind', 'modelCall', 'outputTokens', 'promptTokens', 'reason', 'status', 'verdict']);
    const serialized = JSON.stringify(row);
    for (const leak of ['inventory', 'Assets/', 'RefreshSlots', 'Goal']) assert.ok(!serialized.includes(leak), leak);
    assert.equal(row.kind, 'shape');
    assert.equal(row.status, 'shaped');
  });

  it('exports the defaults the config block mirrors', () => {
    assert.equal(SHAPE_DEFAULTS.maxInputChars, 2000);
  });
});
