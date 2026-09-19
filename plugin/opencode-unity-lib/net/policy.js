// The network policy core (amendment 35.2, 35.5 steps 4-11, 35.6 and 35.7). Everything a request is
// judged against before a socket exists lives here: which entries match it, what those entries allow
// once intersected, which ports are unallowable whatever the profile says, what the request may spend,
// and which gates run. `transport.js` connects, `sensitive.js` reads bytes, `tool.js` orders the steps;
// this module decides.
//
// Two rules carry the design, and both exist because the first revision failed open on them.
//
// `DN25` — every matching entry applies and the narrowest wins. There is no precedence, because a
// first-match rule makes the order of a JSON array a security boundary that no reader checks and no
// schema enforces. Under first match, the blanket loopback entry was picked for every loopback port
// and the narrower rules behind it — the Firebase `demo-` gate above all — were unreachable. Under
// intersection the method must be allowed by *every* matching entry, the budget is the *smallest*
// each one declares, and *every* gate *any* of them declares runs. Adding an entry can never widen
// what an existing entry allowed.
//
// `DN10` — a reserved port is unallowable in every profile including `custom`. Three rows are
// conditional on the surface actually being there and are resolved at their configured value rather
// than at a constant: the Ollama port, the MCP for Unity hub port, and the port a running OpenCode
// server occupies, which only the plugin can know and only per request.
import crypto from 'node:crypto';

import { checkOutboundBudget, intersectBudgets, measureBodyBytes, normalizeBudget } from './budget.js';
import { SENSITIVE_KEYS, findCredential } from './sensitive.js';
import {
  firstPathSegment,
  hasTraversalSegment,
  hostMatchesEntry,
  isLoopbackHostname,
  matchesPathPrefix,
  parseRequestUrl,
  pathCandidates,
  readQueryPairs,
  resolveLocation,
} from './url.js';

/** The method table of `DN6`: three classes, and write is opt-in. */
export const METHOD_CLASS = Object.freeze({
  GET: 'read', HEAD: 'read',
  POST: 'write', PUT: 'write', PATCH: 'write',
  DELETE: 'delete',
});

/** Every deny code this module can produce, so `codes.js` and `net why` can enumerate them. */
export const POLICY_DENY_CODES = Object.freeze([
  'net_disabled', 'net_url_invalid', 'net_url_userinfo', 'net_url_idn',
  'net_method_not_allowed', 'net_body_on_read', 'net_delete_not_allowed',
  'net_host_not_allowed', 'net_port_not_allowed', 'net_path_not_allowed',
  'net_reserved_port', 'net_budget_exceeded', 'net_credential_in_url',
  'net_firebase_project_not_demo', 'net_firebase_project_is_live',
]);

/**
 * The query keys of 12.7.4: a value under any of these never reaches a URL (`DN13`). The list is the
 * shared detector's, so the render, the policy and the delegate lane read one spelling (amendment 38.9).
 */
export const DEFAULT_DENIED_QUERY_KEYS = SENSITIVE_KEYS;

/**
 * Step 9's credential-shaped query value, from the shared detector (S32). It is the default rather than
 * an option a caller has to remember, so a tool that forgets to pass one still refuses the value.
 * @param {string} value
 * @returns {boolean}
 */
export function isCredentialShaped(value) {
  return findCredential(value) !== null;
}

/** A Firebase demo project id, which is the whole of the `DN17` gate: no demo prefix, no call. */
export const DEMO_PROJECT_PATTERN = /^demo-[a-z0-9][a-z0-9-]*$/;

/** The unconditional rows of the reserved-port table (`DN10`, `D-M33`). */
export const UNCONDITIONAL_RESERVED_PORTS = Object.freeze([
  Object.freeze({ port: 4400, reason: 'firebase-emulator-hub', conditional: false }),
  Object.freeze({ port: 2375, reason: 'docker-daemon', conditional: false }),
  Object.freeze({ port: 2376, reason: 'docker-daemon-tls', conditional: false }),
]);

/** Ollama's documented port, reserved at whatever value the install actually configured. */
export const DEFAULT_OLLAMA_PORT = 11434;

/**
 * A policy that refuses everything. What a missing or invalid `network` block resolves to.
 * @returns {NetworkPolicy}
 */
function emptyPolicy() {
  return {
    enabled: false,
    toolId: 'unitynet',
    profile: 'none',
    entries: [],
    limits: {},
    reservedPorts: [],
    deniedQueryKeys: [...DEFAULT_DENIED_QUERY_KEYS],
    deniedProjectSegments: [],
    consentIds: [],
    policyHash: null,
  };
}

