// The untrusted-content sanitiser (amendment 35.10 and `DN15`/`DN27`, expansion 12.8.5).
//
// Everything this product hands the model from outside itself is data. A fetched page, a repository
// file, the stdout of an allowed command and a Unity console line are all written by someone who is
// not the user, so all four go through this module before the model sees them.
//
// Two modes, because one would be wrong:
//   rewriting   network bodies, command output, console lines. The full treatment: markup and its
//               comments removed, JSON re-serialised, hidden characters stripped, markdown and URL
//               syntax neutralised, whitespace collapsed, capped.
//   preserving  source the model has to reproduce byte for byte, which is most of what `read`
//               returns. Fenced and labelled but not rewritten: only the character classes that
//               cannot appear legitimately in source are removed. A wrapper that corrupts the file
//               the model is about to edit is a wrapper that gets switched off.
//
// Ordering is load-bearing. Markup is stripped before entities are decoded, so `&lt;script&gt;`
// stays inert text instead of becoming a tag; entities are decoded before hidden characters are
// stripped, so `&#x202E;` is removed rather than delivered.

/** Characters handed to the model after sanitising (`DN15`). Stays below the agent's `tool_output` cap. */
export const DEFAULT_MAX_OUTPUT_CHARS = 8192;

/** A JSON string value longer than this is replaced by a count (expansion 12.8.5 step 2). */
export const MAX_JSON_VALUE_CHARS = 512;

/** @typedef {'rewriting' | 'preserving'} SanitizeMode */
/** @typedef {'markup' | 'json' | 'text' | 'preserved'} BodyKind */

/** @type {ReadonlyArray<SanitizeMode>} */
export const SANITIZE_MODES = Object.freeze(['rewriting', 'preserving']);

/**
 * Elements dropped with their contents: the hiding places for planted instructions, and the ones
 * OpenCode's own `webfetch` markdown path keeps.
 * @type {ReadonlySet<string>}
 */
export const STRIPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'template']);

/** Void elements have no closing tag, so entering skip mode on one would eat the rest of the page. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements that end a line of text, so extracted words do not run together. */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'option', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
]);

/**
 * The character classes step 3 removes, as code-point ranges rather than escapes. Ranges because a
 * literal control byte in a source file takes that file out of the repository's personal-data scan
 * without saying so, and an escape sequence is one editing accident away from being that byte.
 *
 * `control` is C0 without tab, newline and carriage return, then DEL and C1. The rest is the
 * zero-width set with the byte-order mark, the bidirectional controls, and the Unicode tag block.
 * @type {Readonly<Record<'control' | 'zeroWidth' | 'bidi' | 'tags', ReadonlyArray<readonly number[]>>>}
 */
export const HIDDEN_RANGES = Object.freeze({
  control: Object.freeze([[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f]]),
  zeroWidth: Object.freeze([[0x200b, 0x200d], [0xfeff, 0xfeff]]),
  bidi: Object.freeze([[0x202a, 0x202e], [0x2066, 0x2069]]),
  tags: Object.freeze([[0xe0000, 0xe007f]]),
});

const REWRITING_HIDDEN = buildCharacterClass([
  ...HIDDEN_RANGES.control, ...HIDDEN_RANGES.zeroWidth, ...HIDDEN_RANGES.bidi, ...HIDDEN_RANGES.tags,
]);

// Preserving mode removes only what cannot appear legitimately in source (amendment 35.10).
const PRESERVING_HIDDEN = buildCharacterClass([
  ...HIDDEN_RANGES.zeroWidth, ...HIDDEN_RANGES.bidi, ...HIDDEN_RANGES.tags,
]);

/**
 * None of the ranges above contains a character-class metacharacter, so the bounds go in as
 * themselves.
 * @param {ReadonlyArray<readonly number[]>} ranges
 * @returns {RegExp}
 */
