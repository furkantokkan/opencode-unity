// Workspace discovery (amendment 37.2-37.4, D-B1..D-B5, P1-P7).
//
// SPEC 9.1 assumes a repository *is* a Unity project. This module replaces that precondition: `init`
// resolves a **workspace** root and finds components under it, of which a Unity client is one. Exit 1
// survives only when zero components are found, which is the caller's decision, not this module's.
//
// Discovery is a search for a fixed set of file names, never content analysis, so it stays cheap,
// explainable and fixturable: every component is declared by exactly one file, and `doctor --explain`
// can always say "component X exists because file Y exists" (D-B3).
//
// The walk skips hidden entries for the same reason SPEC 9.1 does, so `.github/`, `.env` folders and
// `.ssh` are never descended. Nothing that needs a dot-folder - the container and CI header line, for
// example - reads it from the walk; it asks for that one path by name.
import path from 'node:path';
import { compareOrdinal, isFile, joinProjectPath } from '../unity/fs-view.js';
import { SKIPPED_DIRS, isUnityHidden } from '../unity/walk.js';
import { detectVcs } from '../unity/vcs.js';
import { createReadBudget, DISCOVERY_LIMITS } from './budget.js';
import { assignComponentIds, isAnchorKind } from './ids.js';
import { evidenceRow } from './signatures.js';

/**
 * SPEC 9.1's skip list plus P3's additions. Compared case-insensitively, like the Unity walk.
 * A directory in this list is never descended, so nothing inside it can declare a component.
 */
export const WORKSPACE_SKIP_DIRS = Object.freeze([
  // SPEC 9.1, from the Unity walk's own list, so a name added there is skipped by both walks.
  ...SKIPPED_DIRS,
  // P3.
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  'vendor',
  '.venv',
  '__pycache__',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  'bin',
  // Unity output folders, which are siblings of the Unity anchor rather than inside it.
  'library',
  'temp',
  'logs',
  'usersettings',
]);

/** P2: a `unity-client` closes these, and only these, at its own root (D-B4). */
export const UNITY_CLOSED_DIRS = Object.freeze(['Assets', 'Packages', 'ProjectSettings']);

/** Files that declare an overlay by name alone. The EF Core `Migrations/` case is confirmed by S55. */
const OVERLAY_DECLARING_FILES = Object.freeze([
  { fileName: 'firebase.json', kind: /** @type {const} */ ('firebase-project'), signature: 'firebase/overlay.firebase-json' },
  { fileName: 'prisma.config.ts', kind: /** @type {const} */ ('database'), signature: 'db/overlay.prisma-config', discriminator: 'prisma' },
  { fileName: 'contract.prisma', kind: /** @type {const} */ ('database'), signature: 'db/overlay.prisma-contract', discriminator: 'prisma' },
  { fileName: 'schema.prisma', kind: /** @type {const} */ ('database'), signature: 'db/overlay.prisma-schema', discriminator: 'prisma' },
  { fileName: 'drizzle.config.ts', kind: /** @type {const} */ ('database'), signature: 'db/overlay.drizzle-config', discriminator: 'drizzle' },
  { fileName: 'drizzle.config.js', kind: /** @type {const} */ ('database'), signature: 'db/overlay.drizzle-config', discriminator: 'drizzle' },
  { fileName: 'knexfile.js', kind: /** @type {const} */ ('database'), signature: 'db/overlay.knexfile', discriminator: 'knex' },
  { fileName: 'knexfile.ts', kind: /** @type {const} */ ('database'), signature: 'db/overlay.knexfile', discriminator: 'knex' },
  { fileName: 'config.toml', kind: /** @type {const} */ ('database'), signature: 'db/overlay.supabase-config', discriminator: 'supabase', inDirNamed: 'supabase' },
]);

/** Server frameworks whose presence turns a workspace-root marker back into a service (P4, D-B5). */
const SERVER_FRAMEWORK_DEPENDENCIES = Object.freeze(['express', 'fastify', 'firebase-functions', 'firebase-admin', 'colyseus', '@colyseus/core', 'socket.io']);

