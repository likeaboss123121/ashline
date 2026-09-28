const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { simplify } = require('./route-planning-links.cjs');
const { parseCsv } = require('./csv.cjs');
const { readRecords } = require('./records.cjs');
const { landMask, rasterizeLand } = require('./land-mask.cjs');

const root = path.resolve(__dirname, '../..');
const checkOnly = process.argv.includes('--check');
const tileKm = 5;

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const deltaLatitude = radians(b.latitude - a.latitude);
  const deltaLongitude = radians(b.longitude - a.longitude);
  const h = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function coordinateBand(value, size) {
  const start = Math.floor(value / 10) * 10;
  return (start < 0 ? 's' : 'n') + String(Math.abs(start)).padStart(size, '0');
}

function regionId(latitude, longitude) {
  return 'r-' + coordinateBand(latitude, 2) + '-' + coordinateBand(longitude, 3).replace(/^n/, 'e').replace(/^s/, 'w');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2).replace(/\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]/g, '[$1, $2]') + '\n';
}

function compile() {
  const sourceManifest = JSON.parse(read('world/sources.json'));
  const importManifest = JSON.parse(read('world/imports.json'));
  const placeRows = parseCsv(read('world/authored/places.csv'));
  const corridorRows = parseCsv(read('world/authored/corridors.csv'));
  const placeIds = new Set();
  const externalIds = new Set();

  const nodes = placeRows.map(row => {
    assert(/^[a-z]{2}-[a-z0-9-]+$/.test(row.place_id), 'Invalid place ID: ' + row.place_id);
    assert(!placeIds.has(row.place_id), 'Duplicate place ID: ' + row.place_id);
    assert(!externalIds.has(row.geonames_id), 'Duplicate GeoNames ID: ' + row.geonames_id);
    placeIds.add(row.place_id);
    externalIds.add(row.geonames_id);
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    const population = Number(row.population);
    assert(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90, 'Invalid latitude: ' + row.place_id);
    assert(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180, 'Invalid longitude: ' + row.place_id);
    assert(Number.isSafeInteger(population) && population >= 0, 'Invalid population: ' + row.place_id);
    return {
      id: row.place_id,
      name: row.name,
      countryCode: row.country_code,
      latitude,
      longitude,
      population,
      sourceId: 'geonames-cities15000-2026-09-20',
      sourceFeatureId: row.geonames_id
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const nodesById = Object.fromEntries(nodes.map(node => [node.id, node]));
  const rowsByCorridor = new Map();
  for (const row of corridorRows) {
    if (!rowsByCorridor.has(row.corridor_id)) rowsByCorridor.set(row.corridor_id, []);
    rowsByCorridor.get(row.corridor_id).push(row);
  }

  const links = [];
  const corridors = Array.from(rowsByCorridor.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => {
    rows.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const label = rows[0].label;
    rows.forEach((row, index) => {
      assert(Number(row.sequence) === index + 1, 'Non-contiguous sequence in corridor ' + id);
      assert(row.label === label, 'Inconsistent label in corridor ' + id);
      assert(nodesById[row.place_id], 'Unknown waypoint ' + row.place_id + ' in corridor ' + id);
    });
    assert(rows.length >= 2, 'Corridor needs at least two waypoints: ' + id);
    const waypoints = rows.map(row => row.place_id);
    const planningLinkIds = [];
    for (let index = 0; index < waypoints.length - 1; index++) {
      const from = nodesById[waypoints[index]];
      const to = nodesById[waypoints[index + 1]];
      const distanceKm = Math.round(haversineKm(from, to) * 10) / 10;
      const linkId = 'plan:' + id + ':' + String(index + 1).padStart(2, '0');
      planningLinkIds.push(linkId);
      links.push({
        id: linkId,
        from: from.id,
        to: to.id,
        corridorId: id,
        distanceKm,
        estimatedSlices: Math.ceil(distanceKm / tileKm),
        status: 'planning',
        navigable: false,
        reviewRequired: true,
        geometrySource: 'authored-waypoint-chord'
      });
    }
    return { id, label, waypoints, planningLinkIds };
  });

  assert(corridors.length > 0, 'At least one corridor is required');
  corridors.forEach(corridor => {
    assert(corridor.waypoints[0] === 'cl-punta-arenas', corridor.id + ' must start at Punta Arenas');
    assert(corridor.waypoints.at(-1) === 'pa-panama-city', corridor.id + ' must end at Panama City');
  });

  const chunks = {};
  function chunk(id) {
    if (!chunks[id]) chunks[id] = { id, nodes: [], portals: [], links: [] };
    return chunks[id];
  }
  nodes.forEach(node => chunk(regionId(node.latitude, node.longitude)).nodes.push(node));
  links.forEach(link => {
    const from = nodesById[link.from];
    const to = nodesById[link.to];
    chunk(regionId((from.latitude + to.latitude) / 2, (from.longitude + to.longitude) / 2)).links.push(link);
  });

  Object.values(chunks).forEach(value => {
    const ownedIds = new Set(value.nodes.map(node => node.id));
    const portalIds = new Set();
    value.links.forEach(link => {
      [link.from, link.to].forEach(nodeId => {
        if (!ownedIds.has(nodeId)) portalIds.add(nodeId);
      });
    });
    value.portals = Array.from(portalIds).sort().map(nodeId => nodesById[nodeId]);
  });

  const sortedChunks = {};
  Object.keys(chunks).sort().forEach(id => {
    const value = chunks[id];
    value.nodes.sort((a, b) => a.id.localeCompare(b.id));
	value.portals.sort((a, b) => a.id.localeCompare(b.id));
    value.links.sort((a, b) => a.id.localeCompare(b.id));
    sortedChunks[id] = value;
  });
  const regions = Object.values(sortedChunks).map(value => ({
    id: value.id,
    file: 'regions/' + value.id + '.json',
    nodeCount: value.nodes.length,
	portalCount: value.portals.length,
    linkCount: value.links.length
  }));
  // Planning links routed over real rail by scripts/world/route-planning-links.cjs. They are proposals: the compiler
  // refuses any that claim to be navigable, and a planning link only learns which route covers it, never loses its
  // own planning status.
  // Two sets can route the same pair of cities over different networks. The first set keeps the plain ID and the
  // rest are qualified by their set, so both stay inspectable.
  const routedIds = new Set();
  const routedLinks = (importManifest.routedLinks || []).flatMap(entry => {
    const routed = JSON.parse(read(entry.file));
    assert(routed.id === entry.id, 'Routed link import ID mismatch: ' + entry.file);
    return routed.links.map(link => {
      const id = routedIds.has(link.id) ? routed.id + '/' + link.id : link.id;
      routedIds.add(id);
      return { ...link, id, proposalSetId: routed.id, geometryId: routed.geometryId, sourceId: routed.sourceId };
    });
  });
  const linksById = Object.fromEntries(links.map(link => [link.id, link]));
  routedLinks.forEach(route => {
    route.planningLinkIds.forEach(id => {
      assert(linksById[id], 'Routed link covers unknown planning link: ' + id);
      // A link can be routed by more than one set.
      linksById[id].routedBy = (linksById[id].routedBy || []).concat(route.id);
    });
  });
  // The playable network: every mapped railway traced onto a grid and joined into one, built by
  // scripts/world/build-network.cjs. The first listed is the one the game starts on; each after it is on a grid of its
  // own and is joined to it where both have a stop (joinAt), into one network: the world.
  const networks = (importManifest.network || []).map(entry => {
    const network = readRecords(path.join(root, entry.file));
    assert(network.id === entry.id && network.formatVersion === 1, 'Network import ID mismatch: ' + entry.file);
    [network.sources.geometry, network.sources.stations, network.sources.settlements].forEach(part => {
      const source = sourceManifest.sources.find(candidate => candidate.id === part.sourceId);
      assert(source && source.status === 'ingested', 'Network part has no ingested source: ' + part.id);
    });
    validateNetwork(network);
    return network;
  });
  assert(networks.length >= 1, 'At least one playable network is required');
  const world = networks.slice(1).reduce((merged, network, index) =>
    joinNetworks(merged, network, importManifest.network[index + 1].joinAt), networks[0]);
  if (networks.length > 1) validateNetwork(world);
  const bundle = {
    formatVersion: 1,
    datasetVersion: sourceManifest.datasetVersion,
    tileKm,
    sources: sourceManifest.sources,
    regions,
    corridors,
    routedLinks,
    network: world,
    chunks: sortedChunks
  };
  validateBundle(bundle);
  return bundle;
}

// Two networks built on grids of their own, joined into one where both have a stop at joinAt.coordinates (Wales,
// Alaska, where the Americas' route ends and the Bering Strait tunnel comes ashore). The second network's squares are
// turned by joinAt.turn quarter turns anticlockwise about that stop and moved by whole squares so it lands on the
// first's, and that square becomes one station with the lines of both. Turned, the second grid can lie beside the
// first rather than over it: seen from Wales, the Americas and Asia both lie to the south. Every move is still to a
// neighbouring square, so the game walks the join like any other track; which grid each square is on, and how it was
// turned and moved, is kept in charts, for turning squares back into places. Refuses any other square the two share.
const quarterTurn = (x, y, turns) => {
  for (let turn = 0; turn < ((turns % 4) + 4) % 4; turn++) [x, y] = [-y, x];
  return [x + 0, y + 0];
};
function joinNetworks(base, other, joinAt) {
  assert(joinAt && Array.isArray(joinAt.coordinates), 'Network ' + other.id + ' needs joinAt coordinates in world/imports.json');
  const point = { longitude: joinAt.coordinates[0], latitude: joinAt.coordinates[1] };
  const nearest = network => network.stops.map(stop => ({ stop, km: haversineKm(point, { longitude: stop.coordinates[0], latitude: stop.coordinates[1] }) }))
    .sort((a, b) => a.km - b.km)[0];
  const [here, there] = [nearest(base), nearest(other)];
  assert(here && here.km < 1 && there && there.km < 1, 'No stop at ' + joinAt.coordinates.join(', ') + ' in both ' + base.id + ' and ' + other.id);
  const turn = joinAt.turn || 0;
  const [hx, hy] = here.stop.square.split(',').map(Number);
  const [tx, ty] = quarterTurn(...there.stop.square.split(',').map(Number), turn);
  let dx = hx - tx, dy = hy - ty;
  const seam = here.stop.square;
  // A station is drawn straight, so where both lines end at the join, the second network's line is brought in from
  // exactly opposite the first's: its end square is left out, and the square before it placed beside the join on the
  // far side, the move between them keeping its length. The grids meet at an arbitrary seam anyway.
  const baseEnds = base.squares.find(square => square.x + ',' + square.y === seam).ends;
  const theirs = other.squares.find(square => square.x + ',' + square.y === there.stop.square);
  let straighten = null;
  if (baseEnds.length === 1 && theirs.ends.length === 1) {
    const [bx, by] = [baseEnds[0].dx, baseEnds[0].dy], [ex, ey] = quarterTurn(theirs.ends[0].dx, theirs.ends[0].dy, turn);
    if (ex !== -bx || ey !== -by) {
      dx = hx - bx - (tx + ex);
      dy = hy - by - (ty + ey);
      straighten = { drop: there.stop.square, next: (theirs.x + theirs.ends[0].dx) + ',' + (theirs.y + theirs.ends[0].dy),
        back: [-ex, -ey], towardSeam: [bx, by], km: theirs.ends[0].km };
    }
  }
  const place = (x, y) => { const [u, v] = quarterTurn(x, y, turn); return [u + dx, v + dy]; };
  const move = key => place(...key.split(',').map(Number)).join(',');
  // Stops and halts named for their square are named for the square they are moved to.
  const moveId = id => id.replace(/^((?:halt|end|authored-end):)(-?\d+,-?\d+)$/, (whole, kind, key) => kind + move(key));
  // The square where they meet is copied before its lines are joined, so neither network given is changed.
  const squares = base.squares.map(square => square.x + ',' + square.y === seam ? { ...square, ends: square.ends.slice() } : square);
  const byKey = new Map(squares.map(square => [square.x + ',' + square.y, square]));
  let added = 0;
  if (straighten) {
    const joined = byKey.get(seam);
    joined.ends = joined.ends.concat([{ dx: -straighten.towardSeam[0] + 0, dy: -straighten.towardSeam[1] + 0, km: straighten.km }])
      .sort((a, b) => a.dx - b.dx || a.dy - b.dy);
  }
  other.squares.forEach(square => {
    if (straighten && square.x + ',' + square.y === straighten.drop) return;
    const [x, y] = place(square.x, square.y), key = x + ',' + y;
    const ends = square.ends.map(end => {
      const [edx, edy] = quarterTurn(end.dx, end.dy, turn);
      // The move back to the square left out goes to the join instead.
      if (straighten && square.x + ',' + square.y === straighten.next && edx === straighten.back[0] && edy === straighten.back[1]) {
        return { ...end, dx: straighten.towardSeam[0], dy: straighten.towardSeam[1] };
      }
      return { ...end, dx: edx, dy: edy };
    }).sort((a, b) => a.dx - b.dx || a.dy - b.dy);
    if (key === seam) {
      const joined = byKey.get(seam);
      ends.forEach(end => assert(!joined.ends.some(mine => mine.dx === end.dx && mine.dy === end.dy),
        'The two networks leave ' + seam + ' the same way'));
      joined.ends = joined.ends.concat(ends).sort((a, b) => a.dx - b.dx || a.dy - b.dy);
      return;
    }
    assert(!byKey.has(key), 'The grids of ' + base.id + ' and ' + other.id + ' overlap at ' + key + '; turn the second grid (joinAt.turn)');
    squares.push({ ...square, x, y, ends });
    added++;
  });
  const stops = base.stops.concat(other.stops.filter(stop => stop !== there.stop)
    .map(stop => ({ ...stop, id: moveId(stop.id), square: move(stop.square) })));
  const ids = new Set();
  stops.forEach(stop => { assert(!ids.has(stop.id), 'Two stops share the id ' + stop.id); ids.add(stop.id); });
  const charts = (base.charts || [{ id: base.id, grid: base.grid, offset: [0, 0], count: base.squares.length }])
    .concat([{ id: other.id, grid: other.grid, offset: [dx, dy], ...(turn ? { turn } : {}), count: added }]);
  const sum = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const result = { ...a };
      Object.keys(b).forEach(key => { result[key] = key in a ? sum(a[key], b[key]) : b[key]; });
      return result;
    }
    return a;
  };
  const stats = sum(base.stats, other.stats);
  stats.squareCount = squares.length;
  stats.moveCount = squares.reduce((total, square) => total + square.ends.length, 0) / 2;
  stats.stopCount = stops.length;
  return {
    formatVersion: 1, id: 'world-network', label: 'The world railway network', builderVersion: base.builderVersion,
    grid: base.grid, charts, joins: (base.joins || []).concat([{ networks: [base.id, other.id], square: seam, name: here.stop.name,
      offset: [dx, dy], ...(turn ? { turn } : {}), ...(joinAt.note ? { note: joinAt.note } : {}) }]),
    sources: base.sources, joinedSources: (base.joinedSources || []).concat([{ id: other.id, sources: other.sources }]),
    parameters: base.parameters, navigable: true, startSquare: base.startSquare, stats,
    stops, points: (base.points || []).concat((other.points || []).map(point => ({ ...point, square: move(point.square) }))),
    bridges: (base.bridges || []).concat(other.bridges || []), squares
  };
}

// The eight directions, in the order setup.worldmap.DIRECTIONS uses: a square's track ends are a bit each.
const DIRECTIONS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];

