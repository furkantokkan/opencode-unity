// The `unitynet` tool (amendment 35.5, expansion 12.8, build step S35): the one path by which the model
// can make an HTTP request (`DN1`). This module orders the steps; the modules it imports decide them.
// `policy.js` judges the URL against the resolved entries, `sensitive.js` reads the outbound bytes,
// `ip-rules.js` judges the resolved addresses, `transport.js` connects to the one pinned address, and
// `sanitize.js`/`wrap.js` turn the body into labelled data.
//
// The order is 12.8.2's, and it is the order a refusal is reported in:
//
//    1  arguments                  8  outbound budget             15  3xx returned, never followed
//    2  policy present, hash       9  query keys and values       16  401/407 returned, never retried
//    3  rate limits               10  outbound credential scan    17  content-type gate
//    4  URL parse                 11  demo- and live-project      18  streaming byte budget
//    5  method class                  gates                       19  total timeout
//    6  entry set, intersection   12  ctx.ask, wrapped            20  sanitise, cap, fence
//    7  reserved ports            13  DNS, IP filter, pin         21  log metadata only
//                                 14  connect to the pin
//
// `DN18`: the tool never throws. Every refusal, timeout, redirect and error is an ordinary result
// string. Spike N measured why this is a rule and not a preference on 1.18.31: a rejected `execute`
// reaches the model as OpenCode's raw error text rather than a stable code, and an uncaught denial from
// `ctx.ask` carries the matching permission ruleset into the model's context as JSON.
import dns from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';

import { formatAskPattern } from './ask-pattern.js';
import { createOutboundLedger, measureBodyBytes } from './budget.js';
import { NET_CODES, describeDenial } from './codes.js';
import { filterResolvedAddresses, parseIpAddress } from './ip-rules.js';
import { evaluatePolicy, evaluateRedirectTarget, matchEntries, normalizeNetworkPolicy, policyHashMatches } from './policy.js';
import { mediaTypeEssence } from './sanitize.js';
import { findCredential } from './sensitive.js';
import { sendRequest } from './transport.js';
import { firstPathSegment, isLoopbackHostname, parseRequestUrl, readQueryPairs } from './url.js';
import { sanitizeSummary, wrapUntrusted } from './wrap.js';

/** The tool id. No underscore and no `web` prefix (`DN2`): `"*_*": "deny"` would hide it. */
export const TOOL_ID = 'unitynet';

/**
 * The only place the tool is explained to the model (amendment 35.5, byte-asserted by C29). It refuses
 * the framing the model would prefer: not a search tool, and a refusal is final.
 */
export const TOOL_DESCRIPTION = 'Make one HTTP request to a host this project allowed. Returns the response status and a short, '
  + 'trimmed body as untrusted data. One request per call. No redirects are followed. Not a search '
  + "tool and not a way to read the internet: if the host is not on the project's list, the call is "
  + 'refused and trying another URL will not help.';

/** The method table the model may name (`DN6`), in the spelling the argument schema declares. */
export const TOOL_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** The three arguments of `DN11`. Anything else - a header map, a file, an options object - is refused. */
const ARGUMENT_NAMES = Object.freeze(['body', 'method', 'url']);

/**
 * @typedef {object} NetLimits
 * @property {number} maxResponseBytes
 * @property {number} maxOutputChars
 * @property {number} maxUrlChars
 * @property {number} connectTimeoutMs
 * @property {number} firstByteTimeoutMs
 * @property {number} totalTimeoutMs
 * @property {number} maxRequestsPerSession
 * @property {number} maxRequestsPerMinute
 * @property {number} maxOutputLines
 * @property {number} maxOutputBytes
 */

/**
 * The limits of amendment 35.7, used wherever the rendered policy does not state one. The last two are
 * this step's: the rendered `tool_output` caps are 250 lines and 12,000 bytes, and a result above
 * either is spilled whole to a file in OpenCode's data directory that a later call can pull back in
 * unfenced (claim 135). A character cap alone cannot keep a result under them - 8,192 characters can be
 * 4,096 lines, or 32 KiB of UTF-8 - so the result is fitted to both.
 * @type {Readonly<NetLimits>}
 */
export const DEFAULT_NET_LIMITS = Object.freeze({
  maxResponseBytes: 65536,
  maxOutputChars: 8192,
  maxUrlChars: 2048,
  connectTimeoutMs: 5000,
  firstByteTimeoutMs: 10000,
  totalTimeoutMs: 20000,
  maxRequestsPerSession: 40,
  maxRequestsPerMinute: 20,
  maxOutputLines: 200,
  maxOutputBytes: 11000,
});

/** Step 11's codes. Step 10 runs before them, so a gate refusal is re-checked for a credential first. */
const GATE_CODES = Object.freeze(['net_firebase_project_not_demo', 'net_firebase_project_is_live']);

