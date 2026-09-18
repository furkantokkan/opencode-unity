// The variables that never reach the OpenCode child and are never restored by `shell.env`
// (spec 8.1, expansion 12.12.4).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  NEVER_FORWARDED_ENV_PATTERNS,
  findNeverForwardedEnvNames,
  isNeverForwardedEnvName,
} from '../../../src/network/sensitive.js';
import { FIXTURES_DIR } from '../../helpers/fixture-fs.mjs';

/** @type {{ environment: Record<string, string>, expectedRemoved: string[], expectedKept: string[] }} */
const PARENT = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'network', 'sensitive', 'env-parent.json'), 'utf8'));

describe('the never-forwarded list', () => {
  it('names the three reasons the spec gives: a credential, a redirect and a proxy', () => {
    assert.ok(isNeverForwardedEnvName('FIREBASE_TOKEN'), 'the Firebase CLI picks this up on its own');
    assert.ok(isNeverForwardedEnvName('FIRESTORE_EMULATOR_HOST'), 'a redirect makes a session unreproducible');
    assert.ok(isNeverForwardedEnvName('HTTPS_PROXY'), 'there is no proxy support, so a proxy is a silent destination');
  });

  it('folds case, so the POSIX lower-case spellings are covered by the upper-case entry', () => {
    assert.ok(isNeverForwardedEnvName('http_proxy'));
    assert.ok(isNeverForwardedEnvName('all_proxy'));
    assert.ok(isNeverForwardedEnvName('firebase_token'));
  });

  it('matches the suffix and prefix globs of both specs', () => {
    for (const name of ['MY_API_KEY', 'SOME_AUTH_TOKEN', 'X_ACCESS_TOKEN', 'A_SECRET', 'B_PASSWORD', 'C_CREDENTIALS']) {
      assert.ok(isNeverForwardedEnvName(name), name);
    }
    for (const name of ['AWS_REGION', 'AZURE_OPENAI_ENDPOINT', 'CLOUDSDK_CORE_PROJECT', 'GOOGLE_OAUTH_CLIENT', 'SUPABASE_URL']) {
      assert.ok(isNeverForwardedEnvName(name), name);
    }
  });

  it('leaves the variables a Unity build actually needs alone', () => {
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'UNITY_VERSION', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'XDG_CONFIG_HOME']) {
      assert.equal(isNeverForwardedEnvName(name), null, name);
    }
  });

  it('reports the first pattern in list order, so a printed list explains itself', () => {
    assert.equal(isNeverForwardedEnvName('MY_API_KEY'), '*_API_KEY');
    assert.equal(isNeverForwardedEnvName('SUPABASE_ANON_KEY'), 'SUPABASE_*');
    // The glob comes first, so the explicit `FIREBASE_TOKEN` row is documentation rather than the
    // reported reason. Both specs name it, which is why it stays written out.
    assert.equal(isNeverForwardedEnvName('FIREBASE_TOKEN'), '*_TOKEN');
  });

  it('is frozen data, spelled once', () => {
    assert.ok(Object.isFrozen(NEVER_FORWARDED_ENV_PATTERNS));
    assert.equal(new Set(NEVER_FORWARDED_ENV_PATTERNS).size, NEVER_FORWARDED_ENV_PATTERNS.length);
  });
});

describe('findNeverForwardedEnvNames', () => {
  it('returns the names present in a parent environment, sorted', () => {
    assert.deepEqual(findNeverForwardedEnvNames(PARENT.environment), PARENT.expectedRemoved);
  });

  it('leaves everything else, including the OPENCODE_* flags start handles separately', () => {
    const removed = new Set(findNeverForwardedEnvNames(PARENT.environment));
    for (const name of PARENT.expectedKept) assert.ok(!removed.has(name), name);
  });

  it('ignores a name whose value is undefined, because it is not set', () => {
    assert.deepEqual(findNeverForwardedEnvNames({ FIREBASE_TOKEN: undefined, GH_TOKEN: 'x' }), ['GH_TOKEN']);
  });

  it('is empty for an empty environment', () => {
    assert.deepEqual(findNeverForwardedEnvNames({}), []);
  });

  it('returns names only: a value never leaves this function', () => {
    const names = findNeverForwardedEnvNames({ GH_TOKEN: 'a-value-nobody-should-see' });
    assert.deepEqual(names, ['GH_TOKEN']);
    assert.ok(!names.join(' ').includes('nobody'));
  });
});