const WEB_SDK_PATTERN = /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/;

/** P6: how a folder holding two anchors splits its files. */
const EXTENSION_FAMILIES = Object.freeze({
  'dotnet-service': ['.cs', '.csproj', '.props', '.targets'],
  'node-service': ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json'],
});

/**
 * @typedef {object} WalkResult
 * @property {string[]} files         POSIX paths relative to the workspace root, sorted.
 * @property {string[]} dirs          POSIX paths relative to the workspace root, sorted.
 * @property {boolean} truncated      The entry cap stopped the walk (doctor: component.walk-truncated).
 * @property {boolean} depthLimited   At least one directory sat below the depth cap.
 * @property {number} entryCount
 * @property {string[]} unityRoots    Directories that are Unity project roots, in walk order.
 */

/**
 * The bounded, sorted, deterministic walk. Same discipline as SPEC 9.1's Unity walk - one entry cap,
 * a skip list, ordinal sorting - generalised over the roots and the skip list so component discovery
 * and the anchor index cannot drift apart.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root  Absolute workspace root.
 * @param {{ maxEntries?: number, maxDepth?: number, skipDirs?: readonly string[], closeUnityRoots?: boolean }} [options]
 * @returns {WalkResult}
 */
export function walkTree(view, root, { maxEntries = DISCOVERY_LIMITS.walkEntryCap, maxDepth = DISCOVERY_LIMITS.maxDepth, skipDirs = WORKSPACE_SKIP_DIRS, closeUnityRoots = true } = {}) {
  const skip = new Set(skipDirs.map((name) => name.toLowerCase()));
  /** @type {WalkResult} */
  const result = { files: [], dirs: [], truncated: false, depthLimited: false, entryCount: 0, unityRoots: [] };

  /**
   * @param {string} relativeDir
   * @param {number} depth
   */
  const descend = (relativeDir, depth) => {
    if (result.truncated) return;
    if (depth > maxDepth) {
      result.depthLimited = true;
      return;
    }
    const entries = view.readDir(joinProjectPath(root, relativeDir));
    // P2, decided where the listing is already in hand: only a directory holding both `Assets/` and
    // `ProjectSettings/` costs the one extra stat that confirms a Unity root.
    const closed = closeUnityRoots && isUnityRoot(view, root, relativeDir, entries) ? UNITY_CLOSED_DIRS : NOTHING_CLOSED;
    if (closed.length > 0) result.unityRoots.push(relativeDir);

    for (const entry of entries) {
      if (result.truncated) return;
      if (isUnityHidden(entry.name) || skip.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory && closed.includes(entry.name)) continue;
      if (result.entryCount >= maxEntries) {
        result.truncated = true;
        return;
      }
      result.entryCount += 1;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        result.dirs.push(relativePath);
        descend(relativePath, depth + 1);
      } else if (entry.isFile) {
        result.files.push(relativePath);
      }
    }
  };

  descend('', 0);
  result.files.sort(compareOrdinal);
  result.dirs.sort(compareOrdinal);
  return result;
}

/** @type {readonly string[]} */
const NOTHING_CLOSED = Object.freeze([]);

/**
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root
 * @param {string} relativeDir
 * @param {readonly import('../unity/fs-view.js').DirEntry[]} entries  The directory's own listing.
 * @returns {boolean}
 */
function isUnityRoot(view, root, relativeDir, entries) {
  if (!entries.some((entry) => entry.isDirectory && entry.name === 'Assets')) return false;
  if (!entries.some((entry) => entry.isDirectory && entry.name === 'ProjectSettings')) return false;
  return isFile(view, path.join(joinProjectPath(root, relativeDir), 'ProjectSettings', 'ProjectVersion.txt'));
}

/**
 * @typedef {object} WorkspaceRoot
 * @property {string} root            Absolute.
 * @property {'vcs' | 'given'} source
 * @property {string | null} vcsKind
 */