/**
 * @typedef {object} PolicyEntry
 * @property {string} id
 * @property {string} host
 * @property {'exact' | 'suffix' | 'loopback'} hostKind
 * @property {number[] | '*'} ports
 * @property {number[]} excludePorts   Ports carved out of a `*` entry so it stays disjoint from the
 *                                     narrower entries `init` derived (`DN25`).
 * @property {'http' | 'https' | '*'} scheme
 * @property {string[]} methods
 * @property {string[]} pathPrefix
 * @property {boolean} stripLocaleSegment
 * @property {boolean} loopback
 * @property {boolean} destructive
 * @property {false | string} firebaseEmulator
 * @property {boolean} shipped
 * @property {import('./budget.js').EntryBudget} budget
 * @property {string | null} consentId
 * @property {Record<string, string>} headers
 * @property {string | null} caFile
 */

/**
 * @typedef {object} ReservedPort
 * @property {number} port
 * @property {string} reason
 * @property {boolean} conditional
 */

/**
 * @typedef {object} NetworkPolicy
 * @property {boolean} enabled
 * @property {string} toolId
 * @property {string} profile
 * @property {PolicyEntry[]} entries
 * @property {Record<string, number>} limits
 * @property {ReservedPort[]} reservedPorts
 * @property {string[]} deniedQueryKeys
 * @property {string[]} deniedProjectSegments
 * @property {string[]} consentIds
 * @property {string | null} policyHash
 */

/**
 * Reads the runtime profile's `network` block into a policy, or fails closed. The plugin must never
 * treat a block it could not understand as permissive: a dropped field is a widened surface, so one
 * unusable entry empties the whole policy and the reason says which.
 * @param {unknown} raw
 * @returns {{ ok: boolean, reason: string | null, policy: NetworkPolicy }}
 */
export function normalizeNetworkPolicy(raw) {
  if (!raw || typeof raw !== 'object') return closed('network block missing');
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (source.enabled !== true) return closed('network disabled');
  if (!Array.isArray(source.entries) || source.entries.length === 0) return closed('no entries');

  /** @type {PolicyEntry[]} */
  const entries = [];
  for (const candidate of source.entries) {
    const entry = normalizeEntry(candidate);
    if (!entry) return closed(`invalid entry: ${describeEntryId(candidate)}`);
    entries.push(entry);
  }
  // The reserved table is the one field whose absence would widen every loopback entry at once, so a
  // block without a usable one is refused rather than read as "nothing is reserved" (DN10, 35.7).
  const reservedPorts = normalizeReservedPorts(source.reservedPorts);
  if (reservedPorts === null) return closed('invalid reservedPorts');

  return {
    ok: true,
    reason: null,
    policy: {
      enabled: true,
      toolId: typeof source.toolId === 'string' && source.toolId !== '' ? source.toolId : 'unitynet',
      profile: typeof source.profile === 'string' ? source.profile : 'standard',
      entries,
      limits: readLimits(source.limits),
      reservedPorts,
      deniedQueryKeys: readStringList(source.deniedQueryKeys, DEFAULT_DENIED_QUERY_KEYS).map((key) => key.toLowerCase()),
      deniedProjectSegments: readStringList(source.deniedProjectSegments, []).map((segment) => segment.toLowerCase()),
      consentIds: readStringList(source.consentIds, []),
      policyHash: typeof source.policyHash === 'string' ? source.policyHash : null,
    },
  };
}

/**
 * The reserved-port table for one machine (`D-M33`). Every conditional row is resolved at its
 * configured value and is only present when the surface it guards is: the Ollama port at the port the
 * install configured, the MCP for Unity hub port only when a hub is configured or answering, and a
 * running OpenCode server's port only when the plugin could determine it. Where a row is present the
 * refusal is absolute; where it is absent the port is an ordinary loopback port — which is what lets
 * an ordinary Firebase project keep Firestore on 8080.
 * @param {{ ollamaPort?: number | null, unityMcpHubPort?: number | null, openCodeServerPort?: number | null, extraPorts?: readonly number[] }} [options]
 * @returns {ReservedPort[]}
 */
export function resolveReservedPorts({ ollamaPort = DEFAULT_OLLAMA_PORT, unityMcpHubPort = null, openCodeServerPort = null, extraPorts = [] } = {}) {
  /** @type {ReservedPort[]} */
  const rows = [...UNCONDITIONAL_RESERVED_PORTS];
  addRow(rows, ollamaPort, 'ollama-api', true);
  addRow(rows, unityMcpHubPort, 'unity-mcp-hub', true);
  addRow(rows, openCodeServerPort, 'opencode-server', true);
  for (const port of Array.isArray(extraPorts) ? extraPorts : []) addRow(rows, port, 'config-extra', false);
  return rows;
}

