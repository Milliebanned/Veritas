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

test('GET, POST and health checks still work', async () => {
  const { getJson, postJson } = require('../src/client');
  const { isUp } = require('../src/health');
  const { server, baseUrl } = await startServer();
  try {
    assert.deepStrictEqual(await getJson(`${baseUrl}/weather?city=Goa`), { city: 'Goa', celsius: 20 });
    assert.deepStrictEqual(await postJson(`${baseUrl}/echo`, { a: 1 }), { received: { a: 1 } });
    await assert.rejects(() => getJson(`${baseUrl}/missing`), /Request failed: 404/);
    assert.strictEqual(await isUp(`${baseUrl}/health`), true);
  } finally {
    server.close();
  }
});
