const test = require('node:test');
const assert = require('node:assert');
const { newRecord } = require('../src/ids');
const { keyFor } = require('../src/keys');
const { isUuid } = require('../src/validate');

test('isUuid accepts and rejects', () => {
  assert.strictEqual(isUuid('not-a-uuid'), false);
  assert.strictEqual(isUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8'), true);
});

test('newRecord assigns a unique v4 id', () => {
  const a = newRecord({ name: 'a' });
  const b = newRecord({ name: 'b' });
  assert.ok(isUuid(a.id));
  assert.strictEqual(a.id[14], '4');
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(a.name, 'a');
});

test('keyFor is stable for the same name', () => {
  assert.strictEqual(keyFor('example.com'), keyFor('example.com'));
  assert.notStrictEqual(keyFor('example.com'), keyFor('example.org'));
  assert.strictEqual(keyFor('example.com')[14], '5');
});
