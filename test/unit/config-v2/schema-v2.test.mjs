// config.json schemaVersion 2 (amendment 35.7, 36.8, 37.10, 38.4): the new blocks are validated as strictly
// as the old ones. Unknown keys are exit 1, the documented defaults are the code's defaults, and an
// allow-list entry cannot carry a key that would switch certificate checks off.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import {
  DEFAULT_CONFIG,
  applyConfigDefaults,
  getConfigWarnings,
  getDefaultConfig,
  readConfigSchema,
  resolveConfig,
  validateConfig,
} from '../../../src/core/config.js';
import { catchError } from '../../helpers/catch-error.mjs';

const PROJECT_ID = 'demo-0a1b2c3d';

/** A loopback entry of the shape `init` derives for a Cloud Functions emulator. */
const FUNCTIONS_EMULATOR = Object.freeze({
  id: 'firebase-functions',
  host: '127.0.0.1',
  ports: [5001],
  scheme: 'http',
  methods: ['GET', 'POST'],
  pathPrefix: ['/demo-game/'],
  loopback: true,
  firebaseEmulator: 'functions',
  budget: { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 8192 },
  note: 'derived from firebase.json',
});

/** A consented, read-only, non-loopback entry. */
const CONSENTED_DOCS = Object.freeze({
  id: 'vendor-docs',
  host: '*.docs.example.test',
  ports: [443],
  scheme: 'https',
  methods: ['GET', 'HEAD'],
  pathPrefix: ['/'],
  stripLocaleSegment: true,
  consentId: 'grant-0001',
});

/**
 * @param {Record<string, unknown>} document  Merged over `{ schemaVersion: 2 }`.
 * @returns {import('../../../plugin/opencode-unity-lib/json-schema.js').SchemaError[]}
 */
function problemsOf(document) {
  return validateConfig(applyConfigDefaults({ schemaVersion: 2, ...document }, { platform: 'win32' }));
}

/**
 * @param {Record<string, unknown>} document
 * @returns {string}
 */
function describeProblems(document) {
  return problemsOf(document).map((problem) => `${problem.path} ${problem.message}`).join('\n');
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
function describeEntryProblems(entry) {
  return describeProblems({ network: { allow: [entry] } });
}

/**
 * Every `default` annotation in the schema, with its dotted path.
 * @param {Record<string, any>} node
 * @param {string} prefix
 * @param {Array<[string, unknown]>} found
 * @returns {Array<[string, unknown]>}
 */
function collectDefaults(node, prefix = '', found = []) {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (Object.hasOwn(child, 'default')) found.push([childPath, child.default]);
    collectDefaults(child, childPath, found);
  }
  return found;
}

/**
 * @param {unknown} root
 * @param {string} dottedPath
 * @returns {unknown}
 */
function readPath(root, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => /** @type {any} */ (value)?.[key], root);
}

