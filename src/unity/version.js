// Unity version from ProjectSettings/ProjectVersion.txt (spec 9.2).
import { joinProjectPath } from './fs-view.js';
import { PROJECT_VERSION_FILE } from './root.js';

/** @typedef {'reference-tested' | 'experimental' | 'unsupported' | 'unknown'} UnitySupport */

/**
 * @typedef {object} UnityVersionFact
 * @property {string | null} editorVersion  For example `6000.3.8f1`.
 * @property {string | null} stream         For example `6000.3`.
 * @property {UnitySupport} support
 * @property {string[]} warnings
 */

const EXPERIMENTAL_STREAMS = new Set(['2021.3', '2022.3']);

/**
 * @param {string} text  Content of ProjectVersion.txt.
 * @returns {UnityVersionFact}
 */
export function parseProjectVersion(text) {
  const match = /^\s*m_EditorVersion:\s*(\S+)\s*$/m.exec(text);
  const editorVersion = match ? match[1] : null;
  const parts = editorVersion ? /^(\d+)\.(\d+)/.exec(editorVersion) : null;
  if (!editorVersion || !parts) {
    return { editorVersion, stream: null, support: 'unknown', warnings: ['Unity version not found in ProjectVersion.txt'] };
  }
  const stream = `${Number(parts[1])}.${Number(parts[2])}`;
  const support = classifyStream(Number(parts[1]), stream);
  const warnings = [];
  if (support === 'experimental') warnings.push(`Unity ${stream} is experimental; only Unity 6000.x is reference-tested`);
  if (support === 'unsupported') warnings.push(`Unity ${stream} is not supported; facts may be wrong`);
  return { editorVersion, stream, support, warnings };
}

/**
 * @param {number} major
 * @param {string} stream
 * @returns {UnitySupport}
 */
function classifyStream(major, stream) {
  if (major === 6000) return 'reference-tested';
  if (EXPERIMENTAL_STREAMS.has(stream)) return 'experimental';
  return 'unsupported';
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} root
 * @returns {UnityVersionFact}
 */
export function detectUnityVersion(view, root) {
  const read = view.readText(joinProjectPath(root, PROJECT_VERSION_FILE), { maxBytes: 64 * 1024 });
  if (!read) return { editorVersion: null, stream: null, support: 'unknown', warnings: ['ProjectVersion.txt is unreadable'] };
  return parseProjectVersion(read.text);
}
