process.env.FORCE_COLOR = '0';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('chalk is no longer on the 4.x line', () => {
  const manifest = path.join(process.cwd(), 'node_modules', 'chalk', 'package.json');
  if (!fs.existsSync(manifest)) return; // dependency removed entirely is also acceptable
  const major = Number(JSON.parse(fs.readFileSync(manifest, 'utf8')).version.split('.')[0]);
  assert.ok(major >= 5, `chalk major is ${major}`);
});

test('formatting still works', () => {
  const { formatStatus, formatSummary } = require('../src/format');
  const { banner } = require('../src/banner');
  assert.strictEqual(formatStatus('a', true), 'PASS a');
  assert.strictEqual(formatStatus('b', false), 'FAIL b');
  assert.strictEqual(formatSummary(3, 0), '3 passed, 0 failed');
  assert.strictEqual(banner('Hi'), '==\nHi\n==');
});

test('full report still renders', () => {
  const { renderReport } = require('../src/report');
  assert.strictEqual(renderReport('X', [{ name: 'only', ok: true }]), '=\nX\n=\nPASS only\n1 passed, 0 failed');
});
