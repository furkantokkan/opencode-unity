// Version control (spec 9.2): the nearest marker from the project root up to the drive root.
import path from 'node:path';
import { VCS_MARKERS } from '../../plugin/opencode-unity-lib/vcs-tables.js';

/**
 * @typedef {object} VcsMarkerHit
 * @property {import('../../plugin/opencode-unity-lib/vcs-tables.js').VcsKind} kind
 * @property {string} marker   Relative to the project root, for example `.git` or `../.plastic`.
 * @property {number} depth    0 at the project root, 1 in its parent, and so on.
 */

/**
 * @typedef {object} VcsFact
 * @property {import('../../plugin/opencode-unity-lib/vcs-tables.js').VcsKind | 'none'} kind
 * @property {'marker' | 'env' | null} source
 * @property {number | null} depth
 * @property {string | null} marker
 * @property {VcsMarkerHit[]} found   Every marker in the nearest directory that has one.
 */

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {VcsFact}
 */
export function detectVcs(view, root, { env = {} } = {}) {
  const markers = getMarkers(env);
  let current = path.resolve(root);
  for (let depth = 0; ; depth += 1) {
    /** @type {VcsMarkerHit[]} */
    const found = [];
    for (const marker of markers) {
      const stat = view.stat(path.join(current, marker.name));
      if (!stat) continue;
      if (marker.type === 'dir' && !stat.isDirectory) continue;
      if (marker.type === 'file' && !stat.isFile) continue;
      found.push({ kind: marker.kind, marker: `${'../'.repeat(depth)}${marker.name}`, depth });
    }
    if (found.length > 0) return { kind: found[0].kind, source: 'marker', depth, marker: found[0].marker, found };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // P4CONFIG names a per-workspace settings file; when it is set but no file was found, Perforce is still
  // the client in use (spec 8.5.3).
  if (getP4ConfigName(env)) return { kind: 'perforce', source: 'env', depth: null, marker: null, found: [] };
  return { kind: 'none', source: null, depth: null, marker: null, found: [] };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Array<{ kind: import('../../plugin/opencode-unity-lib/vcs-tables.js').VcsKind, name: string, type: string }>}
 */
function getMarkers(env) {
  const p4config = getP4ConfigName(env);
  const extra = p4config && !VCS_MARKERS.some((marker) => marker.name === p4config) ? [{ kind: /** @type {const} */ ('perforce'), name: p4config, type: 'file' }] : [];
  return [...VCS_MARKERS, ...extra];
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function getP4ConfigName(env) {
  const value = env.P4CONFIG?.trim();
  if (!value) return null;
  const name = value.split(/[\\/]/).pop();
  return name || null;
}
