const uuidv4 = require('uuid/v4');

function newRecord(fields) {
  return { id: uuidv4(), ...fields };
}

module.exports = { newRecord };
