// Route extraction: one hop, five shapes, twenty landmarks (amendment 37.4, `D-B9`, area 14.6.4).
//
// The budget here is the design, not an implementation detail. A full import graph is unbounded, an
// AST pass is a TypeScript parser dependency, and regexing the whole tree makes the cost a property of
// the repository and picks up fixtures and comments. So: start at the entry file, follow at most three
// **literal relative** imports, one level, and stop.
//
// What is recorded is a landmark, never a contract. `GET /scores` tells the model the file it is about
// to edit answers that path; nothing is inferred about what the handler does. A path built from a
// template literal or a variable is recorded as its literal prefix followed by an ellipsis, because
// half a path is still a landmark and a guessed path is a wrong fact.
//
// The shapes are matched, not the frameworks. A method-and-path registration looks the same in every
// router, so the line is recorded whatever library produced it, and the framework a component actually
// depends on is a separate fact with its own signature row. That is what keeps an unverified product
// name out of this module (`D-B17`).
import { joinInsideWorkspace, resolveModulePath } from './entry.js';
import { evidenceRow } from './signatures.js';

/** 14.6.4: at most 20 entries, at most 48 characters each, and at most 3 files after the entry. */
export const MAX_ROUTES = 20;
export const MAX_ROUTE_LABEL = 48;
export const MAX_HOPS = 3;

