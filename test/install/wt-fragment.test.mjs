// The Windows Terminal fragment (spec 13.5): its path, its deterministic profile GUIDs, and its encoding.
// Pure path math with an explicit platform, so every runner checks the Windows rules.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sha256Hex } from '../../src/core/hash.js';
import { getHomePaths } from '../../src/core/paths.js';
import { createManifest, createdBy, loadManifest, saveManifest, upsertEntry } from '../../src/install/manifest.js';
import {
  FRAGMENT_APP_NAME,
  PROFILE_NAMESPACE,
  buildProfile,
  readFragmentTemplate,
  refreshFragment,
  renderFragment,
  resolveFragmentPath,
  resolveLauncherPath,
  usableProjects,
  uuidV5,
} from '../../src/install/wt-fragment.js';
import { recordProject } from '../../src/project/local.js';
import { useSandbox } from '../helpers/sandbox.mjs';

const LAUNCHER = 'C:\\Users\\user\\AppData\\Roaming\\npm\\opencode-unity.cmd';
const PROJECT = { id: 'MyGame-1a2b3c4d', name: 'MyGame', path: 'C:\\Work\\MyGame' };

describe('fragment path', () => {
  it('sits in its own folder under the per-user fragment directory', () => {
    const target = resolveFragmentPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' } });
    assert.equal(target, 'C:\\Users\\user\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\opencode-unity\\profiles.json');
  });

  it('falls back to the home directory when LOCALAPPDATA is unset', () => {
    const target = resolveFragmentPath({ platform: 'win32', env: {}, homedir: 'C:\\Users\\user' });
    assert.equal(target, 'C:\\Users\\user\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\opencode-unity\\profiles.json');
  });

  it('does not exist off Windows, or without any home', () => {
    assert.equal(resolveFragmentPath({ platform: 'linux', env: { LOCALAPPDATA: '/x' } }), null);
    assert.equal(resolveFragmentPath({ platform: 'win32', env: {}, homedir: '' }), null);
  });

  it('finds the launcher shim on PATH', () => {
    const found = resolveLauncherPath({
      platform: 'win32',
      env: { PATH: 'C:\\npm', PATHEXT: '.CMD' },
    });
    // Nothing is on this fake PATH, which is the honest answer.
    assert.equal(found, null);
  });
});

describe('profile GUIDs', () => {
  it('matches the RFC 4122 version 5 test vector', () => {
    // The DNS namespace and "python.org" are the vector used by Python's uuid documentation.
    assert.equal(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is the same for the same project every time', () => {
    assert.equal(buildProfile(PROJECT, { launcherPath: LAUNCHER }).guid, buildProfile(PROJECT, { launcherPath: LAUNCHER }).guid);
  });

  it('differs between projects', () => {
    const other = { ...PROJECT, id: 'MyGame-99999999' };
    assert.notEqual(buildProfile(PROJECT, { launcherPath: LAUNCHER }).guid, buildProfile(other, { launcherPath: LAUNCHER }).guid);
  });

  it('carries the version and variant bits, in braces', () => {
    const { guid } = buildProfile(PROJECT, { launcherPath: LAUNCHER });
    assert.match(guid, /^\{[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/);
  });

  it('is derived from the fixed namespace and the app-qualified project id', () => {
    const expected = uuidV5(PROFILE_NAMESPACE, `${FRAGMENT_APP_NAME}:${PROJECT.id}`);
    assert.equal(buildProfile(PROJECT, { launcherPath: LAUNCHER }).guid, `{${expected}}`);
  });

  it('refuses a namespace that is not a UUID', () => {
    assert.throws(() => uuidV5('not-a-uuid', 'x'), /is not a UUID/);
  });

  it('agrees with an independent SHA-1 computation', () => {
    const name = 'opencode-unity:check';
    const digest = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(PROFILE_NAMESPACE.replaceAll('-', ''), 'hex'), Buffer.from(name)])).digest('hex');
    const uuid = uuidV5(PROFILE_NAMESPACE, name).replaceAll('-', '');
    assert.equal(uuid.slice(0, 12), digest.slice(0, 12));
    assert.equal(uuid[12], '5');
  });
});

