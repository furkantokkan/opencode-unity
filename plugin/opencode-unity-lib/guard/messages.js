// Guard messages (spec section 7.6). The plugin throws them as Error text, and OpenCode 1.18.31
// decides from that text alone whether to retry (session/retry.ts L33-41, L148-154):
// - stop messages must match none of its patterns and must not contain "exhausted",
//   "unavailable" or "too_many_requests";
// - retry messages must contain "temporarily at capacity", which OpenCode retries up to 5 times.
// Numbers in these messages never form a run of three or more digits except "100", because
// /429|500|502|503|504|524/ matches digits anywhere ("1500 MiB" would read as HTTP 500). Probe error
// texts ("ECONNREFUSED", "timed out") never go into these messages; `opencode-unity guard` shows them.

export const GUARD_MESSAGE_PREFIX = 'opencode-unity GPU guard:';
export const RETRY_MARKER = 'temporarily at capacity';
const k_detailsHint = 'Details: opencode-unity guard';
const k_mibPerGib = 1024;

/**
 * @typedef {import('./decide.js').GuardVerdict} GuardVerdict
 * @typedef {import('./decide.js').GuardReason} GuardReason
 */

/**
 * The text OpenCode shows for a blocked verdict; null for a pass.
 * @param {GuardVerdict} verdict
 * @returns {string | null}
 */
export function formatGuardMessage(verdict) {
  if (verdict.pass || verdict.reasons.length === 0) return null;
  return verdict.mode === 'retry' ? formatRetryMessage(verdict.reasons) : formatStopMessage(verdict.reasons, verdict.path);
}

/**
 * The Error the plugin throws for a blocked verdict; null for a pass.
 * @param {GuardVerdict} verdict
 * @returns {Error | null}
 */
export function createGuardError(verdict) {
  const message = formatGuardMessage(verdict);
  return message === null ? null : new Error(message);
}

/**
 * @param {readonly GuardReason[]} reasons
 * @param {'remote' | 'loaded' | 'cold'} path
 * @returns {string}
 */
export function formatStopMessage(reasons, path) {
  const what = path === 'loaded' ? 'the request was held back' : 'the model was not loaded';
  const deciding = reasons.find((reason) => reason.mode === 'stop') ?? reasons[0];
  return `${GUARD_MESSAGE_PREFIX} ${what} because ${joinCauses(reasons)}. ${describeNextStep(deciding)}. ${k_detailsHint}`;
}

/**
 * @param {readonly GuardReason[]} reasons
 * @returns {string}
 */
export function formatRetryMessage(reasons) {
  return `${GUARD_MESSAGE_PREFIX} the local model is ${RETRY_MARKER} because ${joinCauses(reasons)}. OpenCode sends the prompt again by itself for about a minute. ${k_detailsHint}`;
}

/**
 * One line for CLI output: the verdict and its reasons with full probe details.
 * @param {GuardVerdict} verdict
 * @returns {string}
 */
export function formatVerdictSummary(verdict) {
  if (verdict.pass) return `pass (${verdict.path === 'loaded' ? 'model loaded' : verdict.path === 'remote' ? 'unguarded remote Ollama' : 'safe to load'})`;
  return `blocked: ${verdict.reasons.map((reason) => `${reason.id} (${reason.detail})`).join('; ')}`;
}

/**
 * GiB with one decimal for CLI output, for example `21.9 GiB`.
 * @param {number} mib
 * @returns {string}
 */
export function formatGiB(mib) {
  const text = (mib / k_mibPerGib).toFixed(1);
  return `${text === '-0.0' ? '0.0' : text} GiB`;
}

/**
 * GiB for a message OpenCode reads: one decimal, and never more than two integer digits.
 * @param {number} mib
 * @returns {string}
 */
export function formatMessageGiB(mib) {
  const gib = mib / k_mibPerGib;
  if (gib >= 99.95) return 'over 99 GiB';
  return formatGiB(Math.max(0, mib));
}

/**
 * CPU use for a message OpenCode reads: `63% CPU` up to one core, `2.5 CPU cores` above it.
 * @param {number} percent  100 = one logical core.
 * @returns {string}
 */
