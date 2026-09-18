// `opencode-unity guard` (spec 5.5, 7.3): evaluate the GPU guard and print the verdict.
//
// It loads nothing and asks nothing. `--cold` judges a fresh load even when the model is already in
// video memory, which is the question `start` and `warm` really ask; without it the loaded fast path
// answers, which is what a running session sees.
//
// Exit 0 for a pass, exit 2 for a block. A blocked guard is a normal answer, not a defect, so the
// message names the reason and the one thing that clears it.
import { evaluateGuard } from '../../plugin/opencode-unity-lib/guard/evaluate.js';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { summarizeVerdict } from '../ollama/guarded-chat.js';
import { loadSession } from '../project/session.js';
import { summarizeGuardForBanner } from '../terminal/banner.js';

/**
 * @typedef {object} GuardDependencies
 * @property {import('../../plugin/opencode-unity-lib/guard/collect.js').GuardProbes} [probes]
 * @property {typeof evaluateGuard} [evaluate]
 */

/**
 * @param {import('../cli/main.js').CommandContext} cliContext
 * @param {GuardDependencies} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function run(cliContext, dependencies = {}) {
  const session = await loadSession(cliContext);
  const verdict = await evaluateGuardFor(session, { cold: cliContext.options.cold === true, signal: cliContext.signal, ...dependencies });
  const guard = summarizeVerdict(verdict);
  // Spec 5.3's envelope for this command puts the verdict, its reasons and notes at the top of `data`;
  // `guard` keeps the summary shape `status` and `delegate` share.
  const data = {
    verdict: guard.verdict,
    reasons: guard.reasons,
    notes: guard.notes,
    notMeasured: guard.notMeasured,
    guard,
    target: verdict.target,
    model: verdict.model,
    banner: summarizeGuardForBanner(verdict, session.profile.guard),
  };

  if (!cliContext.global.json) for (const line of renderVerdict(verdict)) cliContext.output.text(line);
  if (verdict.pass) return { message: `guard ${verdict.verdict} (${verdict.path} path)`, data, warnings: session.warnings };

  throw new CliError(formatBlockMessage(verdict), {
    exitCode: EXIT.BLOCKED,
    code: guard.reasons[0]?.id === 'ollama_unreachable' ? 'ollama_unreachable' : 'gpu_guard_blocked',
    data: { ...data, guardReason: guard.reasons[0]?.id ?? 'unknown' },
    hint: 'Run `opencode-unity status` to watch it clear, or free video memory and try again.',
  });
}

/**
 * The one place the guard target is built from a session, so `guard`, `status` and `start` all judge
 * the same endpoint, tag and context.
 * @param {import('../project/session.js').Session} session
 * @param {{ cold?: boolean, signal?: AbortSignal } & GuardDependencies} [options]
 * @returns {Promise<import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict>}
 */
export function evaluateGuardFor(session, { cold = false, signal, probes, evaluate = evaluateGuard } = {}) {
  const { provider, ollama, guard } = session.profile;
  return evaluate({
    target: { baseUrl: ollama.baseUrl, modelTag: provider.modelTag, numCtx: provider.numCtx },
    config: guard,
    cold,
    ...(probes ? { probes } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * @param {import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} verdict
 * @returns {string[]}
 */
export function renderVerdict(verdict) {
  const lines = [`verdict  ${verdict.verdict} (${verdict.path} path, checked ${verdict.checkedAt})`];
  lines.push(`model    ${verdict.target.modelTag} at ${verdict.target.numCtx} context, ${verdict.model.state}`);
  for (const reason of verdict.reasons) lines.push(`reason   ${reason.id}: ${reason.detail}`);
  for (const note of verdict.notes) lines.push(`note     ${note}`);
  return lines;
}

/**
 * @param {import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} verdict
 * @returns {string}
 */
function formatBlockMessage(verdict) {
  const details = verdict.reasons.map((reason) => reason.detail).join('; ');
  return details === '' ? 'The GPU guard blocked this request' : `The GPU guard blocked this request: ${details}`;
}
