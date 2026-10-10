function countResults(results) {
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed };
}

module.exports = { countResults };
