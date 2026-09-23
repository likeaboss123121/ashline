// Named railway stations from an OpenStreetMap snapshot, for placing stops along routed corridors.
//
// The railway geometry extract only keeps nodes that sit on railway ways, which misses most stations: large
// ones are mapped as areas, many stand beside the track, and the long-closed stations of the north are tagged
// disused:railway or abandoned:railway. This pulls all of them, active or not, and keeps a name, a point and a status.
// Metro and bus stations are left out: a train cannot stop at either.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const SCOPE = { output: 'world/imported/south-america-stations.json', id: 'south-america-stations',
  label: 'South America railway stations', sourceId: 'openstreetmap-geofabrik-south-america-2026-09-21' };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let read;
  while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  fs.closeSync(descriptor);
  return hash.digest('hex');
}

const STATION_VALUES = ['station', 'halt'];

// What kind of station a feature is, or null when it is not one a train stops at.
function statusOf(tags) {
  if (tags.station === 'subway' || tags.subway === 'yes' || tags.station === 'funicular' || tags.station === 'light_rail'
    || tags.tram === 'yes' && tags.train !== 'yes') return null;
  if (STATION_VALUES.includes(tags.railway)) return 'active';
  if (STATION_VALUES.includes(tags['disused:railway'])) return 'disused';
  if (STATION_VALUES.includes(tags['abandoned:railway'])) return 'abandoned';
  if (tags.historic === 'railway_station' || STATION_VALUES.includes(tags['historic:railway'])) return 'historic';
  return null;
}

function pointOf(geometry) {
  if (geometry.type === 'Point') return geometry.coordinates;
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
  const unique = ring.slice(0, -1);
  return [unique.reduce((sum, point) => sum + point[0], 0) / unique.length,
    unique.reduce((sum, point) => sum + point[1], 0) / unique.length];
}

// osmium numbers an area from its way (2 × id) or multipolygon relation (2 × id + 1); cite the object itself.
function osmId(id) {
  const kind = String(id)[0], number = Number(String(id).slice(1));
  if (kind === 'a') return number % 2 ? 'osm-relation:' + (number - 1) / 2 : 'osm-way:' + number / 2;
  assert(kind === 'n' || kind === 'w' || kind === 'r', 'Unexpected OSM id: ' + id);
  return { n: 'osm-node', w: 'osm-way', r: 'osm-relation' }[kind] + ':' + number;
}

function main() {
  const scope = SCOPE;
  const input = argument('input') && path.resolve(root, argument('input'));
  assert(input && fs.existsSync(input), 'Usage: npm run world:extract:south-america:stations -- --input /path/to/extract.osm.pbf');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-osm-stations-'));
  const filtered = path.join(temporary, 'stations.osm.pbf');
  const geojson = path.join(temporary, 'stations.geojsonseq');
  try {
    run('osmium', ['tags-filter', '--overwrite', '-o', filtered, input,
      'nwr/railway=station,halt', 'nwr/disused:railway=station,halt', 'nwr/abandoned:railway=station,halt',
      'nwr/historic:railway=station,halt', 'nwr/historic=railway_station']);
    run('osmium', ['export', '--overwrite', '-f', 'geojsonseq', '--add-unique-id=type_id',
      '--geometry-types=point,polygon', '-o', geojson, filtered]);
    const stations = fs.readFileSync(geojson, 'utf8').split('\n').filter(Boolean).map(line => {
      const feature = JSON.parse(line.replace(/^\x1e/, ''));
      const tags = feature.properties;
      const status = statusOf(tags);
      if (!status || !tags.name) return null;
      const point = pointOf(feature.geometry);
      const value = [tags.railway, tags['disused:railway'], tags['abandoned:railway'], tags['historic:railway']]
        .find(candidate => STATION_VALUES.includes(candidate));
      const kind = value === 'halt' ? 'halt' : 'station';
      // EFE grades its stations 1 (major) to 3; the category settles which of two close stations is the stop.
      const category = Number(tags['railway:station_category']);
      return { id: osmId(feature.id), name: tags.name, status, kind,
        ...(category >= 1 && category <= 3 ? { category } : {}),
        coordinates: [Math.round(point[0] * 1e7) / 1e7, Math.round(point[1] * 1e7) / 1e7] };
    }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const counts = {};
    stations.forEach(station => { counts[station.status] = (counts[station.status] || 0) + 1; });
    const artifact = {
      formatVersion: 1,
      id: scope.id,
      label: scope.label,
      sourceId: scope.sourceId,
      sourceSnapshotSha256: sha256File(input),
      navigable: false,
      stats: { stationCount: stations.length, statusCounts: counts },
      stations
    };
    const target = path.join(root, scope.output);
    fs.writeFileSync(target, '{\n' + Object.entries(artifact).filter(([key]) => key !== 'stations')
      .map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join(',\n') +
      ',\n  "stations": [\n' + stations.map(station => '    ' + JSON.stringify(station)).join(',\n') + '\n  ]\n}\n');
    console.log('Wrote ' + stations.length + ' named stations to ' + scope.output + ' (' +
      Object.entries(counts).map(([status, count]) => count + ' ' + status).join(', ') + ')');
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
