// Human and machine output. With --json, stdout carries exactly one envelope and every human line goes
// to stderr, so `opencode-unity <cmd> --json | consumer` always receives valid JSON.
import { formatEnvelope } from './envelope.js';

/**
 * @typedef {object} TextStream
 * @property {(text: string) => unknown} write
 * @property {boolean} [isTTY]
 */

const ANSI = Object.freeze({
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
});

/**
 * @typedef {{ [K in keyof typeof ANSI]: (text: string) => string }} Painter
 */

/**
 * @param {object} input
 * @param {TextStream | undefined} input.stream   The stream the colored text goes to.
 * @param {Record<string, string | undefined>} input.env
 * @param {boolean} [input.noColor]               The --no-color flag.
 * @returns {boolean}
 */
export function shouldUseColor({ stream, env, noColor = false }) {
  if (noColor) return false;
  // https://no-color.org: any non-empty NO_COLOR value disables color.
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

/**
 * @param {boolean} enabled
 * @returns {Painter}
 */
export function createPainter(enabled) {
  const entries = Object.entries(ANSI).map(([name, [open, close]]) => [
    name,
    enabled ? (/** @type {string} */ text) => `[${open}m${text}[${close}m` : (/** @type {string} */ text) => text,
  ]);
  return /** @type {Painter} */ (Object.fromEntries(entries));
}

/**
 * @typedef {object} OutputOptions
 * @property {TextStream} stdout
 * @property {TextStream} stderr
 * @property {boolean} [json]
 * @property {boolean} [verbose]
 * @property {boolean} [color]
 */

/**
 * @typedef {object} Output
 * @property {boolean} json
 * @property {boolean} verbose
 * @property {Painter} paint
 * @property {(line?: string) => void} text     Human text: stdout, or stderr under --json.
 * @property {(line: string) => void} warn      'warning:' line on stderr.
 * @property {(line: string) => void} error     'error:' line on stderr.
 * @property {(line: string) => void} hint      'hint:' line on stderr, the next step after an error.
 * @property {(line: string) => void} debug     stderr, only with --verbose.
 * @property {(envelope: import('./envelope.js').Envelope) => void} envelope  One JSON line on stdout.
 */

/**
 * @param {OutputOptions} options
 * @returns {Output}
 */
export function createOutput({ stdout, stderr, json = false, verbose = false, color = false }) {
  const paint = createPainter(color);
  const humanStream = json ? stderr : stdout;
  return {
    json,
    verbose,
    paint,
    text(line = '') {
      humanStream.write(`${line}\n`);
    },
    warn(line) {
      stderr.write(`${paint.yellow('warning:')} ${line}\n`);
    },
    error(line) {
      stderr.write(`${paint.red('error:')} ${line}\n`);
    },
    hint(line) {
      stderr.write(`${paint.dim('hint:')} ${line}\n`);
    },
    debug(line) {
      if (verbose) stderr.write(`${paint.dim(line)}\n`);
    },
    envelope(envelope) {
      stdout.write(formatEnvelope(envelope));
    },
  };
}
