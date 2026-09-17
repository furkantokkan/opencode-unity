import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT } from '../../../src/cli/exit-codes.js';
import { resolveConfig } from '../../../src/core/config.js';
import { loadPreset } from '../../../src/core/presets.js';
import {
  DEFAULT_TOOLS_TOKENS,
  PROVIDER_ID,
  PROVIDER_NPM,
  assertProfileAllowed,
  buildRuntimeProfile,
  listChangedPaths,
  loadCompat,
  renderRuntimeProfile,
  resolveGuardSettings,
  resolvePreset,
} from '../../../src/core/profile.js';
import { validateRuntimeProfile } from '../../../plugin/opencode-unity-lib/runtime-profile.js';
import { catchError } from '../../helpers/catch-error.mjs';

const P1 = 'nvidia-24gb-qwen3-coder-30b-16k';
const P2 = 'nvidia-24gb-qwen3-coder-30b-32k';
const HOME = '/tmp/opencode-unity-home';

/**
 * @param {Record<string, unknown>} [userConfig]
 * @param {string} [presetId]
 */
function build(userConfig = {}, presetId = P1, extra = {}) {
  const document = { schemaVersion: 1, ...userConfig };
  return buildRuntimeProfile({
    config: resolveConfig(document),
    userConfig: document,
    preset: loadPreset(presetId),
    cliVersion: '0.1.0',
    home: HOME,
    kv: { kvType: 'q8_0', source: 'server-log' },
    ...extra,
  });
}

