// `shapeRequest()`: the one entry point every surface of prompt shaping calls (amendment 36, D-SH5).
//
// A pure function from (request text, project facts) to (request text, note), with at most one bounded
// model call in the middle. Nothing is stored: no request text, no task file, no lifecycle.
//
//   gates (G-a..G-d) -> readiness (R1 verb, R2 anchor) -> ready: the original text, no model call
//                                                      -> needs shaping: one rewrite, validated, rendered
//
// Every failure falls through (S-SH1): the developer's original text comes back byte for byte with one
// line saying why, and the caller carries on. The only hard stop is an empty request (exit 1); a Ctrl+C
// during the model call still ends the command (exit 130).
import { findProtectedEditGlob } from '../delegate/protected-files.js';
import { buildAnchorIndex, buildCandidates, createAnchorLookup, grepIndex, resolveAnchors } from './anchors.js';
import { describeDeniedIntent } from './intent-deny.js';
import { SHAPED_FORM_MAX_CHARS, renderKeepClauses, renderShapedRequest } from './render.js';
import { buildShapeMessages, requestRewrite } from './rewrite.js';
import { validateShapedOutput } from './validate.js';
import { MAX_OUTCOMES_WITHOUT_NOTE, assertShapeableText, checkGates, evaluateReadiness } from './verdict.js';

export { SHAPE_DEFAULTS, resolveShapeSettings } from './verdict.js';

/**
 * @typedef {'ready' | 'shaped' | 'passthrough'} ShapeStatus
 * @typedef {'too_long' | 'denied_intent' | 'disabled' | 'no_model' | 'guard_blocked' | 'lock_timeout'
 *   | 'model_unavailable' | 'timeout' | 'budget' | 'invalid_output'} PassthroughReason
 */

/**
 * The project side of shaping. `index` is optional so a caller holding a cached index (keyed by the
 * facts' `inputsHash`) can pass it in; without one the walk runs, and only when a gate has not already
 * decided.
 * @typedef {object} ShapeProject
 * @property {import('../unity/fs-view.js').FsView} view
 * @property {string} root                        Absolute workspace root.
 * @property {readonly string[]} componentDirs    Workspace-relative component folders.
 * @property {import('./anchors.js').AnchorIndex} [index]
 * @property {readonly import('./anchors.js').FolderAnchorSource[]} [folders]  Assemblies and compile-map prefixes.
 * @property {boolean} [caseInsensitive]
 * @property {import('./render.js').KeepFacts} keep
 * @property {readonly string[]} [extraProtectedEditGlobs]
 */

/**
 * @typedef {object} ShapeInput
 * @property {string} text                        The developer's request, exactly as given.
 * @property {import('./verdict.js').ShapeSettings} settings
 * @property {ShapeProject} project
 * @property {boolean} [noModel]                  Readiness only; the model is never called.
 * @property {import('../../plugin/opencode-unity-lib/runtime-profile.js').RuntimeProfile} [profile]  Needed for a model call.
 * @property {import('../core/lock.js').GpuLock} [lock]
 * @property {string} [lockPath]
 * @property {number} [lockWaitSec]
 * @property {(cleanup: () => string | void) => () => void} [addCleanup]
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {typeof fetch} [fetch]
 * @property {AbortSignal} [signal]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} ShapeResult
 * @property {ShapeStatus} status
 * @property {'ready' | 'needs_shaping' | null} verdict   Null when a gate decided before readiness ran.
 * @property {PassthroughReason | null} reason
 * @property {string | null} rule                          The deny rule, for `denied_intent`.
 * @property {string} request                              The text to use from here on.
 * @property {(import('./validate.js').ShapedFields & { keep: string }) | null} fields
 * @property {string[]} unresolved
 * @property {string | null} note
 * @property {boolean} modelCall
 * @property {number} durationMs
 * @property {number | null} promptTokensActual
 * @property {number | null} outputTokens
 * @property {boolean} indexTruncated
 */

/**
 * @param {ShapeInput} input
 * @returns {Promise<ShapeResult>}
 */
