// Pipeline stage 4: replace planning chords with real rail, and propose the smallest gap fills where there is none.
//
// Each planning link joins two authored cities by a straight geodesic chord. This stage anchors both cities to the
// national railway network, repairs digitizing breaks where two OSM ways stop a few metres apart, and routes the link
// over the repaired network. Wherever the network does not connect, it offers the cheapest way across:
//
//   snap       an OSM break shorter than SNAP_M, joined without comment: it is the same track drawn twice.
//   gap        a join between the loose ends of two separate networks within GAP_KM. Rail pays GAP_PENALTY times its
//              length for these, so real track always wins where it exists.
//   long-gap   the shortest possible join between the two cities' networks when nothing else connects them, such as
//              the length of Patagonia, which has never had a railway.
//
// Nothing produced here is playable. Every gap is a proposal for review, and the whole route stays navigable: false
// until an authored reviewed corridor adopts it. The output is small and committed; the national geometry it reads
// is large and is regenerated from the dated extract (see world/README.md).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildCoordinateGraph, TILE_KM } = require('./build-rail-topology.cjs');
const { formatJson } = require('./import-osm-geojson.cjs');

const root = path.resolve(__dirname, '../..');
const SNAP_M = 50;
const GAP_KM = 30;
const GAP_PENALTY = 4;
const ANCHOR_KM = 20;
// A named station only wins over plain track if it is near the city itself. Large city stations are often mapped as
// areas rather than points, so the nearest station point can be a suburban halt twenty kilometres out.
const STATION_ANCHOR_KM = 8;
const STATION_SNAP_KM = 1;
const ALONG_ROUTE_M = 300;
const GRID_DEGREES = 0.05;
const SIMPLIFY_DEGREES = 0.0002;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeA = radians(a[1]);
  const latitudeB = radians(b[1]);
  const h = Math.sin(radians(b[1] - a[1]) / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [columns[index], value])));
}

// --- spatial index ------------------------------------------------------------------------------------------

class Grid {
  constructor() { this.cells = new Map(); }
  cellOf(coordinate) {
    return [Math.floor(coordinate[0] / GRID_DEGREES), Math.floor(coordinate[1] / GRID_DEGREES)];
  }
  add(coordinate, value) {
    const [x, y] = this.cellOf(coordinate);
    const id = x + ',' + y;
    if (!this.cells.has(id)) this.cells.set(id, []);
    this.cells.get(id).push(value);
  }
  // Every value within ring cells of a coordinate, nearest cells first.
  near(coordinate, ring) {
    const [cx, cy] = this.cellOf(coordinate);
    const found = [];
    for (let x = cx - ring; x <= cx + ring; x++) {
      for (let y = cy - ring; y <= cy + ring; y++) {
        const values = this.cells.get(x + ',' + y);
        if (values) found.push(...values);
      }
    }
    return found;
  }
}

// How many cells a search needs to reach a distance at this latitude: a degree of longitude shrinks polewards.
function ringsFor(km, latitude) {
  const kmPerCell = GRID_DEGREES * 111 * Math.max(0.2, Math.cos(latitude * Math.PI / 180));
  return Math.max(1, Math.ceil(km / kmPerCell));
}

// --- the repaired network -----------------------------------------------------------------------------------

function unionFind(keys) {
  const parent = new Map(keys.map(key => [key, key]));
  function find(key) {
    let cursor = key;
    while (parent.get(cursor) !== cursor) {
      parent.set(cursor, parent.get(parent.get(cursor)));
      cursor = parent.get(cursor);
    }
    return cursor;
  }
  function join(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA < rootB ? rootB : rootA, rootA < rootB ? rootA : rootB);
  }
  return { find, join };
}

function addSegment(graph, fromKey, toKey, kind, detail) {
  const from = graph.nodes.get(fromKey);
  const to = graph.nodes.get(toKey);
  const distanceKm = haversineKm(from.coordinate, to.coordinate);
  const index = graph.segments.length;
  graph.segments.push({ id: kind + ':' + fromKey + '>' + toKey, from: fromKey, to: toKey, distanceKm, kind, ...detail });
  from.segments.push(index);
  to.segments.push(index);
  return index;
}

function degree(graph, key) {
  return graph.nodes.get(key).segments.length;
}