/**
 * D-B1: the VCS root when SPEC 9.2's upward marker search finds one, otherwise the directory given.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} startPath
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {WorkspaceRoot}
 */
export function findWorkspaceRoot(view, startPath, { env = {} } = {}) {
  const given = path.resolve(startPath);
  const vcs = detectVcs(view, given, { env });
  if (vcs.source !== 'marker' || vcs.depth === null) return { root: given, source: 'given', vcsKind: vcs.kind === 'none' ? null : vcs.kind };
  let root = given;
  for (let step = 0; step < vcs.depth; step += 1) root = path.dirname(root);
  return { root, source: 'vcs', vcsKind: vcs.kind };
}

/**
 * @typedef {object} EvidenceEntry
 * @property {string} fact
 * @property {string} signature
 * @property {string} file
 */

/**
 * @typedef {object} DiscoveredComponent
 * @property {string} id
 * @property {import('./ids.js').ComponentKind} kind
 * @property {'anchor' | 'overlay'} class
 * @property {string} dir            POSIX, relative to the workspace root; '' is the root.
 * @property {string} declaredBy     POSIX, relative to the workspace root.
 * @property {'ok' | 'unreadable' | 'unbudgeted'} status
 * @property {string | null} attachedTo  Overlays only: an anchor id, or 'workspace' (P5).
 * @property {Record<string, unknown> | null} manifest  The parsed declaring file when it is JSON.
 * @property {EvidenceEntry[]} evidence
 */

/**
 * @typedef {object} WorkspaceRootMarker
 * @property {boolean} present
 * @property {'npm' | 'pnpm' | 'yarn' | null} tool
 * @property {string[]} members      Declared globs, unexpanded.
 * @property {string | null} declaredBy
 * @property {Record<string, unknown> | null} manifest  The root `package.json`, read once.
 * @property {'ok' | 'unreadable' | 'unbudgeted' | 'missing'} manifestStatus
 */

/**
 * @typedef {object} WorkspaceDiscovery
 * @property {string} root
 * @property {'vcs' | 'given'} rootSource
 * @property {string | null} vcsKind
 * @property {WalkResult} walk
 * @property {WorkspaceRootMarker} workspaceRoot
 * @property {DiscoveredComponent[]} anchors
 * @property {DiscoveredComponent[]} overlays
 * @property {string[]} sharedFolders   Folders holding two anchors (doctor: component.shared-folder).
 * @property {import('./budget.js').ReadBudget} budget
 * @property {string[]} notes           Doctor check ids this discovery raises.
 */

/**
 * Resolves the workspace root first (D-B1), then discovers under it. `init` calls this; a caller that
 * already knows its root - a test, or a `--project` that must not climb to a parent repository - calls
 * `discoverComponents` directly.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} startPath
 * @param {{ env?: Record<string, string | undefined>, limits?: Partial<import('./budget.js').DiscoveryLimits> }} [options]
 * @returns {WorkspaceDiscovery}
 */
export function discoverWorkspace(view, startPath, { env = {}, limits = {} } = {}) {
  const resolved = findWorkspaceRoot(view, startPath, { env });
  return discoverComponents(view, resolved.root, { limits, rootSource: resolved.source, vcsKind: resolved.vcsKind });
}

/**
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root  Absolute, already resolved.
 * @param {{ limits?: Partial<import('./budget.js').DiscoveryLimits>, rootSource?: 'vcs' | 'given', vcsKind?: string | null }} [options]
 * @returns {WorkspaceDiscovery}
 */