describe('fragment content', () => {
  it('starts the product with the project, quoted, and opens in the project', () => {
    const profile = buildProfile(PROJECT, { launcherPath: LAUNCHER });
    assert.equal(profile.name, 'Unity local LLM - MyGame');
    assert.equal(profile.commandline, `"${LAUNCHER}" start --project "C:\\Work\\MyGame"`);
    assert.equal(profile.startingDirectory, 'C:\\Work\\MyGame');
  });

  it('renders valid JSON with one profile per project and no byte-order mark', () => {
    const text = renderFragment([PROJECT, { ...PROJECT, id: 'Other-00000000', name: 'Other' }], { launcherPath: LAUNCHER });
    assert.notEqual(text.charCodeAt(0), 0xfeff);
    assert.equal(Buffer.from(text, 'utf8')[0], 0x7b);
    const parsed = JSON.parse(text);
    assert.equal(parsed.profiles.length, 2);
    assert.ok(text.endsWith('\n'));
  });

  it('renders an empty list before any project is initialized', () => {
    assert.deepEqual(JSON.parse(renderFragment([], { launcherPath: LAUNCHER })), { profiles: [] });
  });

  it('refuses a template placeholder the renderer does not supply', () => {
    assert.throws(() => renderFragment([], { launcherPath: LAUNCHER, template: '{ "x": {{other}} }' }), /\{\{other\}\}/);
  });

  it('refuses a template that starts with a byte-order mark', () => {
    assert.throws(() => renderFragment([], { launcherPath: LAUNCHER, template: '\uFEFF{"profiles": {{profiles}}}' }), /byte-order mark/);
  });

  it('ships a template that is a single placeholder away from JSON', () => {
    assert.deepEqual(JSON.parse(readFragmentTemplate().replace('{{profiles}}', '[]')), { profiles: [] });
  });

  it('drops registry rows that could not start anything', () => {
    assert.deepEqual(usableProjects([PROJECT, { ...PROJECT, path: '' }, { ...PROJECT, name: '' }]), [PROJECT]);
  });
});

describe('fragment refresh after init (spec 13.5, 14.3 step 5)', () => {
  /**
   * The state setup leaves behind in the documented order - setup first, so the fragment it wrote lists
   * no project - with one project `init` has since recorded.
   * @param {import('node:test').TestContext} t
   */
  async function afterSetupThenInit(t) {
    const sandbox = await useSandbox(t, 'wt-refresh');
    const paths = getHomePaths(sandbox.productHome);
    const fragmentPath = path.join(sandbox.dirs.localAppData, 'Fragments', FRAGMENT_APP_NAME, 'profiles.json');
    const written = renderFragment([], { launcherPath: LAUNCHER });
    await fs.mkdir(path.dirname(fragmentPath), { recursive: true });
    await fs.writeFile(fragmentPath, written, 'utf8');
    const entry = { kind: /** @type {const} */ ('wtFragment'), path: fragmentPath, sha256: sha256Hex(written), createdBy: createdBy('setup', '0.1.0') };
    await saveManifest(paths.installManifest, upsertEntry(createManifest('0.1.0'), entry));
    await recordProject(paths.projectsIndex, { id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, factsVersion: 1 });
    const refresh = (/** @type {Partial<Parameters<typeof refreshFragment>[0]>} */ overrides = {}) =>
      refreshFragment({ env: {}, platform: 'win32', paths, io: { locateLauncher: () => LAUNCHER }, ...overrides });
    return { paths, fragmentPath, refresh };
  }

  it('adds the profile of a project initialized after setup, and records the new hash', async (t) => {
    const { paths, fragmentPath, refresh } = await afterSetupThenInit(t);
    const result = await refresh();
    assert.deepEqual(result, { updated: [fragmentPath], warnings: [] });
    const text = await fs.readFile(fragmentPath, 'utf8');
    assert.deepEqual(JSON.parse(text).profiles.map((/** @type {{ name: string }} */ profile) => profile.name), [buildProfile(PROJECT, { launcherPath: LAUNCHER }).name]);
    const { manifest } = await loadManifest(paths.installManifest);
    assert.equal(manifest?.entries.find((entry) => entry.kind === 'wtFragment')?.sha256, sha256Hex(text));
    assert.deepEqual(await refresh(), { updated: [], warnings: [] }, 'a second refresh has nothing to do');
  });

  it('leaves a fragment the user edited alone, and says how to refresh it', async (t) => {
    const { fragmentPath, refresh } = await afterSetupThenInit(t);
    await fs.writeFile(fragmentPath, '{ "profiles": [ { "name": "mine" } ] }\n', 'utf8');
    const result = await refresh();
    assert.deepEqual(result.updated, []);
    assert.match(result.warnings.join('\n'), /changed since setup wrote it[\s\S]*opencode-unity setup/);
    assert.match(await fs.readFile(fragmentPath, 'utf8'), /"mine"/);
  });

  it('does nothing off Windows, without a recorded fragment, or without a launcher it can name', async (t) => {
    const { fragmentPath, refresh } = await afterSetupThenInit(t);
    const before = await fs.readFile(fragmentPath, 'utf8');
    assert.deepEqual(await refresh({ platform: 'linux' }), { updated: [], warnings: [] });
    const noLauncher = await refresh({ io: { locateLauncher: () => null } });
    assert.deepEqual(noLauncher.updated, []);
    assert.match(noLauncher.warnings.join('\n'), /not on PATH/);
    assert.equal(await fs.readFile(fragmentPath, 'utf8'), before);

    const bare = await useSandbox(t, 'wt-refresh');
    assert.deepEqual(await refreshFragment({ env: {}, platform: 'win32', paths: getHomePaths(bare.productHome), io: { locateLauncher: () => LAUNCHER } }), { updated: [], warnings: [] });
  });
});
