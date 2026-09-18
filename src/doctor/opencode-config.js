// The OpenCode configuration doctor judges, read statically (spec 8.2).
//
// Default `doctor` never starts OpenCode, so it cannot ask for the merged configuration; it reads the
// same files OpenCode would read and reports each layer separately. `--deep` adds the real merged
// answer from `opencode debug config` on top of these layers, and the checks prefer it when present.
//
// Only files are read, never written. The user's own OpenCode configuration is input to this product
// and never an output (spec 15 S11).
import fs from 'node:fs';
import path from 'node:path';
import { JsonParseError, parseJsonc } from '../core/jsonc.js';

/** Names OpenCode accepts for a configuration file, in the order it tries them (OC `config/paths.ts`). */
const CONFIG_FILE_NAMES = Object.freeze(['opencode.jsonc', 'opencode.json']);

/** Far above any real repository depth; stops a symlink loop from walking forever. */
const MAX_PARENT_DEPTH = 40;

/**
 * @typedef {object} ConfigLayer
 * @property {string} path
 * @property {'user' | 'home' | 'project' | 'project-dir' | 'profile' | 'deep'} origin
 * @property {Record<string, any> | null} value   Null when the file did not parse.
 * @property {string | null} error
 */

/**
 * @typedef {object} ConfigLayers
 * @property {ConfigLayer[]} layers               Lowest precedence first, as OpenCode merges them.
 * @property {'user' | 'profile'} target          Which setup the report is about.
 * @property {string[]} warnings
 */

/**
 * @typedef {object} ReadIo
 * @property {(target: string) => boolean} exists
 * @property {(target: string) => string} readText
 */

/**
 * @returns {ReadIo}
 */
export function createReadIo() {
  return {
    exists: (target) => fs.existsSync(target),
    readText: (target) => fs.readFileSync(target, 'utf8'),
  };
}

/**
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {string | null} input.projectPath        Absolute; null when doctor runs outside a project.
 * @param {string | null} input.profileConfigPath  The rendered opencode.jsonc, when `--profile`.
 * @param {string | null} [input.worktreeRoot]     Outermost directory OpenCode walks to; null means the
 *   filesystem root, which is what OpenCode falls back to without a VCS worktree.
 * @param {ReadIo} input.io
 * @returns {ConfigLayers}
 */
export function collectConfigLayers({ env, projectPath, profileConfigPath, worktreeRoot = null, io }) {
  /** @type {string[]} */
  const warnings = [];
  if (profileConfigPath !== null) {
    const layer = readLayer(profileConfigPath, 'profile', io);
    if (layer === null) {
      warnings.push(`the rendered profile config is missing at ${profileConfigPath}; run opencode-unity setup`);
      return { layers: [], target: 'profile', warnings };
    }
    return { layers: [layer], target: 'profile', warnings };
  }
  /** @type {ConfigLayer[]} */
  const layers = [];
  for (const candidate of listUserConfigPaths(env)) {
    const layer = readLayer(candidate, 'user', io);
    if (layer !== null) layers.push(layer);
  }
  for (const candidate of listHomeConfigPaths(env)) {
    const layer = readLayer(candidate, 'home', io);
    if (layer !== null) layers.push(layer);
  }
  if (projectPath !== null) {
    for (const candidate of listProjectConfigPaths(projectPath, worktreeRoot)) {
      const layer = readLayer(candidate, candidate.includes(`${path.sep}.opencode${path.sep}`) ? 'project-dir' : 'project', io);
      if (layer !== null) layers.push(layer);
    }
  }
  return { layers, target: 'user', warnings };
}