describe('resolvePreset (spec 6.2 overrides)', () => {
  it('leaves a shipped preset untouched when there are no overrides', () => {
    const resolved = resolvePreset(loadPreset(P1));
    assert.equal(resolved.custom, false);
    assert.deepEqual(resolved.overriddenPaths, []);
    assert.equal(resolved.status, 'reference-tested');
  });

  it('marks the profile custom and experimental, and lists the changed paths', () => {
    const resolved = resolvePreset(loadPreset(P1), { model: { numCtx: 8192, tag: 'ocu-qwen3-coder-30b-8k' }, opencode: { limit: { context: 8192 } } });
    assert.equal(resolved.custom, true);
    assert.equal(resolved.status, 'experimental');
    assert.deepEqual(resolved.overriddenPaths, ['model.numCtx', 'model.tag', 'opencode.limit.context']);
    assert.equal(resolved.preset.model.numCtx, 8192);
    assert.equal(resolved.preset.model.numBatch, 256, 'untouched fields keep the preset value');
  });

  it('treats the custom preset as custom even before overrides are complete', () => {
    const error = catchError(() => resolvePreset(loadPreset('custom')));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /overrides\.model\.base/);
    assert.match(error.message, /overrides\.opencode\.limit\.context/);
  });

  it('completes the custom preset from overrides', () => {
    const resolved = resolvePreset(loadPreset('custom'), {
      model: {
        base: 'qwen2.5-coder:14b',
        tag: 'ocu-qwen2.5-coder-14b-16k',
        renderer: 'qwen3-coder',
        parser: 'qwen3-coder',
        numCtx: 16_384,
        downloadGiB: 9,
        sampling: { temperature: 0.2, topP: 0.8, topK: 20, repeatPenalty: 1.05 },
        vram: { weightsMiB: 9000, computeMiB: 90, kvMiBPerTokenF16: 0.05 },
      },
      opencode: { limit: { context: 16_384, output: 4096 } },
    });
    assert.equal(resolved.custom, true);
    assert.equal(resolved.preset.model.base, 'qwen2.5-coder:14b');
  });

  it('rejects overrides that break the preset schema', () => {
    const error = catchError(() => resolvePreset(loadPreset(P1), { model: { numCtx: 'big' } }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(error.code, 'config_invalid');
    assert.match(error.message, /model\.numCtx/);
  });

  it('rejects a context limit larger than num_ctx, which Ollama would truncate', () => {
    const error = catchError(() => resolvePreset(loadPreset(P1), { opencode: { limit: { context: 32_768 } } }));
    assert.match(error.message, /larger than model\.numCtx/);
    assert.match(catchError(() => resolvePreset(loadPreset(P1), { opencode: { limit: { output: 16_384 } } })).message, /must be smaller/);
  });

  it('refuses Modelfile changes that keep the preset tag (spec 22)', () => {
    const error = catchError(() => resolvePreset(loadPreset(P1), { model: { numCtx: 8192 }, opencode: { limit: { context: 8192 } } }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /keep the preset tag/);
    assert.match(error.hint, /ocu-qwen3-coder-30b-16k-r2/);
    // Overriding only a limit does not touch the Modelfile, so the tag may stay.
    assert.equal(resolvePreset(loadPreset(P1), { opencode: { limit: { output: 2048 } } }).overriddenPaths.length, 1);
  });
});

describe('resolveGuardSettings', () => {
  it('lets a stricter preset guard replace the config value and says so', () => {
    const config = resolveConfig({ schemaVersion: 1, guard: { maxUnityEditors: 3 } });
    const { settings, warnings } = resolveGuardSettings(config.guard, { maxUnityEditors: 1, minFreeVramAfterLoadMiB: 2500 }, { maxUnityEditors: 3 });
    assert.equal(settings.maxUnityEditors, 1);
    assert.equal(settings.minFreeVramAfterLoadMiB, 2500);
    assert.equal(settings.probeTimeoutSec, 10, 'keys the preset does not set keep the config value');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /guard\.maxUnityEditors/);
    assert.match(warnings[0], /overrides\.guard\.maxUnityEditors/);
  });

  it('stays quiet when the config never set the key', () => {
    const config = resolveConfig({ schemaVersion: 1 });
    assert.deepEqual(resolveGuardSettings(config.guard, { maxUnityEditors: 1 }, {}).warnings, []);
  });
});

describe('buildRuntimeProfile (spec 6.3)', () => {
  it('builds the reference profile with the measured VRAM estimate', () => {
    const { profile, vram, warnings } = build();
    assert.deepEqual(validateRuntimeProfile(profile), []);
    assert.equal(profile.presetId, P1);
    assert.equal(profile.presetStatus, 'reference-tested');
    assert.equal(profile.custom, false);
    assert.deepEqual(profile.provider, {
      id: PROVIDER_ID,
      npm: PROVIDER_NPM,
      name: 'Local model (opencode-unity)',
      baseURL: 'http://127.0.0.1:11434/v1',
      modelTag: 'ocu-qwen3-coder-30b-16k',
      numCtx: 16_384,
      limit: { context: 16_384, output: 4096 },
      sampling: { temperature: 0.7, topP: 0.8, topK: 20, repeatPenalty: 1.05 },
      numKeep: 4,
      keepAlive: '15m',
    });
    assert.equal(profile.guard.modelVramMiB, 19_000);
    assert.equal(profile.guard.kvType, 'q8_0');
    assert.equal(profile.guard.kvTypeSource, 'server-log');
    assert.equal(vram.kvMiB, 816);
    assert.equal(profile.budget.promptBudget, 11_776);
    assert.deepEqual(profile.budget.toolsTokens, { ...DEFAULT_TOOLS_TOKENS });
    assert.equal(profile.budget.toolsTokensSource, 'default-allowance');
    assert.equal(profile.home, HOME);
    assert.deepEqual(profile.compat, { opencode: loadCompat().opencode.tested, ollama: loadCompat().ollama.tested });
    assert.deepEqual(warnings, []);
  });

  it('carries the safety and budget settings the plugin needs', () => {
    const { profile } = build({ safety: { bashMode: 'ask', readLimitLines: 120 }, budget: { reserveTokens: 1024 } });
    assert.equal(profile.safety.bashMode, 'ask');
    assert.equal(profile.safety.readLimitLines, 120);
    assert.equal(profile.budget.reserveTokens, 1024);
    assert.equal(profile.budget.promptBudget, 16_384 - 4096 - 1024);
    assert.deepEqual(profile.budget.calibrationClamp, [0.7, 1.4]);
  });

  it('takes the measured tool sizes from a capture when one exists (spec 8.8)', () => {
    const { profile } = build({}, P1, { toolsTokens: { values: { 'unity-code': 3318, 'unity-editor': 6800 }, source: 'capture:2026-09-17T11-40-00' } });
    assert.deepEqual(profile.budget.toolsTokens, { 'unity-code': 3318, 'unity-editor': 6800 });
    assert.equal(profile.budget.toolsTokensSource, 'capture:2026-09-17T11-40-00');
  });

  it('applies the 32K preset guard and warns about an unknown KV type', () => {
    const { profile, warnings } = build({ preset: P2 }, P2, { kv: { kvType: 'f16', source: 'default' } });
    assert.equal(profile.provider.numCtx, 32_768);
    assert.equal(profile.guard.minFreeVramAfterLoadMiB, 2500);
    assert.equal(profile.guard.maxUnityEditors, 1);
    // f16 at 32K is the conservative estimate: 17,524 + 3,072 + 116 = 20,712 -> 21,000 + 500 margin.
    assert.equal(profile.guard.modelVramMiB, 21_500);
    assert.ok(warnings.some((warning) => /assumes f16/.test(warning)));
  });

  it('marks an overridden profile custom and experimental, and warns', () => {
    const { profile, warnings } = build({ overrides: { model: { numCtx: 8192, tag: 'ocu-qwen3-coder-30b-8k' }, opencode: { limit: { context: 8192 } } } });
    assert.equal(profile.custom, true);
    assert.equal(profile.presetStatus, 'experimental');
    assert.deepEqual(profile.overriddenPaths, ['model.numCtx', 'model.tag', 'opencode.limit.context']);
    assert.equal(profile.provider.modelTag, 'ocu-qwen3-coder-30b-8k');
    assert.equal(profile.budget.promptBudget, 8192 - 4096 - 512);
    assert.ok(warnings.some((warning) => /custom \(experimental\)/.test(warning)));
  });

  it('keeps the Ollama base URL and the provider URL in step', () => {
    const { profile } = build({ ollama: { baseUrl: 'http://localhost:11500/' } });
    assert.equal(profile.ollama.baseUrl, 'http://localhost:11500');
    assert.equal(profile.provider.baseURL, 'http://localhost:11500/v1');
  });

  it('refuses a reserve that leaves no prompt budget', () => {
    const error = catchError(() => build({ budget: { reserveTokens: 20_000 } }));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /prompt budget/);
  });

  it('needs an absolute home', () => {
    assert.throws(() => buildRuntimeProfile({ config: resolveConfig({ schemaVersion: 1 }), preset: loadPreset(P1), cliVersion: '0.1.0', home: 'relative/home' }), /absolute/);
  });

  it('renders JSON the plugin can read back', () => {
    const { profile } = build();
    const text = renderRuntimeProfile(profile);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual(validateRuntimeProfile(JSON.parse(text)), []);
  });
});

describe('assertProfileAllowed', () => {
  it('needs --experimental for a custom profile', () => {
    const { profile } = build({ overrides: { model: { numCtx: 8192, tag: 'ocu-qwen3-coder-30b-8k' }, opencode: { limit: { context: 8192 } } } });
    const error = catchError(() => assertProfileAllowed(profile));
    assert.equal(error.exitCode, EXIT.UNSUPPORTED);
    assertProfileAllowed(profile, { experimental: true });
  });

  it('lets the reference profile run without a flag', () => {
    assertProfileAllowed(build().profile);
  });
});

describe('listChangedPaths', () => {
  it('reports the leaf paths whose values differ', () => {
    assert.deepEqual(listChangedPaths({ a: 1, b: { c: 2, d: [1] } }, { a: 1, b: { c: 3, d: [1] } }), ['b.c']);
    assert.deepEqual(listChangedPaths({ a: [1] }, { a: [1, 2] }), ['a']);
    // A whole new subtree is reported at its root, because there is nothing to compare inside it.
    assert.deepEqual(listChangedPaths({}, { a: { b: 1 } }), ['a']);
    assert.deepEqual(listChangedPaths({ a: 1 }, { a: 1 }), []);
  });
});
