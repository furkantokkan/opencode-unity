# Capture, self-test and bounded benchmarks

`doctor` remains read-only and never loads a model. The opt-in diagnostics below start the installed
OpenCode executable in temporary homes with the shipped profile and plugin. Requests go to loopback
mock endpoints, GPU admission uses a fake `nvidia-smi`, and temporary files are removed afterward.
They do not read a project's source or change the installed profile. OpenCode 1.18.31 is the measured
version; other versions require `--experimental` and reports label them unverified.

```powershell
opencode-unity doctor --capture --json
opencode-unity doctor --selftest --json
opencode-unity doctor --capture --selftest --json
```

Capture returns the redacted synthetic request, exact tool set, sampling values, tool JSON bytes and
a character-based tool-token estimate. That estimate is not tokenizer usage and does not rewrite
runtime budget allowances. Self-test covers request isolation, cold guard refusal, deleted/broken/
disabled plugin refusal, overflow compaction, the second-overflow stop and offline startup. A failure
returns exit 5 with each failing check; missing OpenCode returns 1 and an unverified version returns 8.
Each scenario is bounded at 180 seconds with one retry for a timeout. Ctrl+C terminates child trees.
Add `--dry-run` to describe a capture, self-test or benchmark without starting its processes.

The budget regression found while enabling the real launcher was caused by counting read output
again inside OpenCode's UI metadata, and by charging tool tokens to compaction. The estimate now
counts model-facing content once and recognizes tool-free compaction. OpenCode can exit 1 after a
recovered overflow, so recovery requires a later request and final answer; exit status alone is not
accepted as evidence. Every captured request, including compaction, must fit the scenario budget.

```powershell
opencode-unity bench guard --mock --runs 1 --json
opencode-unity bench budget --mock --runs 1 --json
opencode-unity bench all --mock --runs 1 --json
opencode-unity bench edits --runs 1 --temperature 0.2 --json
```

The mock suites run real OpenCode and explicitly report `modelReliabilityMeasured: false`. `all
--mock` combines the capture, guard, budget and offline protocol scenarios. The default is one run.
Live `edits` makes three guarded native `/api/chat` requests per run, compares exact replacements for
three tiny C# fixtures and never applies output to files. It reports actual input/output counts from
Ollama, the model, context, temperature and individual failures. The default is 20 runs; start with
one. Each request is bounded at 120 seconds and uses the shared GPU lock, guard and prompt preflight.
A guard refusal stops the benchmark without a model request. All replacements must match to pass.

Live `toolcalls`, `editor`, `guard`, `budget` and `all` do not yet have a verified runner and return
`prerequisite_missing` (exit 8). A successful text benchmark does not prove OpenCode tool execution,
general coding quality, another context size, another GPU or platform. Native model reliability
remains experimental; use the report's precise API and scope when sharing results.
