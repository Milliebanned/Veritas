const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('lodash is at 4.18.0 or later, where the published advisories are fixed', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'lodash', 'package.json');
  const [major, minor] = JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.').map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 18), `lodash is ${major}.${minor}`);
});

test('flat keys can no longer pollute Object.prototype', () => {
  const { fromFlat } = require('../src/settings');
  try {
    fromFlat({ '__proto__.veritasProbe': true });
    assert.strictEqual({}.veritasProbe, undefined);
  } finally {
    delete Object.prototype.veritasProbe;
  }
});

test('settings and labels behave as before', () => {
  const { fromFlat, withDefaults } = require('../src/settings');
  const { toLabel } = require('../src/labels');
  assert.deepStrictEqual(withDefaults(fromFlat({ 'server.host': 'example.test' })), {
    server: { port: 3000, host: 'example.test' },
    debug: false,
  });
  assert.strictEqual(toLabel('debug'), 'Debug');
});