/** A header an entry may declare: an HTTP token name and a printable, single-line value. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,512}$/;

/** A media type safe to print outside the fence: the header is the server's text, not ours. */
const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** What `readServerPort` answers. `known: false` makes every loopback request fail closed. */
/** @typedef {{ known: boolean, port: number | null }} ServerPortReading */

/**
 * @typedef {object} NetToolContext
 * @property {string} [sessionID]
 * @property {string} [agent]
 * @property {(input: { permission: string, patterns: string[], always: string[], metadata: Record<string, unknown> }) => Promise<void>} [ask]
 */

/**
 * @typedef {object} NetTool
 * @property {string} description
 * @property {Record<string, Record<string, unknown>>} args
 * @property {(args: unknown, ctx?: NetToolContext) => Promise<string>} execute
 * @property {(sessionId: string) => { requests: number, bytes: number, entries: Array<{ id: string, requests: number, bytes: number }> }} snapshot
 */

/**
 * @typedef {object} NetToolOptions
 * @property {unknown} network  The runtime profile's `network` block, unread. Missing or unusable
 *   means every call is refused with `net_disabled` (fail closed, 35.7).
 * @property {{ append: (record: Record<string, unknown>) => void }} [log]
 * @property {() => ServerPortReading} [readServerPort]  Called per request (`DN10`, `D-M33`).
 * @property {(host: string) => Promise<Array<{ address: string, family?: number }>>} [lookup]
 * @property {typeof sendRequest} [send]
 * @property {(file: string) => Promise<string>} [readCaFile]
 * @property {() => number} [now]
 * @property {() => string} [randomHex]  Nonce source for the fence; injected by tests.
 * @property {string} [connectMode]      Forces a transport connect mode; resolved from the runtime otherwise.
 */

/**
 * The argument schema, as plain JSON Schema. OpenCode then marks every property required and validates
 * nothing (claim 134, confirmed by spike O), which is why `execute` validates the object itself. A
 * fresh object per call, so nothing downstream can mutate a shared one.
 * @returns {Record<string, Record<string, unknown>>}
 */
export function createToolArgs() {
  return {
    method: { type: 'string', enum: [...TOOL_METHODS], description: 'HTTP method.' },
    url: { type: 'string', description: 'Absolute http:// or https:// URL from the allowed list.' },
    body: { type: 'string', description: 'Request body for POST/PUT/PATCH. Empty string otherwise.' },
  };
}

/**
 * The port a running OpenCode server occupies, read from the plugin input on every request (`DN10`).
 * OpenCode 1.18.31 exposes `serverUrl` as a getter that falls back to `http://localhost:4096` when no
 * server is bound, so a known port may be a default nobody listens on; reserving it anyway costs one
 * loopback port and never opens one. A getter that throws, or a value that is not a URL with a usable
 * port, is `known: false`.
 * @param {{ serverUrl?: unknown } | null | undefined} input
 * @returns {ServerPortReading}
 */
export function readServerPort(input) {
  let value;
  try {
    value = input?.serverUrl;
  } catch {
    return { known: false, port: null };
  }
  if (value === undefined || value === null) return { known: false, port: null };
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return { known: false, port: null };
  }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { known: false, port: null };
  return { known: true, port };
}

/**
 * Step 1. Exactly three keys, all strings, a method from the table and a URL within `maxUrlChars`.
 * Whether a body belongs on the method is step 5's question and has its own code.
 * @param {unknown} args
 * @param {number} maxUrlChars
 * @returns {{ ok: true, method: string, url: string, body: string } | { ok: false, reason: string }}
 */
export function validateArguments(args, maxUrlChars) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'not-an-object' };
  const keys = Object.keys(args);
  if (keys.some((key) => !ARGUMENT_NAMES.includes(key))) return { ok: false, reason: 'unexpected-key' };
  if (ARGUMENT_NAMES.some((name) => !keys.includes(name))) return { ok: false, reason: 'missing-key' };
  const { method, url, body } = /** @type {Record<string, unknown>} */ (args);
  if (typeof method !== 'string' || typeof url !== 'string' || typeof body !== 'string') return { ok: false, reason: 'not-a-string' };
  if (!TOOL_METHODS.includes(method)) return { ok: false, reason: 'unknown-method' };
  if (url.length > maxUrlChars) return { ok: false, reason: 'url-too-long' };
  return { ok: true, method, url, body };
}

/**
 * Builds the tool over one runtime profile. The policy is read and its hash checked once, when the
 * plugin loads: the profile is the one `start` rendered for this session, and a changed profile is
 * picked up by the next session, not by this one.
 * @param {NetToolOptions} options
 * @returns {NetTool}
 */
