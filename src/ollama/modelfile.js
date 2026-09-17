// Modelfile rendering and post-create verification (spec 10.3). The Modelfile has no SYSTEM line: Ollama
// prepends it only when the first message is not a system message (OL server/routes.go L2651-2654), and
// OpenCode always sends one. Renderer and parser are explicit because the qwen3-coder renderer keeps only
// the first system message and its parser enters tool mode only on a literal <tool_call>.
import fs from 'node:fs';

export const MODELFILE_TEMPLATE_URL = new URL('../../templates/ollama/Modelfile.tpl', import.meta.url);
export const MODEL_TAG_PREFIX = 'ocu-';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
// One Modelfile token: no whitespace, quotes or line breaks, so a value can never add a directive.
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const FLOAT_TOLERANCE = 1e-6;

/**
 * @typedef {object} ModelfileModel
 * @property {string} base
 * @property {string} renderer
 * @property {string} parser
 * @property {number} numCtx
 * @property {number} numBatch
 * @property {{ temperature: number, topP: number, topK: number, repeatPenalty: number }} sampling
 */

/**
 * @param {{ template?: string }} [options]
 * @returns {string}
 */
export function readModelfileTemplate({ template } = {}) {
  return template ?? fs.readFileSync(MODELFILE_TEMPLATE_URL, 'utf8');
}

/**
 * The values each template placeholder takes. Throws on a missing or unsafe value.
 * @param {ModelfileModel} model  A resolved preset model (no null fields).
 * @returns {Record<string, string>}
 */
export function getModelfileValues(model) {
  const sampling = model?.sampling ?? /** @type {any} */ ({});
  return {
    base: toWord(model?.base, 'model.base'),
    renderer: toWord(model?.renderer, 'model.renderer'),
    parser: toWord(model?.parser, 'model.parser'),
    numCtx: toInteger(model?.numCtx, 'model.numCtx', 1),
    numBatch: toInteger(model?.numBatch, 'model.numBatch', 1),
    temperature: toNumber(sampling.temperature, 'model.sampling.temperature'),
    topP: toNumber(sampling.topP, 'model.sampling.topP'),
    topK: toInteger(sampling.topK, 'model.sampling.topK', 0),
    repeatPenalty: toNumber(sampling.repeatPenalty, 'model.sampling.repeatPenalty'),
  };
}

/**
 * @param {ModelfileModel} model
 * @param {{ template?: string }} [options]
 * @returns {string}
 */
export function renderModelfile(model, options = {}) {
  const template = readModelfileTemplate(options);
  const values = getModelfileValues(model);
  const rendered = template.replace(PLACEHOLDER, (_match, name) => {
    if (!Object.hasOwn(values, name)) throw new TypeError(`Modelfile template has an unknown placeholder {{${name}}}`);
    return values[name];
  });
  if (/^\s*SYSTEM\b/im.test(rendered)) throw new TypeError('The Modelfile must not contain a SYSTEM line');
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

/**
 * @typedef {object} ModelMismatch
 * @property {string} id        Parameter or field name, for example `num_ctx` or `renderer`.
 * @property {string} expected
 * @property {string} actual
 */

/**
 * Checks `/api/show` after `ollama create` against the model that was rendered: num_ctx, num_batch and
 * sampling parameters, renderer, parser, and no SYSTEM text (spec 10.3).
 * @param {import('./client.js').ShowResult} show
 * @param {ModelfileModel} model
 * @returns {ModelMismatch[]}  Empty when the created model matches.
 */
export function verifyCreatedModel(show, model) {
  /** @type {ModelMismatch[]} */
  const mismatches = [];
  const expectedParameters = {
    num_ctx: model.numCtx,
    num_batch: model.numBatch,
    temperature: model.sampling.temperature,
    top_p: model.sampling.topP,
    top_k: model.sampling.topK,
    repeat_penalty: model.sampling.repeatPenalty,
  };
  for (const [name, expected] of Object.entries(expectedParameters)) {
    const values = show.parameters[name] ?? [];
    const actual = values.length === 1 ? values[0] : undefined;
    if (typeof actual !== 'number' || Math.abs(actual - expected) > FLOAT_TOLERANCE) {
      mismatches.push({ id: name, expected: String(expected), actual: values.length === 0 ? '(missing)' : values.map(String).join(', ') });
    }
  }
  for (const field of /** @type {const} */ (['renderer', 'parser'])) {
    if (show[field] !== model[field]) mismatches.push({ id: field, expected: model[field], actual: show[field] || '(missing)' });
  }
  if (show.system.trim() !== '') mismatches.push({ id: 'system', expected: '(none)', actual: `${show.system.length} characters` });
  return mismatches;
}

/**
 * `ocu-<model-slug>-<ctx>k`, for example `ocu-qwen3-coder-30b-16k` (spec 22). A context that is not a
 * multiple of 1024 is written in full. `revision` 2 and up appends `-r<n>`.
 * @param {{ base: string, numCtx: number, revision?: number }} input
 * @returns {string}
 */
export function buildModelTag({ base, numCtx, revision = 1 }) {
  const lastSegment = toWord(base, 'base').split('/').pop() ?? '';
  const slug = lastSegment.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (slug === '') throw new TypeError(`Cannot build a tag from base '${base}'`);
  const context = toInteger(numCtx, 'numCtx', 1);
  const ctx = Number(context) % 1024 === 0 ? `${Number(context) / 1024}k` : context;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError(`revision must be a positive integer, got ${revision}`);
  return `${MODEL_TAG_PREFIX}${slug}-${ctx}${revision > 1 ? `-r${revision}` : ''}`;
}

/**
 * The tag to use after a Modelfile parameter changed: `-r2`, or the next revision number.
 * @param {string} tag
 * @returns {string}
 */
export function getNextRevisionTag(tag) {
  const match = /^(.*)-r(\d+)$/.exec(tag);
  return match ? `${match[1]}-r${Number(match[2]) + 1}` : `${tag}-r2`;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function toWord(value, name) {
  if (typeof value !== 'string' || !SAFE_WORD.test(value)) throw new TypeError(`${name} must be a single word without spaces or quotes, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} minimum
 * @returns {string}
 */
function toInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < minimum) throw new TypeError(`${name} must be an integer >= ${minimum}, got ${JSON.stringify(value)}`);
  return String(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function toNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number, got ${JSON.stringify(value)}`);
  return String(value);
}
