const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('marked is no longer on the 3.x line', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'marked', 'package.json');
  const major = Number(JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.')[0]);
  assert.ok(major >= 4, `marked major is ${major}`);
});

test('rendering still works', () => {
  const { renderNote, renderTitle } = require('../src/render');
  const { outline } = require('../src/outline');
  assert.strictEqual(renderNote('one\n\ntwo'), '<p>one</p>\n<p>two</p>\n');
  assert.strictEqual(renderNote('1. x\n2. y\n'), '<ol>\n<li>x</li>\n<li>y</li>\n</ol>\n');
  assert.strictEqual(renderTitle('`code` here'), '<code>code</code> here');
  assert.deepStrictEqual(outline('### Deep\n'), [{ depth: 3, text: 'Deep' }]);
});
