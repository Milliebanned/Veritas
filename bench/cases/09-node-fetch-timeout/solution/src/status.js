const { getJson } = require('./client');

// Reports a service as "timeout" when it is too slow to answer, and "down" when it cannot be reached at all.
async function checkStatus(baseUrl, { timeoutMs = 500 } = {}) {
  try {
    const body = await getJson(`${baseUrl}/status`, { timeoutMs });
    return body.state;
  } catch (err) {
    return err.name === 'AbortError' ? 'timeout' : 'down';
  }
}

module.exports = { checkStatus };
