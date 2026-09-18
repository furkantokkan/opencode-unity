// Job folders, review records and the envelope payload of the delegate lane (spec 12.4, amendment
// D-M7: the object sketched in SPEC 12.4 is the `data` payload of the SPEC 5.3 envelope).
//
// Every job writes its full output under `<home>/state/delegate/results/<jobId>/`, and the envelope
// carries only a capped summary: an orchestrator pays for every character it reads back.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXIT } from '../cli/exit-codes.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { pathKey } from './files.js';
import { takeTail, truncateText } from './prompts.js';

// Spec 12.4: `summary` is at most 4,000 characters.
export const SUMMARY_LIMIT = 4000;

/** Statuses whose output an orchestrator can use; only those count as saved work in the ledger. */
export const USABLE_STATUSES = Object.freeze(['ok', 'partial', 'dry_run', 'applied', 'check_failed_kept']);

/**
 * What an orchestrator should do next (amendment 36.6). Only these three values exist.
 * @type {Readonly<Record<string, 'do_it_yourself' | 'retry_later' | 'split_with_map'>>}
 */
const ORCHESTRATOR_ACTIONS = Object.freeze({
  // A blocked guard reports `gpu_guard_blocked` and carries the deciding reason in `data.guard.reason`
  // (spec 5.3, amendment 36.6). The reason ids stay here too, so a caller that branches on the reason
  // rather than on the code resolves to the same action.
  gpu_busy: 'do_it_yourself',
  vram_low: 'do_it_yourself',
  import_busy: 'do_it_yourself',
  too_many_editors: 'do_it_yourself',
  probe_failed: 'do_it_yourself',
  remote_unguarded: 'do_it_yourself',
  gpu_guard_blocked: 'do_it_yourself',
  // Amendment 36.6 states one row for "Ollama unreachable, or preset tag missing"; a missing preset
  // tag has no code of its own, so nothing here invents one.
  ollama_unreachable: 'do_it_yourself',
  lock_timeout: 'retry_later',
  chat_timeout: 'retry_later',
  context_budget_exceeded: 'split_with_map',
  budget_exceeded: 'split_with_map',
  context_overflow: 'split_with_map',
  delegate_unsupported: 'do_it_yourself',
  consent_required: 'do_it_yourself',
});

/**
 * @param {string} code
 * @returns {'do_it_yourself' | 'retry_later' | 'split_with_map' | undefined}
 */
export function getOrchestratorAction(code) {
  return ORCHESTRATOR_ACTIONS[code];
}

/**
 * Adds `data.orchestratorAction` to a refusal that has one, so the host core's rule ("on
 * do_it_yourself, do the work yourself and do not loop") is machine-readable.
 * @template {{ code: string, data: Record<string, unknown> }} T
 * @param {T} error
 * @returns {T}
 */
export function attachOrchestratorAction(error) {
  const action = getOrchestratorAction(error.code);
  if (action && error.data.orchestratorAction === undefined) error.data.orchestratorAction = action;
  return error;
}

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} dir
 * @property {string} command      `ask`, `map`, `edit`, `apply` or `restore`.
 * @property {string} cwd
 * @property {number} startedMs
 * @property {number} fileCount
 * @property {number} localInputChars
 * @property {number} promptTokensEstimate
 * @property {number} promptTokensActual
 * @property {number} outputTokens
 * @property {string[]} warnings
 */

/**
 * `20260918-143012-edit-9fb3c1`: sortable, and unique even within one second.
 * @param {string} command
 * @param {{ now?: () => number, randomHex?: () => string }} [options]
 * @returns {string}
 */
