const { banner } = require('./banner');
const { formatStatus, formatSummary } = require('./format');
const { countResults } = require('./stats');

function renderReport(title, results) {
  const { passed, failed } = countResults(results);
  return [
    banner(title),
    ...results.map((r) => formatStatus(r.name, r.ok)),
    formatSummary(passed, failed),
  ].join('\n');
}

module.exports = { renderReport };
