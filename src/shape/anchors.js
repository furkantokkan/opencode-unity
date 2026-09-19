// Readiness rule R2 of prompt shaping (amendment 36.3): the anchor index, the five resolution rules,
// the bounded grep, and the candidate list the rewrite may choose from.
//
// The index is a sorted list of workspace-relative paths from the same bounded walk component discovery
// uses (50,000 entries, the same skip list), restricted to the resolved component set and to the
// extensions below. Scene, prefab and asset files are indexed by path only and never opened. Nothing in
// this module reads a file except rule 5 and the V-SH3 search check, and both go through the one grep
// here: capped in files, bytes and time, and never pointed at a path the scanner's read deny set covers.
//
// The candidate list is the only project-derived text that reaches the model, and it carries paths
// only, never content. A path is repository-derived and therefore untrusted (SPEC S15); every path the
// model names afterwards is checked against this index again (validate.js, V-SH2).
import { isNeverOpenedFile, isProtectedReadPath } from '../project/budget.js';
import { isWithin, walkTree } from '../project/discover.js';
import { compareOrdinal, isProjectPath, joinProjectPath } from '../unity/fs-view.js';
import { MAX_WALK_ENTRIES } from '../unity/walk.js';
import { hasSeparator, isIdentifierShaped, isMultiHump, isSnakeCase } from './verdict.js';

/** Files the index lists and rule 5 may search (36.3, including the A1.2 additions for services). */
export const INDEXED_EXTENSIONS = Object.freeze([
  '.cs', '.uxml', '.uss', '.asmdef', '.asmref', '.json', '.md', '.txt', '.shader',
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.csproj', '.sql', '.yaml', '.yml',
]);

/** Listed by path so a request may name them; never opened. */
export const PATH_ONLY_EXTENSIONS = Object.freeze(['.unity', '.prefab', '.asset']);

export const GREP_LIMITS = Object.freeze({ maxFiles: 5000, maxBytesPerFile: 300 * 1024, minHits: 1, maxHits: 50 });

export const CANDIDATE_LIMITS = Object.freeze({ maxLines: 20, maxLineChars: 120, maxEditDistance: 3 });

// A path with a control character could break the one-path-per-line list the model reads.
const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * @typedef {object} AnchorIndex
 * @property {string[]} files       Workspace-relative POSIX paths, sorted ordinally.
 * @property {boolean} truncated    The walk hit its entry cap, so anchors may be missing.
 * @property {number} entryCount
 */

/**
 * @typedef {object} FolderAnchorSource
 * @property {string} name     An assembly name or nothing (compile-map prefixes have none).
 * @property {string} folder   Workspace-relative POSIX folder.
 */

/**
 * @typedef {object} AnchorLookup
 * @property {AnchorIndex} index
 * @property {(value: string) => string} fold
 * @property {Map<string, string>} byPath
 * @property {Map<string, string[]>} byName
 * @property {Map<string, string[]>} byStem
 * @property {Map<string, string>} folders
 * @property {Map<string, string>} assemblies      Assembly name -> folder (rule 4).
 * @property {Map<string, string>} compilePrefixes  Folded folder -> folder (rule 4).
 * @property {Set<string>} members
 */

/**
 * @typedef {object} Anchor
 * @property {string} token
 * @property {1 | 2 | 3 | 4 | 5} rule
 * @property {'file' | 'folder' | 'literal'} kind
 * @property {string} target   The file, the folder, or the literal that was found.
 */

/**
 * @typedef {object} AnchorResolution
 * @property {Anchor[]} anchors
 * @property {Array<{ token: string, paths: string[] }>} ambiguous
 * @property {string[]} unresolved   Identifier- or path-shaped tokens that did not resolve.
 * @property {string[]} plainWords   Plain words that did not resolve; they only feed the candidate list.
 * @property {GrepSummary} grep
 */

/**
 * @typedef {object} GrepSummary
 * @property {boolean} ran
 * @property {boolean} timedOut
 * @property {boolean} capped       More searchable files than `maxFiles`; the rest were not read.
 * @property {number} filesScanned
 */

/**
 * @typedef {object} GrepOptions
 * @property {number} [maxFiles]
 * @property {number} [maxBytesPerFile]
 * @property {number} [maxHits]         A literal is no longer counted once it passes this many files.
 * @property {number} timeoutMs
 * @property {() => number} [now]
 */

/**
 * The index over the component set. `componentDirs` are the discovered components' folders; an empty
 * list indexes the whole walk.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root  Absolute workspace root.
 * @param {{ componentDirs?: readonly string[], maxEntries?: number }} [options]
 * @returns {AnchorIndex}
 */
