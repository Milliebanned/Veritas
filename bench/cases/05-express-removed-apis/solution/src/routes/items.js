const express = require('express');

function itemRoutes(store) {
  const router = express.Router();

  router.get('/:id', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  });

  router.post('/', (req, res) => {
    const item = store.add(req.body.name);
    res.status(201).json(item);
  });

  return router;
}

module.exports = { itemRoutes };
