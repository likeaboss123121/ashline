// Sizes of the world data the game ships, and how long the network takes to read and to build in the game.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');

function measure(relativePath) {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  return { file: relativePath, bytes: bytes.length, gzipBytes: zlib.gzipSync(bytes, { level: 9 }).length };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
}

function median(runs) {
  return runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)];
}

const networkPath = JSON.parse(fs.readFileSync(path.join(root, 'world/imports.json'), 'utf8')).network[0].file;
const networkText = fs.readFileSync(path.join(root, networkPath), 'utf8');
const parseRuns = [];
for (let index = 0; index < 5; index++) {
  const start = performance.now();
  JSON.parse(networkText);
  parseRuns.push(performance.now() - start);
}
const measurements = [measure('source/world-data.js'), measure(networkPath)];
if (fs.existsSync(path.join(root, 'index.html'))) measurements.push(measure('index.html'));
measurements.forEach(item => console.log(item.file + ': ' + formatBytes(item.bytes) + ' raw, ' + formatBytes(item.gzipBytes) + ' gzip'));
console.log('Network JSON.parse median: ' + median(parseRuns).toFixed(1) + ' ms (Node ' + process.version + ')');
// The game's own build of tiles, stations and legs from the compact data, as it happens on first use.
const { loadGame } = require(path.join(root, 'tests/helpers.cjs'));
const buildRuns = [];
for (let index = 0; index < 3; index++) {
  const { setup } = loadGame();
  const start = performance.now();
  setup.realWorldPilot.getGridRoute();
  buildRuns.push(performance.now() - start);
}
console.log('Network build in the game, median: ' + median(buildRuns).toFixed(0) + ' ms');
