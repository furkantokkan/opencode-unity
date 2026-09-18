// The IP policy of amendment 35.5 (`DN9`). It runs on the *resolved* address, never on the host name,
// because an allowed name that resolves to `169.254.169.254` or to `127.0.0.1:11434` is the whole
// attack: the name passes the allow-list and the address is the target. The transport pins one
// surviving address and connects only to that, so this module decides which addresses survive.
//
// Every address is reduced to bytes first, and an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is
// reduced to its IPv4 form, so a denied range cannot be re-entered through the other family's
// spelling. The rule inverts for a loopback entry: there, only `127.0.0.0/8` and `::1` are acceptable.

/** The deny code every rejection here carries into the tool result. */
export const ADDRESS_BLOCKED_CODE = 'net_address_blocked';

/**
 * @typedef {object} IpAddress
 * @property {4 | 6} family
 * @property {Uint8Array} bytes      4 bytes for v4, 16 for v6.
 * @property {string} text           The normalised spelling used in messages and logs.
 * @property {boolean} mapped        True when a v6 literal carried an embedded v4 address.
 */

/**
 * @typedef {object} CidrRange
 * @property {string} id             Stable name printed by `net why`.
 * @property {4 | 6} family
 * @property {Uint8Array} bytes
 * @property {number} prefix
 */

/**
 * The rows of amendment 35.5, in the order the spec lists them. `::` and `::1` are single addresses
 * written as /128 so one matcher covers every row.
 * @type {readonly CidrRange[]}
 */
export const DENIED_RANGES = Object.freeze([
  range('this-network', '0.0.0.0/8'),
  range('private-10', '10.0.0.0/8'),
  range('cgnat', '100.64.0.0/10'),
  range('loopback-v4', '127.0.0.0/8'),
  range('link-local-v4', '169.254.0.0/16'),
  range('private-172', '172.16.0.0/12'),
  range('ietf-protocol', '192.0.0.0/24'),
  range('private-192', '192.168.0.0/16'),
  range('benchmark', '198.18.0.0/15'),
  range('multicast-v4', '224.0.0.0/4'),
  range('reserved-v4', '240.0.0.0/4'),
  range('unspecified-v6', '::/128'),
  range('loopback-v6', '::1/128'),
  range('unique-local-v6', 'fc00::/7'),
  range('link-local-v6', 'fe80::/10'),
  range('multicast-v6', 'ff00::/8'),
]);

/** The two ranges a loopback entry may reach, and nothing else. */
const LOOPBACK_RANGES = Object.freeze([range('loopback-v4', '127.0.0.0/8'), range('loopback-v6', '::1/128')]);

/**
 * Parses a literal address. Names are not accepted: this is what DNS handed back, not what the model
 * typed. A zone id is removed before parsing, because it selects an interface and never changes which
 * range the address is in.
 * @param {unknown} text
 * @returns {IpAddress | null}
 */
export function parseIpAddress(text) {
  if (typeof text !== 'string') return null;
  const value = stripBrackets(text.trim());
  if (value === '') return null;
  const withoutZone = value.includes('%') ? value.slice(0, value.indexOf('%')) : value;
  if (withoutZone.includes(':')) return parseIpv6(withoutZone.toLowerCase());
  const bytes = parseIpv4(withoutZone);
  return bytes ? { family: 4, bytes, text: formatIpv4(bytes), mapped: false } : null;
}

/**
 * Is the resolved address inside one of the denied ranges? An address that does not parse is denied
 * too: an unparseable address is one we cannot reason about, and failing closed is the only safe read.
 * @param {unknown} address  A literal address, or an already parsed one.
 * @returns {{ denied: boolean, rule: string | null }}
 */
export function isDeniedAddress(address) {
  const parsed = toAddress(address);
  if (!parsed) return { denied: true, rule: 'unparseable' };
  for (const row of DENIED_RANGES) {
    if (inRange(parsed, row)) return { denied: true, rule: row.id };
  }
  return { denied: false, rule: null };
}

/**
 * The two ranges a loopback entry accepts. An IPv4-mapped `::ffff:127.0.0.1` counts, because it is the
 * same host reached through the other family.
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const parsed = toAddress(address);
  if (!parsed) return false;
  return LOOPBACK_RANGES.some((row) => inRange(parsed, row));
}

/**
 * The decision for one resolved address under one entry class. For a loopback entry the rule inverts:
 * loopback is the only thing allowed rather than the first thing denied.
 * @param {unknown} address
 * @param {{ loopback?: boolean }} [options]
 * @returns {{ ok: true, address: IpAddress } | { ok: false, code: string, rule: string, address: string }}
 */
