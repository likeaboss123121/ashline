const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTopology } = require('./build-rail-topology.cjs');

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
  const positions = [{ coordinate: corridor.stations[0].coordinates, stationId: corridor.stations[0].id }];
  corridor.gridSlices.forEach(slice => positions.push({ coordinate: slice.coordinates.at(-1), sliceId: slice.id }));
  positions.at(-1).stationId = corridor.stations.at(-1).id;
  return positions;
}

function sampleSquare(vrt, coordinate) {
  const latitude = coordinate[1];
  const halfLatitude = (TILE_KM / 2) / 111.32;
  const halfLongitude = (TILE_KM / 2) / (111.32 * Math.cos(latitude * Math.PI / 180));
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

function main() {
  const demPaths = String(argument('dem') || '').split(',').filter(Boolean).map(file => path.resolve(root, file));
  const output = argument('output');
  assert(demPaths.length && output, 'Usage: node scripts/world/sample-elevation.cjs --dem tile.tif[,tile.tif] --output world/imported/elevation.json');
  demPaths.forEach(file => assert(fs.existsSync(file), 'DEM tile does not exist: ' + file));
  const geometry = JSON.parse(fs.readFileSync(path.join(root, 'world/imported/chile-central-rail.json'), 'utf8'));
  const authored = JSON.parse(fs.readFileSync(path.join(root, 'world/authored/playable-corridors.json'), 'utf8'));
  const topology = buildTopology(geometry, authored);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-dem-'));
  const vrt = path.join(temporary, 'pilot.vrt');
  try {
    run('gdalbuildvrt', ['-q', vrt].concat(demPaths));
    const corridors = topology.corridors.map(corridor => ({
      corridorId: corridor.id,
      positions: positionCoordinates(corridor).map((position, index) => ({
        position: index,
        coordinate: position.coordinate,
        ...(position.stationId ? { stationId: position.stationId } : {}),
        ...(position.sliceId ? { incomingSliceId: position.sliceId } : {}),
        ...sampleSquare(vrt, position.coordinate)
      }))
    }));
    const artifact = {
      formatVersion: 1,
      sourceId: 'copernicus-dem-glo90',
      geometryId: geometry.id,
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
    console.log('Sampled ' + corridors.reduce((sum, corridor) => sum + corridor.positions.length, 0) +
      ' route tiles from Copernicus GLO-90 to ' + path.relative(root, target));
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
