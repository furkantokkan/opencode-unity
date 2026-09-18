// The `node-service` detector (amendment 37.3-37.4, `D-B5`, `D-B9`, `D-B12`, area 14.6.3-14.6.4).
//
// One `package.json` per component, and discovery has already read it: this module is handed that
// manifest rather than opening it again, so the only files it can open are `tsconfig.json`, the entry
// point and the entry's at most three literal relative imports.
//
// Two negatives shape it. A lock file is **listed, never parsed** (claims B5, B6, B3, B7): the file
// name is the evidence, its content is megabytes of no interest, and the read budget refuses to open
// one at all. And a `.env` beside the manifest is recorded as a **path**, never opened and never read
// past its name, which is what `component.secret-file-present` reports at INFO.
//
// The package manager is resolved from the lock file, with `packageManager` as a second opinion rather
// than an authority: it is a Corepack hint (claim B8), so a disagreement is reportable rather than a
// coin flip, and the rendered verify command of S57 depends on getting this right.
import { joinProjectPath } from '../../unity/fs-view.js';
import { evidenceRow } from '../signatures.js';
import { asObject, isWithin } from '../discover.js';
import { extractRoutes } from '../routes.js';
import { resolveEntry } from '../entry.js';
import { ENV_EXAMPLE_FILES } from '../envexample.js';

/**
 * Lock file to package manager, in resolution order. Two managers in one folder is a conflict the
 * user has to settle, and the first row wins only so that the result is deterministic.
 * @type {ReadonlyArray<{ manager: 'npm' | 'yarn' | 'pnpm' | 'bun', files: readonly string[], signature: string }>}
 */
export const LOCK_FILES = Object.freeze([
  { manager: /** @type {const} */ ('npm'), files: ['package-lock.json', 'npm-shrinkwrap.json'], signature: 'node/package-manager.npm' },
  { manager: /** @type {const} */ ('yarn'), files: ['yarn.lock'], signature: 'node/package-manager.yarn' },
  { manager: /** @type {const} */ ('pnpm'), files: ['pnpm-lock.yaml'], signature: 'node/package-manager.pnpm' },
  { manager: /** @type {const} */ ('bun'), files: ['bun.lock', 'bun.lockb'], signature: 'node/package-manager.bun' },
]);

/** Dependency-declared frameworks, in the order they are rendered. Every name has a signature row. */
const FRAMEWORKS = Object.freeze([
  { name: 'express', signature: 'node/framework.express' },
  { name: 'fastify', signature: 'node/framework.fastify' },
  { name: 'firebase-functions', signature: 'node/framework.firebase-functions' },
  { name: 'firebase-admin', signature: 'node/framework.firebase-admin' },
]);

/** Test runners. The built-in runner is a script body, the other two are dependencies (claims B9, B10). */
const TEST_RUNNERS = Object.freeze([
  { name: 'vitest', signature: 'node/test-runner.vitest' },
  { name: 'jest', signature: 'node/test-runner.jest' },
]);

const BUILT_IN_TEST_RUNNER = 'node --test';

export const TSCONFIG_FILE = 'tsconfig.json';

/**
 * `D-B5`: at most 64 member patterns are expanded, because this is where a repository can make
 * discovery quadratic and a cap is cheaper than cleverness.
 */
export const MAX_WORKSPACE_MEMBERS = 64;

const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

/** `"npm@10.9.0"`, `"yarn@3.2.3+sha224...."`: the name is what this product compares. */
const PACKAGE_MANAGER_FIELD = /^([a-z]+)@?/i;

/**
 * @typedef {object} PackageManagerFacts
 * @property {'npm' | 'yarn' | 'pnpm' | 'bun' | null} name
 * @property {string | null} evidence   The lock file that decided it, relative to the workspace root.
 * @property {string | null} declared   The `packageManager` field, verbatim.
 * @property {boolean} conflict         Two managers' lock files in one folder.
 * @property {boolean} mismatch         The declared manager is not the one the lock file names.
 * @property {string[]} lockFiles       Paths, sorted. Listed, never opened.
 * @property {boolean} inherited        Resolved from an ancestor folder's lock file.
 */

