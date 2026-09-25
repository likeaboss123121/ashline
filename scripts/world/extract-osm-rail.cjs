const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { createNormalizer, writeNormalizedJson } = require('./import-osm-geojson.cjs');

const root = path.resolve(__dirname, '../..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
}

// Hashing a multi-gigabyte snapshot must not load it into memory.
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let read;
  while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  fs.closeSync(descriptor);
  return hash.digest('hex');
}

// Every railway way in the South America snapshot, normalized: filtered by railway tags first (the reverse order
// exhausts this server's memory on a continent), exported as a GeoJSON sequence and read record by record, since the
// export is larger than one string this runtime can hold.
const { scopeFromArguments } = require('./scopes.cjs');
const AREA = scopeFromArguments();
const SCOPE = {
  output: 'world/imported/' + AREA.prefix + '-rail.json',
  id: AREA.prefix + '-rail',
  label: AREA.label.charAt(0).toUpperCase() + AREA.label.slice(1) + ' railway geometry',
  sourceId: AREA.sourceId
};
const DROPPED_SERVICE = new Set(AREA.dropServiceTracks || []);

// Douglas-Peucker over [longitude, latitude] points, keeping both ends.
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  let worst = -1, worstIndex = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const p = points[index], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    const distance = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
    if (distance > worst) { worst = distance; worstIndex = index; }
  }
  if (worst <= tolerance) return [a, b];
  return simplify(points.slice(0, worstIndex + 1), tolerance).slice(0, -1).concat(simplify(points.slice(worstIndex), tolerance));
}

async function main() {
  const inputArgument = argument('input');
  assert(inputArgument, 'Usage: npm run world:extract:south-america -- --input /path/to/south-america-260921.osm.pbf');
  const input = path.resolve(root, inputArgument);
  assert(fs.existsSync(input), 'PBF input does not exist: ' + input);
  const output = path.join(root, SCOPE.output);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-osm-rail-'));
  const filtered = path.join(temporary, 'rail.osm.pbf');
  const geojson = path.join(temporary, 'rail.geojsonseq');
  try {
    const trackValues = 'rail,narrow_gauge,light_rail';
    run('osmium', ['tags-filter', '--overwrite', '-o', filtered, input,
      'w/railway=rail,narrow_gauge,light_rail,disused,abandoned,dismantled,razed,demolished,removed,preserved,construction,proposed,planned,historic',
      'w/disused:railway=' + trackValues, 'w/abandoned:railway=' + trackValues,
      'w/dismantled:railway=' + trackValues, 'w/razed:railway=' + trackValues,
      'w/demolished:railway=' + trackValues, 'w/removed:railway=' + trackValues,
      'w/construction:railway=' + trackValues, 'w/proposed:railway=' + trackValues,
      'w/planned:railway=' + trackValues, 'w/historic:railway=' + trackValues]);
    run('osmium', ['export', '--overwrite', '--add-unique-id=type_id', '--attributes=type,id,version,timestamp',
      '-f', 'geojsonseq', '-o', geojson, filtered]);
    const normalizer = createNormalizer({ id: SCOPE.id, label: SCOPE.label, sourceId: SCOPE.sourceId,
      sourceSnapshotSha256: sha256File(input), sourceInputSha256: sha256File(geojson) });
    const lines = readline.createInterface({ input: fs.createReadStream(geojson), crlfDelay: Infinity });
    let read = 0;
    for await (const line of lines) {
      if (!line) continue;
      const feature = JSON.parse(line.replace(/^\x1e/, ''));
      if (DROPPED_SERVICE.has(feature.properties && feature.properties.service)) continue;
      if (AREA.simplifyDegrees && feature.geometry && feature.geometry.type === 'LineString') {
        feature.geometry.coordinates = simplify(feature.geometry.coordinates, AREA.simplifyDegrees);
      }
      normalizer.add(feature);
      if (++read % 100000 === 0) console.error('Read ' + read.toLocaleString('en-US') + ' features');
    }
    const normalized = normalizer.finish();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await writeNormalizedJson(output, normalized);
    console.log('Extracted ' + normalized.stats.wayCount + ' ways, ' + normalized.stats.pointCount + ' railway points and '
      + normalized.stats.coordinateCount + ' coordinates to ' + path.relative(root, output));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
