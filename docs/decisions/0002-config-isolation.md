# 0002 - Clean-room configuration isolation

- Status: accepted
- Date: 2026-09-17
- Deciders: maintainers
- Spec: sections 1.2 (D2, D10, D20), 8.1, 8.2, 8.4, 24.3 (M0 spikes D, G, H, K)
- Evidence: `spikes/results/D.json`, `G.json`, `H.json`, `K.json`

## Context

A launch must not inherit the user's own OpenCode setup: their global `opencode.json`, its agents,
commands, instructions, plugins and MCP servers, their `~/.claude/CLAUDE.md` or their external skills.
`OPENCODE_CONFIG_DIR` alone does not isolate, because the global config directory is read from the
static `Global.Path.config`, which comes from `XDG_CONFIG_HOME`. The launch therefore points
`XDG_CONFIG_HOME` at a profile-owned empty directory, sets `OPENCODE_CONFIG_DIR` to the rendered
profile, and passes the per-launch block through `OPENCODE_CONFIG_CONTENT`. Spikes D, G, H and K
tested that this holds, what it costs and what it breaks.

## Decision

Keep the clean-room launch environment of spec 8.1 with the isolated `XDG_CONFIG_HOME`, and add two
requirements the spikes uncovered:

1. the launch environment sets **`npm_config_fetch_retries=0`**;
2. every dump of `opencode debug config` is **redacted**, because it contains a `username` field.

## What the spikes established

**Canaries stay out (D).** With canary files planted in the sandbox home - global `opencode.json`
(instructions, an agent, an MCP server, a plugin), `AGENTS.md`, a file agent, a command,
`~/.claude/CLAUDE.md` and `~/.agents/skills/canary/SKILL.md` - an isolated launch showed:

- no canary string in the request;
- the canary plugin never loaded and the canary MCP server was never contacted;
- no canary agent, command, MCP server or plugin origin in `debug config`;
- exactly **one system message**, carrying the facts file that `OPENCODE_CONFIG_CONTENT` delivered
  through `instructions`;
- the control run without isolation showed the same canaries live, so the test is not vacuous.

**Shell environment (D).** The `shell.env` hook fires for agent shell commands, and the command saw the
original `XDG_CONFIG_HOME` (not the isolated one) plus `DOTNET_CLI_TELEMETRY_OPTOUT=1` and
`DOTNET_NOLOGO=1`. This is the only way a shell command gets the user's real environment back.

**Models catalogue (G).** With `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_MODELS_URL` pointed at a
loopback recorder, no request reached the catalogue, no models cache file was written, the injected
model kept its tool-call capability, and `opencode models <provider>` still listed it. The recorder was
proved live by a direct request before the run.

**Offline start (H).** OpenCode background-installs `@opencode-ai/plugin` into every config directory it
loads, including the profile and the isolated XDG directory, and writes a `.gitignore` there. Offline:

- the install fails with a WARN line "background dependency install failed" and nothing else changes;
- with `npm_config_fetch_retries=0` the first request arrived after about 13 s;
- **without it, the first request arrived after about 109 s** - the failing retries delay the session
  start, so an offline first prompt looks hung;
- pre-seeding the directory (a `node_modules` tree plus a `package.json` and `package-lock.json` that
  agree) skips the install entirely; the first request arrived after about 17 s.

**Effective verification (K).** `debug agent <name>` returns the agent with its flattened `permission`
ruleset in evaluation order and a `tools` map of built-in tools; `debug config` returns the merged
configuration with `model`, `enabled_providers`, `share`, `autoupdate`, `plugin_origins` (each plugin
spec plus its source directory) - and `username`. Both finished in a few seconds, far inside the 60 s
budget. `opencode generate` prints the OpenAPI document on stdout; `components.schemas.Config`,
`AgentConfig` and the inline `Config.command` value schema are the source for the schema key allow-list.

## Consequences

- Spec 8.1 gains `npm_config_fetch_retries=0`. `doctor` explains the offline warning, and `setup` may
  offer the pre-seed as an opt-in for quiet logs; it is not required.
- `scripts/gen-schema-keys.mjs` (S09) generates `schema-keys-1.18.31.json` from `opencode generate`
  instead of hand-extracting from the OpenCode source tree.
- V-a uses `opencode models <provider>`; V-b and V-c use `debug agent`; V-d uses `debug config`
  (see ADR 0001 and 0003).
- Any product output that includes `debug config` (doctor reports, capture bundles, spike evidence)
  must run through redaction; the spike harness already refuses to write evidence containing the OS
  user name.
- `XDG_DATA_HOME` stays un-isolated (open decision 6); nothing in the spikes required isolating it.
