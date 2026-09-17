// Loads the fixture Unity projects in test/fixtures/unity-projects/.
//
// Markers that a repository cannot hold (a nested `.git`, a `.plastic` or `.svn` folder, a `.p4config`, an
// `.opencode` directory, a `Library/` tree) are listed in each fixture's `fixture.json` and created here, at
// test time. Fixtures are mounted under a virtual root, so an upward VCS or AGENTS.md search inside a test
// can never reach the machine the tests run on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';

export const UNITY_FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/unity-projects/', import.meta.url));
export const VIRTUAL_ROOT = path.resolve(process.platform === 'win32' ? 'C:\\opencode-unity-fixtures' : '/opencode-unity-fixtures');
export const FIXTURE_MANIFEST = 'fixture.json';

/**
 * @returns {string[]} Fixture names, sorted.
 */
export function listFixtureProjects() {
  return fs
    .readdirSync(UNITY_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} name
 * @returns {{ description: string, createAtTestTime: Array<{ path: string, type: 'dir' | 'file', content?: string }> }}
 */
export function readFixtureManifest(name) {
  const file = path.join(UNITY_FIXTURES_DIR, name, FIXTURE_MANIFEST);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} name
 * @param {{ mountAt?: string, extra?: Record<string, string | null> }} [options]  `extra` adds files outside the project.
 * @returns {{ name: string, root: string, view: import('../../../src/unity/fs-view.js').FsView, manifest: ReturnType<typeof readFixtureManifest> }}
 */
export function loadFixtureProject(name, { mountAt, extra = {} } = {}) {
  const root = mountAt ?? path.join(VIRTUAL_ROOT, name);
  const manifest = readFixtureManifest(name);
  /** @type {Record<string, string | null>} */
  const entries = {};
  for (const relativePath of listFixtureFiles(name)) {
    entries[path.join(root, relativePath)] = fs.readFileSync(path.join(UNITY_FIXTURES_DIR, name, relativePath), 'utf8');
  }
  for (const entry of manifest.createAtTestTime) {
    entries[path.join(root, entry.path)] = entry.type === 'dir' ? null : (entry.content ?? '');
  }
  return { name, root, view: createMemoryFsView({ ...entries, ...extra }), manifest };
}

/**
 * Writes a fixture to a real directory, for the one test that runs the scanner on the node filesystem.
 * @param {string} name
 * @param {string} destination
 * @returns {string} The project root.
 */
export function materializeFixtureProject(name, destination) {
  const manifest = readFixtureManifest(name);
  for (const relativePath of listFixtureFiles(name)) {
    const target = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(UNITY_FIXTURES_DIR, name, relativePath), target);
  }
  for (const entry of manifest.createAtTestTime) {
    const target = path.join(destination, entry.path);
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content ?? '');
  }
  return destination;
}

/**
 * @param {string} name
 * @returns {string[]} Committed files, relative with `/`, without the manifest.
 */
export function listFixtureFiles(name) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory @param {string} prefix */
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relativePath);
      else if (relativePath !== FIXTURE_MANIFEST) files.push(relativePath);
    }
  };
  walk(path.join(UNITY_FIXTURES_DIR, name), '');
  return files;
}