/**
 * @typedef {object} TypeScriptFacts
 * @property {boolean} present
 * @property {string | null} config
 * @property {string | null} outDir
 * @property {string | null} rootDir
 * @property {boolean} extended   The configuration extends another file, which is not followed.
 */

/**
 * @typedef {object} NodeServiceFacts
 * @property {'ok' | 'unreadable' | 'unbudgeted'} status
 * @property {string} dir
 * @property {string} declaredBy
 * @property {string | null} engines        `engines.node`, verbatim.
 * @property {'module' | 'commonjs' | null} moduleType
 * @property {PackageManagerFacts} packageManager
 * @property {TypeScriptFacts} typescript
 * @property {string | null} testRunner
 * @property {string[]} frameworks
 * @property {Record<string, string>} scripts   Names and bodies; S57 classifies a body before allowing it.
 * @property {string[]} dependencyNames         Sorted key set, never versions (37.5).
 * @property {import('../entry.js').EntryFacts} entry
 * @property {import('../routes.js').RouteEntry[]} routes
 * @property {number[]} listenPorts             Literal `listen` ports in the entry file (37.8).
 * @property {string[]} routeSources
 * @property {boolean} routesTruncated
 * @property {boolean} workspaceMember
 * @property {string[]} secretFiles         Paths present beside the manifest; never opened.
 * @property {import('../signatures.js').EvidenceEntry[]} evidence
 * @property {string[]} warnings
 */

/**
 * @param {string} dir
 * @param {string} declaredBy
 * @param {'ok' | 'unreadable' | 'unbudgeted'} status
 * @returns {NodeServiceFacts}
 */
function emptyFacts(dir, declaredBy, status) {
  return {
    status,
    dir,
    declaredBy,
    engines: null,
    moduleType: null,
    packageManager: { name: null, evidence: null, declared: null, conflict: false, mismatch: false, lockFiles: [], inherited: false },
    typescript: { present: false, config: null, outDir: null, rootDir: null, extended: false },
    testRunner: null,
    frameworks: [],
    scripts: {},
    dependencyNames: [],
    entry: { path: null, declared: null, source: null, mapped: false, compiledOnly: false, evidence: [] },
    routes: [],
    listenPorts: [],
    routeSources: [],
    routesTruncated: false,
    workspaceMember: false,
    secretFiles: [],
    evidence: [],
    // P7: a component that cannot be described is dropped, not guessed. An exhausted budget is a
    // different finding - `component.budget-dropped` at INFO - and is not reported as unreadable.
    warnings: status === 'unreadable' ? ['component.unreadable'] : [],
  };
}

/**
 * @param {import('../budget.js').ReadBudget} budget
 * @param {object} options
 * @param {string} options.dir                     Relative to the workspace root; '' is the root.
 * @param {string} [options.declaredBy]
 * @param {Record<string, unknown> | null} options.manifest  What discovery read; null means unreadable.
 * @param {readonly string[]} [options.files]      The discovery walk's file list.
 * @param {import('../discover.js').WorkspaceRootMarker} [options.workspaceRoot]
 * @param {string} [options.component]             The read-budget key; discovery uses `node:<dir>`.
 * @param {boolean} [options.extractRoutes]        False when the caller only wants the cheap facts.
 * @param {import('../../unity/fs-view.js').FsView} [options.view]  For the `.env` listing only.
 * @param {string} [options.root]                  Absolute workspace root; required with `view`.
 * @returns {NodeServiceFacts}
 */
