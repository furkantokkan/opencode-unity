# 0003 - Permission ordering, the bash allow-list and MCP argument policy

- Status: accepted
- Date: 2026-09-17
- Deciders: maintainers
- Spec: sections 1.2 (D4, D5, D22), 8.5, 8.6, 11.3, 24.3 (M0 spikes E, F, J, K, L, M)
- Evidence: `spikes/results/F.json`, `J.json`, `K.json`, `E.json`, `L.json`, `M.json`

## Context

Safety rules are only worth as much as their evaluation order. OpenCode evaluates permissions with
`findLast` over defaults, then config-level rules, then agent-level rules, and `mergeDeep` keeps the
position of a key that already exists, so a project file can land before ours. The spec therefore
renders the rules at both levels and passes the ordered agent block per launch through
`OPENCODE_CONFIG_CONTENT`. Bash is an allow-list, dangerous actions are denied, and the editor agent's
MCP tools carry an argument policy enforced in the plugin. Spikes F, J and K tested that, on Windows,
against the real binary.

## Decision

Keep the spec 8.5 model:

- config-level rules for every agent, agent-level rules per launch, no reliance on `OPENCODE_PERMISSION`;
- bash in **allow-list** mode by default (`"*": "deny"` plus the rendered compile and read-only VCS
  patterns);
- the MCP argument policy enforced in the plugin's `tool.execute.before` hook;
- `build`, `plan` and `title` disabled.

No wrapper script (`ocu-compile.cmd`) is needed, and the argument policy does not have to fall back to
prompt rules.

## What the spikes established

**Windows shell and patterns (F).** With `SHELL` unset in the clean room, the shell tool used
`pwsh.EXE` (the first acceptable of pwsh, powershell, git bash, cmd) and its tool id is `bash`.
OpenCode asks for permission with **one pattern per parsed command node**, the pattern being the whole
command text of that node. Measured verdicts, with the spec 8.5.2 rules rendered for a git project:

| Command | Verdict |
|---|---|
| `dotnet build Assembly-CSharp.csproj -nologo -tl:off -v q "-clp:ErrorsOnly;NoSummary"` | allow |
| `dotnet --version`, `git status --short` | allow |
| `git push origin main`, `git commit -m "wip"`, `cm checkin -c "wip"` | deny |
| `dotnet build X.csproj && git push origin main`, same with `;` | deny (the `git` node is evaluated on its own) |
| `cmd /c git push origin main`, `powershell -Command git push origin main` | deny |
| `Remove-Item -Recurse -Force Assets`, `rm -rf Assets` | deny |
| `echo broken > Assets/UI/Menu.prefab` | deny |
| `dotnet build Other.csproj` (not in the compile map) | deny |

The quoted `-clp:ErrorsOnly;NoSummary` argument stays inside one pattern and reaches the process
command line unchanged, so `dotnet build <csproj> *` covers the facts compile command. Only the two
allowed `dotnet` commands actually ran (a fake executable recorded them); the fake `cm` was never
called. A denied call returns the tool error "The user has specified a rule which prevents you from
using this specific tool call" and the session keeps running.

**Ordering under a hostile project (K).** With a project `opencode.json` that sets
`bash: { "*": "allow", "git push *": "allow" }`, that rule is visible in the merged config-level rules,
but the per-launch agent rules are evaluated after it: the flattened ruleset ends with our denies and
`git push origin main` was still denied at runtime. `debug agent <name>` exposes exactly that ruleset,
in evaluation order, so the ported evaluator (V-b) can be checked against real output.

**MCP argument policy (J).** For MCP tools, `tool.execute.before` receives the same arguments object
that is forwarded to the hub, and it runs before the permission ask:

- deleting `unity_instance` there removed it from the JSON-RPC call the mock hub received;
- throwing there (a `read_console` with `action: "clear"`, a `run_tests` in `PlayMode`) failed the tool
  call with our message and never reached the hub;
- the visible MCP tools were exactly the allow-list, and the code agent's `"*_*": "deny"` hid every MCP
  tool and kept the hub instructions out of its system prompt;
- MCP resources are reached through `list_mcp_resources`, `list_mcp_resource_templates` and
  `read_mcp_resource`, which all map to the `read` permission; `read_mcp_resource` asks with pattern
  `mcp:<server>:<uri>` (always `mcp:<server>:*`), exactly the rule format spec 8.5.2 renders;
- a hidden tool the model still calls comes back as "Model tried to call unavailable tool" with the
  list of available tools.

**Built-in agents (E).** With `build`, `plan` and `title` disabled, `opencode run` works with and
without `--agent`, the default agent answers, and the only request per step comes from `unity-code`.
With the title agent enabled the same prompt produced a second request from agent `title`, so the
title agent is the only source of that extra request. `debug agent build` exits non-zero once disabled.

## Open manual items

- **TUI startup (E).** The TUI needs a real console, so its startup and error rendering with the
  built-ins disabled stay a manual M0 check and part of gate G10. The server session path, which the
  TUI drives, is covered automatically.
- **Instance id (L).** The formula is `<name>@<first 16 hex of SHA-1 over the UTF-8 bytes of
  Application.dataPath>`, name = the folder above `Assets`. Slash direction, drive-letter case and a
  trailing separator each change the hash, and batch mode hashes `<cwd>/Assets` instead, so v0.1 takes
  the spec fallback: the editor agent matches on the instance **name** from `mcpforunity://instances`
  and stops unless exactly one instance matches, with a warning. A computed id is only a hint.
- **Hub endpoint (M).** MCP for Unity stores an HTTP base URL (default `http://127.0.0.1:8080`) and
  appends `/mcp`. OpenCode 1.18.31 talks to such a URL over the streamable HTTP transport; pointing it
  at the base without `/mcp` leaves the session with no MCP tools and no error of its own, which is the
  failure mode `doctor` must name. The port lives only in the Editor's preferences, so when no
  configurator entry exists the user pastes the URL from the MCP for Unity window.

## Consequences

- The rendered rule sets of spec 8.5.2 stay as specified; the compile command keeps its quoted `-clp`
  argument and needs no `ocu-compile.cmd` wrapper.
- The shell guard in the plugin (8.7.1) stays defense in depth, not the primary control: the permission
  layer already denied every wrapper and chain tried here.
- Contract tests C3, C9, C11 and C13 lock these behaviors; C3 can use
  `--print-logs --log-level INFO`, where each decision is logged as
  `message=evaluated permission=bash pattern=<command> action.pattern=<rule> action.action=<allow|deny>`.
- The editor agent stays experimental until the two manual items are confirmed on a machine with Unity
  and MCP for Unity.
