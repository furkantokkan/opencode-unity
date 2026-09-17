// Canary home (spec 20.3): files in a sandbox home that a clean-room OpenCode session must never read.
// Each file carries its own marker, so a leaked marker in a captured request names the source that
// loaded. The plugins only add their marker to the system prompt; they read, write and send nothing.
// The committed copy for contract tests is test/fixtures/opencode/canary-home/, and a unit test keeps
// it equal to this output.
import fs from 'node:fs/promises';
import path from 'node:path';

// Closed port: a canary MCP server that loads can reach nothing unless a test passes a mock URL. Its
// marker travels in a request header, so it shows up in mock hub logs rather than in model requests.
export const DEFAULT_CANARY_MCP_URL = 'http://127.0.0.1:9/ocu-canary-mcp';

export const CANARY_MARKERS = Object.freeze({
  claudeMd: 'OCU_CANARY_CLAUDE_MD_41C7',
  claudeSkill: 'OCU_CANARY_CLAUDE_SKILL_5B02',
  agentsSkill: 'OCU_CANARY_AGENTS_SKILL_6D19',
  globalAgentsMd: 'OCU_CANARY_GLOBAL_AGENTS_MD_7A3E',
  globalInstructions: 'OCU_CANARY_GLOBAL_INSTRUCTIONS_8F60',
  globalConfigAgent: 'OCU_CANARY_GLOBAL_CONFIG_AGENT_9E24',
  globalFileAgent: 'OCU_CANARY_GLOBAL_FILE_AGENT_A1D8',
  listedPlugin: 'OCU_CANARY_LISTED_PLUGIN_B3F5',
  discoveredPlugin: 'OCU_CANARY_DISCOVERED_PLUGIN_C84B',
  globalMcpServer: 'OCU_CANARY_GLOBAL_MCP_SERVER_D09A',
});

/** @returns {string[]} */
export function listCanaryMarkers() {
  return Object.values(CANARY_MARKERS);
}

/**
 * The canary files as relative paths (with `/`) and text.
 * @param {{ mcpUrl?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildCanaryHomeFiles({ mcpUrl = DEFAULT_CANARY_MCP_URL } = {}) {
  const m = CANARY_MARKERS;
  const globalConfig = {
    $schema: 'https://opencode.ai/config.json',
    instructions: ['~/.config/opencode/ocu-canary-instructions.md'],
    plugin: ['./ocu-canary/listed-plugin.js'],
    agent: {
      'ocu-canary-config-agent': {
        description: `Canary agent from the global config (${m.globalConfigAgent}).`,
        mode: 'subagent',
        prompt: `Canary prompt ${m.globalConfigAgent}.`,
      },
    },
    mcp: {
      'ocu-canary': { type: 'remote', url: mcpUrl, enabled: true, headers: { 'x-ocu-canary': m.globalMcpServer } },
    },
  };
  return {
    '.claude/CLAUDE.md': `# Canary\n\n${m.claudeMd}: personal Claude Code instructions must not reach an opencode-unity session.\n`,
    '.claude/skills/canary/SKILL.md': skill(m.claudeSkill),
    '.agents/skills/canary/SKILL.md': skill(m.agentsSkill),
    '.config/opencode/AGENTS.md': `# Canary\n\n${m.globalAgentsMd}: global OpenCode rules must not reach an opencode-unity session.\n`,
    '.config/opencode/ocu-canary-instructions.md': `${m.globalInstructions}: global instructions must not reach an opencode-unity session.\n`,
    '.config/opencode/opencode.json': `${JSON.stringify(globalConfig, null, 2)}\n`,
    '.config/opencode/agents/ocu-canary-file-agent.md': `---\ndescription: Canary agent from the global agents folder (${m.globalFileAgent}).\nmode: subagent\n---\n\nCanary prompt ${m.globalFileAgent}.\n`,
    '.config/opencode/ocu-canary/listed-plugin.js': plugin('ocu-canary-listed', m.listedPlugin),
    '.config/opencode/plugins/ocu-canary-discovered.js': plugin('ocu-canary-discovered', m.discoveredPlugin),
  };
}

/**
 * Writes the canary files under `homeDir`, creating folders as needed.
 * @param {string} homeDir
 * @param {{ mcpUrl?: string }} [options]
 * @returns {Promise<string[]>}  Absolute paths written.
 */
export async function writeCanaryHome(homeDir, options) {
  const written = [];
  for (const [relativePath, text] of Object.entries(buildCanaryHomeFiles(options))) {
    const target = path.join(homeDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
    written.push(target);
  }
  return written;
}

/**
 * @param {string} marker
 * @returns {string}
 */
function skill(marker) {
  return `---\nname: canary\ndescription: Canary skill (${marker}); it must never be listed in an opencode-unity session.\n---\n\n${marker}\n`;
}

/**
 * @param {string} id
 * @param {string} marker
 * @returns {string}
 */
function plugin(id, marker) {
  return `// Canary plugin for opencode-unity tests: if ${marker} appears in a model request, the user's global
// plugins were loaded. It only adds that marker to the system prompt.
export default {
  id: ${JSON.stringify(id)},
  server: async () => ({
    'experimental.chat.system.transform': async (_input, output) => {
      output.system.push(${JSON.stringify(marker)});
    },
  }),
};
`;
}