describe('config.json schemaVersion 2', () => {
  it('declares version 2 and requires the three new blocks', () => {
    const schema = readConfigSchema();
    assert.equal(schema.properties.schemaVersion.const, 2);
    for (const block of ['network', 'shape', 'project']) assert.ok(schema.required.includes(block), block);
    assert.ok(schema.properties.safety.required.includes('multiplayerProtectedGlobs'));
  });

  it('documents the same default the code applies, for every key that states one', () => {
    const defaults = collectDefaults(readConfigSchema());
    assert.ok(defaults.length > 60, `only ${defaults.length} documented defaults found`);
    for (const [dottedPath, documented] of defaults) {
      assert.deepEqual(readPath(DEFAULT_CONFIG, dottedPath), documented, dottedPath);
    }
  });

  it('accepts the defaults of every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin', 'freebsd']) {
      assert.deepEqual(validateConfig(getDefaultConfig(platform)), [], platform);
    }
  });

  it('says nothing about the defaults', () => {
    for (const platform of /** @type {const} */ (['win32', 'linux', 'darwin'])) {
      assert.deepEqual(getConfigWarnings(resolveConfig({ schemaVersion: 2 }, 'config.json', { platform })), [], platform);
    }
  });

  it('rejects an out-of-range or unknown value in each new block, as exit 1', () => {
    /** @type {Array<[Record<string, unknown>, RegExp]>} */
    const cases = [
      [{ network: { profile: 'open' } }, /network\.profile must be one of/],
      [{ network: { enabled: 'yes' } }, /network\.enabled must be true or false/],
      [{ network: { bash: 'allow' } }, /network\.bash must be one of/],
      [{ network: { limits: { maxResponseBytes: 0 } } }, /network\.limits\.maxResponseBytes must be >= 1024/],
      [{ network: { limits: { maxRequestsPerSession: 1.5 } } }, /network\.limits\.maxRequestsPerSession must be an integer/],
      [{ network: { limits: { maxRedirects: 3 } } }, /network\.limits\.maxRedirects is not a known key/],
      [{ network: { extraReservedPorts: [70000] } }, /network\.extraReservedPorts\[0\] must be <= 65535/],
      [{ network: { extraDeniedHosts: ['https://x.test/'] } }, /network\.extraDeniedHosts\[0\] must match/],
      [{ network: { extraDeniedQueryKeys: ['token', 'token'] } }, /network\.extraDeniedQueryKeys must not contain duplicates/],
      [{ network: { proxy: 'http://127.0.0.1:3128' } }, /network\.proxy is not a known key/],
      [{ shape: { mode: 'sometimes' } }, /shape\.mode must be one of/],
      [{ shape: { maxOutputTokens: 0 } }, /shape\.maxOutputTokens must be >= 16/],
      [{ shape: { temperature: 0 } }, /shape\.temperature is not a known key/],
      [{ project: { components: 'everything' } }, /project\.components/],
      [{ project: { components: [] } }, /project\.components/],
      [{ project: { components: ['Unity Game'] } }, /project\.components\[0\] must match/],
      [{ project: { maxComponents: 0 } }, /project\.maxComponents must be >= 1/],
      [{ project: { verify: { scriptOrder: [] } } }, /project\.verify\.scriptOrder must have at least 1 item/],
      [{ project: { verify: { scriptOrder: ['test; rm -rf .'] } } }, /project\.verify\.scriptOrder\[0\] must match/],
      [{ project: { database: { readEnvExampleValues: true } } }, /project\.database\.readEnvExampleValues is not a known key/],
      [{ project: { multiplayer: { ruleBlock: 'maybe' } } }, /project\.multiplayer\.ruleBlock must be one of/],
      [{ safety: { multiplayerProtectedGlobs: [''] } }, /safety\.multiplayerProtectedGlobs\[0\] must not be empty/],
      [{ safety: { multiplayerProtectedGlobs: ['*.rules', '*.rules'] } }, /safety\.multiplayerProtectedGlobs must not contain duplicates/],
      [{ experimental: { platforms: 'yes' } }, /experimental\.platforms must be true or false/],
    ];
    for (const [document, pattern] of cases) {
      assert.match(describeProblems(document), pattern, JSON.stringify(document));
      const error = catchError(() => resolveConfig({ schemaVersion: 2, ...document }));
      assert.equal(error.exitCode, EXIT.USAGE, JSON.stringify(document));
      assert.equal(error.code, 'config_invalid');
    }
  });

  it('accepts the documented alternatives of each new block', () => {
    for (const document of [
      { network: { enabled: false, profile: 'none' } },
      { network: { profile: 'custom', allow: [FUNCTIONS_EMULATOR, CONSENTED_DOCS] } },
      { network: { bash: 'ask', extraDeniedQueryKeys: ['session'], extraDeniedHosts: ['*.internal.test', '10.0.0.5'], extraReservedPorts: [9229] } },
      { shape: { mode: 'always' } },
      { shape: { mode: 'off', anchorCandidates: 0 } },
      { project: { components: 'unity-only' } },
      { project: { components: ['unity:game', 'node:api', 'db:api-drizzle', 'firebase:root', 'server:match-1a2b'] } },
      { project: { verify: { enabled: false, scriptOrder: ['test:unit'] }, multiplayer: { ruleBlock: 'never' } } },
      { safety: { multiplayerProtectedGlobs: [] } },
      { experimental: { platforms: true } },
    ]) {
      assert.deepEqual(problemsOf(document), [], JSON.stringify(document));
    }
  });

  it('checks what one key alone cannot: the timeouts and the facts budget', () => {
    assert.match(describeProblems({ network: { limits: { connectTimeoutMs: 30000, totalTimeoutMs: 20000 } } }), /network\.limits\.connectTimeoutMs must not exceed network\.limits\.totalTimeoutMs/);
    assert.match(describeProblems({ network: { limits: { firstByteTimeoutMs: 25000 } } }), /network\.limits\.firstByteTimeoutMs must not exceed/);
    assert.match(describeProblems({ project: { unityBlockChars: 3000 } }), /project\.unityBlockChars must not exceed project\.factsBudgetChars/);
    assert.match(describeProblems({ project: { factsBudgetChars: 500, componentBlockChars: 600, unityBlockChars: 400 } }), /project\.componentBlockChars must not exceed/);
    assert.deepEqual(problemsOf({ network: { limits: { connectTimeoutMs: 20000, firstByteTimeoutMs: 20000 } } }), []);
  });
});

