import { usageError } from '../cli/exit-codes.js';
import { loadConfig, writeConfigFile } from '../core/config.js';
import { readLedger, renderLedgerText, summarizeLedger } from './ledger.js';
import { readDelegateStatus, renderDelegateStatus, watchDelegate } from './monitor.js';
import { openDelegateWindow } from '../terminal/delegate-window.js';

/**
 * Control and history commands never load a profile or call Ollama; they work while delegation is off.
 * @param {import('../cli/main.js').CommandContext} cli
 * @param {import('../core/paths.js').HomePaths} paths
 * @param {{ now?: () => number }} [dependencies]
 * @returns {Promise<import('../cli/main.js').CommandResult>}
 */
export async function runDelegateControl(cli, paths, { now = Date.now } = {}) {
  const command = cli.subcommand;
  if (command === 'ledger') {
    const summary = summarizeLedger(await readLedger(paths.delegateLedger), { since: /** @type {string | undefined} */ (cli.options.since), now });
    return { data: { ledgerPath: paths.delegateLedger, ...summary }, message: renderLedgerText(summary, paths.delegateLedger) };
  }
  if (command === 'status') {
    const data = await readDelegateStatus(paths, { now });
    return { data, message: renderDelegateStatus(data) };
  }
  if (command === 'on' || command === 'off' || cli.options.auto !== undefined) {
    if (cli.options.window === true || cli.options.interval !== undefined) throw usageError('--auto cannot be combined with --window or --interval');
    const { user, config } = await loadConfig(paths.config);
    const key = command === 'monitor' ? 'monitorWindow' : 'enabled';
    const value = command === 'monitor' ? cli.options.auto === 'on' : command === 'on';
    const document = { ...user, schemaVersion: config.schemaVersion, delegate: { .../** @type {object} */ (user.delegate ?? {}), [key]: value } };
    if (!cli.global.dryRun) await writeConfigFile(paths.config, document);
    return { data: { key, value, configPath: paths.config, dryRun: cli.global.dryRun },
      message: `${cli.global.dryRun ? 'Would set' : 'Set'} delegate.${key} = ${value}. ${key === 'enabled' && !value ? 'New jobs are refused; existing jobs may finish.' : 'Preference survives new sessions.'}` };
  }
  if (cli.global.dryRun) return { message: 'Would open the delegate monitor; no window started.' };
  if (cli.options.window === true) {
    const result = await openDelegateWindow({ paths, env: cli.env, platform: cli.platform });
    return { data: result, message: result.message };
  }
  return watchDelegate(cli, paths);
}
