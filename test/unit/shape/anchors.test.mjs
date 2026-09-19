import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CANDIDATE_LIMITS,
  GREP_LIMITS,
  buildAnchorIndex,
  buildCandidates,
  createAnchorLookup,
  getEditDistance,
  grepIndex,
  isIndexable,
  normalizeTokenPath,
  resolveAnchors,
  resolveToken,
} from '../../../src/shape/anchors.js';
import { discoverComponents } from '../../../src/project/discover.js';
import { shapeRequest } from '../../../src/shape/index.js';
import { extractTokens } from '../../../src/shape/verdict.js';
import { compareOrdinal, createMemoryFsView } from '../../../src/unity/fs-view.js';
import { listFixtureProjects, loadFixtureProject } from '../unity/fixture-projects.mjs';
import { createThrowingFetch, mountFiles, mountShapeProject, mountWorkspace, settingsWith, VIRTUAL_ROOT } from './helpers.mjs';

const NO_KEEP = Object.freeze({ vcsKind: null, uiRule: null, inputRule: null });

/**
 * @param {ReturnType<typeof mountShapeProject>} mounted
 * @param {{ caseInsensitive?: boolean, folders?: import('../../../src/shape/anchors.js').FolderAnchorSource[] }} [options]
 */
function lookupFor(mounted, options = {}) {
  const index = buildAnchorIndex(mounted.view, mounted.root);
  return { index, lookup: createAnchorLookup(index, options) };
}

/**
 * @param {string} text
 * @param {import('../../../src/shape/anchors.js').AnchorLookup} lookup
 * @param {ReturnType<typeof mountShapeProject>} mounted
 * @param {Partial<import('../../../src/shape/anchors.js').GrepOptions>} [grepOptions]
 */
function resolveText(text, lookup, mounted, grepOptions = {}) {
  return resolveAnchors(extractTokens(text), lookup, {
    grep: (literals) => grepIndex(mounted.view, mounted.root, lookup.index, literals, { timeoutMs: 2000, ...grepOptions }),
  });
}

describe('anchor index', () => {
  it('lists indexed and path-only files, sorted, and opens none of them', () => {
    const mounted = mountShapeProject();
    const { index } = lookupFor(mounted);
    assert.deepEqual(index.files, [...index.files].sort(compareOrdinal));
    for (const expected of [
      'Assets/Game/Inventory/InventoryView.cs',
      'Assets/Game/Game.Runtime.asmdef',
      'Assets/Scenes/Main.unity',
      'Assets/Prefabs/Slot.prefab',
      'Packages/manifest.json',
      'ProjectSettings/ProjectSettings.asset',
      'ProjectSettings/ProjectVersion.txt',
    ]) {
      assert.ok(index.files.includes(expected), expected);
    }
    assert.equal(index.truncated, false);
    assert.deepEqual(mounted.reads, []);
  });

  it('leaves out secret-shaped files, unindexed extensions and unsafe names', () => {
    assert.equal(isIndexable('Assets/Game/service-account.json'), false);
    assert.equal(isIndexable('Assets/Game/google-services.json'), false);
    assert.equal(isIndexable('Api/appsettings.Production.json'), false);
    assert.equal(isIndexable('Assets/Game/Bad\nName.cs'), false);
    assert.equal(isIndexable('Assets/Game/Icon.png'), false);
    assert.equal(isIndexable('../Outside.cs'), false);
    assert.equal(isIndexable('Assets/Scenes/Main.unity'), true);
    assert.equal(isIndexable('functions/src/index.ts'), true);
    assert.equal(isIndexable('db/migrations/0001_init.sql'), true);
  });

  it('walks past the closed Unity folders and skips Library, node_modules and hidden folders', () => {
    const view = createMemoryFsView({
      [path.join(VIRTUAL_ROOT, 'w', 'Assets', 'A.cs')]: 'x',
      [path.join(VIRTUAL_ROOT, 'w', 'ProjectSettings', 'ProjectVersion.txt')]: 'm_EditorVersion: 6000.3.8f1',
      [path.join(VIRTUAL_ROOT, 'w', 'Library', 'B.cs')]: 'x',
      [path.join(VIRTUAL_ROOT, 'w', 'node_modules', 'c', 'index.js')]: 'x',
      [path.join(VIRTUAL_ROOT, 'w', '.hidden', 'D.cs')]: 'x',
      [path.join(VIRTUAL_ROOT, 'w', 'Assets', 'service-account.json')]: '{}',
    });
    const index = buildAnchorIndex(view, path.join(VIRTUAL_ROOT, 'w'));
    assert.deepEqual(index.files, ['Assets/A.cs', 'ProjectSettings/ProjectVersion.txt']);
  });

  it('is restricted to the component folders when they are given', () => {
    const mounted = mountWorkspace('unity-plus-functions');
    const index = buildAnchorIndex(mounted.view, mounted.root, { componentDirs: ['functions'] });
    assert.ok(index.files.length > 0);
    assert.ok(index.files.every((file) => file.startsWith('functions/')), index.files.join(', '));
  });

  it('reports a walk that hit the entry cap', () => {
    const mounted = mountShapeProject();
    const index = buildAnchorIndex(mounted.view, mounted.root, { maxEntries: 5 });
    assert.equal(index.truncated, true);
  });
});

