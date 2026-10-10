const { createApp } = require('../src/app');

function startApp() {
  return new Promise((resolve) => {
    const server = createApp().listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

module.exports = { startApp, post };
