// `delegate edit` (dry run) and `delegate apply <reviewId>` (spec 12.2).
//
// The two are deliberately separate commands: `edit` never writes a project file, and `apply` never
// calls the model. What is applied is byte for byte what the reviewer read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { sha256Hex } from '../core/hash.js';
import { applyChanges, describeRestoreReport } from './apply.js';
import { toList } from './ask.js';
import { resolveAutoCheck, runCheckCommands, validateCheckCommand } from './check-command.js';
import { createChangesDiff, countDiffLines } from './diff.js';
import { decodeTextFile, parseEditBlocks, validateEditBlocks } from './edit-blocks.js';
import { isInsideDirectory, loadSourceFiles, pathKey, readTaskText, realPathOrSelf, resolveFileArgs } from './files.js';
import { requestChat, withDelegateLock } from './model.js';
import { describeProtectedEdit, findProtectedEditGlob } from './protected-files.js';
import { toPosix } from './sensitive.js';
import { assertPromptBudget, buildEditMessages, estimateMessageTokens, getDelegatePromptBudget, takeTail, truncateText } from './prompts.js';
import { addUsage, createReviewKey, readReview, SUMMARY_LIMIT, writeJobFile, writeReview } from './results.js';

export const DIFF_FILE = 'proposed.diff';
const EDIT_BUDGET_HINT = 'Split the edit into jobs with fewer files, or use delegate map to find the exact lines first.';
// One retry: the first validation failure usually names a mistake the model can fix, and a second
// failure means the task needs a human, not another 20 seconds of GPU.
const EDIT_RETRIES = 1;

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @returns {Promise<import('./results.js').JobOutcome>}
 */
export async function runEdit(context, job) {
  const { options } = context;
  // An explicit check command is validated here, before any GPU work, so a refused command costs
  // nothing. `auto` resolves at apply time, when the changed files are known.
  if (options.check !== undefined && options.check !== 'auto') validateCheckCommand(String(options.check), context.config.delegate.checkCommandPrefixes);
  const task = await readTaskText(/** @type {string} */ (options.task), {
    cwd: context.cwd,
    matcher: context.matcher,
    allowSensitive: Boolean(options.allowSensitive),
  });
  const { files, allowlist } = await loadEditAllowlist(context, job);

  const firstMessages = buildEditMessages(task, files);
  job.promptTokensEstimate = estimateMessageTokens(firstMessages, context.budget.charsPerToken);
  assertPromptBudget({ messages: firstMessages, settings: context.budget, files, hint: EDIT_BUDGET_HINT });

  const generated = await withDelegateLock(context, (lock) => generateValidEdits(context, job, task, files, allowlist, lock));
  if (generated.overflow) {
    return {
      status: 'context_overflow',
      exitCode: EXIT.BUDGET,
      code: 'context_overflow',
      message:
        'The model saw a truncated prompt, so its edit blocks were not validated, applied or saved for review. Pass fewer or smaller files.',
      resultPath: generated.lastAnswerPath ?? job.dir,
    };
  }
  if (generated.errors) {
    return {
      status: 'edit_invalid',
      exitCode: EXIT.VALIDATION,
      code: 'edit_invalid',
      message: `The edit blocks failed validation after ${generated.attempts} attempt(s); nothing was applied${generated.note ? `; ${generated.note}` : ''}`,
      answer: generated.errors.map((error) => `- ${error}`).join('\n'),
      resultPath: generated.lastAnswerPath ?? job.dir,
    };
  }

  const changes = generated.changes ?? [];
  job.localInputChars = files.reduce((total, file) => total + file.text.length, 0);
  const diffText = createChangesDiff(changes);
  const diffPath = await writeJobFile(job, DIFF_FILE, diffText);
  const reviewKey = createReviewKey({ cwd: context.cwd, task, allowlist, platform: context.platform });
  const { reviewId } = await writeReview(job, reviewKey, changes);
  const changed = changes.map((change) => change.relativePath).join(', ');
  return {
    status: 'dry_run',
    exitCode: EXIT.OK,
    reviewId,
    message:
      `Validated edits for ${changed}; no file was changed. Review the diff, then run ` +
      `'opencode-unity delegate apply ${reviewId}' to apply exactly this diff.`,
    answer: diffText,
    resultPath: diffPath,
  };
}

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @returns {Promise<import('./results.js').JobOutcome>}
 */
