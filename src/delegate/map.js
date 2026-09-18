// `delegate map`: one guarded request per file, then an optional reduce request (spec 12.2).
//
// One file per request is what makes a 30B model at 16K useful on a large tree: each answer is about
// exactly one file, and a file that does not fit fails on its own instead of spoiling the whole job.
import { CliError, EXIT, usageError } from '../cli/exit-codes.js';
import { contextOverflowOutcome, toList } from './ask.js';
import { loadSourceFiles, readTaskText, resolveFileArgs } from './files.js';
import { requestChat, withDelegateLock } from './model.js';
import {
  assertPromptBudget,
  buildMapMessages,
  buildReduceMessages,
  chunkPiecesByBudget,
  collapseWhitespace,
  estimateMessageTokens,
  estimateTextBudgetTokens,
  formatNote,
  getDelegatePromptBudget,
  truncateText,
} from './prompts.js';
import { addUsage, writeJobFile } from './results.js';

export const MAP_NOTES_FILE = 'map.md';
const PREVIEW_CHARS = 160;
const MAX_NAMED_FAILURES = 10;
const MIN_REDUCE_NOTE_TOKENS = 256;
const MAX_REDUCE_ROUNDS = 5;
const ONE_FILE_HINT = 'Filter the file first, or use a preset with a larger context.';

/**
 * @typedef {object} MapEntry
 * @property {string} file
 * @property {string} status
 * @property {string | null} resultPath  Relative to the job folder.
 * @property {number} promptTokens
 * @property {number} outputTokens
 * @property {string} preview
 */

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @returns {Promise<import('./results.js').JobOutcome>}
 */
export async function runMap(context, job) {
  const { options } = context;
  const allowSensitive = Boolean(options.allowSensitive);
  const read = { cwd: context.cwd, matcher: context.matcher, allowSensitive };
  const task = await readTaskText(/** @type {string} */ (options.task), read);
  const reduceTask = options.reduce === undefined ? null : await readTaskText(/** @type {string} */ (options.reduce), { ...read, optionName: 'reduce' });
  const fileArgs = toList(options.files);
  if (fileArgs.length === 0) throw usageError('delegate map needs --files');
  const paths = await resolveFileArgs(fileArgs, context.cwd, { platform: context.platform, env: context.env });
  const loaded = await loadSourceFiles(paths, context.cwd, { matcher: context.matcher, allowSensitive });
  job.warnings.push(...loaded.warnings);
  job.fileCount = loaded.files.length;
  if (loaded.files.length === 0) throw usageError(`No usable files: ${loaded.warnings.join('; ')}`);

  // Both budgets are checked before the GPU lock, so impossible work fails fast instead of waiting.
  const noteBudget = reduceTask === null ? 0 : getReduceNoteBudget(context, reduceTask);
  const prepared = loaded.files.map((file) => prepareEntry(context, task, file));
  job.promptTokensEstimate = prepared.reduce((total, item) => total + item.estimate, 0);

  /** @type {string | null} */
  let reduceText = null;
  /** @type {CliError | null} */
  let reduceError = null;
  if (prepared.some((item) => item.entry.status === 'pending')) {
    await withDelegateLock(context, async (lock) => {
      for (const [index, item] of prepared.entries()) {
        if (item.entry.status !== 'pending') continue;
        const status = await mapOneFile(context, job, item, index, lock);
        if (status === 'backend_error') {
          await writeMapResults(job, task, prepared);
          throw /** @type {CliError} */ (item.error);
        }
      }
      await writeMapResults(job, task, prepared);
      if (reduceTask === null || !prepared.some((item) => item.entry.status === 'ok')) return;
      try {
        reduceText = await reduceNotes(context, job, reduceTask, prepared, noteBudget, lock);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        reduceError = error;
      }
    });
  } else {
    await writeMapResults(job, task, prepared);
  }

  job.localInputChars = prepared
    .filter((item) => item.entry.status === 'ok')
    .reduce((total, item) => total + item.file.text.length, 0);
  return buildMapOutcome(job, prepared, reduceText, reduceError);
}

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {string} task
 * @param {import('./files.js').SourceFile} file
 * @returns {{ entry: MapEntry, file: import('./files.js').SourceFile, messages: import('./prompts.js').ChatMessage[], estimate: number, content?: string, error?: CliError }}
 */
