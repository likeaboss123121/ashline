const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { loadGame } = require('./helpers.cjs');
const { normalizeGeoJson } = require('../scripts/world/import-osm-geojson.cjs');
const { buildCoordinateGraph } = require('../scripts/world/rail-graph.cjs');

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
  const { networkSquareCount, networkStopCount, networkRailKm, networkNewLineKm, ...planning } = JSON.parse(JSON.stringify(stats));
  assert.deepEqual(planning, { datasetVersion: 'sa-spike-0.2.0', regionCount: 24, nodeCount: 35, linkCount: 40, corridorCount: 3 });
  assert.ok(networkSquareCount > 20000 && networkStopCount > 3000, JSON.stringify(stats));
  assert.ok(networkRailKm > 100000 && networkNewLineKm > 15000, JSON.stringify(stats));
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
  // Both OSM extracts carry the same attribution line, so it appears once per ingested source.
  assert.deepEqual([...new Set(JSON.parse(JSON.stringify(graph.getAttributions())))], [
    'City names, coordinates and population: GeoNames (https://www.geonames.org/)',
    '© OpenStreetMap contributors; extract provided by Geofabrik',
    '© OpenStreetMap contributors; extracts provided by Geofabrik',
    'Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    'Land outlines made with Natural Earth',
    'Relief made with Natural Earth'
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
  const importedGraph = buildCoordinateGraph(geometry);
  assert.equal(importedGraph.segments.length, 4, 'all railway lifecycle statuses are mechanically routable');
});

test('the sourced grid is the default playable world without copying static data into saves', () => {
  const game = loadGame();
  game.State.variables.debugMode = true;
  game.State.variables.currentTrain = [{ type: 'test locomotive', length: 10, cargo: [], inventory: [], topSpeedKmh: 60 }];
  const train = game.State.variables.currentTrain;
  assert.equal(game.setup.realWorldPilot.DEFAULT_CORRIDOR_ID, 'network');
  assert.equal(game.setup.realWorldPilot.start(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(game.State.variables.journey)),
    { legIndex: 1, tileIndex: 0, forward: true });
  const route = game.setup.realWorldPilot.getGridRoute();
  assert.ok(route.tiles.every(tile => Number.isFinite(tile.elevation) && Number.isFinite(tile.elevationStdDevM)));
  assert.ok(route.tiles.every(tile => ['plains', 'forest', 'desert', 'arctic', 'mountain', 'bridge', 'tunnel'].includes(tile.terrain)));
  assert.equal(game.setup.realWorldPilot.terrainFor({ bridge: false, tunnel: false },
    { meanElevationM: 3000, elevationStdDevM: 20 }, 120), 'plains', 'high and flat is not mountainous');
  assert.equal(game.setup.realWorldPilot.terrainFor({ bridge: false, tunnel: false },
    { meanElevationM: 200, elevationStdDevM: 180 }, 120), 'mountain', 'ruggedness is independent of altitude');
  game.State.variables.journey = { legIndex: 2, tileIndex: 0, forward: true };
  const step = game.setup.worldmap.getJourneyStep(1);
  const firstMove = game.setup.realWorldPilot.getGridRoute().legs[2].tiles[0].distanceKm;
  assert.ok(firstMove > 0);
  assert.equal(step.distanceKm, firstMove, 'a move covers the track between its two squares');
  assert.equal(game.setup.railyard.moveAlongLine(1), true);
  assert.equal(game.State.variables.journey.tileIndex, 1);
  assert.equal(game.State.variables.currentTrain, train);
  assert.equal(game.setup.onfoot.climbDown(), true);
  const main = game.setup.realWorldPilot.getGridRoute();
  assert.equal(game.setup.onfoot.getTile().elevation, main.legs[2].tiles[1].elevation);
  assert.equal(game.setup.onfoot.walk(-1), true);
  assert.equal(game.State.variables.onFoot.tileIndex, 0);
  assert.equal(game.State.variables.journey.tileIndex, 1, 'walking does not move the consist');
  assert.equal(game.setup.onfoot.walk(1), true);
  assert.equal(game.setup.onfoot.climbAboard(), true);
  assert.equal(JSON.stringify(game.State.variables).includes('sourceWayIds'), false);
  assert.equal(game.setup.realWorldPilot.finish(), true);
  assert.equal(game.State.variables.journey, null);
});

// A tiny railway made to exercise the routing stage: two lines with a 20 m digitizing break between them, a 12 km
// gap to a third line, and a far island reachable only by a long gap.
function syntheticGeometry() {
  const way = (id, coordinates, extra = {}) => ({
    id: 'osm-way:' + id, sourceFeatureId: String(id), railway: 'rail', railwayStatus: 'current',
    navigable: false, reviewRequired: true, lengthKm: 0, tags: {}, coordinates, ...extra
  });
  return {
    formatVersion: 1, id: 'synthetic', sourceId: 'test', navigable: false, reviewRequired: true,
    ways: [
      way(1, [[-70.0, -30.0], [-70.0, -30.1], [-70.0, -30.2]]),
      // Starts 20 m south of where way 1 stops: the same line drawn in two pieces.
      way(2, [[-70.0, -30.20018], [-70.0, -30.3], [-70.0, -30.4]]),
      // Starts about 12 km further on: a real break in the network.
      way(3, [[-70.0, -30.51], [-70.0, -30.6], [-70.0, -30.8]], { railwayStatus: 'abandoned' }),
      // An island far to the south.
      way(4, [[-70.0, -33.0], [-70.0, -33.1]])
    ],
    points: [
      { id: 'osm-node:1', railway: 'station', coordinates: [-70.0, -30.0], tags: { name: 'North End' } }
    ]
  };
}
const syntheticPlaces = [
  { id: 'xx-north', countryCode: 'XX', latitude: -30.0, longitude: -70.0 },
  { id: 'xx-middle', countryCode: 'XX', latitude: -30.8, longitude: -70.0 },
  { id: 'xx-south', countryCode: 'XX', latitude: -33.1, longitude: -70.0 }
];
const syntheticCorridor = [
  { corridor_id: 'test', sequence: '1', place_id: 'xx-north' },
  { corridor_id: 'test', sequence: '2', place_id: 'xx-middle' },
  { corridor_id: 'test', sequence: '3', place_id: 'xx-south' }
];

