const uuidv5 = require('uuid/v5');

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function keyFor(name) {
  return uuidv5(name, NAMESPACE);
}

module.exports = { keyFor };
