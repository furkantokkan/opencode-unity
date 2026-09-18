// The outbound HTTP transport (amendment 35, build step S33). One request, to one address that was
// decided before the connection started, with three independent timeouts, a streaming byte budget, a
// content-type gate, and a full stop at a redirect.
//
// This module performs no name resolution. The caller resolves the host, filters every answer through
// the IP policy and hands the surviving address in as `pinned`; the transport's whole job is to make
// sure the socket reaches that address and nothing else. That is what closes the window between the
// check and the connect: a second answer from a resolver, or a resolver that answers differently the
// second time, has nothing to attach to here.
//
// The code runs inside the OpenCode plugin, which runs under Bun, so it cannot assume Node's lookup
// semantics (amendment `DN23`, spike P). Two connection modes exist:
//
//   `pinned-lookup`    a custom `lookup` that only ever answers with the pinned address. Needs the
//                      runtime to honour a `lookup` passed through `http.request`.
//   `literal-address`  connect straight to the literal pinned address, with `servername` and the
//                      certificate check set to the host name the policy validated, and the `Host`
//                      header carrying the original authority. Needs no custom `lookup` at all, which
//                      is why it is the recorded fallback.
//
// Whichever mode runs, the socket's own `remoteAddress` is compared against the pin once it is
// connected, and a mismatch ends the request. A runtime that quietly ignored the `lookup` therefore
// fails closed rather than fetching from wherever it landed.
//
// The seam with S31: step 13 resolves the host, runs every answer through `ip-rules.js` and hands the
// surviving `IpAddress` in as `pinned`. Addresses are compared with that module's parser rather than a
// second one here, and a `Location` header is resolved and judged by `url.resolveLocation` and
// `policy.evaluateRedirectTarget` in the tool - this module reports the header and stops.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

import { ADDRESS_BLOCKED_CODE, parseIpAddress } from './ip-rules.js';
import { mediaTypeEssence } from './sanitize.js';

/**
 * Stable deny and stop codes this module can produce. The tool (S35) surfaces them to the model and
 * the session log; `net_connect_failed` and `net_content_encoding_not_identity` are additions this
 * step needed and are listed in the step report.
 */
export const TRANSPORT_CODES = Object.freeze({
  connectTimeout: 'net_connect_timeout',
  firstByteTimeout: 'net_first_byte_timeout',
  totalTimeout: 'net_total_timeout',
  tlsUntrusted: 'net_tls_untrusted',
  tlsHostnameMismatch: 'net_tls_hostname_mismatch',
  addressBlocked: ADDRESS_BLOCKED_CODE,
  contentTypeNotText: 'net_content_type_not_text',
  connectFailed: 'net_connect_failed',
  contentEncodingNotIdentity: 'net_content_encoding_not_identity',
});

/** @type {readonly string[]} */
export const TRANSPORT_DENY_CODES = Object.freeze(Object.values(TRANSPORT_CODES));

/** How the socket is aimed at the pinned address. */
export const CONNECT_MODES = Object.freeze({ pinnedLookup: 'pinned-lookup', literalAddress: 'literal-address' });

/** Response media types the model may be shown; everything else returns type and length only. */
const k_allowedContentTypes = Object.freeze([
  /^text\/[\w.+-]+$/,
  /^application\/json$/,
  /^application\/[\w.+-]+\+json$/,
  /^application\/xml$/,
  /^application\/x-ndjson$/,
]);

/** Headers the transport owns; an entry's literal headers can never replace one of them. */
const k_reservedHeaders = Object.freeze(['host', 'accept-encoding', 'connection', 'content-length']);

