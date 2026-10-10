const semver = require('semver');

function isSupported(version, range) {
  return semver.satisfies(version, range);
}

function newestSupported(versions, range) {
  return semver.maxSatisfying(versions, range);
}

function sortReleases(versions) {
  return [...versions].sort(semver.compare);
}

module.exports = { isSupported, newestSupported, sortReleases };
