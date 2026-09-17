// Project root detection (spec 9.1): walk up until both `Assets/` and
// `ProjectSettings/ProjectVersion.txt` exist.
import path from 'node:path';
import { CliError, EXIT } from '../cli/exit-codes.js';
import { isDirectory, isFile } from './fs-view.js';

export const PROJECT_VERSION_FILE = 'ProjectSettings/ProjectVersion.txt';

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} directory
 * @returns {boolean}
 */
export function isUnityProjectRoot(view, directory) {
  return isDirectory(view, path.join(directory, 'Assets')) && isFile(view, path.join(directory, 'ProjectSettings', 'ProjectVersion.txt'));
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} startPath  A file or directory inside the project.
 * @returns {string | null} Absolute project root.
 */
export function findUnityProjectRoot(view, startPath) {
  let current = path.resolve(startPath);
  for (;;) {
    if (isUnityProjectRoot(view, current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} startPath
 * @returns {string}
 * @throws {CliError} Exit 1 when no Unity project contains the path.
 */
export function requireUnityProjectRoot(view, startPath) {
  const root = findUnityProjectRoot(view, startPath);
  if (root) return root;
  throw new CliError('not a Unity project', {
    exitCode: EXIT.USAGE,
    code: 'not_unity_project',
    hint: 'Run this inside a Unity project folder (it has Assets/ and ProjectSettings/ProjectVersion.txt), or pass --project <dir>.',
  });
}

/**
 * Unity names the project after its folder (MCP for Unity does the same for instance ids).
 * @param {string} root
 * @returns {string}
 */
export function getProjectName(root) {
  return path.basename(path.resolve(root)) || 'Unknown';
}