/** TLS failures that mean "this certificate cannot be trusted" rather than "it is for someone else". */
const k_untrustedCertCodes = Object.freeze([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_FORMAT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

const k_defaultUserAgent = 'opencode-unity';

/**
 * The three codes that mean a budget ran out rather than something going wrong.
 * @type {readonly string[]}
 */
const k_timeoutCodes = Object.freeze([TRANSPORT_CODES.connectTimeout, TRANSPORT_CODES.firstByteTimeout, TRANSPORT_CODES.totalTimeout]);

/**
 * The address step 13 kept: one entry of what `ip-rules.filterResolvedAddresses` returned. `text` is
 * the normalised spelling, and an IPv4-mapped answer has already been reduced to its IPv4 form.
 * @typedef {import('./ip-rules.js').IpAddress} PinnedAddress
 */

/**
 * The four limits of amendment 35.7, read off the resolved policy.
 * @typedef {object} TransportLimits
 * @property {number} maxResponseBytes
 * @property {number} connectTimeoutMs
 * @property {number} firstByteTimeoutMs
 * @property {number} totalTimeoutMs
 */

/**
 * @typedef {object} TransportRequest
 * @property {string} method            Upper-case, already checked against the matching entries.
 * @property {string} url               The validated absolute URL.
 * @property {PinnedAddress} pinned     The address step 13 kept; the only address this call may reach.
 * @property {string} [host]            The host name to verify the certificate against. Defaults to the
 *                                      URL's host name, which is what a `*.` suffix entry authorises.
 * @property {Record<string, string>} [headers]  The entry's literal headers (loopback only).
 * @property {string | Uint8Array | null} [body]
 * @property {string | null} [ca]       PEM trust anchor from a loopback entry's `caFile`.
 * @property {TransportLimits} limits
 * @property {string} [connectMode]     One of `CONNECT_MODES`; resolved from the runtime when absent.
 * @property {string} [userAgent]
 */

/**
 * A 3xx, reported and stopped. Resolving the header against the request URL and deciding whether that
 * target is allowed is the tool's step 15, through `url.resolveLocation` and
 * `policy.evaluateRedirectTarget`: one resolver, not two with different rules.
 * @typedef {object} RedirectSeen
 * @property {number} status
 * @property {string | null} location   The raw `Location` header.
 */

/**
 * @typedef {'complete' | 'byte-budget' | 'total-timeout' | 'auth-required' | 'redirect' | 'connection-lost'} StopReason
 */

/**
 * @typedef {object} TransportResult
 * @property {boolean} ok               True when a status was received and the call was not refused.
 * @property {string | null} code       The deny code, or the stop reason's code; null on a clean read.
 * @property {string | null} detail     One short English sentence for the model; never the body.
 * @property {number | null} status
 * @property {string | null} contentType
 * @property {number | null} contentLength   The declared length, which is not trusted for the budget.
 * @property {string} body              Decoded text, possibly partial. Empty when nothing was read.
 * @property {number} bytesRead
 * @property {boolean} truncatedAtBytes
 * @property {boolean} timedOut
 * @property {StopReason | null} stoppedBy
 * @property {{ address: string, family: 4 | 6, port: number, host: string, mode: string }} connection
 * @property {RedirectSeen | null} redirect
 * @property {number} durationMs
 */

/**
 * Picks the connection mode for a runtime. Node honours a custom `lookup` passed through
 * `http.request`; Bun publishes nothing about it (claim 196), so the plugin's own runtime takes the
 * fallback, which needs no `lookup` to be honoured by anyone.
 * @param {{ bun?: unknown, forced?: string }} [runtime]
 * @returns {string}
 */
export function selectConnectMode({ bun = process.versions.bun, forced } = {}) {
  if (forced === CONNECT_MODES.pinnedLookup || forced === CONNECT_MODES.literalAddress) return forced;
  return bun === undefined ? CONNECT_MODES.pinnedLookup : CONNECT_MODES.literalAddress;
}

/**
 * A `lookup` that answers with the pinned address and refuses every other name. It supports both
 * shapes a runtime may call it with - `(hostname, callback)` and `(hostname, options, callback)` -
 * and both answer shapes, because `autoSelectFamily` makes Node ask with `all: true`.
 * @param {{ host: string, pinned: PinnedAddress }} options
 * @returns {(hostname: string, options: any, callback?: any) => void}
 */
export function createPinnedLookup({ host, pinned }) {
  const expected = normalizeHostName(host);
  return function pinnedLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'function' ? {} : (options ?? {});
    if (typeof done !== 'function') return;
    if (normalizeHostName(hostname) !== expected) {
      done(hostLookupError(hostname));
      return;
    }
    if (settings.family === 4 || settings.family === 6) {
      if (settings.family !== pinned.family) {
        done(hostLookupError(hostname));
        return;
      }
    }
    if (settings.all === true) {
      done(null, [{ address: pinned.text, family: pinned.family }]);
      return;
    }
    done(null, pinned.text, pinned.family);
  };
}

/**
 * Whether the socket really reached the pinned address. A runtime that ignored the custom `lookup`
 * lands somewhere else and is caught here; a runtime that reports no peer address at all is only
 * trusted in `literal-address` mode, where the connect target was the literal pin and there is nothing
 * left to verify.
 * @param {{ mode: string, remoteAddress?: string | null, pinned: PinnedAddress }} input
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function verifyPinnedAddress({ mode, remoteAddress, pinned }) {
  if (typeof remoteAddress === 'string' && remoteAddress.length > 0) {
    return sameAddress(remoteAddress, pinned.text) ? { ok: true, reason: null } : { ok: false, reason: 'pin-mismatch' };
  }
  if (mode === CONNECT_MODES.literalAddress) return { ok: true, reason: null };
  return { ok: false, reason: 'address-unknown' };
}

/**
 * Are two spellings the same address? The comparison goes through the policy's own parser, so a zone
 * index, a bracketed form, a short IPv6 and an IPv4-mapped IPv6 all land on the spelling the IP rules
 * judged. Anything that does not parse is not equal to anything, including itself.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameAddress(left, right) {
  const first = parseIpAddress(left);
  const second = parseIpAddress(right);
  if (first === null || second === null) return false;
  return first.family === second.family && first.text === second.text;
}

/**
 * Builds everything the request needs, without performing it, so the shape is assertable on its own.
 * Nothing from the caller is spread into the options: `rejectUnauthorized` and friends have no way in.
 * @param {TransportRequest & { connectMode: string }} request
 * @returns {{ module: 'http' | 'https', options: Record<string, any>, agentOptions: Record<string, any>, authority: string, host: string, port: number, path: string }}
 */
export function buildConnection(request) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  const host = normalizeHostName(request.host ?? url.hostname);
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  const literal = request.connectMode === CONNECT_MODES.literalAddress;
  const body = normalizeBody(request.body);

  const headers = buildHeaders({
    entryHeaders: request.headers,
    authority: url.host,
    userAgent: request.userAgent ?? k_defaultUserAgent,
    body,
  });

  /** @type {Record<string, any>} */
  const options = {
    method: request.method,
    host: literal ? request.pinned.text : host,
    port,
    path: `${url.pathname}${url.search}`,
    headers,
    family: request.pinned.family,
    autoSelectFamily: false,
    setHost: false,
  };
  if (!literal) options.lookup = createPinnedLookup({ host, pinned: request.pinned });
  if (secure) {
    options.servername = host;
    options.rejectUnauthorized = true;
    options.checkServerIdentity = createIdentityCheck(host);
    if (typeof request.ca === 'string' && request.ca.length > 0) options.ca = request.ca;
  }

  return {
    module: secure ? 'https' : 'http',
    options,
    agentOptions: { keepAlive: false, maxSockets: 1 },
    authority: url.host,
    host,
    port,
    path: options.path,
  };
}

