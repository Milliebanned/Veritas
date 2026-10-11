const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./server');
const { getJson } = require('../src/client');
const { checkStatus } = require('../src/status');
const { summarize } = require('../src/summary');

test('summarize counts states', () => {
  assert.deepStrictEqual(summarize(['ok', 'down', 'ok']), { ok: 2, down: 1 });
});

test('getJson returns the body of a fast service', async () => {
  const { baseUrl, close } = await startServer();
  try {
    assert.deepStrictEqual(await getJson(`${baseUrl}/status`), { state: 'ok' });
  } finally {
    close();
  }
});

test('getJson gives up on a service slower than the time limit', async () => {
  const { baseUrl, close } = await startServer(600);
  try {
    await assert.rejects(() => getJson(`${baseUrl}/slow/status`, { timeoutMs: 100 }));
  } finally {
    close();
  }
});

test('checkStatus tells ok, timeout and down apart', async () => {
  const { baseUrl, close } = await startServer(600);
  try {
    assert.strictEqual(await checkStatus(baseUrl), 'ok');
    assert.strictEqual(await checkStatus(`${baseUrl}/slow`, { timeoutMs: 100 }), 'timeout');
  } finally {
    close();
  }
  assert.strictEqual(await checkStatus('http://127.0.0.1:9'), 'down');
});
