const test = require('node:test');
const assert = require('node:assert');
const { renderNote, renderTitle } = require('../src/render');
const { outline } = require('../src/outline');
const { wordCount } = require('../src/wordcount');

test('renderNote renders paragraphs and emphasis', () => {
  assert.strictEqual(renderNote('Hello **world**'), '<p>Hello <strong>world</strong></p>\n');
});

test('renderNote renders lists', () => {
  assert.strictEqual(renderNote('- a\n- b\n'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
});

test('renderTitle renders inline markdown without a paragraph', () => {
  assert.strictEqual(renderTitle('A *short* title'), 'A <em>short</em> title');
});

test('outline lists headings', () => {
  assert.deepStrictEqual(outline('# One\n\ntext\n\n## Two\n'), [
    { depth: 1, text: 'One' },
    { depth: 2, text: 'Two' },
  ]);
});

test('wordCount counts words', () => {
  assert.strictEqual(wordCount('one two  three'), 3);
});
