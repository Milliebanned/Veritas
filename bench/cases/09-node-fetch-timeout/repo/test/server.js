const http = require('node:http');

// A status service: /status answers at once, /slow/status answers after `slowMs`.
function startServer(slowMs = 600) {
  const server = http.createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'ok' }));
    };
    if (req.url === '/status') return reply();
    if (req.url === '/slow/status') return void setTimeout(reply, slowMs);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const close = () => {
        server.closeAllConnections();
        server.close();
      };
      resolve({ baseUrl, close });
    });
  });
}

module.exports = { startServer };
