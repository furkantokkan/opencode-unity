// Everything that ends up inside `<home>/profile/<cliVersion>/`, as content keyed by its path relative to
// that directory. The renderers themselves live in src/opencode and src/ollama; this module only decides
// which files a profile consists of, so setup and upgrade cannot disagree about that list.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRuntimeProfile } from '../core/profile.js';
import { buildConfigLevelPermission, renderProfileAssets } from '../opencode/render.js';

export const PLUGIN_SOURCE_URL = new URL('../../plugin/', import.meta.url);

/** Where the plugin is copied to, verbatim, inside a profile directory (spec 6.1). */
export const PLUGIN_TARGET_DIR = 'plugins';

export const RUNTIME_PROFILE_FILE = 'opencode-unity.runtime.json';
export const MODELFILE_FILE = 'Modelfile';

/**
 * @typedef {object} ProfileFilesInput
 * @property {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} profile
 * @property {import('../core/config.js').Config} config
 * @property {string} cliVersion
 * @property {boolean} [editorAgent]
 * @property {Record<string, Uint8Array>} [pluginFiles]  Injected by tests; read from the package otherwise.
 */

/**
 * @param {ProfileFilesInput} input
 * @returns {Promise<Record<string, string | Uint8Array>>}
 */
export async function renderProfileFiles({ profile, config, cliVersion, editorAgent = false, pluginFiles }) {
  const permission = buildConfigLevelPermission({ safety: config.safety });
  const assets = renderProfileAssets({
    modelTag: profile.provider.modelTag,
    sampling: profile.provider.sampling,
    permission,
    editorAgent,
    version: cliVersion,
  });
  /** @type {Record<string, string | Uint8Array>} */
  const files = { ...assets, [RUNTIME_PROFILE_FILE]: renderRuntimeProfile(profile) };
  for (const [relative, content] of Object.entries(pluginFiles ?? (await collectPluginFiles()))) {
    files[`${PLUGIN_TARGET_DIR}/${relative}`] = content;
  }
  return files;
}

/**
 * The plugin is copied byte for byte: it runs inside OpenCode's Bun runtime, so anything that rewrote it
 * on the way in would be a second source of truth for code the guard depends on.
 * @param {{ root?: string }} [options]
 * @returns {Promise<Record<string, Uint8Array>>} Keys are POSIX-separated relative paths.
 */
export async function collectPluginFiles({ root = fileURLToPath(PLUGIN_SOURCE_URL) } = {}) {
  /** @type {Record<string, Uint8Array>} */
  const files = {};
  for (const relative of await listFiles(root)) {
    files[relative] = await fs.readFile(path.join(root, ...relative.split('/')));
  }
  return files;
}

/**
 * @param {string} root
 * @returns {Promise<string[]>} Sorted, so two runs produce the same operation order.
 */
async function listFiles(root) {
  /** @type {string[]} */
  const found = [];
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    found.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return found.sort();
}