export function buildAnchorIndex(view, root, { componentDirs = [], maxEntries = MAX_WALK_ENTRIES } = {}) {
  // Unity's own folders are closed to component discovery, but they are exactly where a Unity request's
  // anchors live, so this walk opens them.
  const walk = walkTree(view, root, { maxEntries, closeUnityRoots: false });
  const files = walk.files.filter((file) => isIndexable(file) && (componentDirs.length === 0 || componentDirs.some((dir) => isWithin(file, dir))));
  return { files, truncated: walk.truncated, entryCount: walk.entryCount };
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isIndexable(relativePath) {
  if (!isProjectPath(relativePath) || CONTROL_CHARACTER.test(relativePath)) return false;
  const extension = extensionOf(relativePath);
  if (PATH_ONLY_EXTENSIONS.includes(extension)) return true;
  // A secret-shaped file (a service account, a production settings file) is left out altogether, so its
  // name can never be offered to the model or named by it.
  return INDEXED_EXTENSIONS.includes(extension) && !isProtectedReadPath(relativePath);
}

/**
 * Files rule 5 and V-SH3 may open.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isSearchable(relativePath) {
  return (
    isProjectPath(relativePath) &&
    INDEXED_EXTENSIONS.includes(extensionOf(relativePath)) &&
    !isProtectedReadPath(relativePath) &&
    !isNeverOpenedFile(relativePath)
  );
}

/**
 * Lookup tables over one index. Case folds only on a case-insensitive volume, the same rule project
 * identity follows.
 * @param {AnchorIndex} index
 * @param {{ caseInsensitive?: boolean, folders?: readonly FolderAnchorSource[] }} [options]
 * @returns {AnchorLookup}
 */
export function createAnchorLookup(index, { caseInsensitive = false, folders = [] } = {}) {
  const fold = caseInsensitive ? (/** @type {string} */ value) => value.toLowerCase() : (/** @type {string} */ value) => value;
  /** @type {AnchorLookup} */
  const lookup = {
    index,
    fold,
    byPath: new Map(),
    byName: new Map(),
    byStem: new Map(),
    folders: new Map(),
    assemblies: new Map(),
    compilePrefixes: new Map(),
    members: new Set(index.files),
  };
  for (const file of index.files) {
    lookup.byPath.set(fold(file), file);
    appendTo(lookup.byName, fold(baseNameOf(file)), file);
    appendTo(lookup.byStem, fold(stemOf(file)), file);
    for (let dir = parentOf(file); dir !== ''; dir = parentOf(dir)) {
      if (lookup.folders.has(fold(dir))) break;
      lookup.folders.set(fold(dir), dir);
    }
  }
  for (const source of folders) {
    const folder = source.folder.replace(/\/+$/, '');
    if (folder !== '' && !isProjectPath(folder)) continue;
    if (source.name) lookup.assemblies.set(source.name, folder);
    else lookup.compilePrefixes.set(fold(folder), folder);
  }
  return lookup;
}

/**
 * Rules 1-4 for every token, then rule 5 when nothing resolved and `grep` is given. The caller passes
 * `grep` only when the alternative is a model call (an action verb is present and the mode is not
 * `always`), so rule 5's disk reads are never spent on a verdict that is already decided.
 * @param {readonly import('./verdict.js').RequestToken[]} tokens
 * @param {AnchorLookup} lookup
 * @param {{ grep?: ((literals: string[]) => GrepResult) | null }} [options]
 * @returns {AnchorResolution}
 */
export function resolveAnchors(tokens, lookup, { grep = null } = {}) {
  /** @type {Anchor[]} */
  const anchors = [];
  /** @type {Array<{ token: string, paths: string[] }>} */
  const ambiguous = [];
  /** @type {import('./verdict.js').RequestToken[]} */
  const pending = [];
  for (const token of tokens) {
    const outcome = resolveToken(token.text, lookup);
    if (outcome === null) pending.push(token);
    else if ('paths' in outcome) ambiguous.push({ token: token.text, paths: outcome.paths });
    else anchors.push(outcome);
  }

  /** @type {GrepSummary} */
  let summary = { ran: false, timedOut: false, capped: false, filesScanned: 0 };
  /** @type {Set<string>} */
  const found = new Set();
  if (anchors.length === 0 && grep) {
    const literals = pending.filter((token) => isGrepLiteral(token)).map((token) => token.text);
    if (literals.length > 0) {
      const result = grep(literals);
      summary = { ran: true, timedOut: result.timedOut, capped: result.capped, filesScanned: result.filesScanned };
      for (const literal of literals) {
        const hits = result.hits.get(literal) ?? 0;
        if (!result.timedOut && hits >= GREP_LIMITS.minHits && hits <= GREP_LIMITS.maxHits) {
          anchors.push({ token: literal, rule: 5, kind: 'literal', target: literal });
          found.add(literal);
        }
      }
    }
  }

  const left = pending.filter((token) => !found.has(token.text));
  return {
    anchors,
    ambiguous,
    unresolved: [...left.filter((token) => token.quoted || isIdentifierShaped(token.text)).map((token) => token.text), ...ambiguous.map((entry) => entry.token)],
    plainWords: left.filter((token) => !token.quoted && !isIdentifierShaped(token.text)).map((token) => token.text),
    grep: summary,
  };
}

/**
 * One token against rules 1-4. `paths` means ambiguous: more than one file matched, so none of them is
 * an anchor and all of them are candidates.
 * @param {string} token
 * @param {AnchorLookup} lookup
 * @returns {Anchor | { paths: string[] } | null}
 */
export function resolveToken(token, lookup) {
  const { fold } = lookup;
  if (hasSeparator(token)) {
    const normalized = normalizeTokenPath(token);
    if (normalized === null) return null;
    const file = lookup.byPath.get(fold(normalized));
    if (file) return { token, rule: 1, kind: 'file', target: file };
    const folder = lookup.folders.get(fold(normalized));
    if (folder) return { token, rule: 1, kind: 'folder', target: folder };
    const prefix = lookup.compilePrefixes.get(fold(normalized));
    return prefix === undefined ? null : { token, rule: 4, kind: 'folder', target: prefix };
  }
  if (hasIndexedExtension(token)) {
    const file = lookup.byPath.get(fold(token));
    if (file) return { token, rule: 1, kind: 'file', target: file };
    return pickOne(token, lookup.byName.get(fold(token)), 2);
  }
  const byStem = pickOne(token, lookup.byStem.get(fold(token)), 2);
  if (byStem) return byStem;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(token)) {
    const last = token.slice(token.lastIndexOf('.') + 1);
    const byLastSegment = pickOne(token, lookup.byStem.get(fold(last)), 3);
    if (byLastSegment) return byLastSegment;
  }
  const assemblyFolder = lookup.assemblies.get(token);
  return assemblyFolder === undefined ? null : { token, rule: 4, kind: 'folder', target: assemblyFolder };
}

