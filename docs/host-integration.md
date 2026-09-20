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

## Task selection in a new session

`delegate on` persists permission to start new jobs. A loaded host skill chooses suitable subtasks;
it does not forward every user message. The skill now rejects small, already-read, tool-solvable,
ambiguous or expensive-to-verify work before preflight. Candidates go through the read-only
`delegate plan` command, then health and the selected `ask`, `map` or `edit` lane. The host supplies
the task category and verification method; the planner cannot validate natural-language intent.
See [routing examples and controls](../README.md#route-a-task-before-spending-model-tokens).

Require coverage of the named files and output fields, plus cited evidence or a focused check.
An incomplete or unsupported answer stays partial even if the model request returned `ok: true`.
Source-input reduction is not net savings; include review and handoff costs in any comparison.

A new session is ready to use these instructions after `host verify` passes for the installed CLI.
Whether the host actually follows them is evidenced by its handoff message and a matching job ID in
`delegate status --json`. The switch alone proves permission, not that a model job ran.

### Check whether a new session used labor

Check `opencode-unity delegate status --json` for active jobs and recent results, and
`opencode-unity delegate ledger --since 1d --json` for recent usage. Match each job's working
directory and timestamp to the host session. Read-only `plan` and `health` calls are not model jobs.

Inspect the host's visible messages and command history to distinguish these cases:

- No delegation call: the host has not started a job. Without an explanation, the reason is unknown;
  do not attribute every unused session to a GPU block. This skill is guidance, not a mandatory host hook.
- `plan` returns `host`: the task stays with the main agent; no inference was requested.
- `health` refuses: report the returned reason. An `ollama_unreachable` result can mean the Ollama
  app/server is stopped; RAM offload cannot fix that. Do not retry automatically or relax other guards.
- `health` passes: the worker is available at that moment. Only a subsequent model job proves use.

When explaining a decision, distinguish unsuitable work from unavailable resources. Keep small,
already-read or tool-solvable work with the host; do not start a demonstration job just to add history.
For an explicit RAM-offload opt-in, use the [configuration steps](../README.md#opt-into-system-ram-offload).

## Update or remove a host skill

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
