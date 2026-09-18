# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `0.1.0-preview.2` (the latest preview) | Yes |
| Anything older | No |

Fixes land on the latest preview. Please check that a problem still happens there before you report it.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include the version (`opencode-unity --version`), your operating system, the command you ran, what you
expected and what happened. `opencode-unity doctor --markdown` prints a redacted report you can attach;
read it before you send it, and remove anything private it still contains.

The maintainers aim to answer within 14 days, coordinate a fix and a release with you, and publish the
advisory once the fix is available, or 90 days after your report, whichever comes first.

## In scope

- **GPU guard bypass**: a path in opencode-unity that makes Ollama load a model without the guard
  deciding first, or a guard pass on a probe error.
- **Permission bypass**: the `unity-code` or editor agent editing a protected Unity file (scenes,
  prefabs, `.asset`, `.meta`, project settings, packages, `.csproj`), running a version-control write,
  or running a shell command the shell guard should deny.
- **Delegate lane**: path traversal or symlink escapes in `delegate edit` or `apply`, applying anything
  other than the reviewed blocks, running a check command outside the allowed prefixes, or reading a
  sensitive file without `--allow-sensitive`.
- **Credential exposure**: cloud keys or secrets reaching the OpenCode child environment, a prompt, a
  log, a `doctor` report or an install manifest.
- **Installer**: `setup` or `uninstall` writing or deleting outside what the install manifest records,
  or editing a file the product did not create.
- **Host files**: anything under `hosts/` that tells a host agent to follow model output, or to bypass its
  own permission system.

## Out of scope

- The behaviour of OpenCode, Ollama, MCP for Unity, Unity, Claude Code, Codex or Antigravity themselves.
  Report those to their projects.
- The quality or correctness of model output. The model is untrusted by design, and every result is
  meant to be reviewed.
- Attacks that need administrator rights on the machine, or write access to opencode-unity's own home
  directory.

## What the design does and does not promise

opencode-unity is not a sandbox. Its boundaries are OpenCode's permission rules, the plugin's shell
guard and the delegate validator; each stops the actions it names and nothing else. The GPU guard lowers
the risk of a GPU driver reset during a model load; it is not a guarantee. A compile check runs
`dotnet build`, which executes the project's own MSBuild logic, so use it only on projects you trust.