function validateNetwork(network) {
  const byKey = new Map(network.squares.map((square, index) => [square.x + ',' + square.y, index]));
  assert(byKey.size === network.squares.length, 'Network squares repeat: ' + network.id);
  network.squares.forEach(square => {
    assert(square.ends.length > 0 || network.squares.length === 1, 'Network square has no track: ' + square.x + ',' + square.y);
    square.ends.forEach(end => {
      assert(DIRECTIONS.some(([dx, dy]) => dx === end.dx && dy === end.dy), 'Network move is not to a neighbour: ' + square.x + ',' + square.y);
      const other = network.squares[byKey.get((square.x + end.dx) + ',' + (square.y + end.dy))];
      assert(other && other.ends.some(back => back.dx === -end.dx && back.dy === -end.dy && back.km === end.km),
        'Network move is not matched from the other side: ' + square.x + ',' + square.y);
      assert(end.km > 0, 'Network move covers no track: ' + square.x + ',' + square.y);
    });
    assert(Number.isFinite(square.elevationM) && Number.isFinite(square.elevationStdDevM), 'Network square lacks elevation: ' + square.x + ',' + square.y);
  });
  // One piece, from the square the game starts on.
  const seen = new Set([network.startSquare]), stack = [network.startSquare];
  assert(byKey.has(network.startSquare), 'Network start square is missing: ' + network.id);
  while (stack.length) {
    const key = stack.pop(), square = network.squares[byKey.get(key)];
    square.ends.forEach(end => {
      const next = (square.x + end.dx) + ',' + (square.y + end.dy);
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    });
  }
  assert(seen.size === network.squares.length, 'Network is not one piece: ' + network.id);
  const stopSquares = new Set();
  network.stops.forEach(stop => {
    assert(byKey.has(stop.square), 'Network stop is off the network: ' + stop.id);
    assert(!stopSquares.has(stop.square), 'Two network stops share a square: ' + stop.square);
    // A railyard has two ends, one line at each: junctions are out on the line. It is drawn straight, so its lines
    // leave in exactly opposite directions.
    const ends = network.squares[byKey.get(stop.square)].ends;
    assert(ends.length <= 2, 'A network stop has more than two lines: ' + stop.id);
    assert(ends.length < 2 || (ends[0].dx === -ends[1].dx && ends[0].dy === -ends[1].dy), 'A network stop is on a bend: ' + stop.id);
    stopSquares.add(stop.square);
  });
  // Every line leads somewhere: each end of a line is a station.
  network.squares.forEach(square => {
    assert(square.ends.length !== 1 || stopSquares.has(square.x + ',' + square.y), 'A line ends with no station: ' + square.x + ',' + square.y);
  });
  // No two railyards in squares that touch.
  stopSquares.forEach(key => {
    const [x, y] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      assert(!(dx || dy) || !stopSquares.has((x + dx) + ',' + (y + dy)), 'Two network stops stand in touching squares: ' + key);
    }
  });
}

