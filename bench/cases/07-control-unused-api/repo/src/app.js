const express = require('express');
const { createRegistry } = require('./registry');

function createApp() {
  const app = express();
  const registry = createRegistry();
  app.use(express.json());

  app.get('/services/:name', (req, res) => {
    const status = registry.get(req.params.name);
    if (!status) return res.status(404).json({ error: 'Unknown service' });
    res.json({ name: req.params.name, status });
  });

  app.put('/services/:name', (req, res) => {
    registry.set(req.params.name, req.body.status);
    res.status(200).json({ name: req.params.name, status: req.body.status });
  });

  app.delete('/services/:name', (req, res) => {
    registry.remove(req.params.name);
    res.status(204).end();
  });

  return app;
}

module.exports = { createApp };