test('planning links are routed over real rail, with breaks snapped and gaps proposed rather than hidden', () => {
  const { routeLinks, GAP_KM } = require('../scripts/world/route-planning-links.cjs');
  process.env.ASHLINE_WORLD_QUIET = '1';
  const result = routeLinks(syntheticGeometry(), syntheticPlaces, syntheticCorridor, 'XX');
  assert.equal(result.snaps, 1, 'the 20 m break is a digitizing break, joined without comment');
  assert.equal(result.links.length, 2);

  const [north, south] = result.links;
  assert.equal(north.id, 'route:xx-north>xx-middle');
  assert.deepEqual([...north.planningLinkIds], ['plan:test:01']);
  assert.equal(north.fromAnchor.kind, 'station');
  assert.equal(north.fromAnchor.name, 'North End');
  // The 12 km break is a short gap: proposed, costed, and reported, but real track carries the rest.
  assert.equal(north.gaps.length, 1);
  assert.equal(north.gaps[0].kind, 'gap');
  assert.ok(north.gaps[0].distanceKm > 11 && north.gaps[0].distanceKm < GAP_KM, JSON.stringify(north.gaps[0]));
  assert.equal(north.status, 'rail-with-gap-proposals');
  assert.ok(Math.abs(north.routedKm - north.railKm - north.gapKm) < 0.2);

  // The island is only reachable by a long gap: the shortest possible new line between the two networks.
  assert.equal(south.gaps.length, 1);
  assert.equal(south.gaps[0].kind, 'long-gap');
  assert.deepEqual([...south.gaps[0].from], [-70, -30.8]);
  assert.deepEqual([...south.gaps[0].to], [-70, -33]);

  // Slices are gameplay-sized, continuous, carry provenance, and never claim to be playable.
  [north, south].forEach(link => {
    assert.equal(link.navigable, false);
    assert.equal(link.reviewRequired, true);
    link.slices.forEach((slice, index) => {
      assert.ok(slice.distanceKm > 0 && slice.distanceKm <= 5.001, slice.id + ' is ' + slice.distanceKm + ' km');
      assert.equal(slice.navigable, false);
      assert.equal(slice.gapFill, slice.gapKm > 0);
      assert.equal(slice.reviewStatus, slice.gapFill ? 'gap-fill-proposal' : 'routed-rail-proposal');
      if (index) assert.deepEqual([...link.slices[index - 1].coordinates.at(-1)], [...slice.coordinates[0]]);
    });
  });
  const statuses = new Set(north.slices.flatMap(slice => slice.railwayStatuses));
  assert.ok(statuses.has('abandoned'), 'lifecycle status survives as provenance');
});

test('the planning corridors are routed over the continent for comparison, and never played', () => {
  const game = loadGame();
  const data = game.setup.worldGraphData;
  const routes = [...data.routedLinks];
  // All three corridors: 40 planning links, 38 distinct pairs of cities.
  assert.equal(routes.length, 38);
  routes.forEach(route => {
    assert.equal(route.proposalSetId, 'south-america-routed-links');
    assert.equal(route.navigable, false);
    assert.equal(route.reviewRequired, true);
    assert.ok(route.runs.length > 0 && route.runs.every(run => run.coordinates.length >= 2));
  });
  // Puerto Montt to Santiago runs almost entirely on mapped rail.
  const south = routes.find(route => route.id === 'route:cl-puerto-montt>cl-santiago');
  assert.ok(south.railKm / south.routedKm > 0.95, JSON.stringify(south));
  // Every chunked planning link knows which route replaced it.
  const links = Object.values(data.chunks).flatMap(chunk => [...chunk.links]);
  assert.ok(links.every(link => Array.isArray(link.routedBy) && link.routedBy.length === 1), 'every link routed once');
});