/**
 * @typedef {object} GrepResult
 * @property {Map<string, number>} hits   Files containing each literal, counted up to `maxHits + 1`.
 * @property {boolean} timedOut
 * @property {boolean} capped
 * @property {number} filesScanned
 */

/**
 * The one bounded search: at most `maxFiles` searchable files in index order, the first
 * `maxBytesPerFile` of each, and a wall-clock limit. An identifier matches as a whole word; any other
 * literal as a substring.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root
 * @param {AnchorIndex} index
 * @param {readonly string[]} literals
 * @param {GrepOptions} options
 * @returns {GrepResult}
 */
export function grepIndex(view, root, index, literals, options) {
  const maxFiles = options.maxFiles ?? GREP_LIMITS.maxFiles;
  const maxBytes = options.maxBytesPerFile ?? GREP_LIMITS.maxBytesPerFile;
  const maxHits = options.maxHits ?? GREP_LIMITS.maxHits;
  const now = options.now ?? Date.now;
  const matchers = literals.map((literal) => ({ literal, test: createLiteralMatcher(literal), hits: 0 }));
  const startedMs = now();
  const result = { timedOut: false, capped: false, filesScanned: 0 };
  for (const file of index.files) {
    if (!isSearchable(file)) continue;
    if (result.filesScanned >= maxFiles) {
      result.capped = true;
      break;
    }
    if (now() - startedMs > options.timeoutMs) {
      result.timedOut = true;
      break;
    }
    const open = matchers.filter((matcher) => matcher.hits <= maxHits);
    if (open.length === 0) break;
    const read = view.readText(joinProjectPath(root, file), { maxBytes });
    result.filesScanned += 1;
    if (!read) continue;
    for (const matcher of open) if (matcher.test(read.text)) matcher.hits += 1;
  }
  return { hits: new Map(matchers.map((matcher) => [matcher.literal, matcher.hits])), ...result };
}

/**
 * The candidate list for the rewrite: resolved files first, then every match of an ambiguous name, then
 * up to `perToken` near matches for each token that did not resolve. At most `maxLines` lines of at most
 * `maxLineChars` characters, sorted. A line that is too long is left out, never cut, because a cut path
 * is an invented one.
 * @param {AnchorLookup} lookup
 * @param {AnchorResolution} resolution
 * @param {{ perToken?: number, maxLines?: number, maxLineChars?: number, maxEditDistance?: number, isProtected?: (path: string) => boolean }} [options]
 * @returns {string[]}
 */
