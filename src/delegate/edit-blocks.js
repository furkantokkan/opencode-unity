// SEARCH/REPLACE edit blocks: parse the model's answer and validate every block against the file it
// names (spec 12.2 `delegate edit`). Pure: no I/O, so every rule is unit-testable.
//
// A block is accepted only when its file is in the allow-list, is not a protected Unity file, its
// SEARCH text matches the current file exactly once, and its REPLACE adds no invisible character that
// the reviewed diff would hide.
import path from 'node:path';
import { pathKey } from './files.js';
import { describeProtectedEdit, findProtectedEditGlob } from './protected-files.js';
import { toPosix } from './sensitive.js';

export const SEARCH_MARKER = '<<<<<<< SEARCH';
export const DIVIDER_MARKER = '=======';
export const REPLACE_MARKER = '>>>>>>> REPLACE';

const FENCE_LINE = /^```[\w.+-]*$/;
// Control characters (a NUL turns a diff into "Binary files differ") and bidi overrides can hide code
// from the reviewed diff. They pass only when SEARCH already holds the same character.
const HIDDEN_CHARACTER_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/**
 * @typedef {object} EditBlock
 * @property {string} file     Path exactly as the model wrote it.
 * @property {string} search
 * @property {string} replace
 * @property {number} line     1-based line of the `FILE:` header in the answer.
 */

/**
 * @typedef {object} DecodedText
 * @property {boolean} bom
 * @property {'\n' | '\r\n'} eol
 * @property {boolean} mixedEol
 * @property {boolean} trailingNewline
 * @property {string} text            Line endings normalized to `\n`.
 */

/**
 * @typedef {object} AllowedFile
 * @property {string} relativePath
 * @property {string} absolutePath
 * @property {Buffer} bytes
 * @property {DecodedText} decoded
 */

/**
 * @typedef {AllowedFile & { newText: string, newBytes: Buffer }} FileChange
 */

/**
 * @param {string} responseText
 * @returns {{ blocks: EditBlock[], errors: string[] }}
 */
export function parseEditBlocks(responseText) {
  const lines = responseText.replace(/\r\n?/g, '\n').split('\n');
  /** @type {EditBlock[]} */
  const blocks = [];
  /** @type {string[]} */
  const errors = [];
  let index = 0;
  let reportedStrayText = false;
  while (index < lines.length) {
    const line = lines[index].trimEnd();
    if (line.trim() === '' || FENCE_LINE.test(line.trim())) {
      index += 1;
      continue;
    }
    const fileMatch = /^FILE:\s*(.+)$/.exec(line);
    if (!fileMatch) {
      if (!reportedStrayText) {
        errors.push(`line ${index + 1}: expected "FILE: <path>" but found "${truncate(line.trim(), 80)}". Output only edit blocks.`);
        reportedStrayText = true;
      }
      index += 1;
      continue;
    }
    reportedStrayText = false;
    const parsed = parseSingleBlock(lines, index, unquotePath(fileMatch[1]));
    if (parsed.error) errors.push(parsed.error);
    else if (parsed.block) blocks.push(parsed.block);
    index = parsed.nextIndex;
  }
  if (blocks.length === 0 && errors.length === 0) errors.push('no edit blocks found');
  return { blocks, errors };
}

/**
 * @param {Buffer} bytes
 * @returns {DecodedText}
 */
export function decodeTextFile(bytes) {
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const lfOnlyCount = (text.match(/\n/g) ?? []).length - crlfCount;
  const normalized = text.replace(/\r\n/g, '\n');
  return {
    bom,
    eol: crlfCount > 0 && crlfCount >= lfOnlyCount ? '\r\n' : '\n',
    mixedEol: crlfCount > 0 && lfOnlyCount > 0,
    trailingNewline: normalized.endsWith('\n'),
    text: normalized,
  };
}

/**
 * Writes the new text back in the file's own shape: its BOM, its line endings and whether it ended
 * with a newline. An edit must not rewrite the whole file as a line-ending change.
 * @param {DecodedText} decoded
 * @param {string} newText
 * @returns {Buffer}
 */
export function encodeTextFile(decoded, newText) {
  let text = newText;
  if (decoded.trailingNewline && !text.endsWith('\n')) text += '\n';
  if (!decoded.trailingNewline) text = text.replace(/\n+$/, '');
  if (decoded.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return Buffer.from(`${decoded.bom ? '﻿' : ''}${text}`, 'utf8');
}

/**
 * Validates every block against the allow-list and the current file contents, applying accepted blocks
 * to an in-memory copy so later blocks for the same file see the earlier ones.
 * @param {readonly EditBlock[]} blocks
 * @param {Map<string, AllowedFile>} allowlist  Keyed by `pathKey(relativePath)`.
 * @param {string} cwd
 * @param {{ platform?: NodeJS.Platform, extraProtectedEditGlobs?: readonly string[] }} [options]
 * @returns {{ changes: FileChange[], errors: string[], warnings: string[] }}
 */
export function validateEditBlocks(blocks, allowlist, cwd, { platform = process.platform, extraProtectedEditGlobs = [] } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, string>} */
  const working = new Map();
  for (const block of blocks) {
    const target = resolveEditTarget(block, cwd, allowlist, platform, extraProtectedEditGlobs);
    if (!target.entry) {
      errors.push(/** @type {string} */ (target.error));
      continue;
    }
    const entry = target.entry;
    const key = pathKey(entry.relativePath, platform);
    const content = working.get(key) ?? entry.decoded.text;
    const search = block.search.replace(/\r\n?/g, '\n');
    const replace = block.replace.replace(/\r\n?/g, '\n');
    const label = `${entry.relativePath} (block at answer line ${block.line})`;
    const hidden = findHiddenCharacter(replace, search);
    if (hidden) {
      errors.push(`${label}: REPLACE contains the invisible control character ${hidden}; write plain text (tabs and line breaks are fine)`);
      continue;
    }
    if (search.trim() === '') {
      if (content.trim() !== '') {
        errors.push(`${label}: SEARCH must contain existing non-blank text; only a file listed as (empty) takes an empty SEARCH`);
      } else if (replace.trim() === '') {
        errors.push(`${label}: SEARCH and REPLACE are both empty; remove blocks that change nothing`);
      } else {
        working.set(key, replace);
      }
      continue;
    }
    if (search === replace) {
      errors.push(`${label}: SEARCH and REPLACE are identical; remove blocks that change nothing`);
      continue;
    }
    const positions = findOccurrences(content, search);
    if (positions.length === 0) {
      errors.push(`${label}: ${describeMissingSearch(content, search)}`);
      continue;
    }
    if (positions.length > 1) {
      const lines = positions.slice(0, 5).map((position) => lineNumberAt(content, position));
      errors.push(`${label}: SEARCH occurs ${positions.length} times (lines ${lines.join(', ')}); include more surrounding lines so it matches exactly once`);
      continue;
    }
    working.set(key, replaceMatch(content, positions[0], search, replace));
  }

  /** @type {FileChange[]} */
  const changes = [];
  for (const [key, newText] of working) {
    const entry = allowlist.get(key);
    if (!entry) continue;
    // A file that was empty gets a final newline instead of inheriting "no trailing newline".
    const encoding = entry.decoded.text.trim() === '' ? { ...entry.decoded, trailingNewline: true } : entry.decoded;
    const newBytes = encodeTextFile(encoding, newText);
    if (newBytes.equals(entry.bytes)) continue;
    if (entry.decoded.mixedEol) warnings.push(`${entry.relativePath} had mixed line endings; they are now ${entry.decoded.eol === '\r\n' ? 'CRLF' : 'LF'}`);
    changes.push({ ...entry, newText, newBytes });
  }
  if (errors.length === 0 && blocks.length > 0 && changes.length === 0) errors.push('the edit blocks change no file');
  return { changes, errors, warnings };
}

/**
 * @param {string[]} lines
 * @param {number} fileLineIndex
 * @param {string} file
 * @returns {{ block?: EditBlock, error?: string, nextIndex: number }}
 */
function parseSingleBlock(lines, fileLineIndex, file) {
  const at = `edit block for ${file} (line ${fileLineIndex + 1})`;
  if (lines[fileLineIndex + 1]?.trimEnd() !== SEARCH_MARKER) {
    return { error: `${at}: the line after FILE must be exactly "${SEARCH_MARKER}"`, nextIndex: fileLineIndex + 1 };
  }
  /** @type {string[]} */
  const search = [];
  let index = fileLineIndex + 2;
  while (index < lines.length && lines[index].trimEnd() !== DIVIDER_MARKER) {
    const marker = lines[index].trimEnd();
    if (marker === REPLACE_MARKER || marker === SEARCH_MARKER || startsEditBlock(lines, index)) {
      return { error: `${at}: missing "${DIVIDER_MARKER}" line`, nextIndex: index };
    }
    search.push(lines[index]);
    index += 1;
  }
  if (index >= lines.length) return { error: `${at}: missing "${DIVIDER_MARKER}" line`, nextIndex: index };
  /** @type {string[]} */
  const replace = [];
  index += 1;
  while (index < lines.length && lines[index].trimEnd() !== REPLACE_MARKER) {
    const marker = lines[index].trimEnd();
    if (marker === SEARCH_MARKER) return { error: `${at}: missing "${REPLACE_MARKER}" line`, nextIndex: index };
    if (marker === DIVIDER_MARKER) {
      // A second divider makes the SEARCH/REPLACE split ambiguous, and guessing could scramble the file.
      return {
        error: `${at}: more than one "${DIVIDER_MARKER}" line; SEARCH and REPLACE cannot contain a bare "${DIVIDER_MARKER}" line, so choose a SEARCH that avoids it`,
        nextIndex: skipPastReplace(lines, index),
      };
    }
    replace.push(lines[index]);
    index += 1;
  }
  if (index >= lines.length) return { error: `${at}: missing "${REPLACE_MARKER}" line`, nextIndex: index };
  return { block: { file, search: search.join('\n'), replace: replace.join('\n'), line: fileLineIndex + 1 }, nextIndex: index + 1 };
}

/**
 * A `FILE: ` line inside file content (documentation about this format, a log) is not a block start
 * unless a SEARCH marker follows it.
 * @param {string[]} lines
 * @param {number} index
 * @returns {boolean}
 */
function startsEditBlock(lines, index) {
  return /^FILE:\s/.test(lines[index]) && lines[index + 1]?.trimEnd() === SEARCH_MARKER;
}

/**
 * @param {string[]} lines
 * @param {number} index
 * @returns {number}
 */
function skipPastReplace(lines, index) {
  let next = index;
  while (next < lines.length && lines[next].trimEnd() !== REPLACE_MARKER) next += 1;
  return Math.min(lines.length, next + 1);
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquotePath(value) {
  return value.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

/**
 * @param {EditBlock} block
 * @param {string} cwd
 * @param {Map<string, AllowedFile>} allowlist
 * @param {NodeJS.Platform} platform
 * @param {readonly string[]} extraProtectedEditGlobs
 * @returns {{ entry?: AllowedFile, error?: string }}
 */
function resolveEditTarget(block, cwd, allowlist, platform, extraProtectedEditGlobs) {
  const requested = toPosix(block.file).replace(/^(\.\/)+/, '');
  const absolutePath = path.resolve(cwd, requested);
  if (path.isAbsolute(requested) || requested.split('/').includes('..') || !isInside(absolutePath, cwd)) {
    return { error: `FILE "${block.file}" must be a relative path inside the working directory (no absolute path and no "..")` };
  }
  const relativePath = toPosix(path.relative(cwd, absolutePath));
  // Checked here as well as when the allow-list is built, so the guarantee holds for any caller that
  // assembled an allow-list itself: S4's third enforcement point may not depend on one builder.
  const protectedGlob = findProtectedEditGlob(relativePath, extraProtectedEditGlobs);
  if (protectedGlob) return { error: `FILE "${block.file}": ${describeProtectedEdit(relativePath, protectedGlob)}` };
  const entry = allowlist.get(pathKey(relativePath, platform));
  if (!entry) {
    const allowed = [...allowlist.values()].map((item) => item.relativePath).join(', ');
    return { error: `FILE "${block.file}" is not in the allow-list (${allowed})` };
  }
  return { entry };
}

/**
 * @param {string} absolutePath
 * @param {string} directory
 * @returns {boolean}
 */
function isInside(absolutePath, directory) {
  const relative = path.relative(directory, absolutePath);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * @param {string} replace
 * @param {string} search
 * @returns {string | null}  The code point name, for example `U+0000`.
 */
function findHiddenCharacter(replace, search) {
  for (const [char] of replace.matchAll(HIDDEN_CHARACTER_PATTERN)) {
    if (!search.includes(char)) return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return null;
}

/**
 * @param {string} content
 * @param {string} search
 * @returns {number[]}
 */
function findOccurrences(content, search) {
  /** @type {number[]} */
  const positions = [];
  let position = content.indexOf(search);
  while (position >= 0) {
    positions.push(position);
    position = content.indexOf(search, position + 1);
  }
  return positions;
}

/**
 * @param {string} content
 * @param {number} position
 * @returns {number}
 */
function lineNumberAt(content, position) {
  let line = 1;
  for (let index = 0; index < position; index += 1) if (content.charCodeAt(index) === 10) line += 1;
  return line;
}

/**
 * Why the SEARCH text was not found, so the retry prompt can name the real mistake.
 * @param {string} content
 * @param {string} search
 * @returns {string}
 */
function describeMissingSearch(content, search) {
  const searchLines = search.split('\n').filter((line) => line.trim() !== '');
  if (searchLines.length > 0 && searchLines.every((line) => /^\s*\d+\| ?/.test(line))) {
    return 'SEARCH includes the "N| " line-number prefixes; copy the file text without them';
  }
  const squash = (/** @type {string} */ text) => text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  if (searchLines.length > 0 && squash(content).includes(squash(search))) {
    return 'SEARCH matches only when indentation or blank lines are ignored; copy the exact text from the file';
  }
  const firstLine = searchLines[0]?.trim() ?? '';
  /** @type {number[]} */
  const hits = [];
  content.split('\n').forEach((line, index) => {
    if (line.trim() === firstLine) hits.push(index + 1);
  });
  if (hits.length > 0) return `the first SEARCH line appears at line ${hits.slice(0, 5).join(', ')} but the following SEARCH lines differ from the file`;
  return `SEARCH text not found; its first line "${truncate(firstLine, 100)}" does not exist in the file`;
}

/**
 * Blocks are line based: an empty REPLACE of whole lines also removes their line break.
 * @param {string} content
 * @param {number} position
 * @param {string} search
 * @param {string} replace
 * @returns {string}
 */
function replaceMatch(content, position, search, replace) {
  let end = position + search.length;
  const startsLine = position === 0 || content[position - 1] === '\n';
  if (replace === '' && startsLine && content[end] === '\n') end += 1;
  return content.slice(0, position) + replace + content.slice(end);
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
