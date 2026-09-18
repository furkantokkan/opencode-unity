// URL parsing, normalisation and the matcher primitives of the network policy (amendment 35.5 step 4
// and step 6). This is the parsed-URL layer `DN3` puts ahead of OpenCode's glob permission rules,
// because `Wildcard.match` compiles `*` to `.*`, which crosses `/`, `:`, `@` and `?` — so the rendered
// rule `GET https://docs.unity3d.com/*` also matches `https://docs.unity3d.com.evil.test/x`. Nothing
// here opens a socket or reads a file; it turns one string into decided facts.
//
// Two shapes of hostile input drive the parsing rules. A raw control character survives in some
// parsers and is silently removed by the WHATWG one, so the two disagree about what the request is:
// every C0/C1 character and the backslash are refused before `new URL()` ever sees the string. And an
// internationalised host is punycoded by `new URL()`, which turns a host the user never wrote into
// the host we would connect to: the authority must already be the ASCII form.

/** The only schemes the tool speaks. */
export const HTTP_SCHEMES = Object.freeze(['http', 'https']);

/** Default ports, so an origin can say whether a port was the scheme's own. */
export const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 });

/**
 * A leading `/en-us` or `/tr` on a documentation host. `learn.microsoft.com` redirects locale-less
 * paths, so an entry may ask for the segment to be ignored while matching (`DN7`, amendment 35.6.1).
 * Two letters, optionally a subtag of two to eight alphanumerics — long enough for `zh-hant`, short
 * enough that `azure` and `dotnet` are not locales.
 */
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z0-9]{2,8})?$/;

/**
 * @typedef {object} ParsedRequestUrl
 * @property {true} ok
 * @property {URL} url
 * @property {'http' | 'https'} scheme
 * @property {string} host            Lowercased, no brackets around an IPv6 literal.
 * @property {number} port            The effective port: the explicit one, or the scheme's default.
 * @property {boolean} explicitPort
 * @property {string} path            The wire form (percent-encoded), which is what the budget counts.
 * @property {string} decodedPath     Percent-decoded once, which is what a path prefix is compared to.
 * @property {string} query           The wire form without the leading `?`.
 * @property {string} origin          Scheme, host and the port only when it is not the scheme default.
 */

/**
 * @typedef {object} UrlRejection
 * @property {false} ok
 * @property {'net_url_invalid' | 'net_url_userinfo' | 'net_url_idn'} code
 * @property {string} reason  Which property failed, for the message and `net why`.
 */

/**
 * Step 4 of the execution order. Returns facts or a stable deny code; it never throws.
 * @param {unknown} raw
 * @returns {ParsedRequestUrl | UrlRejection}
 */
export function parseRequestUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return reject('net_url_invalid', 'not-a-string');
  if (hasControlOrSpace(raw)) return reject('net_url_invalid', 'control-character');
  // WHATWG treats `\` as `/` in a special scheme, so `http://evil.test\@allowed.test/` is one host to
  // a reader and another to the parser. Nothing legitimate needs a literal backslash in a URL.
  if (raw.includes('\\')) return reject('net_url_invalid', 'backslash');
  if (raw.includes('#')) return reject('net_url_invalid', 'fragment');

  let url;
  try {
    url = new URL(raw);
  } catch {
    return reject('net_url_invalid', 'parse');
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!HTTP_SCHEMES.includes(scheme)) return reject('net_url_invalid', 'scheme');
  if (url.username !== '' || url.password !== '') return reject('net_url_userinfo', 'userinfo');

  // `URL.hostname` keeps the brackets around an IPv6 literal, and an entry's `host` never carries
  // them, so the two spellings would never match until the brackets come off here.
  const host = stripBrackets(url.hostname.toLowerCase());
  if (host === '') return reject('net_url_invalid', 'empty-host');

  const authority = readAuthority(raw);
  if (authority === null) return reject('net_url_invalid', 'authority');
  // `new URL()` punycodes a unicode host, which would let a request name one host and reach another.
  // An authority that is already ASCII cannot be transformed that way, so the check is the character
  // range rather than a round trip through an encoder we would then have to trust.
  if (!isAsciiPrintable(authority)) return reject('net_url_idn', 'non-ascii-authority');
  if (hasPunycodeLabel(host) && !authority.toLowerCase().includes('xn--')) return reject('net_url_idn', 'punycode-introduced');

  const explicitPort = url.port !== '';
  const port = explicitPort ? Number(url.port) : DEFAULT_PORTS[/** @type {'http' | 'https'} */ (scheme)];
  if (!Number.isInteger(port) || port < 1 || port > 65535) return reject('net_url_invalid', 'port');

  const decodedPath = decodePath(url.pathname);
  if (decodedPath === null) return reject('net_url_invalid', 'percent-encoding');

  return {
    ok: true,
    url,
    scheme: /** @type {'http' | 'https'} */ (scheme),
    host,
    port,
    explicitPort,
    path: url.pathname,
    decodedPath,
    query: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    origin: formatOrigin(scheme, host, port),
  };
}

