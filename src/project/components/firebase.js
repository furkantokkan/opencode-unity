// The one `firebase.json` and `.firebaserc` reader (amendment 37.8, build step S54).
//
// A1.2 made this a module of its own for a reason: A1.1 had the network lane and the component lane
// both parsing the same two files in two milestones, and both doing their own collision detection.
// This module returns one typed `FirebaseFacts` object; every other module consumes it and none
// re-parses. Port collision detection belongs to the one port table in S39, which reads these facts.
//
// Two rules bound what it reads. It opens exactly two files, both of which are configuration a team
// commits, and neither of which is a secret: `firebase.json` and `.firebaserc`. Service-account keys,
// `.runtimeconfig.json` and `google-services.json` sit in the read deny set and are refused by the
// budget before a handle is opened (D-B7), and a functions runtime therefore comes from `engines.node`
// in the source's own `package.json` or from `functions.runtime`, never from a credential file.
//
// From `.firebaserc` only the alias **keys** are kept. The values are project ids: not secret, but not
// needed either, and matching the key is enough to build `deniedProjectSegments`, which is what refuses
// a functions URL aimed at a live project even when an emulator happens to answer for it (S-BM-9).
// A configuration written on Windows may spell a source with backslashes; the facts are POSIX.
//
// Every path taken out of `firebase.json` is repository content, which S15 declares untrusted, so it
// is joined and then checked with `toProjectPath`: it refuses an absolute path and a `..` segment.
// Without that, a crafted `"source": "../../elsewhere"` steers a metered read out of the workspace -
// where the deny globs no longer denote the tree being scanned - and lands verbatim in a committed
// fact, which is the machine path P6 and CP-D14 keep out of `project.json` and `facts.md`.
import { toPosix, toProjectPath } from '../../unity/fs-view.js';
import { asObject } from '../discover.js';
import { evidenceRow } from '../signatures.js';

export const FIREBASE_CONFIG_FILE = 'firebase.json';
export const FIREBASE_RC_FILE = '.firebaserc';

/** A project id or alias key beginning with this is an emulator-only id and is never denied. */
export const DEMO_PREFIX = 'demo-';

/** Products whose configuration may carry a `rules` file, in the order they are rendered. */
const RULES_PRODUCTS = Object.freeze(['firestore', 'storage', 'database']);

/** Raised once when a path in `firebase.json` names something outside the workspace root. */
const PATH_OUTSIDE_WARNING = 'firebase.path-outside-workspace';

/** Emulator names that carry a port in the documented comprehensive file. */
const EMULATOR_NAMES = Object.freeze(['auth', 'functions', 'firestore', 'database', 'hosting', 'pubsub', 'storage', 'eventarc', 'dataconnect', 'tasks', 'apphosting', 'extensions', 'ui', 'hub', 'logging', 'singleProjectMode']);

/** These two are the emulator suite's own surfaces, not a product a request may be aimed at. */
const NON_PRODUCT_EMULATORS = Object.freeze(['ui', 'hub', 'logging', 'singleProjectMode']);

/**
 * @typedef {object} FirebaseCodebase
 * @property {string} codebase        `default` when the configuration does not name one.
 * @property {string} source          POSIX, relative to the workspace root.
 * @property {string | null} runtime  For example `nodejs22`.
 * @property {string | null} runtimeSource  Which file and key the runtime came from.
 */

/**
 * @typedef {object} FirebaseFacts
 * @property {'ok' | 'absent' | 'unreadable' | 'unbudgeted'} status
 * @property {string} dir                    The folder holding `firebase.json`, relative to the root.
 * @property {string | null} declaredBy
 * @property {string[]} products             Configured product keys, sorted.
 * @property {FirebaseCodebase[]} codebases
 * @property {string[]} rulesFiles           Sorted, deduplicated, relative to the workspace root.
 * @property {string[]} indexFiles           Sorted, deduplicated, relative to the workspace root.
 * @property {Record<string, number>} emulators  Product emulator name -> configured port.
 * @property {Record<string, number>} suitePorts The suite's own surfaces (`ui`, `hub`, `logging`),
 *   kept apart because they are never a destination a request may be aimed at.
 * @property {string[]} aliases              Alias keys from `.firebaserc`, sorted.
 * @property {string[]} deniedProjectSegments  Every non-`demo-` alias key (37.8, S-BM-9).
 * @property {string[]} demoProjectIds       Alias values beginning with `demo-`, sorted. The only
 *   values ever recorded: a `demo-` id is emulator-only by construction, so it carries nothing.
 * @property {boolean | null} defaultAliasIsDemo  Null when there is no `default` alias.
 * @property {boolean} rcPresent
 * @property {import('../signatures.js').EvidenceEntry[]} evidence
 * @property {string[]} warnings             Doctor check ids this read raises.
 */

/**
 * @param {string} dir
 * @returns {FirebaseFacts}
 */
