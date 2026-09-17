// JSON with comments, for files people edit by hand (config.json, opencode.jsonc). Comments and trailing
// commas are replaced with spaces instead of being removed, so JSON.parse error positions still point at
// the original line and column.

export class JsonParseError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number, cause?: unknown }} [details]
   */
  constructor(message, { line, column, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JsonParseError';
    this.line = line;
    this.column = column;
  }
}

/**
 * @param {string} text
 * @param {string} [source]  Label used in error messages, usually the file path.
 * @returns {unknown}
 */
export function parseJsonc(text, source = 'input') {
  const cleaned = stripJsonComments(stripBom(text));
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(detail);
    if (!position) throw new JsonParseError(`${source}: invalid JSON: ${detail}`, { cause: error });
    const { line, column } = getLineAndColumn(cleaned, Number(position[1]));
    throw new JsonParseError(`${source}: invalid JSON at line ${line}, column ${column}: ${detail}`, { line, column, cause: error });
  }
}

/**
 * Replaces `//` and `/* *\/` comments and trailing commas outside strings with spaces. Line breaks inside
 * comments are kept.
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  /** @type {string[]} */
  const out = [];
  let pendingCommaIndex = -1;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      const end = findStringEnd(text, index);
      out.push(text.slice(index, end));
      pendingCommaIndex = -1;
      index = end;
    } else if (char === '/' && next === '/') {
      const newline = text.indexOf('\n', index);
      const end = newline === -1 ? text.length : newline;
      out.push(blankOut(text.slice(index, end)));
      index = end;
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close === -1) throw new JsonParseError(`unterminated block comment at line ${getLineAndColumn(text, index).line}`);
      out.push(blankOut(text.slice(index, close + 2)));
      index = close + 2;
    } else if (char === ',') {
      pendingCommaIndex = out.length;
      out.push(char);
      index += 1;
    } else {
      if ((char === '}' || char === ']') && pendingCommaIndex !== -1) out[pendingCommaIndex] = ' ';
      if (!/\s/.test(char)) pendingCommaIndex = -1;
      out.push(char);
      index += 1;
    }
  }
  return out.join('');
}

/**
 * @param {string} text
 * @returns {string}
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Stable, readable JSON for files we write: two-space indent and a final newline.
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {string} text
 * @param {number} start  Index of the opening quote.
 * @returns {number} Index after the closing quote, or the text length when the string never closes.
 */
function findStringEnd(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

/**
 * @param {string} text
 * @returns {string}
 */
function blankOut(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

/**
 * @param {string} text
 * @param {number} position
 * @returns {{ line: number, column: number }}
 */
function getLineAndColumn(text, position) {
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return { line, column };
}