/**
 * The origin half of the ask pattern (amendment 35.7): scheme, host, and the port only when it is not
 * the scheme's default. An IPv6 host keeps its brackets, as `URL.origin` writes it.
 * @param {string} scheme
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
export function formatOrigin(scheme, host, port) {
  const literal = host.includes(':') ? `[${host}]` : host;
  const isDefault = DEFAULT_PORTS[/** @type {'http' | 'https'} */ (scheme)] === port;
  return isDefault ? `${scheme}://${literal}` : `${scheme}://${literal}:${port}`;
}

/**
 * The host matcher of step 6. `exact` is equality on the lowercased host. `suffix` accepts a host that
 * ends with `.` plus the suffix, which is the label boundary — `a.example.com` matches `*.example.com`
 * and `notexample.com` and `evil.test/a.example.com` do not. `loopback` accepts the two address forms
 * and the literal name.
 * @param {string} host  Already lowercased by `parseRequestUrl`.
 * @param {{ host: string, hostKind?: string }} entry
 * @returns {boolean}
 */
export function hostMatchesEntry(host, entry) {
  if (typeof host !== 'string' || host === '') return false;
  const kind = entry.hostKind ?? 'exact';
  const target = String(entry.host ?? '').toLowerCase();
  if (kind === 'loopback') return isLoopbackHostname(host);
  if (kind === 'suffix') {
    const suffix = target.startsWith('*.') ? target.slice(2) : target;
    if (suffix === '') return false;
    return host.length > suffix.length + 1 && host.endsWith(`.${suffix}`);
  }
  return host === target;
}

/**
 * The hosts a loopback entry accepts before DNS runs. The resolved address is checked again by
 * `ip-rules.js`, because `localhost` is a name and a name can be pointed anywhere.
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHostname(host) {
  const value = String(host ?? '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * The path forms an entry may match: the decoded path, and — when the entry asks for it — the same
 * path with a leading locale segment removed. Both are offered because the locale segment is optional
 * in the URL, so `/dotnet/x` and `/tr-tr/dotnet/x` must both reach the `/dotnet/` prefix.
 * @param {string} decodedPath
 * @param {boolean} [stripLocale]
 * @returns {string[]}
 */
export function pathCandidates(decodedPath, stripLocale = false) {
  const path = typeof decodedPath === 'string' && decodedPath !== '' ? decodedPath : '/';
  if (!stripLocale) return [path];
  const stripped = stripLocaleSegment(path);
  return stripped === path ? [path] : [path, stripped];
}

/**
 * Drops one leading locale segment. `/tr-tr/dotnet/x` becomes `/dotnet/x`; `/azure/x` is not a locale
 * and is returned unchanged.
 * @param {string} path
 * @returns {string}
 */
export function stripLocaleSegment(path) {
  const value = typeof path === 'string' ? path : '';
  if (!value.startsWith('/')) return value;
  const end = value.indexOf('/', 1);
  const first = end === -1 ? value.slice(1) : value.slice(1, end);
  if (!LOCALE_SEGMENT.test(first.toLowerCase())) return value;
  const rest = end === -1 ? '/' : value.slice(end);
  return rest === '' ? '/' : rest;
}

/**
 * True when any candidate form of the path starts with one of the entry's prefixes. A prefix that does
 * not end in `/` must still match on a segment boundary, so `/dotnet` does not grant `/dotnetfoo/x`.
 * @param {string[]} candidates
 * @param {readonly string[]} prefixes
 * @returns {boolean}
 */
