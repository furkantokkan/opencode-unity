// Advisory routing from explicit host declarations. This lane never creates a job, contacts Ollama,
// acquires the GPU lock or recovers apply journals. Normal job guards still run at execution time.
import { usageError } from '../cli/exit-codes.js';
import { toList } from './ask.js';
import { loadSourceFiles, readTaskText, resolveFileArgs } from './files.js';
import { findProtectedEditGlob } from './protected-files.js';
import { buildAskMessages, buildEditMessages, buildMapMessages, estimateMessageTokens, getDelegatePromptBudget } from './prompts.js';

// A conservative routing heuristic, not a measured break-even point or a savings claim.
const MIN_SOURCE_CHARS = 8_000;
const ELIGIBLE_KINDS = new Set(['summary', 'inventory', 'mechanical-edit', 'draft']);

/** @param {import('../commands/delegate.js').DelegateContext} context */
export async function runPlan(context) {
  const { options, budget } = context;
  const kind = String(options.kind ?? 'unknown');
  const verification = String(options.verification ?? 'unknown');
  const base = { kind, verification, advisory: true, minSourceChars: MIN_SOURCE_CHARS };
  if (!ELIGIBLE_KINDS.has(kind)) return decision(base, 'host', 'host_task', 'This task category belongs to the host.');
  if (options.toolSufficient) return decision(base, 'host', 'use_tool', 'Use the existing search, parser or script.');
  if (options.sourceRead) return decision(base, 'host', 'source_already_read', 'The host already has the source context; handing it off duplicates work.');
  if (verification !== 'targeted') return decision(base, 'host', 'review_cost', 'Define a targeted verification method first; full or unknown review can erase the benefit.');

  const task = await readTaskText(/** @type {string} */ (options.task), context);
  const args = toList(options.files);
  if (args.length === 0) throw usageError('delegate plan needs --files');
  const paths = await resolveFileArgs(args, context.cwd, { platform: context.platform, env: context.env });
  const { files, warnings } = await loadSourceFiles(paths, context.cwd, { matcher: context.matcher, strict: true });
  if (files.length === 0) throw usageError('No usable files for delegate plan');
  const facts = { ...base, files: files.map((file) => file.relativePath), fileCount: files.length, sourceChars: files.reduce((total, file) => total + file.text.length, 0) };
  if (files.some((file) => findProtectedEditGlob(file.relativePath, context.config.safety.extraProtectedEditGlobs))) {
    return decision(facts, 'host', 'protected_file', 'Keep protected Unity and project files with the host.');
  }
  if (facts.sourceChars < MIN_SOURCE_CHARS) return decision(facts, 'host', 'small_input', 'This source is below the conservative labor threshold.');

  const edit = kind === 'mechanical-edit';
  const measure = (/** @type {import('./prompts.js').ChatMessage[]} */ messages) => estimateMessageTokens(messages, budget.charsPerToken, budget.safetyMargin);
  const combined = measure(edit ? buildEditMessages(task, files) : buildAskMessages(task, files));
  const promptBudgetTokens = getDelegatePromptBudget(budget);
  const measured = { ...facts, combinedPromptTokensEstimate: combined, promptBudgetTokens };
  if (combined <= promptBudgetTokens) {
    return decision({ ...measured, plannedRequests: 1 }, edit ? 'edit' : 'ask', 'bounded_task', 'The declared task and source fit one request; run health before handing it off.', warnings);
  }
  if (edit || !(kind === 'inventory' || options.independent === true)) {
    return decision(measured, 'host', 'needs_scoping', 'The combined prompt is too large; scope the task without losing cross-file dependencies.');
  }
  const oversized = files.filter((file) => measure(buildMapMessages(task, file)) > promptBudgetTokens);
  if (oversized.length > 0) {
    return decision({ ...measured, oversizedFiles: oversized.map((file) => file.relativePath) }, 'host', 'file_too_large', 'At least one file cannot fit a map request; extract relevant sections first.');
  }
  return decision({ ...measured, plannedRequests: files.length }, 'map', 'independent_files', 'Each file fits independently. Review the request count; omit reduce unless a combined answer is required.', warnings);
}

/**
 * @param {Record<string, unknown>} facts
 * @param {'host' | 'ask' | 'map' | 'edit'} route
 * @param {string} reason
 * @param {string} message
 * @param {string[]} [warnings]
 */
function decision(facts, route, reason, message, warnings = []) {
  return {
    message: `${route}: ${message}`,
    data: { ...facts, route, reason, orchestratorAction: route === 'host' ? 'do_it_yourself' : 'check_health', modelCalled: false },
    warnings,
  };
}
