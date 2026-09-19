// The denied-intent classifier of prompt shaping (amendment 36.7).
//
// A small, ordered, case-insensitive matcher that looks for a forbidden verb bound to a forbidden object,
// never a bare keyword, so "fix the commit message parser" is not a commit and "add a scene loader" is
// not a scene edit. It runs twice: on the developer's request before any model call (a match is
// `passthrough:denied_intent`, the request goes on unchanged), and on the model's rewrite afterwards (a
// match rejects the rewrite). Both name the rule that answers such a request downstream, so the
// developer learns the boundary instead of guessing at it.
//
// This is a signpost, not a security control. The boundary is the permission layer, the shell guard and
// the network policy, and every one of them denies these requests whether or not this module noticed.
// A false positive therefore costs one unshaped request; that is why the groups stay narrow.
import { PROTECTED_EDIT_GLOBS } from '../../plugin/opencode-unity-lib/protected-paths.js';

/**
 * @typedef {object} IntentGroup
 * @property {string} id
 * @property {string} rule     The rule that denies such a request downstream.
 * @property {string} label    What the request asks for, as a noun phrase.
 * @property {(clause: string) => boolean} matches
 */

/**
 * @typedef {object} DeniedIntent
 * @property {string} group
 * @property {string} rule
 * @property {string} label
 */

const DETERMINER = String.raw`(?:the|a|an|our|my|your|its|their|this|that|these|those|each|every|any|some)`;

// VCS write: a VCS verb in a clause that also names a VCS, a branch, a changeset or a remote, or a VCS
// verb that ends the clause as an order ("... and commit it").
const VCS_VERB =
  /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|check(?:s|ed|ing)?[\s-]?in|checkin|submit(?:s|ted|ting)?|revert(?:s|ed|ing)?|stash(?:es|ed|ing)?|merg(?:e|es|ed|ing)|tag(?:s|ged|ging)?|cherry-pick(?:s|ed|ing)?|shelv(?:e|es|ed|ing)|rebas(?:e|es|ed|ing))\b/i;
const VCS_OBJECT =
  /\b(?:git|plastic|unity version control|svn|subversion|perforce|p4|hg|mercurial|branch(?:es)?|changesets?|changelists?|origin|upstream|repo|repository|trunk)\b|\bremotes?\b(?!\s+(?:config|configuration|settings|values?)\b)/i;
const VCS_ORDER_AT_END =
  /\b(?:commit|push|check[\s-]?in|checkin|stash|shelve|cherry-pick)(?:\s+(?:it|this|that|them|these|those|everything|all|(?:the|my|your|our|these|those|all)\s+(?:changes?|work|fix(?:es)?|files?|edits?)))?\s*$/i;

// Deploy and release: a deploy command, a deploy verb used as an order, or a release verb bound to a
// place things are released to.
const DEPLOY_COMMAND = /\b(?:firebase|gcloud|vercel|netlify|wrangler|supabase|heroku)\s+deploy\b|\bnpm\s+publish\b|\bstore\s+build\b/i;
const DEPLOY_ORDER = new RegExp(
  String.raw`(?<!\b${DETERMINER}\s+)\bdeploy(?:s|ed|ing)?\b(?!\s+(?:script|scripts|log|logs|config|configuration|pipeline|workflow|step|stage|job|tool|target|button|process|docs|documentation|file|files|key|keys)\b)`,
  'i',
);
const RELEASE_VERB = /\b(?:publish|release|ship|upload|submit)\b/i;
const RELEASE_TARGET = /\b(?:app\s?store|play\s?store|google\s+play|testflight|steam|itch(?:\.io)?|production|prod|npm|registry|hosting)\b/i;
const SHIP_TO = new RegExp(String.raw`(?<!\b${DETERMINER}\s+)\b(?:ship|upload)\s+(?:(?:it|this|that|them|${DETERMINER}\s+\S+)\s+)?to\b`, 'i');

