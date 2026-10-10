function createRegistry() {
  const services = new Map();
  return {
    get: (name) => services.get(name),
    set: (name, status) => services.set(name, status),
    remove: (name) => services.delete(name),
  };
}

module.exports = { createRegistry };
