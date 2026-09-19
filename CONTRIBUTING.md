# Contributing

Thanks for helping. You do not need a GPU, a model, Ollama or Unity to work on opencode-unity: every
test runs against mocks on loopback.

## Set up and test

You need Node.js 22 or newer and Git.

```bash
npm ci
npm test
npm run typecheck
npm run lint
```

- `npm test` runs the unit, plugin, doctor, install, delegate, bench and lint suites with `node:test`.
- `npm run typecheck` checks the JSDoc types of `bin/`, `src/`, `plugin/` and `scripts/`.
- `npm run lint` runs the three hygiene scripts: no personal data, claims rules for the README and docs,
  and the package file list.
- `npm run docs` regenerates `docs/cli-reference.md`, `docs/configuration.md` and
  `docs/doctor-checks.md`. Commit the result whenever you change the CLI registry, the config schema or a
  doctor check; CI fails when they differ.
- The package round trip (`test/install/package-roundtrip.test.mjs`) packs and installs the package, so
  it runs only when `OPENCODE_UNITY_TEST_PACKAGE_ROUNDTRIP=1` is set, as in the CI package job.
- `npm run test:contract` runs the shipped profile and plugin inside the real OpenCode binary, against
  a mock Ollama server. Set `OPENCODE_UNITY_TEST_OPENCODE` to the executable path first; an unset path
  fails explicitly. `OPENCODE_UNITY_TEST_ARTIFACTS` optionally saves the probe output for inspection.
  This verifies startup and refusal paths; it does not measure real-model quality or GPU behavior.

## Conventions

- ESM JavaScript with JSDoc types, and zero runtime dependencies. Development dependencies are pinned to
  exact versions and never shipped.
- Tests use `node:test` and the mocks in `src/selftest` and `test/helpers`. A test never loads a model,
  never contacts a real Ollama server or Unity MCP hub, and never writes outside a sandbox from
  `test/helpers/sandbox.mjs`. Sandboxes are removed after each test.
- Tests pass on Windows, Linux and macOS. Build paths with `path`, and never hard-code a separator or a
  drive letter.
- Write control characters as escape sequences such as `\x1b`, never as raw bytes.
- Everything in the repository is English.
- Protected actions are `deny`, never `ask`. Any new code path that can make Ollama load a model goes
  through `guardedChat()` or the plugin guard.
- A statement about how OpenCode, Ollama, MCP for Unity or Unity behaves cites a tagged source file and
  line, or an official documentation page.
- Prompts, skills and templates are original text. Do not copy text or code from GPL projects or from
  Unity Companion License material; credit an idea in `NOTICE.md` instead.

## Release verification

Before tagging, run the checks above, `npm run check:release`, the real OpenCode contract suite and the
package round trip. Keep the package version, lockfile, README install commands, host files, security
support table and changelog in sync. Do not relabel experimental hardware or model results without
new evidence.

A version tag runs CI, validates the release metadata, then builds one tarball and `SHA256SUMS`.
Preview tags publish those files as a GitHub prerelease without contacting npm. Stable tags first
publish the same tarball to npm using trusted publishing; a failed npm publish blocks the GitHub
release. Downloaded artifacts are checked against their checksum before either publication.

## No personal data

This project is generic. No real name, user name, e-mail address, machine name, local path, game or
studio name may appear anywhere in the repository, including tests, fixtures and commit contents. Use
placeholders such as `<home>`, `<user>` or `MyGame`.

`scripts/check-no-personal-data.mjs` enforces this in CI. To check your own values locally, copy
`scripts/personal-data-denylist.example` to `.personal-data-denylist` in the repository root (it is
git-ignored and must never be committed), put your own names and paths in it, and run `npm run lint`.
You can also keep the file elsewhere and pass it with
`node scripts/check-no-personal-data.mjs --denylist <file>`.

## Pull requests

- Keep a change small and focused, with tests for the new behaviour and its failure paths.
- Add a line to `CHANGELOG.md` under the next version.
- Say how you verified the change. Hardware reports (GPU, VRAM, driver, OS, versions,
  `opencode-unity doctor --json --redact`) are welcome in issues.
- Report security problems privately, as `SECURITY.md` describes.
