// Backups of anything the installer overwrites, and the `.ocu-new` sibling (spec 14.3).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { chooseBackupPath, createBackup, listSideFiles, newTemplatePath, pathExists, restoreBackup, restoreBackupSync } from '../../src/install/backup.js';
import { useSandbox } from '../helpers/sandbox.mjs';

describe('backups', () => {
  it('names a backup after the version that made it, and counts up on a collision', async () => {
    const taken = new Set(['/a/config.json.bak-0.1.0', '/a/config.json.bak-0.1.0-2']);
    assert.equal(await chooseBackupPath('/a/config.json', '0.1.0', async (candidate) => taken.has(candidate)), '/a/config.json.bak-0.1.0-3');
    assert.equal(await chooseBackupPath('/a/config.json', '0.2.0', async (candidate) => taken.has(candidate)), '/a/config.json.bak-0.2.0');
  });

  it('gives up rather than overwrite after too many backups', async () => {
    await assert.rejects(chooseBackupPath('/a/x', '0.1.0', async () => true), /Too many backups/);
  });

  it('moves a file aside and puts it back', async (t) => {
    const sandbox = await useSandbox(t, 'backup');
    const target = sandbox.path('config.json');
    await fs.writeFile(target, 'mine', 'utf8');

    const backup = await createBackup(target, { cliVersion: '0.1.0' });
    assert.equal(backup?.path, `${target}.bak-0.1.0`);
    assert.equal(await pathExists(target), false);

    await fs.writeFile(target, 'replacement', 'utf8');
    await restoreBackup(/** @type {import('../../src/install/backup.js').Backup} */ (backup));
    assert.equal(await fs.readFile(target, 'utf8'), 'mine');
    assert.equal(await pathExists(`${target}.bak-0.1.0`), false);
  });

  it('puts a backup back synchronously for the Ctrl+C path', async (t) => {
    const sandbox = await useSandbox(t, 'backup');
    const target = sandbox.path('nested', 'current.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'mine', 'utf8');
    const backup = /** @type {import('../../src/install/backup.js').Backup} */ (await createBackup(target, { cliVersion: '0.1.0' }));
    await fs.writeFile(target, 'replacement', 'utf8');

    restoreBackupSync(backup);

    assert.equal(await fs.readFile(target, 'utf8'), 'mine');
    assert.equal(await pathExists(backup.path), false);
  });

  it('has nothing to back up when there is no file', async (t) => {
    const sandbox = await useSandbox(t, 'backup');
    assert.equal(await createBackup(sandbox.path('absent.json'), { cliVersion: '0.1.0' }), null);
  });

  it('lists the backups and the .ocu-new beside a file, and nothing else', async (t) => {
    const sandbox = await useSandbox(t, 'backup');
    const target = sandbox.path('profiles.json');
    for (const name of ['profiles.json', 'profiles.json.bak-0.1.0', 'profiles.json.ocu-new', 'profiles.json.tmp', 'other.json.bak-0.1.0']) {
      await fs.writeFile(sandbox.path(name), 'x', 'utf8');
    }
    assert.deepEqual((await listSideFiles(target)).map((file) => path.basename(file)), ['profiles.json.bak-0.1.0', 'profiles.json.ocu-new']);
    assert.deepEqual(await listSideFiles(sandbox.path('missing', 'x.json')), []);
  });

  it('spells the new-template sibling', () => {
    assert.equal(newTemplatePath('/p/agents/unity-code.md'), '/p/agents/unity-code.md.ocu-new');
  });

  it('reports a path error other than a missing file', async () => {
    // Built from its code point: a NUL written into the source would take this file out of the text scans.
    const target = `${String.fromCharCode(0)}bad`;
    await assert.rejects(pathExists(target));
  });
});
