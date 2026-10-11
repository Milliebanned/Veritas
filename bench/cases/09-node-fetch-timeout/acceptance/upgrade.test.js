const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../test/server');

test('node-fetch is no longer on the 2.x line', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'node-fetch', 'package.json');
  if (!fs.existsSync(manifest)) return; // replaced by the built-in fetch is also acceptable
  const major = Number(JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.')[0]);
  assert.ok(major >= 3, `node-fetch major is ${major}`);
});

test('the time limit is still enforced, and still reported as a timeout', async () => {
  const { getJson } = require('../src/client');
  const { checkStatus } = require('../src/status');
  const { baseUrl, close } = await startServer(800);
  try {
    assert.deepStrictEqual(await getJson(`${baseUrl}/status`, { timeoutMs: 1000 }), { state: 'ok' });
    const started = Date.now();
    await assert.rejects(() => getJson(`${baseUrl}/slow/status`, { timeoutMs: 150 }));
    assert.ok(Date.now() - started < 600, 'the request was not cut off at the time limit');
    assert.strictEqual(await checkStatus(`${baseUrl}/slow`, { timeoutMs: 150 }), 'timeout');
    assert.strictEqual(await checkStatus(baseUrl, { timeoutMs: 1000 }), 'ok');
  } finally {
    close();
  }
  assert.strictEqual(await checkStatus('http://127.0.0.1:9'), 'down');
});
