const express = require('express');

function itemRoutes(store) {
  const router = express.Router();

  router.get('/:id', (req, res) => {
    const item = store.get(req.param('id'));
    if (!item) return res.json(404, { error: 'Not found' });
    res.json(item);
  });

  router.post('/', (req, res) => {
    const item = store.add(req.body.name);
    res.json(201, item);
  });

  return router;
}

module.exports = { itemRoutes };