export function detectNodeService(budget, { dir, declaredBy = joinRelative(dir, 'package.json'), manifest, files = [], workspaceRoot, component = `node:${dir}`, extractRoutes: wantRoutes = true, view, root = '' }) {
  if (manifest === null) return emptyFacts(dir, declaredBy, budget.statusFor(component) === 'unbudgeted' ? 'unbudgeted' : 'unreadable');

  const facts = emptyFacts(dir, declaredBy, 'ok');
  facts.evidence.push(evidenceRow('anchor', 'node/anchor.package-json', declaredBy));

  const engines = asObject(manifest.engines)?.node;
  if (typeof engines === 'string') facts.engines = engines;
  const moduleType = manifest.type;
  if (moduleType === 'module' || moduleType === 'commonjs') facts.moduleType = moduleType;

  facts.scripts = readScripts(manifest);
  facts.dependencyNames = dependencyNames(manifest);
  facts.workspaceMember = isWorkspaceMember(dir, workspaceRoot);

  readPackageManager(facts, manifest, files);
  readFrameworks(facts);
  readTestRunner(facts);
  readTypeScript(facts, budget, files, component);
  readSecretFiles(facts, view ?? null, root);

  facts.entry = resolveEntry({ dir, manifest, files, typescript: facts.typescript });
  facts.evidence.push(...facts.entry.evidence);

  // A compiled-only entry is generated code: describing its routes would describe the build output as
  // if it were the project, so the scan does not start (14.6.4).
  if (wantRoutes && facts.entry.path !== null && !facts.entry.compiledOnly) {
    const routes = extractRoutes(budget, { entry: facts.entry.path, files, component });
    facts.routes = routes.routes;
    facts.listenPorts = routes.listenPorts;
    facts.routeSources = routes.sources;
    facts.routesTruncated = routes.truncated;
    facts.evidence.push(...routes.evidence);
  }

  return facts;
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, string>}
 */
function readScripts(manifest) {
  /** @type {Record<string, string>} */
  const scripts = {};
  const declared = asObject(manifest.scripts) ?? {};
  for (const name of Object.keys(declared).sort()) {
    const body = declared[name];
    if (typeof body === 'string') scripts[name] = body;
  }
  return scripts;
}

/**
 * Key sets, never versions: 37.5 excludes dependency versions from `inputsHash` on purpose, so a patch
 * bump does not force a re-scan on every `start`.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function dependencyNames(manifest) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(asObject(manifest[field]) ?? {})) names.add(name);
  }
  return [...names].sort();
}

/**
 * @param {NodeServiceFacts} facts
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} files
 */
function readPackageManager(facts, manifest, files) {
  const declared = manifest.packageManager;
  if (typeof declared === 'string' && declared.trim() !== '') facts.packageManager.declared = declared;

  const own = lockFilesIn(facts.dir, files);
  const inherited = own.length === 0 ? nearestAncestorLockFiles(facts.dir, files) : [];
  const resolved = own.length > 0 ? own : inherited;

  facts.packageManager.lockFiles = resolved.map((entry) => entry.path).sort();
  facts.packageManager.conflict = new Set(resolved.map((entry) => entry.manager)).size > 1;
  facts.packageManager.inherited = own.length === 0 && inherited.length > 0;
  if (facts.packageManager.conflict) facts.warnings.push('component.lockfile-conflict');

  const chosen = resolved[0];
  if (chosen !== undefined) {
    facts.packageManager.name = chosen.manager;
    facts.packageManager.evidence = chosen.path;
    facts.evidence.push(evidenceRow('package-manager', chosen.signature, chosen.path));
  } else if (facts.packageManager.declared !== null) {
    // No lock file at all: the Corepack hint is the only evidence there is, so it is used and said so.
    facts.packageManager.name = declaredManager(facts.packageManager.declared);
  }

  if (facts.packageManager.declared !== null) facts.evidence.push(evidenceRow('package-manager', 'node/package-manager.declared', facts.declaredBy));

  const declaredName = declaredManager(facts.packageManager.declared);
  if (declaredName !== null && chosen !== undefined && declaredName !== chosen.manager) {
    facts.packageManager.mismatch = true;
    facts.warnings.push('component.packagemanager-mismatch');
  }
}

/**
 * @param {string | null} value
 * @returns {'npm' | 'yarn' | 'pnpm' | 'bun' | null}
 */
export function declaredManager(value) {
  if (value === null) return null;
  const name = PACKAGE_MANAGER_FIELD.exec(value.trim())?.[1]?.toLowerCase();
  return LOCK_FILES.some((row) => row.manager === name) ? /** @type {'npm' | 'yarn' | 'pnpm' | 'bun'} */ (name) : null;
}

