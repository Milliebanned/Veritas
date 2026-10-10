const http = require('node:http');

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/weather') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ city: url.searchParams.get('city'), celsius: 20 }));
    }
    if (url.pathname === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: JSON.parse(body) }));
      });
    }
    if (url.pathname === '/health') {
      res.writeHead(200);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { startServer };
