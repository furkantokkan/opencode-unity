import fs from 'node:fs';

export const CLI_NAME = 'opencode-unity';

// Trademark hygiene (spec P12): the banner and --version always carry this line.
export const DISCLAIMER = 'unofficial; not affiliated with OpenCode, Ollama or Unity';

export const MIN_NODE_MAJOR = 22;

function readPackageVersion() {
  const packageUrl = new URL('../../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(packageUrl, 'utf8')).version;
}

/** @type {string} */
export const CLI_VERSION = readPackageVersion();

/**
 * @param {string} [version]
 * @returns {string}
 */
export function formatVersionLine(version = CLI_VERSION) {
  return `${CLI_NAME} ${version} (${DISCLAIMER})`;
}

/**
 * @param {string} nodeVersion A `process.versions.node` style string, for example '22.4.0'.
 * @returns {boolean}
 */
export function isSupportedNodeVersion(nodeVersion) {
  const major = Number.parseInt(nodeVersion, 10);
  return Number.isInteger(major) && major >= MIN_NODE_MAJOR;
}
