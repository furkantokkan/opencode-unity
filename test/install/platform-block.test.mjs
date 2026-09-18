// The platform block setup prints before its first question (amendment 38.3, 5.4 `setup`).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTier } from '../../src/core/platform.js';
import { buildPlatformData, describeBackend, describeTier, needsTierAcknowledgement, renderPlatformBlock } from '../../src/install/platform-block.js';
import { platformFacts } from './helpers.mjs';

describe('platform block', () => {
  it('names the system, the accelerator and each everyday command tier', () => {
    const lines = renderPlatformBlock(platformFacts());
    assert.equal(lines[0], 'Platform support');
    assert.equal(lines[1], '  system        win32 x64 (0.0.0)');
    assert.equal(lines[2], '  accelerator   nvidia-smi');
    assert.deepEqual(lines.slice(3, 7).map((line) => line.trim().split(/\s+/)[0]), ['setup', 'init', 'start', 'doctor']);
  });

  it('says experimental on a Linux row, with what it does not measure', () => {
    const lines = renderPlatformBlock(platformFacts({ os: 'linux' }));
    assert.ok(lines.some((line) => /^ {2}setup {9}experimental/.test(line)), lines.join('\n'));
  });

  it('names a virtualized host and the refusal sentence', () => {
    const lines = renderPlatformBlock({ ...platformFacts({ os: 'linux', virtualization: 'wsl' }), virtualizationSignals: ['WSL_DISTRO_NAME'] });
    assert.ok(lines.includes('  virtualized   wsl (WSL_DISTRO_NAME)'));
    assert.ok(lines.some((line) => /refused/.test(line)));
  });

  it('carries the same tiers into data.platform', () => {
    const data = buildPlatformData(platformFacts({ os: 'linux' }));
    assert.equal(data.os, 'linux');
    assert.equal(data.tier, 'experimental');
    assert.deepEqual(Object.keys(/** @type {object} */ (data.commands)), ['setup', 'init', 'start', 'doctor']);
  });

  it('asks for an acknowledgement on an experimental tier only', () => {
    assert.equal(needsTierAcknowledgement(resolveTier('setup', platformFacts({ os: 'linux' }))), true);
    assert.equal(needsTierAcknowledgement(resolveTier('setup', platformFacts())), false);
  });

  it('describes tiers and backends in words', () => {
    assert.equal(describeBackend('none'), 'none detected (CPU only)');
    assert.equal(describeBackend('unknown'), 'not determined');
    const tier = /** @type {any} */ ({ tier: 'experimental', degraded: true, noShippedPreset: true, experimentalBackend: true });
    assert.equal(describeTier(tier), 'experimental (degraded, no shipped preset, experimental accelerator backend)');
    assert.equal(describeTier(/** @type {any} */ ({ tier: 'full', degraded: false })), 'full');
  });
});
