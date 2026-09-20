const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { loadGame } = require('./helpers.cjs');

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
    datasetVersion: 'sa-spike-0.1.0',
    regionCount: 24,
    nodeCount: 35,
    linkCount: 40,
    corridorCount: 3
  });
  assert.equal(graph.loadAll(), true);
  assert.equal(graph.getNode('cl-punta-arenas').name, 'Punta Arenas');
  assert.equal(graph.getNode('pa-panama-city').name, 'Panama City');
  assert.equal(JSON.stringify(game.State.variables).includes('sa-spike-0.1.0'), false);
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
    'City names, coordinates and population: GeoNames (https://www.geonames.org/)'
  ]);
});
