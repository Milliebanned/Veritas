const fetch = require('node-fetch');

async function isUp(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { isUp };
