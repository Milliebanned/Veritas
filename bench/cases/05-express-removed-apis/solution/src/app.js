const express = require('express');
const { createStore } = require('./store');
const { itemRoutes } = require('./routes/items');

function createApp() {
  const app = express();
  const store = createStore();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/items', itemRoutes(store));

  app.delete('/items/:id', (req, res) => {
    if (!store.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  });

  return app;
}

module.exports = { createApp };
