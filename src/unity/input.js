// Input handling (spec 9.2): the project's active input handler, the package, action assets and legacy calls.
import { joinProjectPath } from './fs-view.js';
import { findPackage } from './packages.js';
import { extensionOf } from './walk.js';

export const PROJECT_SETTINGS_FILE = 'ProjectSettings/ProjectSettings.asset';
export const INPUT_SYSTEM_PACKAGE_ID = 'com.unity.inputsystem';

// ProjectSettings.asset can be large, and only one line is needed.
const PROJECT_SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

const LEGACY_INPUT_CALL = /\bInput\.Get[A-Z]\w*\s*\(/g;

/** 0, 1 and 2 are the values Unity writes for Input Manager, the Input System package, and both. */
export const INPUT_HANDLER_LABELS = Object.freeze({ 0: 'Input Manager (legacy)', 1: 'Input System package', 2: 'both' });

/** @typedef {'legacy' | 'input-system' | 'both' | 'unknown'} InputVerdict */

/**
 * @typedef {object} InputFact
 * @property {number | null} activeInputHandler
 * @property {InputVerdict} verdict
 * @property {boolean} package           The Input System package is a direct dependency.
 * @property {number} inputActions       `.inputactions` assets.
 * @property {number} legacyCalls        `Input.Get*` calls in first-party scripts.
 * @property {number} legacyFiles
 */

/**
 * Reads the `activeInputHandler` line without parsing the YAML document.
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @returns {{ value: number | null, line: string | null }}
 */
export function readActiveInputHandler(view, root) {
  const read = view.readText(joinProjectPath(root, PROJECT_SETTINGS_FILE), { maxBytes: PROJECT_SETTINGS_MAX_BYTES });
  if (!read) return { value: null, line: null };
  // A truncated read can end mid-line, so the last line is dropped.
  const lines = read.text.split(/\r?\n/);
  if (read.truncated) lines.pop();
  for (const line of lines) {
    const match = /^\s*activeInputHandler:\s*(\d+)\s*$/.exec(line);
    if (match) return { value: Number(match[1]), line: line.trim() };
  }
  return { value: null, line: null };
}

/**
 * @returns {{ add: (text: string) => void, counts: () => { legacyCalls: number, legacyFiles: number } }}
 */
export function createInputUsageCollector() {
  let legacyCalls = 0;
  let legacyFiles = 0;
  return {
    add(text) {
      const matches = text.match(LEGACY_INPUT_CALL);
      if (!matches) return;
      legacyCalls += matches.length;
      legacyFiles += 1;
    },
    counts() {
      return { legacyCalls, legacyFiles };
    },
  };
}

/**
 * @param {string[]} files
 * @returns {number}
 */
export function countInputActionAssets(files) {
  return files.filter((file) => extensionOf(file) === '.inputactions').length;
}

/**
 * @param {object} input
 * @param {number | null} input.activeInputHandler
 * @param {import('./packages.js').PackageInfo[]} input.packages
 * @param {number} input.inputActions
 * @param {number} input.legacyCalls
 * @param {number} input.legacyFiles
 * @returns {InputFact}
 */
export function summarizeInput({ activeInputHandler, packages, inputActions, legacyCalls, legacyFiles }) {
  /** @type {InputVerdict} */
  const verdict =
    activeInputHandler === 0 ? 'legacy' : activeInputHandler === 1 ? 'input-system' : activeInputHandler === 2 ? 'both' : 'unknown';
  return {
    activeInputHandler,
    verdict,
    package: Boolean(findPackage(packages, INPUT_SYSTEM_PACKAGE_ID)?.direct),
    inputActions,
    legacyCalls,
    legacyFiles,
  };
}