export function createNetTool({
  network,
  log = { append: () => {} },
  readServerPort: readPort = () => ({ known: false, port: null }),
  lookup = lookupAll,
  send = sendRequest,
  readCaFile = (file) => fs.readFile(file, 'utf8'),
  now = Date.now,
  randomHex,
  connectMode,
}) {
  const state = loadPolicyState(network);
  const limits = resolveLimits(state.policy?.limits);
  const headersById = readLoopbackHeaders(network, state.policy);
  /** @type {Map<string, string>} */
  const caCache = new Map();
  // The minute window spans every session in this process, so child sessions cannot multiply it; the
  // session cap is per session, which is what `status` and the session summary report.
  const minuteLedger = createOutboundLedger({ maxRequestsPerSession: Number.POSITIVE_INFINITY, maxRequestsPerMinute: limits.maxRequestsPerMinute, now });
  /** @type {Map<string, ReturnType<typeof createOutboundLedger>>} */
  const sessionLedgers = new Map();

  /**
   * @param {string} sessionId
   */
  const ledgerFor = (sessionId) => {
    let ledger = sessionLedgers.get(sessionId);
    if (!ledger) {
      ledger = createOutboundLedger({ maxRequestsPerSession: limits.maxRequestsPerSession, maxRequestsPerMinute: Number.POSITIVE_INFINITY, now });
      sessionLedgers.set(sessionId, ledger);
    }
    return ledger;
  };

  /**
   * @param {ReturnType<typeof createOutboundLedger>} ledger
   * @returns {{ ok: true } | { ok: false, reason: string, limit: number }}
   */
  const checkRate = (ledger) => {
    const at = now();
    const session = ledger.check(at);
    if (!session.ok) return { ok: false, reason: session.scope, limit: session.limit };
    const minute = minuteLedger.check(at);
    if (!minute.ok) return { ok: false, reason: minute.scope, limit: minute.limit };
    return { ok: true };
  };

  const readServer = () => {
    try {
      const reading = readPort();
      return reading && reading.known && Number.isInteger(reading.port) ? reading : { known: false, port: null };
    } catch {
      return { known: false, port: null };
    }
  };

  /**
   * @param {CallRecord} call
   * @param {unknown} args
   * @param {NetToolContext} ctx
   * @returns {Promise<string>}
   */
  async function handle(call, args, ctx) {
    // Step 1.
    const validated = validateArguments(args, limits.maxUrlChars);
    if (!validated.ok) return refuse(call, 'net_bad_arguments', { reason: validated.reason, limit: limits.maxUrlChars });
    const { method, url, body } = validated;
    call.method = method;
    call.bodyBytes = measureBodyBytes(body);
    const target = parseRequestUrl(url);
    if (target.ok) noteTarget(call, target, state.policy);

    // Step 2.
    if (state.kind === 'drift') return refuse(call, 'net_policy_drift', { reason: state.reason ?? undefined });
    if (state.kind !== 'ready' || !state.policy) return refuse(call, 'net_disabled', { reason: state.reason ?? undefined });
    const policy = state.policy;

    // Step 3.
    const ledger = ledgerFor(call.sessionId);
    const rate = checkRate(ledger);
    if (!rate.ok) return refuse(call, 'net_rate_limited', rate);

    // The OpenCode server row of the reserved table exists only here, per request. When its port cannot
    // be determined, loopback fails closed; a host off this machine cannot reach it anyway.
    const server = readServer();
    const requestReserved = server.known ? [{ port: /** @type {number} */ (server.port), reason: 'opencode-server', conditional: true }] : [];
    if (!server.known && target.ok && isLoopbackHostname(target.host)) {
      return refuse(call, 'net_reserved_port', { reason: 'opencode-server-unknown', port: target.port });
    }

    // Steps 4 to 9 and 11.
    const decision = evaluatePolicy({ policy, method, url, body, reservedPorts: requestReserved });
    if (!decision.ok) {
      if (GATE_CODES.includes(decision.code) && target.ok) {
        const leak = scanOutbound(url, target.decodedPath, body);
        if (leak) return refuse(call, 'net_sensitive_outbound', leak);
      }
      return refuse(call, decision.code, denialContext(decision, target));
    }
    call.entryIds = decision.entryIds;

    // Step 10.
    const leak = scanOutbound(url, decision.request.decodedPath, body);
    if (leak) return refuse(call, 'net_sensitive_outbound', leak);

    // Step 12.
    const permission = await askPermission(ctx, method, decision.request.url);
    if (!permission.ok) return refuse(call, 'net_permission_denied', permission);

    // Step 13. The total time limit starts here rather than at step 1, so a human answering a
    // permission prompt is never timed.
    const deadline = now() + limits.totalTimeoutMs;
    const resolved = await resolvePinnedAddress(decision.request.host, decision.loopback, deadline);
    if (!resolved.ok) return refuse(call, resolved.code, { rule: resolved.rule });

    // Step 14.
    const ca = await readTrustAnchor(decision.entries, decision.request.scheme);
    if (!ca.ok) return refuse(call, 'net_tls_untrusted', { reason: 'ca-file', loopback: decision.loopback });

    // The rate check is repeated with the record, synchronously, so parallel calls cannot all pass
    // step 3 during their permission waits and then exceed the cap together.
    const again = checkRate(ledger);
    if (!again.ok) return refuse(call, 'net_rate_limited', again);
    const spent = decision.spent.path + decision.spent.query + decision.spent.body;
    ledger.record({ entryIds: decision.entryIds, bytes: spent, now: now() });
    minuteLedger.record({ entryIds: decision.entryIds, bytes: spent, now: now() });

    const result = await send({
      method,
      url: decision.request.url.href,
      pinned: resolved.pinned,
      host: decision.request.host,
      headers: headersFor(decision.entries),
      body: decision.bodyBytes > 0 ? body : null,
      ca: ca.ca,
      limits: {
        maxResponseBytes: limits.maxResponseBytes,
        connectTimeoutMs: limits.connectTimeoutMs,
        firstByteTimeoutMs: limits.firstByteTimeoutMs,
        totalTimeoutMs: Math.max(1, deadline - now()),
      },
      ...(connectMode ? { connectMode } : {}),
    });

    // Steps 15 to 20.
    return renderResponse(call, { method, decision, result, requestReserved });
  }

  /**
   * Step 13: resolve once, keep only addresses the IP policy allows for this entry class, pin the first.
   * A literal address is its own answer; no resolver is asked about it.
   * @param {string} host
   * @param {boolean} loopback
   * @param {number} deadline
   * @returns {Promise<{ ok: true, pinned: import('./ip-rules.js').IpAddress } | { ok: false, code: string, rule?: string }>}
   */
  async function resolvePinnedAddress(host, loopback, deadline) {
    /** @type {string[]} */
    let addresses;
    const literal = parseIpAddress(host);
    if (literal) {
      addresses = [literal.text];
    } else {
      const answer = await withDeadline(() => lookup(host), deadline - now());
      if (answer.timedOut) return { ok: false, code: 'net_total_timeout' };
      if (!answer.ok || !Array.isArray(answer.value)) return { ok: false, code: 'net_dns_failed' };
      addresses = answer.value.map((item) => (item && typeof item === 'object' ? String(item.address) : String(item)));
    }
    const { allowed, blocked } = filterResolvedAddresses(addresses, { loopback });
    if (allowed.length === 0) {
      return blocked.length > 0 ? { ok: false, code: 'net_address_blocked', rule: blocked[0].rule } : { ok: false, code: 'net_dns_failed' };
    }
    return { ok: true, pinned: allowed[0] };
  }

  /**
   * `DN24`: a local trust anchor is only ever a loopback entry's render-validated `caFile`, and only
   * when every matching entry names the same one. It must be an absolute path - a relative one would
   * resolve against the project directory, which is not where trust comes from - and it must hold a
   * certificate and no private key.
   * @param {readonly import('./policy.js').PolicyEntry[]} entries
   * @param {string} scheme
   * @returns {Promise<{ ok: true, ca: string | null } | { ok: false }>}
   */
  async function readTrustAnchor(entries, scheme) {
    if (scheme !== 'https') return { ok: true, ca: null };
    const files = [...new Set(entries.map((entry) => entry.caFile))];
    if (files.length !== 1 || files[0] === null || !entries.every((entry) => entry.loopback)) return { ok: true, ca: null };
    const file = files[0];
    if (!path.isAbsolute(file)) return { ok: false };
    const cached = caCache.get(file);
    if (cached !== undefined) return { ok: true, ca: cached };
    try {
      const text = String(await readCaFile(file));
      if (!text.includes('-----BEGIN CERTIFICATE-----') || /PRIVATE KEY-----/.test(text)) return { ok: false };
      caCache.set(file, text);
      return { ok: true, ca: text };
    } catch {
      return { ok: false };
    }
  }

  /**
   * `DN12`: literal headers only from loopback entries, and only those every matching entry declares
   * with the same value, so a second matching entry can narrow the set but never add to it.
   * @param {readonly import('./policy.js').PolicyEntry[]} entries
   * @returns {Record<string, string>}
   */
  function headersFor(entries) {
    if (entries.length === 0 || !entries.every((entry) => entry.loopback)) return {};
    const [first, ...rest] = entries.map((entry) => headersById.get(entry.id) ?? {});
    /** @type {Record<string, string>} */
    const common = {};
    for (const [name, value] of Object.entries(first)) {
      if (rest.every((other) => other[name] === value)) common[name] = value;
    }
    return common;
  }

  /**
   * Steps 15 to 20: a redirect or a credential challenge is reported and stopped, a refusal from the
   * transport becomes a refusal line, and a body is sanitised, fitted and fenced.
   * @param {CallRecord} call
   * @param {{ method: string, decision: PolicyDecision, result: import('./transport.js').TransportResult, requestReserved: import('./policy.js').ReservedPort[] }} input
   * @returns {string}
   */
  function renderResponse(call, { method, decision, result, requestReserved }) {
    call.status = result.status;
    call.responseBytes = result.bytesRead;
    call.contentType = safeMediaType(result.contentType);
    call.truncated = result.truncatedAtBytes;

    if (result.stoppedBy === 'redirect') {
      call.verdict = 'redirect';
      return renderRedirect(call, { method, decision, redirect: result.redirect, requestReserved, policy: /** @type {import('./policy.js').NetworkPolicy} */ (state.policy) });
    }
    if (result.stoppedBy === 'auth-required') {
      call.verdict = 'auth-required';
      return sanitizeSummary(`unitynet ${method} ${call.origin} ${result.status} authentication required; the request was not retried, and this tool never signs in or sends a credential.`);
    }
    if (!result.ok) {
      return refuse(call, result.code ?? 'net_connect_failed', {
        loopback: decision.loopback,
        contentType: call.contentType ?? undefined,
        contentLength: result.contentLength ?? undefined,
      });
    }

    call.verdict = 'allowed';
    if (result.code) call.code = result.code;
    const notes = [];
    if (result.truncatedAtBytes) notes.push(`cut at ${result.bytesRead} bytes`);
    if (result.stoppedBy === 'total-timeout') notes.push('stopped at the total time limit (net_total_timeout)');
    if (result.stoppedBy === 'connection-lost') notes.push(`connection lost (${result.code})`);
    const summary = `unitynet ${method} ${call.origin} ${result.status} ${call.contentType ?? 'unknown'} ${result.bytesRead} bytes in ${result.durationMs} ms${notes.length ? `, ${notes.join(', ')}` : ''}`;
    if (result.body === '') return sanitizeSummary(`${summary}, no body.`);
    return fitOutput({ summary, text: result.body, contentType: call.contentType ?? undefined, limits, randomHex });
  }

  return {
    description: TOOL_DESCRIPTION,
    args: createToolArgs(),
    async execute(args, ctx = {}) {
      const call = startCall(ctx, readClock(now));
      let text;
      try {
        text = await handle(call, args, ctx ?? {});
      } catch {
        // A defect in this module, or a dependency that broke its own never-throws contract. The model
        // still gets a result, and the session log still gets a record (`DN18`).
        text = refuse(call, 'net_tool_error', {});
      }
      const ended = readClock(now);
      call.durationMs = Number.isFinite(ended) && Number.isFinite(call.startedAt) ? ended - call.startedAt : null;
      writeLog(log, call);
      return text;
    },
    snapshot(sessionId) {
      return sessionLedgers.get(sessionId)?.snapshot() ?? { requests: 0, bytes: 0, entries: [] };
    },
  };
}

