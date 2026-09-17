// UI system (spec 9.2): uGUI, UI Toolkit or both, from document counts and source usage.
import { extensionOf } from './walk.js';

const UGUI_PATTERNS = [/^[ \t]*using[ \t]+UnityEngine\.UI[ \t]*;/m, /^[ \t]*using[ \t]+TMPro[\w.]*[ \t]*;/m, /\bCanvas\b/];
const UI_TOOLKIT_PATTERNS = [/^[ \t]*using[ \t]+UnityEngine\.UIElements[\w.]*[ \t]*;/m, /\bUIDocument\b/, /\bVisualElement\b/];

/** @typedef {'uGUI' | 'UI Toolkit' | 'mixed' | 'none'} UiVerdict */

/**
 * @typedef {object} UiFact
 * @property {UiVerdict} verdict
 * @property {number} uguiScripts
 * @property {number} uiToolkitScripts
 * @property {number} uxml
 * @property {number} uss
 */

/**
 * Editor tooling uses UIElements for inspectors, which says nothing about the game's UI, so files under an
 * `Editor` folder are left out.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isEditorPath(relativePath) {
  return relativePath
    .split('/')
    .slice(0, -1)
    .some((segment) => segment.toLowerCase() === 'editor');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function usesUgui(text) {
  return UGUI_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function usesUiToolkit(text) {
  return UI_TOOLKIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * @returns {{ add: (relativePath: string, text: string) => void, counts: () => { uguiScripts: number, uiToolkitScripts: number } }}
 */
export function createUiCollector() {
  let uguiScripts = 0;
  let uiToolkitScripts = 0;
  return {
    add(relativePath, text) {
      if (isEditorPath(relativePath)) return;
      if (usesUgui(text)) uguiScripts += 1;
      if (usesUiToolkit(text)) uiToolkitScripts += 1;
    },
    counts() {
      return { uguiScripts, uiToolkitScripts };
    },
  };
}

/**
 * @param {string[]} files  Relative posix paths from the project index.
 * @returns {{ uxml: number, uss: number }}
 */
export function countUiDocuments(files) {
  let uxml = 0;
  let uss = 0;
  for (const file of files) {
    if (isEditorPath(file)) continue;
    const extension = extensionOf(file);
    if (extension === '.uxml') uxml += 1;
    else if (extension === '.uss') uss += 1;
  }
  return { uxml, uss };
}

/**
 * @param {{ uguiScripts: number, uiToolkitScripts: number, uxml: number, uss: number }} counts
 * @returns {UiFact}
 */
export function summarizeUi({ uguiScripts, uiToolkitScripts, uxml, uss }) {
  const ugui = uguiScripts > 0;
  const uiToolkit = uiToolkitScripts > 0 || uxml > 0;
  const verdict = ugui && uiToolkit ? 'mixed' : ugui ? 'uGUI' : uiToolkit ? 'UI Toolkit' : 'none';
  return { verdict, uguiScripts, uiToolkitScripts, uxml, uss };
}
