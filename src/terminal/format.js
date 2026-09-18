// Small formatting helpers the banner, the status view and the session summary share.
//
// Colour lives in exactly one place: a `tone` is a name for what a line means, and `paintTone` turns
// it into a painter call. With `--no-color` (or a redirected stream, or NO_COLOR) the painter is the
// identity function, so every line here is written to read correctly with no colour at all - the
// words carry the meaning and the colour only repeats it.
/** @typedef {import('../cli/output.js').Painter} Painter */

/** @typedef {'plain' | 'good' | 'warn' | 'bad' | 'dim' | 'strong'} Tone */

/** Tones that make `start` pause before the TUI covers the screen (spec 13.1 step 7). */
export const ATTENTION_TONES = Object.freeze(['warn', 'bad']);

/** @type {Readonly<Record<Tone, keyof Painter | null>>} */
const TONE_COLORS = Object.freeze({
  plain: null,
  good: 'green',
  warn: 'yellow',
  bad: 'red',
  dim: 'dim',
  strong: 'bold',
});

/**
 * @param {Painter} paint
 * @param {Tone} tone
 * @param {string} text
 * @returns {string}
 */
export function paintTone(paint, tone, text) {
  const color = TONE_COLORS[tone] ?? null;
  return color === null ? text : paint[color](text);
}

/**
 * `label` padded so every line's text starts in the same column.
 * @param {string} label
 * @param {number} [width]
 * @returns {string}
 */
export function padLabel(label, width = 9) {
  return label.length >= width ? `${label} ` : label.padEnd(width, ' ');
}

/**
 * Fields of one line, separated by two spaces so a field that contains one space still reads as one
 * field.
 * @param {ReadonlyArray<string | null | undefined | false>} fields
 * @returns {string}
 */
export function joinFields(fields) {
  return fields.filter((field) => typeof field === 'string' && field !== '').join('  ');
}

/**
 * A duration a person reads at a glance: `45s`, `13m`, `1h 5m`.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Clock time for the `status --watch` line. Local time, because the reader is at the machine.
 * @param {Date} date
 * @returns {string}
 */
export function formatClock(date) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Mebibytes as gibibytes with one decimal, the unit `nvidia-smi` reports in.
 * @param {number | null | undefined} mib
 * @returns {string}
 */
export function formatGiBOrUnknown(mib) {
  return typeof mib === 'number' && Number.isFinite(mib) ? `${(mib / 1024).toFixed(1)} GiB` : 'unknown';
}
