const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('uuid is on a release without deep imports', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'uuid', 'package.json');
  const major = Number(JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.')[0]);
  assert.ok(major >= 8, `uuid major is ${major}`);
});

test('ids and keys still work', () => {
  const { newRecord } = require('../src/ids');
  const { keyFor } = require('../src/keys');
  const { isUuid } = require('../src/validate');
  const record = newRecord({ kind: 'x' });
  assert.ok(isUuid(record.id));
  assert.strictEqual(record.kind, 'x');
  // v5 of "example.com" in the DNS namespace is fixed by RFC 4122.
  assert.strictEqual(keyFor('example.com'), 'cfbff0d1-9375-5685-968c-48ce8b15ae17');
});
