const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./server');
const { currentTemperature } = require('../src/weather');
const { isUp } = require('../src/health');
const { toFahrenheit } = require('../src/units');

test('toFahrenheit converts', () => {
  assert.strictEqual(toFahrenheit(100), 212);
});

test('currentTemperature reads the service', async () => {
  const { server, baseUrl } = await startServer();
  try {
    assert.strictEqual(await currentTemperature(baseUrl, 'Pune'), 20);
    assert.strictEqual(await currentTemperature(baseUrl, 'Pune', 'F'), 68);
  } finally {
    server.close();
  }
});

test('isUp reports a healthy service', async () => {
  const { server, baseUrl } = await startServer();
  try {
    assert.strictEqual(await isUp(`${baseUrl}/health`), true);
    assert.strictEqual(await isUp(`${baseUrl}/missing`), false);
  } finally {
    server.close();
  }
});
