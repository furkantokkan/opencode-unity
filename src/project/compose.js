// The published-port scan, and the one-line container and CI fact (amendment 37.3 `D-B23`, 37.8).
//
// A1.2 cut the `tooling` component: every file it covered is already deny-edit, every command it
// implied is already denied, and its fact block was the first thing dropped on any workspace near the
// budget. What is left is the one capability it actually delivered - the published port
// `--derive local-services` may turn into a loopback entry - plus the safety line that says container
// and CI files exist and are never edited.
//
// This is deliberately not a YAML parser. It is a bounded, indentation-aware scan for one shape:
// `services: <name>: ports:`, plus `image`, and the presence - never the contents - of `environment`
// and `env_file`. A compose file's `environment:` block is where a plaintext password ends up, so the
// scan records that the key exists and reads no value under it (S-BM-2).
import { isDirectory, isFile, joinProjectPath } from '../unity/fs-view.js';
import { evidenceRow } from './signatures.js';

/** In preference order: `compose.yaml` wins when several exist (claim B32). */
export const COMPOSE_FILE_NAMES = Object.freeze(['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);

/** A published port is only useful when it is one port; a range names no single entry. */
const PORT_PATTERN = /^\d{1,5}$/;

/** Enough for a development stack; a compose file with more services is summarised, not walked. */
const MAX_SERVICES = 24;

/**
 * Container and CI files, by the category they are reported under. `.github/workflows/` and
 * `.gitlab-ci.yml` are hidden, so the discovery walk never sees them and they are probed by name -
 * a fixed constant, never a path taken out of repository content.
 * @type {ReadonlyArray<{ category: string, path: string, kind: 'file' | 'dir' }>}
 */
const HIDDEN_CI_PATHS = Object.freeze([
  { category: 'CI workflows', path: '.github/workflows', kind: 'dir' },
  { category: 'CI workflows', path: '.gitlab-ci.yml', kind: 'file' },
]);

/** A workflow directory listing is bounded: the files are evidence, not a corpus. */
const MAX_WORKFLOW_FILES = 20;

/** Categories found in the walk, in report order. */
const VISIBLE_CONTAINER_RULES = Object.freeze([
  { category: 'container', match: /^Dockerfile(\..+)?$/i, kind: /** @type {const} */ ('file') },
  { category: 'container', match: /^(docker-)?compose(\..+)?\.ya?ml$/i, kind: /** @type {const} */ ('file') },
  { category: 'deployment', match: /^(k8s|charts|deploy)$/i, kind: /** @type {const} */ ('dir') },
  { category: 'deployment', match: /\.tf$/i, kind: /** @type {const} */ ('file') },
]);

/**
 * @typedef {object} ComposeService
 * @property {string} name
 * @property {string | null} image          The image's repository name only - `postgres`, not
 *   `registry.example/library/postgres:17`. A registry host is a fact about someone's infrastructure,
 *   and nothing downstream needs more than the name.
 * @property {number[]} publishedPorts      Host ports, sorted, deduplicated.
 * @property {boolean} hasEnvironment       That the key exists. Its values are never read.
 * @property {boolean} hasEnvFile
 */

/**
 * @typedef {object} ComposeFacts
 * @property {'ok' | 'absent' | 'unreadable' | 'unbudgeted'} status
 * @property {string | null} file
 * @property {ComposeService[]} services    Sorted by name.
 * @property {boolean} truncated            The service cap or the read budget cut the scan.
 * @property {import('./signatures.js').EvidenceEntry[]} evidence
 */

/**
 * @param {readonly string[]} files  POSIX paths from the discovery walk.
 * @param {string} [dir]
 * @returns {string | null}
 */
export function findComposeFile(files, dir = '') {
  for (const name of COMPOSE_FILE_NAMES) {
    const candidate = dir === '' ? name : `${dir}/${name}`;
    if (files.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Reads the published ports of the compose file in `dir`, if there is one.
 * @param {import('./budget.js').ReadBudget} budget
 * @param {{ dir?: string, files?: readonly string[], component?: string }} [options]
 * @returns {ComposeFacts}
 */
export function readComposeServices(budget, { dir = '', files = [], component = 'compose' } = {}) {
  const file = findComposeFile(files, dir);
  if (file === null) return { status: 'absent', file: null, services: [], truncated: false, evidence: [] };

  const read = budget.readText(file, { component });
  if (read.status !== 'ok') {
    return { status: read.status === 'unbudgeted' ? 'unbudgeted' : 'unreadable', file, services: [], truncated: false, evidence: [] };
  }

  const parsed = parseComposeServices(read.text ?? '');
  const facts = {
    status: /** @type {const} */ ('ok'),
    file,
    services: parsed.services,
    truncated: parsed.truncated || read.truncated,
    evidence: /** @type {import('./signatures.js').EvidenceEntry[]} */ ([]),
  };
  if (parsed.services.some((service) => service.publishedPorts.length > 0)) facts.evidence.push(evidenceRow('port', 'game-server/port.compose', file));
  return facts;
}

/**
 * The scan. Three indentation levels matter, and each is fixed by the first line found at it: the
 * service name under `services:`, the service's own keys, and anything deeper. A service-level key is
 * recognised **only at the service's key indent**, which is what stops a variable called `image`
 * under `environment:` from being read as the image - and so from carrying a value into the facts.
 * Below the key indent nothing is read at all, except inside `ports:`.
 * @param {string} text
 * @returns {{ services: ComposeService[], truncated: boolean }}
 */
export function parseComposeServices(text) {
  /** @type {Map<string, ComposeService>} */
  const services = new Map();
  let inServices = false;
  let servicesIndent = -1;
  /** @type {ComposeService | null} */
  let current = null;
  let serviceIndent = -1;
  let keyIndent = -1;
  let inPorts = false;
  let truncated = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (!inServices) {
      if (/^services\s*:/.test(content)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }
    // A top-level key at or left of `services:` ends the block: `volumes:` is not a service.
    if (indent <= servicesIndent) {
      inServices = false;
      current = null;
      continue;
    }

    if (current === null || indent <= serviceIndent) {
      const name = content.match(/^([A-Za-z0-9_.-]+)\s*:/)?.[1];
      if (name === undefined) continue;
      if (services.size >= MAX_SERVICES) {
        truncated = true;
        current = null;
        continue;
      }
      current = { name, image: null, publishedPorts: [], hasEnvironment: false, hasEnvFile: false };
      services.set(name, current);
      serviceIndent = indent;
      keyIndent = -1;
      inPorts = false;
      continue;
    }

    if (keyIndent === -1) keyIndent = indent;
    // YAML lets a sequence sit at its parent key's own indent, so `- "80:80"` may be a ports entry here.
    const isServiceKey = indent === keyIndent && !content.startsWith('-');
    if (!isServiceKey) {
      if (inPorts) readPortLine(current, content);
      continue;
    }

    inPorts = /^ports\s*:/.test(content);
    const value = content.slice(content.indexOf(':') + 1).trim();
    if (inPorts) {
      // The flow form `ports: ["3000:3000"]` carries its entries on the same line.
      for (const entry of value.replace(/[[\]]/g, '').split(',')) addPublishedPort(current, entry.trim());
    } else if (/^image\s*:/.test(content)) current.image = imageName(value);
    // The key, never what is under it: this is where a plaintext password lives (S-BM-2).
    else if (/^environment\s*:/.test(content)) current.hasEnvironment = true;
    else if (/^env_file\s*:/.test(content)) current.hasEnvFile = true;
  }

  for (const service of services.values()) service.publishedPorts.sort((a, b) => a - b);
  return { services: [...services.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), truncated };
}

/**
 * One line inside `ports:`: a short-syntax entry, or a `published` key of the long syntax, whether it
 * opens the entry (`- published: 8080`) or follows another key of it. Every other long-syntax key is
 * skipped rather than misread as a `host:container` pair.
 * @param {ComposeService} service
 * @param {string} content
 */
function readPortLine(service, content) {
  const isEntry = content.startsWith('-');
  const entry = isEntry ? content.slice(1).trim() : content;
  const published = /^published\s*:(.*)$/.exec(entry);
  if (published !== null) addPort(service, published[1]);
  else if (isEntry && !/^[A-Za-z_]+\s*:/.test(entry)) addPublishedPort(service, entry);
}

/**
 * One short-syntax entry: `container`, `published:container`, `ip:published:container`, each of which
 * may carry a `/protocol` suffix. Only the two-and-three-field forms publish a host port; a bare
 * container port is published on a port the engine picks, which names nothing a generated entry could
 * use, and a range names more than one.
 * @param {ComposeService} service
 * @param {string} entry
 */
function addPublishedPort(service, entry) {
  const value = unquote(entry).split('/')[0];
  if (value === '') return;
  const parts = value.split(':');
  if (parts.length === 2) addPort(service, parts[0]);
  else if (parts.length === 3) addPort(service, parts[1]);
}

/**
 * @param {ComposeService} service
 * @param {string} value
 */
function addPort(service, value) {
  const trimmed = unquote(value.trim());
  if (!PORT_PATTERN.test(trimmed)) return;
  const port = Number(trimmed);
  if (port <= 0 || port >= 65_536) return;
  if (!service.publishedPorts.includes(port)) service.publishedPorts.push(port);
}

/**
 * `registry.example:5000/team/api:1.2@sha256:...` -> `api`. The digest goes first because it carries a
 * colon, then the registry and namespace, then the tag.
 * @param {string} value
 * @returns {string | null}
 */
export function imageName(value) {
  const reference = unquote(value).split('@')[0];
  const name = reference.slice(reference.lastIndexOf('/') + 1).split(':')[0].trim();
  return name === '' ? null : name;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0])) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * @typedef {object} ContainerAndCiFacts
 * @property {boolean} present
 * @property {string[]} categories  Sorted, deduplicated: `CI workflows`, `container`, `deployment`.
 * @property {string[]} files       Sorted paths, at most a handful; recorded, never opened.
 * @property {string} line          The header line to render, or '' when nothing was found.
 * @property {import('./signatures.js').EvidenceEntry[]} evidence
 */

/**
 * `D-B23`: the presence of container and CI files is one header line rather than a component. It is a
 * safety line, so 37.5's drop order never drops it.
 * @param {import('../unity/fs-view.js').FsView} view
 * @param {string} root  Absolute workspace root.
 * @param {{ files?: readonly string[], dirs?: readonly string[] }} [walk]
 * @returns {ContainerAndCiFacts}
 */
export function detectContainerAndCiFiles(view, root, { files = [], dirs = [] } = {}) {
  /** @type {Set<string>} */
  const categories = new Set();
  /** @type {Set<string>} */
  const found = new Set();

  for (const rule of VISIBLE_CONTAINER_RULES) {
    for (const entry of rule.kind === 'dir' ? dirs : files) {
      if (!rule.match.test(entry.slice(entry.lastIndexOf('/') + 1))) continue;
      categories.add(rule.category);
      found.add(entry);
    }
  }

  for (const probe of HIDDEN_CI_PATHS) {
    const absolute = joinProjectPath(root, probe.path);
    if (!(probe.kind === 'dir' ? isDirectory(view, absolute) : isFile(view, absolute))) continue;
    categories.add(probe.category);
    found.add(probe.path);
    // The directory's own entries are listed - by name only - so that a later detector can look for a
    // build signal inside a workflow without the walk having to descend a hidden folder.
    if (probe.kind === 'dir') {
      for (const entry of view.readDir(absolute).slice(0, MAX_WORKFLOW_FILES)) {
        if (entry.isFile) found.add(`${probe.path}/${entry.name}`);
      }
    }
  }

  const present = categories.size > 0;
  return {
    present,
    categories: [...categories].sort(),
    files: [...found].sort(),
    line: present ? CONTAINER_AND_CI_LINE : '',
    evidence: present ? [evidenceRow('container-and-ci', 'spec:37.3', [...found].sort()[0])] : [],
  };
}

/** The exact sentence `D-B23` prescribes. */
export const CONTAINER_AND_CI_LINE = 'Container and CI files are present and are never edited.';
