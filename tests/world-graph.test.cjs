const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { loadGame } = require('./helpers.cjs');
const { normalizeGeoJson } = require('../scripts/world/import-osm-geojson.cjs');
const { buildTopology } = require('../scripts/world/build-rail-topology.cjs');

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
    railWayCount: 1581,
    railCoordinateCount: 21391,
    playableRailCorridorCount: 1
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
    '© OpenStreetMap contributors; extract provided by Geofabrik',
    'Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved'
  ]);
});

test('OSM importer retains provenance and operational tags while refusing navigation', () => {
  const geometry = normalizeGeoJson({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { '@id': 42, railway: 'rail', usage: 'main', gauge: 1676, bridge: 'yes' },
      geometry: { type: 'LineString', coordinates: [[-71.5, -33.1], [-71.4, -33.05], [-71.4, -33.05]] } },
    { type: 'Feature', properties: { '@id': 43, railway: 'abandoned', name: 'Old line' },
      geometry: { type: 'LineString', coordinates: [[-71.4, -33.05], [-71.3, -33.0]] } },
    { type: 'Feature', properties: { '@id': 44, railway: 'subway' },
      geometry: { type: 'LineString', coordinates: [[-71, -33], [-70.9, -33]] } },
    { type: 'Feature', properties: { '@id': 46, railway: 'proposed', name: 'Future line' },
      geometry: { type: 'LineString', coordinates: [[-71.3, -33], [-71.2, -33]] } },
    { type: 'Feature', properties: { '@id': 47, 'abandoned:railway': 'rail', name: 'Namespaced old line' },
      geometry: { type: 'LineString', coordinates: [[-71.2, -33], [-71.1, -33]] } },
    { type: 'Feature', properties: { '@id': 45, railway: 'station', name: 'Test Station' },
      geometry: { type: 'Point', coordinates: [-71.4, -33.05] } }
  ] }, { id: 'fixture', label: 'Fixture', sourceId: 'osm-fixture', sourceInputSha256: 'abc' });
  assert.equal(geometry.stats.wayCount, 4);
  assert.equal(geometry.stats.coordinateCount, 8);
  assert.equal(geometry.stats.pointCount, 1);
  assert.equal(geometry.points[0].tags.name, 'Test Station');
  assert.deepEqual(JSON.parse(JSON.stringify(geometry.stats.statusCounts)), { abandoned: 2, current: 1, proposed: 1 });
  assert.equal(geometry.ways[0].coordinates.length, 2, 'consecutive duplicate coordinates are removed');
  assert.deepEqual(JSON.parse(JSON.stringify(geometry.ways[0].tags)), { usage: 'main', gauge: '1676', bridge: 'yes' });
  geometry.ways.forEach(way => {
    assert.equal(way.navigable, false);
    assert.equal(way.reviewRequired, true);
  });
  const importedGraph = require('../scripts/world/build-rail-topology.cjs').buildCoordinateGraph(geometry);
  assert.equal(importedGraph.segments.length, 4, 'all railway lifecycle statuses are mechanically routable');
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