/**
 * @typedef {Extract<ReturnType<typeof evaluatePolicy>, { ok: true }>} PolicyDecision
 */

/**
 * What one call leaves in the session log (12.12.5): metadata only. The host is kept only when it
 * matched an entry, so a name the policy refused - which the model may have composed - is logged as a
 * length rather than as text.
 * @typedef {object} CallRecord
 * @property {number} startedAt
 * @property {string} sessionId
 * @property {string} agent
 * @property {string | null} method
 * @property {string | null} scheme
 * @property {string | null} host        Display host for the result line; never logged unless matched.
 * @property {boolean} hostMatched
 * @property {number | null} port
 * @property {string | null} origin
 * @property {string[]} entryIds
 * @property {number | null} pathChars
 * @property {boolean | null} queryPresent
 * @property {number | null} queryKeys
 * @property {number | null} bodyBytes
 * @property {number | null} status
 * @property {number | null} responseBytes
 * @property {string | null} contentType
 * @property {number | null} durationMs
 * @property {string} code
 * @property {string} verdict
 * @property {number | null} step
 * @property {boolean} truncated
 */

/**
 * The clock outside the guarded part of `execute`, which must not be able to throw either.
 * @param {() => number} now
 * @returns {number}
 */
function readClock(now) {
  try {
    return now();
  } catch {
    return Number.NaN;
  }
}