/**
 * The certificate is validated against the host name the policy authorised, never against the address
 * the socket is pinned to (`S-NET-17`, `DN24`). When the runtime does not publish
 * `tls.checkServerIdentity`, the check falls back to the runtime's own, which `servername` drives.
 * @param {string} host
 * @returns {((hostname: string, cert: any) => Error | undefined) | undefined}
 */
export function createIdentityCheck(host) {
  if (typeof tls.checkServerIdentity !== 'function') return undefined;
  return (_hostname, cert) => tls.checkServerIdentity(host, cert);
}

/**
 * Whether a response may be shown to the model as text.
 * @param {string | null | undefined} value  The raw `Content-Type` header.
 * @returns {boolean}
 */
export function isAllowedContentType(value) {
  const { type } = parseContentType(value);
  if (type === null) return false;
  return k_allowedContentTypes.some((pattern) => pattern.test(type));
}

/**
 * The type comes from the sanitiser's `mediaTypeEssence`, so the gate that admits a body and the
 * sanitiser that decides how to strip it can never read two different types out of one header.
 * @param {string | null | undefined} value
 * @returns {{ type: string | null, charset: string | null }}
 */
export function parseContentType(value) {
  if (typeof value !== 'string' || value.trim() === '') return { type: null, charset: null };
  const [, ...rest] = value.split(';');
  const type = mediaTypeEssence(value);
  /** @type {string | null} */
  let charset = null;
  for (const part of rest) {
    const match = /^\s*charset\s*=\s*"?([\w.:+-]+)"?\s*$/i.exec(part);
    if (match !== null) charset = match[1].toLowerCase();
  }
  return { type: type === '' ? null : type, charset };
}

