// OpenCode configuration checks (spec 5.4, evidence E3 and E7).
//
// These three are the measured reasons a local model silently behaves worse than it should: a model
// entry without `limit`, a `limit.context` larger than what the server will actually hold, and a model
// entry that does not declare the temperature capability, after which the sampler runs at its defaults.
import { compareVersions } from '../../ollama/client.js';
import { error, pass, quantity, skip, warn } from '../finding.js';
import { effectiveLayers, layerLabel } from '../layers.js';
import { listModelEntries } from '../opencode-config.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** @type {readonly CheckSpec[]} */
export const OPENCODE_CHECKS = Object.freeze([
  {
    id: 'opencode.version',
    group: 'opencode',
    title: 'OpenCode version tested',
    severities: ['warn'],
    why: 'The permission rules, the tool list and the plugin hooks were read from one OpenCode version; another one can move any of them without an error.',
    fix: 'Install the tested OpenCode version, or run opencode-unity doctor --selftest for the version you have.',
    source: 'compat.json and spec D21',
    run: (context) => {
      const { binary, testedVersion } = context.opencode;
      if (binary.version === null) {
        return warn(`the OpenCode version could not be read: ${binary.error ?? 'unknown reason'}`, {
          data: { path: binary.path, testedVersion },
        });
      }
      if (binary.version === testedVersion) return pass(`OpenCode ${binary.version} is the tested version`);
      const direction = compareVersions(binary.version, testedVersion) > 0 ? 'newer than' : 'older than';
      return warn(`OpenCode ${binary.version} is ${direction} the tested ${testedVersion}`, {
        data: { version: binary.version, testedVersion, path: binary.path },
      });
    },
  },
  {
    id: 'opencode.no-limit',
    group: 'opencode',
    title: 'Model entries declare a limit',
    severities: ['error'],
    why: 'A model entry without a limit leaves OpenCode with no context size to plan against, so it never compacts and the server truncates the prompt instead.',
    fix: 'Add "limit": { "context": <num_ctx>, "output": <max tokens> } to the model entry.',
    source: 'spec 8.3 and evidence E7',
    run: (context) => {
      const entries = listModelEntries(effectiveLayers(context));
      if (entries.length === 0) return skip('no OpenCode model entry was found');
      const missing = entries.filter((entry) => !isRecord(entry.value.limit));
      if (missing.length === 0) return pass(`every model entry declares a limit (${quantity(entries.length, 'entry', 'entries')})`);
      return error(`${quantity(missing.length, 'OpenCode model entry', 'OpenCode model entries')} without a limit`, {
        details: missing.map((entry) => `${entry.providerId}/${entry.modelId} in ${entry.layerPath}`),
        data: { entries: missing.map(describe) },
      });
    },
  },
  {
    id: 'opencode.limit-exceeds-numctx',
    group: 'opencode',
    title: 'limit.context fits the model context',
    severities: ['error'],
    why: 'When the declared context is larger than the model actually holds, the prompt is cut on the server and the agent loses the part it needed most.',
    fix: 'Lower limit.context to the model num_ctx, or recreate the model tag with a larger num_ctx.',
    source: 'spec 8.8 and evidence E1',
    run: (context) => {
      const numCtx = readNumCtx(context);
      if (numCtx === null) return skip('the model context size is unknown');
      const entries = listModelEntries(effectiveLayers(context)).filter((entry) => isRecord(entry.value.limit));
      const over = entries.filter((entry) => Number(entry.value.limit.context) > numCtx);
      if (entries.length === 0) return skip('no OpenCode model entry declares a limit');
      if (over.length === 0) return pass(`every declared limit.context fits ${numCtx}`);
      return error(`${quantity(over.length, 'model entry', 'model entries')} declaring a context larger than the model's ${numCtx}`, {
        details: over.map((entry) => `${entry.providerId}/${entry.modelId}: limit.context ${entry.value.limit.context} in ${entry.layerPath}`),
        data: { numCtx, entries: over.map(describe) },
      });
    },
  },
  {
    id: 'opencode.temperature-capability',
    group: 'opencode',
    title: 'Model entries declare the temperature capability',
    severities: ['error'],
    why: 'Without the capability the sampling settings are dropped and the request runs at the provider defaults, which is the loosest setting there is.',
    fix: 'Add "temperature": true to the model entry.',
    source: 'spec 8.3 and evidence E3',
    run: (context) => {
      const entries = listModelEntries(effectiveLayers(context));
      if (entries.length === 0) return skip('no OpenCode model entry was found');
      const missing = entries.filter((entry) => entry.value.temperature !== true);
      if (missing.length === 0) return pass(`every model entry declares the temperature capability (${quantity(entries.length, 'entry', 'entries')})`);
      return error(`${quantity(missing.length, 'OpenCode model entry', 'OpenCode model entries')} without "temperature": true`, {
        details: missing.map((entry) => `${entry.providerId}/${entry.modelId} in ${entry.layerPath}`),
        data: { entries: missing.map(describe) },
      });
    },
  },
  {
    id: 'opencode.config-unreadable',
    group: 'opencode',
    title: 'OpenCode config files parse',
    severities: ['warn'],
    why: 'OpenCode skips a configuration file it cannot parse, so a file meant to deny something silently denies nothing.',
    fix: 'Fix the reported file, or move it aside.',
    source: 'spec 8.2',
    run: (context) => {
      const layers = context.opencode.config.layers;
      const broken = layers.filter((layer) => layer.error !== null);
      if (layers.length === 0) return skip('no OpenCode config file was found');
      if (broken.length === 0) return pass(`${quantity(layers.length, 'OpenCode config file')} parsed`);
      return warn(`OpenCode skips ${quantity(broken.length, 'config file')} that did not parse`, {
        details: broken.map((layer) => `${layerLabel(layer)}: ${layer.error}`),
        data: { files: broken.map((layer) => layer.path) },
      });
    },
  },
]);

/**
 * The context size the server will actually hold: what `/api/show` reports, else what the profile asks
 * the Modelfile for.
 * @param {import('../context.js').DoctorContext} context
 * @returns {number | null}
 */
function readNumCtx(context) {
  const reported = context.ollama.show?.parameters.num_ctx?.at(-1);
  const value = reported === undefined ? context.profileInfo.runtime?.provider.numCtx : Number(reported);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {import('../opencode-config.js').ModelEntry} entry
 * @returns {{ provider: string, model: string, file: string }}
 */
function describe(entry) {
  return { provider: entry.providerId, model: entry.modelId, file: entry.layerPath };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
