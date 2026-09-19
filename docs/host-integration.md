# Host skill installation

Install the shipped delegation skill into Claude Code or Codex:

```sh
opencode-unity host install --host claude,codex --dry-run --json
opencode-unity host install --host claude,codex --yes --json
opencode-unity host verify --host claude,codex --json
```

The personal skill paths are `~/.claude/skills/opencode-unity-delegate/SKILL.md`
and `~/.agents/skills/opencode-unity-delegate/SKILL.md`. `--host auto` selects
hosts with an existing `.claude`, `.agents`, or `.codex` personal directory.
`--host-home <dir>` uses a different personal home for isolated testing.
The installation ledger still lives under `OPENCODE_UNITY_HOME`.

Open a **new host session** after installing or updating. Verification checks
file contents against the packaged skill. It does not prove that a running
host session loaded the skill or that local model inference is available.
Check `opencode-unity delegate health --json` separately before delegation.

After upgrading the CLI package:

```sh
opencode-unity host update --host claude,codex --yes --json
```

Files recorded in the installation manifest are replaced only while their
hashes still match. Edited or unowned files stay in place; the new release is
written beside them as `SKILL.md.ocu-new`. An existing, differing review
candidate is also kept. Merge it manually, then run `host verify` again.
An identical manually copied skill is valid but stays unowned.

Remove only unchanged files installed by this tool:

```sh
opencode-unity host uninstall --host claude,codex --dry-run --json
opencode-unity host uninstall --host claude,codex --yes --json
```

Edited files, manual copies, backup files, review candidates, other host
skills, and product data remain. The command rechecks the ownership hashes
after consent. Symbolic links and unexpected file types are refused.
`--dry-run` never writes files or asks for consent.

This integration installs skills only. It does not edit host settings,
instruction files, permission rules, or auto-approval preferences.
Antigravity's file under `hosts/antigravity/` remains a manual integration.

## Verification

`test/unit/host/host.test.mjs` covers temporary-directory installation,
idempotence, verification, upgrades, scoped removal, dry-run behavior,
consent-time edits, rollback, symlink refusal, and preservation of user files.
These tests do not modify the real personal host directories.
