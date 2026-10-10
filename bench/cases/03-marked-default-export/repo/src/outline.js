const marked = require('marked');

function outline(source) {
  return marked
    .lexer(source)
    .filter((token) => token.type === 'heading')
    .map((token) => ({ depth: token.depth, text: token.text }));
}

module.exports = { outline };