function emptyFacts(dir) {
  return {
    status: 'absent',
    dir,
    declaredBy: null,
    products: [],
    codebases: [],
    rulesFiles: [],
    indexFiles: [],
    emulators: {},
    suitePorts: {},
    aliases: [],
    deniedProjectSegments: [],
    demoProjectIds: [],
    defaultAliasIsDemo: null,
    rcPresent: false,
    evidence: [],
    warnings: [],
  };
}

/**
 * Reads one Firebase overlay.
 * @param {import('../budget.js').ReadBudget} budget
 * @param {{ dir?: string, component?: string, nodeManifests?: Record<string, unknown> }} [options]
 *   `nodeManifests` maps a source folder to the `package.json` S51 already read for it, so the runtime
 *   resolution costs no extra file open. A missing entry is read through the budget instead.
 * @returns {FirebaseFacts}
 */
export function readFirebaseFacts(budget, { dir = '', component = 'firebase', nodeManifests = {} } = {}) {
  const facts = emptyFacts(dir);
  const configPath = joinRelative(dir, FIREBASE_CONFIG_FILE);
  const read = budget.readJson(configPath, { component });
  if (read.status === 'missing') return facts;
  if (read.status !== 'ok' || read.error !== null) {
    // P7: a component that cannot be described is dropped, not guessed.
    return { ...facts, status: read.status === 'unbudgeted' ? 'unbudgeted' : 'unreadable', declaredBy: configPath, warnings: ['component.unreadable'] };
  }

  const config = asObject(read.value);
  if (config === null) return { ...facts, status: 'unreadable', declaredBy: configPath, warnings: ['component.unreadable'] };

  facts.status = 'ok';
  facts.declaredBy = configPath;
  facts.products = Object.keys(config).sort();
  facts.evidence.push(evidenceRow('overlay', 'firebase/overlay.firebase-json', configPath));

  readCodebases(facts, config, dir, budget, component, nodeManifests);
  readRulesAndIndexes(facts, config, dir);
  readEmulatorPorts(facts, config, configPath);
  readAliases(facts, budget, dir, component);
  return facts;
}

/**
 * `functions` is documented as an array of objects, and the single-object form is what `firebase init`
 * writes for a project with one codebase. Both are accepted, and both produce the same shape.
 * @param {FirebaseFacts} facts
 * @param {Record<string, unknown>} config
 * @param {string} dir
 * @param {import('../budget.js').ReadBudget} budget
 * @param {string} component
 * @param {Record<string, unknown>} nodeManifests
 */
function readCodebases(facts, config, dir, budget, component, nodeManifests) {
  const entries = toArray(config.functions).map(asObject).filter(Boolean);
  if (entries.length === 0) return;

  const configPath = joinRelative(dir, FIREBASE_CONFIG_FILE);
  for (const entry of entries) {
    const declaredSource = typeof entry?.source === 'string' && entry.source.trim() !== '' ? toPosix(entry.source) : 'functions';
    const source = joinInsideWorkspace(dir, declaredSource);
    if (source === null) {
      addWarning(facts, PATH_OUTSIDE_WARNING);
      continue;
    }
    const codebase = typeof entry?.codebase === 'string' && entry.codebase.trim() !== '' ? entry.codebase : 'default';
    const declared = typeof entry?.runtime === 'string' ? entry.runtime : null;
    const resolved = declared !== null ? { runtime: declared, runtimeSource: `${configPath} functions.runtime` } : runtimeFromSource(budget, source, component, nodeManifests);
    if (resolved.runtime === null) facts.warnings.push('firebase.functions-runtime-unknown');

    facts.codebases.push({ codebase, source, runtime: resolved.runtime, runtimeSource: resolved.runtimeSource });
    facts.evidence.push(evidenceRow('signal', 'firebase/signal.codebase', configPath));
    if (resolved.runtime !== null) {
      facts.evidence.push(evidenceRow('runtime', declared !== null ? 'firebase/runtime.declared' : 'firebase/runtime.engines-node', declared !== null ? configPath : joinRelative(source, 'package.json')));
    }
  }
  facts.codebases.sort((a, b) => (a.codebase < b.codebase ? -1 : a.codebase > b.codebase ? 1 : 0));
}

/**
 * `engines.node` is a major version (`"22"`, `">=20"`); the runtime name Firebase uses is `nodejs<major>`.
 * @param {import('../budget.js').ReadBudget} budget
 * @param {string} source
 * @param {string} component
 * @param {Record<string, unknown>} nodeManifests
 * @returns {{ runtime: string | null, runtimeSource: string | null }}
 */
function runtimeFromSource(budget, source, component, nodeManifests) {
  const manifestPath = joinRelative(source, 'package.json');
  const cached = asObject(nodeManifests[source]);
  const manifest = cached ?? asObject(budget.readJson(manifestPath, { component }).value);
  const node = asObject(manifest?.engines)?.node;
  if (typeof node !== 'string') return { runtime: null, runtimeSource: null };
  const major = node.match(/\d+/)?.[0];
  return major ? { runtime: `nodejs${major}`, runtimeSource: `${manifestPath} engines.node` } : { runtime: null, runtimeSource: null };
}

