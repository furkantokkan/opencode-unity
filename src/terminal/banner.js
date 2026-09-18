// The launch banner of spec 13.2: eight lines printed once, just before the TUI takes the screen.
//
// It exists because a local model session has state a cloud session does not - which model, whether it
// is loaded, how much video memory is free, what the guard decided, how much of the context the fixed
// prompt already costs. A user who cannot see that reads a slow first answer as a broken product.
//
// The banner is built as data and rendered separately, so tests assert on fields rather than on
// spacing, and the colour and no-colour paths render the same words.
//
// Extension seam: `extraLines` inserts a line after a named line. That is how the tier line (S38), the
// network line (S39) and the component line (S58) join the banner without this module knowing about
// them; each owner passes its own `{ after: 'preset' | 'config' | ... }` entry.
import { formatTokens } from '../opencode/effective-config.js';
import { ATTENTION_TONES, formatDuration, joinFields, padLabel, paintTone } from './format.js';

/** @typedef {import('./format.js').Tone} Tone */
/** @typedef {import('../cli/output.js').Painter} Painter */
/** @typedef {'header' | 'project' | 'preset' | 'model' | 'guard' | 'budget' | 'config' | 'tips'} BannerLineId */

/**
 * OpenCode compacts when the previous step's usage passes three quarters of the context window (OC
 * `session/overflow.ts` L10-33): 12,288 tokens at the 16K preset.
 */
export const COMPACTION_FRACTION = 0.75;

export const DEFAULT_TIPS = Object.freeze([
  'Tab switches agents',
  '/compile',
  'opencode-unity stop frees VRAM',
]);

/**
 * @typedef {object} BannerLine
 * @property {string} id
 * @property {string} label      Empty for the header line, which has no label column.
 * @property {string} text
 * @property {Tone} tone
 */

/**
 * @typedef {object} ExtraBannerLine
 * @property {BannerLineId} after   The shipped line this one follows.
 * @property {string} id
 * @property {string} label
 * @property {string} text
 * @property {Tone} [tone]
 */

/**
 * @typedef {object} ProjectBanner
 * @property {string} name
 * @property {string | null} unityVersion
 * @property {string | null} vcsKind
 * @property {boolean} factsFresh
 * @property {number} factsTokens
 */

/**
 * @typedef {object} PresetBanner
 * @property {string} id
 * @property {string} status                  `verified`, `reference-tested` or `experimental`.
 * @property {string | null} opencodeVersion
 * @property {string | null} ollamaVersion
 */

/**
 * @typedef {object} ModelBanner
 * @property {string} tag
 * @property {boolean} loaded
 * @property {number | null} contextLength
 * @property {number | null} expiresInSec
 * @property {number} coldLoadSeconds         Typical first-load time for this preset.
 */

/**
 * @typedef {object} GuardBanner
 * @property {string} verdict
 * @property {string[]} reasons               One detail line per blocking reason.
 * @property {number | null} freeVramMiB
 * @property {number} modelVramMiB
 * @property {number} minFreeVramAfterLoadMiB
 * @property {'idle' | 'busy' | 'unknown'} imports
 * @property {number | null} editors
 * @property {string[]} [notMeasured]         Advisory checks this platform could not run.
 */

/**
 * @typedef {object} BudgetBanner
 * @property {number} fixedPromptTokens
 * @property {number} promptBudget
 * @property {number} numCtx
 * @property {number} prefixFailTokens
 * @property {'allowlist' | 'ask'} bashMode
 */

/**
 * @typedef {object} ConfigBanner
 * @property {boolean} verified
 * @property {boolean} cached
 * @property {boolean} editorAgent
 */

/**
 * @typedef {object} BannerInput
 * @property {string} version
 * @property {ProjectBanner} project
 * @property {PresetBanner} preset
 * @property {ModelBanner} model
 * @property {GuardBanner} guard
 * @property {BudgetBanner} budget
 * @property {ConfigBanner} config
 * @property {readonly string[]} [tips]
 * @property {readonly ExtraBannerLine[]} [extraLines]
 */

