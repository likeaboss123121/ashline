// The playable railway network of a continent, on the shared geographic grid.
//
// Every mapped railway in the geometry import is traced across the 5 km squares of the grid in
// scripts/world/projection.cjs. Two squares are joined where a line runs from one into the other, so junctions,
// branches and spurs to termini are simply squares where several lines meet or one line ends. The network is then
// made whole:
//
//   1. Separate pieces of track within SHORT_BRIDGE_KM of each other are joined by the shortest new line between
//      them, as a break in the mapping or a missing connection usually is.
//   2. Pieces still apart are joined into one network by the shortest set of new lines that connects them all (a
//      minimum spanning tree). A piece is only worth joining if it holds MIN_PIECE_KM of track or serves one of the
//      authored cities; a city with no railway at all is joined as a piece of its own.
//   3. Every new line longer than STRAIGHT_BRIDGE_KM is laid over the terrain and through the towns on the way
//      (scripts/world/terrain-path.cjs), not drawn straight.
//
// Whatever is still not connected to the network the first station stands on is left out, and reported.
//
// Stops are the authored cities, the named OSM stations on the network, and settlements on new lines; a section of
// line with no stop for more than MAX_SECTION_KM gets halts. Elevation is resampled from Copernicus GLO-90 straight
// onto the grid squares in one pass.
//
// Then two kinds of join are added to the one network:
//
//   4. Stub joins: a line that ends close to other track it can only reach the long way round is joined to it.
//   5. Authored joins: world/authored/network-joins.json lists lines to lay by hand, from one point near the network
//      to another. Use it for a connection the rules above miss.
//
// Usage: npm run world:network:south-america
// Needs the geometry, station and settlement imports, and the elevation tile cache (ASHLINE_DEM_CACHE).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const projection = require('./projection.cjs');
const terrain = require('./terrain-path.cjs');
const { defaultCache, copernicusTileName, fetchTiles } = require('./dem.cjs');
const { parseCsv } = require('./csv.cjs');