/** Only lines whose registration starts the line, after optional whitespace (14.6.4). */
const METHOD_PATTERN = /^[ \t]*(?:await[ \t]+)?[A-Za-z_$][\w$.]*\.(get|post|put|patch|delete|del|all|head|options)\([ \t]*(['"`])(\/[^'"`]*)\2/i;
const MOUNT_PATTERN = /^[ \t]*[A-Za-z_$][\w$.]*\.use\([ \t]*(['"`])(\/[^'"`]*)\1[ \t]*,/;
const ROUTE_OBJECT_PATTERN = /^[ \t]*[A-Za-z_$][\w$.]*\.route\([ \t]*\{/;
const ROUTE_OBJECT_METHOD = /\bmethod[ \t]*:[ \t]*(['"])([A-Za-z]+)\1/;
const ROUTE_OBJECT_URL = /\burl[ \t]*:[ \t]*(['"`])(\/[^'"`]*)\1/;
const FUNCTION_PATTERN = /^[ \t]*(?:exports\.([\w$]+)[ \t]*=|export[ \t]+(?:const|let|var)[ \t]+([\w$]+)[ \t]*=)[ \t]*(?:[\w$.]*\.)?(onRequest|onCall)\(/;
const ROOM_PATTERN = /^[ \t]*[A-Za-z_$][\w$.]*\.define\([ \t]*(['"`])([^'"`]+)\1/;

/** How far after a `.route({` line the method and url are still the same call. */
const ROUTE_OBJECT_LINES = 6;

/**
 * `app.listen(3000)` and `app.listen({ port: 3000 })`, with a **literal** port only. A port that comes
 * from an environment variable is not a fact this scan can know, and 37.8 forbids turning a variable's
 * name into a network entry.
 */
const LISTEN_PATTERNS = Object.freeze([
  /^[ \t]*(?:await[ \t]+)?[A-Za-z_$][\w$.]*\.listen\([ \t]*(\d{1,5})[ \t]*[,)]/,
  /^[ \t]*(?:await[ \t]+)?[A-Za-z_$][\w$.]*\.listen\([ \t]*\{[^}]*\bport[ \t]*:[ \t]*(\d{1,5})[ \t]*[,}]/,
]);

/** `import x from './y.js'`, `export * from './y.js'` and `require('./y')`, literal and relative only. */
const IMPORT_PATTERNS = Object.freeze([
  /^[ \t]*import\b[^'"]*(['"])(\.[^'"]*)\1/,
  /^[ \t]*export\b[^'"]*\bfrom[ \t]*(['"])(\.[^'"]*)\1/,
  /require\([ \t]*(['"])(\.[^'"]*)\1[ \t]*\)/,
]);

/**
 * @typedef {object} RouteEntry
 * @property {'route' | 'mount' | 'fn' | 'room'} kind
 * @property {string} label   What the facts render, for example `GET /health` or `FN claimReward (callable)`.
 * @property {string} file    POSIX, relative to the workspace root.
 */

/**
 * @typedef {object} RouteFacts
 * @property {RouteEntry[]} routes   Sorted by label, deduplicated, at most `MAX_ROUTES`.
 * @property {number[]} listenPorts  Literal `listen` ports in the **entry** file only (37.8), sorted.
 * @property {string[]} sources      Files scanned, entry first.
 * @property {boolean} truncated     The route cap or the hop cap cut the scan.
 * @property {import('./signatures.js').EvidenceEntry[]} evidence
 */

/**
 * @param {import('./budget.js').ReadBudget} budget
 * @param {{ entry: string | null, files?: readonly string[], component?: string, maxRoutes?: number, maxHops?: number }} options
 * @returns {RouteFacts}
 */
export function extractRoutes(budget, { entry, files = [], component = 'routes', maxRoutes = MAX_ROUTES, maxHops = MAX_HOPS }) {
  /** @type {RouteFacts} */
  const facts = { routes: [], listenPorts: [], sources: [], truncated: false, evidence: [] };
  if (entry === null) return facts;

  const read = budget.readText(entry, { component });
  if (read.status !== 'ok') return facts;
  facts.sources.push(entry);

  /** @type {Map<string, RouteEntry>} */
  const found = new Map();
  collectRoutes(read.text ?? '', entry, found);
  facts.listenPorts = literalListenPorts(read.text ?? '');
  if (facts.listenPorts.length > 0) facts.evidence.push(evidenceRow('port', 'spec:37.8', entry));

  const imports = literalRelativeImports(read.text ?? '', entry, files);
  if (imports.length > maxHops) facts.truncated = true;
  for (const hop of imports.slice(0, Math.max(0, maxHops))) {
    const hopRead = budget.readText(hop, { component });
    if (hopRead.status !== 'ok') continue;
    facts.sources.push(hop);
    collectRoutes(hopRead.text ?? '', hop, found);
  }

  const all = [...found.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  facts.truncated = facts.truncated || all.length > maxRoutes;
  facts.routes = all.slice(0, Math.max(0, maxRoutes));
  if (facts.routes.length > 0) facts.evidence.push(evidenceRow('routes', 'spec:37.4', entry));
  return facts;
}

/**
 * @param {string} text
 * @param {string} file
 * @param {Map<string, RouteEntry>} found
 */
function collectRoutes(text, file, found) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const method = METHOD_PATTERN.exec(line);
    if (method !== null) {
      add(found, file, 'route', `${methodName(method[1])} ${literalPrefix(method[3])}`);
      continue;
    }

    const mount = MOUNT_PATTERN.exec(line);
    if (mount !== null) {
      add(found, file, 'mount', `MOUNT ${literalPrefix(mount[2])}`);
      continue;
    }

    const fn = FUNCTION_PATTERN.exec(line);
    if (fn !== null) {
      const transport = fn[3] === 'onCall' ? 'callable' : 'http';
      add(found, file, 'fn', `FN ${fn[1] ?? fn[2]} (${transport})`);
      continue;
    }

    const room = ROOM_PATTERN.exec(line);
    if (room !== null) {
      add(found, file, 'room', `ROOM ${literalPrefix(room[2])}`);
      continue;
    }

    if (ROUTE_OBJECT_PATTERN.test(line)) {
      const block = lines.slice(index, index + ROUTE_OBJECT_LINES).join('\n');
      const url = ROUTE_OBJECT_URL.exec(block);
      if (url === null) continue;
      const declared = ROUTE_OBJECT_METHOD.exec(block);
      add(found, file, 'route', `${declared === null ? 'ANY' : methodName(declared[2])} ${literalPrefix(url[2])}`);
    }
  }
}

/**
 * @param {string} text
 * @returns {number[]} Sorted, deduplicated, each a usable port.
 */
export function literalListenPorts(text) {
  /** @type {Set<number>} */
  const ports = new Set();
  for (const line of text.split('\n')) {
    for (const pattern of LISTEN_PATTERNS) {
      const port = Number(pattern.exec(line)?.[1]);
      if (Number.isInteger(port) && port > 0 && port < 65_536) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * @param {Map<string, RouteEntry>} found
 * @param {string} file
 * @param {RouteEntry['kind']} kind
 * @param {string} label
 */
function add(found, file, kind, label) {
  const clamped = label.length > MAX_ROUTE_LABEL ? `${label.slice(0, MAX_ROUTE_LABEL - 3)}...` : label;
  if (!found.has(clamped)) found.set(clamped, { kind, label: clamped, file });
}

/**
 * @param {string} value
 * @returns {string}
 */
function methodName(value) {
  return (value.toLowerCase() === 'del' ? 'delete' : value).toUpperCase();
}

/**
 * A path or room name interpolated from a variable is recorded as the part that is literal. Half a
 * path is a landmark; a path with `${id}` rendered verbatim is a string no request ever matches.
 * @param {string} value
 * @returns {string}
 */
function literalPrefix(value) {
  const interpolation = value.indexOf('${');
  return interpolation === -1 ? value : `${value.slice(0, interpolation)}...`;
}

/**
 * The one hop: literal relative specifiers only, resolved against the walk, deduplicated, in the order
 * they appear. No alias, no bare specifier, nothing under `node_modules`.
 * @param {string} text
 * @param {string} from       The file the imports were read from.
 * @param {readonly string[]} files
 * @returns {string[]}
 */
export function literalRelativeImports(text, from, files) {
  const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  /** @type {string[]} */
  const resolved = [];
  for (const line of text.split('\n')) {
    for (const pattern of IMPORT_PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const target = resolveModulePath(files, fromDir, match[2]);
      if (target === null || target === from || resolved.includes(target)) continue;
      // Belt and braces: `resolveModulePath` already refuses a specifier that leaves the workspace,
      // and this refuses one that leaves it through a symlink-shaped spelling the walk never saw.
      if (joinInsideWorkspace('', target) === null) continue;
      resolved.push(target);
    }
  }
  return resolved;
}