test('authored Chile rail topology follows connected OSM track in five-kilometre slices', () => {
  const fs = require('node:fs');
  const geometry = JSON.parse(fs.readFileSync(path.join(root, 'world/imported/chile-central-rail.json'), 'utf8'));
  const authored = JSON.parse(fs.readFileSync(path.join(root, 'world/authored/playable-corridors.json'), 'utf8'));
  const topology = buildTopology(geometry, authored);
  const corridor = topology.corridors[0];
  assert.deepEqual(corridor.stations.map(station => station.name),
    ['Padre Hurtado', 'Malloco', 'Talagante', 'El Monte', 'Melipilla']);
  assert.equal(corridor.debugOnly, false);
  assert.equal(corridor.navigable, true);
  assert.equal(corridor.sliceCount, 11);
  assert.equal(corridor.gridSliceCount, 9);
  assert.equal(corridor.distanceKm, 42);
  const knownWays = new Set(geometry.ways.map(way => way.id));
  corridor.legs.forEach(leg => {
    let previousEnd = null;
    leg.slices.forEach(slice => {
      assert.ok(slice.distanceKm > 0 && slice.distanceKm <= 5.001);
      assert.ok(slice.sourceWayIds.every(id => knownWays.has(id)));
      if (previousEnd) assert.deepEqual(slice.coordinates[0], previousEnd);
      previousEnd = slice.coordinates.at(-1);
    });
    assert.ok(Math.abs(leg.slices.reduce((sum, slice) => sum + slice.distanceKm, 0) - leg.distanceKm) < 0.01);
  });
  assert.equal(corridor.gridSlices.slice(0, -1).every(slice => slice.distanceKm === 5), true);
  assert.ok(corridor.gridSlices.at(-1).distanceKm > 0 && corridor.gridSlices.at(-1).distanceKm < 5);
  assert.deepEqual(topology, buildTopology(geometry, authored), 'topology compilation is deterministic');
});

test('the sourced grid is the default playable world without copying static data into saves', () => {
  const game = loadGame();
  game.State.variables.debugMode = true;
  game.State.variables.currentTrain = [{ type: 'test locomotive', length: 10, cargo: [], inventory: [], topSpeedKmh: 60 }];
  const train = game.State.variables.currentTrain;
  assert.equal(game.setup.realWorldPilot.start('cl-padre-hurtado-melipilla'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(game.State.variables.journey)),
    { legIndex: 1, tileIndex: 0, forward: true });
  const route = game.setup.realWorldPilot.getGridRoute('cl-padre-hurtado-melipilla');
  assert.equal(route.tiles.length, 9);
  assert.ok(route.slices.every(slice => slice.distanceKm === 5));
  assert.deepEqual(JSON.parse(JSON.stringify(route.stationPositions)), [0, 1, 3, 4, 8]);
  assert.ok(route.tiles.every(tile => Number.isFinite(tile.elevation) && Number.isFinite(tile.elevationStdDevM)));
  assert.ok(route.tiles.every(tile => tile.terrain === 'plains' || tile.terrain === 'bridge' || tile.terrain === 'tunnel'));
  assert.equal(route.tiles[0].elevation, 436.2);
  assert.equal(route.tiles[0].elevationStdDevM, 15);
  assert.equal(route.tiles[0].grade, -0.5);
  assert.equal(game.setup.realWorldPilot.terrainFor({ bridge: false, tunnel: false },
    { meanElevationM: 3000, elevationStdDevM: 20 }, 120), 'plains', 'high and flat is not mountainous');
  assert.equal(game.setup.realWorldPilot.terrainFor({ bridge: false, tunnel: false },
    { meanElevationM: 200, elevationStdDevM: 180 }, 120), 'mountain', 'ruggedness is independent of altitude');
  game.State.variables.journey = { legIndex: 2, tileIndex: 0, forward: true };
  const step = game.setup.worldmap.getJourneyStep(1);
  assert.equal(step.distanceKm, 5);
  assert.equal(game.setup.railyard.moveAlongLine(1), true);
  assert.equal(game.State.variables.journey.tileIndex, 1);
  assert.equal(game.State.variables.currentTrain, train);
  assert.equal(game.setup.onfoot.climbDown(), true);
  assert.equal(game.setup.onfoot.getTile().elevation, route.tiles[2].elevation);
  assert.equal(game.setup.onfoot.walk(-1), true);
  assert.equal(game.State.variables.onFoot.tileIndex, 0);
  assert.equal(game.State.variables.journey.tileIndex, 1, 'walking does not move the consist');
  assert.equal(game.setup.onfoot.walk(1), true);
  assert.equal(game.setup.onfoot.climbAboard(), true);
  assert.equal(JSON.stringify(game.State.variables).includes('sourceWayIds'), false);
  assert.equal(game.setup.realWorldPilot.finish(), true);
  assert.equal(game.State.variables.journey, null);
});