const root = path.resolve(__dirname, '../..');
const TRACE_STEPS_PER_CELL = 8;
const SHORT_BRIDGE_KM = 30;
const STRAIGHT_BRIDGE_KM = 10;
const LONG_BRIDGE_MAX_KM = 1500;
const MIN_PIECE_KM = 15;
const CITY_REACH_KM = 10;
const BRIDGE_MIN_KM = 0.2;
const TUNNEL_MIN_SHARE = 0.5;
const MAX_SECTION_KM = 100;
const HALT_NAME_KM = 15;
// An unnamed dead end shorter than this is a yard track, a siding or a tracing stub, and is pruned; a spur with a
// station at its end is kept however short.
const MIN_STUB_KM = 10;
// A line that ends within STUB_JOIN_KM of other track is joined to it, where getting there along the track would be
// a long way round: at least STUB_DETOUR_FACTOR times as far, and more than STUB_DETOUR_MIN_KM. That is a break in the
// mapping, a lifted junction, or a branch stopping short of a new line; the rule never loops a branch back onto the
// line it has just left.
const STUB_JOIN_KM = 25;
const STUB_DETOUR_FACTOR = 4;
const STUB_DETOUR_MIN_KM = 60;
// An authored join's ends must lie within this of the network.
const AUTHORED_SNAP_KM = 10;
const NODATA = -32768;
const BUILDER_VERSION = 1;
const SCOPE = {
  geometry: 'world/imported/south-america-rail.json',
  stations: 'world/imported/south-america-stations.json',
  settlements: 'world/imported/south-america-places.json',
  output: 'world/network/south-america-network.json',
  id: 'south-america-network',
  label: 'South America railway network'
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  if (process.env.ASHLINE_WORLD_QUIET !== '1') console.error('[network] ' + message);
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const h = Math.sin(radians(b[1] - a[1]) / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const keyOf = (x, y) => x + ',' + y;
const round3 = value => Math.round(value * 1000) / 1000;

// --- tracing ------------------------------------------------------------------------------------------------------

// The squares a line passes through, in order, each with the track of this line inside it. A square that only clips
// the corner between two diagonal neighbours is folded into them, so diagonal track runs straight.
function traceLine(coordinates, grid, extras) {
  const visits = [];
  for (let index = 1; index < coordinates.length; index++) {
    const a = coordinates[index - 1], b = coordinates[index], km = haversineKm(a, b);
    if (!(km > 0)) continue;
    const steps = Math.max(1, Math.ceil(km / (grid.cellKm / TRACE_STEPS_PER_CELL)));
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const cell = projection.cellOf([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], grid);
      let visit = visits.at(-1);
      if (!visit || visit.x !== cell[0] || visit.y !== cell[1]) {
        visit = { x: cell[0], y: cell[1], km: 0 };
        visits.push(visit);
      }
      visit.km += km / steps;
    }
  }
  for (let index = 1; index < visits.length - 1;) {
    const before = visits[index - 1], corner = visits[index], after = visits[index + 1];
    const touching = Math.max(Math.abs(before.x - after.x), Math.abs(before.y - after.y)) === 1;
    if (touching) {
      before.km += corner.km / 2;
      after.km += corner.km / 2;
      visits.splice(index, 1);
      if (index > 1) index--;
    } else {
      index++;
    }
  }
  // A line that doubles straight back (A, B, A) leaves two visits of one square side by side once corners are cut.
  for (let index = 1; index < visits.length;) {
    if (visits[index].x === visits[index - 1].x && visits[index].y === visits[index - 1].y) {
      visits[index - 1].km += visits[index].km;
      visits.splice(index, 1);
    } else {
      index++;
    }
  }
  return visits.map(visit => ({ ...visit, ...extras }));
}

class Network {
  constructor() {
    this.squares = new Map();
    this.edges = new Map();
  }
  square(x, y) {
    const key = keyOf(x, y);
    if (!this.squares.has(key)) {
      this.squares.set(key, { key, x, y, km: 0, railKm: 0, bridgeKm: 0, tunnelKm: 0, wayIds: new Set(), statuses: new Set() });
    }
    return this.squares.get(key);
  }
  // Adds one traced line. A move between two neighbouring squares costs half the line's track in each, or all of it
  // in a square the line ends in; where several lines make the same move, the most direct one sets its cost.
  add(visits, way) {
    visits.forEach(visit => {
      const square = this.square(visit.x, visit.y);
      square.km += visit.km;
      if (way.gap) {
        square.gapKm = (square.gapKm || 0) + visit.km;
      } else {
        square.railKm += visit.km;
        square.bridgeKm += visit.km * way.bridgeShare;
        square.tunnelKm += visit.km * way.tunnelShare;
        square.wayIds.add(way.id);
        square.statuses.add(way.status);
      }
    });
    const last = visits.length - 1;
    for (let index = 0; index < last; index++) {
      const a = visits[index], b = visits[index + 1];
      const km = (index === 0 ? a.km : a.km / 2) + (index + 1 === last ? b.km : b.km / 2);
      const [first, second] = keyOf(a.x, a.y) < keyOf(b.x, b.y) ? [a, b] : [b, a];
      const key = keyOf(first.x, first.y) + '|' + keyOf(second.x, second.y);
      const existing = this.edges.get(key);
      if (!existing) {
        this.edges.set(key, { key, a: keyOf(first.x, first.y), b: keyOf(second.x, second.y), km, gap: !!way.gap });
      } else if (km < existing.km) {
        existing.km = km;
        existing.gap = existing.gap && !!way.gap;
      } else if (!way.gap) {
        existing.gap = false;
      }
    }
  }
  neighbours() {
    const result = new Map();
    this.squares.forEach((_, key) => result.set(key, []));
    this.edges.forEach(edge => { result.get(edge.a).push(edge.b); result.get(edge.b).push(edge.a); });
    return result;
  }
  // Connected pieces: each a list of square keys, with the track they hold.
  pieces() {
    const adjacent = this.neighbours(), seen = new Set(), pieces = [];
    Array.from(this.squares.keys()).sort().forEach(start => {
      if (seen.has(start)) return;
      const keys = [], stack = [start];
      seen.add(start);
      while (stack.length) {
        const key = stack.pop();
        keys.push(key);
        adjacent.get(key).forEach(next => { if (!seen.has(next)) { seen.add(next); stack.push(next); } });
      }
      pieces.push({ keys, km: keys.reduce((sum, key) => sum + this.squares.get(key).km, 0) });
    });
    return pieces;
  }
}

// --- bridging -----------------------------------------------------------------------------------------------------

function unionFind(count) {
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  return { find, join: (a, b) => { a = find(a); b = find(b); if (a === b) return false; parent[b] = a; return true; } };
}

function gridKm(a, b, grid) {
  return Math.hypot(a.x - b.x, a.y - b.y) * grid.cellKm;
}

// Candidate joins between pieces that come within SHORT_BRIDGE_KM of each other: for each pair of pieces, the
// nearest pair of squares.
function shortCandidates(network, pieceOf, grid) {
  const reach = Math.ceil(SHORT_BRIDGE_KM / grid.cellKm), best = new Map();
  network.squares.forEach(square => {
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const other = network.squares.get(keyOf(square.x + dx, square.y + dy));
        if (!other || pieceOf.get(other.key) === pieceOf.get(square.key)) continue;
        const km = gridKm(square, other, grid);
        if (km > SHORT_BRIDGE_KM) continue;
        const [p, q] = [pieceOf.get(square.key), pieceOf.get(other.key)].sort((a, b) => a - b);
        const pair = p + '|' + q;
        const current = best.get(pair);
        if (!current || km < current.km || (km === current.km && square.key + other.key < current.from + current.to)) {
          best.set(pair, { p, q, from: square.key, to: other.key, km });
        }
      }
    }
  });
  return Array.from(best.values());
}

