// `delegate ask`: one guarded request over the task and the named files (spec 12.2).
import { EXIT, usageError } from '../cli/exit-codes.js';
import { loadSourceFiles, readTaskText, resolveFileArgs } from './files.js';
import { requestChat, withDelegateLock } from './model.js';
import { assertPromptBudget, buildAskMessages, estimateMessageTokens } from './prompts.js';
import { addUsage, writeJobFile } from './results.js';

const MANY_FILES_HINT = "Use 'opencode-unity delegate map' for per-file work, or pass fewer files.";
const ONE_FILE_HINT =
  'One file is too large for a single request: filter it first (for example keep only the error and warning lines), ' +
  'or use a preset with a larger context.';

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @returns {Promise<import('./results.js').JobOutcome>}
 */
export async function runAsk(context, job) {
  const { options } = context;
  const allowSensitive = Boolean(options.allowSensitive);
  const task = await readTaskText(/** @type {string} */ (options.task), { cwd: context.cwd, matcher: context.matcher, allowSensitive });
  const paths = await resolveFileArgs(toList(options.files), context.cwd, { platform: context.platform, env: context.env });
  const loaded = await loadSourceFiles(paths, context.cwd, { matcher: context.matcher, allowSensitive });
  job.warnings.push(...loaded.warnings);
  job.fileCount = loaded.files.length;
  if (paths.length > 0 && loaded.files.length === 0) throw usageError(`No usable files: ${loaded.warnings.join('; ')}`);

  const messages = buildAskMessages(task, loaded.files);
  job.promptTokensEstimate = estimateMessageTokens(messages, context.budget.charsPerToken);
  assertPromptBudget({
    messages,
    settings: context.budget,
    files: loaded.files,
    hint: loaded.files.length > 1 ? MANY_FILES_HINT : ONE_FILE_HINT,
  });

  const result = await withDelegateLock(context, (lock) => requestChat(context, job, messages, lock));
  const overflow = addUsage(job, result, context.budget);
  const resultPath = await writeJobFile(job, 'answer.md', result.content);
  if (overflow) return contextOverflowOutcome(resultPath);
  job.localInputChars = loaded.files.reduce((total, file) => total + file.text.length, 0);
  return { status: 'ok', exitCode: EXIT.OK, answer: result.content, resultPath };
}

/**
 * An answer written from a truncated prompt is never printed: the model did not see the whole input.
 * @param {string} resultPath
 * @returns {import('./results.js').JobOutcome}
 */
export function contextOverflowOutcome(resultPath) {
  return {
    status: 'context_overflow',
    exitCode: EXIT.BUDGET,
    code: 'context_overflow',
    message: 'The model saw a truncated prompt, so its answer is not returned. Pass less input, or split the work with delegate map.',
    resultPath,
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function toList(value) {
  return Array.isArray(value) ? value : [];
}