export async function shapeRequest(input) {
  const { text, settings, project } = input;
  const now = input.now ?? Date.now;
  const startedMs = now();
  assertShapeableText(text);
  const elapsed = () => Math.max(0, now() - startedMs);

  const gates = checkGates(text, settings);
  if (gates.outcome === 'passthrough') {
    const reason = /** @type {PassthroughReason} */ (gates.reason);
    const note = gates.denied ? `shaping skipped: ${describeDeniedIntent(gates.denied)}; the request goes on unchanged` : describePassthrough(reason, settings);
    return passthrough(text, { reason, verdict: null, note, rule: gates.denied?.rule ?? null, durationMs: elapsed() });
  }

  const readiness = evaluateReadiness(text);
  const index = project.index ?? buildAnchorIndex(project.view, project.root, { componentDirs: project.componentDirs });
  const lookup = createAnchorLookup(index, { caseInsensitive: project.caseInsensitive ?? false, folders: project.folders ?? [] });
  /** @param {string[]} literals @param {number} [maxHits] */
  const grep = (literals, maxHits) => grepIndex(project.view, project.root, index, literals, { timeoutMs: settings.grepTimeoutMs, maxHits, now });
  const always = settings.mode === 'always';
  // Rule 5 reads files, so it runs only when its answer can still avoid a model call: an action verb is
  // present and the mode is not `always`.
  const useGrep = !always && readiness.hasVerb;
  const resolution = resolveAnchors(readiness.tokens, lookup, { grep: useGrep ? (literals) => grep(literals) : null });
  const unresolved = resolution.unresolved;
  const base = { unresolved, indexTruncated: index.truncated };

  if (!always && readiness.hasVerb && resolution.anchors.length > 0) {
    return { ...emptyResult(text), status: 'ready', verdict: 'ready', ...base, durationMs: elapsed() };
  }
  if (input.noModel) {
    const note = 'readiness check only (--no-model): the request needs shaping, and the original text is returned';
    return { ...passthrough(text, { reason: 'no_model', verdict: 'needs_shaping', note, rule: null, durationMs: elapsed() }), ...base };
  }
  if (!input.profile) throw new TypeError('shapeRequest needs the runtime profile to call the model');

  const extraGlobs = project.extraProtectedEditGlobs ?? [];
  const candidates = buildCandidates(lookup, resolution, {
    perToken: settings.anchorCandidates,
    isProtected: (path) => findProtectedEditGlob(path, extraGlobs) !== null,
  });
  const call = await requestRewrite({
    profile: input.profile,
    messages: buildShapeMessages({ request: text, candidates, unresolved }),
    settings,
    lock: input.lock,
    lockPath: input.lockPath,
    lockWaitSec: input.lockWaitSec,
    addCleanup: input.addCleanup,
    probes: input.probes,
    fetch: input.fetch,
    signal: input.signal,
  });
  if (!call.ok) {
    const note = `shaping skipped: ${call.detail}; the request goes on unchanged`;
    return { ...passthrough(text, { reason: call.reason, verdict: 'needs_shaping', note, rule: null, durationMs: elapsed() }), ...base, modelCall: true };
  }
  const tokens = { modelCall: true, promptTokensActual: call.promptTokens, outputTokens: call.outputTokens };

  const validated = validateShapedOutput(call.content, {
    request: text,
    isIndexMember: (path) => lookup.members.has(path),
    findLiteral: (literal) => {
      const result = grep([literal], 0);
      return !result.timedOut && (result.hits.get(literal) ?? 0) > 0;
    },
    findProtectedGlob: (path) => findProtectedEditGlob(path, extraGlobs),
  });
  if (!validated.ok) {
    const note = validated.denied
      ? `shaping skipped: ${describeDeniedIntent(validated.denied)}; the rewrite was discarded and the request goes on unchanged`
      : `shaping skipped: the rewrite was not usable (${validated.detail}); the request goes on unchanged`;
    return {
      ...passthrough(text, { reason: validated.reason, verdict: 'needs_shaping', note, rule: validated.denied?.rule ?? null, durationMs: elapsed() }),
      ...base,
      ...tokens,
    };
  }

  const rendered = renderShapedRequest(validated.fields, renderKeepClauses(project.keep));
  return {
    ...emptyResult(rendered.text),
    status: 'shaped',
    verdict: 'needs_shaping',
    fields: rendered.fields,
    note: describeShaped({ unresolved, outcomes: readiness.outcomes, dropped: rendered.dropped }),
    ...base,
    ...tokens,
    durationMs: elapsed(),
  };
}

/**
 * The session-log row of P16: counters and verdict ids only - never the request text, a file name or a
 * candidate path.
 * @param {ShapeResult} result
 * @returns {{ kind: 'shape', verdict: string | null, status: ShapeStatus, reason: string | null, modelCall: boolean, durationMs: number, promptTokens: number | null, outputTokens: number | null }}
 */
export function toShapeLogRow(result) {
  return {
    kind: 'shape',
    verdict: result.verdict,
    status: result.status,
    reason: result.reason,
    modelCall: result.modelCall,
    durationMs: result.durationMs,
    promptTokens: result.promptTokensActual,
    outputTokens: result.outputTokens,
  };
}

/**
 * @param {string} request
 * @returns {ShapeResult}
 */
function emptyResult(request) {
  return {
    status: 'ready',
    verdict: null,
    reason: null,
    rule: null,
    request,
    fields: null,
    unresolved: [],
    note: null,
    modelCall: false,
    durationMs: 0,
    promptTokensActual: null,
    outputTokens: null,
    indexTruncated: false,
  };
}

/**
 * The original text, untouched: not trimmed, not normalised, not re-encoded.
 * @param {string} text
 * @param {{ reason: PassthroughReason, verdict: 'needs_shaping' | null, note: string | null, rule: string | null, durationMs: number }} details
 * @returns {ShapeResult}
 */
function passthrough(text, { reason, verdict, note, rule, durationMs }) {
  return { ...emptyResult(text), status: 'passthrough', verdict, reason, note, rule, durationMs };
}

/**
 * @param {PassthroughReason} reason
 * @param {import('./verdict.js').ShapeSettings} settings
 * @returns {string | null}
 */
function describePassthrough(reason, settings) {
  if (reason === 'too_long') return `shaping skipped: the request is longer than ${settings.maxInputChars} characters and already carries its own detail`;
  return null;
}

/**
 * One line for a shaped request, or null when there is nothing to say.
 * @param {{ unresolved: readonly string[], outcomes: number, dropped: readonly string[] }} input
 * @returns {string | null}
 */
function describeShaped({ unresolved, outcomes, dropped }) {
  /** @type {string[]} */
  const parts = [];
  if (unresolved.length > 0) parts.push(`not found in this project: ${unresolved.join(', ')}`);
  if (outcomes > MAX_OUTCOMES_WITHOUT_NOTE) parts.push(`${outcomes} separate asks were kept as one request; sending them one at a time works better`);
  if (dropped.length > 0) parts.push(`shortened to fit ${SHAPED_FORM_MAX_CHARS} characters (dropped: ${[...new Set(dropped)].join(', ')})`);
  return parts.length > 0 ? parts.join('; ') : null;
}