function buildCharacterClass(ranges) {
  const body = ranges
    .map(([low, high]) => (low === high
      ? String.fromCodePoint(low)
      : `${String.fromCodePoint(low)}-${String.fromCodePoint(high)}`))
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

/** Room kept for the truncation marker so the cap holds for the returned string, marker included. */
const TRUNCATION_RESERVE = 48;

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '-', mdash: '-',
  hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', times: 'x', copy: '(c)', reg: '(r)',
});

/**
 * @typedef {object} SanitizeResult
 * @property {string} text          The sanitised body, ready to be fenced.
 * @property {BodyKind} kind        Which path the body took.
 * @property {SanitizeMode} mode
 * @property {boolean} truncated    True when the cap cut the body.
 * @property {number} omittedChars  Characters the cap removed.
 */

/**
 * @param {object} input
 * @param {unknown} input.text                  The decoded body. A non-string is treated as empty.
 * @param {string} [input.contentType]          The `Content-Type` header, when the channel has one.
 * @param {SanitizeMode} [input.mode]
 * @param {number} [input.maxOutputChars]
 * @returns {SanitizeResult}
 */
export function sanitizeUntrusted({ text, contentType, mode = 'rewriting', maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS }) {
  const source = typeof text === 'string' ? text : '';
  if (mode === 'preserving') {
    const capped = capCharacters(stripHiddenCharacters(source, 'preserving'), maxOutputChars);
    return { text: capped.text, kind: 'preserved', mode, truncated: capped.truncated, omittedChars: capped.omitted };
  }

  const normalized = normalizeLineEndings(source);
  let kind = classifyBody(contentType, normalized);
  /** @type {string | undefined} */
  let body;
  if (kind === 'json') {
    const json = reserializeJson(normalized);
    if (json === null) kind = sniffBody(normalized) === 'markup' ? 'markup' : 'text';
    else body = json;
  }
  if (body === undefined) body = kind === 'markup' ? extractTextFromMarkup(normalized) : normalized;

  body = collapseWhitespace(neutralizeSyntax(stripHiddenCharacters(body, 'rewriting'))).trim();
  const capped = capCharacters(body, maxOutputChars);
  return { text: capped.text, kind: /** @type {BodyKind} */ (kind), mode, truncated: capped.truncated, omittedChars: capped.omitted };
}

/**
 * Which path a body takes. The declared type decides; when it is absent, generic or a lie the body
 * is sniffed, so HTML served as `text/plain` still loses its scripts.
 * @param {string} [contentType]
 * @param {string} [text]
 * @returns {'markup' | 'json' | 'text'}
 */
export function classifyBody(contentType, text = '') {
  const essence = mediaTypeEssence(contentType);
  if (essence === 'application/x-ndjson') return 'text';
  if (essence === 'application/json' || essence === 'text/json' || essence.endsWith('+json')) return 'json';
  if (essence === 'text/html' || essence === 'text/xml' || essence === 'application/xml' || essence.endsWith('+xml')) return 'markup';
  return sniffBody(text);
}

/**
 * The lowercased type and subtype, without parameters (`application/json; charset=utf-8`).
 * @param {string} [contentType]
 * @returns {string}
 */
export function mediaTypeEssence(contentType) {
  if (typeof contentType !== 'string') return '';
  const [essence] = contentType.split(';');
  return essence.trim().toLowerCase();
}

/**
 * @param {string} text
 * @returns {'markup' | 'json' | 'text'}
 */
function sniffBody(text) {
  const head = text.slice(0, 256).trimStart();
  if (head.startsWith('<')) return 'markup';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'text';
}

/**
 * Step 1: drop the dangerous elements with their contents and every comment, then extract the text.
 * Hand-written rather than regex-driven because the input is hostile: an unterminated `<script>` or
 * comment ends the document here instead of leaking its tail.
 * @param {string} markup
 * @returns {string}
 */
