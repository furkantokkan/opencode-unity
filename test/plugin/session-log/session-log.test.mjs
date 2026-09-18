// The plugin's session log (spec 6.1, 13.4, P5). Two rules carry the weight: it holds metadata only,
// and it never fails a request.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SESSION_LOG_MAX_STRING,
  SESSION_LOG_RETENTION_DAYS,
  createSessionLog,
  getSessionLogPath,
  pruneOldLogs,
  sanitizeRecord,
} from '../../../plugin/opencode-unity-lib/session-log.js';
import { useSandbox } from '../../helpers/sandbox.mjs';

const DAY = new Date('2026-09-18T10:11:12.000Z');

/** A file system that records calls and can be told to fail. */
function createFakeFs({ failOn = '' } = {}) {
  /** @type {string[]} */
  const writes = [];
  /** @type {string[]} */
  const made = [];
  return {
    writes,
    made,
    fs: {
      mkdir: async (dir) => {
        if (failOn === 'mkdir') throw new Error('read-only home');
        made.push(dir);
      },
      appendFile: async (file, line) => {
        if (failOn === 'appendFile') throw new Error('disk full');
        writes.push(`${file}\u0000${line}`);
      },
      readdir: async () => [],
      rm: async () => {},
    },
  };
}

describe('session log records', () => {
  it('keeps numbers and booleans, and the few strings that name a thing', () => {
    const record = sanitizeRecord({ event: 'request', agent: 'unity-code', estimate: 4200, overBudget: false });
    assert.deepEqual(record, { event: 'request', agent: 'unity-code', estimate: 4200, overBudget: false });
  });

  it('drops anything that could carry prompt or file content', () => {
    const record = sanitizeRecord({
      event: 'shellBlocked',
      command: 'cat Assets/Secret.cs',
      filePath: '/opt/project/Assets/Secret.cs',
      messages: [{ text: 'secret' }],
      nested: { a: 1 },
      nothing: null,
      broken: Number.NaN,
    });
    assert.deepEqual(record, { event: 'shellBlocked' });
  });

  it('cuts a known string to a readable length', () => {
    const record = sanitizeRecord({ reason: 'x'.repeat(500) });
    assert.equal(String(record.reason).length, SESSION_LOG_MAX_STRING);
  });

  it('survives a record that is not an object', () => {
    assert.deepEqual(sanitizeRecord(/** @type {any} */ (null)), {});
  });
});

describe('session log writing', () => {
  it('writes one JSON line per record into the day file, with a timestamp', async () => {
    const fake = createFakeFs();
    const log = createSessionLog({ home: '/opt/home', now: () => DAY, fs: /** @type {any} */ (fake.fs) });
    log.append({ event: 'pluginLoaded', model: 'ocu-model-16k' });
    log.append({ event: 'request', estimate: 10 });
    await log.flush();

    assert.equal(fake.writes.length, 2);
    const [file, line] = fake.writes[0].split('\u0000');
    assert.equal(file, getSessionLogPath('/opt/home', DAY));
    assert.equal(path.basename(file), '2026-09-18.jsonl');
    assert.ok(line.endsWith('\n'));
    assert.deepEqual(JSON.parse(line), { at: '2026-09-18T10:11:12.000Z', event: 'pluginLoaded', model: 'ocu-model-16k' });
  });

  it('creates the directory once and prunes only on the first write', async () => {
    const fake = createFakeFs();
    const log = createSessionLog({ home: '/opt/home', now: () => DAY, fs: /** @type {any} */ (fake.fs) });
    log.append({ event: 'a' });
    log.append({ event: 'b' });
    await log.flush();
    assert.equal(fake.made.length, 1);
  });

  it('reports a write failure instead of throwing at the caller', async () => {
    /** @type {unknown[]} */
    const errors = [];
    for (const failOn of ['mkdir', 'appendFile']) {
      const fake = createFakeFs({ failOn });
      const log = createSessionLog({ home: '/opt/home', now: () => DAY, fs: /** @type {any} */ (fake.fs), onError: (error) => errors.push(error) });
      assert.doesNotThrow(() => log.append({ event: 'x' }));
      await log.flush();
    }
    assert.equal(errors.length, 2);
  });

  it('writes a real file into a real home', async (t) => {
    const sandbox = await useSandbox(t, 'session-log');
    const home = sandbox.path('product-home');
    const log = createSessionLog({ home, now: () => DAY });
    log.append({ event: 'request', estimate: 42 });
    await log.flush();
    const text = await fs.readFile(getSessionLogPath(home, DAY), 'utf8');
    assert.match(text, /"event":"request"/);
  });
});

describe('session log retention', () => {
  it('removes day files older than the retention window and keeps the rest', async () => {
    /** @type {string[]} */
    const removed = [];
    const entries = ['2026-09-18.jsonl', '2026-09-04.jsonl', '2026-09-03.jsonl', '2026-08-01.jsonl', 'notes.txt', 'gpu.lock'];
    const result = await pruneOldLogs(
      /** @type {any} */ ({ readdir: async () => entries, rm: async (file) => removed.push(path.basename(file)) }),
      '/opt/home/state/sessions',
      DAY,
    );
    assert.deepEqual(result, ['2026-09-03.jsonl', '2026-08-01.jsonl']);
    assert.deepEqual(removed, ['2026-09-03.jsonl', '2026-08-01.jsonl']);
    assert.equal(SESSION_LOG_RETENTION_DAYS, 14);
  });

  it('treats an unreadable directory as empty', async () => {
    const result = await pruneOldLogs(/** @type {any} */ ({ readdir: async () => { throw new Error('gone'); }, rm: async () => {} }), '/x', DAY);
    assert.deepEqual(result, []);
  });
});