/**
 * @param {NetToolContext | null | undefined} ctx
 * @param {number} at
 * @returns {CallRecord}
 */
function startCall(ctx, at) {
  return {
    startedAt: at,
    sessionId: typeof ctx?.sessionID === 'string' ? ctx.sessionID : '',
    agent: typeof ctx?.agent === 'string' ? ctx.agent : '',
    method: null,
    scheme: null,
    host: null,
    hostMatched: false,
    port: null,
    origin: null,
    entryIds: [],
    pathChars: null,
    queryPresent: null,
    queryKeys: null,
    bodyBytes: null,
    status: null,
    responseBytes: null,
    contentType: null,
    durationMs: null,
    code: 'ok',
    verdict: 'allowed',
    step: null,
    truncated: false,
  };
}

/**
 * @param {CallRecord} call
 * @param {import('./url.js').ParsedRequestUrl} target
 * @param {import('./policy.js').NetworkPolicy | null} policy
 */
function noteTarget(call, target, policy) {
  call.scheme = target.scheme;
  call.host = target.host;
  call.port = target.port;
  call.origin = target.origin;
  call.pathChars = target.path.length;
  call.queryPresent = target.query !== '';
  call.queryKeys = readQueryPairs(target.query).length;
  if (policy) {
    const matched = matchEntries(policy, target);
    call.hostMatched = matched.ok || matched.code !== 'net_host_not_allowed';
    if (matched.ok) call.entryIds = matched.entries.map((entry) => entry.id);
  }
}

