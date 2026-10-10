const { getJson } = require('./client');
const { toFahrenheit } = require('./units');

async function currentTemperature(baseUrl, city, unit = 'C') {
  const data = await getJson(`${baseUrl}/weather?city=${encodeURIComponent(city)}`);
  return unit === 'F' ? toFahrenheit(data.celsius) : data.celsius;
}

module.exports = { currentTemperature };
