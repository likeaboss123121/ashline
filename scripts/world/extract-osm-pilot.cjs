const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatJson, normalizeGeoJson } = require('./import-osm-geojson.cjs');

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

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function main() {
  const inputArgument = argument('input');
  assert(inputArgument, 'Usage: npm run world:extract:chile -- --input /path/to/chile-260920.osm.pbf');
  const input = path.resolve(root, inputArgument);
  assert(fs.existsSync(input), 'PBF input does not exist: ' + input);
  const output = path.join(root, 'world/imported/chile-central-rail.json');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-osm-pilot-'));
  const filtered = path.join(temporary, 'chile-rail.osm.pbf');
  const extracted = path.join(temporary, 'central-rail.osm.pbf');
  const geojson = path.join(temporary, 'central-rail.geojson');
  try {
    const trackValues = 'rail,narrow_gauge,light_rail';
    run('osmium', ['tags-filter', '--overwrite', '-o', filtered, input,
      'w/railway=rail,narrow_gauge,light_rail,disused,abandoned,dismantled,razed,demolished,removed,preserved,construction,proposed,planned,historic',
      'w/disused:railway=' + trackValues, 'w/abandoned:railway=' + trackValues,
      'w/dismantled:railway=' + trackValues, 'w/razed:railway=' + trackValues,
      'w/demolished:railway=' + trackValues, 'w/removed:railway=' + trackValues,
      'w/construction:railway=' + trackValues, 'w/proposed:railway=' + trackValues,
      'w/planned:railway=' + trackValues, 'w/historic:railway=' + trackValues]);
    run('osmium', ['extract', '--bbox=-72.2,-34.0,-70.0,-32.5', '--strategy=complete_ways', '--overwrite',
      '-o', extracted, filtered]);
    run('osmium', ['export', '--overwrite', '--add-unique-id=type_id', '--attributes=type,id,version,timestamp',
      '-o', geojson, extracted]);
    const geojsonBytes = fs.readFileSync(geojson);
    const normalized = normalizeGeoJson(JSON.parse(geojsonBytes.toString('utf8')), {
      id: 'chile-central-pilot',
      label: 'Central Chile railway geometry pilot',
      sourceId: 'openstreetmap-geofabrik-2026-09-20',
      sourceSnapshotSha256: sha256(fs.readFileSync(input)),
      sourceInputSha256: sha256(geojsonBytes)
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, formatJson(normalized));
    console.log('Extracted ' + normalized.stats.wayCount + ' ways, ' + normalized.stats.pointCount + ' railway points and '
      + normalized.stats.coordinateCount + ' coordinates to ' + path.relative(root, output));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