// The network as the browser gets it: parallel arrays, the ends of each square as a bit mask over DIRECTIONS and
// the length of each move in the same order. Compact, because it runs to tens of thousands of squares.
function compactNetwork(network) {
  const byKey = new Map(network.squares.map((square, index) => [square.x + ',' + square.y, index]));
  const squares = { x: [], y: [], ends: [], km: [], elevation: [], relief: [], flags: [] };
  network.squares.forEach(square => {
    let mask = 0;
    const km = [];
    DIRECTIONS.forEach(([dx, dy], bit) => {
      const end = square.ends.find(candidate => candidate.dx === dx && candidate.dy === dy);
      if (end) { mask |= 1 << bit; km.push(Math.round(end.km * 10) / 10); }
    });
    squares.x.push(square.x); squares.y.push(square.y); squares.ends.push(mask); squares.km.push(km);
    squares.elevation.push(Math.round(square.elevationM)); squares.relief.push(Math.round(square.elevationStdDevM));
    squares.flags.push((square.gapFill ? 1 : 0) | (square.bridge ? 2 : 0) | (square.tunnel ? 4 : 0));
  });
  // Each stop's id is the builder's own (an OSM node, an authored place, or a halt's grid square): it outlasts a
  // rebuild of the network, where the stops' order and numbering do not, so saves refer to stops by it.
  const stops = { id: [], uuid: [], name: [], square: [], status: [], region: [] };
  const namespace = Buffer.from('4ada4312a7cc45109a61902f70fe704c','hex');
  const uuids = new Set();
  network.stops.forEach(stop => {
    const bytes = crypto.createHash('sha1').update(namespace).update(String(stop.id)).digest().subarray(0,16);
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    const uuid = hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
    assert(!uuids.has(uuid), 'Duplicate stable station UUID: ' + stop.id);
    uuids.add(uuid); stops.uuid.push(uuid);
    stops.id.push(stop.id); stops.name.push(stop.name); stops.square.push(byKey.get(stop.square)); stops.status.push(stop.status);
    stops.region.push(stop.region);
  });
  // The junctions and buffers out on the line, named for the nearest place.
  const points = { square: [], kind: [], name: [] };
  (network.points || []).forEach(point => {
    points.square.push(byKey.get(point.square)); points.kind.push(point.kind); points.name.push(point.name);
  });
  // A world of several grids says which squares are on which: the squares of each chart follow those of the one before
  // it, count of them from first, and its grid carries the quarter turns and offset the compiler moved it by
  // (joinNetworks): a square's own place on its grid is the offset taken away, then the turn undone.
  let first = 0;
  const charts = network.charts ? network.charts.map(chart => {
    const entry = { id: chart.id, grid: { ...chart.grid, offset: chart.offset, ...(chart.turn ? { turn: chart.turn } : {}) }, first, count: chart.count };
    first += chart.count;
    return entry;
  }) : null;
  // Land and water under the network, for the debug map (scripts/world/land-mask.cjs).
  const landFile = path.join(root, 'world/external/natural-earth-50m-land.geojson');
  const land = fs.existsSync(landFile) ? landMask(network.squares,
    network.charts || [{ grid: network.grid, offset: [0, 0], count: network.squares.length }],
    rasterizeLand(JSON.parse(fs.readFileSync(landFile, 'utf8')))) : null;
  return { id: network.id, label: network.label, grid: network.grid, ...(charts ? { charts } : {}), start: byKey.get(network.startSquare),
    stats: network.stats, squares, stops, points, ...(land ? { land } : {}) };
}