export function discoverComponents(view, root, { limits = {}, rootSource = 'given', vcsKind = null } = {}) {
  const resolved = { root: path.resolve(root), source: rootSource, vcsKind };
  const walk = walkTree(view, resolved.root, { maxEntries: limits.walkEntryCap ?? DISCOVERY_LIMITS.walkEntryCap, maxDepth: limits.maxDepth ?? DISCOVERY_LIMITS.maxDepth });
  const budget = createReadBudget(view, resolved.root, { limits });

  const workspaceRoot = readWorkspaceRootMarker(budget, walk);
  const anchorCandidates = collectAnchors(budget, walk, workspaceRoot);
  const overlayCandidates = collectOverlays(walk);

  const ids = assignComponentIds([...anchorCandidates, ...overlayCandidates].map((candidate) => ({ kind: candidate.kind, dir: candidate.dir, discriminator: candidate.discriminator, declaredBy: candidate.declaredBy })));
  const anchors = anchorCandidates.map((candidate, index) => finishComponent(candidate, ids[index]));
  const overlays = overlayCandidates.map((candidate, index) => finishComponent(candidate, ids[anchorCandidates.length + index]));
  for (const overlay of overlays) overlay.attachedTo = nearestAnchorId(anchors, overlay.dir);

  const sharedFolders = findSharedFolders(anchors);
  /** @type {string[]} */
  const notes = [];
  if (walk.truncated) notes.push('component.walk-truncated');
  if (sharedFolders.length > 0) notes.push('component.shared-folder');
  if ([...anchors, ...overlays].some((component) => component.status === 'unreadable')) notes.push('component.unreadable');
  if (anchors.length === 0 && overlays.length === 0) notes.push('component.none-found');

  return { root: resolved.root, rootSource: resolved.source, vcsKind: resolved.vcsKind, walk, workspaceRoot, anchors, overlays, sharedFolders, budget, notes };
}

/**
 * @typedef {object} Candidate
 * @property {import('./ids.js').ComponentKind} kind
 * @property {string} dir
 * @property {string} declaredBy
 * @property {string} [discriminator]
 * @property {'ok' | 'unreadable' | 'unbudgeted'} status
 * @property {Record<string, unknown> | null} manifest
 * @property {EvidenceEntry[]} evidence
 */

/**
 * @param {Candidate} candidate
 * @param {string} id
 * @returns {DiscoveredComponent}
 */
function finishComponent(candidate, id) {
  return {
    id,
    kind: candidate.kind,
    class: isAnchorKind(candidate.kind) ? 'anchor' : 'overlay',
    dir: candidate.dir,
    declaredBy: candidate.declaredBy,
    status: candidate.status,
    attachedTo: isAnchorKind(candidate.kind) ? null : 'workspace',
    manifest: candidate.manifest,
    evidence: candidate.evidence,
  };
}

/**
 * P4: the root marker is read before anchors, because whether a `package.json` is a service depends on
 * it. A marker's globs are recorded unexpanded; expanding them is S53's problem, and the ordinary walk
 * finds the members either way.
 * @param {import('./budget.js').ReadBudget} budget
 * @param {WalkResult} walk
 * @returns {WorkspaceRootMarker}
 */
function readWorkspaceRootMarker(budget, walk) {
  const hasPnpmWorkspace = walk.files.includes('pnpm-workspace.yaml');
  const hasRootPackage = walk.files.includes('package.json');
  /** @type {WorkspaceRootMarker} */
  const absent = { present: false, tool: null, members: [], declaredBy: null, manifest: null, manifestStatus: 'missing' };
  if (!hasRootPackage) {
    return hasPnpmWorkspace ? { ...absent, present: true, tool: 'pnpm', declaredBy: 'pnpm-workspace.yaml' } : absent;
  }

  const read = budget.readJson('package.json', { component: 'workspace' });
  const manifest = asObject(read.value);
  const status = read.status === 'ok' && manifest !== null ? /** @type {const} */ ('ok') : read.status === 'unbudgeted' ? /** @type {const} */ ('unbudgeted') : /** @type {const} */ ('unreadable');
  const base = { ...absent, manifest, manifestStatus: status };
  if (hasStartMarker(manifest)) return base;

  const members = asStringArray(manifest?.workspaces) ?? asStringArray(asObject(manifest?.workspaces)?.packages) ?? [];
  if (members.length > 0) return { ...base, present: true, tool: hasPnpmWorkspace ? 'pnpm' : 'npm', members, declaredBy: 'package.json' };
  if (hasPnpmWorkspace) return { ...base, present: true, tool: 'pnpm', declaredBy: 'pnpm-workspace.yaml' };
  return base;
}