/**
 * @param {string} dir
 * @param {readonly string[]} files
 * @returns {Array<{ manager: 'npm' | 'yarn' | 'pnpm' | 'bun', path: string, signature: string }>}
 */
function lockFilesIn(dir, files) {
  /** @type {Array<{ manager: 'npm' | 'yarn' | 'pnpm' | 'bun', path: string, signature: string }>} */
  const found = [];
  for (const row of LOCK_FILES) {
    for (const name of row.files) {
      const candidate = joinRelative(dir, name);
      if (files.includes(candidate)) found.push({ manager: row.manager, path: candidate, signature: row.signature });
    }
  }
  return found;
}

/**
 * A workspace member has no lock file of its own; the one that installed it is at an ancestor folder.
 * @param {string} dir
 * @param {readonly string[]} files
 * @returns {Array<{ manager: 'npm' | 'yarn' | 'pnpm' | 'bun', path: string, signature: string }>}
 */
function nearestAncestorLockFiles(dir, files) {
  let current = dir;
  while (current !== '') {
    current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    const found = lockFilesIn(current, files);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * @param {NodeServiceFacts} facts
 */
function readFrameworks(facts) {
  for (const framework of FRAMEWORKS) {
    if (!facts.dependencyNames.includes(framework.name)) continue;
    facts.frameworks.push(framework.name);
    facts.evidence.push(evidenceRow('framework', framework.signature, facts.declaredBy));
  }
}

/**
 * The script body wins over the dependency, because the body is what actually runs: a project with
 * `vitest` in `devDependencies` and `node --test` in `scripts.test` uses the built-in runner.
 * @param {NodeServiceFacts} facts
 */
function readTestRunner(facts) {
  if (Object.values(facts.scripts).some((body) => body.includes(BUILT_IN_TEST_RUNNER))) {
    facts.testRunner = BUILT_IN_TEST_RUNNER;
    facts.evidence.push(evidenceRow('test-runner', 'node/test-runner.node', facts.declaredBy));
    return;
  }
  for (const runner of TEST_RUNNERS) {
    if (!facts.dependencyNames.includes(runner.name)) continue;
    facts.testRunner = runner.name;
    facts.evidence.push(evidenceRow('test-runner', runner.signature, facts.declaredBy));
    return;
  }
}

/**
 * `outDir` and `rootDir` are the two keys that make the compiled-entry mapping possible (claim B35).
 * A `tsconfig.json` may carry comments, which is not JSON, so a parse failure falls back to reading
 * exactly those two string values - and nothing else is taken from the file either way.
 * @param {NodeServiceFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} files
 * @param {string} component
 */
function readTypeScript(facts, budget, files, component) {
  const configPath = joinRelative(facts.dir, TSCONFIG_FILE);
  if (!files.includes(configPath)) return;

  facts.typescript.present = true;
  facts.typescript.config = configPath;
  facts.evidence.push(evidenceRow('framework', 'node/framework.typescript', configPath));

  const read = budget.readText(configPath, { component });
  if (read.status !== 'ok') return;
  const text = read.text ?? '';

  const parsed = parseJson(text);
  const options = asObject(asObject(parsed)?.compilerOptions);
  facts.typescript.extended = asObject(parsed)?.extends !== undefined || (parsed === undefined && /"extends"\s*:/.test(text));
  facts.typescript.outDir = typeof options?.outDir === 'string' ? options.outDir : stringValue(text, 'outDir');
  facts.typescript.rootDir = typeof options?.rootDir === 'string' ? options.rootDir : stringValue(text, 'rootDir');
}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} text
 * @param {string} key
 * @returns {string | null}
 */
function stringValue(text, key) {
  return new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text)?.[1] ?? null;
}

/**
 * Paths, never contents: `doctor` reports `component.secret-file-present` at INFO by listing the files
 * it refused to open, which is the opposite of reading them.
 *
 * A directory **listing** is what finds them, because a `.env` is hidden and the discovery walk skips
 * every hidden entry, and because the read budget - correctly - refuses a denied path before it can
 * learn whether it exists. Listing a folder opens no file and consumes no read budget.
 * @param {NodeServiceFacts} facts
 * @param {import('../../unity/fs-view.js').FsView | null} view
 * @param {string} root
 */
