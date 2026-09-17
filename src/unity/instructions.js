// Instruction files (spec 9.2): the AGENTS.md OpenCode would load from above the project, the nested files it
// attaches when reading a folder, and whether the project already has a `.opencode` directory.
import path from 'node:path';
import { CALIBRATED_CHARS_PER_TOKEN, estimateCharTokens } from '../../plugin/opencode-unity-lib/tokens.js';
import { compareOrdinal, isDirectory, joinProjectPath } from './fs-view.js';
import { baseNameOf } from './walk.js';

// OpenCode looks for these names from the working directory up to the worktree root, and the first name with
// any match wins. CLAUDE.md is left out because the clean room runs with OPENCODE_DISABLE_CLAUDE_CODE=1.
export const UPWARD_INSTRUCTION_NAMES = Object.freeze(['AGENTS.md', 'CONTEXT.md']);

// Files OpenCode attaches when the agent reads a file in that folder.
export const NESTED_INSTRUCTION_NAMES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);

export const OPENCODE_DIR = '.opencode';

const INSTRUCTION_MAX_BYTES = 1024 * 1024;

/** Calibrated at 3.5 characters per token for this model family (spec 8.8). */
export const CHARS_PER_TOKEN = CALIBRATED_CHARS_PER_TOKEN;

/**
 * @typedef {object} InstructionFile
 * @property {string} path    Relative to the project root, with `/`; `../` for a file above it.
 * @property {'upward' | 'nested'} scope
 * @property {number} chars
 * @property {number} tokens  Estimate.
 */

/**
 * @param {number} chars
 * @returns {number}
 */
export function estimateInstructionTokens(chars) {
  return estimateCharTokens(chars, { charsPerToken: CHARS_PER_TOKEN });
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @param {{ maxDepth?: number | null }} [options]  How far above the project to look; null means the drive root.
 * @returns {InstructionFile[]}
 */
export function detectInstructionFiles(view, root, index, { maxDepth = null } = {}) {
  return [...findUpwardInstructions(view, root, maxDepth), ...findNestedInstructions(view, root, index)];
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @returns {boolean}
 */
export function hasOpencodeDir(view, root) {
  return isDirectory(view, joinProjectPath(root, OPENCODE_DIR));
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {number | null} maxDepth
 * @returns {InstructionFile[]}
 */
function findUpwardInstructions(view, root, maxDepth) {
  for (const name of UPWARD_INSTRUCTION_NAMES) {
    /** @type {InstructionFile[]} */
    const matches = [];
    let current = path.resolve(root);
    for (let depth = 0; maxDepth === null || depth <= maxDepth; depth += 1) {
      const file = measure(view, path.join(current, name), `${'../'.repeat(depth)}${name}`, 'upward');
      if (file) matches.push(file);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @param {import('./walk.js').ProjectIndex} index
 * @returns {InstructionFile[]}
 */
function findNestedInstructions(view, root, index) {
  /** @type {InstructionFile[]} */
  const files = [];
  for (const file of index.files) {
    if (!NESTED_INSTRUCTION_NAMES.includes(baseNameOf(file))) continue;
    const measured = measure(view, joinProjectPath(root, file), file, 'nested');
    if (measured) files.push(measured);
  }
  return files.sort((a, b) => compareOrdinal(a.path, b.path));
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} absolutePath
 * @param {string} relativePath
 * @param {'upward' | 'nested'} scope
 * @returns {InstructionFile | null}
 */
function measure(view, absolutePath, relativePath, scope) {
  const read = view.readText(absolutePath, { maxBytes: INSTRUCTION_MAX_BYTES });
  if (!read) return null;
  return { path: relativePath, scope, chars: read.text.length, tokens: estimateInstructionTokens(read.text.length) };
}