/**
 * @param {number} port
 * @param {readonly ReservedPort[]} rows
 * @returns {ReservedPort | null}
 */
export function findReservedPort(port, rows) {
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row.port === port) ?? null;
}

/**
 * Step 7's lookup. The tables only ever add to each other: the unconditional rows always apply, the
 * rendered table always applies, and a per-request table (the OpenCode server port) adds its rows to
 * both, so a caller that passes only the row it knows cannot drop the hub or a moved Ollama port.
 * @param {number} port
 * @param {...(readonly ReservedPort[] | null | undefined)} tables
 * @returns {ReservedPort | null}
 */
function findReservedPortInAny(port, ...tables) {
  for (const table of [UNCONDITIONAL_RESERVED_PORTS, ...tables]) {
    const row = findReservedPort(port, table ?? []);
    if (row) return row;
  }
  return null;
}

/**
 * Step 6's entry-set match. Returns every entry the request matches, or the most specific reason the
 * set is empty: a host nobody allowed, a port no entry for that host carries, or a path outside every
 * prefix. Scheme is decided with the port, because together they are where the request goes, and the
 * message names whichever of the two failed.
 * @param {{ entries: readonly PolicyEntry[] }} policy
 * @param {{ host: string, port: number, scheme: string, decodedPath: string }} request
 * @returns {{ ok: true, entries: PolicyEntry[] } | { ok: false, code: string, reason: string }}
 */
export function matchEntries(policy, request) {
  const all = Array.isArray(policy?.entries) ? policy.entries : [];
  const byHost = all.filter((entry) => hostMatchesEntry(request.host, entry));
  if (byHost.length === 0) return { ok: false, code: 'net_host_not_allowed', reason: 'host' };

  const byScheme = byHost.filter((entry) => schemeMatches(entry, request.scheme));
  if (byScheme.length === 0) return { ok: false, code: 'net_port_not_allowed', reason: 'scheme' };

  const byPort = byScheme.filter((entry) => portMatches(entry, request.port));
  if (byPort.length === 0) return { ok: false, code: 'net_port_not_allowed', reason: 'port' };

  if (hasTraversalSegment(request.decodedPath)) return { ok: false, code: 'net_path_not_allowed', reason: 'traversal' };

  const byPath = byPort.filter((entry) => matchesPathPrefix(pathCandidates(request.decodedPath, entry.stripLocaleSegment), entry.pathPrefix));
  if (byPath.length === 0) return { ok: false, code: 'net_path_not_allowed', reason: 'path' };

  return { ok: true, entries: byPath };
}

/**
 * The intersection of `DN25`. Methods are the set every member allows, the budget is the smallest cap
 * each member declares, `destructive` holds only when every member says so, `loopback` only when every
 * member is a loopback entry, and the gates are the union — because a gate is a restriction, and a
 * restriction any member declares has to survive the company it keeps.
 * @param {readonly PolicyEntry[]} entries
 * @returns {{ methods: string[], budget: import('./budget.js').EntryBudget, destructive: boolean, loopback: boolean, gates: { firebaseFunctions: boolean }, ids: string[] }}
 */
export function intersectEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const methods = list.length === 0
    ? []
    : list.slice(1).reduce((kept, entry) => kept.filter((method) => entry.methods.includes(method)), [...list[0].methods]);
  return {
    ids: list.map((entry) => entry.id),
    methods,
    budget: intersectBudgets(list.map((entry) => entry.budget)),
    destructive: list.length > 0 && list.every((entry) => entry.destructive === true),
    loopback: list.length > 0 && list.every((entry) => entry.loopback === true),
    gates: { firebaseFunctions: list.some((entry) => entry.firebaseEmulator === 'functions') },
  };
}

/**
 * Steps 4 to 11 of the execution order, in order, each returning a deny result rather than throwing
 * (`DN18`). What is deliberately not here: the outbound sensitive scan of step 10, which belongs to
 * the tool. The credential shape of a query value comes from the shared detector so the delegate lane
 * and the network lane cannot drift apart; `credentialDetector` defaults to it and exists for tests.
 * DNS, the address pin, the connection and everything after it belong to the transport.
 * @param {object} input
 * @param {NetworkPolicy} input.policy
 * @param {unknown} input.method
 * @param {unknown} input.url
 * @param {string} [input.body]
 * @param {number} [input.bodyBytes]
 * @param {readonly ReservedPort[]} [input.reservedPorts]  Rows added to the policy's own table and
 *   the unconditional rows, so the plugin can add the OpenCode server port it only learns per request.
 * @param {(value: string) => boolean} [input.credentialDetector]
 * @returns {{ ok: true, request: import('./url.js').ParsedRequestUrl, entries: PolicyEntry[], entryIds: string[], methods: string[], budget: import('./budget.js').EntryBudget, spent: { path: number, query: number, body: number }, loopback: boolean, bodyBytes: number } | { ok: false, code: string, reason: string, detail?: Record<string, unknown> }}
 */