/**
 * D-B5's "unless it also declares `bin`, a `start` script, or a server framework dependency".
 * @param {Record<string, unknown> | null} manifest
 * @returns {boolean}
 */
export function hasStartMarker(manifest) {
  if (!manifest) return false;
  if (manifest.bin !== undefined) return true;
  if (typeof asObject(manifest.scripts)?.start === 'string') return true;
  return SERVER_FRAMEWORK_DEPENDENCIES.some((name) => hasDependency(manifest, name));
}

/**
 * @param {Record<string, unknown> | null} manifest
 * @param {string} name
 * @returns {boolean}
 */
function hasDependency(manifest, name) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (asObject(manifest?.[field])?.[name] !== undefined) return true;
  }
  return false;
}

/**
 * P1's input: every anchor declaring file the walk saw, sorted by path so the result is deterministic.
 * @param {import('./budget.js').ReadBudget} budget
 * @param {WalkResult} walk
 * @param {WorkspaceRootMarker} workspaceRoot
 * @returns {Candidate[]}
 */
function collectAnchors(budget, walk, workspaceRoot) {
  /** @type {Candidate[]} */
  const candidates = [];

  for (const dir of walk.unityRoots) {
    const declaredBy = joinRelative(dir, 'ProjectSettings/ProjectVersion.txt');
    candidates.push({
      kind: 'unity-client',
      dir,
      declaredBy,
      status: 'ok',
      manifest: null,
      // SPEC 9.1 owns the Unity root rule, so its evidence cites the specification rather than a
      // signature row: no external product name is being claimed here.
      evidence: [evidenceRow('anchor', 'spec:9.1', declaredBy)],
    });
  }

  for (const file of walk.files) {
    const name = baseName(file);
    const dir = parentDir(file);

    if (name === 'package.json') {
      // P4: the root marker is not a service, and its manifest was already read once.
      if (file === 'package.json' && workspaceRoot.present) continue;
      const read = file === 'package.json' ? { status: workspaceRoot.manifestStatus, value: workspaceRoot.manifest } : budget.readJson(file, { component: `node:${dir}` });
      const manifest = asObject(read.value);
      const status = read.status === 'ok' && manifest !== null ? /** @type {const} */ ('ok') : read.status === 'unbudgeted' ? /** @type {const} */ ('unbudgeted') : /** @type {const} */ ('unreadable');
      candidates.push({ kind: 'node-service', dir, declaredBy: file, status, manifest: status === 'ok' ? manifest : null, evidence: [evidenceRow('anchor', 'node/anchor.package-json', file)] });
      continue;
    }

    if (name.toLowerCase().endsWith('.csproj')) {
      // A csproj sitting directly in a Unity root is generated by Unity and is never a web service, so
      // it is not worth a read. A csproj in a sub-folder still is: `Api/` beside `Assets/` is shape A.
      if (walk.unityRoots.includes(dir)) continue;
      const read = budget.readText(file, { component: `dotnet:${dir}` });
      if (read.status !== 'ok') continue;
      if (!WEB_SDK_PATTERN.test(read.text ?? '')) continue;
      candidates.push({ kind: 'dotnet-service', dir, declaredBy: file, status: 'ok', manifest: null, evidence: [evidenceRow('anchor', 'dotnet/anchor.web-sdk', file)] });
    }
  }

  return candidates.sort((a, b) => compareOrdinal(a.declaredBy, b.declaredBy));
}

/**
 * @param {WalkResult} walk
 * @returns {Candidate[]}
 */
