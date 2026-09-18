// The `game-server` overlay detector (amendment 37.3-37.4, `D-B15`, `D-B17`, area 14.6.5).
//
// Every signal here is free: it reads data another scan already has - the Unity package manifest and
// the asmdef enumeration SPEC 9.2 reads, the source sample SPEC 9.5 tokenises, a service's own
// `package.json`, the compose file the published-port scan already opened - so an overlay costs no
// walk of its own.
//
// **The allow-list is the signature table, not this module.** Which package ids, assembly names,
// dependency names and source tokens fire is read from the `game-server` signature file at match time,
// so adding a framework is a data change with a fixture and an evidence file, and a name with no row
// simply does not exist to the detector (`D-B17`). That is what keeps the gaps in this area honest
// rather than embarrassing: a product whose documentation could not be retrieved has no row, and
// therefore no detection, rather than a plausible-looking string written from memory.
//
// The overlay says which signals fired and nothing more. In particular a matchmaking or lobby role is
// **a label, not a claim**: the qualifier is part of the sentence, because what a route name shows is
// the outside of a service, and no behaviour, protocol or authority model follows from it.
import { componentId } from '../ids.js';
import { evidenceRow, loadSignatures } from '../signatures.js';

/** The signature file whose rows are this detector's allow-list. */
export const GAME_SERVER_SIGNATURE_FILE = 'game-server';

/** 14.6.5's route-name words. The label they produce carries its own epistemic status. */
export const ROLE_WORDS = Object.freeze(['match', 'queue', 'ticket', 'lobby', 'room', 'session']);

/** The exact sentence, qualifier included. */
export const ROLE_LABEL = 'matchmaking/lobby (by route names)';

/** Bounded: a signal is a landmark, so a handful of files is enough to find one. */
const MAX_SCANNED_FILES = 6;

/** Only these are scanned for a build-subtarget or custom-resource signal. */
const SCANNABLE_EXTENSIONS = Object.freeze(['.yaml', '.yml']);

/**
 * @typedef {object} GameServerSignal
 * @property {string} signature   The signature row id that fired.
 * @property {string} value       The row's value, for example `Mirror`.
 * @property {string} file        The file that produced it, relative to the workspace root.
 */

/**
 * @typedef {object} GameServerOverlay
 * @property {string} id            `server:<slug>`; the composer reassigns on a collision.
 * @property {'game-server'} kind
 * @property {string} dir
 * @property {string} declaredBy    The file that produced the first signal (`D-B3`).
 * @property {string} attachedTo    An anchor id, or `workspace` (P5).
 * @property {GameServerSignal[]} signals   Sorted by signature id, deduplicated.
 * @property {string[]} products    Distinct values of the `signal` rows, sorted: what the facts line
 *   names. A `port` row carries a file kind rather than a product, so it is evidence, not a name.
 * @property {string | null} role   `ROLE_LABEL`, or null.
 * @property {import('../signatures.js').EvidenceEntry[]} evidence
 */

/**
 * What the Unity scan already holds, in its own convention: every `file` is relative to the Unity
 * project root, and the detector places it in the workspace by prefixing `dir`. `assemblies` has the
 * shape of the scan's asmdef records, so they can be passed through unchanged.
 * @typedef {object} UnityGameServerInput
 * @property {string} id
 * @property {string} dir                        The Unity project root, relative to the workspace.
 * @property {readonly string[]} [packageIds]    Manifest and lock package ids the Unity scan read.
 * @property {readonly { name: string, file: string }[]} [assemblies]  asmdef records (Mirror publishes
 *   no package manifest, so its assemblies are how it is seen).
 * @property {readonly { file: string, text: string }[]} [sources]  Samples the Unity scan already read.
 * @property {string} [manifestFile]             Where the package ids came from; `Packages/manifest.json`.
 */

/**
 * @typedef {object} NodeGameServerInput
 * @property {string} id
 * @property {string} dir
 * @property {string} declaredBy
 * @property {readonly string[]} [dependencyNames]
 * @property {readonly { label: string }[]} [routes]
 */

