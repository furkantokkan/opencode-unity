// `upgrade` (spec 14.3). The package is updated by npm; this command migrates what the package left
// behind: the config file, the profile directory, the pointer, and the files in other people's homes.
//
// The rule that shapes all of it is item 4: a generated file whose hash still matches the manifest is
// ours to replace, and one whose hash does not is the user's. Theirs is carried over or left alone, and
// the new template lands beside it as `<file>.ocu-new` for them to merge.
import fs from 'node:fs/promises';
import { sha256File } from '../core/hash.js';
import { stringifyJson } from '../core/jsonc.js';
import { getPathApi } from '../core/paths.js';
import { newTemplatePath, pathExists } from './backup.js';
import { createdBy, entriesOfKind } from './manifest.js';

/** A 64-character placeholder; apply replaces it with the digest of what it actually wrote. */
const PLACEHOLDER_SHA = '0'.repeat(64);

/**
 * @typedef {object} UpgradeFileDecision
 * @property {string} relative
 * @property {'replace'|'carry-over'|'new'} action
 * - replace:    the previous file was still ours, so the new template is written.
 * - carry-over: the previous file was edited; it moves to the new profile and the template goes beside it.
 * - new:        the previous profile had no such file.
 */

/**
 * @typedef {object} ProfileMigration
 * @property {import('./apply.js').Operation[]} operations
 * @property {UpgradeFileDecision[]} decisions
 * @property {string[]} notices
 */

/**
 * Plans the new profile directory from the previous one (spec 14.3 item 4).
 * @param {object} input
 * @param {string} input.previousDir
 * @param {string} input.newDir
 * @param {Record<string, string | Uint8Array>} input.assets   Relative path -> new content.
 * @param {import('./manifest.js').Manifest} input.manifest
 * @param {string} input.cliVersion
 * @param {NodeJS.Platform} [input.platform]
 * @returns {Promise<ProfileMigration>}
 */
export async function planProfileMigration({ previousDir, newDir, assets, manifest, cliVersion, platform = process.platform }) {
  const api = getPathApi(platform);
  const by = createdBy('upgrade', cliVersion);
  const recorded = new Map(entriesOfKind(manifest, 'file').map((entry) => [entry.path, entry.sha256]));
  /** @type {ProfileMigration} */
  const migration = { operations: [{ op: 'makeDir', path: newDir, entry: { kind: 'dir', path: newDir, createdBy: by } }], decisions: [], notices: [] };

  for (const [relative, content] of Object.entries(assets)) {
    const segments = relative.split('/');
    const previousPath = api.join(previousDir, ...segments);
    const newPath = api.join(newDir, ...segments);
    const action = await classifyFile(previousPath, recorded.get(previousPath));
    migration.decisions.push({ relative, action });
    if (action === 'carry-over') {
      migration.operations.push({
        op: 'writeFile',
        path: newPath,
        content: await fs.readFile(previousPath),
        onConflict: 'backup',
        entry: { kind: 'file', path: newPath, sha256: PLACEHOLDER_SHA, createdBy: by },
      });
      const sidePath = newTemplatePath(newPath);
      migration.operations.push({
        op: 'writeFile',
        path: sidePath,
        content,
        onConflict: 'backup',
        entry: { kind: 'file', path: sidePath, sha256: PLACEHOLDER_SHA, createdBy: by },
      });
      migration.notices.push(`${relative} was edited, so your version was carried over and the new one is beside it as ${api.basename(sidePath)}`);
      continue;
    }
    migration.operations.push({
      op: 'writeFile',
      path: newPath,
      content,
      onConflict: 'backup',
      entry: { kind: 'file', path: newPath, sha256: PLACEHOLDER_SHA, createdBy: by },
    });
  }
  return migration;
}

/**
 * @param {string} previousPath
 * @param {string | undefined} recordedDigest
 * @returns {Promise<UpgradeFileDecision['action']>}
 */
async function classifyFile(previousPath, recordedDigest) {
  if (!(await pathExists(previousPath))) return 'new';
  if (recordedDigest === undefined) return 'carry-over';
  return (await sha256File(previousPath)) === recordedDigest ? 'replace' : 'carry-over';
}

/**
 * Item 5: a fragment or a skill copy is re-rendered only while it is still byte-for-byte ours. An edited
 * one is left alone and the new version goes beside it, so nobody's hand-tuned profile disappears in an
 * upgrade they ran for an unrelated reason.
 * @param {object} input
 * @param {import('./manifest.js').Manifest} input.manifest
 * @param {Record<string, string>} input.rendered   Recorded path -> new content, for the kinds we can render.
 * @param {string} input.cliVersion
 * @returns {Promise<{ operations: import('./apply.js').Operation[], notices: string[] }>}
 */
