// The environment agent shell commands run in (spec 8.7 `shell.env`, 8.1, P7).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ORIGINAL_XDG_ENV, UNSET_MARKER, applyShellEnv, buildShellEnv, resolveXdgConfigHome } from '../../../plugin/opencode-unity-lib/shell-env.js';

describe('agent shell environment', () => {
  it('always opts out of .NET telemetry and the logo', () => {
    const values = buildShellEnv({ env: {} });
    assert.equal(values.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
    assert.equal(values.DOTNET_NOLOGO, '1');
  });

  it('restores the XDG_CONFIG_HOME the user had before start isolated it', () => {
    const values = buildShellEnv({ env: { [ORIGINAL_XDG_ENV]: '/opt/config' } });
    assert.equal(values.XDG_CONFIG_HOME, '/opt/config');
  });

  it('uses the platform default when start recorded that there was none', () => {
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER }, '/opt/home'), '/opt/home/.config');
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER }, 'D:\\home\\dev'), 'D:\\home\\dev\\.config');
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER }, '/opt/home/'), '/opt/home/.config');
  });

  it('falls back to the usual home variables when no home was passed', () => {
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER, HOME: '/opt/h' }, null), '/opt/h/.config');
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER, USERPROFILE: 'E:\\h' }, null), 'E:\\h\\.config');
    assert.equal(resolveXdgConfigHome({ [ORIGINAL_XDG_ENV]: UNSET_MARKER }, null), null);
  });

  it('leaves XDG_CONFIG_HOME alone when start recorded nothing at all', () => {
    // A session that was not launched by `start` gets no guess: changing it would be a change the
    // product never measured.
    assert.equal(resolveXdgConfigHome({}, '/opt/home'), null);
    assert.equal(buildShellEnv({ env: {} }).XDG_CONFIG_HOME, undefined);
  });

  it('merges into the hook output object in place', () => {
    const target = { PATH: '/usr/bin', XDG_CONFIG_HOME: '/profile/xdg-config' };
    const result = applyShellEnv(target, { env: { [ORIGINAL_XDG_ENV]: '/opt/config' } });
    assert.equal(result, target);
    assert.equal(target.PATH, '/usr/bin');
    assert.equal(target.XDG_CONFIG_HOME, '/opt/config');
  });
});