// Joins every loose end to track within SNAP_M. These are digitizing breaks, not missing railway.
function snapBreaks(graph, grid) {
  let snaps = 0;
  const done = new Set();
  Array.from(graph.nodes.keys()).sort().forEach(key => {
    if (degree(graph, key) !== 1) return;
    const node = graph.nodes.get(key);
    let best = null;
    grid.near(node.coordinate, 1).forEach(otherKey => {
      if (otherKey === key) return;
      const other = graph.nodes.get(otherKey);
      if (node.segments.some(index => {
        const segment = graph.segments[index];
        return segment.from === otherKey || segment.to === otherKey;
      })) return;
      const metres = haversineKm(node.coordinate, other.coordinate) * 1000;
      if (metres <= SNAP_M && (!best || metres < best.metres || (metres === best.metres && otherKey < best.key))) {
        best = { key: otherKey, metres };
      }
    });
    if (!best) return;
    const pair = key < best.key ? key + '|' + best.key : best.key + '|' + key;
    if (done.has(pair)) return;
    done.add(pair);
    addSegment(graph, key, best.key, 'snap', {});
    snaps++;
  });
  return snaps;
}

function components(graph) {
  const sets = unionFind(Array.from(graph.nodes.keys()));
  graph.segments.forEach(segment => sets.join(segment.from, segment.to));
  return sets;
}

// Joins loose ends of different networks that lie within GAP_KM of each other: the candidate short gap fills.
function proposeShortGaps(graph, grid, sets) {
  const loose = Array.from(graph.nodes.keys()).filter(key => degree(graph, key) === 1).sort();
  const looseGrid = new Grid();
  loose.forEach(key => looseGrid.add(graph.nodes.get(key).coordinate, key));
  let count = 0;
  const seen = new Set();
  loose.forEach(key => {
    const node = graph.nodes.get(key);
    const rootA = sets.find(key);
    let best = null;
    looseGrid.near(node.coordinate, ringsFor(GAP_KM, node.coordinate[1])).forEach(otherKey => {
      if (sets.find(otherKey) === rootA) return;
      const km = haversineKm(node.coordinate, graph.nodes.get(otherKey).coordinate);
      if (km <= GAP_KM && (!best || km < best.km || (km === best.km && otherKey < best.key))) best = { key: otherKey, km };
    });
    if (!best) return;
    const pair = key < best.key ? key + '|' + best.key : best.key + '|' + key;
    if (seen.has(pair)) return;
    seen.add(pair);
    addSegment(graph, key, best.key, 'gap', {});
    count++;
  });
  return count;
}

// --- anchoring cities to the network ------------------------------------------------------------------------

// Track that carries mainline trains, rather than a city's metro or tram: the anchor a long-distance link wants.
function isMainline(graph, key) {
  return graph.nodes.get(key).segments.some(index => {
    const way = graph.segments[index].way;
    return way && way.railway !== 'light_rail';
  });
}

function nearestNode(graph, grid, coordinate, maxKm, accept) {
  let best = null;
  grid.near(coordinate, ringsFor(maxKm, coordinate[1])).forEach(key => {
    if (accept && !accept(key)) return;
    const km = haversineKm(coordinate, graph.nodes.get(key).coordinate);
    if (km <= maxKm && (!best || km < best.km || (km === best.km && key < best.key))) best = { key, km };
  });
  return best;
}

// A city is reached at its nearest named station if one lies within STATION_ANCHOR_KM, otherwise at its nearest track
// within ANCHOR_KM. A city with no track anywhere near is its own anchor, which the routing then reaches by a long gap.
function anchorPlace(graph, grid, stationGrid, place) {
  const coordinate = [place.longitude, place.latitude];
  let station = null;
  stationGrid.near(coordinate, ringsFor(STATION_ANCHOR_KM, coordinate[1])).forEach(point => {
    const km = haversineKm(coordinate, point.coordinates);
    if (km <= STATION_ANCHOR_KM && point.tags.name
      && (!station || km < station.km || (km === station.km && point.id < station.point.id))) {
      station = { point, km };
    }
  });
  if (station) {
    const track = nearestNode(graph, grid, station.point.coordinates, STATION_SNAP_KM);
    if (track) {
      return { kind: 'station', key: track.key, pointId: station.point.id, name: station.point.tags.name || '',
        distanceKm: round(station.km, 3) };
    }
  }
  const track = nearestNode(graph, grid, coordinate, ANCHOR_KM, key => isMainline(graph, key))
    || nearestNode(graph, grid, coordinate, ANCHOR_KM);
  if (track) return { kind: 'track', key: track.key, distanceKm: round(track.km, 3) };
  const key = 'city:' + place.id;
  graph.nodes.set(key, { key, coordinate, segments: [] });
  grid.add(coordinate, key);
  return { kind: 'city', key, distanceKm: 0 };
}