/**
 * @param {BannerInput} input
 * @returns {BannerLine[]}
 */
export function buildBanner(input) {
  /** @type {BannerLine[]} */
  const lines = [
    { id: 'header', label: '', text: buildHeader(input.version), tone: 'strong' },
    buildProjectLine(input.project),
    buildPresetLine(input.preset),
    buildModelLine(input.model),
    buildGuardLine(input.guard),
    buildBudgetLine(input.budget),
    buildConfigLine(input.config),
    { id: 'tips', label: 'tips', text: (input.tips ?? DEFAULT_TIPS).join(' | '), tone: 'dim' },
  ];
  return insertExtraLines(lines, input.extraLines ?? []);
}

/**
 * @param {readonly BannerLine[]} lines
 * @param {{ paint: Painter }} options
 * @returns {string}
 */
export function renderBanner(lines, { paint }) {
  return lines.map((line) => paintTone(paint, line.tone, line.label === '' ? line.text : `${padLabel(line.label)}${line.text}`)).join('\n');
}

/**
 * Spec 13.1 step 7: when something is yellow, `start` waits so the user reads it before the TUI
 * covers the screen.
 * @param {readonly BannerLine[]} lines
 * @returns {boolean}
 */
export function hasAttention(lines) {
  return lines.some((line) => ATTENTION_TONES.includes(line.tone));
}

/**
 * Turns a guard verdict into the banner's own shape, so `start` and `status` agree on what a verdict
 * looks like without either of them reading probe measurements directly.
 * @param {import('../../plugin/opencode-unity-lib/guard/decide.js').GuardVerdict} verdict
 * @param {Record<string, any> & { modelVramMiB: number }} settings  The profile's resolved guard keys.
 * @returns {GuardBanner}
 */
export function summarizeGuardForBanner(verdict, settings) {
  const memory = verdict.measurements.gpu?.memory;
  const unity = verdict.measurements.unity;
  return {
    verdict: verdict.verdict,
    reasons: verdict.reasons.map((reason) => reason.detail),
    // What `nvidia-smi` reports free, not what the guard counts as available: the line says "free".
    freeVramMiB: memory?.ok ? memory.freeMiB : null,
    modelVramMiB: settings.modelVramMiB,
    minFreeVramAfterLoadMiB: Number(settings.minFreeVramAfterLoadMiB ?? 0),
    imports: describeImports(unity),
    editors: unity?.ok ? unity.editorCount : null,
    notMeasured: [],
  };
}

/**
 * @param {import('../../plugin/opencode-unity-lib/guard/unity-processes.js').UnityFacts | null | undefined} unity
 * @returns {'idle' | 'busy' | 'unknown'}
 */
function describeImports(unity) {
  if (!unity?.ok) return 'unknown';
  if (unity.importCpuPercent === null) return unity.running ? 'unknown' : 'idle';
  return unity.importProcesses.length > 0 && unity.importCpuPercent > 0 ? 'busy' : 'idle';
}

/**
 * @param {string} version
 * @returns {string}
 */
function buildHeader(version) {
  return `opencode-unity ${version} (unofficial; not affiliated with OpenCode, Ollama or Unity)`;
}

/**
 * @param {ProjectBanner} project
 * @returns {BannerLine}
 */
function buildProjectLine(project) {
  const facts = project.factsFresh
    ? `facts fresh (~${formatTokens(project.factsTokens)} tokens)`
    : `facts stale (~${formatTokens(project.factsTokens)} tokens; run init --refresh)`;
  return {
    id: 'project',
    label: 'project',
    text: joinFields([project.name, project.unityVersion ? `Unity ${project.unityVersion}` : 'Unity version unknown', project.vcsKind ?? 'no version control', facts]),
    tone: project.factsFresh ? 'plain' : 'warn',
  };
}

/**
 * @param {PresetBanner} preset
 * @returns {BannerLine}
 */
