const fetch = require('node-fetch').default;

async function isUp(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { isUp };