function validateBundle(bundle) {
  assert(bundle.formatVersion === 1, 'Unsupported format version');
  assert(bundle.tileKm === 5, 'World slice size must be 5 km');
  const nodeIds = new Set();
  const linkIds = new Set();
  for (const region of bundle.regions) {
    const chunk = bundle.chunks[region.id];
    assert(chunk && chunk.id === region.id, 'Missing chunk ' + region.id);
    assert(chunk.nodes.length === region.nodeCount, 'Wrong node count for ' + region.id);
	assert(chunk.portals.length === region.portalCount, 'Wrong portal count for ' + region.id);
    assert(chunk.links.length === region.linkCount, 'Wrong link count for ' + region.id);
    chunk.nodes.forEach(node => {
      assert(!nodeIds.has(node.id), 'Node stored more than once: ' + node.id);
      nodeIds.add(node.id);
    });
    chunk.links.forEach(link => {
      assert(!linkIds.has(link.id), 'Link stored more than once: ' + link.id);
      assert(link.status === 'planning' && link.navigable === false && link.reviewRequired === true,
        'Planning link safety flags are missing: ' + link.id);
      assert(link.geometrySource === 'authored-waypoint-chord', 'Unexpected geometry source: ' + link.id);
      linkIds.add(link.id);
    });
	var locallyResolvable = new Set(chunk.nodes.concat(chunk.portals).map(node => node.id));
	chunk.links.forEach(link => {
		assert(locallyResolvable.has(link.from) && locallyResolvable.has(link.to),
			'Region cannot resolve link endpoints: ' + link.id);
	});
  }
  for (const chunk of Object.values(bundle.chunks)) {
    chunk.links.forEach(link => {
      assert(nodeIds.has(link.from) && nodeIds.has(link.to), 'Link has missing endpoint: ' + link.id);
      assert(link.estimatedSlices === Math.ceil(link.distanceKm / bundle.tileKm), 'Wrong slice estimate: ' + link.id);
    });
  }
  bundle.corridors.forEach(corridor => {
    corridor.waypoints.forEach(id => assert(nodeIds.has(id), 'Corridor has missing waypoint: ' + id));
    corridor.planningLinkIds.forEach(id => assert(linkIds.has(id), 'Corridor has missing link: ' + id));
    assert(corridor.planningLinkIds.length === corridor.waypoints.length - 1, 'Wrong link count: ' + corridor.id);
  });
  const routedIds = new Set();
  (bundle.routedLinks || []).forEach(route => {
    assert(!routedIds.has(route.id), 'Duplicate routed link: ' + route.id);
    routedIds.add(route.id);
    assert(route.navigable === false && route.reviewRequired === true, 'Routed link claims to be playable: ' + route.id);
    assert(route.planningLinkIds.every(id => linkIds.has(id)), 'Routed link covers a missing planning link: ' + route.id);
    assert(route.slices.length === route.sliceCount && route.sliceCount > 0, 'Routed link slice count mismatch: ' + route.id);
    let routed = 0;
    route.slices.forEach((slice, index) => {
      assert(slice.navigable === false, 'Routed slice claims to be playable: ' + slice.id);
      assert(['routed-rail-proposal', 'gap-fill-proposal'].includes(slice.reviewStatus), 'Unknown slice review status: ' + slice.id);
      assert(slice.gapFill === (slice.gapKm > 0) && (slice.reviewStatus === 'gap-fill-proposal') === slice.gapFill,
        'Gap flags disagree: ' + slice.id);
      assert(slice.distanceKm > 0 && slice.distanceKm <= bundle.tileKm + 0.001, 'Invalid routed slice length: ' + slice.id);
      assert(Math.abs(slice.railKm + slice.gapKm - slice.distanceKm) < 0.01, 'Routed slice parts do not add up: ' + slice.id);
      assert(slice.coordinates.length >= 2, 'Routed slice has no shape: ' + slice.id);
      if (index) {
        assert(JSON.stringify(route.slices[index - 1].coordinates.at(-1)) === JSON.stringify(slice.coordinates[0]),
          'Disconnected routed slices: ' + slice.id);
      }
      routed += slice.distanceKm;
    });
    assert(Math.abs(Math.round(routed * 10) / 10 - route.routedKm) < 0.2, 'Routed link distance mismatch: ' + route.id);
  });
}