function prepareEntry(context, task, file) {
  const messages = buildMapMessages(task, file);
  /** @type {MapEntry} */
  const entry = { file: file.relativePath, status: 'pending', resultPath: null, promptTokens: 0, outputTokens: 0, preview: '' };
  const item = { entry, file, messages, estimate: estimateMessageTokens(messages, context.budget.charsPerToken) };
  try {
    assertPromptBudget({ messages, settings: context.budget, files: [file], hint: ONE_FILE_HINT });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    entry.status = error.code;
    entry.preview = truncateText(collapseWhitespace(error.message), PREVIEW_CHARS);
  }
  return item;
}

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @param {ReturnType<typeof prepareEntry>} item
 * @param {number} index
 * @param {import('../core/lock.js').GpuLock} lock
 * @returns {Promise<string>} The entry status after the request.
 */
async function mapOneFile(context, job, item, index, lock) {
  const { entry } = item;
  try {
    const result = await requestChat(context, job, item.messages, lock);
    const overflow = addUsage(job, result, context.budget);
    entry.status = overflow ? 'context_overflow' : 'ok';
    entry.promptTokens = result.promptTokens;
    entry.outputTokens = result.outputTokens;
    entry.resultPath = `files/${String(index + 1).padStart(3, '0')}-${safeFileName(entry.file)}.md`;
    await writeJobFile(job, entry.resultPath, result.content);
    entry.preview = overflow ? 'the context window was full, so the input was truncated' : truncateText(collapseWhitespace(result.content), PREVIEW_CHARS);
    if (!overflow) item.content = result.content;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // A blocked guard, an unreachable server or a lost lock stops the whole job; a per-file problem
    // only marks that file.
    entry.status = error.exitCode === EXIT.BLOCKED || error.exitCode === EXIT.LOCK_TIMEOUT ? 'backend_error' : error.code;
    entry.preview = truncateText(collapseWhitespace(error.message), PREVIEW_CHARS);
    item.error = error;
  }
  return entry.status;
}

/**
 * `map.md` holds every full note, so one read gives an orchestrator all results; `index.json` is the
 * machine-readable index, with paths relative to the job folder.
 * @param {import('./results.js').Job} job
 * @param {string} task
 * @param {readonly ReturnType<typeof prepareEntry>[]} items
 */
async function writeMapResults(job, task, items) {
  await writeJobFile(job, 'index.json', `${JSON.stringify({ task, files: items.map((item) => item.entry) }, null, 2)}\n`);
  const notes = items.map((item) => `## ${item.entry.file} (${item.entry.status})\n\n${(item.content ?? item.entry.preview).replace(/\s+$/, '')}\n`);
  await writeJobFile(job, MAP_NOTES_FILE, notes.join('\n'));
}

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {string} reduceTask
 * @returns {number}
 */
function getReduceNoteBudget(context, reduceTask) {
  const overhead = estimateMessageTokens(buildReduceMessages(reduceTask, ''), context.budget.charsPerToken);
  const budget = getDelegatePromptBudget(context.budget);
  const noteBudget = budget - overhead;
  if (noteBudget < MIN_REDUCE_NOTE_TOKENS) {
    throw new CliError(
      `The --reduce instruction needs about ${overhead} tokens and leaves ${Math.max(0, noteBudget)} of the ${budget}-token prompt budget ` +
        `for the notes (at least ${MIN_REDUCE_NOTE_TOKENS} are needed); shorten it`,
      { exitCode: EXIT.BUDGET, code: 'context_budget_exceeded', data: { overhead, budget } },
    );
  }
  return noteBudget;
}

/**
 * Merges the per-file notes, in rounds, until one answer is left.
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @param {import('./results.js').Job} job
 * @param {string} reduceTask
 * @param {readonly ReturnType<typeof prepareEntry>[]} items
 * @param {number} noteBudget
 * @param {import('../core/lock.js').GpuLock} lock
 * @returns {Promise<string>}
 */
