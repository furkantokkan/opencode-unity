import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildCanaryHomeFiles,
  CANARY_MARKERS,
  DEFAULT_CANARY_MCP_URL,
  listCanaryMarkers,
  writeCanaryHome,
} from '../../../src/selftest/canary-home.js';
import { FIXTURES_DIR, snapshotTree } from '../../helpers/fixture-fs.mjs';

const FIXTURE_DIR = path.join(FIXTURES_DIR, 'opencode', 'canary-home');

/**
 * @param {import('node:test').TestContext} t
 */
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocu-canary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test('canary home: every marker is unique and no marker contains another', () => {
  const markers = listCanaryMarkers();

  assert.equal(markers.length, Object.keys(CANARY_MARKERS).length);
  assert.equal(new Set(markers).size, markers.length);
  for (const marker of markers) {
    assert.match(marker, /^OCU_CANARY_[A-Z_]+_[0-9A-F]{4}$/);
    assert.deepEqual(markers.filter((other) => other !== marker && other.includes(marker)), [], `${marker} is part of another marker`);
  }
});

test('canary home: the written tree equals the committed fixture', async (t) => {
  const dir = await tempDir(t);

  const written = await writeCanaryHome(dir);

  assert.equal(written.length, Object.keys(buildCanaryHomeFiles()).length);
  assert.deepEqual(await snapshotTree(dir), await snapshotTree(FIXTURE_DIR));
});

test('canary home: each source a clean room must block carries its own marker', () => {
  const files = buildCanaryHomeFiles();

  assert.match(files['.claude/CLAUDE.md'], new RegExp(CANARY_MARKERS.claudeMd));
  assert.match(files['.claude/skills/canary/SKILL.md'], new RegExp(CANARY_MARKERS.claudeSkill));
  assert.match(files['.agents/skills/canary/SKILL.md'], new RegExp(CANARY_MARKERS.agentsSkill));
  assert.match(files['.config/opencode/AGENTS.md'], new RegExp(CANARY_MARKERS.globalAgentsMd));
  assert.match(files['.config/opencode/ocu-canary-instructions.md'], new RegExp(CANARY_MARKERS.globalInstructions));
  assert.match(files['.config/opencode/agents/ocu-canary-file-agent.md'], new RegExp(CANARY_MARKERS.globalFileAgent));
  assert.match(files['.config/opencode/ocu-canary/listed-plugin.js'], new RegExp(CANARY_MARKERS.listedPlugin));
  assert.match(files['.config/opencode/plugins/ocu-canary-discovered.js'], new RegExp(CANARY_MARKERS.discoveredPlugin));

  for (const [name, marker] of Object.entries(CANARY_MARKERS)) {
    const carriers = Object.entries(files).filter(([, text]) => text.includes(marker));
    assert.ok(carriers.length >= 1, `${name} appears in no file`);
  }
});

test('canary home: the global config declares an agent, instructions, a plugin and an MCP server', () => {
  const config = JSON.parse(buildCanaryHomeFiles()['.config/opencode/opencode.json']);

  assert.deepEqual(config.instructions, ['~/.config/opencode/ocu-canary-instructions.md']);
  assert.deepEqual(config.plugin, ['./ocu-canary/listed-plugin.js']);
  assert.match(config.agent['ocu-canary-config-agent'].description, new RegExp(CANARY_MARKERS.globalConfigAgent));
  assert.equal(config.mcp['ocu-canary'].url, DEFAULT_CANARY_MCP_URL);
  assert.equal(config.mcp['ocu-canary'].headers['x-ocu-canary'], CANARY_MARKERS.globalMcpServer);

  const withMockHub = JSON.parse(buildCanaryHomeFiles({ mcpUrl: 'http://127.0.0.1:5555/ocu-canary-mcp' })['.config/opencode/opencode.json']);
  assert.equal(withMockHub.mcp['ocu-canary'].url, 'http://127.0.0.1:5555/ocu-canary-mcp');
});

test('canary home: a canary plugin loads and only adds its marker to the system prompt', async (t) => {
  const dir = await tempDir(t);
  await writeCanaryHome(dir);

  const module = await import(pathToFileURL(path.join(dir, '.config', 'opencode', 'plugins', 'ocu-canary-discovered.js')).href);
  const hooks = await module.default.server({});
  const output = { system: ['real prompt'] };
  await hooks['experimental.chat.system.transform']({}, output);

  assert.equal(module.default.id, 'ocu-canary-discovered');
  assert.deepEqual(output.system, ['real prompt', CANARY_MARKERS.discoveredPlugin]);
  assert.deepEqual(Object.keys(hooks), ['experimental.chat.system.transform']);
});
