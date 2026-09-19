// Bounded workspace facts. Detector objects can contain script bodies and configuration values;
// only this explicit projection is shareable. No manifest or raw detector result is exported.
import path from 'node:path';
import { sha256Hex } from '../core/hash.js';
import { isFile, joinProjectPath } from '../unity/fs-view.js';
import { findUnityProjectRoot } from '../unity/root.js';
import { scanUnityProject } from '../unity/scan.js';
import { detectVcs } from '../unity/vcs.js';
import { discoverComponents, findWorkspaceRoot } from './discover.js';
import { detectNodeService } from './components/node-service.js';
import { detectDotnetService } from './components/dotnet-service.js';
import { detectDatabase } from './components/database.js';
import { readFirebaseFacts } from './components/firebase.js';

/** The scanner also works as a standalone API; config v2 supplies these settings to init. */
export const DEFAULT_WORKSPACE_OPTIONS = Object.freeze({
  components: 'auto', maxComponents: 12, factsBudgetChars: 2600, unityBlockChars: 1100,
  componentBlockChars: 200, maxRenderedBlocks: 6, walkEntryCap: 50000, readBudgetBytes: 6291456,
});

/**
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} start
 * @param {{ env?: Record<string, string | undefined>, explicit?: boolean }} [options]
 */
export function resolveWorkspaceProjectRoot(view, start, { env = {}, explicit = false } = {}) {
  const absolute = path.resolve(start);
  const unity = findUnityProjectRoot(view, absolute);
  if (unity !== null) return unity;
  if (explicit) return absolute;
  const workspace = findWorkspaceRoot(view, absolute, { env });
  if (workspace.source === 'vcs') return workspace.root;
  // A standalone service need not have version control initialized yet.
  for (let current = absolute; ; current = path.dirname(current)) {
    if (['package.json', 'firebase.json'].some((file) => isFile(view, path.join(current, file))) ||
        view.readDir(current).some((entry) => entry.isFile && entry.name.endsWith('.csproj'))) return current;
    if (path.dirname(current) === current) return absolute;
  }
}

/**
 * @typedef {{ id: string, kind: string, dir: string, declaredBy: string, status: string,
 *   attachedTo: string | null, details: Record<string, any> }} WorkspaceComponent
 * @typedef {{ root: string, components: WorkspaceComponent[], unityScans: Map<string, import('../unity/scan.js').ScanResult>,
 *   unityOnly: boolean, truncated: boolean, warnings: string[], inputsHash: string, vcsKind: string,
 *   options: Record<string, any> }} WorkspaceScan
 */

/**
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root
 * @param {{ env?: Record<string, string | undefined>, settings?: Record<string, any>, dotnetSdks?: string[] | null }} [options]
 * @returns {WorkspaceScan}
 */