/**
 * The whole detector: one call, every source, one overlay per attachment point.
 * @param {import('../budget.js').ReadBudget} budget
 * @param {object} options
 * @param {readonly UnityGameServerInput[]} [options.unityClients]
 * @param {readonly NodeGameServerInput[]} [options.nodeServices]
 * @param {import('../compose.js').ComposeFacts} [options.compose]
 * @param {readonly string[]} [options.files]      The discovery walk's file list.
 * @param {readonly string[]} [options.ciFiles]    Workflow paths the container and CI probe listed.
 * @param {string} [options.component]
 * @returns {{ overlays: GameServerOverlay[] }}
 */
export function detectGameServer(budget, { unityClients = [], nodeServices = [], compose, files = [], ciFiles = [], component = 'game-server' } = {}) {
  /** @type {GameServerOverlay[]} */
  const overlays = [];

  // A build-subtarget signal can also sit in a workflow file, which is outside the walk because the
  // folder is hidden; the container and CI probe lists those paths by name. A workflow names no
  // project, so its signal belongs to the Unity client only when there is exactly one, and to the
  // workspace otherwise - attaching it to every client would state something nobody observed.
  const ciSignals = scanForSignals(budget, workflowFiles(ciFiles), component);
  const ciOwner = unityClients.length === 1 ? unityClients[0].id : 'workspace';

  for (const unity of unityClients) {
    const signals = unityGameServerSignals(unity);
    if (ciOwner === unity.id) signals.push(...ciSignals);
    addOverlay(overlays, signals, { dir: unity.dir, attachedTo: unity.id });
  }

  for (const service of nodeServices) {
    const signals = nodeGameServerSignals(service);
    addOverlay(overlays, signals, { dir: service.dir, attachedTo: service.id, role: roleOf(service.routes ?? []) });
  }

  const workspaceSignals = scanForSignals(budget, customResourceFiles(files), component);
  if (ciOwner === 'workspace') workspaceSignals.push(...ciSignals);
  if (compose !== undefined && compose.status === 'ok' && compose.services.some((service) => service.publishedPorts.length > 0) && workspaceSignals.length > 0) {
    // A published port on its own says nothing about a game server, so the compose file joins the
    // evidence only once a custom resource has already established the overlay.
    workspaceSignals.push(...composeSignals(compose));
  }
  addOverlay(overlays, workspaceSignals, { dir: '', attachedTo: 'workspace' });

  return { overlays };
}

/**
 * @param {UnityGameServerInput} unity
 * @returns {GameServerSignal[]}
 */
export function unityGameServerSignals(unity) {
  const manifestFile = joinRelative(unity.dir, unity.manifestFile ?? 'Packages/manifest.json');
  /** @type {GameServerSignal[]} */
  const signals = [];

  for (const row of rowsWith('unityPackage')) {
    if (!(unity.packageIds ?? []).includes(/** @type {string} */ (row.match.unityPackage))) continue;
    signals.push({ signature: row.id, value: row.value ?? row.id, file: manifestFile });
  }
  for (const row of rowsWith('assembly')) {
    const record = (unity.assemblies ?? []).find((assembly) => assembly.name === row.match.assembly);
    if (record === undefined) continue;
    signals.push({ signature: row.id, value: row.value ?? row.id, file: joinRelative(unity.dir, record.file) });
  }
  for (const source of unity.sources ?? []) {
    for (const row of rowsWith('contains')) {
      if (!(row.match.contains ?? []).some((token) => source.text.includes(token))) continue;
      signals.push({ signature: row.id, value: row.value ?? row.id, file: joinRelative(unity.dir, source.file) });
    }
  }
  return signals;
}

/**
 * @param {NodeGameServerInput} service
 * @returns {GameServerSignal[]}
 */
