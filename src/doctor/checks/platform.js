// Platform and tier checks (amendment 33.9, 38.3a; CP-D11, R21, R22).
//
// These run first and print first, because every later finding means something different depending on
// what this machine can measure. A WARN about the guard on a row where no accelerator probe ships is
// not the same claim as the same WARN on Windows.
import { REQUIRED_CAPABILITIES } from '../capabilities.js';
import { error, info, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** @type {readonly CheckSpec[]} */
export const PLATFORM_CHECKS = Object.freeze([
  {
    id: 'platform.tier',
    group: 'platform',
    title: 'Support tier for this machine',
    severities: ['error', 'info'],
    why: 'A tier says how much of this product has been run on this kind of machine, which decides what every other finding is worth.',
    fix: 'Run the refused commands on a supported machine, or pass --experimental to accept an experimental row.',
    source: 'amendment 33.4 and src/core/tiers.json',
    run: (context) => {
      const { doctorTier, refusedCommands } = context.platformInfo;
      const details = [
        `matrix row: ${doctorTier.rowLabel}`,
        ...(doctorTier.notMeasured.length > 0 ? [`not measured on this row: ${doctorTier.notMeasured.join(', ')}`] : []),
        ...(doctorTier.note === null ? [] : [doctorTier.note]),
        ...(refusedCommands.length > 0 ? [`refused here: ${refusedCommands.join(', ')}`] : []),
      ];
      const data = { tier: doctorTier.tier, row: doctorTier.row, notMeasured: doctorTier.notMeasured, refusedCommands };
      if (doctorTier.tier === 'refused') {
        return error(doctorTier.message ?? 'doctor is refused on this machine', { details, data });
      }
      return info(`doctor runs at the '${doctorTier.tier}' tier on ${context.platformInfo.facts.os}/${context.platformInfo.facts.arch}`, { details, data });
    },
  },
  {
    id: 'platform.accelerator-backend',
    group: 'platform',
    title: 'Accelerator backend',
    severities: ['warn', 'info'],
    why: 'The guard decides from free video memory. Without an accelerator probe it cannot read any, so it fails closed instead of protecting anything.',
    fix: 'Install the vendor tool the backend needs, or accept that the guard blocks rather than measures on this machine.',
    source: 'amendment 33.5, 33.6 and spec 7.2',
    run: (context) => {
      const { facts, capabilities } = context.platformInfo;
      const memory = capabilities.find((capability) => capability.id === 'accelerator.memory');
      const data = { backend: facts.backend, measured: memory?.measured === true };
      if (memory?.measured === true) return info(`the accelerator backend is ${facts.backend}`, { data });
      return warn(`the accelerator backend is ${facts.backend} and nothing reads its memory here`, {
        details: [memory?.source ?? 'no accelerator probe was selected'],
        data,
      });
    },
  },
  {
    id: 'platform.probe-missing',
    group: 'platform',
    title: 'Guard probes available here',
    severities: ['error', 'warn'],
    why: 'A capability with no probe behind it is not a passing check, it is an unasked question, and the guard has to treat it as one.',
    fix: 'Run on a platform whose probes ship in this version, or expect blocked verdicts instead of measured ones.',
    source: 'amendment 33.6 result algebra',
    run: (context) => {
      const missing = context.platformInfo.capabilities.filter((capability) => capability.applicable && !capability.measured);
      if (missing.length === 0) return pass('every guard capability that applies here has a probe');
      const required = missing.filter((capability) => capability.required);
      const data = {
        missing: missing.map((capability) => capability.id),
        missingRequired: required.map((capability) => capability.id),
        requiredCapabilities: REQUIRED_CAPABILITIES,
      };
      const details = missing.map((capability) => `${capability.id}: ${capability.source}`);
      if (required.length === 0) {
        return warn(`${quantity(missing.length, 'advisory guard capability', 'advisory guard capabilities')} not measured here`, { details, data });
      }
      return error(`the guard cannot measure ${required.map((capability) => capability.id).join(' or ')} on this machine`, { details, data });
    },
  },
  {
    id: 'platform.virtualized-host',
    group: 'platform',
    title: 'Virtualized host',
    severities: ['error'],
    why: 'Inside WSL or a container every probe answers, and answers about the wrong machine: the Unity Editor and the display driver live on the host.',
    fix: 'Run opencode-unity on the host instead.',
    source: 'amendment CP-D11 and src/core/tiers.json',
    // A confidently wrong guard is the same danger before and after setup, so the policy that lowers
    // findings on an unconfigured machine does not apply to this one.
    alwaysSevere: true,
    run: (context) => {
      const { facts, doctorTier } = context.platformInfo;
      if (facts.virtualization === null) return skip('this is not a virtualized host');
      return error(doctorTier.message ?? `this process runs inside ${facts.virtualization}`, {
        details: [`detected from: ${facts.virtualizationSignals.join(', ')}`],
        data: { virtualization: facts.virtualization, signals: facts.virtualizationSignals },
      });
    },
  },
  {
    id: 'platform.unified-memory-cap',
    group: 'platform',
    title: 'Unified memory on macOS',
    severities: ['info'],
    why: 'On Apple silicon the model and the rest of the system share one memory pool, so a video-memory headroom number measured on a discrete card does not transfer.',
    fix: 'Treat the guard headroom values as uncalibrated here and watch memory pressure yourself.',
    source: 'amendment 33.5 and the preset gating of 33.4',
    run: (context) => {
      if (context.platformInfo.facts.os !== 'darwin') return skip('this platform has separate video memory');
      const minFree = context.home.config.guard.minFreeVramAfterLoadMiB;
      return info('memory is unified on this machine, so the guard headroom value is an estimate rather than a measurement', {
        details: [`guard.minFreeVramAfterLoadMiB is ${minFree}; no shipped preset was measured on this hardware`],
        data: { minFreeVramAfterLoadMiB: minFree },
      });
    },
  },
  {
    id: 'platform.linux-ollama-journal',
    group: 'platform',
    title: 'Ollama journal readable',
    severities: ['warn'],
    why: 'On Linux the Ollama server log is the systemd journal. Without access to it the truncation history cannot be read at all.',
    fix: 'Add your user to the systemd-journal group, or pass --logs <path>.',
    source: 'amendment 33.8 and R22',
    run: (context) => {
      if (context.logs.source.kind !== 'journal') return skip('the server log is not a journal on this platform');
      if (context.logs.read) return pass('the Ollama journal is readable');
      return warn('the Ollama journal could not be read, so truncation history is not checked here', {
        details: [context.logs.unreadableReason ?? 'no reason reported'],
        data: { unit: context.logs.source.unit },
      });
    },
  },
  {
    id: 'node.global-prefix-writable',
    group: 'platform',
    title: 'Global npm prefix writable',
    severities: ['warn'],
    why: 'A global install run with sudo leaves root-owned files that a later upgrade or uninstall cannot remove without sudo again.',
    fix: 'Point npm at a prefix you own (npm config set prefix), or use a Node version manager, instead of installing globally with sudo.',
    source: 'amendment R21',
    run: (context) => {
      if (context.node.writable) return pass(`global npm installs land in a directory you can write (${context.node.modulesDir})`);
      return warn(`global npm installs would need elevated rights: ${context.node.checkedPath} is not writable`, {
        details: [`prefix ${context.node.prefix} (${context.node.source})`],
        data: { prefix: context.node.prefix, modulesDir: context.node.modulesDir, checkedPath: context.node.checkedPath },
      });
    },
  },
]);
