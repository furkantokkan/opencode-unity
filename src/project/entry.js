// Entry-point resolution for a node service (amendment 37.4, `D-B9`, area 14.6.4).
//
// The entry point is where the one-hop route scan starts, so it is resolved from declarations the
// package already makes - `bin`, `scripts.start`, `main`, `exports` - and only then from convention.
// Nothing here opens a file: existence is decided against the discovery walk's file list, which the
// workspace scan already produced, so a wrong guess costs no read budget at all.
//
// The compiled-entry problem is the reason this is a module rather than four lines in the detector.
// A TypeScript service declares `dist/server.js`, which is generated, absent from a fresh clone, and
// useless to a model. `tsconfig.json`'s `outDir` and `rootDir` (claim B35) map it back to the source
// that produced it; when they cannot, the entry is recorded as compiled-only and **no routes are
// extracted**, because the alternative is describing generated code as if it were the project.
import { toPosix, toProjectPath } from '../unity/fs-view.js';
import { evidenceRow } from './signatures.js';

/** Source extensions first: a declared `.js` beside a `.ts` of the same name is the build output. */
export const ENTRY_EXTENSIONS = Object.freeze(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

/** Tried in order when nothing is declared (14.6.4). */
export const CONVENTIONAL_ENTRIES = Object.freeze(['src/index', 'src/server', 'src/app', 'src/main', 'index', 'server', 'app']);

/** A compiled spelling whose source sibling is worth trying when the file itself is absent. */
const COMPILED_TO_SOURCE = Object.freeze({ '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] });

/** @typedef {'bin' | 'scripts.start' | 'main' | 'exports' | 'convention'} EntrySource */

/**
 * @typedef {object} EntryFacts
 * @property {string | null} path       POSIX, relative to the workspace root; a file the walk saw.
 * @property {string | null} declared   What the package declared, relative to the workspace root.
 * @property {EntrySource | null} source
 * @property {boolean} mapped           The `outDir` -> `rootDir` mapping was applied.
 * @property {boolean} compiledOnly     A build output was declared and no source could be found.
 * @property {import('./signatures.js').EvidenceEntry[]} evidence
 */

/**
 * @typedef {object} TypeScriptPaths
 * @property {string | null} outDir     Relative to the component directory, as declared.
 * @property {string | null} rootDir
 */

/**
 * @param {object} options
 * @param {string} options.dir                     Component directory, relative to the workspace root.
 * @param {Record<string, unknown> | null} options.manifest  The `package.json` discovery already read.
 * @param {readonly string[]} options.files         The discovery walk's file list.
 * @param {TypeScriptPaths} [options.typescript]
 * @returns {EntryFacts}
 */
export function resolveEntry({ dir, manifest, files, typescript = { outDir: null, rootDir: null } }) {
  /** @type {EntryFacts} */
  const facts = { path: null, declared: null, source: null, mapped: false, compiledOnly: false, evidence: [] };

  for (const candidate of declaredEntries(manifest)) {
    const declared = joinInsideWorkspace(dir, candidate.value);
    if (declared === null) continue;
    facts.declared = declared;
    facts.source = candidate.source;

    const direct = resolveModulePath(files, dir, candidate.value);
    if (direct !== null) {
      facts.path = direct;
      facts.evidence.push(evidenceRow('entry', 'spec:37.4', direct));
      return facts;
    }

    const source = mapCompiledPath(dir, candidate.value, typescript);
    if (source !== null) {
      const mapped = resolveModulePath(files, dir, source);
      if (mapped !== null) {
        facts.path = mapped;
        facts.mapped = true;
        facts.evidence.push(evidenceRow('entry', 'spec:37.4', mapped));
        return facts;
      }
      // The declaration points into the build output and nothing in the source tree matches it.
      facts.compiledOnly = true;
      return facts;
    }
    // A declaration that resolves to nothing at all is not evidence of a compiled entry; the next
    // declaration, and then convention, still get their turn.
    facts.declared = null;
    facts.source = null;
  }

  for (const base of CONVENTIONAL_ENTRIES) {
    const resolved = resolveModulePath(files, dir, `./${base}`);
    if (resolved === null) continue;
    facts.path = resolved;
    facts.source = 'convention';
    facts.evidence.push(evidenceRow('entry', 'spec:37.4', resolved));
    return facts;
  }

  return facts;
}

/**
 * The declaration order of 14.6.4. Every value is repository content, so it is normalised and checked
 * before it is used as a path.
 * @param {Record<string, unknown> | null} manifest
 * @returns {Array<{ source: EntrySource, value: string }>}
 */
function declaredEntries(manifest) {
  /** @type {Array<{ source: EntrySource, value: string }>} */
  const entries = [];
  if (manifest === null) return entries;

  const bin = manifest.bin;
  if (typeof bin === 'string') entries.push({ source: 'bin', value: bin });
  else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    const first = Object.values(/** @type {Record<string, unknown>} */ (bin)).find((value) => typeof value === 'string');
    if (typeof first === 'string') entries.push({ source: 'bin', value: first });
  }

  const scripts = manifest.scripts;
  const start = scripts !== null && typeof scripts === 'object' ? /** @type {Record<string, unknown>} */ (scripts).start : undefined;
  if (typeof start === 'string') {
    const token = pathTokenOf(start);
    if (token !== null) entries.push({ source: 'scripts.start', value: token });
  }

  if (typeof manifest.main === 'string') entries.push({ source: 'main', value: manifest.main });

  const exported = exportsEntry(manifest.exports);
  if (exported !== null) entries.push({ source: 'exports', value: exported });

  return entries;
}

/**
 * `exports` may be a string, a conditions object, or a subpath map whose `.` key holds either.
 * @param {unknown} value
 * @returns {string | null}
 */
function exportsEntry(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const root = record['.'] ?? record;
  if (typeof root === 'string') return root;
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return null;
  for (const condition of ['import', 'default', 'require', 'node']) {
    const candidate = /** @type {Record<string, unknown>} */ (root)[condition];
    if (typeof candidate === 'string') return candidate;
  }
  return null;
}

/**
 * The last token of a start script that looks like a path: it carries a separator or a module
 * extension, and it is not a flag. `node --enable-source-maps dist/server.js` therefore yields the
 * file and not the flag, and `nodemon src --watch src` yields nothing rather than a directory.
 * @param {string} script
 * @returns {string | null}
 */
export function pathTokenOf(script) {
  /** @type {string | null} */
  let found = null;
  for (const rawToken of script.split(/\s+/)) {
    const token = rawToken.replace(/^['"]+|['"]+$/g, '');
    if (token === '' || token.startsWith('-')) continue;
    const normalized = toPosix(token);
    const hasExtension = ENTRY_EXTENSIONS.some((extension) => normalized.toLowerCase().endsWith(extension));
    if (normalized.includes('/') || hasExtension) found = normalized;
  }
  return found;
}

/**
 * Resolves a specifier the way the walk sees the tree: the file itself, then the source spellings of
 * a compiled name, then an extensionless name, then its `index` file. Never a read, never a stat.
 * Matching is exact-case against the walk's own spelling, so the answer does not depend on whether the
 * volume underneath happens to be case-sensitive.
 * @param {readonly string[]} files   POSIX paths relative to the workspace root.
 * @param {string} fromDir            POSIX directory the specifier is relative to.
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveModulePath(files, fromDir, specifier) {
  const base = joinInsideWorkspace(fromDir, specifier);
  if (base === null) return null;
  const lower = base.toLowerCase();

  if (files.includes(base)) return base;

  const dot = lower.lastIndexOf('.');
  const extension = dot > lower.lastIndexOf('/') ? lower.slice(dot) : '';
  for (const candidate of COMPILED_TO_SOURCE[/** @type {keyof typeof COMPILED_TO_SOURCE} */ (extension)] ?? []) {
    const sibling = `${base.slice(0, base.length - extension.length)}${candidate}`;
    if (files.includes(sibling)) return sibling;
  }
  if (extension !== '') return null;

  for (const candidate of ENTRY_EXTENSIONS) {
    if (files.includes(`${base}${candidate}`)) return `${base}${candidate}`;
  }
  for (const candidate of ENTRY_EXTENSIONS) {
    if (files.includes(`${base}/index${candidate}`)) return `${base}/index${candidate}`;
  }
  return null;
}

/**
 * The `outDir` -> `rootDir` mapping of claim B35, applied to a path relative to the component.
 * @param {string} dir
 * @param {string} specifier
 * @param {TypeScriptPaths} typescript
 * @returns {string | null}  A specifier relative to the component directory, or null when the path is
 *   not inside `outDir` or the configuration does not name both folders.
 */
export function mapCompiledPath(dir, specifier, typescript) {
  const outDir = normalizeFolder(typescript.outDir);
  const rootDir = normalizeFolder(typescript.rootDir);
  if (outDir === null || rootDir === null) return null;

  const relative = joinInsideWorkspace(dir, specifier);
  const inside = joinInsideWorkspace(dir, outDir);
  if (relative === null || inside === null) return null;
  if (!relative.startsWith(`${inside}/`)) return null;

  const tail = relative.slice(inside.length + 1);
  return rootDir === '.' ? `./${tail}` : `./${rootDir}/${tail}`;
}

/**
 * @param {string | null} value
 * @returns {string | null}
 */
function normalizeFolder(value) {
  if (typeof value !== 'string') return null;
  const normalized = toPosix(value).replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

/**
 * Every path here comes out of a `package.json` or a source file, which S15 declares untrusted, so a
 * specifier that leaves the workspace resolves to nothing rather than to a path outside the tree the
 * deny globs describe.
 *
 * `..` is resolved rather than refused, because `import './../routes/game.js'` is an ordinary relative
 * import and `toProjectPath` rejects the segment outright; a `..` that would climb above the workspace
 * root still resolves to null. The result is passed through `toProjectPath` anyway, so an absolute
 * path and a Windows drive letter are refused by the same function the committed files use.
 * @param {string} dir
 * @param {string} relativePath
 * @returns {string | null}
 */
export function joinInsideWorkspace(dir, relativePath) {
  const slashed = toPosix(relativePath);
  // Checked before the segments are folded: a leading separator would otherwise be dropped with the
  // empty first segment and `/etc/passwd` would quietly become a workspace path.
  if (slashed.startsWith('/')) return null;
  /** @type {string[]} */
  const segments = [];
  for (const segment of `${dir}/${slashed}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  try {
    return toProjectPath(segments.join('/'));
  } catch {
    return null;
  }
}