// --- routing ------------------------------------------------------------------------------------------------

function segmentCost(segment) {
  if (segment.kind === 'gap' || segment.kind === 'long-gap') return segment.distanceKm * GAP_PENALTY;
  if (segment.kind === 'snap') return segment.distanceKm;
  return segment.distanceKm * (segment.way && segment.way.tags.service ? 1.35 : 1);
}

function reachable(graph, start) {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const key = pending.pop();
    graph.nodes.get(key).segments.forEach(index => {
      const segment = graph.segments[index];
      const next = segment.from === key ? segment.to : segment.from;
      if (!seen.has(next)) { seen.add(next); pending.push(next); }
    });
  }
  return seen;
}

function dijkstra(graph, start, goal) {
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  const heap = [{ key: start, distance: 0 }];
  const push = item => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent].distance <= item.distance) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].distance < heap[child].distance) child++;
        if (heap[child].distance >= last.distance) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  while (heap.length) {
    const current = pop();
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === goal) break;
    graph.nodes.get(current.key).segments.forEach(index => {
      const segment = graph.segments[index];
      const next = segment.from === current.key ? segment.to : segment.from;
      const distance = current.distance + segmentCost(segment);
      if (distance < (distances.get(next) ?? Infinity)) {
        distances.set(next, distance);
        previous.set(next, { key: current.key, index });
        push({ key: next, distance });
      }
    });
  }
  if (start !== goal && !previous.has(goal)) return null;
  const steps = [];
  for (let cursor = goal; cursor !== start;) {
    const step = previous.get(cursor);
    steps.push({ from: step.key, to: cursor, segment: graph.segments[step.index] });
    cursor = step.key;
  }
  return steps.reverse();
}

// Brute force over two lists of node keys, deterministically: the nearest pair, ties broken by key.
function nearestBetween(graph, keysA, keysB) {
  let best = null;
  keysA.forEach(a => {
    const coordinate = graph.nodes.get(a).coordinate;
    keysB.forEach(b => {
      const km = haversineKm(coordinate, graph.nodes.get(b).coordinate);
      if (!best || km < best.km || (km === best.km && (a + '|' + b) < (best.a + '|' + best.b))) best = { a, b, km };
    });
  });
  return best;
}

// Every key in a set within km of a coordinate.
function keysNear(graph, keys, coordinate, km) {
  return keys.filter(key => haversineKm(coordinate, graph.nodes.get(key).coordinate) <= km);
}

// The closest pair of nodes between two disconnected networks: the shortest possible new line to propose. A pair of
// networks can hold hundreds of thousands of nodes between them, and a Patagonian gap is a thousand kilometres, so
// this finds the pair on an even sample of each network first and then refines it among the nodes near that pair.
const COARSE_SAMPLE = 1500;
const REFINE_KM = 25;
function closestPair(graph, setA, setB) {
  const sample = keys => {
    const sorted = Array.from(keys).sort();
    if (sorted.length <= COARSE_SAMPLE) return sorted;
    const step = sorted.length / COARSE_SAMPLE;
    return Array.from({ length: COARSE_SAMPLE }, (_, index) => sorted[Math.floor(index * step)]);
  };
  const keysA = Array.from(setA).sort();
  const keysB = Array.from(setB).sort();
  const coarse = nearestBetween(graph, sample(keysA), sample(keysB));
  if (!coarse) return null;
  // The true pair lies near the sampled one; how near depends on how far apart the networks are.
  const radius = Math.max(REFINE_KM, coarse.km * 0.1);
  const nearA = keysNear(graph, keysA, graph.nodes.get(coarse.a).coordinate, radius);
  const nearB = keysNear(graph, keysB, graph.nodes.get(coarse.b).coordinate, radius);
  // Refining is exhaustive among the nearby nodes, bounded so a dense yard cannot make it quadratic in the network.
  const bound = keys => keys.length > 4000 ? keys.filter((_, index) => index % Math.ceil(keys.length / 4000) === 0) : keys;
  return nearestBetween(graph, bound(nearA), bound(nearB)) || coarse;
}