/**
 * What a 3xx tells the caller. The header is reported exactly as it arrived and the body is not read:
 * whether the target is allowed, and what its absolute form is, is decided by the policy, not here.
 * @param {number} status
 * @param {string | string[] | undefined} location
 * @returns {RedirectSeen}
 */
export function readRedirect(status, location) {
  const raw = Array.isArray(location) ? location[0] : location;
  const header = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  return { status, location: header };
}

/**
 * Maps a socket or request failure onto a stable code.
 * @param {any} error
 * @returns {string}
 */
export function classifyRequestError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return TRANSPORT_CODES.tlsHostnameMismatch;
  if (k_untrustedCertCodes.includes(code)) return TRANSPORT_CODES.tlsUntrusted;
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) return TRANSPORT_CODES.tlsUntrusted;
  return TRANSPORT_CODES.connectFailed;
}

/**
 * Performs one request. It never throws: every failure comes back as a result with a code, because the
 * tool above it turns a result into a message and a thrown error into a broken session (`DN18`).
 * @param {TransportRequest} request
 * @param {{ httpRequest?: typeof http.request, httpsRequest?: typeof https.request, now?: () => number }} [deps]
 * @returns {Promise<TransportResult>}
 */
export function sendRequest(request, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const mode = selectConnectMode({ forced: request.connectMode });
  /** @type {ReturnType<typeof buildConnection>} */
  let plan;
  try {
    plan = buildConnection({ ...request, connectMode: mode });
  } catch (error) {
    // The policy validated this URL long before step 14, so reaching here is a programming error - but
    // the tool above still has to be handed a result rather than an exception (`DN18`).
    return Promise.resolve(failedToStart(request, mode, classifyRequestError(error)));
  }
  const limits = request.limits;
  const body = normalizeBody(request.body);
  const connection = { address: request.pinned.text, family: request.pinned.family, port: plan.port, host: plan.host, mode };

  return new Promise((resolve) => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let bytesRead = 0;
    let truncatedAtBytes = false;
    let settled = false;
    /** @type {import('node:http').IncomingMessage | null} */
    let response = null;
    /** @type {any} */
    let agent = null;
    /** @type {any} */
    let clientRequest = null;

    /** @type {{ connect: any, firstByte: any, total: any }} */
    const timers = { connect: null, firstByte: null, total: null };

    /** @param {'connect' | 'firstByte' | 'total'} name */
    const clearTimer = (name) => {
      if (timers[name] !== null) clearTimeout(timers[name]);
      timers[name] = null;
    };

    /** @param {Partial<TransportResult>} outcome */
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimer('connect');
      clearTimer('firstByte');
      clearTimer('total');
      try {
        clientRequest?.destroy();
      } catch {
        // A request that already ended has nothing to destroy.
      }
      try {
        agent?.destroy?.();
      } catch {
        // Same: the agent may have released its sockets already.
      }
      const contentType = header(response, 'content-type');
      resolve({
        ok: false,
        code: null,
        detail: null,
        status: response?.statusCode ?? null,
        contentType,
        contentLength: readContentLength(response),
        body: '',
        bytesRead,
        truncatedAtBytes,
        timedOut: false,
        stoppedBy: null,
        connection,
        redirect: null,
        durationMs: now() - started,
        ...outcome,
      });
    };

    /**
     * @param {string} code
     * @param {string} detail
     */
    const stop = (code, detail) => finish({ ok: false, code, detail, timedOut: k_timeoutCodes.includes(code) });

    function onTotalTimeout() {
      // Before the headers this is a refusal; after them the caller still gets what arrived, because a
      // slow body is the shape `webfetch`'s single timeout does not cover (claim 125).
      if (response === null) {
        stop(TRANSPORT_CODES.totalTimeout, 'the request did not finish within the total time limit');
        return;
      }
      finish({
        ok: true,
        code: TRANSPORT_CODES.totalTimeout,
        detail: 'the body was still arriving when the total time limit was reached',
        body: decodeBody(chunks, header(response, 'content-type')),
        timedOut: true,
        stoppedBy: 'total-timeout',
      });
    }

    timers.connect = setTimeout(() => stop(TRANSPORT_CODES.connectTimeout, 'the connection was not established in time'), limits.connectTimeoutMs);
    timers.total = setTimeout(onTotalTimeout, limits.totalTimeoutMs);

    try {
      const send = plan.module === 'https' ? (deps.httpsRequest ?? https.request) : (deps.httpRequest ?? http.request);
      agent = plan.module === 'https' ? new https.Agent(plan.agentOptions) : new http.Agent(plan.agentOptions);
      clientRequest = send(/** @type {any} */ ({ ...plan.options, agent }));
    } catch (error) {
      stop(classifyRequestError(error), 'the request could not be started');
      return;
    }

    clientRequest.on('socket', (/** @type {any} */ socket) => {
      const checkPin = () => {
        if (settled) return;
        const verdict = verifyPinnedAddress({ mode, remoteAddress: socket.remoteAddress, pinned: request.pinned });
        if (verdict.ok) return;
        try {
          socket.destroy();
        } catch {
          // Destroying twice is not an error worth reporting.
        }
        stop(TRANSPORT_CODES.addressBlocked, verdict.reason === 'pin-mismatch' ? 'the connection reached an address the policy did not approve' : 'the connection reached an address that could not be confirmed');
      };
      if (socket.connecting === false) checkPin();
      else socket.once('connect', checkPin);
      // The pin is checked first, so a refused connection never starts the next timer.
      const connected = () => {
        clearTimer('connect');
        if (settled) return;
        timers.firstByte = setTimeout(() => stop(TRANSPORT_CODES.firstByteTimeout, 'the server sent no response header in time'), limits.firstByteTimeoutMs);
      };
      if (plan.module === 'https') socket.once('secureConnect', connected);
      else if (socket.connecting === false) connected();
      else socket.once('connect', connected);
    });

    clientRequest.on('error', (/** @type {any} */ error) => {
      if (response !== null) {
        finish({
          ok: true,
          code: classifyRequestError(error),
          detail: 'the connection ended before the body was complete',
          body: decodeBody(chunks, header(response, 'content-type')),
          stoppedBy: 'connection-lost',
        });
        return;
      }
      stop(classifyRequestError(error), 'the request could not be completed');
    });

    clientRequest.on('response', (/** @type {import('node:http').IncomingMessage} */ incoming) => {
      response = incoming;
      clearTimer('firstByte');
      const status = incoming.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        finish({ ok: true, code: null, detail: 'the server answered with a redirect, which is never followed', stoppedBy: 'redirect', redirect: readRedirect(status, incoming.headers.location) });
        return;
      }
      if (status === 401 || status === 407) {
        finish({ ok: true, code: null, detail: 'the server asked for credentials; the request was not retried', stoppedBy: 'auth-required' });
        return;
      }
      const encoding = header(incoming, 'content-encoding');
      if (encoding !== null && encoding.toLowerCase() !== 'identity') {
        stop(TRANSPORT_CODES.contentEncodingNotIdentity, 'the server compressed the response although identity encoding was requested');
        return;
      }
      const contentType = header(incoming, 'content-type');
      if (!isAllowedContentType(contentType)) {
        stop(TRANSPORT_CODES.contentTypeNotText, 'the response is not a text type this tool can show');
        return;
      }

      incoming.on('data', (/** @type {Uint8Array} */ chunk) => {
        if (settled) return;
        const room = limits.maxResponseBytes - bytesRead;
        if (chunk.length <= room) {
          chunks.push(chunk);
          bytesRead += chunk.length;
          return;
        }
        // The declared length is never what stops the read; the counted bytes are.
        chunks.push(chunk.subarray(0, room));
        bytesRead += room;
        truncatedAtBytes = true;
        incoming.destroy();
        finish({ ok: true, code: null, detail: 'the response was longer than the byte budget and was cut', body: decodeBody(chunks, contentType), truncatedAtBytes: true, stoppedBy: 'byte-budget' });
      });
      incoming.on('end', () => finish({ ok: true, code: null, detail: null, body: decodeBody(chunks, contentType), stoppedBy: 'complete' }));
      incoming.on('error', (/** @type {any} */ error) => finish({ ok: true, code: classifyRequestError(error), detail: 'the connection ended before the body was complete', body: decodeBody(chunks, contentType), stoppedBy: 'connection-lost' }));
    });

    if (body === null) clientRequest.end();
    else clientRequest.end(body);
  });
}