/**
 * Rules and index files are recorded as paths, never opened: a `.rules` file is deny-edit precisely
 * because its next deploy decides who reads production data, and nothing here needs its contents.
 * @param {FirebaseFacts} facts
 * @param {Record<string, unknown>} config
 * @param {string} dir
 */
function readRulesAndIndexes(facts, config, dir) {
  const configPath = joinRelative(dir, FIREBASE_CONFIG_FILE);
  /** @type {Set<string>} */
  const rules = new Set();
  /** @type {Set<string>} */
  const indexes = new Set();

  for (const product of RULES_PRODUCTS) {
    // `firestore` and `database` may each be one object or an array of them (several databases).
    for (const entry of toArray(config[product]).map(asObject)) {
      // A rules or index path that leaves the workspace is dropped, not recorded: these are written
      // into committed facts, and a path outside the root names nothing a teammate could open.
      addWorkspacePath(facts, rules, dir, entry?.rules);
      addWorkspacePath(facts, indexes, dir, entry?.indexes);
    }
  }

  facts.rulesFiles = [...rules].sort();
  facts.indexFiles = [...indexes].sort();
  if (facts.rulesFiles.length > 0) facts.evidence.push(evidenceRow('signal', 'firebase/signal.rules-files', configPath));
  if (facts.indexFiles.length > 0) facts.evidence.push(evidenceRow('signal', 'firebase/signal.index-files', configPath));
}

/**
 * @param {FirebaseFacts} facts
 * @param {Record<string, unknown>} config
 * @param {string} configPath
 */
function readEmulatorPorts(facts, config, configPath) {
  const emulators = asObject(config.emulators);
  if (emulators === null) return;
  /** @type {Record<string, number>} */
  const ports = {};
  /** @type {Record<string, number>} */
  const suitePorts = {};
  for (const name of EMULATOR_NAMES) {
    const port = asObject(emulators[name])?.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65_536) continue;
    if (NON_PRODUCT_EMULATORS.includes(name)) suitePorts[name] = port;
    else ports[name] = port;
  }
  facts.emulators = ports;
  facts.suitePorts = suitePorts;
  if (Object.keys(ports).length > 0) facts.evidence.push(evidenceRow('port', 'firebase/port.emulators', configPath));
}

/**
 * @param {FirebaseFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {string} dir
 * @param {string} component
 */
function readAliases(facts, budget, dir, component) {
  const rcPath = joinRelative(dir, FIREBASE_RC_FILE);
  const read = budget.readJson(rcPath, { component });
  if (read.status !== 'ok' || read.error !== null) return;
  const projects = asObject(asObject(read.value)?.projects);
  if (projects === null) return;

  facts.rcPresent = true;
  facts.aliases = Object.keys(projects).sort();
  facts.deniedProjectSegments = facts.aliases.filter((alias) => !alias.startsWith(DEMO_PREFIX));
  // The values are project ids. A `demo-` one is emulator-only by construction and is kept so the
  // facts can say "emulator ids only"; every other value is classified and immediately dropped.
  facts.demoProjectIds = /** @type {string[]} */ (Object.values(projects).filter((id) => typeof id === 'string' && id.startsWith(DEMO_PREFIX))).sort();
  const defaultProject = projects.default;
  facts.defaultAliasIsDemo = typeof defaultProject === 'string' ? defaultProject.startsWith(DEMO_PREFIX) : null;
  if (facts.aliases.length > 0) facts.evidence.push(evidenceRow('signal', 'firebase/signal.alias-keys', rcPath));
  if (facts.defaultAliasIsDemo === false) facts.warnings.push('firebase.live-alias-default');
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/**
 * @param {string} dir
 * @param {string} relativePath
 * @returns {string}
 */
function joinRelative(dir, relativePath) {
  const normalized = relativePath.replace(/^\.\//, '').replace(/\/+$/, '');
  return dir === '' ? normalized : `${dir}/${normalized}`;
}

/**
 * `joinRelative` for a path that came out of `firebase.json`, which is untrusted repository content:
 * null when the result is not a workspace path, so the caller drops the entry rather than reading or
 * recording it.
 * @param {string} dir
 * @param {string} relativePath
 * @returns {string | null}
 */
function joinInsideWorkspace(dir, relativePath) {
  try {
    return toProjectPath(joinRelative(dir, relativePath)) || null;
  } catch {
    return null;
  }
}

/**
 * @param {FirebaseFacts} facts
 * @param {string} id
 */
function addWarning(facts, id) {
  if (!facts.warnings.includes(id)) facts.warnings.push(id);
}

/**
 * Records one declared path, or warns and drops it when it leaves the workspace.
 * @param {FirebaseFacts} facts
 * @param {Set<string>} target
 * @param {string} dir
 * @param {unknown} declared
 */
function addWorkspacePath(facts, target, dir, declared) {
  if (typeof declared !== 'string') return;
  const resolved = joinInsideWorkspace(dir, toPosix(declared));
  if (resolved === null) addWarning(facts, PATH_OUTSIDE_WARNING);
  else target.add(resolved);
}

