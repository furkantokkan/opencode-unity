// Static scan for safety property S1 (spec 19.1): every product path that can make a server load or run
// a model goes through `guardedChat()` first. The scan is textual on purpose - it has to hold for code
// that does not exist yet, so it looks for the route strings themselves rather than for call shapes.
//
// What counts as a model endpoint is the route, not the base URL: `<base>/v1` is rendered into the
// OpenCode provider config all over the product and is not a call, while `/v1/chat/completions` and
// `/api/chat` are. Files that may name a route carry a reason in ALLOWED, and everything else fails.
//
// The amendment (38.x, row S07) adds the second rule: modules under `src/network/**` and
// `src/project/**` never reach a model endpoint at all - not directly and not by importing the guarded
// path. Those directories may not exist yet, so a missing root scans as empty and the rule still holds
// the moment a file lands there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Routes whose call makes a server load or run a model (native Ollama and OpenAI-compatible). */
const MODEL_ENDPOINTS = Object.freeze([
  '/api/chat',
  '/api/generate',
  '/api/embed',
  '/api/embeddings',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/responses',
]);

// The roots that ship, which is what S1 is about. `scripts/` stays out: those are repository hygiene
// tools that never run on a user's machine, and one of them matches route names as documentation data.
const SCANNED_ROOTS = Object.freeze(['src', 'plugin', 'bin']);

/** Roots that must not reach a model endpoint even through `guardedChat()`. */
const NO_MODEL_ROOTS = Object.freeze(['src/network', 'src/project']);

/** Files that may name a model route, each with the reason it is allowed to. */
const ALLOWED = new Map([
  ['src/ollama/guarded-chat.js', 'the guarded path: the one place that may send a model request'],
  ['src/ollama/client.js', 'refuses the load routes, and sends the unload body with keep_alive 0'],
  ['src/ollama/server-log.js', "parses Ollama's own server log, which prints the routes it served"],
]);

/** Directory prefixes that may name a model route. */
const ALLOWED_PREFIXES = Object.freeze([['src/selftest/', 'loopback mocks and capture checks: they serve or inspect these routes, they never call one']]);

