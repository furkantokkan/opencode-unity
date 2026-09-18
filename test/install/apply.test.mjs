// The transactional apply (spec 14.1): staged writes, backups of anything overwritten, the three conflict
// policies, the manifest written last, and a rollback that leaves the machine as it was found.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EXIT } from '../../src/cli/exit-codes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { applyPlan, moveFile, unwindSync } from '../../src/install/apply.js';
import { createManifest, upsertEntry } from '../../src/install/manifest.js';
import { catchAsync } from '../helpers/catch-error.mjs';
import { useSandbox } from '../helpers/sandbox.mjs';
import { createFakeModels, createFakeNpm, createFakeUserEnv, listTree, readManifestFile } from './helpers.mjs';

const VERSION = '0.1.0';
const BY = `setup@${VERSION}`;
const ZERO = '0'.repeat(64);

/**
 * @param {import('node:test').TestContext} t
 */
async function createWorkspace(t) {
  const sandbox = await useSandbox(t, 'apply');
  const root = sandbox.path('work');
  const state = path.join(root, 'state');
  await fs.mkdir(state, { recursive: true });
  return {
    root,
    state,
    manifestPath: path.join(state, 'install-manifest.json'),
    /** @param {string[]} segments */
    at: (...segments) => path.join(root, ...segments),
  };
}

/**
 * @param {Awaited<ReturnType<typeof createWorkspace>>} workspace
 * @param {Partial<import('../../src/install/apply.js').ApplyIo>} [overrides]
 * @returns {import('../../src/install/apply.js').ApplyIo}
 */
function io(workspace, overrides = {}) {
  return {
    cliVersion: VERSION,
    manifestPath: workspace.manifestPath,
    manifest: createManifest(VERSION),
    stagingRoot: workspace.state,
    userEnv: createFakeUserEnv(),
    models: createFakeModels(),
    npm: createFakeNpm(),
    ...overrides,
  };
}

/**
 * @param {string} target
 * @param {string} content
 * @param {import('../../src/install/apply.js').ConflictPolicy} [onConflict]
 * @returns {import('../../src/install/apply.js').WriteFileOperation}
 */
function write(target, content, onConflict = 'backup') {
  return { op: 'writeFile', path: target, content, onConflict, entry: { kind: 'file', path: target, sha256: ZERO, createdBy: BY } };
}

describe('apply writes', () => {
  it('writes files, creates their directories and records the real hash', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('profile', '0.1.0', 'agents', 'a.md');

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'hello\n')] }], io(workspace));

    assert.equal(await fs.readFile(target, 'utf8'), 'hello\n');
    assert.deepEqual(result.steps, [{ id: 'one', status: 'applied', details: [] }]);
    const manifest = await readManifestFile(workspace.manifestPath);
    assert.deepEqual(manifest.entries, [{ kind: 'file', path: target, sha256: sha256Hex('hello\n'), createdBy: BY }]);
  });

  it('writes bytes exactly, including carriage returns', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('probe.ps1');
    const bytes = Buffer.from('line one\r\nline two\r\n', 'utf8');

    await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [{ ...write(target, ''), content: bytes }] }], io(workspace));

    assert.deepEqual(await fs.readFile(target), bytes);
  });

  it('leaves no staging directory behind', async (t) => {
    const workspace = await createWorkspace(t);

    await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(workspace.at('a.txt'), 'a')] }], io(workspace));

    assert.deepEqual(await fs.readdir(workspace.state), ['install-manifest.json']);
  });

  it('skips declined steps and reports them', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('a.txt');

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: false, operations: [write(target, 'a')] }], io(workspace));

    await assert.rejects(fs.access(target));
    assert.equal(result.steps[0].status, 'declined');
  });

  it('reports an identical file as unchanged and still records it', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('a.txt');
    await fs.writeFile(target, 'same', 'utf8');

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'same')] }], io(workspace));

    assert.equal(result.steps[0].status, 'unchanged');
    assert.deepEqual(result.backups, []);
    assert.equal(result.manifest.entries.length, 1);
  });
});

