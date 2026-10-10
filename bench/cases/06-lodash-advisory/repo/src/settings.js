const _ = require('lodash');

const DEFAULTS = { server: { port: 3000, host: 'localhost' }, debug: false };

// Turns flat "a.b.c" keys (for example from a form or query string) into a nested object.
function fromFlat(flat) {
  return _.zipObjectDeep(Object.keys(flat), Object.values(flat));
}

function withDefaults(settings) {
  return _.merge({}, DEFAULTS, settings);
}

module.exports = { fromFlat, withDefaults, DEFAULTS };
