// Builders for the shaping suites: fixture trees mounted on a virtual root (so no upward search can reach
// the machine running the tests), a runtime profile, guard probes that pass, and model transports that
// either throw - the default, so "no model call" is an assertion about a throw - or record and answer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION } from '../../../src/cli/version.js';
import { DEFAULT_CONFIG, DEFAULT_PRESET_ID } from '../../../src/core/config.js';
import { loadPreset } from '../../../src/core/presets.js';
import { buildRuntimeProfile } from '../../../src/core/profile.js';
import { SHAPE_DEFAULTS } from '../../../src/shape/verdict.js';
import { createMemoryFsView } from '../../../src/unity/fs-view.js';

export { createProbes, MODEL_TAG, NUM_CTX } from '../commands/helpers.mjs';

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export const SHAPE_FIXTURES_DIR = path.join(FIXTURES_DIR, 'shape');
export const VIRTUAL_ROOT = path.resolve(process.platform === 'win32' ? 'C:\\opencode-unity-shape' : '/opencode-unity-shape');
export const DEFAULT_PROJECT = 'inventory-game';

/**
 * @typedef {object} MountedTree
 * @property {string} root
 * @property {import('../../../src/unity/fs-view.js').FsView} view
 * @property {string[]} reads   Workspace-relative POSIX paths the view was asked to read, in order.
 */

/**
 * Every file under a fixture directory, as relative POSIX paths.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} relative */
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk('');
  return files.sort();
}

/**
 * Mounts a fixture directory in memory and records every read.
 * @param {string} sourceDir
 * @param {{ mountAt?: string, extra?: Record<string, string | null>, skip?: (relativePath: string) => boolean }} [options]
 * @returns {MountedTree}
 */
export function mountTree(sourceDir, { mountAt = path.join(VIRTUAL_ROOT, path.basename(sourceDir)), extra = {}, skip = () => false } = {}) {
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const relative of listFiles(sourceDir)) {
    if (!skip(relative)) files[relative] = fs.readFileSync(path.join(sourceDir, ...relative.split('/')), 'utf8');
  }
  return mountFiles({ ...files, ...extra }, mountAt);
}

/**
 * Mounts a tree given as `{ relativePath: content }` (`null` for an empty folder) and records every read.
 * @param {Record<string, string | null>} files
 * @param {string} mountAt
 * @returns {MountedTree}
 */
export function mountFiles(files, mountAt) {
  /** @type {Record<string, string | null>} */
  const entries = {};
  for (const [relative, value] of Object.entries(files)) entries[path.join(mountAt, ...relative.split('/'))] = value;
  const inner = createMemoryFsView(entries);
  /** @type {string[]} */
  const reads = [];
  const prefix = mountAt.replace(/\\/g, '/');
  return {
    root: mountAt,
    reads,
    view: {
      stat: (file) => inner.stat(file),
      readDir: (dir) => inner.readDir(dir),
      readText: (file, options) => {
        reads.push(file.replace(/\\/g, '/').slice(prefix.length + 1));
        return inner.readText(file, options);
      },
    },
  };
}

/**
 * @param {string} [name]
 * @returns {MountedTree}
 */
export function mountShapeProject(name = DEFAULT_PROJECT) {
  return mountTree(path.join(SHAPE_FIXTURES_DIR, 'projects', name));
}

/**
 * @param {string} name  A fixture in `test/fixtures/workspaces/`.
 * @returns {MountedTree}
 */
export function mountWorkspace(name) {
  return mountTree(path.join(FIXTURES_DIR, 'workspaces', name), { skip: (relative) => relative === 'fixture.json' });
}

/**
 * @param {string} name
 * @returns {{ note: string, text?: string, textRepeat?: { unit: string, length: number }, reply?: string | Record<string, unknown>, expect: Record<string, any> }}
 */
export function readRequestFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(SHAPE_FIXTURES_DIR, 'requests', `${name}.json`), 'utf8'));
}

/**
 * @returns {string[]}
 */
