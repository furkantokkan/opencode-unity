import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DARWIN_MIN_MAJOR,
  WINDOWS_MIN_BUILD,
  detectPlatform,
  detectVirtualization,
  isOsVersionSupported,
  resolveShellFamily,
} from '../../../src/core/platform.js';

/**
 * @param {Record<string, string>} files
 * @returns {{ readFile: (path: string) => string | null, exists: (path: string) => boolean }}
 */
function fakeFs(files) {
  return {
    readFile: (path) => files[path] ?? null,
    exists: (path) => Object.hasOwn(files, path),
  };
}

const WSL_PROC_VERSION = 'Linux version 5.15.167.4-microsoft-standard-WSL2 (gcc ...) #1 SMP\n';
const HOST_PROC_VERSION = 'Linux version 6.8.0-45-generic (buildd@lcy02) #45-Ubuntu SMP\n';

describe('detectVirtualization (CP-D11)', () => {
  it('finds WSL from /proc/version, case-insensitively', () => {
    const found = detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/proc/version': WSL_PROC_VERSION }) });
    assert.equal(found.kind, 'wsl');
    assert.deepEqual(found.signals, ['/proc/version']);
    assert.equal(detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/proc/version': 'Linux version 5.15.0-MICROSOFT-standard' }) }).kind, 'wsl');
  });

  it('finds WSL from WSL_DISTRO_NAME', () => {
    const found = detectVirtualization({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...fakeFs({ '/proc/version': HOST_PROC_VERSION }) });
    assert.equal(found.kind, 'wsl');
    assert.deepEqual(found.signals, ['WSL_DISTRO_NAME']);
  });

  it('reports both signals when both fire', () => {
    const found = detectVirtualization({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...fakeFs({ '/proc/version': WSL_PROC_VERSION }) });
    assert.deepEqual(found.signals, ['WSL_DISTRO_NAME', '/proc/version']);
  });

  it('ignores WSL_DISTRO_NAME on Windows, where interop exports it into a host process', () => {
    assert.equal(detectVirtualization({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...fakeFs({}) }).kind, null);
  });

  it('finds a container from /.dockerenv', () => {
    const found = detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/.dockerenv': '' }) });
    assert.equal(found.kind, 'container');
    assert.deepEqual(found.signals, ['/.dockerenv']);
  });

  it('finds docker, containerd, lxc and kubepods in /proc/1/cgroup', () => {
    for (const runtime of ['docker', 'containerd', 'lxc', 'kubepods']) {
      const cgroup = `0::/${runtime}/6f3b2c1d\n`;
      const found = detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/proc/1/cgroup': cgroup }) });
      assert.equal(found.kind, 'container', runtime);
      assert.deepEqual(found.signals, ['/proc/1/cgroup']);
    }
  });

  it('leaves a plain host alone', () => {
    const found = detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/proc/version': HOST_PROC_VERSION, '/proc/1/cgroup': '0::/init.scope\n' }) });
    assert.deepEqual(found, { kind: null, signals: [] });
  });

  it('reports WSL rather than container when a WSL distribution also looks containerised', () => {
    const found = detectVirtualization({ platform: 'linux', env: {}, ...fakeFs({ '/proc/version': WSL_PROC_VERSION, '/.dockerenv': '' }) });
    assert.equal(found.kind, 'wsl');
  });

  it('treats an unreadable /proc as a plain host, because the files simply do not exist off Linux', () => {
    assert.deepEqual(detectVirtualization({ platform: 'darwin', env: {}, ...fakeFs({}) }), { kind: null, signals: [] });
  });
});

describe('isOsVersionSupported', () => {
  it('requires Windows 10 22H2 (claim 93)', () => {
    assert.equal(isOsVersionSupported({ platform: 'win32', release: `10.0.${WINDOWS_MIN_BUILD}` }), true);
    assert.equal(isOsVersionSupported({ platform: 'win32', release: '10.0.26200' }), true);
    assert.equal(isOsVersionSupported({ platform: 'win32', release: '10.0.19044' }), false);
    assert.equal(isOsVersionSupported({ platform: 'win32', release: '6.1.7601' }), false);
  });

  it('requires macOS 14 Sonoma, which is Darwin 23 (claim 108)', () => {
    assert.equal(isOsVersionSupported({ platform: 'darwin', release: `${DARWIN_MIN_MAJOR}.6.0` }), true);
    assert.equal(isOsVersionSupported({ platform: 'darwin', release: '24.1.0' }), true);
    assert.equal(isOsVersionSupported({ platform: 'darwin', release: '22.6.0' }), false);
  });

  it('says null where no minimum is documented, rather than guessing one', () => {
    assert.equal(isOsVersionSupported({ platform: 'linux', release: '6.8.0-45-generic' }), null);
    assert.equal(isOsVersionSupported({ platform: 'win32', release: 'not-a-version' }), null);
    assert.equal(isOsVersionSupported({ platform: 'darwin', release: 'unknown' }), null);
  });
});

describe('resolveShellFamily', () => {
  it('selects the family whose grammar the classifier must apply', () => {
    assert.equal(resolveShellFamily({ platform: 'win32' }), 'powershell');
    assert.equal(resolveShellFamily({ platform: 'linux' }), 'posix');
    assert.equal(resolveShellFamily({ platform: 'darwin' }), 'posix');
  });
});

describe('detectPlatform', () => {
  it('collects every fact the matrix matches on, and spawns nothing', () => {
    const found = detectPlatform({
      platform: 'linux',
      arch: 'x64',
      env: {},
      release: '6.8.0-45-generic',
      backend: 'amdgpu-sysfs',
      ...fakeFs({ '/proc/version': HOST_PROC_VERSION }),
    });
    assert.deepEqual(found, {
      os: 'linux',
      arch: 'x64',
      release: '6.8.0-45-generic',
      osVersionSupported: null,
      virtualization: null,
      virtualizationSignals: [],
      shellFamily: 'posix',
      backend: 'amdgpu-sysfs',
    });
  });

  it('leaves the backend unknown until the probe layer resolves it', () => {
    assert.equal(detectPlatform({ platform: 'win32', arch: 'x64', env: {}, release: '10.0.26200', ...fakeFs({}) }).backend, 'unknown');
  });

  it('carries the virtualization signals through for the doctor finding', () => {
    const found = detectPlatform({ platform: 'linux', arch: 'x64', env: {}, release: '5.15.167.4-microsoft-standard-WSL2', ...fakeFs({ '/proc/version': WSL_PROC_VERSION }) });
    assert.equal(found.virtualization, 'wsl');
    assert.deepEqual(found.virtualizationSignals, ['/proc/version']);
  });

  it('reads nothing from the real machine when the readers are injected', () => {
    let reads = 0;
    detectPlatform({
      platform: 'linux',
      arch: 'arm64',
      env: {},
      release: '6.8.0',
      readFile: () => {
        reads += 1;
        return null;
      },
      exists: () => false,
    });
    assert.ok(reads > 0);
  });
});
