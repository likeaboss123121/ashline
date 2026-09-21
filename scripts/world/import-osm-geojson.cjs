const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const allowedRailway = new Set(['rail', 'narrow_gauge', 'light_rail', 'disused', 'abandoned', 'razed', 'preserved', 'construction']);
const retainedTags = ['name', 'usage', 'service', 'gauge', 'electrified', 'tracks', 'bridge', 'tunnel', 'operator', 'maxspeed'];
const retainedPointRailway = new Set(['station', 'halt', 'stop', 'switch', 'junction', 'buffer_stop']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundCoordinate(value) {
  return Math.round(Number(value) * 1e7) / 1e7;
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeA = radians(a[1]);
  const latitudeB = radians(b[1]);
  const deltaLatitude = radians(b[1] - a[1]);
  const deltaLongitude = radians(b[0] - a[0]);
  const h = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function railwayStatus(railway) {
  if (railway === 'disused' || railway === 'abandoned' || railway === 'razed' || railway === 'construction') return railway;
  return 'current';
}

function formatJson(value) {
  // Coordinate pairs dominate GIS diffs. Keep each pair on one line while leaving records and tags reviewable.
  return (JSON.stringify(value, null, 2).replace(/\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]/g, '[$1, $2]') + '\n');
}

function normalizeGeoJson(input, options) {
  assert(input && input.type === 'FeatureCollection' && Array.isArray(input.features), 'Input must be a GeoJSON FeatureCollection');
  assert(options && options.id && options.sourceId, 'Import ID and source ID are required');
  const ways = [];
  const points = [];
  const seenIds = new Set();
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const statusCounts = {};

  input.features.forEach(feature => {
    if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') return;
    const properties = feature.properties || {};
    if (!allowedRailway.has(properties.railway)) return;
    const osmWayId = Number(properties['@id']);
    assert(Number.isSafeInteger(osmWayId) && osmWayId > 0, 'Railway LineString has no valid OSM way ID');
    const id = 'osm-way:' + osmWayId;
    assert(!seenIds.has(id), 'Duplicate OSM way: ' + id);
    seenIds.add(id);
    const coordinates = [];
    feature.geometry.coordinates.forEach(coordinate => {
      assert(Array.isArray(coordinate) && coordinate.length >= 2, 'Invalid coordinate in ' + id);
      const normalized = [roundCoordinate(coordinate[0]), roundCoordinate(coordinate[1])];
      assert(Number.isFinite(normalized[0]) && normalized[0] >= -180 && normalized[0] <= 180, 'Invalid longitude in ' + id);
      assert(Number.isFinite(normalized[1]) && normalized[1] >= -90 && normalized[1] <= 90, 'Invalid latitude in ' + id);
      const previous = coordinates[coordinates.length - 1];
      if (!previous || previous[0] !== normalized[0] || previous[1] !== normalized[1]) coordinates.push(normalized);
    });
    if (coordinates.length < 2) return;
    let lengthKm = 0;
    coordinates.forEach((coordinate, index) => {
      bounds[0] = Math.min(bounds[0], coordinate[0]);
      bounds[1] = Math.min(bounds[1], coordinate[1]);
      bounds[2] = Math.max(bounds[2], coordinate[0]);
      bounds[3] = Math.max(bounds[3], coordinate[1]);
      if (index) lengthKm += haversineKm(coordinates[index - 1], coordinate);
    });
    const tags = {};
    retainedTags.forEach(tag => {
      if (properties[tag] !== undefined && properties[tag] !== '') tags[tag] = String(properties[tag]);
    });
    const status = railwayStatus(properties.railway);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    ways.push({
      id,
      sourceFeatureId: String(osmWayId),
      railway: properties.railway,
      railwayStatus: status,
      navigable: false,
      reviewRequired: true,
      lengthKm: Math.round(lengthKm * 1000) / 1000,
      tags,
      coordinates
    });
  });

  input.features.forEach(feature => {
    if (!feature || !feature.geometry || feature.geometry.type !== 'Point') return;
    const properties = feature.properties || {};
    if (!retainedPointRailway.has(properties.railway)) return;
    const osmNodeId = Number(properties['@id']);
    assert(Number.isSafeInteger(osmNodeId) && osmNodeId > 0, 'Railway Point has no valid OSM node ID');
    const coordinate = feature.geometry.coordinates;
    assert(Array.isArray(coordinate) && coordinate.length >= 2, 'Invalid railway point coordinate');
    const tags = {};
    ['name', 'ref', 'operator', 'public_transport'].forEach(tag => {
      if (properties[tag] !== undefined && properties[tag] !== '') tags[tag] = String(properties[tag]);
    });
    points.push({
      id: 'osm-node:' + osmNodeId,
      sourceFeatureId: String(osmNodeId),
      railway: properties.railway,
      coordinates: [roundCoordinate(coordinate[0]), roundCoordinate(coordinate[1])],
      tags
    });
  });

  ways.sort((a, b) => Number(a.sourceFeatureId) - Number(b.sourceFeatureId));
  points.sort((a, b) => Number(a.sourceFeatureId) - Number(b.sourceFeatureId));
  assert(ways.length > 0, 'No accepted railway LineStrings found');
  return {
    formatVersion: 1,
    id: options.id,
    label: options.label || options.id,
    sourceId: options.sourceId,
    sourceSnapshotSha256: options.sourceSnapshotSha256 || '',
    sourceInputSha256: options.sourceInputSha256 || '',
    bounds: bounds.map(roundCoordinate),
    geometrySource: 'openstreetmap-way',
    navigable: false,
    reviewRequired: true,
    stats: {
      wayCount: ways.length,
      pointCount: points.length,
      coordinateCount: ways.reduce((total, way) => total + way.coordinates.length, 0),
      lengthKm: Math.round(ways.reduce((total, way) => total + way.lengthKm, 0) * 10) / 10,
      statusCounts: Object.fromEntries(Object.entries(statusCounts).sort(([a], [b]) => a.localeCompare(b)))
    },
    ways,
    points
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected argument: ' + argument);
    const key = argument.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    values[key] = value;
  }
  ['input', 'output', 'id', 'label', 'source-id'].forEach(key => assert(values[key], '--' + key + ' is required'));
  return values;
}

function run(argv) {
  const args = parseArguments(argv);
  const inputPath = path.resolve(root, args.input);
  const bytes = fs.readFileSync(inputPath);
  const input = JSON.parse(bytes.toString('utf8'));
  const normalized = normalizeGeoJson(input, {
    id: args.id,
    label: args.label,
    sourceId: args['source-id'],
    sourceInputSha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
  const outputPath = path.resolve(root, args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, formatJson(normalized));
  console.log('Imported ' + normalized.label + ': ' + normalized.stats.wayCount + ' ways, ' +
    normalized.stats.pointCount + ' railway points, ' + normalized.stats.coordinateCount.toLocaleString('en-US') + ' coordinates, ' +
    normalized.stats.lengthKm.toLocaleString('en-US') + ' km');
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { formatJson, normalizeGeoJson, railwayStatus };
