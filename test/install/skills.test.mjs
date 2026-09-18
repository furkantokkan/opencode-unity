// The skill path contract (spec 12.6) and the --delegate to --host seam (amendment D-H1).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readManifestSchema } from '../../src/install/manifest.js';
import { SKILL_ROOT_SEGMENTS, describeDeprecatedDelegateFlag, resolveSkillPath } from '../../src/install/skills.js';

describe('skill paths', () => {
  it('puts the Claude Code skill under ~/.claude/skills and the Codex one under ~/.agents/skills', () => {
    assert.equal(resolveSkillPath('claude', { homedir: '/home/user', platform: 'linux' }), '/home/user/.claude/skills/opencode-unity-delegate/SKILL.md');
    assert.equal(resolveSkillPath('codex', { homedir: '/home/user', platform: 'linux' }), '/home/user/.agents/skills/opencode-unity-delegate/SKILL.md');
    assert.equal(resolveSkillPath('claude', { homedir: 'C:\\Users\\user', platform: 'win32' }), 'C:\\Users\\user\\.claude\\skills\\opencode-unity-delegate\\SKILL.md');
  });

  it('has a path for every target the manifest schema allows', () => {
    const targets = /** @type {Array<'claude'|'codex'>} */ (readManifestSchema().$defs.skillCopyEntry.properties.target.enum);
    assert.deepEqual(Object.keys(SKILL_ROOT_SEGMENTS).sort(), [...targets].sort());
    for (const target of targets) assert.match(resolveSkillPath(target, { homedir: '/home/user', platform: 'linux' }), /SKILL\.md$/);
  });

  it('refuses an unknown target and a missing home', () => {
    assert.throws(() => resolveSkillPath(/** @type {any} */ ('cursor'), { homedir: '/home/user' }), /Unknown skill target/);
    assert.throws(() => resolveSkillPath('claude', { homedir: '' }), /home directory/);
  });
});

describe('host seam', () => {
  it('says in one line where --delegate went', () => {
    const line = describeDeprecatedDelegateFlag(['claude', 'codex']);
    assert.equal(line.split('\n').length, 1);
    assert.match(line, /--host claude,codex/);
  });
});
