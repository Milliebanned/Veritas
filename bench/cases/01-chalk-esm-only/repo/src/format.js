const chalk = require('chalk');

function formatStatus(name, ok) {
  return ok ? chalk.green(`PASS ${name}`) : chalk.red(`FAIL ${name}`);
}

function formatSummary(passed, failed) {
  const text = `${passed} passed, ${failed} failed`;
  return failed > 0 ? chalk.bold.red(text) : chalk.bold.green(text);
}

module.exports = { formatStatus, formatSummary };
