function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

module.exports = { isValidPort };