/**
 * The result for a request that could not even be built.
 * @param {TransportRequest} request
 * @param {string} mode
 * @param {string} code
 * @returns {TransportResult}
 */
function failedToStart(request, mode, code) {
  return {
    ok: false,
    code,
    detail: 'the request could not be built',
    status: null,
    contentType: null,
    contentLength: null,
    body: '',
    bytesRead: 0,
    truncatedAtBytes: false,
    timedOut: false,
    stoppedBy: null,
    connection: { address: request.pinned?.text ?? '', family: request.pinned?.family ?? 4, port: 0, host: '', mode },
    redirect: null,
    durationMs: 0,
  };
}

/**
 * @param {{ entryHeaders?: Record<string, string>, authority: string, userAgent: string, body: Uint8Array | null }} input
 * @returns {Record<string, string>}
 */
function buildHeaders({ entryHeaders, authority, userAgent, body }) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of Object.entries(entryHeaders ?? {})) {
    const key = String(name).toLowerCase();
    if (k_reservedHeaders.includes(key)) continue;
    if (typeof value === 'string') headers[key] = value;
  }
  if (body !== null && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  headers['user-agent'] = headers['user-agent'] ?? userAgent;
  headers.host = authority;
  headers['accept-encoding'] = 'identity';
  headers.connection = 'close';
  if (body !== null) headers['content-length'] = String(body.length);
  return headers;
}

