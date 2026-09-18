import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { catchAsync } from '../../helpers/catch-error.mjs';
import { useSandbox } from '../../helpers/sandbox.mjs';
import {
  buildLocalState,
  LOCAL_STATE_VERSION,
  readLocalState,
  readProjectsIndex,
  recordProject,
  upsertProjectEntry,
  writeLocalState,
  writeProjectsIndex,
} from '../../../src/project/local.js';
import { readProjectSettings } from '../../../src/project/session.js';
import { DEFAULT_PROJECT_SETTINGS } from '../../../src/core/config.js';

/** @returns {import('../../../src/unity/scan.js').ScanResult} */
const scan = () => /** @type {any} */ ({
  local: {
    projectPath: path.join('C:', 'work', 'SampleGame'),
    expectedInstanceId: 'abc123',
    dataPath: path.join('C:', 'data', 'abc123'),
    hubUrl: 'http://127.0.0.1:8080/mcp',
    hubUrlSource: 'package-default',
    hubConfigPath: null,
    hubLoopback: true,
    editorWindowTitlePrefix: 'SampleGame - ',
  },
});

describe('project/local: local.json', () => {
  it('writes the flat hubUrl spelling and every machine-local field', async (t) => {
    const sandbox = await useSandbox(t, 'local-json');
    const file = path.join(sandbox.root, 'projects', 'sample-1a2b3c4d', 'local.json');
    const state = buildLocalState(scan());
    await writeLocalState(file, state);

    const written = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(written.schemaVersion, LOCAL_STATE_VERSION);
    assert.equal(written.hubUrl, 'http://127.0.0.1:8080/mcp');
    assert.equal(written.mcpForUnity, undefined);
    assert.equal(written.editorWindowTitlePrefix, 'SampleGame - ');
    assert.deepEqual(await readLocalState(file), state);
  });

  it('reads back a file written with the nested spelling', async (t) => {
    const sandbox = await useSandbox(t, 'local-nested');
    const file = path.join(sandbox.root, 'local.json');
    await fs.writeFile(file, JSON.stringify({ mcpForUnity: { hubUrl: 'http://127.0.0.1:8081/mcp' } }), 'utf8');
    const state = /** @type {import('../../../src/project/local.js').LocalState} */ (await readLocalState(file));
    assert.equal(state.hubUrl, 'http://127.0.0.1:8081/mcp');
    assert.equal(state.hubUrlSource, 'package-default');
    assert.equal(state.projectPath, '');
  });

  it('reads a missing file as null and refuses a damaged one', async (t) => {
    const sandbox = await useSandbox(t, 'local-missing');
    assert.equal(await readLocalState(path.join(sandbox.root, 'nope.json')), null);

    const broken = path.join(sandbox.root, 'broken.json');
    await fs.writeFile(broken, '{ not json', 'utf8');
    assert.match((await catchAsync(() => readLocalState(broken))).message, /broken\.json/);

    const array = path.join(sandbox.root, 'array.json');
    await fs.writeFile(array, '[]', 'utf8');
    assert.match((await catchAsync(() => readLocalState(array))).message, /does not hold a JSON object/);
  });

  it('lets a read error other than "missing" surface', async () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const failure = await catchAsync(() => readLocalState('x', { readFile: async () => { throw error; } }));
    assert.equal(failure, error);
  });
});

describe('project/local: projects/index.json', () => {
  it('adds, replaces and sorts entries, keeping fields the caller left out', async (t) => {
    const sandbox = await useSandbox(t, 'index');
    const file = path.join(sandbox.root, 'projects', 'index.json');

    let index = upsertProjectEntry(await readProjectsIndex(file), { id: 'zeta-00000002', name: 'Zeta', path: '/z', factsVersion: 1 });
    index = upsertProjectEntry(index, { id: 'alpha-00000001', name: 'Alpha', path: '/a', factsVersion: 1 });
    await writeProjectsIndex(file, index);
    assert.deepEqual((await readProjectsIndex(file)).projects.map((entry) => entry.id), ['alpha-00000001', 'zeta-00000002']);

    await recordProject(file, { id: 'alpha-00000001', lastStart: '2026-09-18T09:30:00.000Z' });
    const reread = await readProjectsIndex(file);
    const alpha = /** @type {import('../../../src/project/local.js').ProjectIndexEntry} */ (reread.projects.find((entry) => entry.id === 'alpha-00000001'));
    assert.equal(alpha.lastStart, '2026-09-18T09:30:00.000Z');
    assert.equal(alpha.name, 'Alpha');
    assert.equal(alpha.factsVersion, 1);
  });

  it('defaults an entry the caller only names', () => {
    const index = upsertProjectEntry({ schemaVersion: 1, projects: [] }, { id: 'p-00000001' });
    assert.deepEqual(index.projects, [{ id: 'p-00000001', name: 'p-00000001', path: '', lastStart: null, factsVersion: 0 }]);
    assert.throws(() => upsertProjectEntry({ schemaVersion: 1, projects: [] }, /** @type {any} */ ({})), /needs a project id/);
  });

  it('reads a missing, damaged or wrongly shaped registry as empty', async (t) => {
    const sandbox = await useSandbox(t, 'index-bad');
    const missing = path.join(sandbox.root, 'none.json');
    assert.deepEqual(await readProjectsIndex(missing), { schemaVersion: 1, projects: [] });

    const damaged = path.join(sandbox.root, 'bad.json');
    await fs.writeFile(damaged, '{oops', 'utf8');
    assert.deepEqual((await readProjectsIndex(damaged)).projects, []);

    const wrong = path.join(sandbox.root, 'wrong.json');
    await fs.writeFile(wrong, JSON.stringify({ projects: [{ name: 'no id' }, 'text', { id: 'ok-00000001' }] }), 'utf8');
    assert.deepEqual((await readProjectsIndex(wrong)).projects.map((entry) => entry.id), ['ok-00000001']);
  });

  it('lets a read error other than "missing" surface', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.equal(await catchAsync(() => readProjectsIndex('x', { readFile: async () => { throw error; } })), error);
  });
});

describe('project/session: project settings', () => {
  it('returns the defaults for a project config.json never mentioned', () => {
    assert.deepEqual(readProjectSettings(/** @type {any} */ ({ projects: {} }), 'p-00000001'), DEFAULT_PROJECT_SETTINGS);
    assert.deepEqual(readProjectSettings(/** @type {any} */ ({}), 'p-00000001'), DEFAULT_PROJECT_SETTINGS);
  });

  it('fills the keys a partial project entry leaves out', () => {
    const settings = readProjectSettings(/** @type {any} */ ({ projects: { 'p-00000001': { editor: { enabled: true } } } }), 'p-00000001');
    assert.deepEqual(settings.editor, { enabled: true, trust: false, allowPlayMode: false });
    assert.equal(settings.bashMode, null);
  });
});
