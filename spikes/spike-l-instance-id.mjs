// Spike L: does the expected MCP for Unity instance id formula match on Windows?
//
// The id is `<name>@<hash>`, where the hash is the first 16 hex characters of SHA-1 over the UTF-8
// bytes of `Application.dataPath` (UM `PersistentInstanceUtility`), and the name is the folder above
// `Assets`. Confirming it against a live Editor needs Unity plus the hub, which this spike must not
// touch, so the automated part checks the formula and how sensitive it is to path normalization.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpikeContext } from './lib/spike.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'L',
  title: 'MCP for Unity instance id formula',
  question: 'Does the expected instance id formula match on Windows (the Application.dataPath string)?',
  contractTest: 'Manual with MCP for Unity',
  fallback: 'Name-only match with a warning',
};

/** A fictional project path; never a real one from this machine. */
const SAMPLE_DATA_PATH = 'D:/Projects/SampleGame/Assets';

/**
 * @param {string} dataPath
 */
function instanceHash(dataPath) {
  return crypto.createHash('sha1').update(dataPath, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The folder above `Assets`, as MCP for Unity derives the project name.
 * @param {string} dataPath
 */
function instanceName(dataPath) {
  let value = dataPath.replace(/[\\/]+$/, '');
  if (/assets$/i.test(value)) value = value.slice(0, -'Assets'.length).replace(/[\\/]+$/, '');
  return path.basename(value) || 'Unknown';
}

export async function run() {
  const ctx = new SpikeContext();
  // SHA-1 of "abc" from RFC 3174; proves the hash implementation before it is used on paths.
  ctx.checks.add('L1 the SHA-1 implementation matches the published test vector', crypto.createHash('sha1').update('abc', 'utf8').digest('hex') === 'a9993e364706816aba3e25717850c26c9cd0d89d');

  const variants = {
    'forward slashes (what Application.dataPath returns on Windows)': SAMPLE_DATA_PATH,
    'backslashes': SAMPLE_DATA_PATH.replace(/\//g, '\\'),
    'lower-case drive letter': SAMPLE_DATA_PATH.replace(/^D/, 'd'),
    'trailing slash': `${SAMPLE_DATA_PATH}/`,
  };
  const hashes = Object.fromEntries(Object.entries(variants).map(([label, value]) => [label, instanceHash(value)]));
  ctx.evidence.sampleDataPath = SAMPLE_DATA_PATH;
  ctx.evidence.expectedId = `${instanceName(SAMPLE_DATA_PATH)}@${instanceHash(SAMPLE_DATA_PATH)}`;
  ctx.evidence.hashesByNormalization = hashes;

  ctx.checks.add('L2 the id has the shape <name>@<16 hex>', /^[^@]+@[0-9a-f]{16}$/.test(String(ctx.evidence.expectedId)), ctx.evidence.expectedId);
  ctx.checks.add('L3 the name is the folder above Assets', instanceName(SAMPLE_DATA_PATH) === 'SampleGame' && instanceName('D:/Projects/SampleGame/Assets/') === 'SampleGame', [instanceName(SAMPLE_DATA_PATH), instanceName('D:/Projects/SampleGame/Assets/')]);
  ctx.checks.add('L4 every normalization gives a different hash, so a computed hash cannot be trusted blindly', new Set(Object.values(hashes)).size === Object.keys(hashes).length, hashes);

  // A locally computed id could only be confirmed offline from an MCP for Unity status file. There is
  // none on this machine, so the live check stays manual.
  const statusDir = path.join(os.homedir(), '.unity-mcp');
  const statusFiles = await fs.readdir(statusDir).catch(() => []);
  ctx.evidence.localStatusFiles = statusFiles.length;
  ctx.checks.add('L5 no offline source of a real instance id exists here, so the live check is manual', statusFiles.length === 0, statusFiles.length);

  ctx.outcome = ctx.checks.allPass ? 'manual-pending' : 'fail';
  ctx.decision = 'Take the spec fallback for v0.1: the editor agent matches on the instance NAME from `mcpforunity://instances` and stops unless exactly one instance matches the project name, with a warning. A computed `<name>@<hash>` is only shown as a hint, never used to pin an instance, until a live Editor check confirms the exact `Application.dataPath` string.';
  ctx.findings.push(
    'Formula (UM v10.1.0): id = `<name>@<hash>`; hash = SHA-1 over the UTF-8 bytes of Application.dataPath, hex, first 16 characters, lower case; name = the folder above `Assets`, or "Unknown".',
    'The hash is taken over the raw string, so slash direction, drive-letter case and a trailing separator each change it. Windows returns forward slashes from Application.dataPath, but the spike cannot prove the exact casing without an Editor.',
    'In batch mode MCP for Unity falls back to hashing `<current working directory>/Assets`, which is another reason not to rely on a locally computed hash.',
    'Manual check still open: start an Editor with MCP for Unity, read `mcpforunity://instances` and compare the id against the formula applied to that project\'s Application.dataPath.',
  );
  return ctx;
}