function boxOf(network, keys) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  keys.forEach(key => {
    const square = network.squares.get(key);
    box[0] = Math.min(box[0], square.x); box[1] = Math.min(box[1], square.y);
    box[2] = Math.max(box[2], square.x); box[3] = Math.max(box[3], square.y);
  });
  return box;
}

// Joins groups of squares into one network by the shortest set of new lines (Borůvka's method): each round, every
// group finds its nearest other group through one shared bucket index, and all those joins are made at once.
function longJoins(network, groups, grid) {
  const BUCKET = 20, groupOf = new Map(), index = new Map();
  groups.forEach((group, number) => group.keys.forEach(key => {
    groupOf.set(key, number);
    const square = network.squares.get(key), bucket = Math.floor(square.x / BUCKET) + ',' + Math.floor(square.y / BUCKET);
    if (!index.has(bucket)) index.set(bucket, []);
    index.get(bucket).push(key);
  }));
  const sets = unionFind(groups.length), joins = [];
  const maxRing = Math.ceil(LONG_BRIDGE_MAX_KM / (BUCKET * grid.cellKm)) + 1;
  for (let round = 0; round < 40; round++) {
    const cheapest = new Map();
    groupOf.forEach((number, key) => {
      const root = sets.find(number), square = network.squares.get(key);
      const bx = Math.floor(square.x / BUCKET), by = Math.floor(square.y / BUCKET);
      for (let ring = 0; ring <= maxRing; ring++) {
        const best = cheapest.get(root);
        if (best && (ring - 1) * BUCKET * grid.cellKm > best.km) break;
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            (index.get((bx + dx) + ',' + (by + dy)) || []).forEach(otherKey => {
              if (sets.find(groupOf.get(otherKey)) === root) return;
              const km = gridKm(square, network.squares.get(otherKey), grid);
              if (km > LONG_BRIDGE_MAX_KM) return;
              const current = cheapest.get(root);
              if (!current || km < current.km || (km === current.km && key + otherKey < current.from + current.to)) {
                cheapest.set(root, { from: key, to: otherKey, km });
              }
            });
          }
        }
      }
    });
    let joined = 0;
    Array.from(cheapest.values()).sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to)).forEach(join => {
      if (sets.join(groupOf.get(join.from), groupOf.get(join.to))) { joins.push(join); joined++; }
    });
    log('long joins, round ' + (round + 1) + ': ' + joined + ' made');
    if (!joined) break;
  }
  return joins;
}

// --- laying new lines --------------------------------------------------------------------------------------------

// Lays a new line between two network squares and adds it to the network: straight when short, over the terrain and
// through the towns on the way when not. Returns the record of what was laid.
function layLine(network, join, context) {
  const { grid, settlements, cache } = context;
  const a = network.squares.get(join.from), b = network.squares.get(join.to);
  const from = projection.centreOf([a.x, a.y], grid), to = projection.centreOf([b.x, b.y], grid);
  const straightKm = haversineKm(from, to);
  let coordinates = [from, to], via = [], waterKm = 0;
  if (straightKm > STRAIGHT_BRIDGE_KM) {
    const laid = terrain.terrainPath(from, to, settlements, cache);
    if (laid) { coordinates = laid.coordinates; via = laid.via; waterKm = laid.waterKm; }
  }
  let km = 0;
  for (let point = 1; point < coordinates.length; point++) km += haversineKm(coordinates[point - 1], coordinates[point]);
  const visits = traceLine(coordinates, grid, {});
  // A line from one square's middle to another's always starts and ends in them.
  if (visits[0].x !== a.x || visits[0].y !== a.y) visits.unshift({ x: a.x, y: a.y, km: 0 });
  if (visits.at(-1).x !== b.x || visits.at(-1).y !== b.y) visits.push({ x: b.x, y: b.y, km: 0 });
  network.add(visits, { id: join.kind + ':' + join.from + '>' + join.to, gap: true });
  return { from: join.from, to: join.to, kind: join.kind, ...(join.note ? { note: join.note } : {}),
    straightKm: round3(straightKm), km: round3(km), waterKm: Math.round(waterKm * 10) / 10, via,
    coordinates: coordinates.map(point => [Math.round(point[0] * 1e5) / 1e5, Math.round(point[1] * 1e5) / 1e5]) };
}

// Track distances from one square outward, up to a limit. extra holds joins not yet laid, as { key: [[other, km]] }.
function distancesAlong(network, adjacent, start, limitKm, extra = {}) {
  const distance = new Map([[start, 0]]), queue = [[0, start]];
  while (queue.length) {
    queue.sort((p, q) => p[0] - q[0]);
    const [km, key] = queue.shift();
    if (km > distance.get(key)) continue;
    const steps = adjacent.get(key).map(next => [next, network.edges.get(key < next ? key + '|' + next : next + '|' + key).km])
      .concat(extra[key] || []);
    steps.forEach(([next, stepKm]) => {
      const total = km + stepKm;
      if (total <= limitKm && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); queue.push([total, next]); }
    });
  }
  return distance;
}