function readSecretFiles(facts, view, root) {
  if (view === null) return;
  for (const entry of view.readDir(joinProjectPath(root, facts.dir))) {
    // Compared without case, like the read deny set: a `.ENV` on a case-insensitive volume is the
    // same file to every tool that loads it.
    const name = entry.name.toLowerCase();
    if (!entry.isFile || !name.startsWith('.env')) continue;
    if (ENV_EXAMPLE_FILES.includes(name)) continue;
    facts.secretFiles.push(joinRelative(facts.dir, entry.name));
  }
  facts.secretFiles.sort();
  if (facts.secretFiles.length > 0) facts.warnings.push('component.secret-file-present');
}

/**
 * @param {string} dir
 * @param {import('../discover.js').WorkspaceRootMarker | undefined} workspaceRoot
 * @returns {boolean}
 */
function isWorkspaceMember(dir, workspaceRoot) {
  if (workspaceRoot === undefined || !workspaceRoot.present || dir === '') return false;
  // A marker with no declared members is a `pnpm-workspace.yaml`, which this product does not parse
  // (it is YAML, and the file's presence is all the marker rule needs). Every package under such a
  // root is installed by it, so membership is the honest default rather than an unknown.
  if (workspaceRoot.members.length === 0) return true;
  return expandWorkspaceMembers(workspaceRoot.members).patterns.some((pattern) => matchesMember(dir, pattern));
}

/**
 * @typedef {object} ExpandedMembers
 * @property {Array<{ prefix: string, depth: 'exact' | 'one' | 'any' }>} patterns
 * @property {string[]} unexpanded   Globs outside the supported subset, verbatim.
 * @property {boolean} truncated     More than `MAX_WORKSPACE_MEMBERS` patterns were declared.
 */

/**
 * `D-B5`: a deliberately small glob subset - a literal path, a trailing `/*`, a trailing `/**`. Any
 * other pattern is not expanded; the members are found by the ordinary walk instead, and the caller
 * reports `component.glob-unexpanded` at INFO.
 * @param {readonly string[]} members
 * @param {{ maxMembers?: number }} [options]
 * @returns {ExpandedMembers}
 */
export function expandWorkspaceMembers(members, { maxMembers = MAX_WORKSPACE_MEMBERS } = {}) {
  /** @type {ExpandedMembers} */
  const expanded = { patterns: [], unexpanded: [], truncated: false };
  for (const member of members) {
    if (expanded.patterns.length >= maxMembers) {
      expanded.truncated = true;
      break;
    }
    const value = member.trim().replace(/^\.\//, '').replace(/^!/, '');
    const depth = value.endsWith('/**') ? /** @type {const} */ ('any') : value.endsWith('/*') ? /** @type {const} */ ('one') : /** @type {const} */ ('exact');
    const prefix = depth === 'any' ? value.slice(0, -3) : depth === 'one' ? value.slice(0, -2) : value;
    // A `*` anywhere else, a `..` segment or an absolute path is outside the subset: not expanded,
    // not resolved, and never turned into a path this product reads.
    if (member.startsWith('!') || prefix.includes('*') || prefix.split('/').includes('..') || prefix.startsWith('/') || /^[A-Za-z]:/.test(prefix) || prefix === '') {
      expanded.unexpanded.push(member);
      continue;
    }
    expanded.patterns.push({ prefix, depth });
  }
  return expanded;
}

/**
 * @param {string} dir
 * @param {{ prefix: string, depth: 'exact' | 'one' | 'any' }} pattern
 * @returns {boolean}
 */
function matchesMember(dir, pattern) {
  if (pattern.depth === 'exact') return dir === pattern.prefix;
  if (!isWithin(dir, pattern.prefix) || dir === pattern.prefix) return false;
  const tail = dir.slice(pattern.prefix.length + 1);
  return pattern.depth === 'any' ? true : !tail.includes('/');
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function joinRelative(dir, name) {
  return dir === '' ? name : `${dir}/${name}`;
}