function collectOverlays(walk) {
  /** @type {Candidate[]} */
  const candidates = [];
  for (const file of walk.files) {
    const name = baseName(file);
    const dir = parentDir(file);
    for (const rule of OVERLAY_DECLARING_FILES) {
      if (rule.fileName !== name) continue;
      if (rule.inDirNamed !== undefined && baseName(dir) !== rule.inDirNamed) continue;
      // `supabase/config.toml` declares the database of the folder that holds `supabase/`, not of
      // `supabase/` itself.
      const componentDir = rule.inDirNamed !== undefined ? parentDir(dir) : dir;
      candidates.push({
        kind: rule.kind,
        dir: componentDir,
        declaredBy: file,
        discriminator: rule.discriminator,
        status: 'ok',
        manifest: null,
        evidence: [evidenceRow('overlay', rule.signature, file)],
      });
    }
  }
  return candidates.sort((a, b) => compareOrdinal(a.declaredBy, b.declaredBy));
}

/**
 * P5: an overlay attaches to the nearest enclosing anchor, or to the workspace when there is none.
 * @param {readonly DiscoveredComponent[]} anchors
 * @param {string} dir
 * @returns {string}
 */
export function nearestAnchorId(anchors, dir) {
  /** @type {DiscoveredComponent | null} */
  let best = null;
  for (const anchor of anchors) {
    if (!isWithin(dir, anchor.dir)) continue;
    if (best === null || anchor.dir.length > best.dir.length) best = anchor;
    // Two anchors in one folder: the same tie-break as P6, so the answer never depends on walk order.
    else if (anchor.dir.length === best.dir.length && compareOrdinal(anchor.declaredBy, best.declaredBy) < 0) best = anchor;
  }
  return best?.id ?? 'workspace';
}

/**
 * P1 and P6: the anchor that owns a file. The longest matching prefix wins; when two anchors declare
 * the same folder, the extension family decides, and anything else goes to the anchor whose declaring
 * file sorts first.
 * @param {readonly DiscoveredComponent[]} anchors
 * @param {string} relativePath  POSIX, relative to the workspace root.
 * @returns {string | null}  The owning anchor id, or null when no anchor covers the path.
 */
export function ownerOf(anchors, relativePath) {
  /** @type {DiscoveredComponent[]} */
  let best = [];
  for (const anchor of anchors) {
    if (!isWithin(relativePath, anchor.dir)) continue;
    if (best.length === 0 || anchor.dir.length > best[0].dir.length) best = [anchor];
    else if (anchor.dir.length === best[0].dir.length) best.push(anchor);
  }
  if (best.length === 0) return null;
  if (best.length === 1) return best[0].id;

  const extension = extensionOfPath(relativePath);
  for (const anchor of best) {
    const family = EXTENSION_FAMILIES[/** @type {keyof typeof EXTENSION_FAMILIES} */ (anchor.kind)];
    if (family?.includes(extension)) return anchor.id;
  }
  return [...best].sort((a, b) => compareOrdinal(a.declaredBy, b.declaredBy))[0].id;
}

/**
 * @param {readonly DiscoveredComponent[]} anchors
 * @returns {string[]}
 */
function findSharedFolders(anchors) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const anchor of anchors) counts.set(anchor.dir, (counts.get(anchor.dir) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([dir]) => dir)
    .sort(compareOrdinal);
}

/**
 * @param {string} relativePath
 * @param {string} dir  '' is the workspace root, which contains everything.
 * @returns {boolean}
 */
export function isWithin(relativePath, dir) {
  if (dir === '') return true;
  return relativePath === dir || relativePath.startsWith(`${dir}/`);
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function baseName(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function parentDir(relativePath) {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/**
 * @param {string} dir
 * @param {string} relativePath
 * @returns {string}
 */
function joinRelative(dir, relativePath) {
  return dir === '' ? relativePath : `${dir}/${relativePath}`;
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function extensionOfPath(relativePath) {
  const name = baseName(relativePath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
export function asStringArray(value) {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((entry) => typeof entry === 'string');
  return strings.length === value.length ? /** @type {string[]} */ (strings) : null;
}
