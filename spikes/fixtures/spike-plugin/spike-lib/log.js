// Relative lib module of the spike plugin. Spike B replaces this file with a syntax error to prove
// that a broken lib module leaves the provider uninjected.
import fs from 'node:fs';

/**
 * @param {string | undefined} file
 * @param {Record<string, unknown>} entry
 */
export function appendLog(file, entry) {
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}
