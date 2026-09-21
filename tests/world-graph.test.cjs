const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { loadGame } = require('./helpers.cjs');
const { normalizeGeoJson } = require('../scripts/world/import-osm-geojson.cjs');

const root = path.resolve(__dirname, '..');

test('compiled world artifacts are deterministic and current', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['scripts/world/compile-world.cjs', '--check'], {
    cwd: root,
    stdio: 'pipe'
  }));
});

test('world graph loads all regional chunks without entering save state', () => {
  const game = loadGame();
  const graph = game.setup.worldGraph;
  const stats = graph.getStats();
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), {
    datasetVersion: 'sa-spike-0.2.0',
    regionCount: 24,
    nodeCount: 35,
    linkCount: 40,
    corridorCount: 3,
    railGeometrySetCount: 1,
    railWayCount: 1553,
    railCoordinateCount: 20297
  });
  assert.equal(graph.loadAll(), true);
  assert.equal(graph.getNode('cl-punta-arenas').name, 'Punta Arenas');
  assert.equal(graph.getNode('pa-panama-city').name, 'Panama City');
  assert.equal(JSON.stringify(game.State.variables).includes('sa-spike-0.2.0'), false);
});

test('prototype routes remain explicitly non-navigable planning links', () => {
  const { setup } = loadGame();
  const graph = setup.worldGraph;
  const data = graph.getData();
  const seenNodes = new Set();
  const seenLinks = new Set();
  for (const region of data.regions) {
    const chunk = graph.loadRegion(region.id);
    assert.equal(chunk.nodes.length, region.nodeCount);
    assert.equal(chunk.portals.length, region.portalCount);
    assert.equal(chunk.links.length, region.linkCount);
	const resolvable = new Set(chunk.nodes.concat(chunk.portals).map(node => node.id));
    chunk.nodes.forEach(node => {
      assert.equal(seenNodes.has(node.id), false);
      seenNodes.add(node.id);
    });
    chunk.links.forEach(link => {
      assert.equal(seenLinks.has(link.id), false);
      seenLinks.add(link.id);
      assert.equal(link.status, 'planning');
      assert.equal(link.navigable, false);
      assert.equal(link.reviewRequired, true);
      assert.equal(link.geometrySource, 'authored-waypoint-chord');
      assert.equal(link.estimatedSlices, Math.ceil(link.distanceKm / data.tileKm));
	  assert.equal(resolvable.has(link.from) && resolvable.has(link.to), true);
    });
  }
  assert.equal(seenNodes.size, 35);
  assert.equal(seenLinks.size, 40);
});

test('three authored Punta Arenas to Panama corridors are independently queryable', () => {
  const { setup } = loadGame();
  const graph = setup.worldGraph;
  const routes = ['pacific', 'central-amazon', 'atlantic'].map(id => graph.getCorridorRoute(id));
  routes.forEach(route => {
    assert.equal(route.waypoints[0].id, 'cl-punta-arenas');
    assert.equal(route.waypoints.at(-1).id, 'pa-panama-city');
    assert.equal(route.links.length, route.waypoints.length - 1);
    assert.equal(route.navigable, false);
  });
  assert.notDeepEqual(routes[0].waypoints.map(node => node.id), routes[1].waypoints.map(node => node.id));
  assert.notDeepEqual(routes[1].waypoints.map(node => node.id), routes[2].waypoints.map(node => node.id));
  assert.deepEqual(JSON.parse(JSON.stringify(graph.getAttributions())), [
    'City names, coordinates and population: GeoNames (https://www.geonames.org/)',
    '© OpenStreetMap contributors; extract provided by Geofabrik'
  ]);
});

test('OSM importer retains provenance and operational tags while refusing navigation', () => {
  const geometry = normalizeGeoJson({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { '@id': 42, railway: 'rail', usage: 'main', gauge: 1676, bridge: 'yes' },
      geometry: { type: 'LineString', coordinates: [[-71.5, -33.1], [-71.4, -33.05], [-71.4, -33.05]] } },
    { type: 'Feature', properties: { '@id': 43, railway: 'abandoned', name: 'Old line' },
      geometry: { type: 'LineString', coordinates: [[-71.4, -33.05], [-71.3, -33.0]] } },
    { type: 'Feature', properties: { '@id': 44, railway: 'subway' },
      geometry: { type: 'LineString', coordinates: [[-71, -33], [-70.9, -33]] } }
  ] }, { id: 'fixture', label: 'Fixture', sourceId: 'osm-fixture', sourceInputSha256: 'abc' });
  assert.equal(geometry.stats.wayCount, 2);
  assert.equal(geometry.stats.coordinateCount, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(geometry.stats.statusCounts)), { abandoned: 1, current: 1 });
  assert.equal(geometry.ways[0].coordinates.length, 2, 'consecutive duplicate coordinates are removed');
  assert.deepEqual(JSON.parse(JSON.stringify(geometry.ways[0].tags)), { usage: 'main', gauge: '1676', bridge: 'yes' });
  geometry.ways.forEach(way => {
    assert.equal(way.navigable, false);
    assert.equal(way.reviewRequired, true);
  });
});

test('central Chile pilot geometry is sourced, bounded and internally consistent', () => {
  const geometry = JSON.parse(require('node:fs').readFileSync(path.join(root, 'world/imported/chile-central-rail.json'), 'utf8'));
  assert.equal(geometry.id, 'chile-central-pilot');
  assert.equal(geometry.sourceId, 'openstreetmap-geofabrik-2026-09-20');
  assert.equal(geometry.stats.wayCount, geometry.ways.length);
  assert.equal(geometry.ways.reduce((sum, way) => sum + way.coordinates.length, 0), geometry.stats.coordinateCount);
  assert.deepEqual(JSON.parse(JSON.stringify(geometry.bounds)), [-71.636144, -34.0204701, -70.0186352, -32.449901]);
  assert.equal(new Set(geometry.ways.map(way => way.id)).size, geometry.ways.length);
  assert.ok(geometry.ways.some(way => way.tags.name === 'Línea Central Sur'));
  assert.ok(geometry.ways.every(way => way.navigable === false && way.reviewRequired === true));
});