export function matchesPathPrefix(candidates, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false;
  return candidates.some((path) => prefixes.some((prefix) => startsWithSegment(path, prefix)));
}

/**
 * A `..` or `.` segment that survived percent-decoding. `new URL()` resolves both the literal form and
 * the `%2e` spelling, so what reaches here is a traversal hidden behind an encoded separator —
 * `/Manual/x%2F..%2Fsecret`, whose only purpose is to leave the prefix the entry granted.
 * @param {string} decodedPath
 * @returns {boolean}
 */
export function hasTraversalSegment(decodedPath) {
  return String(decodedPath ?? '').split('/').some((segment) => segment === '..' || segment === '.');
}

/**
 * The first path segment, which is where a Firebase emulator puts the project id (amendment 35.5
 * step 11). Empty when the path has none.
 * @param {string} decodedPath
 * @returns {string}
 */
export function firstPathSegment(decodedPath) {
  const parts = String(decodedPath ?? '').split('/').filter((segment) => segment !== '');
  return parts.length > 0 ? parts[0] : '';
}

/**
 * The query as lowercased keys and their raw values, for the denied-key and credential-shape checks of
 * step 9. Built from `URLSearchParams` so that repeated keys are all seen.
 * @param {string} query
 * @returns {Array<{ key: string, value: string }>}
 */
export function readQueryPairs(query) {
  const text = typeof query === 'string' ? query : '';
  if (text === '') return [];
  /** @type {Array<{ key: string, value: string }>} */
  const pairs = [];
  for (const [key, value] of new URLSearchParams(text)) pairs.push({ key: key.toLowerCase(), value });
  return pairs;
}

/**
 * Resolves a `Location` header against the request URL without following it (`DN7`). A relative target
 * is resolved, an absolute one is taken as it stands, and either way the result goes back through the
 * whole policy before the model is told the target exists.
 * @param {string} location
 * @param {string | URL} base
 * @returns {string | null}
 */
export function resolveLocation(location, base) {
  if (typeof location !== 'string' || location === '') return null;
  if (hasControlOrSpace(location) || location.includes('\\')) return null;
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

/**
 * Anything at or below the space, plus DEL and the C1 block. Written as code point comparisons rather
 * than as a character class, so that no control character is ever a literal byte in this file: a raw
 * one takes a source file out of the repository's personal-data scan without saying so.
 * @param {string} value
 * @returns {boolean}
 */
function hasControlOrSpace(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * @param {'net_url_invalid' | 'net_url_userinfo' | 'net_url_idn'} code
 * @param {string} reason
 * @returns {UrlRejection}
 */
function reject(code, reason) {
  return { ok: false, code, reason };
}

/**
 * The authority as the caller wrote it, between `://` and the first `/` or `?`. Used only to ask
 * whether the parser changed the host.
 * @param {string} raw
 * @returns {string | null}
 */
function readAuthority(raw) {
  const start = raw.indexOf('://');
  if (start === -1) return null;
  const rest = raw.slice(start + 3);
  let end = rest.length;
  for (const mark of ['/', '?']) {
    const index = rest.indexOf(mark);
    if (index !== -1 && index < end) end = index;
  }
  return rest.slice(0, end);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isAsciiPrintable(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripBrackets(value) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function hasPunycodeLabel(host) {
  return host.split('.').some((label) => label.startsWith('xn--'));
}

/**
 * One round of percent-decoding, segment by segment. Re-joining turns an encoded `/` into a real
 * separator, which is the conservative reading: a prefix is compared against the path a server that
 * decodes will see, and a traversal hidden behind `%2F` becomes a `..` segment the check can find.
 * `null` when the encoding is malformed.
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePath(pathname) {
  try {
    return pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {unknown} prefix
 * @returns {boolean}
 */
function startsWithSegment(path, prefix) {
  if (typeof prefix !== 'string' || prefix === '') return false;
  if (prefix === '/') return path.startsWith('/');
  if (!path.startsWith(prefix)) return false;
  if (prefix.endsWith('/') || path.length === prefix.length) return true;
  return path[prefix.length] === '/';
}
