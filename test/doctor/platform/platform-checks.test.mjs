// Platform and tier checks (amendment 38.3a, fixture root test/doctor/platform/). Every case injects the
// platform facts, so the suite judges macOS, Linux and WSL identically on every runner.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasAmdgpuCard, resolveBackend, resolveCapabilities, REQUIRED_CAPABILITIES } from '../../../src/doctor/capabilities.js';
import { findCheck } from '../../../src/doctor/checks/index.js';
import { LINUX_FACTS, MAC_FACTS, WINDOWS_FACTS, makeContext, platformInfoFor, runOne } from '../helpers.mjs';

/**
 * @param {string} id
 * @param {import('../../../src/doctor/context.js').DoctorContext} context
 */
function outcome(id, context) {
  const check = findCheck(id);
  assert.ok(check);
  return runOne(check, context)[0];
}

const WSL_FACTS = Object.freeze({ ...LINUX_FACTS, virtualization: 'wsl', virtualizationSignals: ['WSL_DISTRO_NAME'] });

describe('platform.tier', () => {
  it('is a note at the full tier on Windows', () => {
    const finding = outcome('platform.tier', makeContext());
    assert.equal(finding.severity, 'info');
    assert.equal(finding.data.tier, 'full');
  });

  it('reports the honest degraded tier on macOS, with what the row cannot measure and what it refuses', () => {
    const finding = outcome('platform.tier', makeContext({ facts: MAC_FACTS }));
    assert.equal(finding.severity, 'info');
    assert.equal(finding.data.tier, 'degraded');
    assert.deepEqual(finding.data.notMeasured, ['accelerator.utilization']);
    assert.ok(finding.details.some((detail) => detail.startsWith('not measured on this row')));
  });

  it('lists the refused commands on macOS Intel', () => {
    const finding = outcome('platform.tier', makeContext({ facts: { ...MAC_FACTS, arch: 'x64' } }));
    assert.ok(/** @type {string[]} */ (finding.data.refusedCommands).includes('start'));
  });

  it('is an error when the matrix refuses doctor itself', () => {
    const context = makeContext();
    const refused = { ...context.platformInfo, doctorTier: { ...context.platformInfo.doctorTier, tier: 'refused', message: 'not here' } };
    const finding = outcome('platform.tier', makeContext({ platformInfo: refused }));
    assert.equal(finding.severity, 'error');
    assert.equal(finding.message, 'not here');
  });
});