export function formatMessageCpu(percent) {
  const rounded = Math.round(Math.max(0, percent));
  if (rounded <= 100) return `${rounded}% CPU`;
  const cores = percent / 100;
  return cores >= 99.95 ? 'over 99 CPU cores' : `${cores.toFixed(1)} CPU cores`;
}

/**
 * A whole count or percent for a message OpenCode reads.
 * @param {number} value
 * @returns {string}
 */
export function formatMessageCount(value) {
  const rounded = Math.round(Math.max(0, value));
  return rounded > 100 ? 'over 99' : String(rounded);
}

/**
 * @param {readonly GuardReason[]} reasons
 * @returns {string}
 */
function joinCauses(reasons) {
  const causes = [];
  for (const reason of reasons) {
    const cause = describeCause(reason);
    if (!causes.includes(cause)) causes.push(cause);
  }
  return causes.join(' and ');
}

/**
 * @param {GuardReason} reason
 * @returns {string}
 */
function describeCause(reason) {
  switch (reason.id) {
    case 'remote_unguarded':
      return 'Ollama is set to a server on another computer, where the guard cannot check video memory';
    case 'ollama_unreachable':
      return 'Ollama did not answer';
    case 'too_many_editors':
      return `${formatMessageCount(reason.data.editorCount)} Unity editors are open (maximum ${formatMessageCount(reason.data.maxUnityEditors)})`;
    case 'import_busy':
      return describeImportCause(reason.data);
    case 'vram_low':
      return describeVramCause(reason.data);
    case 'gpu_busy':
      return `the GPU is busy (utilization ${reason.data.samples.map((sample) => `${formatMessageCount(sample)}%`).join(' then ')}, limit ${formatMessageCount(reason.data.maxGpuUtilPercent)}%)`;
    default:
      return describeProbeCause(reason.data.probe);
  }
}

/**
 * @param {import('./decide.js').ImportBusyData} data
 * @returns {string}
 */
function describeImportCause(data) {
  const parts = [];
  if (data.workers) parts.push(`Unity is importing assets (import workers at ${formatMessageCpu(data.workers.cpuPercent)})`);
  if (data.editor) parts.push(`a Unity editor is importing, compiling or in Play Mode (${formatMessageCpu(data.editor.cpuPercent)})`);
  return parts.join(' and ');
}

/**
 * @param {import('./decide.js').VramLowData} data
 * @returns {string}
 */
function describeVramCause(data) {
  const minimum = formatMessageGiB(data.minFreeVramAfterLoadMiB);
  if (data.freeAfterLoadMiB >= 0) return `free video memory would drop to ${formatMessageGiB(data.freeAfterLoadMiB)} (minimum ${minimum})`;
  return `the model needs ${formatMessageGiB(data.modelVramMiB)} but only ${formatMessageGiB(data.availableMiB)} of video memory is free (minimum ${minimum} left after loading)`;
}

/**
 * @param {import('./decide.js').ProbeName} probe
 * @returns {string}
 */
function describeProbeCause(probe) {
  switch (probe) {
    case 'settings':
      return 'the guard settings are not valid, so the load was refused to stay safe';
    case 'nvidia-smi-memory':
      return 'nvidia-smi could not report GPU memory, so the load was refused to stay safe';
    case 'nvidia-smi-utilization':
      return 'nvidia-smi could not report GPU utilization, so the load was refused to stay safe';
    case 'processes':
      return 'the Unity process check did not finish, so the request was refused to stay safe';
    default:
      return 'the guard check did not finish, so the request was refused to stay safe';
  }
}

/**
 * @param {GuardReason} reason
 * @returns {string}
 */
function describeNextStep(reason) {
  switch (reason.id) {
    case 'remote_unguarded':
      return 'Point opencode-unity at a local Ollama, or set guard.remote to unguarded to accept the risk';
    case 'ollama_unreachable':
      return 'Start Ollama, then send the prompt again';
    case 'too_many_editors':
      return 'Close a Unity editor, then send the prompt again';
    case 'import_busy':
      return 'Send the prompt again when Unity is idle';
    case 'vram_low':
      return 'Close GPU-heavy apps or unload other models, then send the prompt again';
    case 'gpu_busy':
      return 'Send the prompt again when the GPU work ends';
    default:
      return reason.data.probe === 'settings' ? 'Run opencode-unity doctor to find the setting' : 'Run opencode-unity guard to see which check failed';
  }
}
