# Notice

opencode-unity is an unofficial, independent project. It is not affiliated with, endorsed by or
sponsored by OpenCode, Ollama, Unity Technologies, Anthropic, OpenAI, Google or Alibaba Cloud (Qwen).
All product names and trademarks belong to their owners and are used here only to say what this
project works with. The project ships no third-party logos.

## Third-party projects referenced

opencode-unity starts and configures these projects; it does not include their code.

- **OpenCode** (MIT) - the coding agent that `opencode-unity start` launches. Behaviour described in
  this repository cites OpenCode source files at the tested version in `compat.json`.
- **Ollama** (MIT) - the local model server. Behaviour described here cites Ollama source files and
  documentation at the tested version in `compat.json`.
- **MCP for Unity** (MIT) - the optional Unity Editor bridge the experimental editor-check agent talks
  to. A recorded `tools/list` answer is kept as a test fixture of names and schemas.
- **Qwen3-Coder** - the default model. Its sampling values come from the published model card and
  generation configuration.
- **Unity** - project facts (packages, assembly definitions, `.csproj` files, folders) are read from
  Unity projects on disk. No Unity reference source or Unity Companion License material is included.

## Development dependencies

`typescript`, `@types/node` and `@opencode-ai/plugin` are used only to type-check and test this
repository. They are not part of the installed package, which has no runtime dependencies.

## Ideas credited

Some design ideas were inspired by other open-source agent projects, among them an explorer subagent and
a context audit from a GPL-3.0 Unity agent project, and prompt discipline from Apache-2.0 coding agents.
Only ideas were taken. Every prompt, skill, template and line of code in this repository is original
text written for it, and no text or code was copied.