export function buildCandidates(lookup, resolution, options = {}) {
  const perToken = options.perToken ?? 5;
  const maxLines = options.maxLines ?? CANDIDATE_LIMITS.maxLines;
  const maxLineChars = options.maxLineChars ?? CANDIDATE_LIMITS.maxLineChars;
  const maxDistance = options.maxEditDistance ?? CANDIDATE_LIMITS.maxEditDistance;
  const isProtected = options.isProtected ?? (() => false);
  /** @type {string[]} */
  const ordered = [];
  for (const anchor of resolution.anchors) if (anchor.kind === 'file') ordered.push(anchor.target);
  for (const entry of resolution.ambiguous) ordered.push(...entry.paths);
  for (const token of resolution.unresolved) ordered.push(...findNearMatches(lookup, token, { limit: perToken, maxDistance, isProtected }));
  for (const word of resolution.plainWords) ordered.push(...findNearMatches(lookup, word, { limit: perToken, maxDistance: -1, isProtected }));

  /** @type {string[]} */
  const chosen = [];
  for (const candidate of ordered) {
    if (chosen.length >= maxLines) break;
    if (candidate.length > maxLineChars || chosen.includes(candidate)) continue;
    chosen.push(candidate);
  }
  return chosen.sort(compareOrdinal);
}

/**
 * Index files whose name contains the token, or - when `maxDistance` is not negative - whose name is
 * within that many edits of it. Only files the agent may edit are offered, so the few `Files:` slots are
 * not spent on paths the validator would remove.
 * @param {AnchorLookup} lookup
 * @param {string} token
 * @param {{ limit: number, maxDistance: number, isProtected: (path: string) => boolean }} options
 * @returns {string[]}
 */
export function findNearMatches(lookup, token, { limit, maxDistance, isProtected }) {
  const key = candidateKey(token);
  if (key.length < 3) return [];
  /** @type {Array<{ path: string, score: number }>} */
  const scored = [];
  for (const file of lookup.index.files) {
    if (PATH_ONLY_EXTENSIONS.includes(extensionOf(file)) || isProtected(file)) continue;
    const stem = stemOf(file).toLowerCase();
    let score = stem.includes(key) ? 0 : -1;
    if (score < 0 && maxDistance >= 0 && Math.abs(stem.length - key.length) <= maxDistance) {
      const distance = getEditDistance(stem, key, maxDistance);
      if (distance <= maxDistance) score = distance;
    }
    if (score >= 0) scored.push({ path: file, score });
  }
  scored.sort((a, b) => a.score - b.score || compareOrdinal(a.path, b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}

/**
 * Levenshtein distance, giving up as soon as it must exceed `max` (and then returning `max + 1`).
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
export function getEditDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[b.length], max + 1);
}

/**
 * `Assets\Game\X.cs`, `./Assets/Game/X.cs` and `Assets/Game/` all name the same place. A token that climbs
 * out of the workspace names nothing.
 * @param {string} token
 * @returns {string | null}
 */
export function normalizeTokenPath(token) {
  const slashed = token.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return isProjectPath(slashed) ? slashed : null;
}

/**
 * @param {string} relativePath
 * @returns {string} Lower-case, with the dot; '' when there is none.
 */
export function extensionOf(relativePath) {
  const name = baseNameOf(relativePath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
export function baseNameOf(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1);
}

/**
 * The file name without its last extension.
 * @param {string} relativePath
 * @returns {string}
 */
export function stemOf(relativePath) {
  const name = baseNameOf(relativePath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * @param {string} relativePath
 * @returns {string} '' at the root.
 */
export function parentOf(relativePath) {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/**
 * @param {import('./verdict.js').RequestToken} token
 * @returns {boolean}
 */
function isGrepLiteral(token) {
  return token.quoted || isMultiHump(token.text) || isSnakeCase(token.text);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function hasIndexedExtension(token) {
  const extension = extensionOf(token);
  return INDEXED_EXTENSIONS.includes(extension) || PATH_ONLY_EXTENSIONS.includes(extension);
}

/**
 * @param {string} token
 * @param {string[] | undefined} paths
 * @param {2 | 3} rule
 * @returns {Anchor | { paths: string[] } | null}
 */
function pickOne(token, paths, rule) {
  if (!paths || paths.length === 0) return null;
  if (paths.length > 1) return { paths: [...paths] };
  return { token, rule, kind: 'file', target: paths[0] };
}

/**
 * What a near match is measured against: the name part of a path, the last part of a dotted name.
 * @param {string} token
 * @returns {string}
 */
function candidateKey(token) {
  let name = token.replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  const extension = extensionOf(name);
  if (INDEXED_EXTENSIONS.includes(extension) || PATH_ONLY_EXTENSIONS.includes(extension)) name = name.slice(0, -extension.length);
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(name)) name = name.slice(name.lastIndexOf('.') + 1);
  return name.toLowerCase();
}

/**
 * @param {string} literal
 * @returns {(text: string) => boolean}
 */
function createLiteralMatcher(literal) {
  if (!/^\w+$/.test(literal)) return (text) => text.includes(literal);
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${literal}(?![A-Za-z0-9_])`);
  return (text) => pattern.test(text);
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string} value
 */
function appendTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
