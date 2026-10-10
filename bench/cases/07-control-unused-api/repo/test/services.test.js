const test = require('node:test');
const assert = require('node:assert');
const { startApp, put } = require('./helpers');

test('set, read and remove a service status', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const saved = await put(`${baseUrl}/services/db`, { status: 'up' });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(await saved.json(), { name: 'db', status: 'up' });

    const read = await fetch(`${baseUrl}/services/db`);
    assert.deepStrictEqual(await read.json(), { name: 'db', status: 'up' });

    assert.strictEqual((await fetch(`${baseUrl}/services/db`, { method: 'DELETE' })).status, 204);

    const missing = await fetch(`${baseUrl}/services/db`);
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(await missing.json(), { error: 'Unknown service' });
  } finally {
    server.close();
  }
});
