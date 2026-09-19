# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.y.z`, a minor release
may change the CLI or the config schema, with automatic migrations and a Breaking section.

## [0.1.0-preview.7] - 2026-09-19

The preview.6 tag was not published: CI found platform-dependent test defaults, a missing isolated OpenCode fixture and unreferenced mock timeout handles. Preview.7 fixes those test harness assumptions and includes the integrations below. Runtime protections and platform restrictions remain unchanged.

### Added

- Managed `host install/verify/update/uninstall` for Claude and Codex, wired into `setup --host`, preserving user-edited files and tracking owned copies.
- Schema-v2 configuration migration preserving delegation and guard preferences; bounded Unity/service workspace facts and read-only service launch inspection.
- Standalone `shape` with one guarded rewrite or `--no-model`; platform facts via `--print-platform`; generated installation commands for four shells.
- `unitynet` with bounded documentation and loopback reads, request permissions, reserved-port protection, pinned network policy and startup permission verification.
- Real OpenCode `doctor --capture/--selftest`, mock protocol benchmarks and guarded `bench edits`. Unsupported live benchmark suites explicitly refuse.

### Fixed

- Shell network classification handles quoted URLs and encoded commands conservatively; network permission overrides cannot silently widen access.
- Context accounting excludes duplicated tool UI metadata and tool definitions absent from compaction requests.
- Delegation reports measured local tokens separately from estimated source-input reduction, subtracts the returned summary and gives failed or partial jobs no estimated savings credit.

### Limits

- Windows remains the model-execution platform. Linux/macOS hardware probes, broad native-tool reliability evidence and stable npm publication remain future release gates.
- See [completion status](docs/completion-plan.md), [diagnostics](docs/diagnostics.md) and [network policy](docs/network-policy.md) for validation and scope.

## [0.1.0-preview.5] - 2026-09-19

### Added

- Persistent user controls: `delegate on`, `off` and `status`. Turning delegation off refuses new
  jobs before any model call, while history and backup restoration remain available.
- `delegate monitor` shows running job metadata and recent results. Opt into a shared visible
  Windows CMD window with `delegate monitor --auto on`; use `--auto off` to disable automatic
  windows, or `--window` to open one manually. Monitoring never calls the model.
- Host skill guidance and a copyable standing rule for automatic eligible labor handoff when the
  CLI is installed, with explicit OFF/refusal handling and job-id reporting.

### Fixed

- The config schema now accepts `delegate.enabled`; the earlier refusal check was unreachable
  through a valid config. Disabled delegation can still be inspected and re-enabled by its user.

## [0.1.0-preview.4] - 2026-09-19

The preview.3 tag was not published: its Windows CI run exposed the log-rotation issue fixed here.

### Fixed

- Ollama log rotation preserves native file identifiers as big integers. Large Windows file IDs
  could round to the same JavaScript number, causing the follower to skip old lines and start partway
  through the replacement file. A deterministic regression test reproduces the collision.
- Startup now requires the guard plugin and its local provider/model in OpenCode's resolved config.
  A successful agent probe alone could previously accept a missing plugin. Plugin origins now use
  OpenCode's actual record format, and foreign plugins are refused before the interactive session.
- The CI contract job now runs real OpenCode tests instead of an empty test glob. The weekly drift
  check uses that suite instead of a missing fixture-generation script.
- Preview tags now automatically publish a GitHub prerelease after CI and release checks pass.
  Previously, skipping npm also skipped the GitHub release job, leaving previews without packages.
- Package once, attach the installable tarball and `SHA256SUMS`, and verify the downloaded artifact
  before release. Stable releases reuse the same bytes for npm provenance publishing.

### Changed

- Updated the installation instructions and host skills to this version, with an explicit upgrade
  path for existing profiles and instructions for installing the GitHub release asset.
- Added release workflow regression checks for preview publication, failed stable npm publishing,
  single-build packaging and checksum verification.
- Added real OpenCode contract checks for a valid profile, disabled sharing, a missing guard plugin
  and a foreign project plugin, plus unit cases for provider and plugin path validation.

This remains a Windows reference preview. Linux/macOS model-load support, the larger hardware
benchmark series and the other features in the README roadmap are still pending. The native tool-call
limitation documented in `docs/evidence/v0.1/reference-rtx3090-16k.md` still applies. No npm package is
published for this preview.

Install:

```sh
npm install -g "github:furkantokkan/opencode-unity#v0.1.0-preview.4"
```

For an existing installation, run `opencode-unity upgrade`, then `opencode-unity doctor`.
For a first installation, follow the setup steps in the README.

## [0.1.0-preview.2] - 2026-09-18