describe('platform.accelerator-backend', () => {
  it('is a note when nvidia-smi measures memory', () => {
    assert.equal(outcome('platform.accelerator-backend', makeContext()).severity, 'info');
  });

  it('warns when the backend has no probe in this build', () => {
    const finding = outcome('platform.accelerator-backend', makeContext({ facts: MAC_FACTS }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.message, /darwin-unified/);
  });
});

describe('platform.probe-missing', () => {
  it('passes on Windows with nvidia-smi, where the working-set cap does not apply', () => {
    assert.equal(outcome('platform.probe-missing', makeContext()).severity, 'pass');
  });

  it('is an error for a missing required capability on an installed machine', () => {
    const finding = outcome('platform.probe-missing', makeContext({ facts: LINUX_FACTS }));
    assert.equal(finding.severity, 'error');
    assert.deepEqual(finding.data.missingRequired, ['process.enumerate', 'process.cpuTime', 'process.classify']);
  });

  it('is lowered to a warning on macOS before setup, which is what keeps the smoke job at exit 0', () => {
    const finding = outcome('platform.probe-missing', makeContext({ facts: MAC_FACTS, home: { installed: false } }));
    assert.equal(finding.severity, 'warn');
    assert.equal(finding.declaredSeverity, 'error');
  });

  it('warns when only an advisory capability is missing', () => {
    const context = makeContext();
    const capabilities = context.platformInfo.capabilities.map((capability) =>
      capability.id === 'accelerator.utilization' ? { ...capability, measured: false } : capability);
    const finding = outcome('platform.probe-missing', makeContext({ platformInfo: { ...context.platformInfo, capabilities } }));
    assert.equal(finding.severity, 'warn');
    assert.deepEqual(finding.data.missing, ['accelerator.utilization']);
  });
});

describe('platform.virtualized-host', () => {
  it('is an error inside WSL, even before setup (CP-D11)', () => {
    const finding = outcome('platform.virtualized-host', makeContext({ facts: WSL_FACTS, home: { installed: false } }));
    assert.equal(finding.severity, 'error');
    assert.equal(finding.loweredBy, null);
    assert.match(finding.message, /host/);
    assert.deepEqual(finding.data.signals, ['WSL_DISTRO_NAME']);
  });

  it('does not apply on a real host', () => {
    assert.equal(outcome('platform.virtualized-host', makeContext()).severity, 'skip');
  });
});

describe('platform.unified-memory-cap', () => {
  it('is a note on macOS and does not apply elsewhere', () => {
    assert.equal(outcome('platform.unified-memory-cap', makeContext({ facts: MAC_FACTS })).severity, 'info');
    assert.equal(outcome('platform.unified-memory-cap', makeContext()).severity, 'skip');
  });
});

describe('platform.linux-ollama-journal', () => {
  const journal = { kind: 'journal', unit: 'ollama', command: ['journalctl', '-u', 'ollama', '--no-pager'] };

  it('warns when the journal cannot be read (R22)', () => {
    const finding = outcome('platform.linux-ollama-journal', makeContext({ facts: LINUX_FACTS, logs: { source: journal, read: false, unreadableReason: 'No journal files were opened due to insufficient permissions.' } }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.details[0], /insufficient permissions/);
  });

  it('passes when it can, and does not apply to a log file', () => {
    assert.equal(outcome('platform.linux-ollama-journal', makeContext({ facts: LINUX_FACTS, logs: { source: journal, read: true } })).severity, 'pass');
    assert.equal(outcome('platform.linux-ollama-journal', makeContext()).severity, 'skip');
  });
});

describe('node.global-prefix-writable', () => {
  it('warns when a global install would need elevated rights (R21)', () => {
    const node = { prefix: '/usr', modulesDir: '/usr/lib/node_modules', source: 'derived', writable: false, checkedPath: '/usr/lib/node_modules' };
    const finding = outcome('node.global-prefix-writable', makeContext({ facts: LINUX_FACTS, node }));
    assert.equal(finding.severity, 'warn');
    assert.match(finding.message, /\/usr\/lib\/node_modules/);
  });

  it('passes when the prefix is writable', () => {
    assert.equal(outcome('node.global-prefix-writable', makeContext()).severity, 'pass');
  });
});

describe('capabilities', () => {
  it('names the four required capabilities of amendment 33.2', () => {
    assert.deepEqual([...REQUIRED_CAPABILITIES], ['accelerator.memory', 'process.enumerate', 'process.cpuTime', 'process.classify']);
  });

  it('marks the working-set cap applicable on macOS only', () => {
    const windows = resolveCapabilities({ facts: WINDOWS_FACTS, nvidiaSmiWorks: true });
    const mac = resolveCapabilities({ facts: MAC_FACTS, nvidiaSmiWorks: false });
    assert.equal(windows.find((capability) => capability.id === 'accelerator.workingSetCap')?.applicable, false);
    assert.equal(mac.find((capability) => capability.id === 'accelerator.workingSetCap')?.applicable, true);
    assert.ok(mac.every((capability) => !capability.measured));
  });

  it('measures accelerator memory only where nvidia-smi works, and processes only on Windows', () => {
    const linux = resolveCapabilities({ facts: LINUX_FACTS, nvidiaSmiWorks: true });
    assert.equal(linux.find((capability) => capability.id === 'accelerator.memory')?.measured, true);
    assert.equal(linux.find((capability) => capability.id === 'process.enumerate')?.measured, false);
  });

  it('resolves the backend from what is installed', () => {
    assert.equal(resolveBackend({ platform: 'win32', nvidiaSmiPresent: true }), 'nvidia-smi');
    assert.equal(resolveBackend({ platform: 'darwin', nvidiaSmiPresent: false }), 'darwin-unified');
    assert.equal(resolveBackend({ platform: 'linux', nvidiaSmiPresent: false, amdgpuPresent: true }), 'amdgpu-sysfs');
    assert.equal(resolveBackend({ platform: 'linux', nvidiaSmiPresent: false }), 'none');
    assert.equal(resolveBackend({ platform: 'win32', nvidiaSmiPresent: false }), 'none');
  });

  it('finds an amdgpu card by resolving the driver link, and ignores other entries', () => {
    const links = { '/sys/class/drm/card1/device/driver': '../../../bus/pci/drivers/amdgpu', '/sys/class/drm/card0/device/driver': '../../../bus/pci/drivers/i915' };
    const io = {
      readdir: () => ['card0', 'card0-DP-1', 'card1', 'renderD128'],
      readlink: (/** @type {string} */ target) => links[/** @type {keyof typeof links} */ (target.replace(/\\/g, '/'))] ?? null,
    };
    assert.equal(hasAmdgpuCard('/sys/class/drm', io), true);
    assert.equal(hasAmdgpuCard('/sys/class/drm', { readdir: () => ['card0'], readlink: () => '../drivers/i915' }), false);
    assert.equal(hasAmdgpuCard('/sys/class/drm', { readdir: () => [], readlink: () => null }), false);
  });

  it('builds a platform info block for every shipped row the helpers use', () => {
    for (const facts of [WINDOWS_FACTS, MAC_FACTS, LINUX_FACTS, WSL_FACTS]) {
      const info = platformInfoFor(facts);
      assert.equal(info.block.os, facts.os);
      assert.equal(typeof info.doctorTier.tier, 'string');
    }
  });
});