export function nodeGameServerSignals(service) {
  /** @type {GameServerSignal[]} */
  const signals = [];
  for (const row of rowsWith('dependency')) {
    if (!(service.dependencyNames ?? []).includes(/** @type {string} */ (row.match.dependency))) continue;
    signals.push({ signature: row.id, value: row.value ?? row.id, file: service.declaredBy });
  }
  return signals;
}

/**
 * @param {import('../compose.js').ComposeFacts} compose
 * @returns {GameServerSignal[]}
 */
function composeSignals(compose) {
  const row = signatureRowById('game-server/port.compose');
  if (row === null || compose.file === null) return [];
  return [{ signature: row.id, value: row.value ?? row.id, file: compose.file }];
}

/**
 * Text signals - a build subtarget, a custom resource kind - over a bounded set of files.
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} paths
 * @param {string} component
 * @returns {GameServerSignal[]}
 */
function scanForSignals(budget, paths, component) {
  /** @type {GameServerSignal[]} */
  const signals = [];
  for (const file of paths.slice(0, MAX_SCANNED_FILES)) {
    const read = budget.readText(file, { component });
    if (read.status !== 'ok') continue;
    const text = read.text ?? '';
    for (const row of rowsWith('contains')) {
      if (!(row.match.contains ?? []).some((token) => text.includes(token))) continue;
      signals.push({ signature: row.id, value: row.value ?? row.id, file });
    }
  }
  return signals;
}

/**
 * @param {readonly string[]} files
 * @returns {string[]}  Manifests under `k8s/` or `charts/`, which is where a custom resource lives.
 */
function customResourceFiles(files) {
  return files.filter((file) => /^(k8s|charts)\//i.test(file) && SCANNABLE_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension))).sort();
}

/**
 * @param {readonly string[]} ciFiles
 * @returns {string[]}
 */
function workflowFiles(ciFiles) {
  return ciFiles.filter((file) => SCANNABLE_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension))).sort();
}

/**
 * @param {readonly { label: string }[]} routes
 * @returns {string | null}
 */
export function roleOf(routes) {
  const matched = routes.some((route) => ROLE_WORDS.some((word) => route.label.toLowerCase().includes(word)));
  return matched ? ROLE_LABEL : null;
}

/**
 * @param {GameServerOverlay[]} overlays
 * @param {GameServerSignal[]} signals
 * @param {{ dir: string, attachedTo: string, role?: string | null }} placement
 */
function addOverlay(overlays, signals, { dir, attachedTo, role = null }) {
  const unique = deduplicate(signals);
  if (unique.length === 0) return;
  overlays.push({
    id: componentId('game-server', dir),
    kind: 'game-server',
    dir,
    declaredBy: unique[0].file,
    attachedTo,
    signals: unique,
    products: [...new Set(unique.filter((signal) => signatureRowById(signal.signature)?.fact === 'signal').map((signal) => signal.value))].sort(),
    role,
    evidence: unique.map((signal) => evidenceRow('signal', signal.signature, signal.file)),
  });
}

/**
 * @param {readonly GameServerSignal[]} signals
 * @returns {GameServerSignal[]}
 */
function deduplicate(signals) {
  /** @type {Map<string, GameServerSignal>} */
  const unique = new Map();
  for (const signal of signals) {
    const key = `${signal.signature} ${signal.file}`;
    if (!unique.has(key)) unique.set(key, signal);
  }
  return [...unique.values()].sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * @param {keyof import('../signatures.js').SignatureMatch} key
 * @returns {import('../signatures.js').SignatureRow[]}
 */
function rowsWith(key) {
  return [...loadSignatures().rows.values()].filter((row) => row.id.startsWith(`${GAME_SERVER_SIGNATURE_FILE}/`) && row.match[key] !== undefined);
}

/**
 * @param {string} id
 * @returns {import('../signatures.js').SignatureRow | null}
 */
function signatureRowById(id) {
  return loadSignatures().rows.get(id) ?? null;
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function joinRelative(dir, name) {
  return dir === '' ? name : `${dir}/${name}`;
}