// Consecutive slices of the same kind merged into one polyline, simplified to about 200 m: the browser only draws these
// on a continent-sized debug overview, so the full slice geometry stays in the committed proposal file.
function runsOf(slices) {
  const runs = [];
  slices.forEach(slice => {
    const last = runs[runs.length - 1];
    if (last && last.gapFill === slice.gapFill) {
      last.coordinates.push(...slice.coordinates.slice(1));
    } else {
      runs.push({ gapFill: slice.gapFill, coordinates: slice.coordinates.slice() });
    }
  });
  return runs.map(run => ({
    gapFill: run.gapFill,
    coordinates: simplify(run.coordinates, 0.002).map(point => [Math.round(point[0] * 1e3) / 1e3, Math.round(point[1] * 1e3) / 1e3])
  }));
}

// The Map tab's globe: a greyscale picture of the whole Earth, water 0 and land its shaded relief (globe-texture.cjs),
// embedded as a PNG so it ships inside the game; and land and water alone, finer (the 1:50m land polygons filled at
// land-mask.cjs's raster size), as run lengths row by row from the north, water first, so coastlines stay sharp when
// the globe is zoomed in on the texture's coarse texels.
function globeTexture() {
  const file = path.join(root, 'world/external/globe-texture.png');
  const landFile = path.join(root, 'world/external/natural-earth-50m-land.geojson');
  if (!fs.existsSync(file) || !fs.existsSync(landFile)) return '';
  const bytes = fs.readFileSync(file);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const land = rasterizeLand(JSON.parse(fs.readFileSync(landFile, 'utf8')));
  const runs = [];
  let current = 0, length = 0;
  land.raster.forEach(value => {
    if (value === current) { length++; return; }
    runs.push(length);
    current = value;
    length = 1;
  });
  runs.push(length);
  return '// The globe on the Map tab: see scripts/world/globe-texture.cjs.\nsetup.worldGraphData.globe = '
    + JSON.stringify({ width, height, texture: 'data:image/png;base64,' + bytes.toString('base64'),
      land: { columns: land.columns, rows: land.rows, runs: runs.map(run => run.toString(36)).join(',') } }) + ';\n';
}

