import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPainter } from '../../../src/cli/output.js';
import { buildBanner, COMPACTION_FRACTION, hasAttention, renderBanner, summarizeGuardForBanner } from '../../../src/terminal/banner.js';
import { formatClock, formatDuration, formatGiBOrUnknown, joinFields, padLabel, paintTone } from '../../../src/terminal/format.js';
import { createTruncationWatcher, formatStatusLine, readTruncations, statusTone } from '../../../src/terminal/status-view.js';
import { parseSessionLines, renderSummary, summarizeSession } from '../../../src/terminal/summary.js';
import { buildPaneCommands, CONHOST_WARNING, decidePane, isWindowsTerminal, openStatusPane } from '../../../src/terminal/wt.js';

const plain = createPainter(false);
const colored = createPainter(true);

/** @returns {import('../../../src/terminal/banner.js').BannerInput} */
function bannerInput(overrides = {}) {
  return {
    version: '0.1.0',
    project: { name: 'SampleGame', unityVersion: '6000.3', vcsKind: 'git', factsFresh: true, factsTokens: 410 },
    preset: { id: 'nvidia-24gb-qwen3-coder-30b-16k', status: 'reference-tested', opencodeVersion: '1.18.31', ollamaVersion: '0.34.1' },
    model: { tag: 'ocu-qwen3-coder-30b-16k', loaded: false, contextLength: null, expiresInSec: null, coldLoadSeconds: 15 },
    guard: { verdict: 'pass', reasons: [], freeVramMiB: 22_426, modelVramMiB: 19_046, minFreeVramAfterLoadMiB: 1536, imports: 'idle', editors: 1, notMeasured: [] },
    budget: { fixedPromptTokens: 5000, promptBudget: 11_776, numCtx: 16_384, prefixFailTokens: 6000, bashMode: 'allowlist' },
    config: { verified: true, cached: true, editorAgent: false },
    ...overrides,
  };
}

describe('terminal/format', () => {
  it('pads labels to one column and joins fields with two spaces', () => {
    assert.equal(padLabel('project'), 'project  ');
    assert.equal(padLabel('a-very-long-label'), 'a-very-long-label ');
    assert.equal(joinFields(['a', '', null, undefined, false, 'b']), 'a  b');
  });

  it('formats durations a person reads at a glance', () => {
    assert.equal(formatDuration(45), '45s');
    assert.equal(formatDuration(59.4), '59s');
    assert.equal(formatDuration(59.6), '1m');
    assert.equal(formatDuration(13 * 60), '13m');
    assert.equal(formatDuration(3600), '1h');
    assert.equal(formatDuration(3900), '1h 5m');
    assert.equal(formatDuration(-1), 'unknown');
    assert.equal(formatDuration(Number.NaN), 'unknown');
  });

  it('formats a clock and gibibytes', () => {
    assert.match(formatClock(new Date(2026, 8, 18, 4, 5, 6)), /^04:05:06$/);
    assert.equal(formatGiBOrUnknown(1024), '1.0 GiB');
    assert.equal(formatGiBOrUnknown(null), 'unknown');
    assert.equal(formatGiBOrUnknown(Number.POSITIVE_INFINITY), 'unknown');
  });

  it('paints only when a painter is enabled', () => {
    assert.equal(paintTone(plain, 'warn', 'text'), 'text');
    assert.notEqual(paintTone(colored, 'warn', 'text'), 'text');
    assert.equal(paintTone(colored, 'plain', 'text'), 'text');
  });
});