/**
 * @param {string | Uint8Array | null | undefined} body
 * @returns {Uint8Array | null}
 */
function normalizeBody(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}

/**
 * @param {Uint8Array[]} chunks
 * @param {string | null} contentType
 * @returns {string}
 */
function decodeBody(chunks, contentType) {
  if (chunks.length === 0) return '';
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const { charset } = parseContentType(contentType);
  // A byte budget cuts mid-character, so the decoder must replace rather than refuse.
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * @param {import('node:http').IncomingMessage | null} response
 * @param {string} name
 * @returns {string | null}
 */
function header(response, name) {
  const value = response?.headers?.[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/**
 * @param {import('node:http').IncomingMessage | null} response
 * @returns {number | null}
 */
function readContentLength(response) {
  const value = header(response, 'content-length');
  if (value === null) return null;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

/**
 * @param {string} host
 * @returns {string}
 */
function normalizeHostName(host) {
  const text = String(host ?? '').trim().toLowerCase();
  const unbracketed = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

/**
 * @param {string} hostname
 * @returns {Error & { code: string }}
 */
function hostLookupError(hostname) {
  const error = /** @type {Error & { code: string }} */ (new Error(`opencode-unity: ${hostname} is not the host this request was pinned to`));
  error.code = 'ENOTFOUND';
  return error;
}