export async function runApply(context, job) {
  const reviewId = String(context.args.reviewId ?? '').trim();
  const review = await readReview(context.resultsDir, reviewId);
  if (!review) {
    throw new CliError(`No reviewed dry run named '${reviewId}'`, {
      exitCode: EXIT.VALIDATION,
      code: 'review_not_found',
      data: { reviewId },
      hint: "Run 'opencode-unity delegate edit' again and apply the review id it prints.",
    });
  }
  const changes = await loadReviewedChanges(review.record, review.jobId);
  const checks = context.options.check === undefined ? null : resolveChecks(context, changes.map((change) => change.relativePath));

  const diffText = createChangesDiff(changes);
  const diffPath = await writeJobFile(job, DIFF_FILE, diffText);
  const changed = changes.map((change) => change.relativePath).join(', ');
  const applied = await applyChanges({
    job,
    changes,
    maxRunSec: checks ? Math.round(context.timeouts.checkMs / 1000) : 0,
    track: context.trackCleanup,
  });
  // The reviewer already read the whole diff in the dry run, so only a summary is returned again.
  const summary = `The diff is not repeated (reviewed in ${reviewId}): ${countDiffLines(changes).join(', ')}. Full diff: ${diffPath}`;

  if (!checks) {
    applied.finish();
    return {
      status: 'applied',
      exitCode: EXIT.OK,
      message: `Applied the reviewed edit to ${changed}; backups are in ${path.join(job.dir, 'backup')}`,
      answer: summary,
      resultPath: diffPath,
      extra: { appliedFiles: changes.map((change) => change.relativePath), reviewId },
    };
  }

  const results = await runCheckCommands(checks, {
    cwd: context.cwd,
    timeoutMs: context.timeouts.checkMs,
    signal: context.signal,
    onSpawn: context.trackChild,
    env: context.env,
  });
  const checkOutput = results.map((result) => `$ ${result.command.text}\n${result.output}`).join('\n\n');
  const checkPath = await writeJobFile(job, 'check-output.txt', checkOutput);
  if (results.every((result) => result.ok)) {
    applied.finish();
    return {
      status: 'applied',
      exitCode: EXIT.OK,
      message: `Applied the reviewed edit to ${changed}; the check passed`,
      answer: summary,
      resultPath: diffPath,
      extra: { appliedFiles: changes.map((change) => change.relativePath), reviewId, check: 'passed' },
    };
  }

  const failed = /** @type {import('./check-command.js').CheckResult} */ (results.find((result) => !result.ok));
  const report = applied.restore();
  applied.finish();
  const status = report.failures.length > 0 ? 'restore_incomplete' : report.conflicts.length > 0 ? 'restore_conflict' : 'check_failed_restored';
  return {
    status,
    exitCode: EXIT.CHECK_FAILED,
    code: 'check_failed',
    message: `The check '${failed.command.text}' exited ${failed.exitCode ?? 'without a code'}; ${describeRestoreReport(report)}. Diff: ${diffPath}`,
    answer: formatDiffAndCheckTail(summary, failed.output),
    answerFromEnd: false,
    resultPath: checkPath,
    extra: { reviewId, check: 'failed', restored: report.restored, conflicts: report.conflicts, failures: report.failures },
  };
}

