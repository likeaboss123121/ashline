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

const geometryPath = 'world/dist/geometry/chile-central-pilot.json';
const geometryText = fs.readFileSync(path.join(root, geometryPath), 'utf8');
const parseRuns = [];
for (let index = 0; index < 25; index++) {
  const start = performance.now();
  JSON.parse(geometryText);
  parseRuns.push(performance.now() - start);
}
parseRuns.sort((a, b) => a - b);

const measurements = [measure('source/world-data.js'), measure(geometryPath)];
if (fs.existsSync(path.join(root, 'index.html'))) measurements.push(measure('index.html'));
measurements.forEach(item => console.log(item.file + ': ' + formatBytes(item.bytes) + ' raw, ' + formatBytes(item.gzipBytes) + ' gzip'));
console.log('Central Chile geometry JSON.parse median: ' + parseRuns[Math.floor(parseRuns.length / 2)].toFixed(2) + ' ms (Node ' + process.version + ')');
