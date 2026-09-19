# Completion status — preview.8

Updated 2026-09-19. The Windows preview integrates the remaining implementation slices from the original unfinished checkout. The original source worktree is preserved. The integration starts from preview.5 commit `85b80c69d9444f13b9dbe972f7fce2ae2cb89827`.

## Delivered

| Area | Result | Verification |
| --- | --- | --- |
| Config/profile | Schema-v2 migration, released guard/delegation preferences preserved, read-only migration stays in memory | Migration and package upgrade tests |
| Delegation/hosts | Persistent controls retained; managed install, verify, update and uninstall; setup integration preserves edits | Isolated host lifecycle and command tests |
| Network | Per-session bounded policy, shell classification, request asks and effective-permission verification | Unit fixtures, six real OpenCode permission contracts, two network protocol scenarios |
| Workspace | Unity plus service and standalone service discovery; bounded facts without sensitive configuration values | Component fixtures and init-to-start inspection |
| Shape | Text, file and stdin request handling; one guarded rewrite; `--no-model` | Shape suites and actual CLI no-model exercise |
| Diagnostics | Real OpenCode capture/selftest and mock benchmark suites; bounded live text-edit benchmark | Eight real OpenCode scenarios; local model benchmark not run while guard refuses |
| Documentation | README handoff integrated; generated CLI/config/install references; network, host, workspace and token accounting notes | Generator drift, claims, link and package checks |
| Accounting | Measured local usage separated from source-input estimates; returned text subtracted; no credit for failed/partial work | Ledger regression tests |

## Release validation

- Full local suite: **3,864 passed, zero failed or skipped** on Windows / Node 24.13.0.
- Existing critical-module coverage gate: **99.55% lines, 93.78% branches, 97.61% functions**; required line threshold remains 90%.
- Real OpenCode 1.18.31: **6 permission contracts**, **8 diagnostic scenarios**, and **2 network scenarios** passed. The enabled network scenario made exactly one loopback HTTP request and returned the result to the model turn.
- Enabled package round trip passed: pack, install, setup, init, launch inspection, diagnosis and uninstall.
- Typecheck, lint, release prechecks and generated documents passed. GitHub CI and the release workflow supply the cross-platform result for the published tag.
- [Final validation](evidence/preview-8-validation.json) and [original-change inventory](evidence/preview-6-validation.json). The earlier [config-only snapshot](evidence/config-v2-integration.json) is historical and its deferred labels are superseded here.

The preview.6 and preview.7 workflows stopped before publication because portable tests assumed Windows defaults, found a local OpenCode instead of an isolated fixture, and omitted mock timeout/server handles. The corrected implementation passed all eight jobs in [CI run 35466304801](https://github.com/furkantokkan/opencode-unity/actions/runs/35466304801), including four Windows/Ubuntu Node 22/24 suites, macOS smoke, lint, actual OpenCode contracts and the package round trip. Preview.8 packages this result.

A separate Codex session ran one real preview.7 delegation job: 5,967 input plus 210 output tokens in 32.808 seconds. Command execution succeeded but the summary was semantically partial. Raw source-text reduction was estimated at 4,554 tokens before overhead; the net estimate and usable savings credit were both **0** after preparation and verification. No repeated model job was used to improve the reported result. See the [measurement report](evidence/delegation-measurement.md) and its detailed session record. Delegation code is unchanged between that trial and preview.8.

## Remaining stable-release and hardware gates

1. Linux NVIDIA/AMD and macOS process/memory probes, compatible presets and actual device evidence. Missing measurements continue to block model loads.
2. Larger reference-hardware native-tool reliability runs and live toolcall/editor benchmark suites. Mock protocol success does not satisfy this gate.
3. Automatic insertion of shaping into interactive sessions; execution of reserved `project.verify` and additional `safety.multiplayerProtectedGlobs` policy. The current release documents these as reserved rather than claiming protection it does not implement.
4. Antigravity managed installation and an explicit visible monitor-window check in a real host UI.
5. Stable npm publication after these acceptance gates. Preview.8 is distributed as a GitHub prerelease.

Historical spike files remain research material in the original checkout; their release-facing diagnostic requirements are implemented in the bounded runtime harness. They are not silently promoted into supported features.

## Key points

- Root causes fixed: config fields leaking into the strict runtime contract; missing CLI/host/workspace wiring; incomplete network permission checks; duplicated UI metadata in token budgeting; overstated delegation savings.
- Changed systems: config/migrations, CLI/install, project facts, guard probes, network plugin, selftest/bench and documentation.
- Next work follows the hardware/reliability gates above. No reset or cleanup of the original unfinished checkout was performed.
