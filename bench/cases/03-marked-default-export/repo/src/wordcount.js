function wordCount(source) {
  return source.split(/\s+/).filter(Boolean).length;
}

module.exports = { wordCount };
