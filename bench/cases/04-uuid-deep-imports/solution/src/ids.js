const { v4: uuidv4 } = require('uuid');

function newRecord(fields) {
  return { id: uuidv4(), ...fields };
}

module.exports = { newRecord };