export function createJobId(command, { now = Date.now, randomHex = () => crypto.randomBytes(3).toString('hex') } = {}) {
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${stamp}-${command}-${randomHex()}`;
}

/**
 * @param {{ resultsDir: string, command: string, cwd: string, now?: () => number, randomHex?: () => string }} input
 * @returns {Promise<Job>}
 */
export async function createJob({ resultsDir, command, cwd, now = Date.now, randomHex }) {
  const id = createJobId(command, { now, randomHex });
  const dir = path.join(resultsDir, id);
  await fs.mkdir(dir, { recursive: true });
  return { id, dir, command, cwd, startedMs: now(), fileCount: 0, localInputChars: 0, promptTokensEstimate: 0, promptTokensActual: 0, outputTokens: 0, warnings: [] };
}

/**
 * @param {Job} job
 * @param {string} relativeName  Posix or platform separators; nested names create their folder.
 * @param {string | Buffer} content
 * @returns {Promise<string>} The absolute path written.
 */
export async function writeJobFile(job, relativeName, content) {
  const target = path.join(job.dir, relativeName);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

/**
 * Adds one model answer to the job counters and warns when Ollama's own token counts show the context
 * window overflowed: the prompt was truncated, or generation shifted it and dropped part of the input.
 * @param {Job} job
 * @param {{ promptTokens: number, outputTokens: number, doneReason: string }} result
 * @param {{ numCtx: number, maxOutputTokens: number }} limits
 * @returns {boolean} True when the context window overflowed.
 */
export function addUsage(job, result, { numCtx, maxOutputTokens }) {
  job.promptTokensActual += result.promptTokens;
  job.outputTokens += result.outputTokens;
  if (result.doneReason === 'length') {
    job.warnings.push('The answer stopped at the output limit, so it may be incomplete.');
  }
  const overflow = result.promptTokens >= numCtx || result.promptTokens + result.outputTokens >= numCtx;
  if (overflow) {
    job.warnings.push(
      `The context window is full (prompt ${result.promptTokens} + output ${result.outputTokens} >= numCtx ${numCtx}): ` +
        'the input was probably truncated, so do not trust this result.',
    );
  } else if (result.promptTokens > numCtx - maxOutputTokens) {
    job.warnings.push(`The prompt used ${result.promptTokens} of numCtx ${numCtx} tokens, leaving little room for the answer.`);
  }
  return overflow;
}

/**
 * @typedef {object} ReviewKey
 * @property {string} cwd            Case-folded on Windows.
 * @property {string} taskSha256
 * @property {string[]} files        Allow-list keys, sorted.
 */

/**
 * The identity of a dry run: the same working directory, the same task text and the same file list.
 * `apply` only reuses a review whose key matches, so it applies exactly what was reviewed.
 * @param {{ cwd: string, task: string, allowlist: Map<string, unknown>, platform?: NodeJS.Platform }} input
 * @returns {ReviewKey}
 */
export function createReviewKey({ cwd, task, allowlist, platform = process.platform }) {
  return { cwd: pathKey(cwd, platform), taskSha256: sha256Hex(task), files: [...allowlist.keys()].sort() };
}

/**
 * @typedef {object} ReviewRecord
 * @property {string} cwd
 * @property {string} taskSha256
 * @property {string[]} files
 * @property {Array<{ relativePath: string, absolutePath: string, originalSha256: string, newBytesBase64: string }>} changes
 */

/**
 * @param {ReviewKey} reviewKey
 * @param {readonly import('./edit-blocks.js').FileChange[]} changes
 * @returns {ReviewRecord}
 */
export function createReviewRecord(reviewKey, changes) {
  return {
    ...reviewKey,
    changes: changes.map((change) => ({
      relativePath: change.relativePath,
      absolutePath: change.absolutePath,
      originalSha256: sha256Hex(change.bytes),
      newBytesBase64: change.newBytes.toString('base64'),
    })),
  };
}

/**
 * `<jobId>.<sha8>`: names the job folder and pins the exact reviewed content, so a review record that
 * was edited or regenerated after the review is refused instead of applied.
 * @param {string} jobId
 * @param {ReviewRecord} record
 * @returns {string}
 */
export function createReviewId(jobId, record) {
  return `${jobId}.${sha256Hex(stableStringify(record)).slice(0, 8)}`;
}

/**
 * @param {string} reviewId
 * @returns {{ jobId: string, digest: string } | null}
 */
export function parseReviewId(reviewId) {
  const match = /^(\d{8}-\d{6}-[a-z]+-[0-9a-f]{6})\.([0-9a-f]{8})$/.exec(String(reviewId).trim());
  return match ? { jobId: match[1], digest: match[2] } : null;
}

/**
 * @param {Job} job
 * @param {ReviewKey} reviewKey
 * @param {readonly import('./edit-blocks.js').FileChange[]} changes
 * @returns {Promise<{ reviewId: string, reviewPath: string }>}
 */
export async function writeReview(job, reviewKey, changes) {
  const record = createReviewRecord(reviewKey, changes);
  const reviewId = createReviewId(job.id, record);
  const reviewPath = await writeJobFile(job, 'review.json', `${JSON.stringify(record)}\n`);
  return { reviewId, reviewPath };
}

/**
 * @param {string} resultsDir
 * @param {string} reviewId
 * @returns {Promise<{ jobId: string, record: ReviewRecord } | null>} Null when the id is unknown or the
 *   record no longer matches the digest in the id.
 */
export async function readReview(resultsDir, reviewId) {
  const parsed = parseReviewId(reviewId);
  if (!parsed) return null;
  let record;
  try {
    record = JSON.parse(await fs.readFile(path.join(resultsDir, parsed.jobId, 'review.json'), 'utf8'));
  } catch {
    return null;
  }
  if (createReviewId(parsed.jobId, record) !== reviewId) return null;
  return { jobId: parsed.jobId, record };
}

/**
 * @typedef {object} JobOutcome
 * @property {string} status
 * @property {number} exitCode
 * @property {string} [code]        Envelope code; defaults from the exit code.
 * @property {string} [message]
 * @property {string} [answer]      Long text; the envelope carries a capped summary of it.
 * @property {boolean} [answerFromEnd]  Keep the tail (command output) instead of the head.
 * @property {string} [resultPath]
 * @property {string} [reviewId]
 * @property {Record<string, unknown>} [extra]
 */

/**
 * Builds the `data` payload and the envelope fields of one finished job.
 * @param {object} input
 * @param {Job} input.job
 * @param {JobOutcome} input.outcome
 * @param {{ model: string, numCtx: number }} input.target
 * @param {() => number} [input.now]
 * @returns {{ exitCode: number, code: string | undefined, message: string, data: Record<string, unknown>, warnings: string[], summary: string, truncated: boolean }}
 */
export function buildJobResult({ job, outcome, target, now = Date.now }) {
  const answer = outcome.answer ?? '';
  const summary = answer.length <= SUMMARY_LIMIT
    ? answer
    : outcome.answerFromEnd
      ? takeTail(answer, SUMMARY_LIMIT)
      : truncateText(answer, SUMMARY_LIMIT);
  const durationMs = Math.max(0, now() - job.startedMs);
  /** @type {Record<string, unknown>} */
  const data = {
    jobId: job.id,
    status: outcome.status,
    model: target.model,
    numCtx: target.numCtx,
    promptTokensEstimate: job.promptTokensEstimate,
    promptTokensActual: job.promptTokensActual,
    outputTokens: job.outputTokens,
    durationMs,
    resultPath: outcome.resultPath ?? job.dir,
    summary,
    summaryTruncated: summary.length < answer.length,
    answerChars: answer.length,
    ...(outcome.extra ?? {}),
  };
  if (outcome.reviewId) data.reviewId = outcome.reviewId;
  const action = outcome.exitCode === EXIT.OK ? undefined : getOrchestratorAction(outcome.code ?? '');
  if (action) data.orchestratorAction = action;
  return {
    exitCode: outcome.exitCode,
    code: outcome.code,
    message: outcome.message ?? '',
    data,
    warnings: [...job.warnings],
    summary,
    truncated: summary.length < answer.length,
  };
}

/**
 * The record `meta.json` keeps next to the job output.
 * @param {Job} job
 * @param {ReturnType<typeof buildJobResult>} result
 * @returns {string}
 */
export function renderJobMeta(job, result) {
  return `${JSON.stringify({ command: job.command, cwd: job.cwd, exitCode: result.exitCode, code: result.code ?? null, message: result.message, warnings: result.warnings, ...result.data, summary: undefined }, null, 2)}\n`;
}