// Network write: a write method used as an action or aimed at a URL, a writing curl or PowerShell call,
// or a webhook or chat service as the destination. "the POST /scores route" is code, not an action.
const METHOD_AS_ACTION = /\b(?:send|make|do|issue|fire|perform)\s+(?:(?:a|an|the)\s+)?(?:POST|PUT|PATCH|DELETE)\b/i;
const METHOD_AT_URL = /\b(?:post|put|patch|delete)\s+(?:(?:it|this|that|them|the\s+\S+)\s+)?(?:to\s+)?https?:\/\//i;
const METHOD_TO_SERVICE = /\b(?:POST|PUT|PATCH|DELETE)\s+(?:it\s+|this\s+|that\s+)?to\s+(?:the\s+)?(?:\S+\s+)?(?:endpoint|api|server|webhook|url)\b/;
const CURL_WRITE = /\bcurl\b[^\r\n]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE)|-d|--data(?:-[a-z]+)?|-F|--form|-T|--upload-file)\b/i;
const POWERSHELL_WRITE = /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\r\n]*-Method\s+(?:Post|Put|Patch|Delete)\b/i;
const WEBHOOK_CALL = /\b(?:call|trigger|hit|fire|ping)\s+(?:the\s+|a\s+|our\s+)?webhook\b/i;
const SEND_TO_SERVICE = /\bsend\b[^\r\n]*\bto\s+(?:the\s+|our\s+|a\s+)?(?:slack|discord|teams|webhook|https?:\/\/)/i;

// Serialized asset edit: an edit verb in a clause that names a protected file and no editable source
// file, or an edit verb whose object is a scene, a prefab, the project settings, the manifest or the
// input actions - unless that word only qualifies a code noun ("scene loader").
const EDIT_VERB =
  /\b(?:edit|change|modify|update|move|rename|delete|remove|add|set|adjust|tweak|replace|rewrite|create|save|fix|reorder|resize|rotate|scale|place|assign|attach|wire|reposition|duplicate|drag|drop)\b/i;
const PROTECTED_FILE = createProtectedFilePattern(PROTECTED_EDIT_GLOBS);
const EDITABLE_SOURCE_FILE = /\.(?:cs|ts|tsx|js|mjs|cjs|uxml|uss|shader|hlsl|cginc|md|txt|sql|ya?ml)\b/i;
const CODE_NOUN =
  String.raw`(?:loader|loading|loads|manager|transition|transitions|fader|switcher|switch|name|names|list|index|reference|references|view|camera|root|parser|reader|writer|builder|bootstrap|script|scripts|class|service|controller|pool|factory|spawner|registry|cache|code|handler|system|test|tests)`;
const PROTECTED_OBJECT = new RegExp(
  String.raw`\b(?:edit|change|modify|update|move|rename|delete|remove|add|set|adjust|tweak|replace|rewrite|create|save|fix|reorder|duplicate)\s+(?:${DETERMINER}\s+|all\s+|both\s+|new\s+)?(?:[\w-]+\s+){0,2}?(?:scenes?|prefabs?|project\s*settings|manifest|input\s*actions)\b(?!\s+${CODE_NOUN}\b)`,
  'i',
);

// Process control (SPEC S12, S13): the product never starts, stops or restarts Unity or Ollama, and never
// runs Unity in batch mode.
const PROCESS_VERB = String.raw`(?:open|start|launch|run|restart|reopen|quit|close|kill|stop|reload)\s+(?:up\s+)?(?:the\s+)?`;
const PROCESS_END = String.raw`(?=\s*$|\s*,|\s+(?:and|then|with|in|to|so|again|now|first|before|after)\b)`;
const UNITY_PROCESS = new RegExp(String.raw`\b${PROCESS_VERB}unity(?:\s+(?:editor|hub|app))?${PROCESS_END}`, 'i');
const OLLAMA_PROCESS = new RegExp(String.raw`\b${PROCESS_VERB}ollama(?:\s+(?:app|server|service))?${PROCESS_END}`, 'i');
const BATCH_MODE = /-batchmode\b|\b(?:in|with|using|via)\s+batch\s*-?mode\b/i;

