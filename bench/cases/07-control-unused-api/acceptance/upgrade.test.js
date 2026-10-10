const test = require('node:test');
const assert = require('node:assert');
const { startApp, put } = require('../test/helpers');

test('the API behaves as before', async () => {
  const { server, baseUrl } = await startApp();
  try {
    await put(`${baseUrl}/services/cache`, { status: 'degraded' });
    const read = await fetch(`${baseUrl}/services/cache`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(await read.json(), { name: 'cache', status: 'degraded' });
    assert.strictEqual((await fetch(`${baseUrl}/services/none`)).status, 404);
  } finally {
    server.close();
  }
});