function routeLink(graph, from, to) {
  let steps = dijkstra(graph, from.key, to.key);
  const longGaps = [];
  // Where the two cities' networks do not meet at all, propose the single shortest line that joins them, then route
  // again. Repeating allows for a chain of islands, though one join covers every link in the current spike.
  for (let attempt = 0; !steps && attempt < 4; attempt++) {
    const pair = closestPair(graph, reachable(graph, from.key), reachable(graph, to.key));
    assert(pair, 'No gap can join ' + from.key + ' and ' + to.key);
    addSegment(graph, pair.a, pair.b, 'long-gap', {});
    longGaps.push(pair);
    steps = dijkstra(graph, from.key, to.key);
  }
  assert(steps, 'Could not route between ' + from.key + ' and ' + to.key);
  return { steps, longGaps };
}

// --- slicing into gameplay-sized pieces ---------------------------------------------------------------------

function interpolate(a, b, ratio) {
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
}

// Douglas-Peucker in degrees: a slice's shape survives, and its coordinate list stops being thousands of points.
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let worst = 0;
  let worstIndex = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const [px, py] = points[index];
    const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distance > worst) { worst = distance; worstIndex = index; }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  return simplify(points.slice(0, worstIndex + 1), tolerance).slice(0, -1)
    .concat(simplify(points.slice(worstIndex), tolerance));
}

function sliceRoute(graph, steps, linkId) {
  const slices = [];
  let current = null;
  function open(coordinate) {
    current = { coordinates: [coordinate], distanceKm: 0, railKm: 0, gapKm: 0, sourceWayIds: new Set(),
      statuses: new Set(), bridge: false, tunnel: false, kinds: new Set() };
  }
  function close() {
    if (!current || !(current.distanceKm > 0)) return;
    const ordinal = slices.length + 1;
    slices.push({
      id: linkId + ':slice-' + String(ordinal).padStart(3, '0'),
      distanceKm: round(current.distanceKm, 3),
      railKm: round(current.railKm, 3),
      gapKm: round(current.gapKm, 3),
      gapFill: current.gapKm > 0,
      bridge: current.bridge,
      tunnel: current.tunnel,
      sourceWayIds: Array.from(current.sourceWayIds).sort(),
      railwayStatuses: Array.from(current.statuses).sort(),
      coordinates: simplify(current.coordinates, SIMPLIFY_DEGREES).map(point => [round(point[0], 5), round(point[1], 5)]),
      navigable: false,
      reviewStatus: current.gapKm > 0 ? 'gap-fill-proposal' : 'routed-rail-proposal'
    });
    current = null;
  }
  function add(segment, km) {
    if (segment.kind === 'gap' || segment.kind === 'long-gap') current.gapKm += km;
    else current.railKm += km;
    current.kinds.add(segment.kind || 'rail');
    if (segment.way) {
      current.sourceWayIds.add(segment.way.id);
      current.statuses.add(segment.way.railwayStatus);
      current.bridge = current.bridge || (!!segment.way.tags.bridge && segment.way.tags.bridge !== 'no');
      current.tunnel = current.tunnel || (!!segment.way.tags.tunnel && segment.way.tags.tunnel !== 'no');
    }
  }
  open(graph.nodes.get(steps[0].from).coordinate);
  steps.forEach(step => {
    let from = graph.nodes.get(step.from).coordinate;
    const to = graph.nodes.get(step.to).coordinate;
    let remaining = haversineKm(from, to);
    while (remaining > 0.000001) {
      const room = TILE_KM - current.distanceKm;
      if (remaining <= room + 0.000001) {
        current.coordinates.push(to);
        current.distanceKm += remaining;
        add(step.segment, remaining);
        remaining = 0;
      } else {
        const boundary = interpolate(from, to, room / remaining);
        current.coordinates.push(boundary);
        current.distanceKm += room;
        add(step.segment, room);
        close();
        open(boundary);
        from = boundary;
        remaining = haversineKm(from, to);
      }
    }
  });
  close();
  return slices;
}

// Named stations the route passes within ALONG_ROUTE_M of, in order: the candidate stops for a playable corridor.
function stationsAlong(graph, steps, stationGrid) {
  const found = new Map();
  let along = 0;
  steps.forEach(step => {
    const coordinate = graph.nodes.get(step.to).coordinate;
    along += step.segment.distanceKm;
    if (step.segment.kind === 'gap' || step.segment.kind === 'long-gap') return;
    stationGrid.near(coordinate, 1).forEach(point => {
      if (!point.tags.name || found.has(point.id)) return;
      if (haversineKm(coordinate, point.coordinates) * 1000 <= ALONG_ROUTE_M) {
        found.set(point.id, { id: point.id, name: point.tags.name, railway: point.railway, alongKm: round(along, 1) });
      }
    });
  });
  return Array.from(found.values()).sort((a, b) => a.alongKm - b.alongKm);
}

