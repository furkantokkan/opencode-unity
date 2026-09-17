#!/usr/bin/env node
// Runs the M0 spikes (spec 24.3) against the real OpenCode binary with sandboxed homes and loopback
// mocks, and writes redacted evidence to spikes/results/<id>.json plus summary.json.
//
//   node spikes/run-all.mjs          all spikes
//   node spikes/run-all.mjs A B K    selected spikes
import fs from 'node:fs/promises';
import path from 'node:path';

import { RESULTS_DIR, writeEvidence } from './lib/evidence.mjs';
import { TESTED_OPENCODE_VERSION, locateOpencode, runOpencode } from './lib/opencode.mjs';
import { createSandbox } from '../test/helpers/sandbox.mjs';

const SPIKES = {
  A: './spike-a-guard-throw.mjs',
  B: './spike-b-provider-injection.mjs',
  C: './spike-c-overflow-compaction.mjs',
  D: './spike-d-xdg-isolation.mjs',
  E: './spike-e-builtins-disabled.mjs',
  F: './spike-f-bash-patterns.mjs',
  G: './spike-g-models-fetch.mjs',
  H: './spike-h-offline-start.mjs',
  I: './spike-i-powershell-probe.mjs',
  J: './spike-j-mcp-tools.mjs',
  K: './spike-k-debug-introspection.mjs',
  L: './spike-l-instance-id.mjs',
  M: './spike-m-hub-endpoint.mjs',
};

async function opencodeVersion() {
  const sandbox = await createSandbox('spike-version');
  try {
    const result = await runOpencode({ args: ['--version'], env: sandbox.env, cwd: sandbox.dirs.tmp, timeoutMs: 60_000 });
    return result.stdout.trim();
  } finally {
    await sandbox.cleanup();
  }
}

async function main() {
  const requested = process.argv.slice(2).map((id) => id.toUpperCase());
  const ids = requested.length ? requested : Object.keys(SPIKES);
  locateOpencode();
  const version = await opencodeVersion();
  if (version !== TESTED_OPENCODE_VERSION) {
    process.stderr.write(`warning: spikes target OpenCode ${TESTED_OPENCODE_VERSION}, found ${version}\n`);
  }
  const summary = [];
  for (const id of ids) {
    const modulePath = SPIKES[/** @type {keyof typeof SPIKES} */ (id)];
    if (!modulePath) throw new Error(`unknown spike ${id}`);
    const spike = await import(modulePath);
    process.stdout.write(`\nSpike ${id}: ${spike.meta.title}\n`);
    const started = Date.now();
    let ctx;
    let crash = null;
    try {
      ctx = await spike.run();
    } catch (error) {
      crash = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
      process.stdout.write(`  [CRASH] ${crash}\n`);
    }
    const checks = ctx?.checks.checks ?? [];
    const outcome = crash ? 'fail' : ctx.outcome ?? (ctx.checks.allPass ? 'pass' : 'fail');
    const record = {
      spike: id,
      ...spike.meta,
      opencodeVersion: version,
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      outcome,
      decision: ctx?.decision ?? null,
      checks,
      findings: ctx?.findings ?? [],
      evidence: ctx?.evidence ?? {},
      crash,
    };
    await writeEvidence(id, record);
    summary.push({ spike: id, title: spike.meta.title, outcome, passed: checks.filter((check) => check.pass).length, total: checks.length, decision: record.decision });
    process.stdout.write(`  => ${outcome} (${checks.filter((check) => check.pass).length}/${checks.length} checks, ${Math.round(record.durationMs / 1000)} s)\n`);
  }
  const summaryPath = path.join(RESULTS_DIR, 'summary.json');
  let previous = [];
  try {
    previous = JSON.parse(await fs.readFile(summaryPath, 'utf8')).spikes ?? [];
  } catch {
    // First run.
  }
  const merged = new Map(previous.map((/** @type {any} */ entry) => [entry.spike, entry]));
  for (const entry of summary) merged.set(entry.spike, entry);
  const spikes = [...merged.values()].sort((a, b) => a.spike.localeCompare(b.spike));
  await writeEvidence('summary', { opencodeVersion: version, updatedAt: new Date().toISOString(), spikes });
}

await main();
