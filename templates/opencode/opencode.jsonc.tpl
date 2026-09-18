// Rendered by opencode-unity {{version}} into <home>/profile/<cliVersion>/opencode.jsonc.
// Edits are lost: `opencode-unity upgrade` rewrites this file. Change config.json instead.
// There is no "provider" block on purpose; the plugin injects it, so a broken plugin fails closed.
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "lsp": false,
  "enabled_providers": ["opencode-unity"],
  "model": "opencode-unity/{{modelTag}}",
  "small_model": "opencode-unity/{{modelTag}}",
  "default_agent": "unity-code",
  "compaction": { "auto": true, "prune": true },
  "tool_output": { "max_lines": {{toolOutputMaxLines}}, "max_bytes": {{toolOutputMaxBytes}} },
  "agent": {
    "build": { "disable": true },
    "plan": { "disable": true },
    "title": { "disable": true }
  },
  "permission": {{configLevelPermission}}
}
