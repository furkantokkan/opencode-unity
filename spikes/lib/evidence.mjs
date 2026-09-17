// Check recording and redacted evidence files for spikes. Evidence may contain sandbox paths, the OS
// user name or the machine name (OpenCode prints `username` in `debug config`), so every string is
// redacted before it is written, and the write fails if anything personal survives.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RESULTS_DIR = path.join(SPIKES_DIR, 'results');
const REPO_DIR = path.resolve(SPIKES_DIR, '..');

/**
 * @typedef {{ name: string, pass: boolean, detail?: unknown }} Check
 * @typedef {'pass' | 'fail' | 'partial' | 'manual-pending'} Outcome
 */

export class CheckList {
  constructor() {
    /** @type {Check[]} */
    this.checks = [];
  }

  /**
   * @param {string} name
   * @param {boolean} pass
   * @param {unknown} [detail]
   */
  add(name, pass, detail) {
    this.checks.push({ name, pass: Boolean(pass), detail });
    const mark = pass ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${mark}] ${name}\n`);
    return Boolean(pass);
  }

  get allPass() {
    return this.checks.every((check) => check.pass);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Variants of a path as it may appear in output: native, forward slashes, file URL and JSON-escaped
 * once or twice (a log line that is JSON itself and then stored inside the evidence JSON).
 * @param {string} value
 */
function pathVariants(value) {
  const forward = value.replace(/\\/g, '/');
  const variants = new Set([
    value,
    forward,
    value.replace(/\\/g, '\\\\'),
    value.replace(/\\/g, '\\\\\\\\'),
    encodeURI(forward),
  ]);
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * @param {string} text
 * @param {Array<[string, string]>} extraPairs  [literal, placeholder], longest first wins.
 */
export function redactText(text, extraPairs = []) {
  const user = os.userInfo().username;
  const pairs = [
    ...extraPairs,
    [REPO_DIR, '<repo>'],
    [os.tmpdir(), '<tmp>'],
    [os.homedir(), '<home>'],
  ];
  let result = text;
  for (const [literal, placeholder] of pairs) {
    for (const variant of pathVariants(literal)) {
      result = result.replace(new RegExp(escapeRegExp(variant), 'gi'), placeholder);
    }
  }
  if (user.length >= 3) result = result.replace(new RegExp(escapeRegExp(user), 'gi'), '<user>');
  const host = os.hostname();
  if (host.length >= 3) result = result.replace(new RegExp(escapeRegExp(host), 'gi'), '<host>');
  return result;
}

/**
 * @param {string} spikeId
 * @param {unknown} data
 * @param {Array<[string, string]>} [extraPairs]
 */
export async function writeEvidence(spikeId, data, extraPairs = []) {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const text = redactText(`${JSON.stringify(data, null, 2)}\n`, extraPairs);
  const user = os.userInfo().username;
  if (user.length >= 3 && text.toLowerCase().includes(user.toLowerCase())) {
    throw new Error(`evidence for ${spikeId} still contains the OS user name`);
  }
  const file = path.join(RESULTS_DIR, `${spikeId}.json`);
  await fs.writeFile(file, text);
  return file;
}

/**
 * Keeps the tail of long output for evidence.
 * @param {string} text
 * @param {number} [max]
 */
export function tail(text, max = 1500) {
  return text.length <= max ? text : `...${text.slice(-max)}`;
}
