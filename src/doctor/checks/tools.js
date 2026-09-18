// MCP servers and the tool schema they add to every request (spec 5.4, 11.2).
//
// An MCP server's tool schemas are sent with every request. On a 16K context that cost is paid before
// the model has seen one line of the task, and a hub with dozens of tools can take more of the window
// than the code under discussion.
import { buildRuleset, isToolRemoved } from '../../opencode/permission-eval.js';
import { loadUnityMcpToolFixture } from '../../selftest/mock-mcp-hub.js';
import { error, pass, quantity, skip, warn } from '../finding.js';
import { effectiveLayers } from '../layers.js';
import { listMcpEntries, listPermissionBlocks } from '../opencode-config.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Calibrated at 3.5 characters per token for this model family (spec 8.8). */
const CHARS_PER_TOKEN = 3.5;

/** @type {readonly CheckSpec[]} */
export const TOOL_CHECKS = Object.freeze([
  {
    id: 'tools.mcp-schema',
    group: 'tools',
    title: 'MCP tool schemas reaching a local model',
    severities: ['error'],
    why: 'Enabled MCP servers add their whole tool schema to every request, and nothing in the configuration denies those tools to the local model.',
    fix: 'Deny the server\'s tools for this agent, or disable the server, and keep only the tools the agent is meant to call.',
    source: 'spec 8.5 and 11.2',
    run: (context) => {
      const layers = effectiveLayers(context);
      const enabled = listMcpEntries(layers).filter((entry) => entry.value.enabled !== false);
      if (enabled.length === 0) return skip('no MCP server is enabled in the configuration');
      const rules = buildRuleset(listPermissionBlocks(layers).map((block) => ({ layer: block.layerPath, permission: block.permission })));
      const caseInsensitive = context.platform === 'win32';
      const exposed = enabled.filter((entry) => !isToolRemoved(rules, `${entry.key}_*`, { caseInsensitive }));
      const estimate = estimateFixtureTokens();
      const data = {
        servers: enabled.map((entry) => entry.key),
        exposed: exposed.map((entry) => entry.key),
        estimatedTokensPerServer: estimate,
      };
      if (exposed.length === 0) return pass(`the tools of ${quantity(enabled.length, 'enabled MCP server')} are denied to the agent`, { data });
      return error(`${quantity(exposed.length, 'enabled MCP server')} without a deny rule, so the tool schema is in every request`, {
        details: [
          ...exposed.map((entry) => `${entry.key} in ${entry.layerPath}`),
          `a hub of the measured size costs about ${estimate} tokens of schema per request`,
        ],
        data,
      });
    },
  },
  {
    id: 'mcp.duplicate-server',
    group: 'tools',
    title: 'Duplicate MCP server entries',
    severities: ['error'],
    why: 'Two entries that differ only in case, or that point at the same URL, make the same tools appear twice and double what every request pays for them.',
    fix: 'Keep one entry per server and remove the duplicates.',
    source: 'spec 5.4',
    run: (context) => {
      const entries = listMcpEntries(effectiveLayers(context));
      if (entries.length === 0) return skip('no MCP server is configured');
      const byKey = groupBy(entries, (entry) => entry.key.toLowerCase());
      const byUrl = groupBy(entries.filter((entry) => typeof entry.value.url === 'string'), (entry) => String(entry.value.url).toLowerCase());
      const duplicateKeys = [...byKey.entries()].filter(([, group]) => new Set(group.map((entry) => entry.key)).size > 1);
      const duplicateUrls = [...byUrl.entries()].filter(([, group]) => new Set(group.map((entry) => entry.key)).size > 1);
      if (duplicateKeys.length === 0 && duplicateUrls.length === 0) {
        return pass(`${quantity(entries.length, 'MCP server entry', 'MCP server entries')}, no duplicates`);
      }
      return error(`${quantity(duplicateKeys.length + duplicateUrls.length, 'MCP server')} configured more than once`, {
        details: [
          ...duplicateKeys.map(([, group]) => `keys differing only in case: ${group.map((entry) => entry.key).join(', ')}`),
          ...duplicateUrls.map(([, group]) => `same url ${String(group[0].value.url)}: ${group.map((entry) => entry.key).join(', ')}`),
        ],
        data: {
          duplicateKeys: duplicateKeys.map(([, group]) => group.map((entry) => entry.key)),
          duplicateUrls: duplicateUrls.map(([, group]) => String(group[0].value.url)),
        },
      });
    },
  },
  {
    id: 'mcp.hub-loopback',
    group: 'tools',
    title: 'MCP hub address is loopback',
    severities: ['warn'],
    why: 'A non-loopback hub means editor commands and their arguments leave the machine, and the instance the hub answers for is not necessarily the project open here.',
    fix: 'Point the MCP server url at a loopback address.',
    source: 'spec 11.4 and P11',
    run: (context) => {
      const mcp = context.project.scan?.local;
      if (mcp === undefined) return skip('there is no Unity project here to scan');
      if (mcp.hubLoopback) return pass(`the MCP hub address ${mcp.hubUrl} is loopback`);
      return warn(`the MCP hub address ${mcp.hubUrl} is not loopback`, {
        details: [`source: ${mcp.hubUrlSource}`],
        data: { hubUrl: mcp.hubUrl, source: mcp.hubUrlSource },
      });
    },
  },
]);

/**
 * What one hub's tool list costs, from the shipped `tools/list` fixture. An estimate is honest here:
 * reading the live list would mean opening a socket to the hub, which default doctor does not do.
 * @returns {number}
 */
function estimateFixtureTokens() {
  try {
    return Math.round(JSON.stringify(loadUnityMcpToolFixture()).length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const id = key(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
}
