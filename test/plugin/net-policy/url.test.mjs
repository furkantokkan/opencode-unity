// URL parsing, normalisation and the matcher primitives (amendment 35.5 step 4 and step 6). The cases
// that matter are the ones where two readers disagree about what the request is: a host the parser
// rewrites, a delimiter one parser honours and another strips, and a path that leaves its prefix only
// after decoding.
//
// Every hostile character is built with `String.fromCodePoint` rather than written into the file. A
// raw control byte in a source file takes it out of the repository's personal-data scan silently, and
// a raw homoglyph is invisible to the reviewer who has to judge the test.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  firstPathSegment,
  formatOrigin,
  hasTraversalSegment,
  hostMatchesEntry,
  isLoopbackHostname,
  matchesPathPrefix,
  parseRequestUrl,
  pathCandidates,
  readQueryPairs,
  resolveLocation,
  stripLocaleSegment,
} from '../../../plugin/opencode-unity-lib/net/url.js';

const TAB = String.fromCodePoint(0x09);
const LF = String.fromCodePoint(0x0a);
const CR = String.fromCodePoint(0x0d);
const NUL = String.fromCodePoint(0x00);
const CYRILLIC_O = String.fromCodePoint(0x043e);
const U_UMLAUT = String.fromCodePoint(0x00fc);

/** @param {string} raw */
function parse(raw) {
  return parseRequestUrl(raw);
}

describe('net/url: what it accepts', () => {
  it('reads the parts the policy decides on', () => {
    const result = parse('https://docs.unity3d.com/Manual/Profiler.html?q=gc');
    assert.equal(result.ok, true);
    assert.equal(result.scheme, 'https');
    assert.equal(result.host, 'docs.unity3d.com');
    assert.equal(result.port, 443);
    assert.equal(result.explicitPort, false);
    assert.equal(result.path, '/Manual/Profiler.html');
    assert.equal(result.query, 'q=gc');
    assert.equal(result.origin, 'https://docs.unity3d.com');
  });

  it('folds host case without touching the path, on every platform', () => {
    const result = parse('HTTPS://DOCS.Unity3D.COM/Manual/Case.html');
    assert.equal(result.ok, true);
    assert.equal(result.host, 'docs.unity3d.com');
    assert.equal(result.path, '/Manual/Case.html', 'the path is a byte string, not a file name');
  });

  it('keeps an explicit port and leaves a default one out of the origin', () => {
    assert.equal(parse('http://127.0.0.1:5001/demo-app/fn').origin, 'http://127.0.0.1:5001');
    assert.equal(parse('http://127.0.0.1:80/x').origin, 'http://127.0.0.1');
    assert.equal(parse('https://api.nuget.org:443/v3/index.json').origin, 'https://api.nuget.org');
    assert.equal(formatOrigin('http', '::1', 8080), 'http://[::1]:8080');
  });

  it('accepts an IPv6 loopback literal', () => {
    const result = parse('http://[::1]:5001/health');
    assert.equal(result.ok, true);
    assert.equal(result.host, '::1');
    assert.equal(result.port, 5001);
  });

  it('decodes the path once, for prefix comparison', () => {
    const result = parse('https://learn.microsoft.com/dotnet/api/System%2ESpan-1');
    assert.equal(result.ok, true);
    assert.equal(result.decodedPath, '/dotnet/api/System.Span-1');
    assert.equal(result.path, '/dotnet/api/System%2ESpan-1', 'the wire form is what the budget counts');
  });
});