// --- the stage ----------------------------------------------------------------------------------------------

function routeLinks(geometry, places, corridorRows, countryCode) {
  const graph = buildCoordinateGraph(geometry);
  graph.segments.forEach(segment => { segment.kind = 'rail'; });
  const grid = new Grid();
  graph.nodes.forEach((node, key) => grid.add(node.coordinate, key));
  const stationGrid = new Grid();
  geometry.points.filter(point => ['station', 'halt'].includes(point.railway))
    .forEach(point => stationGrid.add(point.coordinates, point));

  const log = message => { if (process.env.ASHLINE_WORLD_QUIET !== '1') console.error('[route] ' + message); };
  log(graph.nodes.size + ' nodes, ' + graph.segments.length + ' segments');
  const snaps = snapBreaks(graph, grid);
  log(snaps + ' breaks snapped');
  const shortGaps = proposeShortGaps(graph, grid, components(graph));
  log(shortGaps + ' short gaps offered');

  const placesById = Object.fromEntries(places.map(place => [place.id, place]));
  const byCorridor = new Map();
  corridorRows.forEach(row => {
    if (!byCorridor.has(row.corridor_id)) byCorridor.set(row.corridor_id, []);
    byCorridor.get(row.corridor_id).push(row);
  });
  // Every link whose two cities both lie in the country the geometry covers. Links shared by several corridors
  // (they all leave Punta Arenas) are routed once.
  const pairs = new Map();
  Array.from(byCorridor.keys()).sort().forEach(corridorId => {
    const rows = byCorridor.get(corridorId).sort((a, b) => Number(a.sequence) - Number(b.sequence));
    for (let index = 0; index < rows.length - 1; index++) {
      const from = placesById[rows[index].place_id];
      const to = placesById[rows[index + 1].place_id];
      if (from.countryCode !== countryCode || to.countryCode !== countryCode) continue;
      const pairId = from.id + '>' + to.id;
      if (!pairs.has(pairId)) pairs.set(pairId, { from, to, planningLinkIds: [] });
      pairs.get(pairId).planningLinkIds.push('plan:' + corridorId + ':' + String(index + 1).padStart(2, '0'));
    }
  });

  const anchors = {};
  const anchorFor = place => anchors[place.id] || (anchors[place.id] = anchorPlace(graph, grid, stationGrid, place));
  const links = Array.from(pairs.entries()).map(([pairId, pair]) => {
    const fromAnchor = anchorFor(pair.from);
    const toAnchor = anchorFor(pair.to);
    const { steps, longGaps } = routeLink(graph, fromAnchor, toAnchor);
    const id = 'route:' + pairId;
    const slices = sliceRoute(graph, steps, id);
    const gaps = steps.filter(step => step.segment.kind === 'gap' || step.segment.kind === 'long-gap').map(step => ({
      kind: step.segment.kind,
      distanceKm: round(step.segment.distanceKm, 3),
      from: graph.nodes.get(step.from).coordinate.map(value => round(value, 5)),
      to: graph.nodes.get(step.to).coordinate.map(value => round(value, 5))
    }));
    const railKm = slices.reduce((sum, slice) => sum + slice.railKm, 0);
    const gapKm = slices.reduce((sum, slice) => sum + slice.gapKm, 0);
    return {
      id,
      from: pair.from.id,
      to: pair.to.id,
      planningLinkIds: pair.planningLinkIds.sort(),
      chordKm: round(haversineKm([pair.from.longitude, pair.from.latitude], [pair.to.longitude, pair.to.latitude]), 1),
      routedKm: round(railKm + gapKm, 1),
      railKm: round(railKm, 1),
      gapKm: round(gapKm, 1),
      status: gapKm > 0 ? 'rail-with-gap-proposals' : 'rail-routed',
      fromAnchor: { ...fromAnchor, key: undefined },
      toAnchor: { ...toAnchor, key: undefined },
      gaps,
      longGapCount: longGaps.length,
      stations: stationsAlong(graph, steps, stationGrid),
      sliceCount: slices.length,
      slices,
      navigable: false,
      reviewRequired: true
    };
  });
  return { snaps, shortGaps, links };
}

