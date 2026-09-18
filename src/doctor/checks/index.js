// The check registry (spec 5.4, amendment 38.3a).
//
// One ordered list is the single source for the run order, the report sections, `--explain` and the
// generated `docs/doctor-checks.md`. Adding a check means adding it here and nowhere else.
//
// Extension seam for the later build steps. Each of the four groups below owns its own module and is
// concatenated here in the order the amendment lists them; nothing else in `src/doctor/` needs to
// change to add one:
//   network.*     S39, amendment 35 - reachability, consent, policy drift, emulator ports
//   component.*   S58, amendment 37 - workspace components, Firebase, databases, multiplayer
//   shape.*       S41, amendment 36 - prompt shaping mode, index truncation, thinking presets
//   host.*        S38, amendment 32 - installed host integrations and their manifests
import { CHECK_GROUPS } from '../engine.js';
import { DECLARABLE_SEVERITIES } from '../finding.js';
import { BUDGET_CHECKS } from './budget.js';
import { ENVIRONMENT_CHECKS } from './environment.js';
import { GPU_CHECKS } from './gpu.js';
import { INSTRUCTION_CHECKS } from './instructions.js';
import { LOG_CHECKS } from './logs.js';
import { OLLAMA_CHECKS } from './ollama.js';
import { OPENCODE_CHECKS } from './opencode.js';
import { PERMISSION_CHECKS } from './permissions.js';
import { PLATFORM_CHECKS } from './platform.js';
import { SETUP_CHECKS } from './setup.js';
import { TOOL_CHECKS } from './tools.js';
import { UNITY_CHECKS } from './unity.js';

export const CHECK_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** @type {readonly CheckSpec[]} */
export const CHECKS = Object.freeze([
  ...PLATFORM_CHECKS,
  ...SETUP_CHECKS,
  ...OLLAMA_CHECKS,
  ...OPENCODE_CHECKS,
  ...INSTRUCTION_CHECKS,
  ...TOOL_CHECKS,
  ...BUDGET_CHECKS,
  ...LOG_CHECKS,
  ...GPU_CHECKS,
  ...PERMISSION_CHECKS,
  ...ENVIRONMENT_CHECKS,
  ...UNITY_CHECKS,
]);

/**
 * @param {string} id
 * @param {readonly CheckSpec[]} [checks]
 * @returns {CheckSpec | undefined}
 */
export function findCheck(id, checks = CHECKS) {
  return checks.find((check) => check.id === id);
}

/**
 * Every id, for the docs generator and for the lint that keeps the count honest.
 * @param {readonly CheckSpec[]} [checks]
 * @returns {string[]}
 */
export function listCheckIds(checks = CHECKS) {
  return checks.map((check) => check.id);
}

/**
 * Structural problems in the registry. A duplicate id or an unknown group is a build error, not a
 * finding, so the lint suite fails on it rather than a user's report.
 * @param {readonly CheckSpec[]} [checks]
 * @param {readonly string[]} [groups]
 * @returns {string[]}
 */
export function validateRegistry(checks = CHECKS, groups = CHECK_GROUPS.map((group) => group.id)) {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const check of checks) {
    if (seen.has(check.id)) problems.push(`duplicate check id '${check.id}'`);
    seen.add(check.id);
    if (!groups.includes(check.group)) problems.push(`check '${check.id}' names the unknown group '${check.group}'`);
    if (!CHECK_ID_PATTERN.test(check.id)) problems.push(`check id '${check.id}' is not <area>.<kebab-case>`);
    if (check.severities.length === 0) problems.push(`check '${check.id}' declares no severity range`);
    for (const severity of check.severities) {
      if (!DECLARABLE_SEVERITIES.includes(severity)) problems.push(`check '${check.id}' declares the severity '${severity}', which is an outcome rather than a range`);
    }
    for (const [field, value] of Object.entries({ title: check.title, why: check.why, fix: check.fix, source: check.source })) {
      if (typeof value !== 'string' || value.trim() === '') problems.push(`check '${check.id}' has an empty ${field}`);
    }
  }
  return problems;
}
