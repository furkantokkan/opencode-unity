// Component ids (amendment 37.3, D-B19). Rules, permission rendering, `status` lines, doctor findings
// and the fact blocks all have to name the same thing, and a path is too long for a 200-character
// block, so every component carries a stable `<prefix>:<slug>` id derived from its folder.
import { sha256Hex } from '../core/hash.js';

/** @typedef {'unity-client' | 'node-service' | 'dotnet-service' | 'firebase-project' | 'database' | 'game-server'} ComponentKind */

/** Anchors own a folder subtree; overlays own no files and attach to an anchor or the workspace (D-B2). */
export const ANCHOR_KINDS = Object.freeze(['unity-client', 'node-service', 'dotnet-service']);
export const OVERLAY_KINDS = Object.freeze(['firebase-project', 'database', 'game-server']);
export const COMPONENT_KINDS = Object.freeze([...ANCHOR_KINDS, ...OVERLAY_KINDS]);

/**
 * The id prefix per kind. Short on purpose: the id is rendered in a fact block whose whole budget is
 * 200 characters.
 * @type {Readonly<Record<ComponentKind, string>>}
 */
export const ID_PREFIXES = Object.freeze({
  'unity-client': 'unity',
  'node-service': 'node',
  'dotnet-service': 'dotnet',
  'firebase-project': 'firebase',
  database: 'db',
  'game-server': 'server',
});

export const MAX_SLUG_LENGTH = 24;

/**
 * @param {string} kind
 * @returns {boolean}
 */
export function isAnchorKind(kind) {
  return ANCHOR_KINDS.includes(/** @type {ComponentKind} */ (kind));
}

/**
 * Folder-derived slug: lower case, every run of non-alphanumerics collapsed to one `-`, capped at 24
 * characters. The workspace root is `root` so an overlay declared there reads as `firebase:root`.
 * @param {string} relativeDir  POSIX, relative to the workspace root; '' or '.' is the root.
 * @param {string} [discriminator]  Distinguishes two overlays of one kind in one folder, e.g. `drizzle`.
 * @returns {string}
 */
export function slugForDir(relativeDir, discriminator = '') {
  const parts = `${relativeDir}/${discriminator}`
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.');
  const cleaned = parts.map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter((part) => part !== '');
  if (cleaned.length === 0) return 'root';

  // Keep whole segments from the tail: the last ones say which component this is, the leading ones
  // repeat across a monorepo ("apps/services/match" and "apps/services/inventory" share their head).
  const kept = [];
  let length = -1;
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    const next = length + 1 + cleaned[index].length;
    if (kept.length > 0 && next > MAX_SLUG_LENGTH) break;
    kept.unshift(cleaned[index]);
    length = next;
  }
  const slug = kept.join('-');
  return slug.length <= MAX_SLUG_LENGTH ? slug : slug.slice(slug.length - MAX_SLUG_LENGTH).replace(/^-+/, '');
}

/**
 * @param {ComponentKind} kind
 * @param {string} relativeDir
 * @param {string} [discriminator]
 * @returns {string}
 */
export function componentId(kind, relativeDir, discriminator = '') {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new TypeError(`Unknown component kind: '${kind}'`);
  return `${prefix}:${slugForDir(relativeDir, discriminator)}`;
}

/**
 * @typedef {object} IdCandidate
 * @property {ComponentKind} kind
 * @property {string} dir            POSIX, relative to the workspace root.
 * @property {string} [discriminator]
 * @property {string} [declaredBy]   Used only to break a collision, so the suffix is stable.
 */

/**
 * Assigns one id per candidate, in the order given. A second component that wants an id already taken
 * gets a 4-hex suffix derived from its declaring file, so the id is stable across runs and machines
 * rather than positional.
 * @param {readonly IdCandidate[]} candidates
 * @returns {string[]}  One id per candidate, in the same order.
 */
export function assignComponentIds(candidates) {
  /** @type {Set<string>} */
  const taken = new Set();
  return candidates.map((candidate) => {
    const base = componentId(candidate.kind, candidate.dir, candidate.discriminator);
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }
    const seed = candidate.declaredBy ?? `${candidate.dir}/${candidate.discriminator ?? ''}`;
    let id = `${base}-${sha256Hex(seed).slice(0, 4)}`;
    for (let attempt = 1; taken.has(id); attempt += 1) {
      id = `${base}-${sha256Hex(`${seed}#${attempt}`).slice(0, 4)}`;
    }
    taken.add(id);
    return id;
  });
}
