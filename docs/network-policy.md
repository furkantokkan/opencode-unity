# Network policy in preview.6

`start` builds a per-session policy from config-v2 and verifies OpenCode's effective permissions before launching. The static installed profile denies `unitynet`; a validated launch enables the allowed entries. The child receives the policy through a cleaned environment, so concurrent projects do not overwrite shared policy files.

The standard profile permits bounded GET/HEAD requests to Unity documentation, Microsoft .NET/NuGet documentation, the npm and NuGet registries, Firebase documentation, and development loopback endpoints. Ollama, the active Editor hub, the current OpenCode server and configured reserved ports are protected. Loopback support does not permit arbitrary private-network hosts. Limits cover response size, output length, URL/body size, timeout, rate and session request counts.

Set `network.enabled` to `false` or `network.profile` to `none` to disable the tool. `custom` removes the shipped entries and uses your configured allow-list. Custom entries ask for permission on every request. A public read entry needs a `consentId` label, but that label never proves approval or bypasses the ask. Public writes are refused. Custom loopback writes require a narrowly configured entry and a request approval.

Project network settings can only narrow the global policy. They cannot introduce hosts, widen paths/methods, increase budgets or replace transport headers and CA settings. The policy hash includes headers, and fetched content is always untrusted data. The tool checks redirects and resolved addresses; a tool refusal must not be bypassed with a shell command.

Shell networking defaults to `network.bash: "deny"`. `ask` routes recognized networking commands through OpenCode's permission prompt and startup checks the effective shell rules. Neither setting is an operating-system sandbox: a program run with user approval can have its own network behavior. The model-facing fetch tool is separate from delegation: `delegate ask/map/edit` has no tools or network access.

Verification includes policy/rendering tests, request limits, cancellation, redirects, private addresses, encoded/quoted shell commands and actual OpenCode permission-override rejection. The opt-in `test/unit/selftest/network-contract.mjs` uses real OpenCode with mock model/HTTP endpoints to verify that the tool is hidden when disabled and performs exactly one allowed loopback request when enabled. These protocol checks do not establish native-model tool reliability.