const GUARDED_CHAT_IMPORT = /(?:^|[\s(])(?:import|export)\b[^\n;]*['"][^'"\n]*guarded-chat\.js['"]|\bimport\s*\(\s*['"][^'"\n]*guarded-chat\.js['"]/;

/**
 * @param {string} filePath
 * @returns {string}  The path with forward slashes, so a finding reads the same on every platform.
 */
function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

/**
 * Every JavaScript module under `root`, as repository-relative posix paths. A root that does not exist
 * yet scans as empty.
 * @param {string} root  Repository-relative, posix spelling.
 * @returns {string[]}
 */
function listModules(root) {
  const absolute = path.join(REPO_ROOT, ...root.split('/'));
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT' || /** @type {{ code?: string }} */ (error)?.code === 'ENOTDIR') return [];
    throw error;
  }
  return entries
    .flatMap((entry) => {
      const child = `${root}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listModules(child);
      return /\.(?:js|mjs|cjs)$/.test(entry.name) ? [child] : [];
    })
    .sort();
}

/**
 * @param {string[]} roots
 * @returns {Array<{ path: string, text: string }>}
 */
function readModules(roots) {
  return roots.flatMap(listModules).map((relative) => ({
    path: relative,
    text: fs.readFileSync(path.join(REPO_ROOT, ...relative.split('/')), 'utf8'),
  }));
}

/**
 * Blanks out comments and keeps strings, so prose that names a route is not read as a call while
 * `'http://host/api/chat'` still is. Newlines survive, so line numbers stay true. A naive `//` cut
 * would have swallowed the host URL in exactly the case that matters.
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let out = '';
  let state = 'code';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'code') {
      if (character === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line' : 'block';
        out += '  ';
        index += 1;
      } else {
        if (character === "'" || character === '"' || character === '`') state = character;
        out += character;
      }
    } else if (state === 'line') {
      state = character === '\n' ? 'code' : state;
      out += character === '\n' ? character : ' ';
    } else if (state === 'block') {
      if (character === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 1;
      } else {
        out += character === '\n' ? character : ' ';
      }
    } else if (character === '\\') {
      out += character + (next ?? '');
      index += 1;
    } else {
      if (character === state) state = 'code';
      out += character;
    }
  }
  return out;
}

/**
 * Routes named inside a string or a template, which is what a call needs.
 * @param {string} text
 * @returns {Array<{ line: number, endpoint: string }>}
 */
function findModelEndpoints(text) {
  const findings = [];
  const quote = /['"`]/;
  for (const [index, line] of stripComments(text).split(/\r?\n/).entries()) {
    for (const endpoint of MODEL_ENDPOINTS) {
      const at = line.indexOf(endpoint);
      if (at === -1) continue;
      if (!quote.test(line.slice(0, at)) || !quote.test(line.slice(at + endpoint.length))) continue;
      findings.push({ line: index + 1, endpoint });
    }
  }
  return findings;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function importsGuardedChat(text) {
  return GUARDED_CHAT_IMPORT.test(text);
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isAllowedToNameARoute(relativePath) {
  return ALLOWED.has(relativePath) || ALLOWED_PREFIXES.some(([prefix]) => relativePath.startsWith(prefix));
}

/**
 * S1: only the guarded path, the client's unload call and the mocks may name a model route.
 * @param {Array<{ path: string, text: string }>} files
 * @returns {string[]}  One finding per offending line.
 */
function checkRouteAllowList(files) {
  const findings = [];
  for (const file of files) {
    const hits = findModelEndpoints(file.text);
    if (hits.length === 0) continue;
    if (!isAllowedToNameARoute(file.path)) {
      for (const hit of hits) findings.push(`${file.path}:${hit.line} names ${hit.endpoint}; only guardedChat() may reach a model`);
      continue;
    }
    // An allowed file may name a route, but naming one on a line that also calls fetch would be a
    // second caller hiding behind the allowance.
    if (file.path === 'src/ollama/guarded-chat.js') continue;
    const code = stripComments(file.text).split(/\r?\n/);
    for (const hit of hits) {
      if (/\bfetch\s*\(/.test(code[hit.line - 1])) findings.push(`${file.path}:${hit.line} calls fetch on ${hit.endpoint}; only guardedChat() may reach a model`);
    }
  }
  return findings;
}

/**
 * The amendment's addition: `src/network/**` and `src/project/**` never reach a model endpoint.
 * @param {Array<{ path: string, text: string }>} files
 * @returns {string[]}
 */
function checkNoModelRoots(files) {
  const findings = [];
  for (const file of files) {
    if (!NO_MODEL_ROOTS.some((root) => file.path === root || file.path.startsWith(`${root}/`))) continue;
    for (const hit of findModelEndpoints(file.text)) {
      findings.push(`${file.path}:${hit.line} names ${hit.endpoint}; network and project code never reaches a model`);
    }
    if (importsGuardedChat(file.text)) findings.push(`${file.path} imports the guarded chat path; network and project code never reaches a model`);
  }
  return findings;
}

const productModules = readModules(SCANNED_ROOTS);

describe('S1 static scan: model routes', () => {
  it('scans the product roots that exist', () => {
    assert.ok(productModules.length > 0, 'the scan found no modules to check');
    assert.ok(
      productModules.some((file) => file.path === 'src/ollama/guarded-chat.js'),
      'the guarded path itself was not scanned',
    );
  });

  it('lets only the guarded path, the unload call and the mocks name a model route', () => {
    assert.deepEqual(checkRouteAllowList(productModules), []);
  });

  it('keeps the allow-list free of entries that no longer exist', () => {
    const scanned = new Set(productModules.map((file) => file.path));
    for (const [allowed] of ALLOWED) assert.ok(scanned.has(allowed), `${allowed} is allowed to name a model route but was not found`);
  });

  it('holds the client to the unload body it is allowed to send', () => {
    const client = productModules.find((file) => file.path === 'src/ollama/client.js');
    assert.ok(client, 'src/ollama/client.js was not scanned');
    assert.match(client.text, /keep_alive:\s*0\b/, 'the client may only reach /api/chat with keep_alive 0');
    assert.match(client.text, /only guardedChat\(\) may call it/, 'the client must still refuse the load routes');
  });

  it('keeps the guard and the lock in front of the one model request', () => {
    const guarded = productModules.find((file) => file.path === 'src/ollama/guarded-chat.js');
    assert.ok(guarded, 'src/ollama/guarded-chat.js was not scanned');
    assert.match(guarded.text, /\bevaluateGuard\b/, 'the guarded path must evaluate the guard');
    assert.match(guarded.text, /\bacquireGpuLock\b/, 'the guarded path must take the GPU lock');
    assert.equal((guarded.text.match(/\bfetchImpl\s*\(/g) ?? []).length, 1, 'the guarded path must have exactly one outgoing request');
  });
});

describe('S1 static scan: roots that never reach a model', () => {
  it('finds nothing in the network and project roots', () => {
    assert.deepEqual(checkNoModelRoots(productModules), []);
  });

  it('scans a root that does not exist yet as empty', () => {
    assert.deepEqual(listModules('src/does-not-exist-yet'), []);
    assert.deepEqual(listModules('package.json'), []);
  });
});

describe('S1 static scan rules', () => {
  it('reads a route out of a line and leaves a bare /v1 base URL alone', () => {
    assert.deepEqual(findModelEndpoints("const url = `${base}/v1`;\nawait post('/api/chat');"), [{ line: 2, endpoint: '/api/chat' }]);
    assert.deepEqual(findModelEndpoints("baseURL: 'http://127.0.0.1:11434/v1'"), []);
    assert.deepEqual(
      findModelEndpoints("fetch(`${base}/v1/chat/completions`)").map((hit) => hit.endpoint),
      ['/v1/chat/completions'],
    );
  });

  it('reads a quoted route, not a route named in prose', () => {
    assert.deepEqual(findModelEndpoints('// the only POST to /api/chat here is the unload body'), []);
    assert.deepEqual(findModelEndpoints('// sends the native `/api/chat` body of spec 12.3'), [], 'backticks in a comment are prose, not a call');
    assert.deepEqual(findModelEndpoints('/*\n * A block comment about /api/embed and `/v1/completions`.\n */'), []);
    assert.deepEqual(findModelEndpoints("const CHAT_ROUTE = '/api/chat';"), [{ line: 1, endpoint: '/api/chat' }]);
    // A host URL carries `//`, so cutting at the first `//` would have hidden this call.
    assert.deepEqual(findModelEndpoints("await fetch('http://127.0.0.1:11434/api/generate');"), [{ line: 1, endpoint: '/api/generate' }]);
    assert.deepEqual(findModelEndpoints("const a = 1; // note\nconst route = '/api/chat';"), [{ line: 2, endpoint: '/api/chat' }], 'a line comment ends at the newline');
  });

  it('reports a route named outside the allow-list', () => {
    const findings = checkRouteAllowList([
      { path: 'src/bench/run.js', text: "await fetch(`${base}/api/chat`);" },
      { path: 'src/ollama/guarded-chat.js', text: "await fetchImpl(`${base}/api/chat`);" },
      { path: 'src/selftest/mock-ollama.js', text: "'POST /api/chat': handleGenerate," },
    ]);
    assert.deepEqual(findings, ['src/bench/run.js:1 names /api/chat; only guardedChat() may reach a model']);
  });

  it('reports an allowed file that starts calling a route', () => {
    const findings = checkRouteAllowList([{ path: 'src/selftest/mock-ollama.js', text: "await fetch(`${base}/api/generate`);" }]);
    assert.deepEqual(findings, ['src/selftest/mock-ollama.js:1 calls fetch on /api/generate; only guardedChat() may reach a model']);
  });

  it('reports network and project modules that reach a model, by route or by import', () => {
    const findings = checkNoModelRoots([
      { path: 'src/network/probe.js', text: "const route = '/v1/chat/completions';" },
      { path: 'src/project/components/backend.js', text: "import { guardedChat } from '../../ollama/guarded-chat.js';" },
      { path: 'src/shape/rewrite.js', text: "import { guardedChat } from '../ollama/guarded-chat.js';" },
      { path: 'src/projects-view.js', text: "import { guardedChat } from './ollama/guarded-chat.js';" },
    ]);
    assert.deepEqual(findings, [
      'src/network/probe.js:1 names /v1/chat/completions; network and project code never reaches a model',
      'src/project/components/backend.js imports the guarded chat path; network and project code never reaches a model',
    ]);
  });

  it('recognises the import spellings a module could use', () => {
    for (const text of [
      "import { guardedChat } from '../ollama/guarded-chat.js';",
      'import * as guarded from "../../ollama/guarded-chat.js";',
      "export { guardedWarm } from './guarded-chat.js';",
      "const mod = await import('../ollama/guarded-chat.js');",
    ]) {
      assert.ok(importsGuardedChat(text), `not recognised: ${text}`);
    }
    for (const text of ["// guarded-chat.js is off limits here", "const name = 'guarded-chat.js';"]) {
      assert.equal(importsGuardedChat(text), false, `wrongly recognised: ${text}`);
    }
  });
});