describe('apply conflict policies', () => {
  it('backup: moves a foreign file aside before replacing it', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('current.json');
    await fs.writeFile(target, 'theirs', 'utf8');

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'ours')] }], io(workspace));

    assert.equal(await fs.readFile(target, 'utf8'), 'ours');
    assert.equal(await fs.readFile(`${target}.bak-${VERSION}`, 'utf8'), 'theirs');
    assert.deepEqual(result.backups.map((backup) => backup.path), [`${target}.bak-${VERSION}`]);
  });

  it('backup: never overwrites an earlier backup', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('current.json');
    await fs.writeFile(target, 'theirs', 'utf8');
    await fs.writeFile(`${target}.bak-${VERSION}`, 'older', 'utf8');

    await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'ours')] }], io(workspace));

    assert.equal(await fs.readFile(`${target}.bak-${VERSION}`, 'utf8'), 'older');
    assert.equal(await fs.readFile(`${target}.bak-${VERSION}-2`, 'utf8'), 'theirs');
  });

  it('backup: replaces our own recorded bytes without a .bak file', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('current.json');
    await fs.writeFile(target, 'ours v1', 'utf8');
    const manifest = upsertEntry(createManifest(VERSION), { kind: 'file', path: target, sha256: sha256Hex('ours v1'), createdBy: BY });

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'ours v2')] }], io(workspace, { manifest }));

    assert.equal(await fs.readFile(target, 'utf8'), 'ours v2');
    assert.deepEqual(result.backups, []);
    assert.deepEqual(await fs.readdir(workspace.root), ['current.json', 'state']);
  });

  it('skip: leaves an existing file alone and records nothing for it', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('config.json');
    await fs.writeFile(target, 'user settings', 'utf8');

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'defaults', 'skip')] }], io(workspace));

    assert.equal(await fs.readFile(target, 'utf8'), 'user settings');
    assert.deepEqual(result.manifest.entries, []);
    assert.match(result.notes[0], /left as it is/);
  });

  it('preserve: writes .ocu-new beside a file the user edited', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('profiles.json');
    await fs.writeFile(target, 'edited by hand', 'utf8');
    const operation = { ...write(target, 'new template', 'preserve'), recordedSha256: sha256Hex('as we wrote it') };

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [operation] }], io(workspace));

    assert.equal(await fs.readFile(target, 'utf8'), 'edited by hand');
    assert.equal(await fs.readFile(`${target}.ocu-new`, 'utf8'), 'new template');
    assert.deepEqual(result.newTemplates, [`${target}.ocu-new`]);
  });

  it('preserve: replaces a file that is still exactly ours', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('profiles.json');
    await fs.writeFile(target, 'as we wrote it', 'utf8');
    const operation = { ...write(target, 'new template', 'preserve'), recordedSha256: sha256Hex('as we wrote it') };

    const result = await applyPlan([{ id: 'one', title: 'One', accepted: true, operations: [operation] }], io(workspace));

    assert.equal(await fs.readFile(target, 'utf8'), 'new template');
    assert.deepEqual(result.newTemplates, []);
  });
});