describe('net/url: what it refuses', () => {
  it('refuses a scheme that is not http or https', () => {
    for (const raw of ['ftp://docs.unity3d.com/x', 'file:///etc/passwd', 'data:text/plain,hello']) {
      const result = parse(raw);
      assert.equal(result.ok, false, raw);
      assert.equal(result.code, 'net_url_invalid');
    }
  });

  it('refuses userinfo in either spelling', () => {
    // The host is example.com so that the userinfo does not read as an address to the hygiene scan.
    for (const raw of ['https://user:secret@example.com/x', 'https://user@example.com/x']) {
      const result = parse(raw);
      assert.equal(result.ok, false, raw);
      assert.equal(result.code, 'net_url_userinfo');
    }
  });

  it('refuses control characters, which the WHATWG parser would silently remove', () => {
    const hostile = [
      `https://docs.unity3d.com${TAB}/x`,
      `https://docs.unity3d.com/x${LF}`,
      `https://docs${NUL}.unity3d.com/x`,
      `https://docs.unity3d.com/x${CR}`,
    ];
    for (const raw of hostile) {
      const result = parse(raw);
      assert.equal(result.ok, false, JSON.stringify(raw));
      assert.equal(result.code, 'net_url_invalid');
      assert.equal(result.reason, 'control-character');
    }
  });

  it('refuses a backslash, which a special scheme reads as a separator', () => {
    const result = parse('http://evil.test\\@docs.unity3d.com/x');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'backslash');
  });

  it('refuses a fragment and an out-of-range port', () => {
    assert.equal(parse('https://docs.unity3d.com/x#frag').reason, 'fragment');
    assert.equal(parse('http://127.0.0.1:0/x').reason, 'port');
  });

  it('refuses a host the parser would punycode, in either script', () => {
    const hostile = [`https://d${CYRILLIC_O}cs.unity3d.com/x`, `https://${U_UMLAUT}nity.example.test/x`];
    for (const raw of hostile) {
      const result = parse(raw);
      assert.equal(result.ok, false, raw);
      assert.equal(result.code, 'net_url_idn');
    }
  });

  it('refuses malformed percent encoding rather than guessing', () => {
    assert.equal(parse('https://docs.unity3d.com/%zz').reason, 'percent-encoding');
  });

  it('refuses a string the parser itself cannot read', () => {
    for (const raw of ['http://', 'https://:443/x', 'not-a-url']) {
      const result = parse(raw);
      assert.equal(result.ok, false, raw);
      assert.equal(result.code, 'net_url_invalid');
      assert.equal(result.reason, 'parse', raw);
    }
  });

  it('refuses a non-string and an empty string', () => {
    for (const raw of [null, undefined, 42, '', {}]) assert.equal(parseRequestUrl(raw).ok, false);
  });
});

describe('net/url: the host matcher', () => {
  const suffix = { host: '*.example.com', hostKind: 'suffix' };
  const exact = { host: 'docs.unity3d.com', hostKind: 'exact' };

  it('matches an exact host and nothing that merely contains it', () => {
    assert.equal(hostMatchesEntry('docs.unity3d.com', exact), true);
    assert.equal(hostMatchesEntry('docs.unity3d.com.evil.test', exact), false, 'the case the rendered glob would accept');
    assert.equal(hostMatchesEntry('evil-docs.unity3d.com', exact), false);
  });

  it('matches a suffix only on a label boundary', () => {
    assert.equal(hostMatchesEntry('a.example.com', suffix), true);
    assert.equal(hostMatchesEntry('deep.a.example.com', suffix), true);
    assert.equal(hostMatchesEntry('example.com', suffix), false, 'the suffix is *.example.com, not example.com');
    assert.equal(hostMatchesEntry('notexample.com', suffix), false);
    assert.equal(hostMatchesEntry('example.com.evil.test', suffix), false);
  });

  it('takes the host from the parsed URL, so a path cannot forge one', () => {
    const result = parse('https://evil.test/a.example.com');
    assert.equal(result.ok, true);
    assert.equal(hostMatchesEntry(result.host, suffix), false);
  });

  it('knows the loopback spellings a loopback entry accepts', () => {
    for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '::1']) assert.equal(isLoopbackHostname(host), true, host);
    for (const host of ['localhost.evil.test', '127.0.0.1.evil.test', '10.0.0.1', '::2']) assert.equal(isLoopbackHostname(host), false, host);
  });
});

