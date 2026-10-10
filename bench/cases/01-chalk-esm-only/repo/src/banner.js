const chalk = require('chalk');

function banner(title) {
  const line = '='.repeat(title.length);
  return [chalk.cyan(line), chalk.cyan.bold(title), chalk.cyan(line)].join('\n');
}

module.exports = { banner };