async function reduceNotes(context, job, reduceTask, items, noteBudget, lock) {
  const measure = (/** @type {string} */ text) => estimateTextBudgetTokens(text, context.budget.charsPerToken, context.budget.safetyMargin);
  let pieces = items
    .filter((item) => item.entry.status === 'ok')
    .map((item) => formatNote(item.entry.file, /** @type {string} */ (item.content)));
  for (let round = 1; round <= MAX_REDUCE_ROUNDS; round += 1) {
    const groups = chunkPiecesByBudget(pieces, noteBudget, measure);
    /** @type {string[]} */
    const outputs = [];
    for (const group of groups) {
      const result = await requestChat(context, job, buildReduceMessages(reduceTask, group.join('\n\n')), lock);
      if (addUsage(job, result, context.budget)) {
        // Same rule as ask and the per-file requests: an answer from a truncated prompt is withheld.
        await writeJobFile(job, `reduce-round-${round}-overflow.md`, result.content);
        throw new CliError('A reduce request filled the context window, so its answer was withheld', {
          exitCode: EXIT.BUDGET,
          code: 'context_overflow',
        });
      }
      outputs.push(result.content);
    }
    if (outputs.length === 1) {
      await writeJobFile(job, 'reduce.md', outputs[0]);
      return outputs[0];
    }
    await writeJobFile(job, `reduce-round-${round}.md`, outputs.join('\n\n---\n\n'));
    pieces = outputs.map((output, index) => formatNote(`partial summary ${index + 1}`, output));
  }
  throw new CliError(`Reduce did not converge within ${MAX_REDUCE_ROUNDS} rounds; read the per-file notes instead`, {
    exitCode: EXIT.RUNTIME,
    code: 'reduce_failed',
  });
}

/**
 * @param {import('./results.js').Job} job
 * @param {readonly ReturnType<typeof prepareEntry>[]} items
 * @param {string | null} reduceText
 * @param {CliError | null} reduceError
 * @returns {import('./results.js').JobOutcome}
 */
function buildMapOutcome(job, items, reduceText, reduceError) {
  const entries = items.map((item) => item.entry);
  const okCount = entries.filter((entry) => entry.status === 'ok').length;
  const failed = entries.filter((entry) => entry.status !== 'ok');
  const formatEntry = (/** @type {MapEntry} */ entry) => `${entry.status} ${entry.file}: ${entry.preview}`;
  const notesPath = `${job.dir}/${MAP_NOTES_FILE}`;
  const failedText = failed.length > 0 ? `${describeFailedFiles(failed, entries.length)}; ` : '';
  const notesHint = `the full per-file notes are in ${MAP_NOTES_FILE} in the job folder`;
  if (reduceError) {
    return {
      status: 'reduce_failed',
      exitCode: reduceError.exitCode,
      code: reduceError.code,
      message: `The reduce request failed: ${reduceError.message}; ${failedText}${notesHint}`,
      answer: entries.map(formatEntry).join('\n'),
      resultPath: notesPath,
    };
  }
  const answer = reduceText !== null
    ? ['=== reduce ===', reduceText, '', `=== files: ${okCount} ok, ${failed.length} failed ===`, ...failed.map(formatEntry)].join('\n')
    : entries.map(formatEntry).join('\n');
  const resultPath = reduceText !== null ? `${job.dir}/reduce.md` : notesPath;
  if (okCount === entries.length) {
    return { status: 'ok', exitCode: EXIT.OK, answer, resultPath, message: reduceText !== null ? notesHint : '' };
  }
  const message = `${failedText}${notesHint}`;
  if (okCount === 0 && entries.every((entry) => ['context_budget_exceeded', 'context_overflow'].includes(entry.status))) {
    return { ...contextOverflowOutcome(resultPath), status: 'context_overflow', answer, message: `Every file was over the context budget; ${message}` };
  }
  if (okCount === 0) return { status: 'failed', exitCode: EXIT.RUNTIME, answer, resultPath, message };
  return { status: 'partial', exitCode: EXIT.OK, answer, resultPath, message };
}

/**
 * Failed files are named in the message, which prints before the answer and survives truncation.
 * @param {readonly MapEntry[]} failed
 * @param {number} total
 * @returns {string}
 */
function describeFailedFiles(failed, total) {
  const named = failed.slice(0, MAX_NAMED_FAILURES).map((entry) => `${entry.file} (${entry.status})`);
  const more = failed.length > named.length ? ` and ${failed.length - named.length} more` : '';
  return `${failed.length} of ${total} files failed: ${named.join(', ')}${more}`;
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function safeFileName(relativePath) {
  return relativePath.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(-80) || 'file';
}