// Joins for line ends: each end's nearest track within STUB_JOIN_KM that the track only reaches the long way round.
// They are accepted shortest first, each checked against the network with the joins already accepted, so one join
// that already gives a short way round makes another redundant rather than closing a small loop.
function stubJoins(network, grid) {
  const adjacent = network.neighbours(), reach = Math.ceil(STUB_JOIN_KM / grid.cellKm);
  const limitKm = Math.max(STUB_DETOUR_MIN_KM, STUB_JOIN_KM * STUB_DETOUR_FACTOR);
  const isLongWayRound = (byTrack, km) => byTrack === undefined || byTrack > Math.max(STUB_DETOUR_MIN_KM, km * STUB_DETOUR_FACTOR);
  const candidates = [];
  Array.from(network.squares.keys()).sort().filter(key => adjacent.get(key).length === 1).forEach(end => {
    const square = network.squares.get(end), along = distancesAlong(network, adjacent, end, limitKm);
    let best = null;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const other = network.squares.get(keyOf(square.x + dx, square.y + dy));
        if (!other || other.key === end) continue;
        const km = gridKm(square, other, grid);
        if (km > STUB_JOIN_KM || !isLongWayRound(along.get(other.key), km)) continue;
        if (!best || km < best.km || (km === best.km && other.key < best.to)) best = { from: end, to: other.key, km };
      }
    }
    if (best) candidates.push(best);
  });
  candidates.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
  const accepted = [], extra = {};
  candidates.forEach(candidate => {
    const along = distancesAlong(network, adjacent, candidate.from, limitKm, extra);
    if (!isLongWayRound(along.get(candidate.to), candidate.km)) return;
    accepted.push(candidate);
    (extra[candidate.from] = extra[candidate.from] || []).push([candidate.to, candidate.km]);
    (extra[candidate.to] = extra[candidate.to] || []).push([candidate.from, candidate.km]);
  });
  return accepted;
}

// --- elevation ----------------------------------------------------------------------------------------------------

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with ' + (result.signal ? 'signal ' + result.signal : 'status ' + result.status)
    + ': ' + result.stderr);
  return result.stdout;
}

// Mean elevation and the spread of heights within every square, resampled from the elevation tiles onto the grid in
// one pass. The grid is the projection itself, so each output cell is exactly one square.
function sampleElevation(network, grid, cache) {
  const box = boxOf(network, Array.from(network.squares.keys()));
  const tiles = new Set();
  network.squares.forEach(square => {
    [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]].forEach(([dx, dy]) => {
      const point = projection.centreOf([square.x + dx, square.y + dy], grid);
      tiles.add(copernicusTileName(point[0], point[1]));
    });
  });
  log('elevation: ' + tiles.size + ' tiles under ' + network.squares.size + ' squares');
  const files = fetchTiles(Array.from(tiles).sort(), cache);
  const origin = projection.project(grid.origin, grid);
  const width = box[2] - box[0] + 1, height = box[3] - box[1] + 1;
  const extent = [(origin[0] + (box[0] - 0.5) * grid.cellKm) * 1000, (origin[1] + (box[1] - 0.5) * grid.cellKm) * 1000,
    (origin[0] + (box[2] + 0.5) * grid.cellKm) * 1000, (origin[1] + (box[3] + 0.5) * grid.cellKm) * 1000];
  const srs = '+proj=laea +lat_0=' + grid.centre[1] + ' +lon_0=' + grid.centre[0] + ' +x_0=0 +y_0=0 +R=' +
    (projection.EARTH_RADIUS_KM * 1000) + ' +units=m +no_defs';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-network-dem-'));
  const rasters = {};
  try {
    const list = path.join(temporary, 'tiles.txt');
    fs.writeFileSync(list, files.join('\n') + '\n');
    const vrt = path.join(temporary, 'dem.vrt');
    run('gdalbuildvrt', ['-q', '-vrtnodata', String(NODATA), '-input_file_list', list, vrt]);
    ['average', 'rms'].forEach(method => {
      log('elevation: resampling onto the grid (' + method + ')');
      const output = path.join(temporary, method + '.bin');
      // A modest working buffer on one thread: this runs beside everything else the build holds in memory.
      run('gdalwarp', ['-q', '-overwrite', '-wm', '256', '-t_srs', srs, '-te', ...extent.map(String),
        '-ts', String(width), String(height), '-r', method, '-srcnodata', String(NODATA), '-dstnodata', String(NODATA),
        '-ot', 'Float32', '-of', 'ENVI', vrt, output]);
      const bytes = fs.readFileSync(output);
      rasters[method] = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + width * height * 4));
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  network.squares.forEach(square => {
    const index = (box[3] - square.y) * width + (square.x - box[0]);
    const mean = rasters.average[index], rms = rasters.rms[index];
    if (mean === NODATA || !Number.isFinite(mean)) {
      square.elevationM = 0; square.elevationStdDevM = 0;
    } else {
      square.elevationM = Math.round(mean * 10) / 10;
      square.elevationStdDevM = Math.round(Math.sqrt(Math.max(0, rms * rms - mean * mean)) * 10) / 10;
    }
  });
  return files.map(file => path.basename(file)).sort();
}

