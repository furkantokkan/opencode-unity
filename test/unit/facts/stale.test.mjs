import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  checkFactsFreshness,
  collectStalenessInputs,
  computeInputsHash,
  FACTS_GENERATOR_VERSION,
  getInputsHash,
} from '../../../src/facts/stale.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';
import fs from 'node:fs';
import { listFixtureFiles, loadFixtureProject, readFixtureManifest, UNITY_FIXTURES_DIR, VIRTUAL_ROOT } from '../unity/fixture-projects.mjs';

const FIXTURE = 'u6-urp-ugui-git';

/**
 * Rebuilds the fixture view so single files can be changed between hashes.
 * @param {Record<string, string | null>} changes  Keys are project-relative paths; null removes the entry.
 * @param {Record<string, string | undefined>} [env]
 */
function hashWith(changes = {}, env = {}) {
  const root = path.join(VIRTUAL_ROOT, FIXTURE);
  /** @type {Record<string, string | null>} */
  const entries = {};
  for (const relativePath of listFixtureFiles(FIXTURE)) {
    entries[path.join(root, relativePath)] = fs.readFileSync(path.join(UNITY_FIXTURES_DIR, FIXTURE, relativePath), 'utf8');
  }
  for (const marker of readFixtureManifest(FIXTURE).createAtTestTime) {
    entries[path.join(root, marker.path)] = marker.type === 'dir' ? null : (marker.content ?? '');
  }
  for (const [relativePath, value] of Object.entries(changes)) {
    if (value === null) delete entries[path.join(root, relativePath)];
    else entries[path.join(root, relativePath)] = value;
  }
  return { root, hash: getInputsHash(createMemoryFsView(entries), root, { env }) };
}

test('the hash is stable for the same project state', () => {
  const { root, view } = loadFixtureProject(FIXTURE);
  assert.equal(getInputsHash(view, root, { env: {} }), getInputsHash(view, root, { env: {} }));
  assert.match(getInputsHash(view, root, { env: {} }), /^[0-9a-f]{64}$/);
});

test('every documented input changes the hash', () => {
  const base = hashWith().hash;
  assert.notEqual(hashWith({ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.3.9f1\n' }).hash, base);
  assert.notEqual(hashWith({ 'Packages/manifest.json': '{ "dependencies": {} }' }).hash, base);
  assert.notEqual(hashWith({ 'Packages/packages-lock.json': '{ "dependencies": {} }' }).hash, base);
  assert.notEqual(hashWith({ 'Assets/Game/Game.Runtime.asmdef': '{ "name": "Game.Runtime2" }' }).hash, base);
  assert.notEqual(hashWith({ 'Assets/Game/New.asmdef': '{ "name": "New" }' }).hash, base);
  assert.notEqual(hashWith({ 'Assets/Extra/Extra.asmref': '{ "reference": "Game.Runtime" }' }).hash, base);
  assert.notEqual(hashWith({ '.git': null }).hash, base, 'the VCS marker is part of the hash');
  assert.notEqual(hashWith({ 'Game.Runtime.csproj': null }).hash, base);
  assert.notEqual(hashWith({ 'ProjectSettings/ProjectSettings.asset': 'PlayerSettings:\n  activeInputHandler: 2\n' }).hash, base);
  // With the .git marker removed, P4CONFIG alone switches the detected VCS to Perforce.
  assert.notEqual(hashWith({ '.git': null }, { P4CONFIG: '.p4config' }).hash, hashWith({ '.git': null }).hash);
});

test('a source file that is not an input does not change the hash', () => {
  const base = hashWith().hash;
  assert.equal(hashWith({ 'Assets/Game/Player.cs': 'class Player { }' }).hash, base);
  assert.equal(hashWith({ 'Assets/Game/Brand.new.cs': 'class BrandNew { }' }).hash, base);
});

test('a .csproj modification time is an input', () => {
  const { root, view } = loadFixtureProject(FIXTURE);
  const inputs = collectStalenessInputs(view, root, { env: {} });
  const csprojEntry = inputs.find(([key]) => key.startsWith('csproj/'));
  assert.ok(csprojEntry);
  const touched = inputs.map((input) => (input === csprojEntry ? [input[0], '1700000000000'] : input));
  assert.notEqual(computeInputsHash(touched), computeInputsHash(inputs));
});

test('the generator version is part of the hash', () => {
  const { root, view } = loadFixtureProject(FIXTURE);
  assert.notEqual(
    getInputsHash(view, root, { env: {}, generatorVersion: FACTS_GENERATOR_VERSION + 1 }),
    getInputsHash(view, root, { env: {} }),
  );
  assert.equal(collectStalenessInputs(view, root, { env: {} })[0][0], 'generator');
});

test('missing files hash as absent instead of throwing', () => {
  const root = path.join(VIRTUAL_ROOT, 'empty');
  const view = createMemoryFsView({ [path.join(root, 'ProjectSettings/ProjectVersion.txt')]: 'm_EditorVersion: 6000.3.8f1\n' });
  const inputs = collectStalenessInputs(view, root, { env: {} });
  assert.equal(inputs.find(([key]) => key === 'Packages/manifest.json')?.[1], 'absent');
  assert.match(computeInputsHash(inputs), /^[0-9a-f]{64}$/);
});

test('freshness compares the stored hash and generator version', () => {
  const hash = 'a'.repeat(64);
  const stored = { inputsHash: hash, generator: { factsVersion: FACTS_GENERATOR_VERSION } };
  assert.deepEqual(checkFactsFreshness(stored, hash), { stale: false, reason: null });
  assert.deepEqual(checkFactsFreshness(stored, 'b'.repeat(64)), { stale: true, reason: 'inputs' });
  assert.deepEqual(checkFactsFreshness({ inputsHash: hash, generator: { factsVersion: 0 } }, hash), { stale: true, reason: 'generator' });
  assert.deepEqual(checkFactsFreshness(null, hash), { stale: true, reason: 'missing' });
  assert.deepEqual(checkFactsFreshness({}, hash), { stale: true, reason: 'missing' });
});