export async function planExternalFiles({ manifest, rendered, cliVersion }) {
  const by = createdBy('upgrade', cliVersion);
  /** @type {import('./apply.js').Operation[]} */
  const operations = [];
  /** @type {string[]} */
  const notices = [];
  for (const kind of /** @type {const} */ (['wtFragment', 'skillCopy'])) {
    for (const entry of entriesOfKind(manifest, kind)) {
      const target = /** @type {string} */ (entry.path);
      const content = rendered[target];
      if (content === undefined) {
        notices.push(`${target} is not re-rendered by this command; run 'opencode-unity host update' for it.`);
        continue;
      }
      if (!(await pathExists(target))) {
        operations.push({ op: 'writeFile', path: target, content, onConflict: 'backup', entry: { ...entry, sha256: PLACEHOLDER_SHA, createdBy: by } });
        continue;
      }
      const digest = await sha256File(target);
      if (digest === entry.sha256) {
        operations.push({ op: 'writeFile', path: target, content, onConflict: 'backup', entry: { ...entry, sha256: PLACEHOLDER_SHA, createdBy: by } });
        continue;
      }
      const sidePath = newTemplatePath(target);
      operations.push({ op: 'writeFile', path: sidePath, content, onConflict: 'backup', entry: { kind: 'file', path: sidePath, sha256: PLACEHOLDER_SHA, createdBy: by } });
      notices.push(`${target} was edited, so the new version is beside it as ${sidePath}`);
    }
  }
  return { operations, notices };
}

/**
 * Item 6: the pointer names the new profile and remembers the old one. The old directory stays until the
 * next successful `start`, so a launch that fails on the new profile has something to go back to.
 * @param {string} version
 * @param {string | null} previous
 * @returns {string}
 */
export function renderPointer(version, previous) {
  return stringifyJson({ version, previous });
}

/**
 * @param {string} text
 * @returns {{ version: string | null, previous: string | null }}
 */
export function parsePointer(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') return { version: null, previous: null };
    const version = typeof value.version === 'string' ? value.version : null;
    const previous = typeof value.previous === 'string' ? value.previous : null;
    return { version, previous };
  } catch {
    return { version: null, previous: null };
  }
}

/**
 * Item 2: the compatibility lines the user is shown before anything is written.
 * @param {object} input
 * @param {{ opencode: { tested: string }, ollama: { tested: string, min: string } }} input.compat
 * @param {string | null} input.installedOpencode
 * @param {string | null} input.installedOllama
 * @returns {string[]}
 */
export function describeCompatibility({ compat, installedOpencode, installedOllama }) {
  /** @type {string[]} */
  const lines = [`tested with OpenCode ${compat.opencode.tested} and Ollama ${compat.ollama.tested}`];
  if (installedOpencode && installedOpencode !== compat.opencode.tested) {
    lines.push(`your OpenCode is ${installedOpencode}; this release is tested against ${compat.opencode.tested} only`);
  }
  if (installedOllama && installedOllama !== compat.ollama.tested) {
    lines.push(`your Ollama is ${installedOllama}; the tested version is ${compat.ollama.tested} (minimum ${compat.ollama.min})`);
  }
  return lines;
}

/**
 * Item 7: a preset whose context length or sampling changed needs its own tag, because a tag is what the
 * profile pins and two different models must never share one name.
 * @param {{ numCtx?: number, sampling?: Record<string, number> }} previous
 * @param {{ numCtx?: number, sampling?: Record<string, number> }} next
 * @returns {boolean}
 */
export function modelNeedsNewTag(previous, next) {
  if (previous.numCtx !== next.numCtx) return true;
  const keys = new Set([...Object.keys(previous.sampling ?? {}), ...Object.keys(next.sampling ?? {})]);
  for (const key of keys) {
    if ((previous.sampling ?? {})[key] !== (next.sampling ?? {})[key]) return true;
  }
  return false;
}

/**
 * Item 9: `--rollback` moves the pointer back. It never reinstalls the package, so it prints the npm
 * command and says plainly when the previous profile is no longer on disk.
 * @param {object} input
 * @param {{ version: string | null, previous: string | null }} input.pointer
 * @param {(version: string) => string} input.profileDir
 * @returns {Promise<{ ok: boolean, version: string | null, message: string, command: string | null }>}
 */
export async function planRollback({ pointer, profileDir }) {
  if (!pointer.previous) return { ok: false, version: null, message: 'There is no previous profile to go back to.', command: null };
  const directory = profileDir(pointer.previous);
  if (!(await pathExists(directory))) {
    return { ok: false, version: pointer.previous, message: `The previous profile ${pointer.previous} is no longer in ${directory}.`, command: `npm i -g opencode-unity@${pointer.previous}` };
  }
  return {
    ok: true,
    version: pointer.previous,
    message: `The pointer now names ${pointer.previous}. Install that package version to use it.`,
    command: `npm i -g opencode-unity@${pointer.previous}`,
  };
}

/**
 * Item 8: projects whose facts were written by an older facts schema.
 * @param {Array<{ id: string, factsVersion?: number | null }>} projects
 * @param {number} currentFactsVersion
 * @returns {string[]}
 */
export function listStaleProjects(projects, currentFactsVersion) {
  return projects.filter((project) => (project.factsVersion ?? 0) !== currentFactsVersion).map((project) => project.id);
}
