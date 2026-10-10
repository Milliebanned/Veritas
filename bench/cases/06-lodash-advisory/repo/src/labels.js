const _ = require('lodash');

function toLabel(key) {
  return _.startCase(_.trim(key));
}

module.exports = { toLabel };
