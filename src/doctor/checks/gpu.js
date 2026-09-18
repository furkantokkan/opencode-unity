// GPU checks: headroom, the guard's own verdict, driver resets and the lock (spec 5.4, 7.3, 7.8).
import { describeGpuLock } from '../../core/lock.js';
import { formatVerdictSummary } from '../../../plugin/opencode-unity-lib/guard/messages.js';
import { error, info, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Below this much headroom above the guard minimum, a load is going to be refused sooner or later. */
const TIGHT_HEADROOM_MIB = 1000;

/** @type {readonly CheckSpec[]} */
export const GPU_CHECKS = Object.freeze([
  {
    id: 'vram.headroom',
    group: 'gpu',
    title: 'Video memory headroom for the preset',
    severities: ['error', 'warn'],
    why: 'The preset states what the model needs; the guard refuses a load that would leave the rest of the machine below its minimum, and that refusal is the whole point of the guard.',
    fix: 'Free video memory, choose a preset with a smaller context, or set guard.allowOffload so the part that does not fit runs from system RAM.',
    source: 'spec 7.3 and 7.4',
    run: (context) => {
      const estimate = context.profileInfo.vram;
      const memory = context.gpu.verdict?.measurements.gpu?.memory;
      if (estimate === null) return skip('the runtime profile could not be built');
      if (memory === undefined || !memory.ok) {
        return skip(memory === undefined ? 'no video memory reading was taken on this run' : `video memory could not be read: ${memory.error}`);
      }
      const minimum = context.home.config.guard.minFreeVramAfterLoadMiB;
      const allowOffload = context.home.config.guard.allowOffload;
      const reclaimable = context.gpu.verdict?.model.reclaimableMiB ?? 0;
      const available = memory.freeMiB + reclaimable;
      const afterLoad = available - estimate.modelVramMiB;
      const data = {
        modelVramMiB: estimate.modelVramMiB,
        kvType: estimate.kvType,
        freeMiB: memory.freeMiB,
        totalMiB: memory.totalMiB,
        reclaimableMiB: reclaimable,
        freeAfterLoadMiB: afterLoad,
        minFreeVramAfterLoadMiB: minimum,
        allowOffload,
      };
      const details = [`the preset needs about ${estimate.modelVramMiB} MiB with a ${estimate.kvType} cache; ${available} MiB is available`];
      if (afterLoad < minimum) {
        if (allowOffload && available >= minimum) {
          const offload = estimate.modelVramMiB - (available - minimum);
          return warn(`about ${offload} MiB of the model would run from system RAM because guard.allowOffload is on, and replies will be slower`, { details, data });
        }
        return error(`loading the model would leave ${afterLoad} MiB free, below the ${minimum} MiB minimum`, { details, data });
      }
      if (afterLoad - minimum < TIGHT_HEADROOM_MIB) {
        return warn(`loading the model would leave ${afterLoad} MiB free, just above the ${minimum} MiB minimum`, { details, data });
      }
      return pass(`loading the model would leave ${afterLoad} MiB free`, { details, data });
    },
  },
  {
    id: 'gpu.guard',
    group: 'gpu',
    title: 'Guard verdict right now',
    severities: ['error', 'info'],
    why: 'This is the verdict a launch would get at this moment, with the reasons the guard would give for it.',
    fix: 'Close what is using the GPU, or read the listed reasons and decide which one to act on.',
    source: 'spec 7.3',
    run: (context) => {
      const verdict = context.gpu.verdict;
      if (verdict === null) return skip(context.gpu.error ?? 'the guard was not evaluated');
      const data = {
        verdict: verdict.verdict,
        path: verdict.path,
        mode: verdict.mode,
        reasons: verdict.reasons.map((reason) => ({ id: reason.id, detail: reason.detail })),
        model: { state: verdict.model.state, loaded: verdict.model.loaded },
      };
      const details = [...verdict.reasons.map((reason) => `${reason.id}: ${reason.detail}`), ...verdict.notes];
      if (verdict.pass) return info(formatVerdictSummary(verdict), { details, data });
      return error(`the guard would block a load right now: ${verdict.reasons.map((reason) => reason.id).join(', ')}`, { details, data });
    },
  },
  {
    id: 'gpu.driver-resets',
    group: 'gpu',
    title: 'Recent display driver resets',
    severities: ['warn'],
    why: 'A display driver reset under load takes the Editor and the model down together, and a machine that has had one recently will have another.',
    fix: 'Lower the context size or the guard thresholds, and check the vendor driver release notes.',
    source: 'spec 5.4',
    run: (context) => {
      const { checked, events, error: queryError } = context.gpu.driverResets;
      if (context.platformInfo.facts.os !== 'win32') return skip('this reading is only available on Windows');
      if (!checked) return skip(queryError ?? 'the event log query did not run');
      if (events === 0) return pass('no display driver reset in the recent System log');
      return warn(`${quantity(events, 'display driver reset')} in the recent System log`, {
        data: { events, since: context.gpu.driverResets.since },
      });
    },
  },
  {
    id: 'gpu.lock',
    group: 'gpu',
    title: 'GPU lock holder',
    severities: ['warn', 'info'],
    why: 'One process at a time may load the model, and a command that appears to hang is often waiting for whoever holds the lock.',
    fix: 'Wait for the holder to finish, or delete the lock file once you are sure the process is gone.',
    source: 'spec 7.8',
    run: (context) => {
      const lock = context.gpu.lock;
      if (lock === null || lock.state === 'free') return pass('the GPU lock is free');
      const data = { state: lock.state, path: context.home.paths.gpuLock };
      if (lock.state === 'unreadable') return warn(`the GPU lock is ${describeGpuLock(lock)}`, { data });
      return info(`the GPU lock is ${describeGpuLock(lock)}`, { data });
    },
  },
]);