describe('anchor resolution, rules 1-4', () => {
  const mounted = mountShapeProject();
  const { lookup } = lookupFor(mounted, { folders: [{ name: 'Game.Gameplay', folder: 'Assets/Game' }, { name: '', folder: 'Assets/Plugins/' }] });

  it('rule 1: an exact path, in either separator, with or without ./', () => {
    for (const token of ['Assets/Game/Inventory/InventoryView.cs', 'Assets\\Game\\Inventory\\InventoryView.cs', './Assets/Game/Inventory/InventoryView.cs']) {
      assert.deepEqual(resolveToken(token, lookup), { token, rule: 1, kind: 'file', target: 'Assets/Game/Inventory/InventoryView.cs' });
    }
  });

  it('rule 1: a folder that holds indexed files', () => {
    assert.deepEqual(resolveToken('Assets/Game/Inventory/', lookup), { token: 'Assets/Game/Inventory/', rule: 1, kind: 'folder', target: 'Assets/Game/Inventory' });
  });

  it('rule 1 never falls back to the basename of a path that does not exist', () => {
    assert.equal(resolveToken('Assets/Other/InventoryView.cs', lookup), null);
    assert.equal(resolveToken('../InventoryView.cs', lookup), null);
    assert.equal(normalizeTokenPath('../x.cs'), null);
  });

  it('rule 2: a basename one file has, with or without its extension', () => {
    assert.equal(/** @type {any} */ (resolveToken('InventoryView.cs', lookup)).target, 'Assets/Game/Inventory/InventoryView.cs');
    assert.equal(/** @type {any} */ (resolveToken('InventoryView', lookup)).rule, 2);
    assert.equal(/** @type {any} */ (resolveToken('Main.unity', lookup)).target, 'Assets/Scenes/Main.unity');
  });

  it('rule 2: a basename several files have is ambiguous, and every match is a candidate', () => {
    assert.deepEqual(resolveToken('Config.cs', lookup), {
      paths: ['Assets/Game/Audio/Config.cs', 'Assets/Game/Config.cs', 'Assets/Game/Net/Config.cs'],
    });
  });

  it('rule 3: the last segment of a dotted name', () => {
    assert.deepEqual(resolveToken('SampleGame.Inventory.InventoryGrid', lookup), {
      token: 'SampleGame.Inventory.InventoryGrid',
      rule: 3,
      kind: 'file',
      target: 'Assets/Game/Inventory/InventoryGrid.cs',
    });
  });

  it('rule 4: an assembly name or a compile-map prefix resolves to a folder', () => {
    assert.deepEqual(resolveToken('Game.Gameplay', lookup), { token: 'Game.Gameplay', rule: 4, kind: 'folder', target: 'Assets/Game' });
    assert.deepEqual(resolveToken('Assets/Plugins/', lookup), { token: 'Assets/Plugins/', rule: 4, kind: 'folder', target: 'Assets/Plugins' });
  });

  it('rule 4 ignores folders that leave the workspace', () => {
    const unsafe = createAnchorLookup(lookup.index, { folders: [{ name: 'Escape', folder: '../outside' }, { name: '', folder: '/abs' }] });
    assert.equal(resolveToken('Escape', unsafe), null);
    assert.equal(unsafe.compilePrefixes.size, 0);
  });

  it('folds case only on a case-insensitive volume', () => {
    assert.equal(resolveToken('inventoryview.cs', lookup), null);
    const folded = createAnchorLookup(lookup.index, { caseInsensitive: true });
    assert.equal(/** @type {any} */ (resolveToken('inventoryview.cs', folded)).target, 'Assets/Game/Inventory/InventoryView.cs');
    assert.equal(/** @type {any} */ (resolveToken('assets/game/inventory/inventoryview.cs', folded)).rule, 1);
  });
});