describe('apply external operations', () => {
  it('sets an environment variable and records what was there before', async (t) => {
    const workspace = await createWorkspace(t);
    const userEnv = createFakeUserEnv({ OLLAMA_KV_CACHE_TYPE: 'f16' });

    const result = await applyPlan(
      [{ id: 'env', title: 'Env', accepted: true, operations: [{ op: 'setEnv', kind: 'userEnv', name: 'OLLAMA_KV_CACHE_TYPE', value: 'q8_0' }] }],
      io(workspace, { userEnv }),
    );

    assert.equal(userEnv.values.get('OLLAMA_KV_CACHE_TYPE'), 'q8_0');
    assert.deepEqual(result.manifest.entries, [{ kind: 'userEnv', name: 'OLLAMA_KV_CACHE_TYPE', value: 'q8_0', previous: 'f16', createdBy: BY }]);
  });

  it('refuses an environment operation without an adapter', async (t) => {
    const workspace = await createWorkspace(t);
    const error = await catchAsync(() =>
      applyPlan([{ id: 'env', title: 'Env', accepted: true, operations: [{ op: 'setEnv', kind: 'userEnv', name: 'A', value: 'b' }] }], io(workspace, { userEnv: undefined })),
    );
    assert.match(error.message, /user-env adapter/);
  });

  it('records the npm install and has no rollback for it', async (t) => {
    const workspace = await createWorkspace(t);
    const npm = createFakeNpm();

    const error = await catchAsync(() =>
      applyPlan(
        [
          { id: 'npm', title: 'Npm', accepted: true, operations: [{ op: 'installNpmGlobal', name: 'opencode-ai', version: '1.18.31' }] },
          { id: 'fail', title: 'Fail', accepted: true, operations: [{ op: 'makeDir', path: workspace.at('x') }] },
        ],
        io(workspace, {
          npm,
          onOperation: (operation) => {
            if (operation.op === 'makeDir') throw new Error('boom');
          },
        }),
      ),
    );

    assert.equal(error.data.rolledBack, true);
    assert.deepEqual(npm.commands, ['install -g opencode-ai@1.18.31']);
  });

  it('refuses a model operation without an installer', async (t) => {
    const workspace = await createWorkspace(t);
    const error = await catchAsync(() =>
      applyPlan([{ id: 'm', title: 'M', accepted: true, operations: [{ op: 'pullModel', model: 'a:b', alreadyInstalled: false }] }], io(workspace, { models: undefined })),
    );
    assert.match(error.message, /model installer/);
  });

  it('refuses an operation it does not know', async (t) => {
    const workspace = await createWorkspace(t);
    const error = await catchAsync(() => applyPlan([{ id: 'x', title: 'X', accepted: true, operations: [/** @type {any} */ ({ op: 'formatDisk' })] }], io(workspace)));
    assert.match(error.message, /Unknown install operation 'formatDisk'/);
  });
});

