process.env.FORCE_COLOR = '0';

const test = require('node:test');
const assert = require('node:assert');
const { renderReport } = require('../src/report');
const { countResults } = require('../src/stats');

test('countResults counts passes and failures', () => {
  assert.deepStrictEqual(countResults([{ ok: true }, { ok: false }, { ok: true }]), { passed: 2, failed: 1 });
});

test('renderReport lists every result under a banner', () => {
  const out = renderReport('Suite', [
    { name: 'parses input', ok: true },
    { name: 'writes output', ok: false },
  ]);
  assert.strictEqual(
    out,
    ['=====', 'Suite', '=====', 'PASS parses input', 'FAIL writes output', '1 passed, 1 failed'].join('\n'),
  );
});
