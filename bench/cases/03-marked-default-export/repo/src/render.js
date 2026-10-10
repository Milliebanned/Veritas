const marked = require('marked');

function renderNote(source) {
  return marked(source);
}

function renderTitle(source) {
  return marked.parseInline(source);
}

module.exports = { renderNote, renderTitle };
