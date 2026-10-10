const test = require('node:test');
const assert = require('node:assert');

test('version checks still work', () => {
  const { isSupported, newestSupported, sortReleases } = require('../src/compat');
  assert.strictEqual(isSupported('3.1.0-beta.1', '>=3.0.0'), false);
  assert.strictEqual(newestSupported(['0.9.0', '1.0.0'], '<1.0.0'), '0.9.0');
  assert.deepStrictEqual(sortReleases(['2.0.0', '2.0.0-rc.1']), ['2.0.0-rc.1', '2.0.0']);
});