/**
 * The refusal line: the same header shape as a result, the code in place of the status, and no block
 * (12.8.6). It names the command that would fix it when there is one (`DN5`).
 * @param {CallRecord} call
 * @param {string} code
 * @param {import('./codes.js').DenialContext & { contentType?: string, contentLength?: number }} context
 * @returns {string}
 */
function refuse(call, code, context) {
  const known = Object.prototype.hasOwnProperty.call(NET_CODES, code) ? code : 'net_tool_error';
  call.code = known;
  call.verdict = 'refused';
  call.step = NET_CODES[/** @type {keyof typeof NET_CODES} */ (known)].step;
  const { sentence, remedy } = describeDenial(known, {
    method: call.method ?? undefined,
    host: call.host ?? undefined,
    port: call.port ?? undefined,
    origin: call.origin ?? undefined,
    loopback: call.host !== null && isLoopbackHostname(call.host),
    ...context,
  });
  const detail = code === 'net_content_type_not_text' && context.contentType
    ? `the response is ${context.contentType}${typeof context.contentLength === 'number' ? `, ${context.contentLength} bytes declared` : ''}, which this tool does not show`
    : sentence;
  const head = ['unitynet', call.method, call.origin, call.status].filter((part) => part !== null && part !== undefined && part !== '').join(' ');
  const stop = /[.!?]$/.test(detail) ? '' : '.';
  return sanitizeSummary(`${head} refused ${known}: ${detail}${stop}${remedy ? ` ${remedy}` : ''}`);
}

/**
 * The context a policy refusal is described with. Only facts the policy decided, never the path,
 * query or body.
 * @param {{ code: string, reason: string, detail?: Record<string, unknown> }} decision
 * @param {ReturnType<typeof parseRequestUrl>} target
 * @returns {import('./codes.js').DenialContext}
 */
function denialContext(decision, target) {
  const detail = decision.detail ?? {};
  /** @type {import('./codes.js').DenialContext} */
  const context = { reason: decision.reason };
  if (typeof detail.field === 'string') context.field = detail.field;
  if (typeof detail.limit === 'number') context.limit = detail.limit;
  if (typeof detail.actual === 'number') context.actual = detail.actual;
  if (typeof detail.key === 'string') context.key = detail.key;
  if (typeof detail.port === 'number') context.port = detail.port;
  if (target.ok) context.segment = firstPathSegment(target.decodedPath);
  return context;
}

/**
 * Step 10: the URL as the model wrote it, its path once decoded (so a credential cannot hide behind
 * percent-encoding), and the body. A hit names the pattern id, never the text.
 * @param {string} url
 * @param {string} decodedPath
 * @param {string} body
 * @returns {{ part: string, patternId: string } | null}
 */
function scanOutbound(url, decodedPath, body) {
  for (const [part, text] of [['url', url], ['url', decodedPath], ['body', body]]) {
    const hit = findCredential(text);
    if (hit) return { part, patternId: hit.patternId };
  }
  return null;
}

/**
 * Step 12, with the pattern of 35.7 and `always: []`, so answering "always" can never widen anything
 * beyond this one request. Every rejection is a result: a rule denial, a human's refusal, a refusal with
 * feedback - whose words are passed on, because a human wrote them - and a runtime with no `ask` at all.
 * @param {NetToolContext} ctx
 * @param {string} method
 * @param {URL} url
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, feedback?: string }>}
 */
async function askPermission(ctx, method, url) {
  if (typeof ctx?.ask !== 'function') return { ok: false, reason: 'no-ask' };
  try {
    await ctx.ask({ permission: TOOL_ID, patterns: [formatAskPattern(method, url)], always: [], metadata: {} });
    return { ok: true };
  } catch (error) {
    return classifyPermissionError(error);
  }
}

