const test = require('node:test');
const assert = require('node:assert');
const { fromFlat, withDefaults } = require('../src/settings');
const { toLabel } = require('../src/labels');
const { isValidPort } = require('../src/ports');

test('fromFlat builds nested settings', () => {
  assert.deepStrictEqual(fromFlat({ 'server.port': 8080, debug: true }), { server: { port: 8080 }, debug: true });
});

test('withDefaults fills in missing values', () => {
  assert.deepStrictEqual(withDefaults({ server: { port: 8080 } }), {
    server: { port: 8080, host: 'localhost' },
    debug: false,
  });
});

test('toLabel makes a readable label', () => {
  assert.strictEqual(toLabel('  server_port '), 'Server Port');
});

test('isValidPort checks the range', () => {
  assert.strictEqual(isValidPort(8080), true);
  assert.strictEqual(isValidPort(70000), false);
});