export function evaluatePolicy({ policy, method, url, body, bodyBytes, reservedPorts, credentialDetector = isCredentialShaped }) {
  if (!policy?.enabled || !Array.isArray(policy.entries) || policy.entries.length === 0) {
    return deny('net_disabled', 'policy-empty');
  }

  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  const methodClass = METHOD_CLASS[/** @type {keyof typeof METHOD_CLASS} */ (verb)];
  if (!methodClass) return deny('net_method_not_allowed', 'unknown-method', { method: verb });
  const bytes = typeof bodyBytes === 'number' ? bodyBytes : measureBodyBytes(body);
  if (bytes > 0 && methodClass !== 'write') return deny('net_body_on_read', 'body-on-read', { method: verb });

  const parsed = parseRequestUrl(url);
  if (!parsed.ok) return deny(parsed.code, parsed.reason);

  const matched = matchEntries(policy, parsed);
  if (!matched.ok) return deny(matched.code, matched.reason, { host: parsed.host, port: parsed.port, scheme: parsed.scheme });

  const intersection = intersectEntries(matched.entries);
  if (methodClass === 'delete') {
    if (!intersection.loopback) return deny('net_delete_not_allowed', 'delete-off-machine', { entries: intersection.ids });
    if (!intersection.destructive) return deny('net_delete_not_allowed', 'not-destructive', { entries: intersection.ids });
  }
  if (!intersection.methods.includes(verb)) {
    return deny('net_method_not_allowed', 'method-not-in-intersection', { method: verb, entries: intersection.ids, allowed: intersection.methods });
  }

  // Step 7, independent of the entry that matched: `DN10` is the reason free-by-default loopback is
  // defensible at all, so it is re-checked rather than inferred from the entry's port list.
  const reserved = findReservedPortInAny(parsed.port, policy.reservedPorts, reservedPorts);
  if (reserved) return deny('net_reserved_port', reserved.reason, { port: reserved.port, conditional: reserved.conditional });

  const budget = checkOutboundBudget({ path: parsed.path, query: parsed.query, bodyBytes: bytes }, intersection.budget);
  if (!budget.ok) return deny(budget.code, `budget-${budget.field}`, { field: budget.field, limit: budget.limit, actual: budget.actual });

  const denied = findDeniedQueryKey(parsed.query, policy.deniedQueryKeys, credentialDetector);
  if (denied) return deny('net_credential_in_url', denied.reason, { key: denied.key });

  const gate = checkProjectGates(parsed, intersection, policy.deniedProjectSegments);
  if (gate) return gate;

  return {
    ok: true,
    request: parsed,
    entries: matched.entries,
    entryIds: intersection.ids,
    methods: intersection.methods,
    budget: intersection.budget,
    spent: budget.spent,
    loopback: intersection.loopback,
    bodyBytes: bytes,
  };
}

/**
 * `DN7`: a 3xx is never followed. The target is run through the whole policy from step 4 onward, and
 * the full URL is returned only when it passes — so the model's second call is a copy rather than a
 * guess, and the call it copies is one the policy already decided it would allow. When the target
 * fails, the failing code is named and no target path is handed back.
 * @param {object} input
 * @param {NetworkPolicy} input.policy
 * @param {string} input.location
 * @param {string | URL} input.base
 * @param {string} input.method
 * @param {readonly ReservedPort[]} [input.reservedPorts]
 * @param {(value: string) => boolean} [input.credentialDetector]
 * @returns {{ allowed: boolean, url: string | null, host: string | null, port: number | null, code: string | null, reason: string | null }}
 */
export function evaluateRedirectTarget({ policy, location, base, method, reservedPorts, credentialDetector = isCredentialShaped }) {
  const target = resolveLocation(location, base);
  if (target === null) return { allowed: false, url: null, host: null, port: null, code: 'net_url_invalid', reason: 'location' };
  const result = evaluatePolicy({ policy, method, url: target, bodyBytes: 0, reservedPorts, credentialDetector });
  if (!result.ok) {
    const parsed = parseRequestUrl(target);
    return {
      allowed: false,
      url: null,
      host: parsed.ok ? parsed.host : null,
      port: parsed.ok ? parsed.port : null,
      code: result.code,
      reason: result.reason,
    };
  }
  return { allowed: true, url: target, host: result.request.host, port: result.request.port, code: null, reason: null };
}