export function extractTextFromMarkup(markup) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let skipName = null;
  let skipDepth = 0;
  let i = 0;
  const end = markup.length;

  const keep = (/** @type {string} */ value) => {
    if (!skipName && value) out.push(value);
  };

  while (i < end) {
    const lt = markup.indexOf('<', i);
    if (lt < 0) {
      keep(decodeEntities(markup.slice(i)));
      break;
    }
    if (lt > i) keep(decodeEntities(markup.slice(i, lt)));

    if (markup.startsWith('<!--', lt)) {
      const close = markup.indexOf('-->', lt + 4);
      i = close < 0 ? end : close + 3;
      continue;
    }
    if (markup.startsWith('<![CDATA[', lt)) {
      const close = markup.indexOf(']]>', lt + 9);
      keep(markup.slice(lt + 9, close < 0 ? end : close));
      i = close < 0 ? end : close + 3;
      continue;
    }
    if (markup.startsWith('<?', lt)) {
      const close = markup.indexOf('?>', lt + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    if (markup.startsWith('<!', lt)) {
      const close = markup.indexOf('>', lt + 2);
      i = close < 0 ? end : close + 1;
      continue;
    }

    const tag = readTag(markup, lt);
    if (!tag) {
      keep('<');
      i = lt + 1;
      continue;
    }
    if (skipName) {
      if (tag.closing && tag.name === skipName) {
        skipDepth -= 1;
        if (skipDepth <= 0) skipName = null;
      } else if (!tag.closing && tag.name === skipName && !tag.selfClosing) {
        skipDepth += 1;
      }
    } else if (!tag.closing && !tag.selfClosing && STRIPPED_ELEMENTS.has(tag.name) && !VOID_ELEMENTS.has(tag.name)) {
      skipName = tag.name;
      skipDepth = 1;
    } else if (BLOCK_ELEMENTS.has(tag.name)) {
      out.push('\n');
    }
    i = tag.end;
  }

  return out.join('');
}

/**
 * @typedef {{ name: string, closing: boolean, selfClosing: boolean, end: number }} Tag
 */

/**
 * Reads one tag from `<`. Quoted attribute values are honoured, so a `<` inside an attribute cannot
 * start a second tag. An unterminated tag consumes the rest of the document.
 * @param {string} source
 * @param {number} start
 * @returns {Tag | null}
 */
function readTag(source, start) {
  let i = start + 1;
  let closing = false;
  if (source[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < source.length && isTagNameChar(source[i])) i += 1;
  if (i === nameStart) return null;
  const name = source.slice(nameStart, i).toLowerCase();

  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { name, closing, selfClosing: source[i - 1] === '/', end: i + 1 };
    }
    i += 1;
  }
  return { name, closing, selfClosing: false, end: source.length };
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isTagNameChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    || ch === '-' || ch === '_' || ch === ':' || ch === '.';
}

/**
 * Decodes the entities a text node can carry. Runs after tags are gone, so an encoded tag stays
 * inert text, and before the hidden-character strip, so an encoded bidi override is removed.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] !== '#') {
      const named = NAMED_ENTITIES[/** @type {keyof typeof NAMED_ENTITIES} */ (body.toLowerCase())];
      return named === undefined ? match : named;
    }
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    if (code >= 0xd800 && code <= 0xdfff) return '';
    return String.fromCodePoint(code);
  });
}

/**
 * Step 2: parse and re-serialise, eliding long string values. Re-serialising removes the hidden
 * whitespace framing and normalises the shape the model sees. Returns null when the body is not one
 * JSON document, and the caller falls back to markup or plain text.
 * @param {string} text
 * @param {number} [maxValueChars]
 * @returns {string | null}
 */
