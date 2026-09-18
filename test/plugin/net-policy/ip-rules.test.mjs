// The IP policy of amendment 35.5 (`DN9`), every row in IPv4, IPv6 and IPv4-mapped-IPv6 form. The two
// addresses the table exists for are `169.254.169.254` — the cloud metadata service — and
// `127.0.0.1`, because a name on the allow-list that resolves to either one is the whole attack.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DENIED_RANGES,
  checkResolvedAddress,
  filterResolvedAddresses,
  isDeniedAddress,
  isLoopbackAddress,
  parseIpAddress,
} from '../../../plugin/opencode-unity-lib/net/ip-rules.js';

/** One address inside each denied range, in the order 35.5 lists them. */
const INSIDE = [
  ['0.1.2.3', 'this-network'],
  ['10.1.2.3', 'private-10'],
  ['100.64.1.2', 'cgnat'],
  ['127.0.0.1', 'loopback-v4'],
  ['169.254.169.254', 'link-local-v4'],
  ['172.16.5.6', 'private-172'],
  ['192.0.0.7', 'ietf-protocol'],
  ['192.168.1.1', 'private-192'],
  ['198.18.0.9', 'benchmark'],
  ['224.0.0.251', 'multicast-v4'],
  ['240.0.0.1', 'reserved-v4'],
  ['::', 'unspecified-v6'],
  ['::1', 'loopback-v6'],
  ['fd00::1', 'unique-local-v6'],
  ['fe80::1', 'link-local-v6'],
  ['ff02::1', 'multicast-v6'],
];

/** Addresses just outside a range, which must stay reachable for an ordinary allowed host. */
const OUTSIDE = ['1.2.3.4', '9.255.255.255', '11.0.0.1', '100.128.0.1', '128.0.0.1', '169.253.0.1',
  '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.167.255.255', '198.20.0.1', '223.255.255.255',
  '2001:4860:4860::8888', 'fbff::1', 'fec0::1'];

describe('net/ip-rules: parsing', () => {
  it('reads a dotted quad and rejects anything that is not one', () => {
    assert.equal(parseIpAddress('192.0.2.10')?.family, 4);
    for (const text of ['192.0.2', '192.0.2.10.1', '192.0.2.256', 'example.test', '', null, 42]) {
      assert.equal(parseIpAddress(text), null, String(text));
    }
  });

  it('refuses a leading zero, which two resolvers read two ways', () => {
    assert.equal(parseIpAddress('010.0.0.1'), null);
    assert.equal(parseIpAddress('127.0.0.01'), null);
    assert.equal(parseIpAddress('0.0.0.0')?.text, '0.0.0.0', 'a single zero octet is still a zero');
  });

  it('reads IPv6 in compressed, full and bracketed form', () => {
    assert.equal(parseIpAddress('::1')?.family, 6);
    assert.equal(parseIpAddress('[::1]')?.text, '0:0:0:0:0:0:0:1');
    assert.equal(parseIpAddress('0:0:0:0:0:0:0:1')?.text, '0:0:0:0:0:0:0:1');
    assert.equal(parseIpAddress('2001:db8::1')?.family, 6);
    for (const text of ['::1::2', '1:2:3:4:5:6:7', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
      assert.equal(parseIpAddress(text), null, text);
    }
  });

  it('reduces an IPv4-mapped address to the host it actually names', () => {
    const mapped = parseIpAddress('::ffff:127.0.0.1');
    assert.equal(mapped?.family, 4);
    assert.equal(mapped?.text, '127.0.0.1');
    assert.equal(mapped?.mapped, true);
  });

  it('ignores a zone id, which selects an interface and not a range', () => {
    assert.equal(parseIpAddress('fe80::1%eth0')?.family, 6);
    assert.equal(isDeniedAddress('fe80::1%eth0').rule, 'link-local-v6');
  });
});

describe('net/ip-rules: the denied table', () => {
  it('denies one address from every row, and names the row', () => {
    for (const [address, rule] of INSIDE) {
      const result = isDeniedAddress(address);
      assert.equal(result.denied, true, address);
      assert.equal(result.rule, rule, address);
    }
    assert.equal(DENIED_RANGES.length, INSIDE.length, 'every shipped range has a case');
  });

  it('denies the IPv4-mapped spelling of every IPv4 row', () => {
    for (const [address, rule] of INSIDE) {
      if (address.includes(':')) continue;
      const result = isDeniedAddress(`::ffff:${address}`);
      assert.equal(result.denied, true, address);
      assert.equal(result.rule, rule, `mapped ${address}`);
    }
  });

  it('leaves an ordinary public address alone', () => {
    for (const address of OUTSIDE) assert.equal(isDeniedAddress(address).denied, false, address);
  });

  it('denies an address it cannot parse rather than passing it on', () => {
    for (const text of ['not-an-address', '', null, undefined, {}]) {
      const result = isDeniedAddress(text);
      assert.equal(result.denied, true, String(text));
      assert.equal(result.rule, 'unparseable');
    }
  });
});

describe('net/ip-rules: the loopback inversion', () => {
  it('accepts only the two loopback ranges for a loopback entry', () => {
    for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackAddress(address), true, address);
      assert.equal(checkResolvedAddress(address, { loopback: true }).ok, true, address);
    }
  });

  it('refuses everything else for a loopback entry, including the metadata address', () => {
    for (const address of ['10.0.0.1', '169.254.169.254', '1.2.3.4', '::2', 'fe80::1']) {
      const result = checkResolvedAddress(address, { loopback: true });
      assert.equal(result.ok, false, address);
      assert.equal(result.code, 'net_address_blocked');
      assert.equal(result.rule, 'not-loopback');
    }
  });

  it('refuses loopback for a non-loopback entry, which is the rebinding answer', () => {
    const result = checkResolvedAddress('127.0.0.1', { loopback: false });
    assert.equal(result.ok, false);
    assert.equal(result.rule, 'loopback-v4');
  });
});

describe('net/ip-rules: filtering a DNS answer', () => {
  it('splits the answer and keeps the rule that blocked each rejected address', () => {
    const result = filterResolvedAddresses(['1.2.3.4', '169.254.169.254', '2001:db8::1', '::1'], { loopback: false });
    // v6 comes back in the full eight-group spelling: a log line that says which address was pinned
    // has to be unambiguous, and `::` is ambiguous about how many groups it stands for.
    assert.deepEqual(result.allowed.map((address) => address.text), ['1.2.3.4', '2001:db8:0:0:0:0:0:1']);
    assert.deepEqual(result.blocked, [
      { address: '169.254.169.254', rule: 'link-local-v4' },
      { address: '0:0:0:0:0:0:0:1', rule: 'loopback-v6' },
    ]);
  });

  it('returns nothing to pin when every address is denied', () => {
    const result = filterResolvedAddresses(['10.0.0.1', '192.168.1.1'], { loopback: false });
    assert.equal(result.allowed.length, 0);
    assert.equal(result.blocked.length, 2);
  });

  it('treats a non-array answer as empty', () => {
    assert.deepEqual(filterResolvedAddresses(/** @type {any} */ (null)), { allowed: [], blocked: [] });
  });
});