describe('anchor resolution, rule 5 and the bounded grep', () => {
  it('resolves an identifier that 1-50 files contain, and never opens a scene, a prefab or an asset', () => {
    const mounted = mountShapeProject();
    const { lookup } = lookupFor(mounted);
    const resolution = resolveText('the RefreshSlots call allocates, cache the list', lookup, mounted);
    assert.deepEqual(resolution.anchors, [{ token: 'RefreshSlots', rule: 5, kind: 'literal', target: 'RefreshSlots' }]);
    assert.equal(resolution.grep.ran, true);
    assert.ok(mounted.reads.length > 0);
    assert.ok(!mounted.reads.some((file) => /\.(?:unity|prefab|asset)$/.test(file)), mounted.reads.join(', '));
  });

  it('runs only when rules 1-4 all failed', () => {
    const mounted = mountShapeProject();
    const { lookup } = lookupFor(mounted);
    const resolution = resolveText('rename RefreshSlots in InventoryView.cs', lookup, mounted);
    assert.equal(resolution.grep.ran, false);
    assert.deepEqual(mounted.reads, []);
  });

  it('does not resolve a literal with no hit or with more than fifty', () => {
    /** @type {Record<string, string>} */
    const files = { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.8f1' };
    for (let index = 0; index < GREP_LIMITS.maxHits + 1; index += 1) files[`Assets/Many/File${index}.cs`] = 'class X { void CommonCall() {} }';
    const mounted = mountFiles(files, path.join(VIRTUAL_ROOT, 'many'));
    const { lookup } = lookupFor(mounted);
    const resolution = resolveText('fix CommonCall and MissingCall', lookup, mounted);
    assert.deepEqual(resolution.anchors, []);
    assert.deepEqual(resolution.unresolved, ['CommonCall', 'MissingCall']);
  });

  it('gives up at the time limit, and a timed-out literal is not an anchor', () => {
    const mounted = mountShapeProject();
    const { lookup } = lookupFor(mounted);
    let clock = 0;
    const resolution = resolveText('fix RefreshSlots now', lookup, mounted, { now: () => (clock += 1000), timeoutMs: 1500 });
    assert.equal(resolution.grep.timedOut, true);
    assert.deepEqual(resolution.anchors, []);
  });

  it('reads at most maxFiles files and maxBytesPerFile bytes of each', () => {
    const mounted = mountShapeProject();
    const { index } = lookupFor(mounted);
    const capped = grepIndex(mounted.view, mounted.root, index, ['RefreshSlots'], { timeoutMs: 2000, maxFiles: 1 });
    assert.equal(capped.capped, true);
    assert.equal(capped.filesScanned, 1);
    const short = grepIndex(mounted.view, mounted.root, index, ['RefreshSlots'], { timeoutMs: 2000, maxBytesPerFile: 10 });
    assert.equal(short.hits.get('RefreshSlots'), 0);
  });

  it('matches an identifier as a whole word and any other literal as a substring', () => {
    const mounted = mountShapeProject();
    const { index } = lookupFor(mounted);
    const result = grepIndex(mounted.view, mounted.root, index, ['Refresh', 'RefreshSlots()', 'm_grid.Refresh'], { timeoutMs: 2000 });
    assert.equal(result.hits.get('Refresh'), 0);
    assert.equal(result.hits.get('RefreshSlots()'), 2);
    assert.equal(result.hits.get('m_grid.Refresh'), 1);
  });

  it('never opens a secret-shaped file or a lock file even when asked to search everything', () => {
    const mounted = mountFiles(
      { 'service-account.json': '{"canary":"x"}', 'package-lock.json': '{}', 'src/app.js': 'x', 'appsettings.Production.json': '{}' },
      path.join(VIRTUAL_ROOT, 'secrets'),
    );
    const index = { files: ['appsettings.Production.json', 'package-lock.json', 'service-account.json', 'src/app.js'], truncated: false, entryCount: 4 };
    grepIndex(mounted.view, mounted.root, index, ['canary'], { timeoutMs: 2000 });
    assert.deepEqual(mounted.reads, ['src/app.js']);
  });
});

describe('candidate list', () => {
  const mounted = mountShapeProject();
  const { lookup } = lookupFor(mounted);

  it('offers near matches of a missing name', () => {
    const resolution = resolveAnchors(extractTokens('fix Assets/Game/Inventory/InventorySlots.cs'), lookup);
    assert.deepEqual(resolution.unresolved, ['Assets/Game/Inventory/InventorySlots.cs']);
    assert.deepEqual(buildCandidates(lookup, resolution), ['Assets/Game/Inventory/InventorySlot.cs']);
  });

  it('offers every match of an ambiguous name', () => {
    const resolution = resolveAnchors(extractTokens('update Config.cs'), lookup);
    assert.deepEqual(buildCandidates(lookup, resolution), ['Assets/Game/Audio/Config.cs', 'Assets/Game/Config.cs', 'Assets/Game/Net/Config.cs']);
  });

  it('offers files whose name contains a plain word, at most perToken of them, sorted', () => {
    const resolution = resolveAnchors(extractTokens('the inventory is broken'), lookup);
    const candidates = buildCandidates(lookup, resolution, { perToken: 3 });
    assert.equal(candidates.length, 3);
    assert.deepEqual(candidates, [...candidates].sort(compareOrdinal));
    assert.ok(candidates.every((candidate) => /Inventory/.test(candidate)));
  });

  it('never offers a path-only or protected file', () => {
    const resolution = resolveAnchors(extractTokens('the main slot'), lookup);
    const candidates = buildCandidates(lookup, resolution, { isProtected: (file) => file.endsWith('.asmdef') });
    assert.ok(!candidates.some((candidate) => /\.(?:unity|prefab|asset|asmdef)$/.test(candidate)), candidates.join(', '));
  });

  it('holds at most 20 lines of at most 120 characters, and leaves long ones out instead of cutting them', () => {
    /** @type {Record<string, string>} */
    const files = {};
    for (let index = 0; index < 30; index += 1) files[`Assets/Slot${String(index).padStart(2, '0')}.cs`] = 'x';
    files[`Assets/${'Deep/'.repeat(30)}SlotDeep.cs`] = 'x';
    const many = mountFiles(files, path.join(VIRTUAL_ROOT, 'slots'));
    const { lookup: manyLookup } = lookupFor(many);
    const resolution = resolveAnchors(extractTokens('slot handling'), manyLookup);
    const candidates = buildCandidates(manyLookup, resolution, { perToken: 40 });
    assert.equal(candidates.length, CANDIDATE_LIMITS.maxLines);
    assert.ok(candidates.every((candidate) => candidate.length <= CANDIDATE_LIMITS.maxLineChars));
  });

  it('measures edit distance and gives up past the limit', () => {
    assert.equal(getEditDistance('inventoryslots', 'inventoryslot', 3), 1);
    assert.equal(getEditDistance('kitten', 'sitting', 3), 3);
    assert.equal(getEditDistance('abc', 'xyzuvw', 3), 4);
  });
});

describe('every fixture Unity project', () => {
  for (const name of listFixtureProjects()) {
    it(`${name}: every indexed file resolves by rule 1, and building the index opens nothing`, () => {
      const fixture = loadFixtureProject(name);
      /** @type {string[]} */
      const reads = [];
      const view = { ...fixture.view, readText: (/** @type {string} */ file, /** @type {any} */ options) => (reads.push(file), fixture.view.readText(file, options)) };
      const index = buildAnchorIndex(view, fixture.root);
      assert.ok(index.files.length > 0);
      assert.ok(!index.files.some((file) => /^(?:Library|Temp|Logs)\//.test(file)), index.files.join(', '));
      const lookup = createAnchorLookup(index);
      for (const file of index.files) assert.equal(/** @type {any} */ (resolveToken(file, lookup))?.target, file);
      assert.deepEqual(reads, []);
    });
  }
});

describe('every repository shape', () => {
  /** @type {Record<string, string>} */
  const readyRequests = {
    'backend-only-dotnet': 'add a health check route in Api/Program.cs',
    'hostile-workspace': 'rename the player speed field in Assets/Game/Player.cs',
    'monorepo-workspaces': 'add input validation to apps/api/src/index.js',
    'standalone-node-service': 'add a season column in src/db/schema.ts',
    'unity-plus-dedicated-server': 'fix the tick rate in ServerLoop.cs',
    'unity-plus-functions': 'add logging to functions/src/index.ts',
  };
  for (const [name, text] of Object.entries(readyRequests)) {
    it(`${name}: a ready verdict is reachable without a model call`, async () => {
      const mounted = mountWorkspace(name);
      const discovery = discoverComponents(mounted.view, mounted.root);
      const componentDirs = [...discovery.anchors, ...discovery.overlays].map((component) => component.dir);
      assert.ok(componentDirs.length > 0);
      const result = await shapeRequest({
        text,
        settings: settingsWith(),
        project: { view: mounted.view, root: mounted.root, componentDirs, keep: NO_KEEP },
        fetch: createThrowingFetch(),
      });
      assert.equal(result.status, 'ready', JSON.stringify(result));
      assert.equal(result.request, text);
      assert.equal(result.modelCall, false);
    });
  }
});
