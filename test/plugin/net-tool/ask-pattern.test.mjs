// The one spelling of the permission pattern (amendment 35.7, `D-M25`): `<METHOD> <origin><path>`, the
// WHATWG origin with the port only when it is not the scheme default, the path in its wire form, and no
// query. A1.1's second spelling put `:443` in the pattern, which the rendered `GET https://host/*` can
// never match under OpenCode's anchored `Wildcard.match`. The matcher below restates claim 129 (escape,
// `*` to `.*`, anchored, `s` flag) so the shape can be checked here; C47 runs the real one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatAskPattern } from '../../../plugin/opencode-unity-lib/net/ask-pattern.js';
import { SHIPPED_HOST_ENTRIES } from './helpers.mjs';

/**
 * Claim 129's `Wildcard.match`, restated for this suite only.
 * @param {string} input
 * @param {string} pattern
 * @returns {boolean}
 */
function wildcardMatch(input, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 's').test(input);
}

describe('formatAskPattern', () => {
  const cases = [
    { method: 'GET', url: 'https://docs.unity3d.com/Manual/index.html', pattern: 'GET https://docs.unity3d.com/Manual/index.html' },
    { method: 'GET', url: 'https://docs.unity3d.com:443/Manual/', pattern: 'GET https://docs.unity3d.com/Manual/' },
    { method: 'HEAD', url: 'HTTPS://Docs.Unity3D.com/x', pattern: 'HEAD https://docs.unity3d.com/x' },
    { method: 'GET', url: 'https://learn.microsoft.com/en-us/dotnet/api/system.string?view=net-8.0', pattern: 'GET https://learn.microsoft.com/en-us/dotnet/api/system.string' },
    { method: 'POST', url: 'http://127.0.0.1:5001/demo-game/us-central1/f?token=x', pattern: 'POST http://127.0.0.1:5001/demo-game/us-central1/f' },
    { method: 'GET', url: 'http://127.0.0.1:80/', pattern: 'GET http://127.0.0.1/' },
    { method: 'GET', url: 'http://[::1]:3000/health', pattern: 'GET http://[::1]:3000/health' },
    { method: 'GET', url: 'https://docs.unity3d.com/Manual/a%20b.html', pattern: 'GET https://docs.unity3d.com/Manual/a%20b.html' },
    { method: 'GET', url: 'https://docs.unity3d.com', pattern: 'GET https://docs.unity3d.com/' },
  ];
  for (const { method, url, pattern } of cases) {
    it(`spells ${url} as ${pattern}`, () => {
      assert.equal(formatAskPattern(method, url), pattern);
      assert.equal(formatAskPattern(method, new URL(url)), pattern);
    });
  }

  it('never carries a query, whatever the query holds', () => {
    assert.doesNotMatch(formatAskPattern('GET', 'https://docs.unity3d.com/x?key=secret&token=t'), /[?]|secret|token/);
  });
});

describe('the rendered rule shape against the pattern', () => {
  it('matches every shipped host for GET and HEAD under the anchored glob', () => {
    for (const entry of SHIPPED_HOST_ENTRIES) {
      for (const method of entry.methods) {
        for (const prefix of entry.pathPrefix) {
          const rule = `${method} https://${entry.host}${prefix}*`;
          const pattern = formatAskPattern(method, `https://${entry.host}${prefix}some/page`);
          assert.ok(wildcardMatch(pattern, rule), `${rule} does not match ${pattern}`);
        }
      }
    }
  });

  it('shows why the explicit-port spelling was withdrawn: it matches nothing that was rendered', () => {
    assert.equal(wildcardMatch('GET https://docs.unity3d.com:443/Manual/x', 'GET https://docs.unity3d.com/*'), false);
    assert.equal(wildcardMatch(formatAskPattern('GET', 'https://docs.unity3d.com:443/Manual/x'), 'GET https://docs.unity3d.com/*'), true);
  });

  it('matches a loopback port rule and not a method it does not name', () => {
    const pattern = formatAskPattern('GET', 'http://127.0.0.1:3000/v1/scores');
    assert.ok(wildcardMatch(pattern, 'GET http://127.0.0.1:*'));
    assert.equal(wildcardMatch(formatAskPattern('POST', 'http://127.0.0.1:3000/v1/scores'), 'GET http://127.0.0.1:*'), false);
  });
});