/**
 * In order; the first group with a matching clause decides. The multiplayer group of amendment 37.7 is
 * added to this table, not beside it.
 * @type {readonly IntentGroup[]}
 */
export const DENIED_INTENT_GROUPS = Object.freeze([
  {
    id: 'vcs_write',
    rule: 'VCS_WRITE_DENY',
    label: 'a version-control write',
    matches: (clause) => VCS_ORDER_AT_END.test(clause) || (VCS_VERB.test(clause) && VCS_OBJECT.test(clause)),
  },
  {
    id: 'deploy_release',
    rule: 'PM_DENY',
    label: 'a deploy or a release',
    matches: (clause) => DEPLOY_COMMAND.test(clause) || DEPLOY_ORDER.test(clause) || SHIP_TO.test(clause) || (RELEASE_VERB.test(clause) && RELEASE_TARGET.test(clause)),
  },
  {
    id: 'network_write',
    rule: 'the network policy',
    label: 'a network write',
    matches: (clause) =>
      METHOD_AS_ACTION.test(clause) ||
      METHOD_AT_URL.test(clause) ||
      METHOD_TO_SERVICE.test(clause) ||
      CURL_WRITE.test(clause) ||
      POWERSHELL_WRITE.test(clause) ||
      WEBHOOK_CALL.test(clause) ||
      SEND_TO_SERVICE.test(clause),
  },
  {
    id: 'serialized_asset_edit',
    rule: 'PROTECTED_EDIT',
    label: 'an edit to a scene, prefab, asset or project file',
    matches: (clause) => (PROTECTED_FILE.test(clause) && EDIT_VERB.test(clause) && !EDITABLE_SOURCE_FILE.test(clause)) || PROTECTED_OBJECT.test(clause),
  },
  {
    id: 'unity_process_control',
    rule: 'S12',
    label: 'starting, stopping or batch-running Unity',
    matches: (clause) => UNITY_PROCESS.test(clause) || BATCH_MODE.test(clause),
  },
  {
    id: 'ollama_process_control',
    rule: 'S13',
    label: 'starting or stopping Ollama',
    matches: (clause) => OLLAMA_PROCESS.test(clause),
  },
]);

/**
 * The first denied intent in the text, or null.
 * @param {string} text
 * @param {readonly IntentGroup[]} [groups]
 * @returns {DeniedIntent | null}
 */
export function findDeniedIntent(text, groups = DENIED_INTENT_GROUPS) {
  const clauses = splitClauses(text);
  for (const group of groups) {
    if (clauses.some((clause) => group.matches(clause))) return { group: group.id, rule: group.rule, label: group.label };
  }
  return null;
}

/**
 * One line naming what was asked and which rule answers it.
 * @param {DeniedIntent} denied
 * @returns {string}
 */
export function describeDeniedIntent(denied) {
  return `the request asks for ${denied.label}, which ${denied.rule} denies`;
}

/**
 * Sentences and list lines. A dot only ends a clause before whitespace or the end, so `Main.unity` and
 * `Game.Tests.EditMode` stay whole.
 * @param {string} text
 * @returns {string[]}
 */
export function splitClauses(text) {
  return text
    .split(/[\r\n;]+|[.!?]+(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
}

/**
 * A file name with any extension `PROTECTED_EDIT` names, or a path into `ProjectSettings/` or the package
 * manifest. Built from the shared table, so a glob added there is a denied object here too.
 * @param {readonly string[]} globs
 * @returns {RegExp}
 */
function createProtectedFilePattern(globs) {
  const extensions = globs
    .map((glob) => /^\*\.([A-Za-z0-9]+)$/.exec(glob)?.[1])
    .filter((extension) => extension !== undefined)
    .sort((a, b) => b.length - a.length);
  return new RegExp(String.raw`[\w-]\.(?:${extensions.join('|')})\b|\bProjectSettings[\\/]|\bPackages[\\/](?:manifest|packages-lock)\.json\b`, 'i');
}
