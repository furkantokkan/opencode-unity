// The one spelling of the `unitynet` permission pattern (amendment 35.7, `D-M25`). The tool passes it to
// `ctx.ask`, and the renderer (S37) generates the rendered `unitynet` rules against it, so it is defined
// here and nowhere else. A1.1 had two spellings in one file, and the one with an explicit `:443` could
// never match the rendered `GET https://docs.unity3d.com/*`: `Wildcard.match` anchors the glob, so the
// only surviving rule was the leading `* -> deny` and the default profile was denied before the
// plugin's own matcher ran.
//
// `origin` is the WHATWG `URL.origin`: scheme, lowercased host, and the port only when it is not the
// scheme's default. `path` is `URL.pathname` in its wire form. The query is never part of it, so
// nothing a query carries can reach a permission prompt, a log line or the OpenCode message store
// (`DN13`).

/**
 * @param {string} method  Upper case, already validated.
 * @param {URL | string} url
 * @returns {string}
 */
export function formatAskPattern(method, url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  return `${method} ${parsed.origin}${parsed.pathname}`;
}