export function checkResolvedAddress(address, { loopback = false } = {}) {
  const parsed = toAddress(address);
  if (!parsed) return { ok: false, code: ADDRESS_BLOCKED_CODE, rule: 'unparseable', address: String(address ?? '') };
  if (loopback) {
    if (isLoopbackAddress(parsed)) return { ok: true, address: parsed };
    return { ok: false, code: ADDRESS_BLOCKED_CODE, rule: 'not-loopback', address: parsed.text };
  }
  const denied = isDeniedAddress(parsed);
  if (denied.denied) return { ok: false, code: ADDRESS_BLOCKED_CODE, rule: /** @type {string} */ (denied.rule), address: parsed.text };
  return { ok: true, address: parsed };
}

/**
 * Splits a DNS answer into the addresses the transport may pin and the ones it may not, keeping the
 * rule that blocked each rejected address so the log can say why without naming the host twice.
 * @param {readonly unknown[]} addresses
 * @param {{ loopback?: boolean }} [options]
 * @returns {{ allowed: IpAddress[], blocked: Array<{ address: string, rule: string }> }}
 */
export function filterResolvedAddresses(addresses, { loopback = false } = {}) {
  /** @type {IpAddress[]} */
  const allowed = [];
  /** @type {Array<{ address: string, rule: string }>} */
  const blocked = [];
  for (const candidate of Array.isArray(addresses) ? addresses : []) {
    const result = checkResolvedAddress(candidate, { loopback });
    if (result.ok) allowed.push(result.address);
    else blocked.push({ address: result.address, rule: result.rule });
  }
  return { allowed, blocked };
}

/**
 * @param {unknown} value
 * @returns {IpAddress | null}
 */
function toAddress(value) {
  if (value && typeof value === 'object' && 'bytes' in value && 'family' in value) return /** @type {IpAddress} */ (value);
  return parseIpAddress(value);
}

/**
 * @param {IpAddress} address
 * @param {CidrRange} row
 * @returns {boolean}
 */
function inRange(address, row) {
  if (address.family !== row.family) return false;
  let bitsLeft = row.prefix;
  for (let index = 0; index < row.bytes.length && bitsLeft > 0; index += 1) {
    const take = Math.min(8, bitsLeft);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address.bytes[index] & mask) !== (row.bytes[index] & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

/**
 * @param {string} id
 * @param {string} cidr
 * @returns {CidrRange}
 */
function range(id, cidr) {
  const [text, prefixText] = cidr.split('/');
  const address = /** @type {IpAddress} */ (parseIpAddress(text));
  return Object.freeze({ id, family: address.family, bytes: address.bytes, prefix: Number(prefixText) });
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripBrackets(value) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * Strict dotted quad: four decimal octets, no leading zeros, nothing else. Leading zeros are refused
 * because `010` is octal to some resolvers and decimal to others, and two readings of one address is
 * exactly the ambiguity this policy cannot afford.
 * @param {string} value
 * @returns {Uint8Array | null}
 */
function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index];
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

/**
 * @param {string} value
 * @returns {IpAddress | null}
 */
function parseIpv6(value) {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  let embedded = false;
  /** @type {number[]} */
  const head = [];
  /** @type {number[]} */
  const tail = [];
  for (const [position, half] of halves.entries()) {
    const target = position === 0 ? head : tail;
    if (half === '') continue;
    const groups = half.split(':');
    for (const [index, group] of groups.entries()) {
      if (group.includes('.')) {
        // A trailing dotted quad is only legal as the last two groups: `::ffff:127.0.0.1`.
        if (index !== groups.length - 1) return null;
        const quad = parseIpv4(group);
        if (!quad) return null;
        target.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
        embedded = true;
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      target.push(Number.parseInt(group, 16));
    }
  }
  const total = head.length + tail.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const groups = halves.length === 1 ? head : [...head, ...new Array(8 - total).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = (groups[index] >> 8) & 0xff;
    bytes[index * 2 + 1] = groups[index] & 0xff;
  }
  // `::ffff:a.b.c.d` is the same host as `a.b.c.d`, so it is reduced rather than judged separately.
  if (isMappedV4(bytes)) {
    const quad = bytes.slice(12);
    return { family: 4, bytes: quad, text: formatIpv4(quad), mapped: true };
  }
  return { family: 6, bytes, text: formatIpv6(bytes), mapped: embedded };
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isMappedV4(bytes) {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function formatIpv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/**
 * Full eight-group form. Messages and logs stay unambiguous rather than short.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function formatIpv6(bytes) {
  /** @type {string[]} */
  const groups = [];
  for (let index = 0; index < 8; index += 1) groups.push(((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16));
  return groups.join(':');
}
