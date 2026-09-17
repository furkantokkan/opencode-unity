# M0 spikes

Throwaway harness for the milestone 0 spikes (spec section 24.3). It answers the runtime questions the
design could not settle from source alone, using the real `opencode-ai@1.18.31` binary. The results are
recorded in `results/` and the decisions in `docs/decisions/`.

This directory is **not published**: it is outside the `files` allow-list in `package.json` and outside
the `include` list in `jsconfig.json`.

## Running

```sh
node spikes/run-all.mjs        # every spike, A to M
node spikes/run-all.mjs A C K  # selected spikes
node --test "spikes/test/*.test.mjs"   # tests for the harness itself
```

Each run writes `results/<id>.json` (checks, findings, decision, evidence) and updates
`results/summary.json`. Every string is redacted before it is written: home, temp and repository paths,
the OS user name and the machine name become `<home>`, `<tmp>`, `<repo>`, `<user>` and `<host>`, and a
write that still contains the user name fails.

`OPENCODE_UNITY_SPIKE_OPENCODE` overrides the binary that is used; otherwise the global npm install of
`opencode-ai` is found first, then `PATH`.

## Safety rules the harness enforces

- Every OpenCode run gets a sandboxed `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` and all `XDG_*`
  directories under the OS temp directory (`test/helpers/sandbox.mjs`), plus
  `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_MODELS_FETCH`.
- No model is ever loaded. The provider `baseURL` always points at the loopback mock in
  `lib/mock-llm.mjs`; `lib/workspace.mjs` starts a mock Ollama for the probe path; `lib/mock-mcp-hub.mjs`
  stands in for the MCP for Unity hub. An environment variable pointing at `:11434` or `:8081` is
  refused before a process starts.
- Anything that is not loopback is pointed at the closed port `127.0.0.1:9` (npm registry, proxies,
  the models catalogue URL).
- Sandboxes are removed after each spike unless `OPENCODE_UNITY_TEST_KEEP_SANDBOX=1` is set.

## Layout

| Path | Contents |
|---|---|
| `run-all.mjs` | Runner: picks the spikes, checks the OpenCode version, writes the evidence |
| `lib/spike.mjs` | Spike context: checks, tracked resources, run summaries |
| `lib/evidence.mjs` | Check list, redaction, evidence writer |
| `lib/opencode.mjs` | Locates and runs the binary, with a tree kill and one retry on a startup hang |
| `lib/serve.mjs` | `opencode serve` on a free loopback port, for the session path the TUI uses |
| `lib/workspace.mjs` | Sandboxed home, fictional Unity project, rendered profile, clean-room environment |
| `lib/mock-llm.mjs` | OpenAI-compatible endpoint: records requests, replays text, tool calls or errors |
| `lib/mock-mcp-hub.mjs` | Streamable HTTP MCP server shaped like the MCP for Unity hub |
| `fixtures/spike-plugin/` | Instrumented plugin: same hooks as the product plugin, behavior from a JSON file |
| `fixtures/probe/` | PowerShell process probe used by spike I |
| `test/` | Tests for the harness (no OpenCode, mocks only) |
| `results/` | Redacted evidence per spike, plus `summary.json` |