describe('apply rollback', () => {
  it('removes every file and directory it created, including new parents', async (t) => {
    const workspace = await createWorkspace(t);
    const deep = workspace.at('profile', '0.1.0', 'plugins', 'lib', 'a.js');
    const before = await listTree(workspace.root);

    const error = await catchAsync(() =>
      applyPlan(
        [
          { id: 'dirs', title: 'Dirs', accepted: true, operations: [{ op: 'makeDir', path: workspace.at('xdg-config') }, write(deep, 'x')] },
          { id: 'boom', title: 'Boom', accepted: true, operations: [write(workspace.at('late.txt'), 'late')] },
        ],
        io(workspace, {
          onOperation: (operation) => {
            if (operation.op === 'writeFile' && operation.path.endsWith('late.txt')) throw new Error('disk full');
          },
        }),
      ),
    );

    assert.equal(error.code, 'install_failed');
    assert.equal(error.data.rolledBack, true);
    assert.deepEqual(await listTree(workspace.root), before);
  });

  it('never writes the manifest when the apply fails', async (t) => {
    const workspace = await createWorkspace(t);

    await catchAsync(() =>
      applyPlan(
        [{ id: 'one', title: 'One', accepted: true, operations: [write(workspace.at('a.txt'), 'a'), write(workspace.at('b.txt'), 'b')] }],
        io(workspace, {
          onOperation: (operation) => {
            if (operation.op === 'writeFile' && operation.path.endsWith('b.txt')) throw new Error('stop');
          },
        }),
      ),
    );

    await assert.rejects(fs.access(workspace.manifestPath));
  });

  it('puts a replaced file of ours back with its old bytes', async (t) => {
    const workspace = await createWorkspace(t);
    const target = workspace.at('current.json');
    await fs.writeFile(target, 'ours v1', 'utf8');
    const manifest = upsertEntry(createManifest(VERSION), { kind: 'file', path: target, sha256: sha256Hex('ours v1'), createdBy: BY });

    await catchAsync(() =>
      applyPlan(
        [{ id: 'one', title: 'One', accepted: true, operations: [write(target, 'ours v2'), write(workspace.at('b.txt'), 'b')] }],
        io(workspace, {
          manifest,
          onOperation: (operation) => {
            if (operation.op === 'writeFile' && operation.path.endsWith('b.txt')) throw new Error('stop');
          },
        }),
      ),
    );

    assert.equal(await fs.readFile(target, 'utf8'), 'ours v1');
  });

  it('keeps a base model it finished downloading, and records it as pulled by setup (spec 14.1, 14.4)', async (t) => {
    const workspace = await createWorkspace(t);
    const models = createFakeModels();

    const error = await catchAsync(() =>
      applyPlan(
        [
          {
            id: 'models',
            title: 'Models',
            accepted: true,
            operations: [
              { op: 'pullModel', model: 'present:1', alreadyInstalled: true },
              { op: 'pullModel', model: 'fresh:1', alreadyInstalled: false },
              { op: 'createModel', tag: 'ocu-x', modelfilePath: anyExistingPath(workspace), baseModel: 'fresh:1', alreadyInstalled: true },
              { op: 'makeDir', path: workspace.at('late') },
            ],
          },
        ],
        io(workspace, {
          models,
          onOperation: (operation) => {
            if (operation.op === 'makeDir') throw new Error('stop');
          },
        }),
      ),
    );

    assert.deepEqual(models.commands, ['pull fresh:1'], 'an unrelated later failure never deletes the download');
    assert.equal(error.data.rolledBack, true);
    assert.deepEqual(error.data.keptModels, ['fresh:1']);
    assert.match(error.message, /the downloaded fresh:1 was kept/);
    assert.doesNotMatch(error.message, /nothing was changed/);
    const manifest = JSON.parse(await fs.readFile(workspace.manifestPath, 'utf8'));
    const record = manifest.entries.find((/** @type {{ kind: string, name?: string }} */ entry) => entry.kind === 'ollamaModel' && entry.name === 'fresh:1');
    assert.equal(record?.pulledBySetup, true, 'uninstall --remove-base-model can still remove it');
    assert.equal(manifest.entries.some((/** @type {{ name?: string }} */ entry) => entry.name === 'present:1'), false, 'a model that was already there is not claimed');
  });

  it('names a kept download in the Ctrl+C note, which cannot wait for the manifest', () => {
    assert.equal(unwindSync([], [], ['fresh:1']), 'rolled back the install; kept the downloaded fresh:1 (ollama rm removes it)');
    assert.equal(unwindSync([], []), 'rolled back the install');
  });

  it('reports a rollback step that itself failed, with a different hint', async (t) => {
    const workspace = await createWorkspace(t);
    const models = createFakeModels({ failOn: 'rm ocu-x' });
    const modelfile = workspace.at('Modelfile');
    await fs.writeFile(modelfile, 'FROM x\n', 'utf8');

    const error = await catchAsync(() =>
      applyPlan(
        [
          {
            id: 'models',
            title: 'Models',
            accepted: true,
            operations: [
              { op: 'createModel', tag: 'ocu-x', modelfilePath: modelfile, baseModel: 'x' },
              { op: 'makeDir', path: workspace.at('late') },
            ],
          },
        ],
        io(workspace, {
          models,
          onOperation: (operation) => {
            if (operation.op === 'makeDir') throw new Error('stop');
          },
        }),
      ),
    );

    assert.equal(error.data.rolledBack, false);
    assert.deepEqual(error.data.rollbackProblems, ['remove ocu-x: remove failed']);
    assert.match(error.hint, /by hand/);
  });

  it('stops and rolls back when it is interrupted', async (t) => {
    const workspace = await createWorkspace(t);
    const controller = new AbortController();

    const error = await catchAsync(() =>
      applyPlan(
        [{ id: 'one', title: 'One', accepted: true, operations: [write(workspace.at('a.txt'), 'a'), write(workspace.at('b.txt'), 'b')] }],
        io(workspace, {
          signal: controller.signal,
          onOperation: (operation) => {
            if (operation.op === 'writeFile' && operation.path.endsWith('a.txt')) controller.abort();
          },
        }),
      ),
    );

    assert.equal(error.exitCode, EXIT.INTERRUPTED);
    await assert.rejects(fs.access(workspace.at('a.txt')));
    await assert.rejects(fs.access(workspace.manifestPath));
  });
});