function buildPresetLine(preset) {
  return {
    id: 'preset',
    label: 'preset',
    text: joinFields([
      `${preset.id} [${preset.status}]`,
      preset.opencodeVersion ? `OpenCode ${preset.opencodeVersion}` : 'OpenCode version unknown',
      preset.ollamaVersion ? `Ollama ${preset.ollamaVersion}` : 'Ollama version unknown',
    ]),
    tone: preset.status === 'experimental' ? 'warn' : 'plain',
  };
}

/**
 * @param {ModelBanner} model
 * @returns {BannerLine}
 */
function buildModelLine(model) {
  if (!model.loaded) {
    return {
      id: 'model',
      label: 'model',
      text: joinFields([model.tag, `not loaded (the first prompt loads it through the guard, ~${model.coldLoadSeconds} s)`]),
      tone: 'plain',
    };
  }
  const context = model.contextLength === null ? 'loaded' : `loaded ${formatTokens(model.contextLength)}`;
  const left = model.expiresInSec === null ? null : model.expiresInSec === Infinity ? 'no timeout' : `${formatDuration(model.expiresInSec)} left`;
  return { id: 'model', label: 'model', text: joinFields([model.tag, joinFields([context, left])]), tone: 'good' };
}

/**
 * @param {GuardBanner} guard
 * @returns {BannerLine}
 */
function buildGuardLine(guard) {
  const passed = guard.verdict.startsWith('pass');
  const needs = `needs ${gib(guard.modelVramMiB)} + ${gib(guard.minFreeVramAfterLoadMiB)}`;
  const vram = guard.freeVramMiB === null
    ? `free VRAM not measured, ${needs} GiB`
    : `free VRAM ${gib(guard.freeVramMiB)} GiB, ${needs}`;
  const notMeasured = guard.notMeasured ?? [];
  const text = joinFields([
    guard.verdict,
    passed ? vram : guard.reasons[0] ?? vram,
    `imports ${guard.imports}`,
    guard.editors === null ? 'editors unknown' : `editors ${guard.editors}`,
    notMeasured.length === 0 ? null : `not measured here: ${notMeasured.join(', ')}`,
  ]);
  return { id: 'guard', label: 'guard', text, tone: passed ? (notMeasured.length === 0 ? 'good' : 'warn') : 'bad' };
}

/**
 * @param {BudgetBanner} budget
 * @returns {BannerLine}
 */
function buildBudgetLine(budget) {
  return {
    id: 'budget',
    label: 'budget',
    text: joinFields([
      `fixed prompt ~${formatTokens(budget.fixedPromptTokens)} / ${formatTokens(budget.promptBudget)}`,
      `compaction at ${formatTokens(Math.floor(budget.numCtx * COMPACTION_FRACTION))}`,
      `bash: ${budget.bashMode === 'allowlist' ? 'allow-list' : 'ask'}`,
    ]),
    tone: budget.fixedPromptTokens >= budget.prefixFailTokens ? 'warn' : 'plain',
  };
}

/**
 * @param {ConfigBanner} config
 * @returns {BannerLine}
 */
function buildConfigLine(config) {
  const rules = config.verified ? `effective rules verified${config.cached ? ' (cached)' : ''}` : 'effective rules not verified';
  return {
    id: 'config',
    label: 'config',
    text: joinFields([rules, `editor agent: ${config.editorAgent ? 'on' : 'off'}`]),
    tone: config.verified ? 'plain' : 'warn',
  };
}

/**
 * @param {BannerLine[]} lines
 * @param {readonly ExtraBannerLine[]} extras
 * @returns {BannerLine[]}
 */
function insertExtraLines(lines, extras) {
  /** @type {BannerLine[]} */
  const out = [];
  for (const line of lines) {
    out.push(line);
    for (const extra of extras) {
      if (extra.after === line.id) out.push({ id: extra.id, label: extra.label, text: extra.text, tone: extra.tone ?? 'plain' });
    }
  }
  return out;
}

/**
 * @param {number} mib
 * @returns {string}
 */
function gib(mib) {
  return (mib / 1024).toFixed(1);
}