### Added

- `guard.allowOffload` (default `false`). When it is on, the guard lets a model load that does not fit
  in video memory alone: the rest runs from system RAM and replies are slower. The free-memory minimum
  (`guard.minFreeVramAfterLoadMiB`) still applies, and `doctor` reports the offload share instead of an
  error.

## [0.1.0-preview.1] - 2026-09-18

The first preview. It is installed from GitHub and is not published to npm. It is meant for Unity
developers on Windows with a 24 GB NVIDIA GPU who want to try a guarded local-model OpenCode session and
the delegate commands before the v0.1 release gate. A first small measurement of the 16K reference
preset (tool calls and edits on the reference machine) is in `docs/evidence/v0.1/`; the full
release-gate series is not in this preview.

### Added

- `opencode-unity` CLI with zero runtime dependencies and one JSON envelope for every command:
  `doctor`, `setup`, `init`, `start`, `status`, `guard`, `warm`, `stop`, `delegate`, `upgrade` and
  `uninstall`.
- `doctor`: read-only checks of an OpenCode and Ollama setup that never load a model, with `--profile`,
  `--deep`, `--markdown`, `--redact`, `--strict` and `--explain`.
- `setup`: one consent per persistent change, a dry run, an install manifest and a transactional apply
  for the OpenCode install, the model download and tag, the clean-room profile, the Ollama server
  environment and the Windows Terminal fragment.
- `init`: a read-only scan of a Unity project that writes its facts (packages, assemblies, compile map,
  input and UI stack, version control) outside the project.
- `start`: a clean-room OpenCode session with the `unity-code` agent and the `/compile` command,
  effective-config verification before every launch, and refusal of auto-approval flags.
  `start --print-env` prints the launch environment and content and writes nothing.
- The OpenCode plugin: the GPU guard before every model request, sampling and output limits, a budget
  preflight, a read clamp, the shell guard, truncation and text-call detection, and a metadata-only
  session log.
- The GPU guard: free video memory, GPU utilization and Unity asset-import checks before a model load,
  failing closed on any probe error, with a GPU lock shared by `warm` and `delegate`.
- `delegate health|ask|map|edit|apply|restore|ledger`: guarded local-model labor for Claude Code, Codex
  and Antigravity, with reviewed dry-run edits and `data.orchestratorAction` on every refusal.
- An experimental editor-check agent for projects with MCP for Unity, enabled per project with
  `init --editor`.
- Preview host files under `hosts/`: a Claude Code skill, a Codex skill and an Antigravity rule with one
  shared body, copied by hand.
- Generated reference pages: `docs/cli-reference.md`, `docs/configuration.md` and
  `docs/doctor-checks.md`.
- The package round trip test: pack, install, `setup`, `init`, `start --print-env`, `doctor`,
  `uninstall`, and a residue check, all sandboxed against mocks.
- First preset evidence: the 16K reference preset measured on the reference machine (tool calls 3 of 10
  native, 7 of 10 written as text the plugin detects; edits 6 of 6), in
  `docs/evidence/v0.1/reference-rtx3090-16k.md`. The 16K preset is now `verified` with that evidence; the
  32K preset stays `experimental`.

### Compat

- OpenCode 1.18.31, exactly.
- Ollama 0.34.1, and 0.34.1 as the minimum.
- MCP for Unity 10.1.0.
- Node.js 22 or newer.
- Unity 6000.3 is the reference; 2021.3 and 2022.3 are experimental.

### Not in this preview

- The `host` command group (install, verify, update and uninstall of host files), the generated install
  matrix and the `--print-platform` flag.
- The `unitynet` network tool and prompt shaping.
- Guard probes for Linux and macOS. Those platforms run `doctor` and `init`; on them the guard blocks
  every model load, because it cannot see Unity.
- `bench`, `doctor --capture` and `doctor --selftest`.
- The release-gate measurements and their evidence.

### Known gaps

- The guard lowers the risk of a GPU driver reset during a model load; it is not a guarantee. An import
  can start after the check passed and before the load finishes, and Ollama clients outside
  opencode-unity are not guarded.
- opencode-unity is not a sandbox. The permission rules and the shell guard stop the actions they name;
  a compile check runs the project's own MSBuild logic.

[0.1.0-preview.4]: https://github.com/furkantokkan/opencode-unity/releases/tag/v0.1.0-preview.4
[0.1.0-preview.2]: https://github.com/furkantokkan/opencode-unity/releases/tag/v0.1.0-preview.2
[0.1.0-preview.1]: https://github.com/furkantokkan/opencode-unity/releases/tag/v0.1.0-preview.1