describe('apply on Ctrl+C', () => {
  it('registers a synchronous rollback that restores every file before the process exits', async (t) => {
    const workspace = await createWorkspace(t);
    const replaced = workspace.at('current.json');
    await fs.writeFile(replaced, 'theirs', 'utf8');
    const before = await listTree(workspace.root);
    /** @type {(() => string | void) | null} */
    let cleanup = null;
    /** @type {string | void} */
    let note;
    /** @type {string[]} */
    let treeAtExit = [];
    const modelfile = workspace.at('Modelfile');
    await fs.writeFile(modelfile, 'FROM x\n', 'utf8');

    await catchAsync(() =>
      applyPlan(
        [
          {
            id: 'all',
            title: 'All',
            accepted: true,
            operations: [
              write(replaced, 'ours'),
              write(workspace.at('profile', '0.1.0', 'agents', 'a.md'), 'a'),
              { op: 'createModel', tag: 'ocu-x', modelfilePath: modelfile, baseModel: 'x' },
              { op: 'makeDir', path: workspace.at('late') },
            ],
          },
        ],
        io(workspace, {
          addCleanup: (registered) => {
            cleanup = registered;
            return () => {
              cleanup = null;
            };
          },
          onOperation: async (operation) => {
            if (operation.op !== 'makeDir') return;
            // What the interrupt controller does: run the cleanup synchronously, then the process exits.
            note = /** @type {() => string | void} */ (cleanup)();
            treeAtExit = await listTree(workspace.root);
            throw new Error('the process has exited');
          },
        }),
      ),
    );

    assert.deepEqual(treeAtExit, [...before, 'Modelfile'].sort());
    assert.equal(await fs.readFile(replaced, 'utf8'), 'theirs');
    assert.match(String(note), /still to do by hand: remove ocu-x/);
    assert.equal(cleanup, null, 'the registration is withdrawn once apply has finished');
  });

  it('says the whole install was rolled back when only files had changed', async (t) => {
    const workspace = await createWorkspace(t);
    /** @type {(() => string | void) | null} */
    let cleanup = null;
    /** @type {string | void} */
    let note;

    await catchAsync(() =>
      applyPlan(
        [{ id: 'one', title: 'One', accepted: true, operations: [write(workspace.at('a.txt'), 'a'), write(workspace.at('b.txt'), 'b')] }],
        io(workspace, {
          addCleanup: (registered) => {
            cleanup = registered;
            return () => {};
          },
          onOperation: (operation) => {
            if (operation.op === 'writeFile' && operation.path.endsWith('b.txt')) {
              note = /** @type {() => string | void} */ (cleanup)();
              throw new Error('exited');
            }
          },
        }),
      ),
    );

    assert.equal(note, 'rolled back the install');
    await assert.rejects(fs.access(workspace.at('a.txt')));
  });

  it('keeps going when one synchronous undo fails, and names it', () => {
    const note = unwindSync(
      [
        { label: 'first', undo: async () => {}, undoSync: () => {} },
        {
          label: 'second',
          undo: async () => {},
          undoSync: () => {
            throw new Error('busy');
          },
        },
      ],
      [],
    );
    assert.equal(note, 'rolled back the files; still to do by hand: second (busy)');
  });
});

describe('moveFile', () => {
  it('renames within one volume', async (t) => {
    const workspace = await createWorkspace(t);
    await fs.writeFile(workspace.at('from.txt'), 'x', 'utf8');

    await moveFile(workspace.at('from.txt'), workspace.at('to.txt'));

    assert.equal(await fs.readFile(workspace.at('to.txt'), 'utf8'), 'x');
    await assert.rejects(fs.access(workspace.at('from.txt')));
  });
});

/**
 * A path that exists, for a create operation that is marked already installed and never reads it.
 * @param {{ state: string }} workspace
 * @returns {string}
 */
function anyExistingPath(workspace) {
  return workspace.state;
}