export function listRequestFixtures() {
  return fs
    .readdirSync(path.join(SHAPE_FIXTURES_DIR, 'requests'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * @param {ReturnType<typeof readRequestFixture>} fixture
 * @returns {string}
 */
export function requestTextOf(fixture) {
  if (typeof fixture.text === 'string') return fixture.text;
  const { unit, length } = /** @type {{ unit: string, length: number }} */ (fixture.textRepeat);
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/**
 * The model's raw answer, exactly as the fixture file holds it (without the final newline).
 * @param {string} name
 * @returns {string}
 */
export function readModelReply(name) {
  const dir = path.join(SHAPE_FIXTURES_DIR, 'model-replies');
  const file = fs.existsSync(path.join(dir, `${name}.json`)) ? `${name}.json` : `${name}.txt`;
  return fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r?\n$/, '');
}

/**
 * @param {Partial<import('../../../src/shape/verdict.js').ShapeSettings>} [overrides]
 * @returns {import('../../../src/shape/verdict.js').ShapeSettings}
 */
export function settingsWith(overrides = {}) {
  return { ...SHAPE_DEFAULTS, ...overrides };
}

/**
 * A runtime profile at the default preset. `home` only has to be absolute; a test that lets the guarded
 * path take the real lock passes a sandbox directory.
 * @param {{ home?: string, baseUrl?: string, context?: number }} [options]
 * @returns {import('../../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile}
 */
export function createProfile({ home = path.join(VIRTUAL_ROOT, 'home'), baseUrl = 'http://127.0.0.1:9', context } = {}) {
  const config = /** @type {any} */ ({ ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl } });
  const { profile } = buildRuntimeProfile({ config, preset: loadPreset(DEFAULT_PRESET_ID), cliVersion: CLI_VERSION, home });
  if (context === undefined) return profile;
  return { ...profile, provider: { ...profile.provider, limit: { ...profile.provider.limit, context } } };
}

/**
 * A lock handle that is already held, so the guarded path neither waits nor writes a lock file.
 * @returns {import('../../../src/core/lock.js').GpuLock}
 */
export function createHeldLock() {
  const stamp = '2026-09-18T09:30:00.000Z';
  return {
    record: { pid: process.pid, command: 'shape', startedAt: stamp, heartbeatAt: stamp, timeoutSec: 60, token: 'test-token' },
    takeover: null,
    heartbeat: () => true,
    release: () => {},
  };
}

/**
 * A transport that fails the test the moment anything tries to reach a model.
 * @returns {typeof fetch}
 */
export function createThrowingFetch() {
  return /** @type {typeof fetch} */ (async () => {
    throw new Error('the model transport was called, and this test forbids any model call');
  });
}

/**
 * A transport that answers every chat request with `content` as one native NDJSON stream, and records
 * each request body.
 * @param {string | ((body: any) => string)} content
 * @param {{ promptTokens?: number, outputTokens?: number }} [counts]
 * @returns {{ fetch: typeof fetch, calls: Array<{ url: string, body: any }> }}
 */
export function createRecordingFetch(content, { promptTokens = 812, outputTokens = 96 } = {}) {
  /** @type {Array<{ url: string, body: any }>} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const text = typeof content === 'function' ? content(body) : content;
    return new Response(renderChatStream(text, { promptTokens, outputTokens }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };
  return { fetch: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)), calls };
}

/**
 * @param {string} content
 * @param {{ promptTokens: number, outputTokens: number }} counts
 * @returns {string}
 */
export function renderChatStream(content, { promptTokens, outputTokens }) {
  const first = { model: 'test', message: { role: 'assistant', content }, done: false };
  const last = { model: 'test', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: promptTokens, eval_count: outputTokens, total_duration: 1, load_duration: 0 };
  return `${JSON.stringify(first)}\n${JSON.stringify(last)}\n`;
}

/**
 * A transport that answers with a fixed HTTP status and body.
 * @param {number} status
 * @param {string} body
 * @returns {typeof fetch}
 */
export function createStatusFetch(status, body) {
  return /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => new Response(body, { status })));
}