describe('terminal/banner', () => {
  it('builds the eight lines of spec 13.2 in order', () => {
    const lines = buildBanner(bannerInput());
    assert.deepEqual(lines.map((line) => line.id), ['header', 'project', 'preset', 'model', 'guard', 'budget', 'config', 'tips']);
    assert.match(lines[0].text, /^opencode-unity 0\.1\.0 \(unofficial/);
    assert.match(lines[1].text, /SampleGame {2}Unity 6000\.3 {2}git {2}facts fresh/);
    assert.match(lines[3].text, /not loaded \(the first prompt loads it through the guard, ~15 s\)/);
    assert.match(lines[4].text, /free VRAM 21\.9 GiB, needs 18\.6 \+ 1\.5/);
    assert.match(lines[5].text, /compaction at 12\.3k/);
    assert.match(lines[6].text, /effective rules verified \(cached\) {2}editor agent: off/);
  });

  it('uses the same compaction fraction the overflow path does', () => {
    assert.equal(Math.floor(16_384 * COMPACTION_FRACTION), 12_288);
  });

  it('marks stale facts, an experimental preset and an unverified config as attention', () => {
    assert.equal(hasAttention(buildBanner(bannerInput())), false);
    const stale = buildBanner(bannerInput({ project: { ...bannerInput().project, factsFresh: false } }));
    assert.equal(stale[1].tone, 'warn');
    assert.match(stale[1].text, /init --refresh/);
    assert.equal(hasAttention(stale), true);
    const experimental = buildBanner(bannerInput({ preset: { ...bannerInput().preset, status: 'experimental' } }));
    assert.equal(experimental[2].tone, 'warn');
    const unverified = buildBanner(bannerInput({ config: { verified: false, cached: false, editorAgent: true } }));
    assert.equal(unverified[6].tone, 'warn');
    assert.match(unverified[6].text, /editor agent: on/);
  });

  it('shows a blocked guard with its reason and marks it red', () => {
    const lines = buildBanner(bannerInput({ guard: { ...bannerInput().guard, verdict: 'blocked', reasons: ['not enough video memory'] } }));
    assert.equal(lines[4].tone, 'bad');
    assert.match(lines[4].text, /blocked {2}not enough video memory/);
    assert.equal(hasAttention(lines), true);
  });

  it('warns rather than passing silently when a check could not be measured', () => {
    const lines = buildBanner(bannerInput({ guard: { ...bannerInput().guard, notMeasured: ['gpu utilization'] } }));
    assert.equal(lines[4].tone, 'warn');
    assert.match(lines[4].text, /not measured here: gpu utilization/);
  });

  it('reports a loaded model with its context and remaining time', () => {
    const loaded = buildBanner(bannerInput({ model: { tag: 'ocu', loaded: true, contextLength: 16_384, expiresInSec: 780, coldLoadSeconds: 15 } }));
    assert.match(loaded[3].text, /loaded 16\.4k {2}13m left/);
    const forever = buildBanner(bannerInput({ model: { tag: 'ocu', loaded: true, contextLength: null, expiresInSec: Infinity, coldLoadSeconds: 15 } }));
    assert.match(forever[3].text, /loaded {2}no timeout/);
  });

  it('says so when the numbers are missing instead of inventing them', () => {
    const lines = buildBanner(bannerInput({
      project: { name: 'P', unityVersion: null, vcsKind: null, factsFresh: true, factsTokens: 0 },
      preset: { id: 'p', status: 'verified', opencodeVersion: null, ollamaVersion: null },
      guard: { ...bannerInput().guard, freeVramMiB: null, editors: null, imports: 'unknown' },
    }));
    assert.match(lines[1].text, /Unity version unknown {2}no version control/);
    assert.match(lines[2].text, /OpenCode version unknown {2}Ollama version unknown/);
    assert.match(lines[4].text, /free VRAM not measured, needs 18\.6 \+ 1\.5 GiB/);
    assert.match(lines[4].text, /editors unknown/);
  });

  it('inserts an extension line after the line it names', () => {
    const lines = buildBanner(bannerInput({ extraLines: [{ after: 'preset', id: 'tier', label: 'tier', text: 'full', tone: 'plain' }] }));
    assert.deepEqual(lines.map((line) => line.id), ['header', 'project', 'preset', 'tier', 'model', 'guard', 'budget', 'config', 'tips']);
  });

  it('renders the same words with and without colour', () => {
    const lines = buildBanner(bannerInput());
    const bare = renderBanner(lines, { paint: plain });
    const painted = renderBanner(lines, { paint: colored });
    assert.equal(bare.split('\n').length, lines.length);
    // eslint-disable-next-line no-control-regex
    assert.equal(painted.replace(/\u001b\[\d+m/g, ''), bare);
    assert.match(bare, /^opencode-unity/);
    assert.match(bare, /\nproject {2}SampleGame/);
  });

  it('maps a verdict to the banner shape without reading probe internals', () => {
    const verdict = {
      verdict: 'blocked',
      pass: false,
      path: 'cold',
      mode: 'stop',
      reasons: [{ id: 'vram_low', mode: 'stop', detail: 'only 1.0 GiB free', data: {} }],
      notes: [],
      cacheSec: 0,
      checkedAt: '2026-09-18T09:30:00.000Z',
      target: { modelTag: 'ocu', numCtx: 16_384 },
      model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
      measurements: {
        gpu: { memory: { ok: true, totalMiB: 24_576, freeMiB: 1024 }, utilization: { ok: true, samples: [3] }, gpuCount: 1 },
        unity: { ok: true, running: true, detailsRead: true, editorCount: 2, cpuSampled: true, elapsedMs: 1500, importProcesses: [{ pid: 1 }], importCpuPercent: 40, editors: [], busiestEditorCpuPercent: 5, unreadable: [] },
        loadedModels: [],
      },
    };
    const banner = summarizeGuardForBanner(/** @type {any} */ (verdict), { modelVramMiB: 19_046, minFreeVramAfterLoadMiB: 1536 });
    assert.equal(banner.freeVramMiB, 1024);
    assert.equal(banner.editors, 2);
    assert.equal(banner.imports, 'busy');
    assert.deepEqual(banner.reasons, ['only 1.0 GiB free']);
  });

  it('reads an unreadable probe as unknown, never as idle', () => {
    const base = {
      verdict: 'pass', pass: true, path: 'cold', mode: null, reasons: [], notes: [], cacheSec: 3,
      checkedAt: '2026-09-18T09:30:00.000Z', target: { modelTag: 'ocu', numCtx: 16_384 },
      model: { loaded: false, state: 'not-listed', contextLength: null, expiresInSec: null, sizeVramMiB: 0, reclaimableMiB: 0, otherModels: [] },
      measurements: { gpu: null, unity: { ok: false, error: 'access denied' }, loadedModels: [] },
    };
    const banner = summarizeGuardForBanner(/** @type {any} */ (base), { modelVramMiB: 1, minFreeVramAfterLoadMiB: 1 });
    assert.equal(banner.imports, 'unknown');
    assert.equal(banner.editors, null);
    assert.equal(banner.freeVramMiB, null);
  });
});

describe('terminal/summary', () => {
  const records = [
    { at: '2026-09-18T09:30:00.000Z', event: 'pluginLoaded', model: 'ocu' },
    { at: '2026-09-18T09:31:00.000Z', event: 'request', agent: 'unity-code', estimate: 5200, budget: 11_776 },
    { at: '2026-09-18T09:32:00.000Z', event: 'request', agent: 'unity-code', estimate: 9100, budget: 11_776 },
    { at: '2026-09-18T09:33:00.000Z', event: 'overflow', agent: 'unity-code', estimate: 12_000, overBy: 224 },
    { at: '2026-09-18T09:34:00.000Z', event: 'guardBlock', reason: 'vram_low' },
    { at: '2026-09-18T09:35:00.000Z', event: 'guardBlock', reason: 'vram_low' },
    { at: '2026-09-18T09:36:00.000Z', event: 'guardBlock', reason: 'import_busy' },
    { at: '2026-09-18T09:37:00.000Z', event: 'truncation', inputTokens: 16_380, numCtx: 16_384 },
    { at: '2026-09-18T09:38:00.000Z', event: 'textToolCall', code: 'xml' },
  ];

  it('counts the spec 13.4 fields', () => {
    const summary = summarizeSession(records);
    assert.equal(summary.requests, 2);
    assert.equal(summary.maxEstimatedPromptTokens, 12_000);
    assert.equal(summary.maxActualPromptTokens, 16_380);
    assert.equal(summary.overflows, 1);
    assert.deepEqual(summary.guardBlocks, [{ reason: 'vram_low', count: 2 }, { reason: 'import_busy', count: 1 }]);
    assert.equal(summary.truncations, 1);
    assert.equal(summary.textToolCalls, 1);
    assert.equal(summary.firstLoadSeconds, null);
    assert.equal(summary.records, records.length);
  });

  it('names a guard block without a reason rather than dropping it', () => {
    const summary = summarizeSession([{ event: 'guardBlock' }]);
    assert.deepEqual(summary.guardBlocks, [{ reason: 'unknown', count: 1 }]);
  });

  it('fills the first-load time the moment a record carries one', () => {
    assert.equal(summarizeSession([{ event: 'firstLoad', seconds: 14.5 }]).firstLoadSeconds, 14.5);
    assert.equal(summarizeSession([{ event: 'firstLoad' }]).firstLoadSeconds, null);
  });

  it('renders four labelled lines and marks the ones that need attention', () => {
    const lines = renderSummary(summarizeSession(records), { paint: plain, durationMs: 480_000 });
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^session {2}2 requests {2}in 8m/);
    assert.match(lines[1], /max estimated 12\.0k {2}actual 16\.4k {2}compaction overflows 1/);
    assert.match(lines[2], /vram_low x2, import_busy x1/);
    assert.match(lines[3], /truncated prompts 1 {2}text-form tool calls 1/);
  });

  it('says nothing was recorded instead of printing zeros', () => {
    const lines = renderSummary(summarizeSession([]), { paint: plain });
    assert.deepEqual(lines, ['session  no plugin records for this session window']);
  });

  it('reports "not recorded" when no token number was measured', () => {
    const lines = renderSummary(summarizeSession([{ event: 'request' }]), { paint: plain });
    assert.match(lines[1], /max estimated not recorded {2}actual not recorded/);
  });

  it('skips lines that are not JSON objects, including a half-written last line', () => {
    const records2 = parseSessionLines('{"event":"request"}\nnot json\n[1,2]\n"text"\n{"event":"overflow"');
    assert.deepEqual(records2, [{ event: 'request' }]);
  });
});

describe('terminal/status-view', () => {
  /** @returns {import('../../../src/terminal/status-view.js').StatusSnapshot} */
  const snapshot = (overrides = {}) => ({
    at: new Date(2026, 8, 18, 12, 4, 10),
    guardVerdict: 'pass',
    guardReason: null,
    modelLoaded: true,
    modelContextLength: 16_384,
    modelExpiresInSec: 780,
    freeVramMiB: 1229,
    imports: 'idle',
    editors: 1,
    lock: '-',
    requests: 14,
    overflows: 1,
    truncations: 0,
    textToolCalls: 0,
    ...overrides,
  });

  it('renders the one-line form of spec 13.3', () => {
    const line = formatStatusLine(snapshot(), { paint: plain });
    assert.equal(
      line,
      '12:04:10 guard pass (loaded 16.4k, 13m left) | VRAM free 1.2 GiB | imports idle | editors 1 | lock - | req 14 | overflow 1 | trunc 0 | text-calls 0',
    );
  });

  it('names the blocking reason and turns red', () => {
    const line = formatStatusLine(snapshot({ guardVerdict: 'blocked', guardReason: 'gpu_busy' }), { paint: plain });
    assert.match(line, /guard blocked \(gpu_busy\)/);
    assert.equal(statusTone(snapshot({ guardVerdict: 'blocked' })), 'bad');
  });

  it('turns yellow on a truncated prompt or a degraded pass', () => {
    assert.equal(statusTone(snapshot({ truncations: 1 })), 'warn');
    assert.equal(statusTone(snapshot({ overflows: 0, guardVerdict: 'pass-degraded' })), 'warn');
    assert.equal(statusTone(snapshot({ overflows: 0 })), 'plain');
  });

  it('reads truncation lines out of a server log', () => {
    const text = [
      'time=2026-09-18T12:00:00.000+03:00 level=WARN source=llama_server.go:299 msg="truncating input prompt" limit=16384 prompt=20000 keep=4 new=8194',
      'time=2026-09-18T12:01:00.000+03:00 level=INFO msg="something else"',
    ].join('\n');
    const notices = readTruncations(text);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].prompt, 20_000);
    assert.equal(notices[0].kept, 8194);
    assert.match(notices[0].text, /cut a prompt of 20000 tokens to 8194 \(limit 16384\)/);
  });

  it('yields nothing for a journal or absent log source, and paints notices yellow', async () => {
    for (const source of [{ kind: 'journal', unit: 'ollama', command: [] }, { kind: 'none' }]) {
      const watcher = createTruncationWatcher({ source: /** @type {any} */ (source) });
      assert.deepEqual(await watcher.poll(), []);
    }
    const watcher = createTruncationWatcher({ source: { kind: 'none' } });
    const painted = watcher.render([{ time: null, limit: 1, prompt: 2, kept: 1, text: 'cut' }], { paint: colored });
    assert.notEqual(painted[0], 'cut');
  });

  it('follows a file source and survives a follower that throws', async () => {
    let call = 0;
    const watcher = createTruncationWatcher({
      source: { kind: 'file', path: '/logs/server.log', rotation: 'server-*.log' },
      createFollower: () => ({
        poll: async () => {
          call += 1;
          if (call === 1) return ['msg="truncating input prompt" limit=16384 prompt=17000 keep=4 new=8194'];
          throw new Error('rotated away');
        },
      }),
    });
    assert.equal((await watcher.poll()).length, 1);
    assert.deepEqual(await watcher.poll(), []);
  });
});

