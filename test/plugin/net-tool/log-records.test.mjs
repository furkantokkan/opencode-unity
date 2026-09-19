// Step 21 (12.12.5, SPEC P5): the session log holds metadata only. Markers are planted in every place a
// request or a response can carry text - path, query, body, response body, response header, userinfo -
// and none may appear in any record, either as the tool hands it over or as the session log keeps it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeRecord } from '../../../plugin/opencode-unity-lib/session-log.js';
import { sendRequest } from '../../../plugin/opencode-unity-lib/net/transport.js';
import { FUNCTIONS_ENTRY, buildPolicy, call, createContext, createTool, startServer } from './helpers.mjs';

const MARKERS = Object.freeze({
  path: 'pathmarker7f3a',
  query: 'querymarker91c4',
  body: 'bodymarker55e2',
  response: 'responsemarker0b8d',
  header: 'headermarker6a1f',
  user: 'usermarker3d9c',
});

/**
 * @param {Record<string, unknown>[]} records
 */
function assertNoMarker(records) {
  const text = JSON.stringify(records) + JSON.stringify(records.map((record) => sanitizeRecord(record)));
  for (const [where, marker] of Object.entries(MARKERS)) assert.equal(text.includes(marker), false, `the ${where} marker reached the log`);
}

describe('what the session log keeps', () => {
  it('keeps no path, query, body or response text from a request that went out', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-note': MARKERS.header });
      response.end(JSON.stringify({ result: MARKERS.response }));
    });
    try {
      const { tool, records } = createTool({ network: buildPolicy({ derived: [{ ...FUNCTIONS_ENTRY, ports: [server.port] }], disjoint: true }), send: sendRequest });
      const text = await tool.execute(call('POST', `${server.origin}/demo-game/us-central1/${MARKERS.path}?q=${MARKERS.query}`, JSON.stringify({ data: MARKERS.body })), createContext({ sessionID: 'ses_log' }).ctx);
      assert.match(text, new RegExp(MARKERS.response), 'the model still reads the body');
      assert.equal(records.length, 1);
      assertNoMarker(records);
      const record = records[0];
      assert.deepEqual(
        Object.keys(record).sort(),
        ['agent', 'bodyBytes', 'code', 'contentType', 'durationMs', 'entry', 'event', 'host', 'method', 'pathChars', 'port', 'queryKeys', 'queryPresent', 'responseBytes', 'scheme', 'sessionId', 'status', 'tool', 'truncated', 'verdict'].sort(),
      );
      assert.equal(record.event, 'net');
      assert.equal(record.tool, 'unitynet');
      assert.equal(record.verdict, 'allowed');
      assert.equal(record.code, 'ok');
      assert.equal(record.entry, 'firebase-functions');
      assert.equal(record.host, '127.0.0.1');
      assert.equal(record.pathChars, `/demo-game/us-central1/${MARKERS.path}`.length);
      assert.equal(record.queryPresent, true);
      assert.equal(record.queryKeys, 1);
      assert.equal(record.bodyBytes, JSON.stringify({ data: MARKERS.body }).length);
      assert.equal(record.status, 200);
      assert.equal(record.contentType, 'application/json');
    } finally {
      await server.close();
    }
  });

  it('keeps no value from a refused request either, and logs an unmatched host as a length', async () => {
    const { tool, records } = createTool();
    const { ctx } = createContext();
    // The host is example.com so that the userinfo does not read as an address to the hygiene scan.
    await tool.execute(call('GET', `https://${MARKERS.user}:secret@example.com/${MARKERS.path}`), ctx);
    await tool.execute(call('GET', `https://${MARKERS.path}.example/x?${MARKERS.query}=1`), ctx);
    await tool.execute(call('GET', `https://docs.unity3d.com/Manual/x?token=${MARKERS.query}`), ctx);
    await tool.execute(call('POST', `https://docs.unity3d.com/${MARKERS.path}`, MARKERS.body), ctx);
    assert.equal(records.length, 4);
    assertNoMarker(records);
    const unmatched = records[1];
    assert.equal(unmatched.code, 'net_host_not_allowed');
    assert.equal('host' in unmatched, false);
    assert.equal(unmatched.hostChars, `${MARKERS.path}.example`.length);
    assert.equal(records[2].host, 'docs.unity3d.com');
    assert.equal(records[2].code, 'net_credential_in_url');
  });

  it('keeps no human feedback from a declined permission', async () => {
    const { tool, records } = createTool();
    const { ctx } = createContext({ answer: () => { throw Object.assign(new Error('x'), { _tag: 'PermissionCorrectedError', feedback: MARKERS.body }); } });
    const text = await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), ctx);
    assert.match(text, new RegExp(MARKERS.body), 'the model reads what the human wrote');
    assertNoMarker(records);
  });

  it('keeps the step number for every refusal and none for a result', async () => {
    const { tool, records } = createTool();
    await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    await tool.execute(call('GET', 'http://127.0.0.1:11434/api/tags'), createContext().ctx);
    assert.equal('step' in records[0], false);
    assert.equal(records[1].step, 7);
  });

  it('survives the session log\'s own sanitiser with its codes and counts intact', async () => {
    const { tool, records } = createTool();
    await tool.execute(call('GET', 'https://docs.unity3d.com/Manual/index.html'), createContext().ctx);
    const kept = sanitizeRecord(records[0]);
    assert.equal(kept.event, 'net');
    assert.equal(kept.code, 'ok');
    assert.equal(kept.verdict, 'allowed');
    assert.equal(kept.status, 200);
    assert.equal(kept.port, 443);
  });
});