test('a line that ends near other track it only reaches the long way round is joined to it', () => {
  const { stubJoins, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  // Kilometres east and north of a point in the Argentine pampas, as longitude and latitude.
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  const add = (id, points) => network.add(traceLine(points.map(point => at(...point)), grid, {}),
    { id, status: 'current', bridgeShare: 0, tunnelShare: 0 });
  add('main', [[0, 0], [0, 100]]);
  // A branch that leaves the main line, swings out and runs back up beside it, ending 15 km short of it at 80 km.
  add('branch', [[0, 0], [15, 0], [15, 80]]);
  // A short spur off the main line, ending 7 km from the branch: the way round to the branch is long, the way back
  // to its own main line is not.
  add('spur', [[0, 50], [8, 50]]);
  const joins = stubJoins(network, grid);
  const endOf = point => network.squares.get(projection.cellOf(at(...point), grid).join(',')).key;
  const pairs = joins.map(join => [join.from, join.to].sort().join(' '));
  // The branch's end reaches back to the main line; the spur's end reaches across to the branch.
  assert.ok(joins.some(join => join.from === endOf([15, 80]) && network.squares.get(join.to).x === network.squares.get(endOf([0, 80])).x),
    JSON.stringify(joins));
  assert.ok(joins.some(join => join.from === endOf([8, 50]) && Math.abs(network.squares.get(join.to).x - network.squares.get(endOf([15, 50])).x) <= 1),
    JSON.stringify(joins));
  // The main line's far end is 25 km from the branch's end, and was the long way round from it; once the branch has
  // been joined back to the main line it no longer is, so no second join closes a small loop.
  assert.ok(!joins.some(join => join.from === endOf([0, 100]) || join.to === endOf([0, 100])), JSON.stringify(joins));
  assert.equal(joins.length, 2, JSON.stringify(joins));
  assert.equal(new Set(pairs).size, pairs.length, 'each join is made once');
});

test('two line ends that face each other across a gap are joined when the way round is many times as far', () => {
  const { endJoins, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  const add = (id, points) => network.add(traceLine(points.map(point => at(...point)), grid, {}),
    { id, status: 'current', bridgeShare: 0, tunnelShare: 0 });
  // A long loop whose two ends stop 100 km apart: the way round is over 1,000 km.
  add('loop', [[0, 0], [0, 500], [100, 500], [100, 0]]);
  // A short hook whose ends are 100 km apart but only 300 km round: not worth a new line.
  add('hook', [[300, 0], [300, 100], [400, 100], [400, 0]]);
  const planned = [];
  const joins = endJoins(network, grid, join => { planned.push(join); return join; });
  const cellAt = point => projection.cellOf(at(...point), grid).join(',');
  assert.equal(joins.length, 1, JSON.stringify(joins));
  assert.deepEqual([joins[0].from, joins[0].to].sort(), [cellAt([0, 0]), cellAt([100, 0])].sort());
  // A join the plan turns down (over water, say) is not made.
  assert.equal(endJoins(network, grid, () => null).length, 0);
});

test('a bare rural line sends spurs out to the places off it, spaced apart, skipping generic names', () => {
  const { spurs, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  network.add(traceLine([at(0, 0), at(0, 600)], grid, {}), { id: 'main', status: 'current', bridgeShare: 0, tunnelShare: 0 });
  const place = (id, name, kind, east, north) => ({ id, name, kind, coordinates: at(east, north) });
  const places = [
    place('a', 'Estancia La Rosa', 'isolated_dwelling', 20, 300),
    place('b', 'Villa Chica', 'village', 25, 330), // bigger, so it wins the stretch; La Rosa is then too close along it
    place('c', 'Puesto Norte', 'hamlet', 15, 480),
    place('d', 'Too Close', 'hamlet', 5, 150), // within reach of the track already
    place('e', 'Too Far', 'village', 60, 200)
  ].concat(Array.from({ length: 25 }, (_, index) => place('g' + index, 'Estancia', 'isolated_dwelling', 30, 100 + index)));
  const laid = spurs(network, grid, places, () => 'rural', join => join);
  assert.deepEqual(laid.map(spur => spur.place.name).sort(), ['Puesto Norte', 'Villa Chica']);
  // Nothing in a town or a works district.
  assert.equal(spurs(network, grid, places, () => 'urban', join => join).length, 0);
  // Planning ahead is shown the spurs before they are laid, and the same ones are laid.
  const shown = [];
  const ahead = spurs(network, grid, places, () => 'rural', join => join, null, joins => shown.push(...joins));
  assert.deepEqual(ahead.map(spur => spur.place.name), laid.map(spur => spur.place.name));
  laid.forEach(spur => assert.ok(shown.some(join => join.to === spur.square), spur.place.name + ' was planned ahead'));
});

test('a city\'s maze of track is reduced to a hub and the lines into it', () => {
  const { simplifyUrban, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  const add = (id, points) => network.add(traceLine(points.map(point => at(...point)), grid, {}),
    { id, status: 'current', bridgeShare: 0, tunnelShare: 0 });
  // A lattice of suburban lines 40 km across, every 10 km, with four main lines running out of it into the country.
  for (let line = 0; line <= 40; line += 10) { add('ew' + line, [[0, line], [40, line]]); add('ns' + line, [[line, 0], [line, 40]]); }
  add('north', [[20, 40], [20, 200]]); add('south', [[20, 0], [20, -200]]);
  add('east', [[40, 20], [200, 20]]); add('west', [[0, 20], [-200, 20]]);
  const inCity = point => { const [x, y] = [point[0], point[1]]; const sw = at(-3, -3), ne = at(43, 43); return x >= sw[0] && x <= ne[0] && y >= sw[1] && y <= ne[1]; };
  const regionOf = point => inCity(point) ? 'urban' : 'rural';
  regionOf.peopleAt = point => inCity(point) ? 1e6 : 0;
  const hub = projection.cellOf(at(20, 20), grid).join(',');
  const junctions = () => Array.from(network.neighbours().entries()).filter(([key, next]) => next.length > 2 && inCity(projection.centreOf(key.split(',').map(Number), grid))).length;
  const before = junctions();
  const result = simplifyUrban(network, grid, regionOf, new Set([hub]));
  assert.equal(result.areas, 1);
  assert.ok(result.squares > 20, JSON.stringify(result));
  assert.ok(junctions() < before / 4, before + ' junctions before, ' + junctions() + ' after');
  // Every main line still reaches every other, through the hub.
  const pieces = network.pieces();
  assert.equal(pieces.length, 1);
  const far = [[20, 200], [20, -200], [200, 20], [-200, 20]].map(point => projection.cellOf(at(...point), grid).join(','));
  far.forEach(key => assert.ok(network.squares.has(key), key));
});

test('an authored route names its stops by place, by coordinates, or by place near a point', () => {
  const { placeIndex, resolveRoute } = require('../scripts/world/build-network.cjs');
  const index = placeIndex([{ name: 'Punta Arenas', longitude: -70.9, latitude: -53.16 }], [
    { name: 'Humaitá', kind: 'town', population: 57000, coordinates: [-63.02, -7.51] },
    { name: 'Humaitá', kind: 'village', coordinates: [-42.71, -5.17] },
    { name: 'San José', kind: 'town', coordinates: [-60, -30] },
    { name: 'San José', kind: 'town', coordinates: [-70, -10] }
  ]);
  const stops = resolveRoute({ route: ['punta arenas', 'Humaita', [-61, -6], { name: 'San José', near: [-69, -11] }] }, index);
  assert.deepEqual(stops, [
    { name: 'Punta Arenas', coordinates: [-70.9, -53.16] },
    { name: 'Humaitá', coordinates: [-63.02, -7.51] },
    { name: null, coordinates: [-61, -6] },
    { name: 'San José', coordinates: [-70, -10] }
  ]);
  // Two towns of one name far apart: the route has to say which.
  assert.throws(() => resolveRoute({ route: ['Punta Arenas', 'San José'] }, index), /could be any of .*"near"/);
  assert.throws(() => resolveRoute({ route: ['Punta Arenas', 'Atlantis'] }, index), /no place called "Atlantis"/);
  // The older two-point form still reads.
  assert.equal(resolveRoute({ from: [-70, -50], to: [-71, -51] }, index).length, 2);
  // A named point that is not a mapped place, and a stop reached through a tunnel.
  assert.deepEqual(resolveRoute({ route: ['Punta Arenas', { name: 'Cape Froward', coordinates: [-71.3, -53.9] },
    { name: 'Humaita', tunnel: true }] }, index), [
    { name: 'Punta Arenas', coordinates: [-70.9, -53.16] },
    { name: 'Cape Froward', coordinates: [-71.3, -53.9] },
    { name: 'Humaitá', coordinates: [-63.02, -7.51], tunnel: true }
  ]);
});

test('a route stop marked as a tunnel is reached straight, under the sea, in tunnel squares', () => {
  const { planLine, addLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = { ...projection.GRID, centre: [40, 37.5], origin: [-168.09035, 65.60829] };
  const cell = point => projection.cellOf(point, grid).join(',');
  // Uelen to Wales by the Diomedes: every hop a tunnel, so nothing is routed over the terrain.
  const line = planLine({ from: cell([-169.817, 66.16053]), to: cell([-168.09035, 65.60829]), kind: 'authored', toTunnel: true,
    through: [{ name: 'Big Diomede', coordinates: projection.pointInFrame([-169.06, 65.78], grid), tunnel: true }] },
  { grid, settlements: [], cache: null, network: null });
  assert.equal(line.planned, true);
  assert.equal(line.waterKm, 0);
  assert.ok(line.tunnelKm > 80 && line.tunnelKm < 120, line.tunnelKm + ' km of tunnel');
  assert.deepEqual(line.via, ['Big Diomede']);
  const network = new Network();
  addLine(network, line);
  // Wales is square (0, 0) of this grid, and the squares of the crossing hold their new track in the tunnel.
  assert.ok(network.squares.has('0,0'));
  const squares = Array.from(network.squares.values());
  const underground = squares.filter(square => (square.tunnelGapKm || 0) >= square.gapKm * 0.5);
  assert.ok(underground.length >= squares.length - 2, underground.length + ' of ' + squares.length + ' squares in the tunnel');
});

test('longitudes are kept in each grid\'s frame, so Chukotka lies east of the 180th meridian in Asia\'s', () => {
  const projection = require('../scripts/world/projection.cjs');
  const { copernicusTileName } = require('../scripts/world/dem.cjs');
  const asia = { ...projection.GRID, centre: [40, 37.5] };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' is not ' + expected);
  near(projection.inFrame(-169.8, asia), 190.2);
  near(projection.inFrame(18.4, asia), 18.4);
  // The Americas' frame leaves their longitudes as they are.
  near(projection.inFrame(-168.1, { ...projection.GRID, centre: [-102.5, 10] }), -168.1);
  assert.equal(copernicusTileName(190.2, 66.1), copernicusTileName(-169.8, 66.1));
  assert.equal(copernicusTileName(190.2, 66.1), 'Copernicus_DSM_COG_30_N66_00_W170_00_DEM');
  // A square's centre comes back in the frame too: west of the meridian, then east of it.
  const across = projection.centreOf(projection.cellOf([190.2, 66.1], asia), asia);
  assert.ok(Math.abs(across[0] - 190.2) < 0.2, across.join(','));
});

test('place and station names are given in the Latin alphabet', () => {
  const { displayName } = require('../scripts/world/names.cjs');
  assert.deepEqual(displayName({ name: 'München', 'name:en': 'Munich' }), { name: 'München', from: 'name' });
  assert.deepEqual(displayName({ name: 'Москва', 'name:en': 'Moscow' }), { name: 'Moscow', from: 'name:en' });
  assert.deepEqual(displayName({ name: '北京市', 'name:zh_pinyin': 'Běijīng Shì' }), { name: 'Běijīng Shì', from: 'name:zh_pinyin' });
  assert.deepEqual(displayName({ name: 'Комсомольск-на-Амуре' }), { name: 'Komsomolsk-na-Amure', from: 'transliterated' });
  assert.equal(displayName({ name: '北京' }).name, 'Beijing');
  assert.equal(displayName({}), null);
});

test('world files are read a record to a line, the same as a whole-file parse', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { readRecords } = require('../scripts/world/records.cjs');
  const value = { id: 'test', stats: { count: 2 }, bounds: [1, 2],
    places: [{ name: 'Uelen', coordinates: [-169.8, 66.2] }, { name: 'Ёлкино — «ёлка»', coordinates: [30, 60] }], empty: [] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-records-')), 'places.json');
  fs.writeFileSync(file, '{\n  "id": "test",\n  "stats": {"count":2},\n  "bounds": [1, 2],\n  "places": [\n'
    + value.places.map(place => '    ' + JSON.stringify(place)).join(',\n') + '\n  ],\n  "empty": [\n\n  ]\n}\n');
  assert.deepEqual(readRecords(file), value);
  assert.deepEqual(readRecords(file), JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('two networks on grids of their own are joined into one where both have a stop', () => {
  const { joinNetworks, validateNetwork } = require('../scripts/world/compile-world.cjs');
  const square = (x, y, ends) => ({ x, y, elevationM: 0, elevationStdDevM: 0, ends: ends.map(([dx, dy]) => ({ dx, dy, km: 5 })) });
  const network = (id, squares, stops, start) => ({ formatVersion: 1, id, label: id, grid: { centre: [0, 0] }, sources: {},
    parameters: {}, stats: { squareCount: squares.length, stopCount: stops.length, spurCount: 1 }, startSquare: start, squares, stops, points: [] });
  // The Americas end at Wales, square (-2, 3), coming up from the south; Asia's grid has Wales at (0, 0) with its line
  // going west.
  const americas = network('americas-network', [square(-2, 1, [[0, 1]]), square(-2, 2, [[0, -1], [0, 1]]), square(-2, 3, [[0, -1]])], [
    { id: 'place:start', name: 'Start', square: '-2,1', coordinates: [0, 0] },
    { id: 'authored-end:-2,3', name: 'Wales', square: '-2,3', coordinates: [-168.09035, 65.60829] }], '-2,1');
  const asia = network('afro-eurasia-network', [square(-3, 0, [[1, 0]]), square(-2, 0, [[-1, 0], [1, 0]]), square(-1, 0, [[-1, 0], [1, 0]]),
    square(0, 0, [[-1, 0]])], [
    { id: 'halt:-3,0', name: 'Uelen', square: '-3,0', coordinates: [190.2, 66.2] },
    { id: 'authored-end:0,0', name: 'Wales', square: '0,0', coordinates: [191.90965, 65.60829] }], '-3,0');
  const world = joinNetworks(americas, asia, { coordinates: [-168.09035, 65.60829] });
  validateNetwork(world);
  // Wales is one station with a line each way, and a station is straight: Asia's line is brought in from the north,
  // opposite the Americas', its own Wales square left out and the rest moved by the offset; its halt is renamed for
  // the square it moved to.
  assert.equal(world.squares.length, 6);
  assert.deepEqual(world.squares.find(s => s.x === -2 && s.y === 3).ends.map(end => [end.dx, end.dy]), [[0, -1], [0, 1]]);
  assert.deepEqual(world.squares.find(s => s.x === -2 && s.y === 4).ends.map(end => [end.dx, end.dy]), [[-1, 0], [0, -1]]);
  assert.deepEqual(world.stops.map(stop => stop.id), ['place:start', 'authored-end:-2,3', 'halt:-4,4']);
  assert.deepEqual(world.charts.map(chart => [chart.id, chart.offset, chart.count]),
    [['americas-network', [0, 0], 3], ['afro-eurasia-network', [-1, 4], 3]]);
  assert.equal(world.stats.spurCount, 2);
  // Grids that would lay squares on each other are refused, and turned half round, the same grid lies clear.
  const clash = () => network('afro-eurasia-network', [square(0, -2, [[0, 1]]), square(0, -1, [[0, -1], [0, 1]]), square(0, 0, [[0, -1]])], [
    { id: 'halt:0,-2', name: 'Uelen', square: '0,-2', coordinates: [190.2, 66.2] },
    { id: 'authored-end:0,0', name: 'Wales', square: '0,0', coordinates: [191.90965, 65.60829] }], '0,-2');
  assert.throws(() => joinNetworks(americas, clash(), { coordinates: [-168.09035, 65.60829] }), /overlap|same way/);
  const turned = joinNetworks(americas, clash(), { coordinates: [-168.09035, 65.60829], turn: 2 });
  validateNetwork(turned);
  assert.deepEqual(turned.squares.map(s => [s.x, s.y, s.ends.map(end => [end.dx, end.dy])]).sort((a, b) => a[1] - b[1]),
    [[-2, 1, [[0, 1]]], [-2, 2, [[0, -1], [0, 1]]], [-2, 3, [[0, -1], [0, 1]]], [-2, 4, [[0, -1], [0, 1]]], [-2, 5, [[0, -1]]]]);
  assert.deepEqual(turned.stops.map(stop => stop.id), ['place:start', 'authored-end:-2,3', 'halt:-2,5']);
  assert.deepEqual(turned.charts[1].turn, 2);
});

test('the game finds the place of a square on a grid turned and moved to join another', () => {
  const projection = require('../scripts/world/projection.cjs');
  const { setup } = loadGame();
  const asia = { ...projection.GRID, centre: [40, 37.5], origin: [-168.09035, 65.60829] };
  // As the compiler lays it: turned half round about Wales, then moved so Wales lands on the Americas' Wales.
  const joined = { ...asia, offset: [-1073, 2710], turn: 2 };
  for (const point of [[18.42322, -33.92584], [37.61781, 55.75204], [-169.817, 66.16053], [141.67, 45.41]]) {
    const [x, y] = projection.cellOf(point, asia), expected = projection.centreOf([x, y], asia);
    const found = setup.worldmap.unprojectGrid(-x - 1073, -y + 2710, joined);
    assert.ok(Math.abs(((found[0] - expected[0]) % 360 + 540) % 360 - 180) < 1e-4 && Math.abs(found[1] - expected[1]) < 1e-4,
      point.join(',') + ': ' + found.join(',') + ' is not ' + expected.join(','));
    assert.ok(found[0] >= -180 && found[0] < 180);
  }
});

test('the generator rules make the connections Likea asked for, and thin the yards in cities', () => {
  const network = require('../world/network/south-america-network.json');
  const adjacent = new Map(network.squares.map(square => [square.x + ',' + square.y,
    square.ends.map(end => [(square.x + end.dx) + ',' + (square.y + end.dy), end.km])]));
  const byTrack = (from, to) => {
    const distance = new Map([[from, 0]]), queue = [[0, from]];
    while (queue.length) {
      queue.sort((a, b) => a[0] - b[0]);
      const [km, key] = queue.shift();
      if (key === to) return km;
      if (km > distance.get(key) || km > 3500) continue;
      adjacent.get(key).forEach(([next, step]) => {
        if (km + step < (distance.get(next) ?? Infinity)) { distance.set(next, km + step); queue.push([km + step, next]); }
      });
    }
    return Infinity;
  };
  // Facing line ends joined: into Chile from Neuquén, Jazpampa to Arica, and Peru into Ecuador.
  assert.ok(byTrack('-49,317', '-28,311') < 300, 'Lonquimay to Los Catutos');
  assert.ok(byTrack('-59,738', '-66,762') < 300, 'Jazpampa to Arica');
  assert.ok(byTrack('-268,978', '-272,1095') < 1200, 'Trujillo to El Cisne');
  // The authored Amazon route, Manaus to Neiva.
  const stop = name => network.stops.find(candidate => candidate.name === name && candidate.status === 'city');
  assert.ok(byTrack(stop('Manaus').square, network.stops.find(candidate => candidate.name === 'Neiva').square) < 3000, 'Manaus to Neiva');
  assert.ok(network.stats.endJoinCount > 10 && network.stats.spurCount > 50, JSON.stringify(network.stats));
  // Every stop has a region, and in the cities a plain station on a through line rarely gets a yard.
  assert.ok(network.stops.every(candidate => ['rural', 'industrial', 'urban'].includes(candidate.region)));
  const urbanThrough = network.stops.filter(candidate => candidate.region === 'urban' && candidate.status !== 'city'
    && adjacent.get(candidate.square).length === 2);
  assert.ok(urbanThrough.length < 50, urbanThrough.length + ' urban through stations');
});

// The nodes from Punta Arenas that reach an authored city, a line at a time: [{ from, line }], or null when it cannot
// be reached.
function wayTo(game, goalName) {
  const pilot = game.setup.realWorldPilot, route = pilot.getGridRoute(), stations = route.corridor.stations;
  const goal = stations.findIndex(station => station.name === goalName && station.status === 'city') + 1;
  if (!goal) return null;
  const startNode = route.nodes[route.stationPositions[0]], goalSquare = route.stationPositions[goal - 1];
  const previous = new Map([[startNode.square, null]]), queue = [startNode];
  for (let head = 0; head < queue.length && !previous.has(goalSquare); head++) {
    const node = queue[head];
    node.lines.forEach(line => {
      const leg = pilot.getLeg(line.legIndex), next = line.forward ? leg.toNode : leg.fromNode;
      if (!previous.has(next.square)) { previous.set(next.square, { from: node, line }); queue.push(next); }
    });
  }
  if (!previous.has(goalSquare)) return null;
  const path = [];
  for (let at = goalSquare; previous.get(at); at = previous.get(at).from.square) path.unshift(previous.get(at));
  return path;
}

// Drives from Punta Arenas to an authored city along wayTo's way, a square at a time, picking the way at each junction
// as a player would. Returns the distance and the junctions passed, and each step's terrain, heading and the station
// it arrives at, if any.
function driveTo(game, goalName) {
  const { setup, State } = game, pilot = setup.realWorldPilot;
  const path = wayTo(game, goalName);
  assert.ok(path, goalName + ' can be reached');
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.currentTrain = [setup.railyard.cloneCar(State.variables.defaultTrains.dieselShunter)];
  State.variables.stationTracks = {};
  State.variables.currentStation = 1;
  let km = 0, junctions = 0;
  const steps = [];
  path.forEach(({ from, line }) => {
    const leg = pilot.getLeg(line.legIndex);
    if (from.kind === 'station') {
      assert.equal(State.variables.currentStation, from.stationIndex);
      State.variables.journey = { legIndex: line.legIndex, tileIndex: line.forward ? 0 : leg.tiles.length - 1, forward: line.forward };
    } else {
      // Standing at the junction, the chosen line is one of the ways on.
      const choice = setup.worldmap.getBranchChoices().find(candidate => candidate.legIndex === line.legIndex);
      assert.ok(choice, 'leg ' + line.legIndex + ' leaves the junction');
      km += setup.worldmap.getBranchStep(choice.id).distanceKm;
      assert.equal(setup.railyard.takeBranch(choice.id), true);
      junctions++;
    }
    for (let step = setup.worldmap.getJourneyStep(1); State.variables.journey && step; step = setup.worldmap.getJourneyStep(1)) {
      km += step.distanceKm;
      steps.push({ terrain: step.terrain, heading: step.heading, arrives: step.destinationName || '' });
      assert.equal(setup.railyard.moveAlongLine(1), true, 'leg ' + line.legIndex);
    }
    if (line.destination) assert.equal(State.variables.currentStation, line.destination);
  });
  assert.equal(setup.worldmap.getStationName(State.variables.currentStation), goalName);
  return { km, junctions, legs: path.length, steps };
}

test('the world is one network, driven from Punta Arenas under the Bering Strait to Cape Town', () => {
  const game = loadGame();
  const { setup } = game;
  const data = setup.worldGraphData.network, route = setup.realWorldPilot.getGridRoute(), stations = route.corridor.stations;
  // Two grids, the Americas' and Europe, Asia and Africa's, the second turned and moved to meet the first at Wales.
  assert.deepEqual(Array.from(data.charts, chart => chart.id), ['americas-network', 'afro-eurasia-network']);
  assert.equal(data.charts[0].count + data.charts[1].count, data.squares.x.length);
  // Wales is one station with a line each way: to Nome, and into the tunnel.
  const wales = stations.findIndex(station => station.name === 'Wales') + 1;
  const walesTile = route.tiles[route.stationPositions[wales - 1]];
  assert.equal(walesTile.ends.length, 2);
  assert.ok(Math.abs(walesTile.geoCoordinate[0] + 168.09) < 0.1 && Math.abs(walesTile.geoCoordinate[1] - 65.61) < 0.1, walesTile.geoCoordinate.join(','));
  const [east, west] = walesTile.ends.map(end => route.byKey[(walesTile.x + setup.worldmap.DIRECTIONS[end].dx) + ',' + (walesTile.y + setup.worldmap.DIRECTIONS[end].dy)])
    .sort((a, b) => b.geoCoordinate[0] - a.geoCoordinate[0]);
  assert.equal(west.terrain, 'tunnel');
  assert.notEqual(east.terrain, 'tunnel');
  assert.ok(west.geoCoordinate[0] < -168.1 && west.geoCoordinate[0] > -170, west.geoCoordinate.join(','));
  // Every square's place comes back within its own square's reach of where the builder put it, on both grids.
  assert.ok(route.tiles.every(tile => tile.geoCoordinate[0] >= -180 && tile.geoCoordinate[0] < 180));
  // The far end of the journey, and the cities on the way, are on the one network.
  ['Moscow', 'Beijing', 'Tokyo', 'London', 'New Delhi', 'Cairo', 'Nairobi', 'Johannesburg'].forEach(city =>
    assert.ok(wayTo(game, city), city + ' can be reached'));
  const journey = driveTo(game, 'Cape Town');
  assert.ok(journey.km > 30000, Math.round(journey.km) + ' km');
  // Out of Wales the line runs west, through the tunnel, towards Uelen.
  const atWales = journey.steps.findIndex(step => step.arrives === 'Wales');
  assert.ok(atWales > 0 && journey.steps[atWales + 1].terrain === 'tunnel', 'the tunnel starts at Wales');
  assert.match(journey.steps[atWales + 1].heading, /west/);
});

test('the whole continent is one network that can be driven from Punta Arenas to Caracas', () => {
  const game = loadGame();
  const { setup, State } = game;
  const pilot = setup.realWorldPilot, route = pilot.getGridRoute(), stations = route.corridor.stations;
  const stats = setup.worldGraphData.network.stats;
  assert.ok(route.network && route.tiles.length > 20000, route.tiles.length + ' squares');
  assert.equal(stats.unreachableCities.length, 0, 'every authored city is on the network');
  // Line ends near track they could only reach the long way round are joined to it.
  assert.ok(stats.stubJoinCount > 100, JSON.stringify(stats));
  assert.equal(stats.stubJoinCount, setup.worldGraphData.network.stats.stubJoinCount);
  // The squares are one geographic grid: no square twice, every move to a neighbour, matched from the other side.
  const squares = new Set(route.tiles.map(tile => tile.x + ',' + tile.y));
  assert.equal(squares.size, route.tiles.length);
  route.tiles.forEach(tile => tile.ends.forEach(end => {
    const direction = setup.worldmap.DIRECTIONS[end];
    const other = route.byKey[(tile.x + direction.dx) + ',' + (tile.y + direction.dy)];
    assert.ok(other && other.ends.includes(setup.worldmap.opposite(end)), tile.x + ',' + tile.y + ' joins its neighbour');
  }));
  // Every junction and every end of the line is a node (a station, a junction out on the line, or a buffer), so every
  // leg is one plain line; and no station has more than two lines.
  route.tiles.filter(tile => tile.ends.length !== 2).forEach(tile =>
    assert.ok(tile.stationIndex || tile.junction || tile.buffer, tile.x + ',' + tile.y + ' is a node'));
  route.tiles.filter(tile => tile.stationIndex).forEach(tile => assert.ok(tile.ends.length <= 2, tile.station));
  // Spurs to termini are kept: Puerto Montt is at the end of one.
  const puertoMontt = stations.findIndex(station => station.name === 'Puerto Montt' && station.status === 'city') + 1;
  assert.ok(puertoMontt > 0);
  const { km, junctions } = driveTo(game, 'Caracas');
  assert.ok(junctions > 10, junctions + ' junctions on the way');
  assert.ok(km > 10000, Math.round(km) + ' km');
  // Every yard on the continent can be generated, with a reserve engine that can get out.
  for (let stationId = 1; stationId <= stations.length; stationId += 11) {
    assert.ok(setup.yardGeneration.validate(setup.railyard.generateStationTracks(stationId, 'network')), 'station ' + stationId);
  }
});

test('the hard region covers Alaska and the Yukon, and nothing to the south', () => {
  const { hardRegionTest } = require('../scripts/world/build-network.cjs');
  const isHard = hardRegionTest(require('../world/authored/regions.json').regions);
  for (const [name, point] of [['Fairbanks', [-147.7, 64.8]], ['Wales', [-168.1, 65.6]], ['Whitehorse', [-135.05, 60.72]],
    ['Skagway', [-135.3, 59.46]], ['Anchorage', [-149.9, 61.2]]]) assert.ok(isHard(point), name);
  for (const [name, point] of [['Dease Lake', [-130.0, 58.44]], ['Prince George', [-122.75, 53.92]], ['Prince Rupert', [-130.3, 54.3]], ['Fort Nelson', [-122.7, 58.8]],
    ['Seattle', [-122.3, 47.6]], ['Punta Arenas', [-70.9, -53.2]]]) assert.ok(!isHard(point), name);
});

test('of two lines between the same junctions nearly as direct as each other, the lesser is taken up', () => {
  const { pruneParallel, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  const add = (id, points, status) => network.add(traceLine(points.map(point => at(...point)), grid, {}),
    { id, status, bridgeShare: 0, tunnelShare: 0 });
  // Two junctions 200 km apart, with a working line straight between them and an abandoned one bowing out 15 km:
  // the abandoned line is barely longer, so it goes. A spur off the working line has no other way, so it stays.
  add('main', [[0, 0], [0, 200]], 'current');
  add('parallel', [[0, 0], [15, 20], [15, 180], [0, 200]], 'abandoned');
  add('in', [[0, 0], [0, -100]], 'current'); add('out', [[0, 200], [0, 300]], 'current');
  add('spur', [[0, 100], [-60, 100]], 'current');
  const before = network.squares.size;
  const result = pruneParallel(network, new Set(), new Set());
  assert.ok(result.stretches >= 1 && result.km > 150 && result.km < 260, JSON.stringify(result));
  assert.ok(network.squares.size < before);
  const has = point => network.squares.has(projection.cellOf(at(...point), grid).join(','));
  assert.ok(!has([15, 100]), 'the abandoned line is gone');
  assert.ok(has([0, 100]) && has([-60, 100]) && has([0, 250]), 'the working line and its spur stay');
  assert.equal(network.pieces().length, 1);
});

test('a far scrap of track is not worth a long new line, unless it serves an authored city', () => {
  const { longJoins, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const build = () => {
    const network = new Network();
    const add = (id, points) => network.add(traceLine(points.map(point => at(...point)), grid, {}),
      { id, status: 'current', bridgeShare: 0, tunnelShare: 0 });
    add('main', [[0, 0], [0, 800]]);          // a big network
    add('scrap', [[600, 400], [640, 400]]);  // 40 km of track 600 km away
    add('near', [[150, 0], [190, 0]]);       // 40 km of track 150 km away
    const groups = network.pieces().map(piece => ({ keys: piece.keys, km: piece.km }));
    return { network, groups };
  };
  const { network, groups } = build();
  const joins = longJoins(network, groups, grid);
  const reaches = east => joins.some(join => [join.from, join.to].some(key => {
    const square = network.squares.get(key);
    return Math.abs(projection.centreOf([square.x, square.y], grid)[0] - at(east, 0)[0]) < 0.3;
  }));
  assert.equal(joins.length, 1, JSON.stringify(joins));
  assert.ok(reaches(150), 'the near scrap is joined: 150 km is within the 300 km every piece may have');
  assert.ok(!reaches(600), 'the far one is not: 600 km is more than five times its 40 km of track');
  // A city on the big network does not make every scrap worth joining to it.
  const onMain = build();
  const mainCity = projection.cellOf(at(0, 400), grid).join(',');
  assert.equal(longJoins(onMain.network, onMain.groups, grid, () => false, new Set([mainCity])).length, 1);
  // A scrap serving an authored city is always worth it.
  const cities = build();
  const city = projection.cellOf(at(620, 400), grid).join(',');
  assert.equal(longJoins(cities.network, cities.groups, grid, () => false, new Set([city])).length, 2);
});

test('a build checkpoint reads back exactly what was written, and only for its own key', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const checkpoint = require('../scripts/world/checkpoint.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-checkpoint-'));
  try {
    const squares = Array.from({ length: 2500 }, (_, index) => ({ key: index + ',0', statuses: new Set(['current', 'disused']), km: index / 3 }));
    const state = { squares, lines: [{ kind: 'stub', parts: [{ coordinates: [[1.5, -2], [3, 4]] }] }], counts: new Map([['a', 1], ['b', 2]]), note: 'x' };
    checkpoint.write(dir, 'test', 'joins', 'key-1', state);
    const read = checkpoint.read(dir, 'test', 'joins', 'key-1');
    assert.equal(read.squares.length, 2500);
    assert.deepEqual(read.squares[7], squares[7]);
    assert.ok(read.squares[7].statuses instanceof Set);
    assert.deepEqual(Array.from(read.squares[7].statuses), ['current', 'disused']);
    assert.deepEqual(read.lines, state.lines);
    assert.deepEqual(Array.from(read.counts.entries()), [['a', 1], ['b', 2]]);
    assert.equal(read.note, 'x');
    // Another key is another build: nothing to read.
    assert.equal(checkpoint.read(dir, 'test', 'joins', 'key-2'), null);
    // The same source with Windows line endings keys a checkpoint just the same: it can move between computers.
    fs.writeFileSync(path.join(dir, 'unix.cjs'), 'const a = 1;\nconst b = 2;\n');
    fs.writeFileSync(path.join(dir, 'windows.cjs'), 'const a = 1;\r\nconst b = 2;\r\n');
    assert.equal(checkpoint.hashOf({ file: path.join(dir, 'unix.cjs') }), checkpoint.hashOf({ file: path.join(dir, 'windows.cjs') }));
    // A file cut short (the machine died while writing it) is no checkpoint at all.
    const file = checkpoint.fileFor(dir, 'test', 'joins');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 5000));
    assert.equal(checkpoint.read(dir, 'test', 'joins', 'key-1'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each build stage depends on the code it runs, and not on the stages after it', () => {
  const { dependenciesOf, stageTrace, stageJoins, stageOutskirts } = require('../scripts/world/build-network.cjs');
  const names = stage => dependenciesOf(stage).map(([name]) => name);
  const trace = names(stageTrace), joins = names(stageJoins), outskirts = names(stageOutskirts);
  // Followed through the functions a stage calls: tracing uses the grid projection through traceLine.
  ['traceLine', 'Network', 'TRACE_STEPS_PER_CELL', 'projection'].forEach(name => assert.ok(trace.includes(name), name));
  ['longJoins', 'shortCandidates', 'planLine', 'routeOverTerrain', 'terrain', 'MAX_WATER_KM', 'LONG_JOIN_MIN_KM'].forEach(name =>
    assert.ok(joins.includes(name), name));
  ['stubJoins', 'endJoins', 'cityShortcuts', 'spurs', 'SPUR_SPACING_KM', 'regionClassifier'].forEach(name => assert.ok(outskirts.includes(name), name));
  // Where the stops and yards go is decided after every checkpoint, so changing it reruns none of them.
  [trace, joins, outskirts].forEach(stage => ['YARD_RULES', 'MAX_SECTION_KM', 'pruneParallel', 'simplifyUrban', 'stageStops'].forEach(name =>
    assert.ok(!stage.includes(name), name)));
  assert.ok(!trace.includes('longJoins') && !joins.includes('spurs'));
  // Nor on where the project lies on this computer.
  [trace, joins, outskirts].forEach(stage => assert.ok(!stage.includes('root')));
});

test('a search that stops once its answers are certain agrees with one that searches everything', () => {
  const { distancesAlong, distancesTo, traceLine, Network } = require('../scripts/world/build-network.cjs');
  const projection = require('../scripts/world/projection.cjs');
  const grid = projection.GRID;
  const at = (eastKm, northKm) => [-62 + eastKm / (111.32 * Math.cos(-35 * Math.PI / 180)), -35 + northKm / 110.57];
  const network = new Network();
  const add = (id, points) => network.add(traceLine(points.map(point => at(...point)), grid, {}), { id, status: 'current', bridgeShare: 0, tunnelShare: 0 });
  // A loop with a branch off it, and a piece of track on its own.
  add('loop', [[0, 0], [300, 0], [300, 300], [0, 300], [0, 0]]);
  add('branch', [[300, 150], [600, 150]]);
  add('alone', [[800, 800], [900, 800]]);
  const adjacent = network.neighbours(), keys = Array.from(network.squares.keys()).sort();
  const start = keys[0], all = distancesAlong(network, adjacent, start, Infinity);
  const targets = new Map(keys.filter((_, index) => index % 7 === 0).map((key, index) => [key, 50 + index * 37]));
  const found = distancesTo(network, adjacent, start, targets);
  targets.forEach((threshold, key) => {
    const truth = all.get(key);
    // Either the exact distance, or missing only when it is at least the threshold (or not reachable at all).
    if (found.has(key)) assert.equal(found.get(key), truth, key);
    else assert.ok(truth === undefined || truth >= threshold, key + ': ' + truth + ' < ' + threshold);
    if (truth !== undefined && truth < threshold) assert.ok(found.has(key), key);
  });
});

test('a station stands only where the line runs straight, and every dead end leads to a station', () => {
  const { isStraightSquare, pruneDeadEnds, Network } = require('../scripts/world/build-network.cjs');
  const network = new Network();
  // A line west to east with a branch north from its middle, and a spur off the branch.
  const add = (from, to) => network.add([{ x: from[0], y: from[1], km: 2.5 }, { x: to[0], y: to[1], km: 2.5 }], { id: 'w', status: 'current', bridgeShare: 0, tunnelShare: 0 });
  for (let x = 0; x < 10; x++) add([x, 0], [x + 1, 0]);
  for (let y = 0; y < 4; y++) add([5, y], [5, y + 1]);
  add([5, 4], [6, 5]);
  add([6, 5], [7, 5]);
  const adjacent = network.neighbours();
  assert.ok(isStraightSquare('2,0', adjacent), 'straight through');
  assert.ok(isStraightSquare('0,0', adjacent), 'the end of a line');
  assert.ok(!isStraightSquare('5,0', adjacent), 'a junction');
  assert.ok(!isStraightSquare('5,4', adjacent), 'a bend');
  assert.ok(!isStraightSquare('6,5', adjacent), 'a bend of 45 degrees');
  // Stations at both ends of the main line and one on the branch: the branch beyond it goes, and so does nothing else.
  const stops = new Set(['0,0', '10,0', '5,2']);
  const removed = pruneDeadEnds(network, key => stops.has(key));
  assert.equal(removed, 4, 'from 7,5 back to the station at 5,2');
  ['5,3', '5,4', '6,5', '7,5'].forEach(key => assert.ok(!network.squares.has(key), key));
  ['0,0', '5,0', '5,1', '5,2', '10,0'].forEach(key => assert.ok(network.squares.has(key), key));
  // With no station on the branch, all of it goes, back to the junction.
  const stationless = pruneDeadEnds(network, key => key === '0,0' || key === '10,0');
  assert.equal(stationless, 2);
  assert.ok(network.squares.has('5,0') && !network.squares.has('5,1'));
});

test('the land raster has no row with land and water swapped where a coastline vertex meets a row', () => {
  const fs = require('node:fs');
  const { rasterizeLand } = require('../scripts/world/land-mask.cjs');
  const land = rasterizeLand(JSON.parse(fs.readFileSync(path.join(root, 'world/external/natural-earth-50m-land.geojson'), 'utf8')));
  const totals = [];
  for (let row = 0; row < land.rows; row++) {
    let count = 0;
    for (let column = 0; column < land.columns; column++) count += land.raster[row * land.columns + column];
    totals.push(count);
  }
  const odd = [];
  for (let row = 1; row < land.rows - 1; row++) {
    if (totals[row - 1] > 100 && totals[row] < 0.7 * Math.min(totals[row - 1], totals[row + 1])) odd.push(90 - (row + 0.5) * 0.05);
  }
  assert.deepEqual(odd, []);
});