// --- stops --------------------------------------------------------------------------------------------------------

function rank(stop) {
  if (stop.status === 'city') return 100;
  if (stop.status === 'halt' || stop.status === 'junction' || stop.status === 'end') return 0;
  if (stop.status === 'settlement') return { city: 38, town: 28, village: 15 }[stop.kind] || 15;
  const working = stop.status === 'active';
  if (stop.kind === 'halt') return working ? 30 : 5;
  return (working ? 40 : 10) + (stop.category ? 4 - stop.category : 0);
}

// The network square a point stands on, or the nearest network square touching it; null when neither exists.
function squareFor(network, point, grid) {
  const cell = projection.cellOf(point, grid);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const square = network.squares.get(keyOf(cell[0] + dx, cell[1] + dy));
      if (!square) continue;
      const km = haversineKm(point, projection.centreOf([square.x, square.y], grid));
      if (!best || km < best.km) best = { square, km };
    }
  }
  return best;
}

// --- the stage ----------------------------------------------------------------------------------------------------

function buildNetwork(options) {
  const { geometry, stations, settlements, cities, grid, cache } = options;
  const network = new Network();
  log('tracing ' + geometry.ways.length + ' ways');
  geometry.ways.forEach(way => {
    const visits = traceLine(way.coordinates, grid, {});
    const share = tag => way.lengthKm > 0 && way.tags[tag] && way.tags[tag] !== 'no' ? 1 : 0;
    network.add(visits, { id: way.id, status: way.railwayStatus, bridgeShare: share('bridge'), tunnelShare: share('tunnel') });
  });
  // The traced squares hold everything the rest of the build needs; the geometry is the largest thing in memory.
  geometry.ways = null;
  // Authored cities must be reachable: each is joined to the square nearest it within reach, or stands as a piece of
  // its own when no railway comes near.
  const cityStops = cities.map(city => {
    const point = [city.longitude, city.latitude];
    const found = squareFor(network, point, grid);
    let square;
    if (found && found.km <= CITY_REACH_KM) {
      square = found.square;
    } else {
      const cell = projection.cellOf(point, grid);
      square = network.square(cell[0], cell[1]);
      square.cityOnly = true;
    }
    return { id: 'place:' + city.id, name: city.name, status: 'city', square: square.key, coordinates: point };
  });
  const mustKeep = new Set(cityStops.map(stop => stop.square));

  let pieces = network.pieces();
  log(network.squares.size + ' squares, ' + network.edges.size + ' moves, ' + pieces.length + ' separate pieces');
  const bridges = [];
  const pieceIndex = () => {
    const pieceOf = new Map();
    pieces.forEach((piece, index) => piece.keys.forEach(key => pieceOf.set(key, index)));
    return pieceOf;
  };
  // 1. Short joins, shortest first, between any two pieces.
  let pieceOf = pieceIndex(), sets = unionFind(pieces.length);
  shortCandidates(network, pieceOf, grid).sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to))
    .forEach(candidate => { if (sets.join(candidate.p, candidate.q)) bridges.push({ from: candidate.from, to: candidate.to, km: candidate.km, kind: 'short' }); });
  // 2. Long joins between the groups the short joins left, among those worth joining.
  const groups = new Map();
  pieces.forEach((piece, index) => {
    const root = sets.find(index);
    if (!groups.has(root)) groups.set(root, { keys: [], km: 0 });
    groups.get(root).keys.push(...piece.keys);
    groups.get(root).km += piece.km;
  });
  const worth = Array.from(groups.values()).filter(group => group.km >= MIN_PIECE_KM || group.keys.some(key => mustKeep.has(key)));
  log(groups.size + ' groups after short joins, ' + worth.length + ' worth joining');
  longJoins(network, worth, grid).forEach(join => bridges.push({ ...join, kind: 'long' }));
  log(bridges.length + ' new lines to lay (' + bridges.filter(bridge => bridge.kind === 'long').length + ' long)');

  // 3. Lay the new lines: straight when short, over the terrain and through towns when not.
  const context = { grid, settlements, cache };
  bridges.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
  const laidLines = bridges.map((bridge, index) => {
    if (bridge.km > 100) log('laying new line ' + (index + 1) + ' of ' + bridges.length + ', ' + Math.round(bridge.km) + ' km straight');
    return layLine(network, bridge, context);
  });

  // 4. Keep the network the first city stands on.
  pieces = network.pieces();
  const startKey = cityStops[0].square;
  const main = pieces.find(piece => piece.keys.includes(startKey));
  const kept = new Set(main.keys);
  const dropped = pieces.filter(piece => piece !== main);
  const droppedKm = dropped.reduce((sum, piece) => sum + piece.km, 0);
  Array.from(network.squares.keys()).forEach(key => { if (!kept.has(key)) network.squares.delete(key); });
  Array.from(network.edges.keys()).forEach(key => {
    const edge = network.edges.get(key);
    if (!kept.has(edge.a)) network.edges.delete(key);
  });
  const lostCities = cityStops.filter(stop => !kept.has(stop.square)).map(stop => stop.name);
  log('kept ' + network.squares.size + ' squares; left out ' + dropped.length + ' isolated pieces (' + Math.round(droppedKm) + ' km)');

  // 4. Authored joins, then stub joins: the rules can miss what a person sees, and a line ends differently once a
  // join has been laid to it.
  (options.authoredJoins || []).forEach(join => {
    const ends = [join.from, join.to].map(point => {
      const cell = projection.cellOf(point, grid);
      let best = null;
      const reach = Math.ceil(AUTHORED_SNAP_KM / grid.cellKm);
      for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        const square = network.squares.get(keyOf(cell[0] + dx, cell[1] + dy));
        if (!square) continue;
        const km = haversineKm(point, projection.centreOf([square.x, square.y], grid));
        if (km <= AUTHORED_SNAP_KM && (!best || km < best.km)) best = { key: square.key, km };
      }
      assert(best, 'Authored join end ' + point.join(',') + ' is not within ' + AUTHORED_SNAP_KM + ' km of the network' +
        (join.note ? ' (' + join.note + ')' : ''));
      return best.key;
    });
    laidLines.push(layLine(network, { from: ends[0], to: ends[1], kind: 'authored', note: join.note }, context));
  });
  const stubs = stubJoins(network, grid);
  log(stubs.length + ' line ends joined to track they only reached the long way round');
  stubs.forEach(join => laidLines.push(layLine(network, { ...join, kind: 'stub' }, context)));

  // 5. Stops: one per square, the highest ranked.
  const candidates = cityStops.filter(stop => kept.has(stop.square)).map(stop => ({ ...stop }));
  stations.forEach(station => {
    const found = squareFor(network, station.coordinates, grid);
    if (!found) return;
    candidates.push({ id: station.id, name: station.name, status: station.status, kind: station.kind,
      category: station.category, square: found.square.key, coordinates: station.coordinates });
  });
  // Settlements on new lines, where no station was ever mapped.
  const newSquares = new Set();
  network.squares.forEach(square => { if ((square.gapKm || 0) > square.railKm) newSquares.add(square.key); });
  settlements.forEach(settlement => {
    const cell = projection.cellOf(settlement.coordinates, grid), key = keyOf(cell[0], cell[1]);
    if (!newSquares.has(key)) return;
    candidates.push({ id: settlement.id, name: settlement.name, status: 'settlement', kind: settlement.kind, square: key,
      coordinates: settlement.coordinates });
  });
  const pickStops = () => {
    const chosen = new Map();
    candidates.forEach(candidate => {
      if (!network.squares.has(candidate.square)) return;
      const current = chosen.get(candidate.square);
      if (!current || rank(candidate) > rank(current) || (rank(candidate) === rank(current) && candidate.id < current.id)) {
        chosen.set(candidate.square, candidate);
      }
    });
    return chosen;
  };
  let stopBySquare = pickStops();

  // Prune stubs: walk in from every dead end with no stop on it; if the run back to a junction or a stop is short,
  // remove it. Repeat, since removing one stub can leave another.
  let pruned = 0;
  for (let changed = true; changed;) {
    changed = false;
    const adjacentNow = network.neighbours();
    Array.from(network.squares.keys()).sort().forEach(end => {
      if (!network.squares.has(end) || stopBySquare.has(end) || adjacentNow.get(end).length !== 1) return;
      const run = [end];
      let previous = null, current = end, km = 0;
      for (;;) {
        const next = adjacentNow.get(current).find(key => key !== previous && network.squares.has(key));
        if (!next) break;
        km += network.edges.get(current < next ? current + '|' + next : next + '|' + current).km;
        if (stopBySquare.has(next) || adjacentNow.get(next).length !== 2 || km >= MIN_STUB_KM) break;
        run.push(next);
        previous = current;
        current = next;
      }
      if (km >= MIN_STUB_KM) return;
      run.forEach(key => {
        network.squares.delete(key);
        adjacentNow.get(key).forEach(other => network.edges.delete(key < other ? key + '|' + other : other + '|' + key));
      });
      pruned += run.length;
      changed = true;
    });
    Array.from(network.edges.keys()).forEach(key => {
      const edge = network.edges.get(key);
      if (!network.squares.has(edge.a) || !network.squares.has(edge.b)) network.edges.delete(key);
    });
  }
  stopBySquare = pickStops();
  log('pruned ' + pruned + ' squares of short unnamed stubs');

  // Every junction and every end of the line is a stop, so the track between stops is always one plain line.
  const nearestSettlementName = point => {
    let best = null;
    settlements.forEach(settlement => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > 1) return;
      const km = haversineKm(point, settlement.coordinates);
      if (!best || km < best.km) best = { name: settlement.name, km };
    });
    return best ? best.name : null;
  };
  let nodeStops = 0;
  const adjacentNodes = network.neighbours();
  Array.from(network.squares.keys()).sort().forEach(key => {
    const degree = adjacentNodes.get(key).length;
    if (degree === 2 || stopBySquare.has(key)) return;
    const square = network.squares.get(key), centre = projection.centreOf([square.x, square.y], grid);
    stopBySquare.set(key, { id: (degree === 1 ? 'end:' : 'junction:') + key, status: degree === 1 ? 'end' : 'junction',
      square: key, coordinates: centre, name: nearestSettlementName(centre) || 'Junction' });
    nodeStops++;
  });
  log(nodeStops + ' junctions and line ends without a station made stops');

  // 6. Halts on long sections: runs of track between stops, junctions and ends with nowhere to stop.
  const adjacent = network.neighbours();
  const edgeKm = (a, b) => network.edges.get(a < b ? a + '|' + b : b + '|' + a).km;
  const isNode = key => stopBySquare.has(key) || adjacent.get(key).length !== 2;
  const walked = new Set();
  const nearestSettlement = point => {
    let best = null;
    settlements.forEach(settlement => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > 0.2) return;
      const km = haversineKm(point, settlement.coordinates);
      if (km <= HALT_NAME_KM && (!best || km < best.km)) best = { settlement, km };
    });
    return best && best.settlement;
  };
  let halts = 0;
  Array.from(network.squares.keys()).sort().filter(isNode).forEach(start => {
    adjacent.get(start).slice().sort().forEach(first => {
      const edge = start < first ? start + '|' + first : first + '|' + start;
      if (walked.has(edge)) return;
      const run = [start];
      let previous = start, current = first;
      walked.add(edge);
      for (;;) {
        run.push(current);
        if (isNode(current)) break;
        const next = adjacent.get(current).find(key => key !== previous);
        const nextEdge = current < next ? current + '|' + next : next + '|' + current;
        if (walked.has(nextEdge)) break;
        walked.add(nextEdge);
        previous = current;
        current = next;
      }
      const along = [0];
      for (let index = 1; index < run.length; index++) along.push(along[index - 1] + edgeKm(run[index - 1], run[index]));
      const total = along.at(-1), count = Math.ceil(total / MAX_SECTION_KM) - 1;
      const startName = stopBySquare.has(start) ? stopBySquare.get(start).name : null;
      for (let halt = 1; halt <= count; halt++) {
        const target = total * halt / (count + 1);
        let index = 1;
        while (index < run.length - 2 && along[index] < target) index++;
        const key = run[index];
        if (stopBySquare.has(key)) continue;
        const square = network.squares.get(key), centre = projection.centreOf([square.x, square.y], grid);
        const near = nearestSettlement(centre);
        stopBySquare.set(key, { id: 'halt:' + key, status: 'halt', square: key, coordinates: centre,
          name: near ? near.name : (startName ? 'Km ' + Math.round(along[index]) + ' from ' + startName : 'Km ' + Math.round(along[index])) });
        halts++;
      }
    });
  });
  log(stopBySquare.size + ' stops, ' + halts + ' of them halts on long sections');

  // 7. Elevation.
  const tiles = sampleElevation(network, grid, cache);

  // Assemble, in a fixed order: squares by key, moves by key, stops by square.
  const squareKeys = Array.from(network.squares.keys()).sort();
  const squares = squareKeys.map(key => {
    const square = network.squares.get(key), gapKm = square.gapKm || 0;
    const ends = adjacent.get(key).map(other => {
      const next = network.squares.get(other);
      // A line that only clips two squares' edges holds little track in them; a move is never shorter than most of
      // the distance between their middles.
      const floorKm = 0.8 * Math.hypot(next.x - square.x, next.y - square.y) * grid.cellKm;
      return { dx: next.x - square.x, dy: next.y - square.y, km: round3(Math.max(floorKm, edgeKm(key, other))) };
    }).sort((a, b) => a.dx - b.dx || a.dy - b.dy);
    return {
      x: square.x, y: square.y, centre: projection.centreOf([square.x, square.y], grid),
      km: round3(square.km), railKm: round3(square.railKm), gapKm: round3(gapKm), gapFill: gapKm > square.railKm,
      bridge: square.bridgeKm >= BRIDGE_MIN_KM, tunnel: square.railKm > 0 && square.tunnelKm >= square.railKm * TUNNEL_MIN_SHARE,
      elevationM: square.elevationM, elevationStdDevM: square.elevationStdDevM,
      statuses: Array.from(square.statuses).sort(), sourceWayCount: square.wayIds.size, ends
    };
  });
  const stops = Array.from(stopBySquare.values()).sort((a, b) => a.square.localeCompare(b.square)).map(stop => ({
    id: stop.id, name: stop.name, status: stop.status, ...(stop.kind ? { kind: stop.kind } : {}),
    square: stop.square, coordinates: stop.coordinates.map(value => Math.round(value * 1e7) / 1e7)
  }));
  return {
    squares, stops,
    bridges: laidLines,
    startSquare: startKey,
    stats: {
      squareCount: squares.length,
      moveCount: squares.reduce((sum, square) => sum + square.ends.length, 0) / 2,
      stopCount: stops.length, haltCount: halts,
      bridgeCount: laidLines.length, bridgeKm: Math.round(laidLines.reduce((sum, line) => sum + line.km, 0)),
      stubJoinCount: laidLines.filter(line => line.kind === 'stub').length,
      authoredJoinCount: laidLines.filter(line => line.kind === 'authored').length,
      railKm: Math.round(squares.reduce((sum, square) => sum + square.railKm, 0)),
      leftOutPieces: dropped.length, leftOutKm: Math.round(droppedKm), unreachableCities: lostCities, prunedStubSquares: pruned,
      junctionSquares: squares.filter(square => square.ends.length >= 3).length,
      endSquares: squares.filter(square => square.ends.length === 1).length
    },
    elevationTiles: tiles
  };
}

