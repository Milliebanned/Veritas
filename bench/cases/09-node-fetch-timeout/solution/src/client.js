const fetch = require('node-fetch').default;

async function getJson(url, { timeoutMs = 2000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

module.exports = { getJson };