/**
 * The render-time rules of 35.7, whose failures are exit 4 naming the entry id and the code. They live
 * beside the request-time matcher on purpose: a rule the renderer states and the matcher does not is a
 * rule that stops being true the moment someone edits `config.json` by hand, so both read this one
 * implementation. This is the semantic layer — `schema/config.schema.json` has already refused a wrong
 * type or a missing field, so an entry that will not normalise at all is reported as a host failure
 * rather than given a code of its own. The unconditional reserved rows and the shared credential
 * detector apply whether or not the caller passes them, so a caller that forgets either still refuses.
 * @param {unknown} candidate
 * @param {{ reservedPorts?: readonly ReservedPort[], consentIds?: readonly string[], experimental?: boolean, looksLikeSecret?: (value: string) => boolean }} [context]
 * @returns {{ ok: true, entry: PolicyEntry } | { ok: false, code: string, id: string, reason: string }}
 */
export function validateEntry(candidate, context = {}) {
  const id = describeEntryId(candidate);
  if (hasLoopbackMismatch(candidate)) return { ok: false, code: 'network_entry_host_invalid', id, reason: 'loopback flag disagrees with host' };
  const entry = normalizeEntry(candidate);
  if (!entry) return { ok: false, code: 'network_entry_host_invalid', id, reason: 'shape' };

  const raw = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of ['rejectUnauthorized', 'insecure', 'strictSSL']) {
    if (key in raw) return { ok: false, code: 'network_entry_ca_invalid', id, reason: `forbidden key ${key}` };
  }
  if (!isAsciiHost(entry.host)) return { ok: false, code: 'network_entry_host_not_ascii', id, reason: 'host' };

  const looksLikeSecret = context.looksLikeSecret ?? isCredentialShaped;
  const reserved = Array.isArray(entry.ports) ? entry.ports.map((port) => findReservedPortInAny(port, context.reservedPorts)).find(Boolean) : null;
  if (reserved) return { ok: false, code: 'network_entry_port_reserved', id, reason: `port ${reserved.port} (${reserved.reason})` };
  if (entry.ports === '*' && !entry.loopback) return { ok: false, code: 'network_entry_port_reserved', id, reason: 'wildcard ports off loopback' };

  if (entry.scheme === 'http' && !entry.loopback) return { ok: false, code: 'network_entry_insecure_scheme', id, reason: 'http' };
  const writes = entry.methods.filter((verb) => METHOD_CLASS[/** @type {keyof typeof METHOD_CLASS} */ (verb)] === 'write');
  if (writes.length > 0 && !entry.loopback && !(entry.consentId && context.experimental === true)) {
    return { ok: false, code: 'network_entry_write_not_loopback', id, reason: writes.join(',') };
  }
  if (entry.methods.includes('DELETE') && (!entry.loopback || !entry.destructive)) {
    return { ok: false, code: 'network_entry_delete_not_allowed', id, reason: entry.loopback ? 'destructive' : 'off-machine' };
  }

  const headers = raw.headers && typeof raw.headers === 'object' ? /** @type {Record<string, unknown>} */ (raw.headers) : null;
  if (headers && !entry.loopback) return { ok: false, code: 'network_entry_headers_not_loopback', id, reason: 'headers' };
  if (headers) {
    const secret = Object.entries(headers).find(([, value]) => typeof value === 'string' && looksLikeSecret(value));
    if (secret) return { ok: false, code: 'network_entry_header_looks_like_secret', id, reason: secret[0] };
  }

  if (entry.firebaseEmulator !== false && !entry.loopback) return { ok: false, code: 'network_entry_emulator_not_loopback', id, reason: String(entry.firebaseEmulator) };
  if (entry.caFile !== null && !entry.loopback) return { ok: false, code: 'network_entry_ca_not_loopback', id, reason: 'caFile' };
  if (!entry.shipped && !entry.loopback && !entry.consentId) return { ok: false, code: 'network_entry_no_consent', id, reason: 'missing consentId' };
  if (entry.consentId && Array.isArray(context.consentIds) && !context.consentIds.includes(entry.consentId)) {
    return { ok: false, code: 'network_entry_no_consent', id, reason: 'consentId not in ledger' };
  }

  return { ok: true, entry };
}

