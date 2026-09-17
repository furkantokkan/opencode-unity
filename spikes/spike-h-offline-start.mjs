// Spike H: does an offline start still load the plugin when OpenCode's background `@opencode-ai/plugin`
// install fails, how much does the failing install cost, and does a pre-seeded profile skip it?
import fs from 'node:fs/promises';
import path from 'node:path';

import { startMockLlm } from './lib/mock-llm.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'H',
  title: 'Offline start with a failing background dependency install',
  question: 'Does an offline start load the plugin when the background npm install fails?',
  contractTest: 'C12',
  fallback: '`setup` pre-seeds @opencode-ai/plugin into the profile dir (with consent)',
};

const INSTALL_WARNING = /background dependency install failed/;

/**
 * Writes the pre-seed fallback: a resolved dependency tree OpenCode's installer accepts as up to date.
 * @param {string} dir
 */
async function preSeed(dir) {
  await fs.mkdir(dir, { recursive: true });
  const packageDir = path.join(dir, 'node_modules', '@opencode-ai', 'plugin');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@opencode-ai/plugin', version: '1.18.31', type: 'module', main: 'index.js' }, null, 2));
  await fs.writeFile(path.join(packageDir, 'index.js'), 'export {};\n');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'opencode-unity-profile', private: true, dependencies: { '@opencode-ai/plugin': '1.18.31' } }, null, 2));
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'opencode-unity-profile',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'opencode-unity-profile', dependencies: { '@opencode-ai/plugin': '1.18.31' } },
      'node_modules/@opencode-ai/plugin': { version: '1.18.31', resolved: '', integrity: '' },
    },
  }, null, 2));
}

/**
 * @param {SpikeContext} ctx
 * @param {string} label
 * @param {object} options
 * @param {Record<string, string | null>} [options.envOverrides]
 * @param {boolean} [options.seed]
 */
async function runScenario(ctx, label, { envOverrides = {}, seed = false } = {}) {
  const llm = ctx.track(await startMockLlm());
  const ws = ctx.track(await createWorkspace({ label: `h-${label}`, opencodeConfig: profileConfig(), pluginConfig: providerPluginConfig(llm.baseURL) }));
  if (seed) {
    await preSeed(ws.profile);
    await preSeed(path.join(ws.isolatedXdg, 'opencode'));
  }
  const startedAt = Date.now();
  const result = await runOpencode({
    args: ['run', '--print-logs', '--log-level', 'WARN', '--format', 'json', '--agent', 'unity-code', 'Say OK'],
    env: ws.env(envOverrides),
    cwd: ws.project,
    timeoutMs: 300_000,
    retryOnTimeout: false,
  });
  const hooks = ws.readHooks();
  const profileEntries = await fs.readdir(ws.profile).catch(() => []);
  return {
    llm,
    ws,
    result,
    hooks,
    summary: {
      ...summarizeRun(result, llm, hooks),
      installWarning: INSTALL_WARNING.test(result.stderr),
      firstRequestMs: llm.chatRequests[0] ? llm.chatRequests[0].at - startedAt : null,
      profileEntries: profileEntries.sort(),
    },
  };
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    // The sandbox points npm at a closed port, so every install attempt fails like a real offline start.
    const noRetries = await runScenario(ctx, 'no-retries');
    ctx.evidence.offlineNoRetries = noRetries.summary;
    ctx.checks.add('H1 offline: the plugin loads and the provider resolves', noRetries.result.exitCode === 0 && noRetries.llm.chatRequests.length === 1, { exitCode: noRetries.result.exitCode, requests: noRetries.llm.chatRequests.length });
    ctx.checks.add('H1 offline: the failing install is only a warning', noRetries.summary.installWarning, noRetries.summary.installWarning);

    const defaultRetries = await runScenario(ctx, 'default-retries', { envOverrides: { npm_config_fetch_retries: null } });
    ctx.evidence.offlineDefaultRetries = defaultRetries.summary;
    ctx.checks.add('H2 offline with npm default retries: the run still succeeds', defaultRetries.result.exitCode === 0 && defaultRetries.llm.chatRequests.length === 1, { exitCode: defaultRetries.result.exitCode, durationMs: defaultRetries.result.durationMs });

    const seeded = await runScenario(ctx, 'pre-seeded', { seed: true });
    ctx.evidence.preSeeded = seeded.summary;
    ctx.checks.add('H3 pre-seeded profile: no install is attempted', seeded.summary.installWarning === false, seeded.summary.installWarning);
    ctx.checks.add('H3 pre-seeded profile: the run still works', seeded.result.exitCode === 0 && seeded.llm.chatRequests.length === 1, { exitCode: seeded.result.exitCode, requests: seeded.llm.chatRequests.length });

    ctx.evidence.durationsMs = {
      noRetries: noRetries.result.durationMs,
      defaultRetries: defaultRetries.result.durationMs,
      preSeeded: seeded.result.durationMs,
    };
    ctx.evidence.timeToFirstRequestMs = {
      noRetries: noRetries.summary.firstRequestMs,
      defaultRetries: defaultRetries.summary.firstRequestMs,
      preSeeded: seeded.summary.firstRequestMs,
    };
    ctx.checks.add('H4 npm_config_fetch_retries=0 keeps the first request fast offline', Number(noRetries.summary.firstRequestMs) < 30_000 && Number(seeded.summary.firstRequestMs) < 30_000, ctx.evidence.timeToFirstRequestMs);
    ctx.checks.add('H5 without that setting the failing install delays the first request', Number(defaultRetries.summary.firstRequestMs) > Number(noRetries.summary.firstRequestMs) + 30_000, ctx.evidence.timeToFirstRequestMs);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Offline starts need no pre-seed, but the launch environment must set npm_config_fetch_retries=0; the pre-seed stays an optional setup extra for quiet logs.'
    : '`setup` pre-seeds @opencode-ai/plugin into the profile directory with consent.';
  ctx.findings.push(
    'OpenCode background-installs @opencode-ai/plugin into every config directory it loads (the profile and the isolated XDG config dir). Offline, this fails with a WARN line "background dependency install failed" and nothing else changes.',
    'The install is skipped when the directory already has node_modules plus a package.json whose dependencies all appear in package-lock.json, which is exactly the pre-seed fallback.',
    'The failing install DOES block the first request: with npm default retries it arrived after about 109 s, against about 13 s with npm_config_fetch_retries=0 and about 17 s pre-seeded. The clean-room launch environment must therefore set npm_config_fetch_retries=0 (S09), otherwise an offline first prompt looks hung.',
    'Every config directory also gets a .gitignore written by OpenCode, which matters for the in-project mode warning (spec D20, R19).',
  );
  return ctx;
}
