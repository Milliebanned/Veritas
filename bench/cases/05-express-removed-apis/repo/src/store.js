function createStore() {
  const items = new Map();
  let nextId = 1;
  return {
    add(name) {
      const item = { id: String(nextId++), name };
      items.set(item.id, item);
      return item;
    },
    get(id) {
      return items.get(id);
    },
    remove(id) {
      return items.delete(id);
    },
  };
}

module.exports = { createStore };
