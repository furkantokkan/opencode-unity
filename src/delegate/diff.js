// Unified diff of the proposed edit, so a reviewer reads one text instead of two files. Pure and
// dependency-free: no `git diff --no-index`, because the reviewed diff must look the same on a machine
// without git and in a folder that is not a repository.
import { splitLines } from './prompts.js';

/** @typedef {{ type: ' ' | '-' | '+', line: string }} DiffOp */
/** @typedef {DiffOp & { oldNo: number, newNo: number }} DiffRow */

// A full LCS table is quadratic; above this many cells the two sides are shown as one delete and one
// insert instead, which is still a correct diff.
const MAX_LCS_CELLS = 4_000_000;

/**
 * @param {string} oldName
 * @param {string} newName
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [context]
 * @returns {string} Empty when the texts are equal.
 */
export function createUnifiedDiff(oldName, newName, oldText, newText, context = 3) {
  const oldLines = splitLines(oldText.replace(/\r\n/g, '\n'));
  const newLines = splitLines(newText.replace(/\r\n/g, '\n'));
  const rows = numberDiffRows(diffLines(oldLines, newLines));
  const hunks = groupHunks(rows, context);
  if (hunks.length === 0) return '';
  const output = [`--- ${oldName}`, `+++ ${newName}`];
  for (const hunk of hunks) {
    const oldCount = hunk.filter((row) => row.type !== '+').length;
    const newCount = hunk.filter((row) => row.type !== '-').length;
    const oldStart = oldCount > 0 ? /** @type {DiffRow} */ (hunk.find((row) => row.type !== '+')).oldNo : hunk[0].oldNo - 1;
    const newStart = newCount > 0 ? /** @type {DiffRow} */ (hunk.find((row) => row.type !== '-')).newNo : hunk[0].newNo - 1;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of hunk) output.push(`${row.type}${row.line}`);
  }
  return `${output.join('\n')}\n`;
}

/**
 * @param {readonly { relativePath: string, decoded: { text: string }, newText: string }[]} changes
 * @returns {string}
 */
export function createChangesDiff(changes) {
  return changes.map((change) => createUnifiedDiff(`a/${change.relativePath}`, `b/${change.relativePath}`, change.decoded.text, change.newText)).join('');
}

/**
 * `path +added -removed` per file, for the summary printed when the diff was already reviewed.
 * @param {readonly { relativePath: string, decoded: { text: string }, newText: string }[]} changes
 * @returns {string[]}
 */
export function countDiffLines(changes) {
  return changes.map((change) => {
    const lines = createUnifiedDiff('a', 'b', change.decoded.text, change.newText).split('\n');
    const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++ ')).length;
    const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('--- ')).length;
    return `${change.relativePath} +${added} -${removed}`;
  });
}

/**
 * @param {readonly string[]} oldLines
 * @param {readonly string[]} newLines
 * @returns {DiffOp[]}
 */
function diffLines(oldLines, newLines) {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const same = (/** @type {string} */ line) => /** @type {DiffOp} */ ({ type: ' ', line });
  const middleOld = oldLines.slice(start, oldEnd);
  const middleNew = newLines.slice(start, newEnd);
  const middle = middleOld.length * middleNew.length <= MAX_LCS_CELLS
    ? diffByLcs(middleOld, middleNew)
    : [
        ...middleOld.map((line) => /** @type {DiffOp} */ ({ type: '-', line })),
        ...middleNew.map((line) => /** @type {DiffOp} */ ({ type: '+', line })),
      ];
  return [...oldLines.slice(0, start).map(same), ...middle, ...oldLines.slice(oldEnd).map(same)];
}

/**
 * @param {readonly string[]} oldLines
 * @param {readonly string[]} newLines
 * @returns {DiffOp[]}
 */
function diffByLcs(oldLines, newLines) {
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  /** @type {DiffOp[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: ' ', line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: '-', line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ type: '+', line: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    ops.push({ type: '-', line: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    ops.push({ type: '+', line: newLines[j] });
    j += 1;
  }
  return ops;
}

/**
 * @param {readonly DiffOp[]} ops
 * @returns {DiffRow[]}
 */
function numberDiffRows(ops) {
  let oldNo = 1;
  let newNo = 1;
  return ops.map((op) => {
    const row = { ...op, oldNo, newNo };
    if (op.type !== '+') oldNo += 1;
    if (op.type !== '-') newNo += 1;
    return row;
  });
}

/**
 * @param {readonly DiffRow[]} rows
 * @param {number} context
 * @returns {DiffRow[][]}
 */
function groupHunks(rows, context) {
  /** @type {Array<{ start: number, end: number }>} */
  const ranges = [];
  rows.forEach((row, index) => {
    if (row.type === ' ') return;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length, index + context + 1);
    const current = ranges[ranges.length - 1];
    if (current && start <= current.end) current.end = Math.max(current.end, end);
    else ranges.push({ start, end });
  });
  return ranges.map((range) => rows.slice(range.start, range.end));
}
