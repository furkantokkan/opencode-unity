# 0001 - Where the guard and the budget run

- Status: accepted
- Date: 2026-09-17
- Deciders: maintainers
- Spec: sections 1.2 (D1, D3, D6), 4.5, 7.5, 8.7, 8.10, 24.3 (M0)
- Evidence: `spikes/results/A.json`, `B.json`, `C.json` (redacted, produced by `node spikes/run-all.mjs`)

## Context

The GPU guard and the prompt budget must run before every model load that this product controls. Two
places were specified:

1. the **in-process OpenCode plugin**, which throws from `experimental.chat.system.transform` and
   `chat.params` before OpenCode builds the request;
2. a **loopback gate** (spec 8.10), an HTTP proxy in front of Ollama that answers 503 and 413.

The plugin is cheaper and has no extra port, but it depends on three runtime behaviors that source
reading alone cannot confirm: a throw aborts the request, a missing plugin leaves no usable model, and
a thrown overflow object turns into OpenCode's own compaction. Milestone M0 spikes A, B and C were
written to decide this against the real `opencode-ai@1.18.31` binary, with sandboxed homes and
loopback mocks only.

## Decision

**The in-process plugin is the enforcement point. The loopback gate is not built for v0.1**, so build
step S20 is dropped from the v0.1 plan. The gate stays specified in 8.10 as the pre-planned answer if
a future OpenCode version breaks one of the behaviors below.

## M0 spike results

| Spike | Question | Outcome | Evidence |
|---|---|---|---|
| A | Throw in `system.transform` / `chat.params` aborts with 0 requests; retry wording retries | pass (16/16) | `spikes/results/A.json` |
| B | `config`-hook provider injection resolves the model; missing/broken plugin and `OPENCODE_PURE` give 0 requests | pass (32/32) | `B.json` |
| C | Thrown `context_length_exceeded` object triggers compaction without sending the request | pass (11/11) | `C.json` |
| D | XDG isolation canaries stay out; `shell.env` restores `XDG_CONFIG_HOME` | pass (10/10) | `D.json` (ADR 0002) |
| E | TUI and `run` work with `build`/`plan`/`title` disabled; no extra requests | pass (7/7), TUI manual | `E.json` |
| F | Bash allow-list patterns under the Windows shell | pass (17/17) | `F.json` (ADR 0003) |
| G | `OPENCODE_DISABLE_MODELS_FETCH` keeps the injected provider working | pass (6/6) | `G.json` (ADR 0002) |
| H | Offline start with a failing background npm install | pass (7/7) | `H.json` (ADR 0002) |
| I | PowerShell stdin probe on Windows PowerShell 5.1 and 7 | pass (13/13) | `I.json` |
| J | MCP argument policy in `tool.execute.before`; resource `read` pattern | pass (13/13) | `J.json` (ADR 0003) |
| K | `debug agent` / `debug config` introspection; schema-key extraction | pass (8/8) | `K.json` (ADR 0002, 0003) |
| L | Instance id formula on Windows | manual-pending, fallback chosen | `L.json` (ADR 0003) |
| M | Hub endpoint path without a configurator entry | partial, fallback chosen | `M.json` (ADR 0003) |

## What the spikes established

**Guard throws (A).**
- A thrown `Error` in `experimental.chat.system.transform` or in `chat.params` aborts the step with
  **0 requests** to the model endpoint, because `prepare()` runs before `streamText`.
- The message is stored on the assistant message and is readable in `opencode run --format json` and
  over the server session path that the TUI uses.
- A message containing "temporarily at capacity" is retried: the observed backoff was about 2.3 s,
  4.9 s, 9.8 s, 18.7 s and 30 s, and the guard re-ran on each attempt (1 attempt plus 5 retries = 6
  evaluations). After the last retry the error is stored, still with 0 requests sent.
- An async probe (an HTTP call to a loopback Ollama) inside the hook works.

**Fail closed (B).**
- The `config` hook injects provider `opencode-unity` and pins `enabled_providers`; the request then
  carries the preset model tag.
- Missing plugin file, a syntax error in a lib module, a throwing `config` hook, `OPENCODE_PURE=1` and
  `--pure` all end with **0 requests** and a non-zero exit.
- `opencode debug agent <name>` exits **0 even when the provider is missing**, so it is not a
  fail-closed signal. `opencode models <provider>` exits 1 with "Provider not found", and
  `debug config` shows no `provider` block; those are the signals the V-a check uses.
- The user-visible run error is only "Unexpected server error. Check server logs for details."; the
  real reason ("Model not found: `<provider>/<tag>`") appears in the log stream. `start` must verify
  before launching rather than rely on that message.

**Budget (C).**
- Throwing `{ type: "error", error: { code: "context_length_exceeded" } }` from `chat.params` is
  parsed as `ContextOverflowError`: the request is not sent, it is never retried, and OpenCode starts
  its own compaction. The observed order of `chat.params` calls was `unity-code` (threw),
  `compaction`, `unity-code`, and only the last two produced requests.
- The compaction request runs through the same prepare path, so the plugin exempts it and throws a
  stop `Error` there instead; that halts the session with a readable message and 0 requests.
- The loop breaker (a second overflow after a compaction) halts with its own message.
- OpenCode publishes the overflow as a session error even when it recovers, so `opencode run` exits 1
  although the answer after compaction is produced. Bench, delegate and contract tests must judge the
  final assistant text, not the exit code alone.

## Consequences

- S20 (loopback gate) is removed from the v0.1 build plan. Spec 8.10 stays as the documented fallback.
- Guard messages keep the wording rules of spec 7.6: stop messages must not match OpenCode's retry
  patterns, retry messages must contain "temporarily at capacity". A5 and A3 depend on it.
- The plugin owns provider injection, so the rendered profile must keep **no** `provider` block.
- Contract tests C5, C6, C7 and C8 keep these behaviors true, and the weekly drift job runs them
  against `opencode-ai@latest`. If any of them fails on a future version, this ADR is superseded by
  building the gate (spec 8.10, step S20).
- `start`, `doctor` and the contract tests use `opencode models <provider>` (not `debug agent`) as the
  plugin-loaded signal, and `--print-logs` when they need the underlying reason.
- Risk R2 is closed for 1.18.31 and stays open as a version-drift risk.
