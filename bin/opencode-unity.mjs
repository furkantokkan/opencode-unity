#!/usr/bin/env node
// Checked before importing the CLI so an old Node prints a clear message instead of a syntax error.
const MIN_NODE_MAJOR = 22;
const EXIT_UNSUPPORTED = 8;

const nodeMajor = Number.parseInt(process.versions.node, 10);
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(`opencode-unity needs Node ${MIN_NODE_MAJOR} or newer; this is Node ${process.versions.node}\n`);
  process.exitCode = EXIT_UNSUPPORTED;
} else {
  const { main } = await import('../src/cli/main.js');
  // exitCode instead of process.exit lets buffered stdout reach a pipe before the process ends.
  process.exitCode = await main(process.argv.slice(2), { installSignals: true });
}