/**
 * Pairs of entries that can both match one `(host, port, scheme, pathPrefix)` tuple, which the render
 * refuses with `network_entry_overlap` (`DN25`). Disjointness is what lets a derived entry carry a
 * write method: while a read-only blanket entry still matches the same port, the intersection makes
 * that write unreachable, so the render has to carve the port out rather than rely on ordering.
 * @param {readonly PolicyEntry[]} entries
 * @returns {Array<{ a: string, b: string }>}
 */
export function findEntryOverlaps(entries) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Array<{ a: string, b: string }>} */
  const overlaps = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (entriesOverlap(list[i], list[j])) overlaps.push({ a: list[i].id, b: list[j].id });
    }
  }
  return overlaps;
}

/**
 * The digest `start` records and the plugin re-computes, so a rendered permission set and the policy
 * behind it cannot drift apart unnoticed (12.7.4, V-d). The hash covers the resolved policy with its
 * own `policyHash` removed, and keys are sorted at every level so two equal policies always hash
 * equally whatever order their JSON happened to be written in.
 * @param {unknown} policy
 * @returns {string}
 */
export function hashPolicy(policy) {
  const { policyHash: _ignored, ...rest } = /** @type {Record<string, unknown>} */ (policy ?? {});
  return `sha256:${crypto.createHash('sha256').update(stableStringify(rest)).digest('hex')}`;
}

/**
 * @param {unknown} policy
 * @param {unknown} expected
 * @returns {boolean}
 */
export function policyHashMatches(policy, expected) {
  return typeof expected === 'string' && expected !== '' && hashPolicy(policy) === expected;
}

/**
 * @param {string} reason
 * @returns {{ ok: false, reason: string, policy: NetworkPolicy }}
 */