export function reserializeJson(text, maxValueChars = MAX_JSON_VALUE_CHARS) {
  try {
    const rendered = JSON.stringify(elideLongValues(JSON.parse(text), maxValueChars), null, 2);
    return typeof rendered === 'string' ? rendered : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {number} maxValueChars
 * @returns {unknown}
 */
function elideLongValues(value, maxValueChars) {
  if (typeof value === 'string') {
    return value.length > maxValueChars ? `<omitted ${value.length} chars>` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => elideLongValues(item, maxValueChars));
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = elideLongValues(item, maxValueChars);
    return out;
  }
  return value;
}

/**
 * Step 3. `mode` decides how much goes: rewriting also drops the control characters, preserving
 * leaves them because a tab is indentation and a source file is reproduced byte for byte.
 * @param {string} text
 * @param {SanitizeMode} mode
 * @returns {string}
 */
export function stripHiddenCharacters(text, mode = 'rewriting') {
  const pattern = mode === 'preserving' ? PRESERVING_HIDDEN : REWRITING_HIDDEN;
  pattern.lastIndex = 0;
  return text.replace(pattern, '');
}

/**
 * Step 4: markdown and URL syntax. The model can still read a URL it needs; it is no longer handed
 * one that looks actionable, a fenced block it can be told to run, or the `` !` `` opener that
 * OpenCode expands outside the tool layer (amendment 35.10 property 4).
 *
 * `@name` is counted rather than rewritten - see `scanActionableForms` in `wrap.js` for why.
 * @param {string} text
 * @returns {string}
 */
export function neutralizeSyntax(text) {
  return text
    .replace(/\]\(/g, '] (')
    .replace(/https?:\/\//gi, defangScheme)
    .replace(/`{3,}/g, '`')
    .replace(/!`/g, '! `');
}

/**
 * `http://` becomes `hxxp://`, keeping the case of the letters that stay.
 * @param {string} scheme
 * @returns {string}
 */
function defangScheme(scheme) {
  const x = scheme[1] === 'T' ? 'X' : 'x';
  return scheme[0] + x + x + scheme.slice(3);
}

/**
 * Step 5. Trailing whitespace goes first, so the blank lines a markup extractor leaves behind
 * collapse instead of surviving as lines of spaces.
 *
 * Runs of spaces are collapsed only after a non-space character: the JSON re-serialiser indents by
 * two, so a value three levels deep legitimately starts a line with six spaces, and the padding
 * this rule exists to remove is padding within a line.
 * @param {string} text
 * @returns {string}
 */
export function collapseWhitespace(text) {
  return text
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\S) {5,}/g, '$1    ');
}

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Step 6. The returned string never exceeds the cap, marker included: a cap a marker can push past
 * is not a cap, and `DN15` needs this number to stay below the agent's `tool_output` limit.
 * @param {string} text
 * @param {number} [maxOutputChars]
 * @returns {{ text: string, truncated: boolean, omitted: number }}
 */
export function capCharacters(text, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const cap = Number.isFinite(maxOutputChars) && maxOutputChars >= 0
    ? Math.floor(maxOutputChars)
    : DEFAULT_MAX_OUTPUT_CHARS;
  if (text.length <= cap) return { text, truncated: false, omitted: 0 };

  const keep = trimToCharacterBoundary(text, Math.max(0, cap - TRUNCATION_RESERVE));
  const omitted = text.length - keep;
  const candidate = `${text.slice(0, keep)}${keep > 0 ? '\n' : ''}[truncated: ${omitted} more characters]`;
  if (candidate.length <= cap) return { text: candidate, truncated: true, omitted };

  // Only reachable when the cap itself is smaller than the marker. Cut hard and let `truncated`
  // carry the fact, rather than returning more than the caller asked for.
  const hard = trimToCharacterBoundary(text, cap);
  return { text: text.slice(0, hard), truncated: true, omitted: text.length - hard };
}

/**
 * Keeps the cut off the middle of a surrogate pair, so the last character is whole.
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function trimToCharacterBoundary(text, index) {
  if (index <= 0) return 0;
  const previous = text.charCodeAt(index - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index;
}