/**
 * The files an edit may touch. Symlinks are resolved, so a link inside the working directory cannot
 * point a write outside it.
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @returns {Promise<{ files: import('./files.js').SourceFile[], allowlist: Map<string, import('./edit-blocks.js').AllowedFile> }>}
 */
async function loadEditAllowlist(context, job) {
  const fileArgs = toList(context.options.files);
  if (fileArgs.length === 0) throw usageError('delegate edit needs --files: the exact files the edit may touch');
  const paths = await resolveFileArgs(fileArgs, context.cwd, { allowGlobs: false, platform: context.platform, env: context.env });
  // Refused before the file is even opened: a protected path never reaches the prompt, so it costs no
  // GPU time and its contents - a scene and a prefab are `PROTECTED_READ` too - never leave the disk.
  for (const absolutePath of paths) {
    const relativePath = toPosix(path.relative(context.cwd, absolutePath));
    const protectedGlob = findProtectedEditGlob(relativePath, context.config.safety.extraProtectedEditGlobs);
    if (protectedGlob) throw usageError(describeProtectedEdit(relativePath, protectedGlob));
  }
  const loaded = await loadSourceFiles(paths, context.cwd, {
    matcher: context.matcher,
    allowSensitive: Boolean(context.options.allowSensitive),
    strict: true,
  });
  job.warnings.push(...loaded.warnings);
  job.fileCount = loaded.files.length;
  const realCwd = realPathOrSelf(context.cwd);
  /** @type {Map<string, import('./edit-blocks.js').AllowedFile>} */
  const allowlist = new Map();
  for (const file of loaded.files) {
    const realPath = realPathOrSelf(file.absolutePath);
    if (!isInsideDirectory(file.absolutePath, context.cwd) || !isInsideDirectory(realPath, realCwd)) {
      throw usageError(`edit files must be inside ${context.cwd} (links are resolved): ${file.relativePath}`);
    }
    allowlist.set(pathKey(file.relativePath, context.platform), {
      relativePath: file.relativePath,
      absolutePath: realPath,
      bytes: file.bytes,
      decoded: decodeTextFile(file.bytes),
    });
  }
  return { files: loaded.files, allowlist };
}

/**
 * Asks the model for edit blocks and validates them, retrying once with the validation errors.
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @param {string} task
 * @param {readonly import('./files.js').SourceFile[]} files
 * @param {Map<string, import('./edit-blocks.js').AllowedFile>} allowlist
 * @param {import('../core/lock.js').GpuLock} lock
 * @returns {Promise<{ changes?: import('./edit-blocks.js').FileChange[], errors?: string[], attempts?: number, overflow?: boolean, lastAnswerPath?: string, note?: string }>}
 */
async function generateValidEdits(context, job, task, files, allowlist, lock) {
  /** @type {string[]} */
  let errors = [];
  /** @type {string | undefined} */
  let lastAnswerPath;
  for (let attempt = 1; attempt <= EDIT_RETRIES + 1; attempt += 1) {
    const messages = buildEditMessages(task, files, errors);
    // The first prompt was checked before the lock; a retry only adds the error list, so when that no
    // longer fits, the job ends as a validation failure (exit 4) and not as an over-budget prompt.
    if (attempt > 1 && estimateMessageTokens(messages, context.budget.charsPerToken) > getDelegatePromptBudget(context.budget)) {
      return { errors, attempts: attempt - 1, lastAnswerPath, note: 'no retry was sent, because the prompt with these errors would be over the context budget' };
    }
    const result = await requestChat(context, job, messages, lock);
    const overflow = addUsage(job, result, context.budget);
    lastAnswerPath = await writeJobFile(job, `attempt-${attempt}.answer.md`, result.content);
    // Blocks written from a truncated prompt are never validated, applied or saved for review.
    if (overflow) return { overflow: true, lastAnswerPath };
    const parsed = parseEditBlocks(result.content);
    const validation = parsed.errors.length > 0
      ? { changes: [], errors: parsed.errors, warnings: [] }
      : validateEditBlocks(parsed.blocks, allowlist, context.cwd, { platform: context.platform, extraProtectedEditGlobs: context.config.safety.extraProtectedEditGlobs });
    if (validation.errors.length === 0) {
      job.warnings.push(...validation.warnings);
      return { changes: validation.changes, attempts: attempt };
    }
    errors = validation.errors;
    await writeJobFile(job, `attempt-${attempt}.errors.txt`, `${errors.join('\n')}\n`);
  }
  return { errors, attempts: EDIT_RETRIES + 1, lastAnswerPath };
}

