// MCP for Unity (spec 9.2, 11): package presence, the hub URL the Editor writes, and the expected instance id.
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, toPosix } from './fs-view.js';
import { findPackage } from './packages.js';

export const MCP_PACKAGE_ID = 'com.coplaydev.unity-mcp';
export const MCP_TESTED_VERSION = '10.1.0';
export const MCP_SERVER_KEY = 'unityMCP';

// Package default base URL plus the JSON-RPC path the Editor helper appends.
export const DEFAULT_HUB_BASE_URL = 'http://127.0.0.1:8080';
export const DEFAULT_HUB_URL = `${DEFAULT_HUB_BASE_URL}/mcp`;

const CONFIG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {object} McpFact
 * @property {boolean} present
 * @property {string | null} version
 * @property {boolean} testedVersion
 * @property {string | null} folder     Embedded package folder, when the package lives in the project.
 */

/**
 * @param {import('./packages.js').PackageInfo[]} packages
 * @returns {McpFact}
 */
export function detectMcpForUnity(packages) {
  const found = findPackage(packages, MCP_PACKAGE_ID);
  if (!found) return { present: false, version: null, testedVersion: false, folder: null };
  return { present: true, version: found.version, testedVersion: found.version === MCP_TESTED_VERSION, folder: found.folder };
}

/**
 * The path MCP for Unity's OpenCode configurator writes: `$XDG_CONFIG_HOME` or `<user profile>/.config`,
 * then `opencode/opencode.json`.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function getOpenCodeUserConfigPath(env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, 'opencode', 'opencode.json');
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  return home ? path.join(home, '.config', 'opencode', 'opencode.json') : null;
}

/**
 * @typedef {object} HubUrlFact
 * @property {string} url
 * @property {'opencode-config' | 'package-default'} source
 * @property {string | null} configPath  Absolute; machine data, so it belongs in local.json only.
 * @property {boolean} loopback
 */

/**
 * Read-only: the user's own OpenCode config is never written by this product.
 * @param {import('./fs-view.js').FsView} view
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {HubUrlFact}
 */
export function detectHubUrl(view, { env = {} } = {}) {
  const configPath = getOpenCodeUserConfigPath(env);
  const url = configPath ? readHubUrl(view, configPath) : null;
  const value = url ?? DEFAULT_HUB_URL;
  return { url: value, source: url ? 'opencode-config' : 'package-default', configPath, loopback: isLoopbackUrl(value) };
}

/**
 * The instance id MCP for Unity derives from `Application.dataPath`, which is `<project>/Assets` with
 * forward slashes.
 * @param {string} root
 * @returns {{ id: string, name: string, dataPath: string }}
 */
export function getExpectedInstanceId(root) {
  const absolute = path.resolve(root);
  const dataPath = `${toPosix(absolute)}/Assets`;
  const hash = crypto.createHash('sha1').update(dataPath, 'utf8').digest('hex').slice(0, 16);
  const name = path.basename(absolute) || 'Unknown';
  return { id: `${name}@${hash}`, name, dataPath };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * @param {import('./fs-view.js').FsView} view
 * @param {string} configPath
 * @returns {string | null}
 */
function readHubUrl(view, configPath) {
  const document = readJson(view, configPath, { maxBytes: CONFIG_MAX_BYTES });
  if (!document.found || document.error || typeof document.value !== 'object' || document.value === null) return null;
  const mcp = /** @type {Record<string, any>} */ (document.value).mcp;
  const server = mcp && typeof mcp === 'object' ? mcp[MCP_SERVER_KEY] : undefined;
  const url = server && typeof server === 'object' ? server.url : undefined;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}