describe('terminal/wt', () => {
  it('opens a pane only inside Windows Terminal on Windows', () => {
    assert.deepEqual(decidePane({ platform: 'win32', env: { WT_SESSION: 'abc' } }), { open: true, reason: 'ok', warning: null });
    assert.deepEqual(decidePane({ platform: 'linux', env: { WT_SESSION: 'abc' } }), { open: false, reason: 'not-windows', warning: null });
    assert.deepEqual(decidePane({ platform: 'darwin', env: {} }), { open: false, reason: 'not-windows', warning: null });
    assert.deepEqual(decidePane({ platform: 'win32', env: { WT_SESSION: 'abc' }, noPane: true }), { open: false, reason: 'disabled-by-flag', warning: null });
    assert.deepEqual(decidePane({ platform: 'win32', env: { WT_SESSION: 'abc' }, configPane: 'never' }), { open: false, reason: 'disabled-by-config', warning: null });
    assert.deepEqual(decidePane({ platform: 'win32', env: {} }), { open: false, reason: 'not-windows-terminal', warning: CONHOST_WARNING });
    assert.equal(isWindowsTerminal({ WT_SESSION: '' }), false);
  });

  it('builds the two wt commands of spec 13.1 and escapes a semicolon', () => {
    const commands = buildPaneCommands({ nodePath: 'C:\\node.exe', cliPath: 'C:\\cli.mjs', project: 'C:\\a;b\\Game', intervalSec: 5 });
    assert.deepEqual(commands[0].args, ['-w', '0', 'split-pane', '--horizontal', '--size', '0.25', '--', 'C:\\node.exe', 'C:\\cli.mjs', 'status', '--watch', '--project', 'C:\\a\\;b\\Game', '--interval', '5']);
    assert.deepEqual(commands[1].args, ['-w', '0', 'move-focus', 'up']);
    const withoutInterval = buildPaneCommands({ nodePath: 'node', cliPath: 'cli', project: 'p' });
    assert.equal(withoutInterval[0].args.includes('--interval'), false);
  });

  it('reports rather than throws when wt is missing or fails', async () => {
    const missing = await openStatusPane({ nodePath: 'node', cliPath: 'cli', project: 'p', locate: () => null, run: async () => { throw new Error('never'); } });
    assert.equal(missing.opened, false);
    assert.match(missing.notes[0], /Windows Terminal command \(wt\) on PATH/);

    const failing = await openStatusPane({
      nodePath: 'node',
      cliPath: 'cli',
      project: 'p',
      locate: () => 'wt.exe',
      run: async () => /** @type {any} */ ({ exitCode: 1, error: null, timedOut: false, stdout: '', stderr: '' }),
    });
    assert.equal(failing.opened, false);
    assert.match(failing.notes[0], /wt exited 1/);
  });

  it('runs both commands when the pane opens', async () => {
    /** @type {string[][]} */
    const calls = [];
    const opened = await openStatusPane({
      nodePath: 'node',
      cliPath: 'cli',
      project: 'p',
      locate: () => 'wt.exe',
      run: async (_file, args) => {
        calls.push([...args]);
        return /** @type {any} */ ({ exitCode: 0, error: null, timedOut: false, stdout: '', stderr: '' });
      },
    });
    assert.equal(opened.opened, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].at(-1), 'up');
  });
});
