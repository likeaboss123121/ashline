const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTopology } = require('./build-rail-topology.cjs');
const { buildRoutedTopology } = require('./build-routed-corridor.cjs');
const { parseCsv } = require('./csv.cjs');
const { defaultCache, tilesFor, fetchTiles } = require('./dem.cjs');

const root = path.resolve(__dirname, '../..');
const TILE_KM = 5;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status + ': ' + result.stderr);
  return result.stdout;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function positionCoordinates(corridor) {
  // A routed corridor is sampled over each grid square it crosses, centred on the square.
  if (corridor.gridCells) {
    const stationAt = Object.fromEntries(corridor.stationPositions.map((position, index) => [position, corridor.stations[index].id]));
    return corridor.gridCells.map((cell, index) => ({ coordinate: cell.centre, sliceId: cell.id,
      ...(stationAt[index] ? { stationId: stationAt[index] } : {}), squareKm: corridor.grid.cellKm }));
  }
  const positions = [{ coordinate: corridor.stations[0].coordinates, stationId: corridor.stations[0].id }];
  corridor.gridSlices.forEach(slice => positions.push({ coordinate: slice.coordinates.at(-1), sliceId: slice.id }));
  positions.at(-1).stationId = corridor.stations.at(-1).id;
  return positions;
}

function sampleSquare(vrt, coordinate, squareKm = TILE_KM) {
  const latitude = coordinate[1];
  const halfLatitude = (squareKm / 2) / 111.32;
  const halfLongitude = (squareKm / 2) / (111.32 * Math.cos(latitude * Math.PI / 180));
  const xyz = run('gdal_translate', ['-q', '-of', 'XYZ', '-projwin',
    String(coordinate[0] - halfLongitude), String(latitude + halfLatitude),
    String(coordinate[0] + halfLongitude), String(latitude - halfLatitude), vrt, '/vsistdout/']);
  let count = 0, mean = 0, sumSquaredDifference = 0;
  xyz.trim().split(/\r?\n/).forEach(line => {
    if (!line) return;
    const value = Number(line.trim().split(/\s+/).at(-1));
    if (!Number.isFinite(value)) return;
    count++;
    const delta = value - mean;
    mean += delta / count;
    sumSquaredDifference += delta * (value - mean);
  });
  assert(count > 0, 'DEM returned no samples at ' + coordinate.join(','));
  return {
    meanElevationM: Math.round(mean * 10) / 10,
    elevationStdDevM: Math.round(Math.sqrt(sumSquaredDifference / count) * 10) / 10,
    sampleCount: count
  };
}

// The topology the elevation belongs to, built exactly as the compiler builds it, so the build IDs agree.
function topologyFor(geometryId) {
  const imports = JSON.parse(fs.readFileSync(path.join(root, 'world/imports.json'), 'utf8'));
  const authored = JSON.parse(fs.readFileSync(path.join(root, 'world/authored/playable-corridors.json'), 'utf8'));
  const railEntry = (imports.railGeometry || []).find(entry => entry.id === geometryId);
  if (railEntry) {
    const geometry = JSON.parse(fs.readFileSync(path.join(root, railEntry.file), 'utf8'));
    return buildTopology(geometry, authored);
  }
  const routedEntry = (imports.routedLinks || []).find(entry => entry.id === geometryId);
  assert(routedEntry, 'No rail geometry or routed link set with ID ' + geometryId + ' in world/imports.json');
  const routed = JSON.parse(fs.readFileSync(path.join(root, routedEntry.file), 'utf8'));
  const places = parseCsv(fs.readFileSync(path.join(root, 'world/authored/places.csv'), 'utf8'))
    .map(row => ({ id: row.place_id, name: row.name }));
  const stationSets = Object.fromEntries((imports.stations || []).map(entry =>
    [entry.id, JSON.parse(fs.readFileSync(path.join(root, entry.file), 'utf8'))]));
  const settlementSets = Object.fromEntries((imports.settlements || []).map(entry =>
    [entry.id, JSON.parse(fs.readFileSync(path.join(root, entry.file), 'utf8'))]));
  return buildRoutedTopology(routed, authored, places, stationSets, settlementSets);
}

function main() {
  const geometryId = argument('geometry') || 'chile-central-pilot';
  const output = argument('output');
  const fetch = process.argv.includes('--fetch');
  assert(output && (fetch || argument('dem')), 'Usage: node scripts/world/sample-elevation.cjs [--geometry id] ' +
    '(--dem tile.tif[,tile.tif] | --fetch [--cache dir]) --output world/imported/elevation.json');
  const topology = topologyFor(geometryId);
  const positionsByCorridor = topology.corridors.map(corridor => ({ corridor, positions: positionCoordinates(corridor) }));
  let demPaths;
  if (fetch) {
    const cache = argument('cache') ? path.resolve(argument('cache')) : defaultCache();
    demPaths = fetchTiles(tilesFor(positionsByCorridor.flatMap(entry => entry.positions.map(position => position.coordinate))), cache);
  } else {
    demPaths = String(argument('dem')).split(',').filter(Boolean).map(file => path.resolve(root, file));
  }
  demPaths.forEach(file => assert(fs.existsSync(file), 'DEM tile does not exist: ' + file));
  assert(demPaths.length, 'No DEM tiles cover the route');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-dem-'));
  const vrt = path.join(temporary, 'pilot.vrt');
  try {
    run('gdalbuildvrt', ['-q', vrt].concat(demPaths));
    let sampled = 0;
    const total = positionsByCorridor.reduce((sum, entry) => sum + entry.positions.length, 0);
    const corridors = positionsByCorridor.map(({ corridor, positions }) => ({
      corridorId: corridor.id,
      positions: positions.map((position, index) => {
        sampled++;
        if (process.env.ASHLINE_WORLD_QUIET !== '1' && sampled % 100 === 0) console.error('Sampled ' + sampled + '/' + total);
        return {
          position: index,
          coordinate: position.coordinate,
          ...(position.stationId ? { stationId: position.stationId } : {}),
          ...(position.sliceId ? { incomingSliceId: position.sliceId } : {}),
          ...sampleSquare(vrt, position.coordinate, position.squareKm)
        };
      })
    }));
    const artifact = {
      formatVersion: 1,
      sourceId: 'copernicus-dem-glo90',
      geometryId: topology.geometryId,
      topologyBuildId: topology.buildId,
      tileKm: TILE_KM,
      aggregation: 'mean-and-population-standard-deviation-within-geographic-tile',
      mountainStdDevM: 120,
      sourceFiles: demPaths.map(file => ({ name: path.basename(file), sha256: sha256File(file) })),
      corridors
    };
    const target = path.resolve(root, output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(artifact, null, 2) + '\n');
    console.log('Sampled ' + total + ' route tiles from Copernicus GLO-90 to ' + path.relative(root, target));
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
