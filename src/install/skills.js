// Where a delegation skill lands in another tool's home (spec 12.6), and the seam the host lane plugs
// into.
//
// This module deliberately does not render or write anything. Amendment D-H1 turns setup item 9 into
// `setup --host`, and the `host` command group owns detection, rendering, the append-only settings merge
// and the permission printers. What stays here is the part `uninstall` needs even when that lane is not
// installed: the exact path contract for a `skillCopy` entry, so a file recorded by any writer can be
// reverted by hash.
//
// The seam for that lane is the `host-install` step of the setup plan (plan.js), which today names the
// command to run; the host lane replaces that step's body and adds its manifest kinds to the schema.
import { getPathApi } from '../core/paths.js';

export const SKILL_DIRECTORY_NAME = 'opencode-unity-delegate';
export const SKILL_FILE_NAME = 'SKILL.md';

/** @typedef {'claude'|'codex'} SkillTarget */

/**
 * Per-target roots, each from that tool's own documentation:
 * - Claude Code reads personal skills from `~/.claude/skills/<name>/SKILL.md`.
 * - Codex reads user skills from `$HOME/.agents/skills/<name>/SKILL.md`.
 * @type {Readonly<Record<SkillTarget, readonly string[]>>}
 */
export const SKILL_ROOT_SEGMENTS = Object.freeze({
  claude: Object.freeze(['.claude', 'skills']),
  codex: Object.freeze(['.agents', 'skills']),
});

/**
 * @param {SkillTarget} target
 * @param {{ homedir: string, platform?: NodeJS.Platform }} options
 * @returns {string}
 */
export function resolveSkillPath(target, { homedir, platform = process.platform }) {
  const segments = SKILL_ROOT_SEGMENTS[target];
  if (!segments) throw new TypeError(`Unknown skill target '${target}'`);
  if (!homedir) throw new TypeError('A skill path needs the user home directory');
  const api = getPathApi(platform);
  return api.join(homedir, ...segments, SKILL_DIRECTORY_NAME, SKILL_FILE_NAME);
}

/**
 * The one-line notice `setup --delegate` prints (amendment 38.3, 5.4 `setup`). The flag still selects the
 * same targets, so nobody's script breaks; it just says where the work moved.
 * @param {readonly string[]} targets
 * @returns {string}
 */
export function describeDeprecatedDelegateFlag(targets) {
  return `--delegate is now --host; '--host ${targets.join(',')}' does the same thing and covers the rest of each tool's setup.`;
}
