// Provider injection (spec 8.7 `config` hook, D3). The rendered `opencode.jsonc` names a model that
// exists only because this hook adds it, so a plugin that fails to load leaves OpenCode with no model
// at all and the session stops before a request is built. That is the fail-closed design: there is no
// static provider entry to fall back to.
//
// The `config` hook runs before providers are resolved (OC provider/provider.ts L1440-1444), and
// `temperature: true` is required because config models default it to false (L1521), which would drop
// the sampling values the guard and the preset depend on.

export const PROVIDER_ID = 'opencode-unity';

/**
 * @typedef {import('./runtime-profile.js').RuntimeProfile} RuntimeProfile
 */

/**
 * @param {RuntimeProfile} profile
 * @returns {Record<string, unknown>}
 */
export function buildProviderEntry(profile) {
  const { npm, name, baseURL, modelTag, limit } = profile.provider;
  return {
    npm,
    name,
    options: { baseURL, apiKey: 'local' },
    models: {
      [modelTag]: {
        name: modelTag,
        tool_call: true,
        temperature: true,
        limit: { context: limit.context, output: limit.output },
      },
    },
  };
}

/**
 * The model id OpenCode resolves, as `opencode.jsonc` spells it.
 * @param {RuntimeProfile} profile
 * @returns {string}
 */
export function getModelId(profile) {
  return `${PROVIDER_ID}/${profile.provider.modelTag}`;
}

/**
 * Sampling for one request (spec 8.7 `chat.params`). The preset values are filled in only where
 * OpenCode left the field undefined, so an agent that sets its own temperature keeps it. `topK` and
 * the repeat penalty are not sent: the OpenAI-compatible API has no field for them, which is why the
 * Modelfile carries them instead. The output cap is enforced rather than filled, because a request
 * asking for more than `limit.output` would eat the prompt budget the preflight just measured.
 * @param {{ temperature?: number, topP?: number, maxOutputTokens?: number }} output
 * @param {RuntimeProfile} profile
 * @returns {{ temperature: number, topP: number, maxOutputTokens: number }}
 */
export function applySampling(output, profile) {
  const { sampling, limit } = profile.provider;
  if (output.temperature === undefined) output.temperature = sampling.temperature;
  if (output.topP === undefined) output.topP = sampling.topP;
  const requested = output.maxOutputTokens;
  const capped = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, limit.output) : limit.output;
  output.maxOutputTokens = capped;
  return { temperature: /** @type {number} */ (output.temperature), topP: /** @type {number} */ (output.topP), maxOutputTokens: capped };
}

/**
 * Adds the provider to a config object in place and pins it as the only enabled one, so a cloud
 * provider that a merged config or an environment variable brought in cannot answer instead (P3).
 * @param {{ provider?: Record<string, unknown>, enabled_providers?: string[] }} config
 * @param {RuntimeProfile} profile
 * @returns {void}
 */
export function applyProvider(config, profile) {
  const providers = config.provider ?? {};
  providers[profile.provider.id] = buildProviderEntry(profile);
  config.provider = providers;
  config.enabled_providers = [profile.provider.id];
}
