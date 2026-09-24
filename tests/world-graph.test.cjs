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
  assert.ok(networkSquareCount > 20000 && networkStopCount > 6000, JSON.stringify(stats));
  assert.ok(networkRailKm > 120000 && networkNewLineKm > 15000, JSON.stringify(stats));
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
  assert.ok(route.tiles.every(tile => ['plains', 'mountain', 'bridge', 'tunnel'].includes(tile.terrain)));
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
  // Every junction and every end of the line is a stop, so every leg is one plain line.
  route.tiles.filter(tile => tile.ends.length !== 2).forEach(tile => assert.ok(tile.stationIndex, tile.x + ',' + tile.y + ' is a stop'));
  // Spurs to termini are kept: Puerto Montt is at the end of one.
  const puertoMontt = stations.findIndex(station => station.name === 'Puerto Montt' && station.status === 'city') + 1;
  assert.ok(puertoMontt > 0);
  // Find a way from Punta Arenas to Caracas, a station at a time, and drive it.
  const goal = stations.findIndex(station => station.name === 'Caracas' && station.status === 'city') + 1;
  const previous = new Map([[1, null]]), queue = [1];
  while (queue.length && !previous.has(goal)) {
    const at = queue.shift();
    pilot.getStationLines(at).forEach(line => {
      if (!previous.has(line.destination)) { previous.set(line.destination, { from: at, line }); queue.push(line.destination); }
    });
  }
  assert.ok(previous.has(goal), 'Caracas can be reached');
  const path = [];
  for (let at = goal; previous.get(at); at = previous.get(at).from) path.unshift(previous.get(at));
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.currentTrain = [setup.railyard.cloneCar(State.variables.defaultTrains.dieselShunter)];
  State.variables.stationTracks = {};
  State.variables.currentStation = 1;
  let km = 0;
  path.forEach(({ from, line }) => {
    assert.equal(State.variables.currentStation, from);
    const leg = pilot.getLeg(line.legIndex);
    State.variables.journey = { legIndex: line.legIndex, tileIndex: line.forward ? 0 : leg.tiles.length - 1, forward: line.forward };
    while (State.variables.journey) {
      const step = setup.worldmap.getJourneyStep(1);
      km += step.distanceKm;
      assert.equal(setup.railyard.moveAlongLine(1), true, 'leg ' + line.legIndex);
    }
    assert.equal(State.variables.currentStation, line.destination);
  });
  assert.equal(setup.worldmap.getStationName(State.variables.currentStation), 'Caracas');
  assert.ok(km > 10000, Math.round(km) + ' km');
  // Every yard on the continent can be generated, with a reserve engine that can get out.
  for (let stationId = 1; stationId <= stations.length; stationId += 11) {
    assert.ok(setup.yardGeneration.validate(setup.railyard.generateStationTracks(stationId, 'network')), 'station ' + stationId);
  }
});