/**
 * The three permission errors spike N observed, by name. The denial's message is never passed on: it
 * carries the matching ruleset as JSON.
 * @param {unknown} error
 * @returns {{ ok: false, reason: string, feedback?: string }}
 */
export function classifyPermissionError(error) {
  const value = /** @type {{ name?: unknown, _tag?: unknown, feedback?: unknown, message?: unknown } | null} */ (error);
  const name = typeof value?._tag === 'string' ? value._tag : typeof value?.name === 'string' ? value.name : '';
  if (name === 'PermissionDeniedError') return { ok: false, reason: 'rule' };
  if (name === 'PermissionRejectedError') return { ok: false, reason: 'rejected' };
  if (name === 'PermissionCorrectedError') {
    const words = typeof value?.feedback === 'string' ? value.feedback : typeof value?.message === 'string' ? value.message : '';
    const feedback = sanitizeSummary(words).slice(0, 300);
    return feedback ? { ok: false, reason: 'corrected', feedback } : { ok: false, reason: 'corrected' };
  }
  return { ok: false, reason: 'unknown' };
}

/**
 * Step 15. The target is run through the whole policy again - steps 4 to 11, including the outbound
 * scan - and the full URL is handed back only when it passes, so the model's next call is a copy of one
 * the policy already accepted. When it fails, the host and port are named and no path is returned.
 * 307 and 308 keep the method; every other redirect is judged as the read a client would make next.
 * @param {CallRecord} call
 * @param {{ method: string, decision: PolicyDecision, redirect: import('./transport.js').RedirectSeen | null, requestReserved: import('./policy.js').ReservedPort[], policy: import('./policy.js').NetworkPolicy }} input
 * @returns {string}
 */
function renderRedirect(call, { method, decision, redirect, requestReserved, policy }) {
  const status = redirect?.status ?? call.status ?? 0;
  const head = `unitynet ${method} ${call.origin} ${status} redirect`;
  const closing = 'Call again with an allowed URL if you have one.';
  if (!redirect?.location) return sanitizeSummary(`${head} with no usable location, not followed. ${closing}`);
  const nextMethod = status === 307 || status === 308 ? method : method === 'HEAD' ? 'HEAD' : 'GET';
  const target = evaluateRedirectTarget({ policy, location: redirect.location, base: decision.request.url, method: nextMethod, reservedPorts: requestReserved });
  if (target.allowed && target.url && !findCredential(target.url)) {
    return sanitizeSummary(`${head} to ${target.url}, allowed. It was not followed; call again with that URL if you still need it.`);
  }
  if (target.host === null || target.port === null) return sanitizeSummary(`${head} to an unusable location, not followed. ${closing}`);
  const where = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
  return sanitizeSummary(`${head} to ${where}, not allowed (${target.code ?? 'net_sensitive_outbound'}). It was not followed. ${closing}`);
}

/**
 * Step 20: sanitise, cap and fence - and then make sure the result is also under the line and byte
 * caps, by shrinking the character cap until both hold. The body is re-sanitised on each pass, which
 * is cheap next to the 64 KiB it can be, and each pass draws a fresh nonce against the final text.
 * @param {{ summary: string, text: string, contentType?: string, limits: NetLimits, randomHex?: () => string }} input
 * @returns {string}
 */
export function fitOutput({ summary, text, contentType, limits, randomHex }) {
  let cap = limits.maxOutputChars;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const wrapped = wrapUntrusted({ channel: 'network', summary, text, contentType, maxOutputChars: cap, ...(randomHex ? { randomHex } : {}) });
    const lines = wrapped.text.split('\n').length;
    const bytes = new TextEncoder().encode(wrapped.text).length;
    if ((lines <= limits.maxOutputLines && bytes <= limits.maxOutputBytes) || cap === 0) return wrapped.text;
    const ratio = Math.min(limits.maxOutputLines / lines, limits.maxOutputBytes / bytes);
    cap = Math.max(0, Math.floor(Math.min(cap, wrapped.text.length) * ratio * 0.9));
  }
  return wrapUntrusted({ channel: 'network', summary, text, contentType, maxOutputChars: 0, ...(randomHex ? { randomHex } : {}) }).text;
}

/**
 * The server's `Content-Type`, reduced to a type and subtype that are safe to print outside the fence.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function safeMediaType(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const essence = mediaTypeEssence(value);
  return SAFE_MEDIA_TYPE.test(essence) ? essence : 'unknown';
}

/**
 * Step 21 (12.12.5): entry id, method, scheme, host, port, path length, whether a query was present,
 * query key count, body bytes, status, response bytes, content type, duration, code and truncation.
 * No path, no query, no header value, no body. The log itself drops anything it does not know.
 * @param {{ append: (record: Record<string, unknown>) => void }} log
 * @param {CallRecord} call
 */
