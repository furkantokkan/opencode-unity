// One detector, not two (amendment 38.9). The delegate lane and the network lane answer the same
// question, and the only way they can keep answering it the same way is to be the same code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as pluginSensitive from '../../../plugin/opencode-unity-lib/net/sensitive.js';
import * as networkSensitive from '../../../src/network/sensitive.js';

const DELEGATE_MODULE_URL = new URL('../../../src/delegate/sensitive.js', import.meta.url);

/**
 * S32 left the delegate lane's own copy in place and asked the integrator to repoint its importers at
 * the shared module. Until that lands there are two files, and these assertions are what says they
 * still agree; once it lands there is one file and there is nothing left to compare.
 * @returns {Promise<any | null>}
 */
async function loadDelegateCopy() {
  if (!fs.existsSync(fileURLToPath(DELEGATE_MODULE_URL))) return null;
  return import(DELEGATE_MODULE_URL.href);
}

describe('the CLI module is the plugin module', () => {
  it('re-exports the same bindings rather than a second copy', () => {
    for (const name of Object.keys(networkSensitive)) {
      assert.equal(
        networkSensitive[name],
        pluginSensitive[name],
        `src/network/sensitive.js must re-export ${name}, not redefine it`,
      );
    }
  });

  it('re-exports everything the plugin module offers, so no caller has to reach past it', () => {
    assert.deepEqual(Object.keys(networkSensitive).sort(), Object.keys(pluginSensitive).sort());
  });
});

describe('the delegate lane and the network lane cannot diverge', () => {
  it('shares one secret-path pattern list', async () => {
    const delegateSensitive = await loadDelegateCopy();
    if (!delegateSensitive) return;
    assert.deepEqual(
      [...delegateSensitive.DEFAULT_SENSITIVE_PATTERNS],
      [...networkSensitive.DEFAULT_SENSITIVE_PATTERNS],
      'the pattern list belongs to plugin/opencode-unity-lib/net/sensitive.js; import it there',
    );
  });

  it('gives both lanes the same verdict for the same path', async () => {
    const delegateSensitive = await loadDelegateCopy();
    if (!delegateSensitive) return;
    const options = { platform: /** @type {NodeJS.Platform} */ ('linux'), realPath: () => null };
    const delegateMatcher = delegateSensitive.createSensitiveMatcher(options);
    const networkMatcher = networkSensitive.createSensitiveMatcher(options);
    for (const file of ['/w/.env', '/w/Assets/Scripts/Player.cs', '/w/ci/app-service-account.json', '/w/README.md']) {
      assert.equal(delegateMatcher.find(file, '/w'), networkMatcher.find(file, '/w'), file);
    }
  });
});
