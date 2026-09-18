// `delegate restore <jobId>` (spec 12.2): put back the backups an apply job wrote.
import { EXIT } from '../cli/exit-codes.js';
import { describeRestoreReport, restoreJob } from './apply.js';

/**
 * @param {import('../commands/delegate.js').DelegateContext} context
 * @returns {import('../cli/main.js').CommandResult}
 */
export function runRestore(context) {
  const jobId = String(context.args.jobId ?? '').trim();
  const { report, files } = restoreJob({ resultsDir: context.resultsDir, jobId });
  const data = { jobId, files, restored: report.restored, conflicts: report.conflicts, failures: report.failures };
  if (report.failures.length > 0) {
    return { exitCode: EXIT.RUNTIME, code: 'restore_incomplete', message: `Job ${jobId}: ${describeRestoreReport(report)}`, data };
  }
  return {
    message: `Job ${jobId}: ${describeRestoreReport(report)}`,
    data,
    warnings: report.conflicts.length > 0 ? [`${report.conflicts.length} file(s) were left alone because they changed after that job wrote them.`] : [],
  };
}