function writeLog(log, call) {
  /** @type {Record<string, unknown>} */
  const record = {
    event: 'net',
    tool: TOOL_ID,
    sessionId: call.sessionId,
    agent: call.agent,
    verdict: call.verdict,
    code: call.code,
  };
  if (call.step !== null) record.step = call.step;
  if (call.entryIds.length > 0) record.entry = call.entryIds.join(',');
  if (call.method) record.method = call.method;
  if (call.scheme) record.scheme = call.scheme;
  if (call.host !== null) {
    if (call.hostMatched) record.host = call.host;
    else record.hostChars = call.host.length;
  }
  for (const key of /** @type {const} */ (['port', 'pathChars', 'queryPresent', 'queryKeys', 'bodyBytes', 'status', 'responseBytes', 'durationMs'])) {
    if (call[key] !== null) record[key] = call[key];
  }
  if (call.contentType) record.contentType = call.contentType;
  record.truncated = call.truncated;
  try {
    log.append(record);
  } catch {
    // The log is a diagnostic; losing a line must never cost the model its result.
  }
}

/**
 * Step 2's reading of the runtime profile, once per plugin load. An unusable block is `disabled`; a
 * usable one whose recorded `policyHash` does not match its own content is `drift`, and refuses every
 * call - `start` checked the rendered permissions against that hash, so a block that no longer matches
 * it is not the policy those permissions were checked against.
 * @param {unknown} network
 * @returns {{ kind: 'ready' | 'disabled' | 'drift', reason: string | null, policy: import('./policy.js').NetworkPolicy | null }}
 */
function loadPolicyState(network) {
  try {
    const loaded = normalizeNetworkPolicy(network);
    if (!loaded.ok) return { kind: 'disabled', reason: loaded.reason, policy: null };
    if (!policyHashMatches(loaded.policy, loaded.policy.policyHash)) return { kind: 'drift', reason: 'policy-hash', policy: loaded.policy };
    return { kind: 'ready', reason: null, policy: loaded.policy };
  } catch {
    return { kind: 'disabled', reason: 'unreadable', policy: null };
  }
}

/**
 * @param {Record<string, number> | undefined} policyLimits
 * @returns {NetLimits}
 */
function resolveLimits(policyLimits) {
  /** @type {Record<string, number>} */
  const limits = { ...DEFAULT_NET_LIMITS };
  for (const key of Object.keys(DEFAULT_NET_LIMITS)) {
    const value = policyLimits?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = value;
  }
  return /** @type {NetLimits} */ (limits);
}

/**
 * The literal headers of loopback entries, read from the rendered block because the normalised entry
 * does not carry them. A header that is not a plain token and a printable single-line value, or whose
 * value looks like a credential, is dropped: the one value a loopback entry needs is the emulator's
 * `Bearer owner`, which the detector deliberately does not flag.
 * @param {unknown} network
 * @param {import('./policy.js').NetworkPolicy | null} policy
 * @returns {Map<string, Record<string, string>>}
 */
function readLoopbackHeaders(network, policy) {
  /** @type {Map<string, Record<string, string>>} */
  const byId = new Map();
  if (!policy) return byId;
  const raw = /** @type {{ entries?: unknown }} */ (network ?? {});
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
  for (const entry of policy.entries) {
    if (!entry.loopback) continue;
    const source = rawEntries.find((candidate) => candidate && typeof candidate === 'object' && /** @type {{ id?: unknown }} */ (candidate).id === entry.id);
    const declared = /** @type {{ headers?: unknown } | undefined} */ (source)?.headers;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) continue;
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(declared)) {
      if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) continue;
      if (findCredential(value)) continue;
      headers[name.toLowerCase()] = value;
    }
    byId.set(entry.id, headers);
  }
  return byId;
}

/**
 * The resolver of step 13: every address, in the order the system returns them.
 * @param {string} host
 * @returns {Promise<Array<{ address: string, family: number }>>}
 */
export function lookupAll(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * Runs `work` against a time limit without leaving a timer behind either way.
 * @template T
 * @param {() => Promise<T>} work
 * @param {number} budgetMs
 * @returns {Promise<{ ok: true, timedOut: false, value: T } | { ok: false, timedOut: boolean }>}
 */
async function withDeadline(work, budgetMs) {
  if (budgetMs <= 0) return { ok: false, timedOut: true };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), budgetMs);
  });
  try {
    const settled = Promise.resolve()
      .then(work)
      .then((value) => ({ ok: true, timedOut: false, value }), () => ({ ok: false, timedOut: false }));
    return /** @type {any} */ (await Promise.race([settled, expired]));
  } finally {
    clearTimeout(timer);
  }
}