/**
 * `XDG_CONFIG_HOME/opencode/`, else `~/.config/opencode/` (OC `core/src/global.ts`, `config/paths.ts`).
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function listUserConfigPaths(env) {
  const explicit = nonEmpty(env.OPENCODE_CONFIG);
  if (explicit !== undefined) return [path.resolve(explicit)];
  const base = nonEmpty(env.XDG_CONFIG_HOME) ?? joinHome(env, '.config');
  if (base === null) return [];
  return CONFIG_FILE_NAMES.map((name) => path.join(base, 'opencode', name));
}

/**
 * `~/.opencode/` is read whatever XDG says (OC `config/paths.ts` L34-38), which is why the clean room
 * cannot remove it and why doctor reports it separately.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function listHomeConfigPaths(env) {
  const base = joinHome(env, '.opencode');
  return base === null ? [] : CONFIG_FILE_NAMES.map((name) => path.join(base, name));
}

/**
 * Project files from the outermost directory inward, so the innermost wins, plus each directory's
 * `.opencode/` configuration. The walk stops at the worktree root, as OpenCode's does: a file above it
 * is not loaded, and reporting it would be a finding about a file the session never sees.
 * @param {string} projectPath
 * @param {string | null} [worktreeRoot]
 * @returns {string[]}
 */
export function listProjectConfigPaths(projectPath, worktreeRoot = null) {
  /** @type {string[]} */
  const directories = [];
  const stopAt = worktreeRoot === null ? null : path.resolve(worktreeRoot);
  let current = path.resolve(projectPath);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    directories.unshift(current);
    const parent = path.dirname(current);
    if (parent === current || current === stopAt) break;
    current = parent;
  }
  return directories.flatMap((directory) => [
    ...CONFIG_FILE_NAMES.map((name) => path.join(directory, name)),
    ...CONFIG_FILE_NAMES.map((name) => path.join(directory, '.opencode', name)),
  ]);
}

/**
 * @param {string} target
 * @param {ConfigLayer['origin']} origin
 * @param {ReadIo} io
 * @returns {ConfigLayer | null}
 */
function readLayer(target, origin, io) {
  if (!io.exists(target)) return null;
  try {
    const value = parseJsonc(io.readText(target), target);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { path: target, origin, value: null, error: 'the file is not a JSON object' };
    }
    return { path: target, origin, value: /** @type {Record<string, any>} */ (value), error: null };
  } catch (cause) {
    const message = cause instanceof JsonParseError || cause instanceof Error ? cause.message : String(cause);
    return { path: target, origin, value: null, error: message };
  }
}

/**
 * @typedef {object} ModelEntry
 * @property {string} providerId
 * @property {string} modelId
 * @property {string} layerPath
 * @property {Record<string, any>} value
 */

/**
 * Every `provider.<id>.models.<id>` entry across the layers, later layers last.
 * @param {readonly ConfigLayer[]} layers
 * @returns {ModelEntry[]}
 */
export function listModelEntries(layers) {
  /** @type {ModelEntry[]} */
  const entries = [];
  for (const layer of layers) {
    const providers = asRecord(layer.value?.provider);
    for (const [providerId, provider] of Object.entries(providers)) {
      const models = asRecord(asRecord(provider).models);
      for (const [modelId, model] of Object.entries(models)) {
        entries.push({ providerId, modelId, layerPath: layer.path, value: asRecord(model) });
      }
    }
  }
  return entries;
}

/**
 * Every `mcp.<key>` entry across the layers.
 * @param {readonly ConfigLayer[]} layers
 * @returns {Array<{ key: string, layerPath: string, value: Record<string, any> }>}
 */
export function listMcpEntries(layers) {
  return layers.flatMap((layer) =>
    Object.entries(asRecord(layer.value?.mcp)).map(([key, value]) => ({ key, layerPath: layer.path, value: asRecord(value) })));
}

/**
 * The `permission` blocks, in merge order, for the permission evaluator port.
 * @param {readonly ConfigLayer[]} layers
 * @returns {Array<{ layerPath: string, permission: Record<string, any>, agent: string | null }>}
 */
export function listPermissionBlocks(layers) {
  /** @type {Array<{ layerPath: string, permission: Record<string, any>, agent: string | null }>} */
  const blocks = [];
  for (const layer of layers) {
    const root = layer.value?.permission;
    if (root !== undefined) blocks.push({ layerPath: layer.path, permission: asRecord(root), agent: null });
    for (const [name, agent] of Object.entries(asRecord(layer.value?.agent))) {
      const permission = asRecord(agent).permission;
      if (permission !== undefined) blocks.push({ layerPath: layer.path, permission: asRecord(permission), agent: name });
    }
  }
  return blocks;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} segment
 * @returns {string | null}
 */
function joinHome(env, segment) {
  const home = nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME);
  return home === undefined ? null : path.join(home, segment);
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