function closed(reason) {
  return { ok: false, reason, policy: emptyPolicy() };
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {Record<string, unknown>} [detail]
 * @returns {{ ok: false, code: string, reason: string, detail?: Record<string, unknown> }}
 */
function deny(code, reason, detail) {
  return detail ? { ok: false, code, reason, detail } : { ok: false, code, reason };
}

/**
 * @param {unknown} candidate
 * @returns {PolicyEntry | null}
 */
function normalizeEntry(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (candidate);
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(raw.id) ? raw.id : null;
  const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : '';
  if (!id || host === '' || /[/@\s?#]/.test(host)) return null;

  const hostKind = raw.hostKind === 'suffix' || raw.hostKind === 'loopback' ? raw.hostKind : 'exact';
  if (hostKind === 'suffix' && !host.startsWith('*.')) return null;
  if (hostKind !== 'suffix' && host.includes('*')) return null;
  if (hasLoopbackMismatch(candidate)) return null;

  const ports = normalizePorts(raw.ports);
  if (ports === null) return null;
  const excluded = raw.excludePorts === undefined ? [] : normalizePorts(raw.excludePorts);
  if (excluded === null || excluded === '*') return null;
  const scheme = raw.scheme === 'http' || raw.scheme === 'https' || raw.scheme === '*' ? raw.scheme : null;
  if (scheme === null) return null;

  const methods = normalizeMethods(raw.methods);
  if (methods === null) return null;
  const pathPrefix = normalizePathPrefix(raw.pathPrefix);
  if (pathPrefix === null) return null;
  if (raw.headers !== undefined && (raw.headers === null || typeof raw.headers !== 'object' || Array.isArray(raw.headers) || Object.values(raw.headers).some((value) => typeof value !== 'string'))) return null;
  const headers = /** @type {Record<string, string>} */ ({ .../** @type {Record<string, string>} */ (raw.headers ?? {}) });

  return {
    id,
    host: hostKind === 'suffix' ? host.slice(2) : host,
    hostKind,
    ports,
    excludePorts: excluded,
    scheme,
    methods,
    pathPrefix,
    stripLocaleSegment: raw.stripLocaleSegment === true,
    loopback: isLoopbackEntryHost(hostKind, host),
    destructive: raw.destructive === true,
    firebaseEmulator: typeof raw.firebaseEmulator === 'string' && raw.firebaseEmulator !== '' ? raw.firebaseEmulator : false,
    shipped: raw.shipped === true,
    budget: normalizeBudget(raw.budget),
    consentId: typeof raw.consentId === 'string' && raw.consentId !== '' ? raw.consentId : null,
    headers,
    caFile: typeof raw.caFile === 'string' && raw.caFile !== '' ? raw.caFile : null,
  };
}

/**
 * Whether an entry is on this machine, decided by its host and never by its own say-so: every
 * off-machine rule (http, writes, `DELETE`, headers, consent) keys on this, so a self-declared flag
 * would let `config.json` exempt a public host from all of them at once (35.7, `DN6`).
 * @param {string} hostKind
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackEntryHost(hostKind, host) {
  return hostKind === 'loopback' || (hostKind === 'exact' && isLoopbackHostname(host));
}

/**
 * An entry that states a `loopback` flag its host contradicts. It is refused rather than corrected in
 * either direction, because the entry's author and its host disagree about where the request goes.
 * @param {unknown} candidate
 * @returns {boolean}
 */
function hasLoopbackMismatch(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const raw = /** @type {Record<string, unknown>} */ (candidate);
  if (typeof raw.loopback !== 'boolean') return false;
  const hostKind = raw.hostKind === 'suffix' || raw.hostKind === 'loopback' ? raw.hostKind : 'exact';
  const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : '';
  return raw.loopback !== isLoopbackEntryHost(hostKind, host);
}

/**
 * @param {unknown} value
 * @returns {number[] | '*' | null}
 */
function normalizePorts(value) {
  if (value === '*') return '*';
  if (!Array.isArray(value)) return null;
  /** @type {number[]} */
  const ports = [];
  for (const port of value) {
    if (!Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65535) return null;
    ports.push(/** @type {number} */ (port));
  }
  return ports;
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizeMethods(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  /** @type {string[]} */
  const methods = [];
  for (const method of value) {
    if (typeof method !== 'string') return null;
    const verb = method.toUpperCase();
    if (!(verb in METHOD_CLASS)) return null;
    if (!methods.includes(verb)) methods.push(verb);
  }
  return methods;
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizePathPrefix(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  /** @type {string[]} */
  const prefixes = [];
  for (const prefix of value) {
    if (typeof prefix !== 'string' || !prefix.startsWith('/')) return null;
    prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function readLimits(value) {
  /** @type {Record<string, number>} */
  const limits = {};
  if (!value || typeof value !== 'object') return limits;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) limits[key] = entry;
  }
  return limits;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @returns {string[]}
 */
function readStringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item) => typeof item === 'string' && item !== '');
}

/**
 * The rendered table with the unconditional rows always present, or null when the field is missing or
 * any row is unusable: a row that cannot be read is a port that would silently open.
 * @param {unknown} value
 * @returns {ReservedPort[] | null}
 */
function normalizeReservedPorts(value) {
  if (!Array.isArray(value)) return null;
  /** @type {ReservedPort[]} */
  const rows = UNCONDITIONAL_RESERVED_PORTS.map((row) => ({ ...row }));
  for (const row of value) {
    // A plain number is accepted so that an older rendered profile still reserves the port rather than
    // silently opening it; the row simply has no reason to print.
    const record = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : null;
    const port = record ? record.port : row;
    if (!isUsablePort(port)) return null;
    const reason = record && typeof record.reason === 'string' ? record.reason : 'unknown';
    addRow(rows, /** @type {number} */ (port), reason, record?.conditional === true);
  }
  return rows;
}

/**
 * @param {unknown} port
 * @returns {boolean}
 */
function isUsablePort(port) {
  return Number.isInteger(port) && /** @type {number} */ (port) >= 1 && /** @type {number} */ (port) <= 65535;
}

/**
 * @param {ReservedPort[]} rows
 * @param {number | null | undefined} port
 * @param {string} reason
 * @param {boolean} conditional
 */
function addRow(rows, port, reason, conditional) {
  if (!Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65535) return;
  if (rows.some((row) => row.port === port)) return;
  rows.push({ port: /** @type {number} */ (port), reason, conditional });
}

/**
 * @param {PolicyEntry} entry
 * @param {string} scheme
 * @returns {boolean}
 */
function schemeMatches(entry, scheme) {
  return entry.scheme === '*' || entry.scheme === scheme;
}

/**
 * @param {PolicyEntry} entry
 * @param {number} port
 * @returns {boolean}
 */
function portMatches(entry, port) {
  if (Array.isArray(entry.excludePorts) && entry.excludePorts.includes(port)) return false;
  return entry.ports === '*' || (Array.isArray(entry.ports) && entry.ports.includes(port));
}

/**
 * @param {string} query
 * @param {readonly string[]} deniedKeys
 * @param {((value: string) => boolean) | undefined} credentialDetector
 * @returns {{ key: string, reason: string } | null}
 */
function findDeniedQueryKey(query, deniedKeys, credentialDetector) {
  for (const pair of readQueryPairs(query)) {
    if (deniedKeys.includes(pair.key)) return { key: pair.key, reason: 'denied-query-key' };
    if (credentialDetector && pair.value !== '' && credentialDetector(pair.value)) return { key: pair.key, reason: 'credential-shaped-value' };
  }
  return null;
}

/**
 * Step 11. The `demo-` gate runs when *any* matching entry is a Cloud Functions emulator, which is the
 * half of `DN25` that keeps a blanket loopback entry from carrying a request past it. The project's
 * denied segments are checked on every loopback request whatever entry matched, because a live alias
 * key is a fact about the project and not about one entry.
 * @param {import('./url.js').ParsedRequestUrl} parsed
 * @param {ReturnType<typeof intersectEntries>} intersection
 * @param {readonly string[]} deniedProjectSegments
 * @returns {{ ok: false, code: string, reason: string, detail?: Record<string, unknown> } | null}
 */
function checkProjectGates(parsed, intersection, deniedProjectSegments) {
  const segment = firstPathSegment(parsed.decodedPath);
  if (intersection.gates.firebaseFunctions && !DEMO_PROJECT_PATTERN.test(segment)) {
    return deny('net_firebase_project_not_demo', 'first-segment', { entries: intersection.ids });
  }
  if (isLoopbackHostname(parsed.host) && segment !== '' && deniedProjectSegments.includes(segment.toLowerCase())) {
    return deny('net_firebase_project_is_live', 'denied-project-segment');
  }
  return null;
}

/**
 * @param {PolicyEntry} a
 * @param {PolicyEntry} b
 * @returns {boolean}
 */
function entriesOverlap(a, b) {
  return hostsOverlap(a, b) && schemesOverlap(a, b) && portsOverlap(a, b) && pathPrefixesOverlap(a, b);
}

/**
 * @param {PolicyEntry} a
 * @param {PolicyEntry} b
 * @returns {boolean}
 */
function hostsOverlap(a, b) {
  const kinds = [a.hostKind, b.hostKind].sort().join('+');
  if (kinds === 'loopback+loopback') return true;
  if (a.hostKind === 'loopback' || b.hostKind === 'loopback') {
    const other = a.hostKind === 'loopback' ? b : a;
    return other.hostKind === 'exact'
      ? isLoopbackHostname(other.host)
      : ['localhost', '127.0.0.1', '::1'].some((host) => hostMatchesEntry(host, other));
  }
  if (a.hostKind === 'exact' && b.hostKind === 'exact') return a.host === b.host;
  if (a.hostKind === 'suffix' && b.hostKind === 'suffix') return a.host === b.host || a.host.endsWith(`.${b.host}`) || b.host.endsWith(`.${a.host}`);
  const exact = a.hostKind === 'exact' ? a : b;
  const suffix = a.hostKind === 'exact' ? b : a;
  return hostMatchesEntry(exact.host, suffix);
}

/**
 * @param {PolicyEntry} a
 * @param {PolicyEntry} b
 * @returns {boolean}
 */
function schemesOverlap(a, b) {
  return a.scheme === '*' || b.scheme === '*' || a.scheme === b.scheme;
}

/**
 * @param {PolicyEntry} a
 * @param {PolicyEntry} b
 * @returns {boolean}
 */
function portsOverlap(a, b) {
  if (a.ports !== '*' && b.ports !== '*') return a.ports.some((port) => portMatches(b, port) && portMatches(a, port));
  const listed = a.ports === '*' ? b : a;
  const wildcard = a.ports === '*' ? a : b;
  if (listed.ports === '*') {
    // Two wildcards are disjoint only when one excludes every port the other could still reach, which
    // no render produces; treating them as overlapping keeps the check conservative.
    return true;
  }
  return listed.ports.some((port) => portMatches(wildcard, port) && portMatches(listed, port));
}

/**
 * @param {PolicyEntry} a
 * @param {PolicyEntry} b
 * @returns {boolean}
 */
function pathPrefixesOverlap(a, b) {
  return a.pathPrefix.some((left) => b.pathPrefix.some((right) => prefixesOverlap(left, right)));
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function prefixesOverlap(left, right) {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter === '/') return true;
  if (!longer.startsWith(shorter)) return false;
  return shorter.endsWith('/') || longer.length === shorter.length || longer[shorter.length] === '/';
}

/**
 * @param {unknown} host
 * @returns {boolean}
 */
function isAsciiHost(host) {
  return typeof host === 'string' && /^[a-z0-9.:_-]+$/.test(host);
}

/**
 * @param {unknown} candidate
 * @returns {string}
 */
function describeEntryId(candidate) {
  const id = candidate && typeof candidate === 'object' ? /** @type {Record<string, unknown>} */ (candidate).id : null;
  return typeof id === 'string' && id !== '' ? id : '(unnamed)';
}

/**
 * JSON with object keys sorted at every level. The CLI has its own copy in `src/core/hash.js`; the
 * plugin cannot import it, because only `plugin/` is copied into the rendered profile.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
  return sorted;
}