describe('net/url: paths, prefixes and locales', () => {
  it('compares a prefix on a segment boundary', () => {
    assert.equal(matchesPathPrefix(['/dotnet/api/x'], ['/dotnet/']), true);
    assert.equal(matchesPathPrefix(['/dotnet'], ['/dotnet/']), false);
    assert.equal(matchesPathPrefix(['/dotnetfoo/x'], ['/dotnet']), false, 'a prefix is not a substring');
    assert.equal(matchesPathPrefix(['/anything'], ['/']), true);
    assert.equal(matchesPathPrefix(['/x'], []), false);
  });

  it('strips one locale segment and leaves a real first segment alone', () => {
    assert.equal(stripLocaleSegment('/tr-tr/dotnet/x'), '/dotnet/x');
    assert.equal(stripLocaleSegment('/en-us/nuget/y'), '/nuget/y');
    assert.equal(stripLocaleSegment('/zh-hant/dotnet/x'), '/dotnet/x');
    assert.equal(stripLocaleSegment('/azure/x'), '/azure/x');
    assert.equal(stripLocaleSegment('/dotnet/x'), '/dotnet/x');
    assert.equal(stripLocaleSegment('/tr'), '/');
  });

  it('offers both forms when an entry asks for locale stripping', () => {
    assert.deepEqual(pathCandidates('/tr-tr/dotnet/x', true), ['/tr-tr/dotnet/x', '/dotnet/x']);
    assert.deepEqual(pathCandidates('/dotnet/x', true), ['/dotnet/x']);
    assert.deepEqual(pathCandidates('/tr-tr/dotnet/x', false), ['/tr-tr/dotnet/x']);
    assert.equal(matchesPathPrefix(pathCandidates('/tr-tr/dotnet/x', true), ['/dotnet/', '/nuget/']), true);
    assert.equal(matchesPathPrefix(pathCandidates('/azure/x', true), ['/dotnet/', '/nuget/']), false);
  });

  it('finds a traversal segment hidden behind an encoded separator', () => {
    const result = parse('https://docs.unity3d.com/Manual/x%2F..%2Fsecret');
    assert.equal(result.ok, true);
    assert.equal(result.path, '/Manual/x%2F..%2Fsecret', 'the wire form has no .. segment of its own');
    assert.equal(result.decodedPath, '/Manual/x/../secret');
    assert.equal(hasTraversalSegment(result.decodedPath), true);
    assert.equal(hasTraversalSegment('/Manual/Profiler.html'), false);
  });

  it('leaves the plain traversal spellings to the parser, which resolves them', () => {
    // `new URL()` resolves `..` and `%2e%2e` before the policy sees the path, so the only spelling
    // that reaches the traversal check is the encoded-separator one above.
    assert.equal(parse('https://docs.unity3d.com/Manual/%2E%2E/secret').decodedPath, '/secret');
    assert.equal(parse('https://docs.unity3d.com/a/./b').decodedPath, '/a/b');
  });

  it('reads the first path segment, which is where a project id sits', () => {
    assert.equal(firstPathSegment('/demo-app/us-central1/fn'), 'demo-app');
    assert.equal(firstPathSegment('/'), '');
    assert.equal(firstPathSegment(''), '');
  });
});

describe('net/url: query pairs and redirect targets', () => {
  it('lowercases query keys and keeps repeats', () => {
    assert.deepEqual(readQueryPairs('Token=a&token=b&q=c'), [
      { key: 'token', value: 'a' },
      { key: 'token', value: 'b' },
      { key: 'q', value: 'c' },
    ]);
    assert.deepEqual(readQueryPairs(''), []);
  });

  it('resolves a relative and an absolute Location without following either', () => {
    assert.equal(resolveLocation('/Manual/new.html', 'https://docs.unity3d.com/old.html'), 'https://docs.unity3d.com/Manual/new.html');
    assert.equal(resolveLocation('https://evil.test/x', 'https://docs.unity3d.com/old.html'), 'https://evil.test/x');
  });

  it('refuses a Location that carries a control character or a backslash', () => {
    assert.equal(resolveLocation(`https://evil.test/${CR}Set-Cookie`, 'https://docs.unity3d.com/x'), null);
    assert.equal(resolveLocation('\\\\evil.test\\x', 'https://docs.unity3d.com/x'), null);
    assert.equal(resolveLocation('', 'https://docs.unity3d.com/x'), null);
  });
});
