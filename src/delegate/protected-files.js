// The `PROTECTED_EDIT` half of spec 8.5.2 inside the delegate lane (spec 12.2, safety rule S4).
//
// S4 names three enforcement points and this is the third: the other two are OpenCode's permission
// layer and the shell guard, and the delegate lane goes through neither - it writes the file itself
// with `fs.writeFile`, under the orchestrator's standing `Bash(opencode-unity delegate:*)` approval.
// One SEARCH/REPLACE block from a local model can corrupt a scene's YAML, change a GUID in a `.meta`
// file or rewrite an `.asmdef`, and a compile check cannot see any of it.
//
// The table itself stays in the plugin, which is the one home for both boundaries' globs, and the
// match is the classifier's, so all three enforcement points read one list through one matcher.
import { PROTECTED_EDIT_GLOBS } from '../../plugin/opencode-unity-lib/protected-paths.js';
import { matchesGlob } from '../../plugin/opencode-unity-lib/shell-classify.js';

/**
 * The first protected glob a path matches, or null when the agent may edit it.
 * @param {string} relativePath  Relative to the working directory; either separator is accepted.
 * @param {readonly string[]} [extraGlobs]  `safety.extraProtectedEditGlobs` from the config.
 * @returns {string | null}
 */
export function findProtectedEditGlob(relativePath, extraGlobs = []) {
  for (const glob of [...PROTECTED_EDIT_GLOBS, ...extraGlobs]) {
    if (matchesGlob(relativePath, glob)) return glob;
  }
  return null;
}

/**
 * The one sentence both ends of the lane use, so a refused path reads the same whether it was refused
 * before the model saw it or after the model named it.
 * @param {string} relativePath
 * @param {string} glob
 * @returns {string}
 */
export function describeProtectedEdit(relativePath, glob) {
  return `${relativePath} is a protected Unity or project file (${glob}); the agent may never edit it`;
}