function outputsFor(bundle) {
  const manifest = { ...bundle };
  delete manifest.chunks;
  const browserBundle = { ...bundle, network: undefined };
  const networkFiles = JSON.parse(read('world/imports.json')).network.map(entry => entry.file);
  manifest.network = { id: bundle.network.id, label: bundle.network.label, grid: bundle.network.grid,
    ...(bundle.network.charts ? { charts: bundle.network.charts.map(chart => ({ id: chart.id, grid: chart.grid, offset: chart.offset,
      ...(chart.turn ? { turn: chart.turn } : {}), count: chart.count })),
      joins: bundle.network.joins, joinedSources: bundle.network.joinedSources } : {}),
    sources: bundle.network.sources, parameters: bundle.network.parameters, stats: bundle.network.stats,
    ...(networkFiles.length === 1 ? { file: networkFiles[0] } : { files: networkFiles }) };
  manifest.routedLinks = bundle.routedLinks.map(route => ({
    id: route.id, proposalSetId: route.proposalSetId, from: route.from, to: route.to,
    planningLinkIds: route.planningLinkIds, status: route.status, chordKm: route.chordKm, routedKm: route.routedKm,
    railKm: route.railKm, gapKm: route.gapKm, gapCount: route.gaps.length, sliceCount: route.sliceCount,
    stationCount: route.stations.length, navigable: route.navigable, reviewRequired: route.reviewRequired
  }));
  browserBundle.routedLinks = bundle.routedLinks.map(route => ({
    id: route.id, proposalSetId: route.proposalSetId, from: route.from, to: route.to, status: route.status,
    ...(route.detour ? { detour: true } : {}), chordKm: route.chordKm,
    routedKm: route.routedKm, railKm: route.railKm, gapKm: route.gapKm, gapCount: route.gaps.length,
    sliceCount: route.sliceCount, navigable: route.navigable, reviewRequired: route.reviewRequired,
    runs: runsOf(route.slices)
  }));
  const compact = compactNetwork(bundle.network);
  const revision = crypto.createHash('sha256').update(JSON.stringify(compact)).digest('hex').slice(0,24);
  const outputs = new Map([
    ['world/dist/manifest.json', stableJson(manifest)],
    ['source/world-data.js', '// Generated by scripts/world/compile-world.cjs. Do not edit.\nsetup.worldGraphData = ' + stableJson(browserBundle).trimEnd() + ';\n'
      + '// The playable network, compact: see compactNetwork in the compiler.\nsetup.worldGraphData.network = '
      + JSON.stringify(compact) + ';\nsetup.worldGraphData.networkRevision = ' + JSON.stringify(revision) + ';\n' + globeTexture()]
  ]);
  Object.entries(bundle.chunks).forEach(([id, chunk]) => {
    outputs.set('world/dist/regions/' + id + '.json', stableJson(chunk));
  });
  return outputs;
}

