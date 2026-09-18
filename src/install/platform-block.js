// The platform block `setup` prints before it asks for anything (amendment 38.3, 5.4 `setup`). It exists
// so nobody agrees to a 19 GiB download and then finds out their machine is on an experimental row: the
// tier, what it cannot measure and why come first, and only then does the first question appear.
//
// `doctor` prints the same block as its first section (S38), which is why the rendering lives here rather
// than inside the setup command.
import { describePlatform, resolveTier, resolveTiers } from '../core/platform.js';

/** The commands a person is about to use if they continue; the rest of the matrix is doctor's job. */
export const SETUP_BLOCK_COMMANDS = Object.freeze(['setup', 'init', 'start', 'doctor']);

/**
 * @typedef {import('../core/platform.js').PlatformFacts} PlatformFacts
 * @typedef {import('../core/platform.js').TierResult} TierResult
 */

/**
 * @param {PlatformFacts} facts
 * @param {{ commands?: readonly string[], tiers?: Record<string, any> }} [options]
 * @returns {string[]} Lines, without a trailing blank.
 */
export function renderPlatformBlock(facts, { commands = SETUP_BLOCK_COMMANDS, tiers } = {}) {
  const resolved = resolveTiers(facts, tiers ? { tiers } : {});
  const lines = ['Platform support', `  system        ${facts.os} ${facts.arch} (${facts.release})`, `  accelerator   ${describeBackend(facts.backend)}`];
  if (facts.virtualization) lines.push(`  virtualized   ${facts.virtualization} (${facts.virtualizationSignals.join(', ') || 'detected'})`);
  for (const command of commands) {
    const result = resolved[command];
    if (!result) continue;
    lines.push(`  ${command.padEnd(13)} ${describeTier(result)}`);
  }
  const notMeasured = collectNotMeasured(resolved, commands);
  if (notMeasured.length > 0) lines.push(`  not measured  ${notMeasured.join(', ')}`);
  for (const sentence of collectReasons(resolved, commands)) lines.push(`  ${sentence}`);
  return lines;
}

/**
 * The `data.platform` object for the JSON envelope, with one row per command in the block so a machine
 * reader sees exactly what the text said.
 * @param {PlatformFacts} facts
 * @param {{ command?: string, commands?: readonly string[], tiers?: Record<string, any> }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildPlatformData(facts, { command = 'setup', commands = SETUP_BLOCK_COMMANDS, tiers } = {}) {
  const options = tiers ? { tiers } : {};
  const resolved = resolveTiers(facts, options);
  return {
    ...describePlatform(facts, resolveTier(command, facts, options)),
    release: facts.release,
    virtualization: facts.virtualization,
    commands: Object.fromEntries(
      commands
        .filter((name) => resolved[name] !== undefined)
        .map((name) => [name, { tier: resolved[name].tier, degraded: resolved[name].degraded, reason: resolved[name].reason }]),
    ),
  };
}

/**
 * An experimental tier is not refused - the matrix calls the machine usable - but nobody should install
 * onto one without saying so first. `--experimental` is the same acknowledgement in flag form, and
 * `--yes` deliberately is not (amendment 38.3).
 * @param {TierResult} result
 * @returns {boolean}
 */
export function needsTierAcknowledgement(result) {
  return result.tier === 'experimental';
}

/**
 * @param {TierResult} result
 * @returns {string}
 */
export function describeTier(result) {
  const notes = [];
  if (result.degraded && result.tier !== 'degraded') notes.push('degraded');
  if (result.noShippedPreset) notes.push('no shipped preset');
  if (result.experimentalBackend) notes.push('experimental accelerator backend');
  return notes.length > 0 ? `${result.tier} (${notes.join(', ')})` : result.tier;
}

/**
 * @param {import('../core/platform.js').AcceleratorBackend} backend
 * @returns {string}
 */
export function describeBackend(backend) {
  if (backend === 'none') return 'none detected (CPU only)';
  if (backend === 'unknown') return 'not determined';
  return backend;
}

/**
 * @param {Record<string, TierResult>} resolved
 * @param {readonly string[]} commands
 * @returns {string[]}
 */
function collectNotMeasured(resolved, commands) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const command of commands) for (const id of resolved[command]?.notMeasured ?? []) ids.add(id);
  return [...ids].sort();
}

/**
 * @param {Record<string, TierResult>} resolved
 * @param {readonly string[]} commands
 * @returns {string[]}
 */
function collectReasons(resolved, commands) {
  /** @type {Set<string>} */
  const sentences = new Set();
  for (const command of commands) {
    const result = resolved[command];
    if (result?.message) sentences.add(result.message);
    if (result?.note) sentences.add(result.note);
  }
  return [...sentences];
}
