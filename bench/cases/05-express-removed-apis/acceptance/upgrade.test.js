const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, post } = require('../test/helpers');

test('express is on 5.x or later', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'express', 'package.json');
  const major = Number(JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.')[0]);
  assert.ok(major >= 5, `express major is ${major}`);
});

test('the API behaves as before', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const a = await post(`${baseUrl}/items`, { name: 'alpha' });
    const b = await post(`${baseUrl}/items`, { name: 'beta' });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    assert.deepStrictEqual(await b.json(), { id: '2', name: 'beta' });

    const read = await fetch(`${baseUrl}/items/2`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(await read.json(), { id: '2', name: 'beta' });

    const unknown = await fetch(`${baseUrl}/items/99`);
    assert.strictEqual(unknown.status, 404);
    assert.deepStrictEqual(await unknown.json(), { error: 'Not found' });

    assert.strictEqual((await fetch(`${baseUrl}/items/1`, { method: 'DELETE' })).status, 204);
    assert.strictEqual((await fetch(`${baseUrl}/items/1`, { method: 'DELETE' })).status, 404);
    assert.strictEqual((await fetch(`${baseUrl}/items/1`)).status, 404);
  } finally {
    server.close();
  }
});