function writeOrCheck(outputs) {
  let stale = false;
  for (const [relativePath, content] of outputs) {
    const absolutePath = path.join(root, relativePath);
    if (checkOnly) {
      if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, 'utf8') !== content) {
        console.error('World output is stale: ' + relativePath);
        stale = true;
      }
    } else {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, 'utf8') !== content) {
        fs.writeFileSync(absolutePath, content);
      }
    }
  }
  if (stale) process.exitCode = 1;
}

function main() {
  const bundle = compile();
  const outputs = outputsFor(bundle);
  writeOrCheck(outputs);
  const nodeCount = bundle.regions.reduce((sum, region) => sum + region.nodeCount, 0);
  const linkCount = bundle.regions.reduce((sum, region) => sum + region.linkCount, 0);
  const distanceKm = Object.values(bundle.chunks).flatMap(chunk => chunk.links)
    .reduce((sum, link) => sum + link.distanceKm, 0);
  const action = checkOnly ? 'Verified' : 'Compiled';
  console.log(action + ' world ' + bundle.datasetVersion + ': ' + nodeCount + ' nodes, ' + linkCount +
    ' planning links, ' + bundle.regions.length + ' regions, ' + Math.round(distanceKm).toLocaleString('en-US') +
    ' km; ' + bundle.routedLinks.length + ' routed planning link proposal(s); network of ' +
    bundle.network.stats.squareCount.toLocaleString('en-US') + ' squares and ' + bundle.network.stats.stopCount.toLocaleString('en-US') +
    ' stops');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { joinNetworks, validateNetwork, compactNetwork };
