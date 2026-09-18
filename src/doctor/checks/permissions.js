// Permission checks (spec 5.4, 8.5).
//
// The rules are evaluated with the port of OpenCode's own `evaluate()`, over the layers OpenCode would
// merge, because last match wins and `mergeDeep` keeps an earlier key's position: a rule far down the
// stack can re-allow something the profile denied, and reading the files one at a time would not show
// it. Without `--deep` this is the file view; with it, the merged configuration is the last layer.
import { NON_NEGOTIABLE_TUPLES } from '../../opencode/effective-config.js';
import { buildRuleset, evaluatePermission } from '../../opencode/permission-eval.js';
import { error, pass, quantity, skip, warn } from '../finding.js';
import { effectiveLayers, hasMergedConfig } from '../layers.js';
import { listPermissionBlocks } from '../opencode-config.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Permission names whose blanket `allow` removes the ask that every dangerous action depends on. */
const RISKY_BLANKET_ALLOWS = Object.freeze(['bash', 'edit', 'write', 'webfetch', 'task', 'external_directory']);

/** @type {readonly CheckSpec[]} */
export const PERMISSION_CHECKS = Object.freeze([
  {
    id: 'permissions.serialized-assets',
    group: 'permissions',
    title: 'Serialized Unity assets denied',
    severities: ['error'],
    why: 'A scene, prefab, asset or meta file rewritten by a model loses references that no diff review catches, and the damage shows up days later in the Editor.',
    fix: 'Deny edit and read for the serialized-asset globs, and let the model change C# only.',
    source: 'spec 8.5.4',
    run: (context) => evaluateGroup(context, ['edit', 'read'], 'serialized assets and secrets'),
  },
  {
    id: 'permissions.vcs-writes',
    group: 'permissions',
    title: 'Version-control writes denied',
    severities: ['error'],
    why: 'A commit, push, submit or checkin the model decided to run is the one action a reviewer cannot undo by rejecting a diff.',
    fix: 'Deny the version-control write commands for the agent\'s bash tool.',
    source: 'spec 8.5.3 and 8.5.4',
    run: (context) => evaluateGroup(context, ['bash'], 'version-control writes and destructive commands'),
  },
  {
    id: 'permissions.auto-approve-risk',
    group: 'permissions',
    title: 'Dangerous actions still ask',
    severities: ['warn'],
    why: 'A blanket allow turns every later ask into silence, which is exactly the setting that makes an agent look well behaved right up to the moment it is not.',
    fix: 'Replace the blanket allow with the narrow patterns the action actually needs.',
    source: 'spec 8.5',
    run: (context) => {
      const blocks = listPermissionBlocks(effectiveLayers(context));
      if (blocks.length === 0) return skip('no permission block was found in the configuration');
      /** @type {string[]} */
      const risky = [];
      for (const block of blocks) {
        for (const name of RISKY_BLANKET_ALLOWS) {
          if (block.permission[name] === 'allow') risky.push(`${name} is allowed outright${block.agent === null ? '' : ` for agent ${block.agent}`} in ${block.layerPath}`);
        }
      }
      const tuples = NON_NEGOTIABLE_TUPLES.filter((tuple) => tuple.group === 'other');
      const rules = buildRuleset(blocks.map((block) => ({ layer: block.layerPath, permission: block.permission })));
      const allowed = tuples.filter((tuple) => evaluatePermission(rules, { tool: tuple.tool, argument: tuple.argument }, { caseInsensitive: context.platform === 'win32' }).action === 'allow');
      const details = [...risky, ...allowed.map((tuple) => `${tuple.tool} is allowed without asking`)];
      if (details.length === 0) return pass('no dangerous action is allowed without asking');
      return warn(`${quantity(details.length, 'dangerous action')} allowed without asking`, {
        details,
        data: { blanketAllows: risky, allowedTools: allowed.map((tuple) => tuple.tool) },
      });
    },
  },
]);

/**
 * @param {import('../context.js').DoctorContext} context
 * @param {readonly string[]} groups
 * @param {string} subject
 * @returns {import('../finding.js').Outcome}
 */
function evaluateGroup(context, groups, subject) {
  const blocks = listPermissionBlocks(effectiveLayers(context));
  if (blocks.length === 0) return skip('no permission block was found in the configuration');
  const rules = buildRuleset(blocks.map((block) => ({ layer: block.layerPath, permission: block.permission })));
  const tuples = NON_NEGOTIABLE_TUPLES.filter((tuple) => groups.includes(tuple.group));
  const caseInsensitive = context.platform === 'win32';
  const failures = tuples
    .map((tuple) => ({ tuple, verdict: evaluatePermission(rules, { tool: tuple.tool, argument: tuple.argument }, { caseInsensitive }) }))
    .filter((entry) => entry.verdict.action !== 'deny');
  const view = hasMergedConfig(context) ? 'the merged configuration' : 'the configuration files';
  if (failures.length === 0) return pass(`${view} denies every ${subject} rule`, { data: { tuples: tuples.length } });
  return error(`${view} does not deny ${failures.length} of ${tuples.length} ${subject} rules`, {
    details: failures.map((entry) => {
      const rule = entry.verdict.rule;
      const from = rule === null ? 'no rule matched, so OpenCode allows it' : `${rule.name} -> ${rule.pattern} from ${rule.layer}`;
      return `${entry.tuple.tool} ${entry.tuple.argument} is '${entry.verdict.action}' (${from})`;
    }),
    data: {
      failures: failures.map((entry) => ({ tool: entry.tuple.tool, argument: entry.tuple.argument, action: entry.verdict.action })),
      merged: hasMergedConfig(context),
    },
  });
}