/**
 * Re-reads every reviewed file and refuses when one changed since the dry run (spec 12.2: stale
 * review, exit 4).
 * @param {import('./results.js').ReviewRecord} record
 * @param {string} jobId
 * @returns {Promise<import('./edit-blocks.js').FileChange[]>}
 */
async function loadReviewedChanges(record, jobId) {
  /** @type {import('./edit-blocks.js').FileChange[]} */
  const changes = [];
  for (const reviewed of record.changes) {
    /** @type {Buffer} */
    let bytes;
    try {
      bytes = await fs.readFile(reviewed.absolutePath);
    } catch (error) {
      throw new CliError(`${reviewed.relativePath} cannot be read any more; nothing was applied`, {
        exitCode: EXIT.VALIDATION,
        code: 'review_stale',
        data: { file: reviewed.relativePath, jobId },
        cause: error,
      });
    }
    if (sha256Hex(bytes) !== reviewed.originalSha256) {
      throw new CliError(`${reviewed.relativePath} changed since dry run ${jobId} (or that diff was already applied); nothing was applied`, {
        exitCode: EXIT.VALIDATION,
        code: 'review_stale',
        data: { file: reviewed.relativePath, jobId },
        hint: 'Run delegate edit again and review the new diff.',
      });
    }
    const newBytes = Buffer.from(reviewed.newBytesBase64, 'base64');
    changes.push({
      relativePath: reviewed.relativePath,
      absolutePath: reviewed.absolutePath,
      bytes,
      decoded: decodeTextFile(bytes),
      newBytes,
      newText: decodeTextFile(newBytes).text,
    });
  }
  return changes;
}

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {readonly string[]} changedPaths
 * @returns {import('./check-command.js').CheckCommand[]}
 */
function resolveChecks(context, changedPaths) {
  const value = String(context.options.check);
  const prefixes = context.config.delegate.checkCommandPrefixes;
  if (value !== 'auto') return [validateCheckCommand(value, prefixes)];
  if (changedPaths.length === 0) return [];
  const project = context.requireProject();
  return resolveAutoCheck({ changedPaths, compileMap: project.compileMap, cwd: context.cwd, projectRoot: project.root, prefixes });
}

/**
 * The applied summary and the tail of the check output share the summary limit: the summary first (at
 * most half), then as much of the output tail as fits.
 * @param {string} summary
 * @param {string} checkOutput
 * @returns {string}
 */
export function formatDiffAndCheckTail(summary, checkOutput) {
  const summaryHeader = 'APPLIED:\n';
  const tailHeader = '\nCHECK OUTPUT (tail):\n';
  const summaryRoom = Math.max(0, Math.floor(SUMMARY_LIMIT / 2) - summaryHeader.length);
  let summaryPart = summary.replace(/\s+$/, '');
  if (summaryPart.length > summaryRoom) summaryPart = `${truncateText(summaryPart, Math.max(0, summaryRoom - 40))}\n[summary truncated]`;
  const tailRoom = Math.max(0, SUMMARY_LIMIT - summaryHeader.length - summaryPart.length - tailHeader.length - 1);
  const tail = takeTail(checkOutput.split(/\r?\n/).slice(-60).join('\n'), tailRoom);
  return `${summaryHeader}${summaryPart}\n${tailHeader}${tail}`;
}