function reportMarkdown(result) {
  const lines = [
    '# ' + result.label,
    '',
    'Generated by `npm run world:route:chile`. Nothing here is playable: every route is a proposal for review, and',
    'every gap is new track that does not exist in OpenStreetMap. Rail figures include all lifecycle statuses.',
    '',
    '| Link | Chord | Routed | On rail | Gap fills | Stations on route |',
    '| --- | ---: | ---: | ---: | ---: | ---: |'
  ];
  result.links.forEach(link => {
    lines.push('| ' + link.from + ' → ' + link.to + ' | ' + link.chordKm + ' km | ' + link.routedKm + ' km | ' +
      link.railKm + ' km | ' + link.gapKm + ' km in ' + link.gaps.length + ' | ' + link.stations.length + ' |');
  });
  lines.push('', 'Network repairs: ' + result.stats.snaps + ' digitizing breaks under ' + SNAP_M + ' m snapped; ' +
    result.stats.shortGaps + ' candidate short gaps under ' + GAP_KM + ' km offered to routing (rail costs ' +
    GAP_PENALTY + '× less than a gap per km).', '');
  result.links.forEach(link => {
    lines.push('## ' + link.from + ' → ' + link.to, '');
    const anchor = value => value.kind === 'station' ? 'station ' + (value.name || value.pointId) + ' (' + value.distanceKm + ' km from the city)'
      : value.kind === 'track' ? 'nearest track, ' + value.distanceKm + ' km from the city' : 'no track within ' + ANCHOR_KM + ' km: the city itself';
    lines.push('- Starts at ' + anchor(link.fromAnchor) + '.');
    lines.push('- Ends at ' + anchor(link.toAnchor) + '.');
    if (!link.gaps.length) {
      lines.push('- Runs entirely on mapped rail.');
    } else {
      lines.push('- Gap fills proposed for review:');
      link.gaps.slice().sort((a, b) => b.distanceKm - a.distanceKm).forEach(gap => {
        lines.push('  - ' + gap.kind + ', ' + gap.distanceKm + ' km, from ' + gap.from.join(', ') + ' to ' + gap.to.join(', '));
      });
    }
    lines.push('');
  });
  return lines.join('\n');
}

function main() {
  const geometryPath = path.join(root, 'world/imported/chile-rail.json');
  assert(fs.existsSync(geometryPath),
    'Missing ' + path.relative(root, geometryPath) + '. Run: npm run world:extract:chile:national -- --input /path/to/chile-260920.osm.pbf');
  const bytes = fs.readFileSync(geometryPath);
  const geometry = JSON.parse(bytes.toString('utf8'));
  const places = parseCsv(fs.readFileSync(path.join(root, 'world/authored/places.csv'), 'utf8')).map(row => ({
    id: row.place_id, name: row.name, countryCode: row.country_code,
    latitude: Number(row.latitude), longitude: Number(row.longitude)
  }));
  const corridorRows = parseCsv(fs.readFileSync(path.join(root, 'world/authored/corridors.csv'), 'utf8'));
  const routed = routeLinks(geometry, places, corridorRows, 'CL');
  const result = {
    formatVersion: 1,
    id: 'chile-routed-links',
    label: 'Chile planning links routed over OpenStreetMap rail',
    geometryId: geometry.id,
    sourceId: geometry.sourceId,
    geometrySha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    tileKm: TILE_KM,
    parameters: { snapM: SNAP_M, gapKm: GAP_KM, gapPenalty: GAP_PENALTY, anchorKm: ANCHOR_KM,
      stationAnchorKm: STATION_ANCHOR_KM, stationSnapKm: STATION_SNAP_KM, simplifyDegrees: SIMPLIFY_DEGREES },
    navigable: false,
    reviewRequired: true,
    stats: { snaps: routed.snaps, shortGaps: routed.shortGaps, linkCount: routed.links.length },
    links: routed.links
  };
  const outputPath = path.join(root, 'world/proposals/chile-routed-links.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, formatJson(result));
  const reportPath = path.join(root, 'world/proposals/chile-routed-links.md');
  fs.writeFileSync(reportPath, reportMarkdown(result) + '\n');
  result.links.forEach(link => {
    console.log(link.from + ' → ' + link.to + ': ' + link.routedKm + ' km routed (' + link.railKm + ' km rail, ' +
      link.gapKm + ' km in ' + link.gaps.length + ' gap fills), ' + link.sliceCount + ' slices, ' + link.stations.length + ' stations');
  });
  console.log('Wrote ' + path.relative(root, outputPath) + ' and ' + path.relative(root, reportPath));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { routeLinks, sliceRoute, simplify, SNAP_M, GAP_KM, GAP_PENALTY };
