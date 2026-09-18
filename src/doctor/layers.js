// The configuration layers the checks judge.
//
// Without `--deep` these are the files OpenCode would read. With `--deep` the merged answer from
// `opencode debug config` is appended as one more layer, because a merged configuration can re-allow
// something no single file shows (spec 8.2), and a check that only ever saw the files would miss it.

/** @typedef {import('./opencode-config.js').ConfigLayer} ConfigLayer */
/** @typedef {import('./context.js').DoctorContext} DoctorContext */

export const DEEP_LAYER_PATH = 'opencode debug config';

/**
 * @param {DoctorContext} context
 * @returns {ConfigLayer[]}
 */
export function effectiveLayers(context) {
  const merged = context.opencode.deep?.config.value ?? null;
  const layers = [...context.opencode.config.layers];
  if (merged !== null) layers.push({ path: DEEP_LAYER_PATH, origin: 'deep', value: merged, error: null });
  return layers;
}

/**
 * True when the report has a merged configuration rather than only the files.
 * @param {DoctorContext} context
 * @returns {boolean}
 */
export function hasMergedConfig(context) {
  return context.opencode.deep?.config.value != null;
}

/**
 * A short, stable label for a layer path in a message.
 * @param {ConfigLayer} layer
 * @returns {string}
 */
export function layerLabel(layer) {
  return layer.origin === 'deep' ? DEEP_LAYER_PATH : layer.path;
}
