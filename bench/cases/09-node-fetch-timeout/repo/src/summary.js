function summarize(states) {
  const counts = {};
  for (const state of states) counts[state] = (counts[state] || 0) + 1;
  return counts;
}

module.exports = { summarize };