export function scanWorkspace(view, root, { env = {}, settings = {}, dotnetSdks = null } = {}) {
  const options = readWorkspaceOptions(settings);
  const discovery = discoverComponents(view, root, { limits: { walkEntryCap: options.walkEntryCap, workspaceBytes: options.readBudgetBytes } });
  const candidates = [...discovery.anchors, ...discovery.overlays];
  const selected = candidates.filter((item) => options.components === 'auto' ||
    (options.components === 'unity-only' ? item.kind === 'unity-client' :
      Array.isArray(options.components) && options.components.includes(item.id)));
  const unityOnly = selected.length === 1 && selected[0].kind === 'unity-client' && selected[0].dir === '';
  /** @type {WorkspaceComponent[]} */
  const components = [];
  /** @type {WorkspaceScan['unityScans']} */
  const unityScans = new Map();
  const warnings = [...discovery.notes];
  const { files } = discovery.walk;
  let unityReadTruncated = false;
  for (const item of selected.slice(0, options.maxComponents)) {
    let status = item.status;
    /** @type {Record<string, any>} */
    let details = {};
    if (item.kind === 'unity-client') {
      // The legacy command owns the unchanged Unity-only scan and its SDK probe.
      if (!unityOnly) {
        /** @type {import('../unity/fs-view.js').FsView} */
        const unityView = { ...view, readText(file, readOptions = {}) {
          const relative = path.relative(root, file).split(path.sep).join('/');
          // Machine-local OpenCode configuration is irrelevant to a shareable workspace brief.
          if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
          const read = discovery.budget.readText(relative, { component: item.id, ...readOptions });
          if (read.truncated || read.status === 'unbudgeted') unityReadTruncated = true;
          return read.status === 'ok' ? { text: read.text ?? '', truncated: read.truncated, size: read.size } : null;
        } };
        const scan = scanUnityProject(unityView, path.join(root, item.dir), { env, dotnetSdks, maxWalkEntries: options.walkEntryCap });
        unityScans.set(item.id, scan);
        details = { version: scan.unity.editorVersion, pipeline: scan.packages.pipeline, assemblies: scan.assemblies.definitions.length, sources: scan.sources.files };
      }
    } else if (item.kind === 'node-service') {
      const node = detectNodeService(discovery.budget, { ...item, files, workspaceRoot: discovery.workspaceRoot, component: `node:${item.dir}` });
      status = node.status;
      details = { frameworks: node.frameworks, packageManager: node.packageManager.name, typescript: node.typescript.present,
        testRunner: node.testRunner, scripts: ['test', 'build', 'typecheck', 'check'].filter((name) => Object.hasOwn(node.scripts, name)),
        entry: node.entry.path, routes: node.routes.length };
      warnings.push(...node.warnings);
    } else if (item.kind === 'dotnet-service') {
      const dotnet = detectDotnetService(discovery.budget, { ...item, files });
      status = dotnet.status;
      details = { sdk: dotnet.sdk === 'Microsoft.NET.Sdk.Web' ? dotnet.sdk : null,
        targetFramework: /^net\d[\w.;-]{0,60}$/.test(dotnet.targetFramework ?? '') ? dotnet.targetFramework : null,
        efCore: dotnet.efCore, testProjects: dotnet.testProjects.length };
      warnings.push(...dotnet.warnings);
    } else if (item.kind === 'firebase-project') {
      const firebase = readFirebaseFacts(discovery.budget, { dir: item.dir, component: item.id });
      status = firebase.status === 'ok' ? 'ok' : firebase.status === 'unbudgeted' ? 'unbudgeted' : 'unreadable';
      details = { products: firebase.products.filter((name) => ['functions', 'firestore', 'storage', 'database', 'hosting', 'auth', 'extensions', 'emulators'].includes(name)),
        codebases: firebase.codebases.length, rulesFiles: firebase.rulesFiles.length, emulators: Object.keys(firebase.emulators).sort() };
      warnings.push(...firebase.warnings);
    } else if (item.kind === 'database') {
      const database = detectDatabase(discovery.budget, { ...item, files, dirs: discovery.walk.dirs, maxEnvKeys: 0 });
      status = database.status;
      details = { tool: database.tool, models: database.modelCount, migrations: database.migrations.count,
        dialect: ['postgresql', 'postgres', 'mysql', 'sqlite', 'sqlite3', 'sqlserver', 'mongodb', 'cockroachdb', 'turso', 'singlestore'].includes(database.dialect ?? '') ? database.dialect : null };
      warnings.push(...database.warnings);
    }
    components.push({ id: item.id, kind: item.kind, dir: item.dir, declaredBy: item.declaredBy, status, attachedTo: item.attachedTo, details });
  }
  const truncated = discovery.walk.truncated || discovery.walk.depthLimited || discovery.budget.state.exhausted ||
    unityReadTruncated || discovery.budget.state.refused.some((entry) => entry.startsWith('unbudgeted ')) || selected.length > components.length;
  if (selected.length > components.length) warnings.push('component.limit-reached');
  // Safe facts plus file metadata invalidate the brief when code/configuration changes, without
  // opening secret files or publishing their hashes. Only the aggregate digest is retained.
  const inputFiles = [...new Set([...files, ...discovery.budget.state.opened])].sort();
  const stamps = inputFiles.map((file) => {
    const stat = view.stat(joinProjectPath(root, file));
    return [file, stat?.size ?? 0, stat?.mtimeMs ?? 0];
  });
  const vcsKind = detectVcs(view, root, { env }).kind;
  const inputsHash = sha256Hex(JSON.stringify({ options, components, stamps, vcsKind, truncated }));
  return { root, components, unityScans, unityOnly, truncated, warnings: [...new Set(warnings)], inputsHash, vcsKind, options };
}

/**
 * Session freshness uses the stored discovery settings so a custom limit hashes identically.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root
 * @param {Record<string, any>} projectJson
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function getWorkspaceInputsHash(view, root, projectJson, { env = {} } = {}) {
  return scanWorkspace(view, root, { env, settings: projectJson.workspace?.settings ?? {} }).inputsHash;
}

/** Stored project.json is also an input: it cannot enlarge a scan beyond config's hard limits.
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function readWorkspaceOptions(settings) {
  /** @type {Record<string, any>} */
  const options = { ...DEFAULT_WORKSPACE_OPTIONS };
  const limits = { maxComponents: [1, 64], factsBudgetChars: [500, 20000], unityBlockChars: [100, 20000],
    componentBlockChars: [50, 2000], maxRenderedBlocks: [1, 64], walkEntryCap: [1, 500000], readBudgetBytes: [1, 67108864] };
  for (const [key, [minimum, maximum]] of Object.entries(limits)) {
    const value = settings[key];
    if (Number.isInteger(value) && value >= minimum && value <= maximum) options[key] = value;
  }
  if (settings.components === 'unity-only') options.components = 'unity-only';
  else if (Array.isArray(settings.components)) options.components = settings.components.filter((value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)).slice(0, 64);
  return options;
}
