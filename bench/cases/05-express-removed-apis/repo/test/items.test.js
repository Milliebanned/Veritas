const test = require('node:test');
const assert = require('node:assert');
const { startApp, post } = require('./helpers');
const { createStore } = require('../src/store');

test('store adds, reads and removes', () => {
  const store = createStore();
  const item = store.add('a');
  assert.deepStrictEqual(store.get(item.id), { id: '1', name: 'a' });
  assert.strictEqual(store.remove(item.id), true);
  assert.strictEqual(store.remove(item.id), false);
});

test('health endpoint responds', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('create, read and delete an item', async () => {
  const { server, baseUrl } = await startApp();
  try {
    const created = await post(`${baseUrl}/items`, { name: 'first' });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(await created.json(), { id: '1', name: 'first' });

    const read = await fetch(`${baseUrl}/items/1`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(await read.json(), { id: '1', name: 'first' });

    const removed = await fetch(`${baseUrl}/items/1`, { method: 'DELETE' });
    assert.strictEqual(removed.status, 204);

    const missing = await fetch(`${baseUrl}/items/1`);
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(await missing.json(), { error: 'Not found' });
  } finally {
    server.close();
  }
});
