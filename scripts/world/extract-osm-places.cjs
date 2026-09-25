// Named settlements from an OpenStreetMap snapshot: the towns a proposed line is drawn towards where no railway
// was ever mapped. Cities, towns and villages only; hamlets and farms are too small to route a railway through.
//
// With --outposts it extracts the hamlets, farms and isolated dwellings instead: the estancias, mine camps and small
// ports a spur can run out to, where a long rural line would otherwise have nothing off it (see build-network.cjs).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const AREA = require('./scopes.cjs').scopeFromArguments();
const Area = AREA.label.charAt(0).toUpperCase() + AREA.label.slice(1);
const SCOPES = {
  places: { output: 'world/imported/' + AREA.prefix + '-places.json', id: AREA.prefix + '-places',
    label: Area + ' settlements', sourceId: AREA.sourceId, kinds: ['city', 'town', 'village'] },
  outposts: { output: 'world/imported/' + AREA.prefix + '-outposts.json', id: AREA.prefix + '-outposts',
    label: Area + ' hamlets, farms and isolated dwellings', sourceId: AREA.sourceId,
    kinds: ['hamlet', 'isolated_dwelling', 'farm'] }
};

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

function main() {
  const scope = process.argv.includes('--outposts') ? SCOPES.outposts : SCOPES.places;
  const KINDS = scope.kinds;
  const input = argument('input') && path.resolve(root, argument('input'));
  assert(input && fs.existsSync(input), 'Usage: npm run world:extract:south-america:places -- --input /path/to/extract.osm.pbf'
    + ' [--outposts]');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-osm-places-'));
  const filtered = path.join(temporary, 'places.osm.pbf');
  const geojson = path.join(temporary, 'places.geojsonseq');
  try {
    run('osmium', ['tags-filter', '--overwrite', '-o', filtered, input, 'n/place=' + KINDS.join(',')]);
    run('osmium', ['export', '--overwrite', '-f', 'geojsonseq', '--add-unique-id=type_id', '--geometry-types=point',
      '-o', geojson, filtered]);
    const places = fs.readFileSync(geojson, 'utf8').split('\n').filter(Boolean).map(line => {
      const feature = JSON.parse(line.replace(/^\x1e/, ''));
      const tags = feature.properties;
      if (!tags.name || !KINDS.includes(tags.place)) return null;
      const population = Number(String(tags.population || '').replace(/[^\d]/g, ''));
      return { id: 'osm-node:' + String(feature.id).slice(1), name: tags.name, kind: tags.place,
        ...(population > 0 ? { population } : {}),
        coordinates: feature.geometry.coordinates.map(value => Math.round(value * 1e5) / 1e5) };
    }).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const counts = {};
    places.forEach(place => { counts[place.kind] = (counts[place.kind] || 0) + 1; });
    const artifact = { formatVersion: 1, id: scope.id, label: scope.label, sourceId: scope.sourceId,
      sourceSnapshotSha256: sha256File(input), stats: { placeCount: places.length, kindCounts: counts }, places };
    fs.writeFileSync(path.join(root, scope.output), '{\n' + Object.entries(artifact).filter(([key]) => key !== 'places')
      .map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join(',\n') +
      ',\n  "places": [\n' + places.map(place => '    ' + JSON.stringify(place)).join(',\n') + '\n  ]\n}\n');
    console.log('Wrote ' + places.length + ' settlements to ' + scope.output + ' (' +
      Object.entries(counts).map(([kind, count]) => count + ' ' + kind).join(', ') + ')');
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