function writeNetwork(target, artifact) {
  const stream = fs.createWriteStream(target);
  const header = Object.entries(artifact).filter(([key]) => !['squares', 'stops', 'bridges'].includes(key));
  stream.write('{\n' + header.map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join(',\n'));
  ['stops', 'bridges', 'squares'].forEach(key => {
    stream.write(',\n  ' + JSON.stringify(key) + ': [\n');
    artifact[key].forEach((record, index) => stream.write((index ? ',\n' : '') + '    ' + JSON.stringify(record)));
    stream.write('\n  ]');
  });
  stream.write('\n}\n');
  return new Promise((resolve, reject) => { stream.on('error', reject); stream.end(resolve); });
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let read;
  while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  fs.closeSync(descriptor);
  return hash.digest('hex');
}

async function main() {
  const scope = SCOPE;
  [scope.geometry, scope.stations, scope.settlements].forEach(file =>
    assert(fs.existsSync(path.join(root, file)), 'Missing ' + file + '; see world/README.md'));
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const geometry = read(scope.geometry), stationSet = read(scope.stations), settlementSet = read(scope.settlements);
  // Punta Arenas first: the network kept is the one the game starts on.
  const cities = parseCsv(fs.readFileSync(path.join(root, 'world/authored/places.csv'), 'utf8'))
    .map(row => ({ id: row.place_id, name: row.name, latitude: Number(row.latitude), longitude: Number(row.longitude) }))
    .sort((a, b) => (a.id === 'cl-punta-arenas' ? -1 : b.id === 'cl-punta-arenas' ? 1 : a.id.localeCompare(b.id)));
  const grid = projection.GRID, cache = defaultCache();
  const joinsFile = path.join(root, 'world/authored/network-joins.json');
  const authoredJoins = fs.existsSync(joinsFile) ? JSON.parse(fs.readFileSync(joinsFile, 'utf8')).joins : [];
  const built = buildNetwork({ geometry, stations: stationSet.stations, settlements: settlementSet.places, cities, grid, cache,
    authoredJoins });
  const artifact = {
    formatVersion: 1,
    id: scope.id,
    label: scope.label,
    builderVersion: BUILDER_VERSION,
    grid,
    sources: {
      geometry: { id: geometry.id, sourceId: geometry.sourceId, sha256: sha256File(path.join(root, scope.geometry)) },
      stations: { id: stationSet.id, sourceId: stationSet.sourceId },
      settlements: { id: settlementSet.id, sourceId: settlementSet.sourceId },
      elevation: { sourceId: 'copernicus-dem-glo90', aggregation: 'mean-and-population-standard-deviation-within-grid-square',
        tileCount: built.elevationTiles.length }
    },
    parameters: { traceStepsPerCell: TRACE_STEPS_PER_CELL, shortBridgeKm: SHORT_BRIDGE_KM, straightBridgeKm: STRAIGHT_BRIDGE_KM,
      longBridgeMaxKm: LONG_BRIDGE_MAX_KM, minPieceKm: MIN_PIECE_KM, cityReachKm: CITY_REACH_KM, bridgeMinKm: BRIDGE_MIN_KM,
      tunnelMinShare: TUNNEL_MIN_SHARE, maxSectionKm: MAX_SECTION_KM, minStubKm: MIN_STUB_KM, stubJoinKm: STUB_JOIN_KM,
      stubDetourFactor: STUB_DETOUR_FACTOR, stubDetourMinKm: STUB_DETOUR_MIN_KM, authoredSnapKm: AUTHORED_SNAP_KM,
      terrain: terrain.PARAMETERS },
    navigable: true,
    startSquare: built.startSquare,
    stats: built.stats,
    stops: built.stops,
    bridges: built.bridges,
    squares: built.squares
  };
  const target = path.join(root, scope.output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await writeNetwork(target, artifact);
  console.log('Wrote ' + scope.output + ': ' + JSON.stringify(built.stats));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildNetwork, stubJoins, traceLine, Network };