describe('network.allow entries (35.7)', () => {
  it('accepts a derived loopback entry and a consented read-only entry', () => {
    assert.equal(describeEntryProblems(FUNCTIONS_EMULATOR), '');
    assert.equal(describeEntryProblems(CONSENTED_DOCS), '');
    assert.equal(describeEntryProblems({ ...FUNCTIONS_EMULATOR, ports: '*' }), '', 'a wildcard port is for the render rules to judge');
    assert.equal(describeEntryProblems({ ...FUNCTIONS_EMULATOR, host: '::1', headers: { 'X-Dev': 'local' }, caFile: 'dev-ca.pem', firebaseEmulator: false, destructive: false }), '');
  });

  it('refuses a key that would switch certificate checks off, rather than ignoring it', () => {
    for (const key of ['rejectUnauthorized', 'insecure', 'strictSSL']) {
      assert.match(describeEntryProblems({ ...CONSENTED_DOCS, [key]: false }), new RegExp(`network\\.allow\\[0\\]\\.${key} is not a known key`), key);
    }
  });

  it('refuses a scheme wildcard, which would let plain http reach a remote host', () => {
    assert.match(describeEntryProblems({ ...CONSENTED_DOCS, scheme: '*' }), /network\.allow\[0\]\.scheme must be one of: "http", "https"/);
  });

  it('has no default port, method, scheme or path', () => {
    for (const key of ['id', 'host', 'ports', 'scheme', 'methods', 'pathPrefix']) {
      const entry = /** @type {Record<string, unknown>} */ ({ ...CONSENTED_DOCS });
      delete entry[key];
      assert.match(describeEntryProblems(entry), new RegExp(`network\\.allow\\[0\\]\\.${key} is required`), key);
    }
  });

  it('rejects malformed fields with the field named', () => {
    /** @type {Array<[Record<string, unknown>, RegExp]>} */
    const cases = [
      [{ id: 'Vendor Docs' }, /\.id must match/],
      [{ host: 'https://docs.example.test' }, /\.host must match/],
      [{ host: 'docs.example.test/path' }, /\.host must match/],
      [{ host: 'user@docs.example.test' }, /\.host must match/],
      [{ ports: [] }, /\.ports/],
      [{ ports: [0] }, /\.ports/],
      [{ ports: [443, 443] }, /\.ports/],
      [{ methods: ['CONNECT'] }, /\.methods\[0\] must be one of/],
      [{ methods: ['get'] }, /\.methods\[0\] must be one of/],
      [{ methods: [] }, /\.methods must have at least 1 item/],
      [{ pathPrefix: ['docs/'] }, /\.pathPrefix\[0\] must match/],
      [{ pathPrefix: [] }, /\.pathPrefix must have at least 1 item/],
      [{ firebaseEmulator: true }, /\.firebaseEmulator/],
      [{ headers: { 'Bad Header': 'x' } }, /\.headers\.Bad Header is not a valid key/],
      [{ budget: { maxBodyBytes: 10 } }, /\.budget\.maxBodyBytes is not a known key/],
      [{ budget: { maxPathChars: -1 } }, /\.budget\.maxPathChars must be >= 0/],
      [{ consentId: 'has space' }, /\.consentId must match/],
    ];
    for (const [change, pattern] of cases) {
      assert.match(describeEntryProblems({ ...CONSENTED_DOCS, ...change }), pattern, JSON.stringify(change));
    }
  });
});

describe('projects.<id>.network (35.7)', () => {
  it('accepts a narrowing override and leaves the key out of the defaults', () => {
    const config = resolveConfig({ schemaVersion: 2, projects: { [PROJECT_ID]: { network: { profile: 'none' } } } });
    assert.deepEqual(config.projects[PROJECT_ID].network, { profile: 'none' });
    const plain = resolveConfig({ schemaVersion: 2, projects: { [PROJECT_ID]: { editor: { enabled: true } } } });
    assert.equal(Object.hasOwn(plain.projects[PROJECT_ID], 'network'), false, 'absent means the global block applies');
    assert.deepEqual(problemsOf({ projects: { [PROJECT_ID]: { network: { enabled: false, limits: { maxRequestsPerSession: 5 }, allow: [CONSENTED_DOCS], extraDeniedHosts: ['*.cdn.test'] } } } }), []);
  });

  it('cannot turn the shell rule to ask, and checks its entries like the global ones', () => {
    assert.match(describeProblems({ projects: { [PROJECT_ID]: { network: { bash: 'ask' } } } }), /projects\.demo-0a1b2c3d\.network\.bash is not a known key/);
    assert.match(describeProblems({ projects: { [PROJECT_ID]: { network: { allow: [{ ...CONSENTED_DOCS, insecure: true }] } } } }), /network\.allow\[0\]\.insecure is not a known key/);
    assert.match(describeProblems({ projects: { [PROJECT_ID]: { network: { limits: { maxResponseBytes: 1 } } } } }), /network\.limits\.maxResponseBytes must be >= 1024/);
  });
});

describe('getConfigWarnings (the new settings that weaken a default)', () => {
  it('warns when shell network commands prompt instead of being refused', () => {
    const warnings = getConfigWarnings(resolveConfig({ schemaVersion: 2, network: { bash: 'ask' } }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /network\.bash is ask/);
  });

  it('warns when a verify script body is no longer checked', () => {
    const warnings = getConfigWarnings(resolveConfig({ schemaVersion: 2, project: { verify: { blockScriptBodies: false } } }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /project\.verify\.blockScriptBodies is false/);
  });

  it('does not warn about a narrower setting', () => {
    const config = resolveConfig({ schemaVersion: 2, network: { enabled: false, profile: 'none' }, shape: { mode: 'off' }, safety: { multiplayerProtectedGlobs: ['*Economy/*'] } });
    assert.deepEqual(getConfigWarnings(config), []);
  });
});
