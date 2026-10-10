const test = require('node:test');
const assert = require('node:assert');
const { isSupported, newestSupported, sortReleases } = require('../src/compat');

test('isSupported checks a range', () => {
  assert.strictEqual(isSupported('1.4.0', '^1.2.0'), true);
  assert.strictEqual(isSupported('2.0.0', '^1.2.0'), false);
});

test('newestSupported picks the highest match', () => {
  assert.strictEqual(newestSupported(['1.2.0', '1.9.3', '2.0.0'], '^1.0.0'), '1.9.3');
  assert.strictEqual(newestSupported(['2.0.0'], '^1.0.0'), null);
});

test('sortReleases orders by version, not by string', () => {
  assert.deepStrictEqual(sortReleases(['1.10.0', '1.2.0', '1.9.0']), ['1.2.0', '1.9.0', '1.10.0']);
});
