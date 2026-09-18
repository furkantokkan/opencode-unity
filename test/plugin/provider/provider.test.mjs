// Provider injection and sampling (spec 8.7 `config` and `chat.params`, D3, P3).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDER_ID, applyProvider, applySampling, buildProviderEntry, getModelId } from '../../../plugin/opencode-unity-lib/provider.js';
import { buildTestProfile } from '../helpers/profile.mjs';

describe('provider entry', () => {
  it('describes the local model the way an OpenAI-compatible provider needs it', () => {
    const profile = buildTestProfile();
    const entry = /** @type {any} */ (buildProviderEntry(profile));
    assert.equal(entry.npm, '@ai-sdk/openai-compatible');
    assert.equal(entry.options.baseURL, profile.provider.baseURL);
    assert.equal(entry.options.apiKey, 'local');
    const model = entry.models[profile.provider.modelTag];
    assert.equal(model.tool_call, true);
    // Config models default temperature support to false, which would drop the preset's sampling.
    assert.equal(model.temperature, true);
    assert.deepEqual(model.limit, { context: profile.provider.limit.context, output: profile.provider.limit.output });
  });

  it('names the model the rendered config asks for', () => {
    const profile = buildTestProfile();
    assert.equal(getModelId(profile), `${PROVIDER_ID}/${profile.provider.modelTag}`);
  });

  it('pins the local provider as the only enabled one', () => {
    const profile = buildTestProfile();
    const config = /** @type {any} */ ({ provider: { anthropic: { models: {} } }, enabled_providers: ['anthropic'] });
    applyProvider(config, profile);
    assert.deepEqual(config.enabled_providers, [PROVIDER_ID]);
    assert.ok(config.provider[PROVIDER_ID]);
    // Another provider may stay in the map; only the enabled list decides what can answer.
    assert.ok(config.provider.anthropic);
  });

  it('works on a config that has no provider map yet', () => {
    const config = /** @type {any} */ ({});
    applyProvider(config, buildTestProfile());
    assert.ok(config.provider[PROVIDER_ID]);
  });
});

describe('sampling', () => {
  it('fills the preset values only where OpenCode left a gap', () => {
    const profile = buildTestProfile();
    const output = /** @type {any} */ ({ temperature: undefined, topP: undefined, maxOutputTokens: undefined });
    applySampling(output, profile);
    assert.equal(output.temperature, profile.provider.sampling.temperature);
    assert.equal(output.topP, profile.provider.sampling.topP);

    const chosen = /** @type {any} */ ({ temperature: 0.9, topP: 0.5, maxOutputTokens: 100 });
    applySampling(chosen, profile);
    assert.equal(chosen.temperature, 0.9);
    assert.equal(chosen.topP, 0.5);
    assert.equal(chosen.maxOutputTokens, 100);
  });

  it('caps the output at the preset limit however the request asked', () => {
    const profile = buildTestProfile();
    const limit = profile.provider.limit.output;
    for (const requested of [limit + 1, 999999, 0, -5, Number.NaN, undefined]) {
      const output = /** @type {any} */ ({ maxOutputTokens: requested });
      assert.equal(applySampling(output, profile).maxOutputTokens, limit, String(requested));
      assert.equal(output.maxOutputTokens, limit);
    }
  });

  it('sends nothing for topK or the repeat penalty, which the Modelfile carries instead', () => {
    const profile = buildTestProfile();
    const output = /** @type {any} */ ({});
    applySampling(output, profile);
    assert.deepEqual(Object.keys(output).sort(), ['maxOutputTokens', 'temperature', 'topP']);
  });
});
