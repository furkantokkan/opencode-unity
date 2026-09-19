# Delegation routing validation

Scope: preview.9, based on preview.8 plus README commit `19e6054`.

## Behavior and checks

`test/delegate/plan.test.mjs` checks the public command handler with isolated home directories and a
mock Ollama server that records requests. Planning must leave that request log empty.

| Scenario | Required result |
| --- | --- |
| Debugging, design, security, deployment, review or unknown task kind | Host, before source reads |
| Existing tool solves the task, source already read, full or unknown verification | Host, before source reads |
| Several tiny files | Host; file count alone is not a benefit |
| Large bounded summary or explicit mechanical edit | One `ask` or `edit`, within the actual profile prompt budget |
| Combined prompt too large | Host for dependent work; `map` only for independently useful files that each fit |
| One file too large | Host, with the file named for scoping |
| Sensitive, binary or oversized file | Refuse without silently omitting input |
| Protected Unity or project file | Host |
| Delegation OFF | Exit 8, no model call, switches preserved |
| An abandoned apply journal exists | Leave source and journal unchanged; normal recovery still works separately |

The command parser validates task kinds, verification choices and required file scope. Existing
delegate, host install/update, help, registry and README checks cover integration and compatibility.

## Limits

- The host classifies the task and declares review scope. This is not natural-language classification
  or a security boundary, and direct `ask`/`map`/`edit` calls retain their existing interface.
- The 8,000-character threshold is a conservative heuristic, not a measured break-even point.
- Planning estimates context fit, not net or billed savings. The historical
  [separate-session measurement](delegation-measurement.md) remains unchanged; no new savings claim is made.
- Automated routing scenarios do not prove that every future host session will choose the right task
  or that the local model will return complete answers. Updated host skills require coverage checks
  and treat incomplete results as partial even when the request succeeded.

## Completion note

- Local automated verification: all 3,885 tests passed, including 21 routing scenarios; no failures
  or skipped tests. Typecheck, repository lint and release prechecks passed. Generated docs are current.
- Actual CLI smoke checks routed a bounded source summary to `ask` and a debugging task to `host`;
  both reported `modelCalled: false`. No local inference or new savings experiment was performed.
- Added the plan handler, CLI entry and focused scenarios; updated all shipped host instructions,
  answer guidance, generated CLI reference, README and host integration documentation.
- Preserved existing job guards, apply review/rollback, delegation switches and monitor preferences.
- Cross-platform and package-roundtrip jobs run again in the preview.9 release workflow.
