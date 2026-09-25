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
// Then new lines are added to the one network, each rule standing for a reason a person would give for a line:
//
//   4. Authored routes: world/authored/network-joins.json lists lines to lay by hand, as a list of stops from one
//      place near the network to another, by town name or by coordinates; with "newEnd" the last stop may be where
//      no track is, and the route ends there in a new terminus. Use it for a connection the rules
//      miss, or to send a new line along the way a person would build it.
//   5. Stub joins: a line that ends close to other track it can only reach the long way round is joined to it.
//   6. Facing ends: two lines that both stop short of each other, where going round by track is many times as far,
//      are joined end to end. That is a railway that was never finished or has been lifted: across the Andes, over a
//      border, along a coast. It is what takes the Pacific corridor from Peru into Ecuador.
//   7. Spurs: a rural line with no branch for a long way sends a short spur out to the nearest place off it, an
//      estancia, a mine camp or a village, so there is somewhere to explore off the main line.
//
// Each city's maze of suburban track is then reduced to a hub and the lines into it (simplifyUrban), and every stop
// gets a region, from the people and the mapped track around it:
//
//   - urban: a big population close by. Mapped stations are a kilometre or two apart here, and a railyard at each
//     would be one long yard, so only the larger places get one, well apart (YARD_RULES).
//   - industrial: a lot of mapped track close by but not the people: mines, ports and works. Yards are kept apart
//     a little.
//   - rural: everything else, where every mapped station is a stop.
//
// The game sizes each railyard by its region: small in the country, large in the cities.
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
const { Heap } = terrain;

const root = path.resolve(__dirname, '../..');
const TRACE_STEPS_PER_CELL = 8;
const SHORT_BRIDGE_KM = 30;
const STRAIGHT_BRIDGE_KM = 10;
const LONG_BRIDGE_MAX_KM = 1500;
const MIN_PIECE_KM = 15;
// A long join is only worth laying to a piece of track in proportion to its size: at most LONG_JOIN_PER_TRACK_KM times
// the track of the smaller side, and never under LONG_JOIN_MIN_KM. A scrap of mine railway in the Arctic is not worth
// a thousand kilometres of new line; a piece serving an authored city always is.
const LONG_JOIN_PER_TRACK_KM = 5;
const LONG_JOIN_MIN_KM = 300;
const UNBUILT = new Set(['proposed', 'planned', 'construction']);
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
// Two line ends further apart than a stub join reaches (STUB_JOIN_KM), and up to END_JOIN_KM, are joined when going round by track is at least END_DETOUR_FACTOR times
// as far and END_DETOUR_MIN_KM further. Ends only, so the rule never sends a long new line into the side of a line
// that already serves the area.
const END_JOIN_KM = 600;
const END_DETOUR_FACTOR = 8;
const END_DETOUR_MIN_KM = 800;
// A facing-end join or a spur may cross this much open water and no more: a river, not an estuary or a strait.
const MAX_WATER_KM = 3;
// A spur runs out to a place SPUR_MIN_KM to SPUR_MAX_KM from any track, from a rural line with no junction, line
// end or other spur within SPUR_SPACING_KM along it. Bigger places come first; a name shared by more than
// GENERIC_NAME_COUNT places ("Estancia", "Puesto") says nothing about where it is, and is skipped.
const SPUR_MIN_KM = 8;
const SPUR_MAX_KM = 40;
const SPUR_SPACING_KM = 100;
const GENERIC_NAME_COUNT = 20;
// Regions: urban where URBAN_POPULATION people live within URBAN_RADIUS_KM; industrial where INDUSTRIAL_RAIL_KM of
// mapped track lies within INDUSTRIAL_RADIUS_KM. A place with no population recorded counts as DEFAULT_POPULATION.
const URBAN_POPULATION = 500000;
const URBAN_RADIUS_KM = 20;
const INDUSTRIAL_RAIL_KM = 60;
const INDUSTRIAL_RADIUS_KM = 10;
const DEFAULT_POPULATION = { city: 50000, town: 5000, village: 500 };
// Which stations get a railyard, by region: the smallest population of the place a station serves (the nearest
// settlement within SERVES_KM), and how far along the track it must be from another yard. Junctions, line ends
// and the authored cities are always stops, whatever their region.
const YARD_RULES = {
  rural: { minPopulation: 0, spacingKm: null }, // by DENSITY_RADIUS_KM
  industrial: { minPopulation: 0, spacingKm: 20 },
  urban: { minPopulation: 100000, spacingKm: 40 }
};
const SERVES_KM = 5;
// A new line that comes within a square of existing track for SPLICE_MIN_KM or more joins that track and leaves it
// again, rather than running beside it, as long as the existing track gets between the two points in no more than
// SPLICE_DETOUR_FACTOR times the distance plus SPLICE_DETOUR_KM. So no generated line duplicates one already there.
const SPLICE_MIN_KM = 8;
const SPLICE_DETOUR_FACTOR = 1.5;
const SPLICE_DETOUR_KM = 10;
// Two places of SHORTCUT_POPULATION or more, up to SHORTCUT_KM apart and each within CITY_TRACK_KM of track, get a
// shortcut when going round by track is at least SHORTCUT_DETOUR_FACTOR times as far and SHORTCUT_DETOUR_MIN_KM
// further: Medellín to Apartadó, say, 216 km apart and 1,250 km round.
const SHORTCUT_POPULATION = 100000;
const SHORTCUT_KM = 400;
const SHORTCUT_DETOUR_FACTOR = 4;
const SHORTCUT_DETOUR_MIN_KM = 500;
const CITY_TRACK_KM = 10;
// A stretch of line between two junctions is taken up when another way between the same two junctions is no more
// than PARALLEL_FACTOR times as long plus PARALLEL_EXTRA_KM: two lines side by side, or a loop that saves nothing.
// The least used goes first: new lines, then abandoned, then disused, then working track, and fewer stations first.
const PARALLEL_FACTOR = 1.4;
const PARALLEL_EXTRA_KM = 15;
// In the country, how far apart along the track two yards must be depends on how many people live within
// DENSITY_RADIUS_KM: nowhere near SPARSE_POPULATION, every station; up to DENSE_POPULATION, RURAL_SPACING_KM; beyond,
// DENSE_SPACING_KM. Whatever the region, no two yards stand in squares that touch: the busier place keeps its yard.
const DENSITY_RADIUS_KM = 50;
const SPARSE_POPULATION = 150000;
const DENSE_POPULATION = 1000000;
const RURAL_SPACING_KM = 15;
const DENSE_SPACING_KM = 25;
// An authored route's ends must lie within this of the network.
const AUTHORED_SNAP_KM = 10;
// Two places of the same name and size further apart than this are different places, and the route must say which.
const SAME_PLACE_KM = 20;
const NODATA = -32768;
const BUILDER_VERSION = 1;
const AREA = require('./scopes.cjs').scopeFromArguments();
const SCOPE = {
  geometry: 'world/imported/' + AREA.prefix + '-rail.json',
  stations: 'world/imported/' + AREA.prefix + '-stations.json',
  settlements: 'world/imported/' + AREA.prefix + '-places.json',
  outposts: 'world/imported/' + AREA.prefix + '-outposts.json',
  output: 'world/network/' + AREA.prefix + '-network.json',
  id: AREA.prefix + '-network',
  label: AREA.label.charAt(0).toUpperCase() + AREA.label.slice(1) + ' railway network',
  grid: Object.assign({}, projection.GRID, { centre: AREA.gridCentre })
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
        this.link(keyOf(first.x, first.y), keyOf(second.x, second.y));
      } else if (km < existing.km) {
        existing.km = km;
        existing.gap = existing.gap && !!way.gap;
      } else if (!way.gap) {
        existing.gap = false;
      }
    }
  }
  // Every square's neighbours, kept up to date as lines are added: while the network only grows (the joins, the new
  // lines), this is the adjacency without rebuilding it for a continent each time. Removing track does not update it,
  // so code that takes track up builds its own from neighbours().
  link(a, b) {
    if (!this.live) return;
    (this.live.get(a) || this.live.set(a, []).get(a)).push(b);
    (this.live.get(b) || this.live.set(b, []).get(b)).push(a);
  }
  liveNeighbours() {
    if (!this.live) {
      this.live = new Map();
      this.edges.forEach(edge => this.link(edge.a, edge.b));
    }
    return this.live;
  }
  forgetLive() {
    this.live = null;
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
      // builtKm leaves out lines only ever proposed, planned or being built: a plan is not a railway worth a long join.
      const builtKm = keys.reduce((sum, key) => {
        const square = this.squares.get(key);
        const built = square.gapKm > 0 || Array.from(square.statuses).some(status => !UNBUILT.has(status));
        return sum + (built ? square.km : 0);
      }, 0);
      pieces.push({ keys, km: keys.reduce((sum, key) => sum + this.squares.get(key).km, 0), builtKm });
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
function shortCandidates(network, pieceOf, grid, excluded = () => false) {
  const reach = Math.ceil(SHORT_BRIDGE_KM / grid.cellKm), best = new Map();
  network.squares.forEach(square => {
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const other = network.squares.get(keyOf(square.x + dx, square.y + dy));
        if (!other || pieceOf.get(other.key) === pieceOf.get(square.key)) continue;
        const km = gridKm(square, other, grid);
        if (km > SHORT_BRIDGE_KM || excluded(square.key, other.key)) continue;
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
function longJoins(network, groups, grid, excluded = () => false, keep = new Set()) {
  const BUCKET = 20, groupOf = new Map(), index = new Map();
  groups.forEach((group, number) => group.keys.forEach(key => {
    groupOf.set(key, number);
    const square = network.squares.get(key), bucket = Math.floor(square.x / BUCKET) + ',' + Math.floor(square.y / BUCKET);
    if (!index.has(bucket)) index.set(bucket, []);
    index.get(bucket).push(key);
  }));
  const sets = unionFind(groups.length), joins = [];
  // Each group's track, and whether it serves an authored city, kept per set as the groups join up.
  const trackKm = groups.map(group => group.builtKm === undefined ? group.km : group.builtKm), serves = groups.map(group => group.keys.some(key => keep.has(key)));
  // Judged by the smaller side: the main network serves every authored city, so what matters is whether the piece
  // being brought in does.
  const worthKm = (a, b) => {
    const small = trackKm[a] <= trackKm[b] ? a : b;
    return serves[small] ? Infinity : Math.max(LONG_JOIN_MIN_KM, LONG_JOIN_PER_TRACK_KM * trackKm[small]);
  };
  const maxRing = Math.ceil(LONG_BRIDGE_MAX_KM / (BUCKET * grid.cellKm)) + 1;
  for (let round = 0; round < 40; round++) {
    const cheapest = new Map();
    // The biggest group does not search for itself: across a continent it is nearly every square, each one would look
    // hundreds of kilometres out for the few groups left, and every other group finds its own cheapest join anyway,
    // including the joins into this one, so the rounds still bring everything together.
    const size = new Map();
    groupOf.forEach(number => { const root = sets.find(number); size.set(root, (size.get(root) || 0) + 1); });
    let biggest = null;
    size.forEach((count, root) => { if (biggest === null || count > size.get(biggest)) biggest = root; });
    groupOf.forEach((number, key) => {
      const root = sets.find(number), square = network.squares.get(key);
      if (root === biggest && size.size > 1) return;
      const bx = Math.floor(square.x / BUCKET), by = Math.floor(square.y / BUCKET);
      for (let ring = 0; ring <= maxRing; ring++) {
        const best = cheapest.get(root);
        if (best && (ring - 1) * BUCKET * grid.cellKm > best.km) break;
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            (index.get((bx + dx) + ',' + (by + dy)) || []).forEach(otherKey => {
              const otherRoot = sets.find(groupOf.get(otherKey));
              if (otherRoot === root) return;
              const km = gridKm(square, network.squares.get(otherKey), grid);
              if (km > LONG_BRIDGE_MAX_KM || km > worthKm(root, otherRoot) || excluded(key, otherKey)) return;
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
      const [a, b] = [sets.find(groupOf.get(join.from)), sets.find(groupOf.get(join.to))];
      if (sets.join(a, b)) {
        const root = sets.find(a);
        trackKm[root] = trackKm[a] + trackKm[b];
        serves[root] = serves[a] || serves[b];
        joins.push(join);
        joined++;
      }
    });
    log('long joins, round ' + (round + 1) + ': ' + joined + ' made');
    if (!joined) break;
  }
  return joins;
}

// --- laying new lines --------------------------------------------------------------------------------------------

// Lays a new line between two network squares and adds it to the network: straight when short, over the terrain and
// through the towns on the way when not. join.through, when given, is a list of named points ({ name, coordinates })
// the line must pass through in order, each hop between them laid the same way. Returns the record of what was laid.
function layLine(network, join, context) {
  const line = planLine(join, context);
  addLine(network, line);
  return line;
}

// The line layLine would lay, without adding it. line.planned is false where the terrain search found no way and the
// line is only drawn straight. A join's ends are square keys; the square at the far end need not exist yet.
function planLine(join, context) {
  const { grid, settlements, cache } = context;
  const [a, b] = [join.from, join.to].map(key => { const [x, y] = key.split(',').map(Number); return { x, y }; });
  const from = projection.centreOf([a.x, a.y], grid), to = projection.centreOf([b.x, b.y], grid);
  const straightKm = haversineKm(from, to);
  const points = [{ coordinates: from }].concat(join.through || [], [{ coordinates: to }]);
  let coordinates = [from], via = [], waterKm = 0, planned = true;
  for (let hop = 1; hop < points.length; hop++) {
    const start = coordinates.at(-1), end = points[hop].coordinates, long = haversineKm(start, end) > STRAIGHT_BRIDGE_KM;
    const laid = long && routeOverTerrain(start, end, settlements, cache);
    if (laid) { coordinates = coordinates.concat(laid.coordinates.slice(1)); via = via.concat(laid.via); waterKm += laid.waterKm; }
    else { coordinates.push(end); if (long) planned = false; }
    if (hop < points.length - 1 && points[hop].name) via.push(points[hop].name);
  }
  let km = 0;
  for (let point = 1; point < coordinates.length; point++) km += haversineKm(coordinates[point - 1], coordinates[point]);
  const rounded = coordinates.map(point => [Math.round(point[0] * 1e5) / 1e5, Math.round(point[1] * 1e5) / 1e5]);
  const segments = context.network ? spliceOntoTrack(context.network, rounded, join.from, join.to, grid)
    : [{ from: join.from, to: join.to, coordinates: rounded }];
  const laidKm = segments.reduce((sum, segment) => sum + lengthKm(segment.coordinates), 0);
  const line = { from: join.from, to: join.to, kind: join.kind, ...(join.note ? { note: join.note } : {}),
    straightKm: round3(straightKm), km: round3(laidKm), waterKm: Math.round(waterKm * 10) / 10, via,
    ...(laidKm < km - 1 ? { plannedKm: round3(km), onExistingTrackKm: round3(km - laidKm) } : {}),
    coordinates: rounded, ...(segments.length !== 1 || laidKm < km - 1 ? { segments } : {}) };
  Object.defineProperty(line, 'planned', { value: planned });
  Object.defineProperty(line, 'grid', { value: grid });
  Object.defineProperty(line, 'parts', { value: segments });
  return line;
}

function addLine(network, line) {
  const grid = line.grid;
  line.parts.forEach(part => {
    const [a, b] = [part.from, part.to].map(key => { const [x, y] = key.split(',').map(Number); return { x, y }; });
    const visits = traceLine(part.coordinates, grid, {});
    if (!visits.length) visits.push({ x: a.x, y: a.y, km: 0 });
    // A line from one square's middle to another's always starts and ends in them.
    if (visits[0].x !== a.x || visits[0].y !== a.y) visits.unshift({ x: a.x, y: a.y, km: 0 });
    if (visits.at(-1).x !== b.x || visits.at(-1).y !== b.y) visits.push({ x: b.x, y: b.y, km: 0 });
    network.add(visits, { id: line.kind + ':' + part.from + '>' + part.to, gap: true });
  });
}

const lengthKm = coordinates => coordinates.reduce((sum, point, index) => index ? sum + haversineKm(coordinates[index - 1], point) : 0, 0);

// A planned line cut where it runs beside existing track (SPLICE_MIN_KM), so the train uses that track instead: the
// parts of the line away from track, each from the network square where it leaves track to the one where it meets
// it again. from and to are the line's end squares; to need not be on the network yet (a spur's far end).
function spliceOntoTrack(network, coordinates, from, to, grid) {
  const samples = [];
  let along = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const a = coordinates[index - 1], b = coordinates[index], km = haversineKm(a, b), steps = Math.max(1, Math.ceil(km));
    for (let step = index === 1 ? 0 : 1; step <= steps; step++) {
      const t = step / steps;
      samples.push({ point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], vertex: index - 1, km: along + km * t });
    }
    along += km;
  }
  if (samples.length < 2) return [{ from, to, coordinates }];
  // The existing track within a square of each point, if any.
  samples.forEach(sample => {
    const cell = projection.cellOf(sample.point, grid);
    let best = null;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const key = keyOf(cell[0] + dx, cell[1] + dy);
      if (!network.squares.has(key)) continue;
      const km = haversineKm(sample.point, projection.centreOf([cell[0] + dx, cell[1] + dy], grid));
      if (!best || km < best.km) best = { key, km };
    }
    sample.near = best ? best.key : null;
  });
  const runs = [];
  samples.forEach((sample, index) => {
    const near = !!sample.near, last = runs.at(-1);
    if (last && last.near === near) last.end = index;
    else runs.push({ near, start: index, end: index });
  });
  let adjacent = null;
  const connected = (p, q, km) => {
    if (p === q) return true;
    adjacent = adjacent || network.liveNeighbours();
    if (!adjacent.has(p) || !adjacent.has(q)) return false;
    const limit = km * SPLICE_DETOUR_FACTOR + SPLICE_DETOUR_KM;
    return (distancesAlong(network, adjacent, p, limit).get(q) ?? Infinity) <= limit;
  };
  const toOnNetwork = network.squares.has(to), last = samples.length - 1;
  // Anchors: where the line is on existing track. Its start always is; its end is when that square is on the network.
  const anchors = [{ start: 0, end: 0, entry: from, exit: from }];
  runs.forEach(run => {
    if (!run.near) return;
    const km = samples[run.end].km - samples[run.start].km;
    const leading = run.start === 0, trailing = run.end === last && toOnNetwork;
    if (leading && trailing) {
      if (connected(from, to, km)) anchors[0] = { start: 0, end: last, entry: from, exit: to };
      return;
    }
    if (leading) {
      if (connected(from, samples[run.end].near, km)) anchors[0] = { start: 0, end: run.end, entry: from, exit: samples[run.end].near };
      return;
    }
    if (trailing) {
      if (connected(samples[run.start].near, to, km)) anchors.push({ start: run.start, end: last, entry: samples[run.start].near, exit: to });
      return;
    }
    if (km >= SPLICE_MIN_KM && connected(samples[run.start].near, samples[run.end].near, km)) {
      anchors.push({ start: run.start, end: run.end, entry: samples[run.start].near, exit: samples[run.end].near });
    }
  });
  if (anchors.at(-1).end !== last) anchors.push({ start: last, end: last, entry: to, exit: to });
  const centre = key => projection.centreOf(key.split(',').map(Number), grid);
  const parts = [];
  for (let index = 1; index < anchors.length; index++) {
    const before = anchors[index - 1], after = anchors[index];
    if (before.exit === after.entry) continue;
    const startKm = samples[before.end].km, endKm = samples[after.start].km;
    const inside = [];
    let km = 0;
    for (let vertex = 1; vertex < coordinates.length - 1; vertex++) {
      km += haversineKm(coordinates[vertex - 1], coordinates[vertex]);
      if (km > startKm && km < endKm) inside.push(coordinates[vertex]);
    }
    const first = before.exit === from ? coordinates[0] : centre(before.exit);
    const end = after.entry === to ? coordinates.at(-1) : centre(after.entry);
    parts.push({ from: before.exit, to: after.entry, coordinates: [first, ...inside, end] });
  }
  return parts;
}

// Terrain routes are kept between builds, in the elevation cache beside the tiles, keyed by the two ends, the
// router's parameters and the settlements it steers by: a rebuild only searches for the lines that are new or have
// moved, which on two continents is the difference between minutes and hours. A null route (no way found) is kept
// too. Delete the file to start again.
const routeMemo = { file: null, routes: null, dirty: false, found: 0 };
function routeOverTerrain(start, end, settlements, cache) {
  if (!routeMemo.routes) {
    routeMemo.file = path.join(cache, 'terrain-routes-' + AREA.prefix + '.json');
    try {
      routeMemo.routes = JSON.parse(fs.readFileSync(routeMemo.file, 'utf8'));
    } catch (error) {
      routeMemo.routes = {};
    }
    routeMemo.stamp = crypto.createHash('sha1').update(JSON.stringify(terrain.PARAMETERS) + ':' + settlements.length).digest('hex').slice(0, 12);
  }
  const key = routeMemo.stamp + ':' + start.map(value => value.toFixed(5)).join(',') + '>' + end.map(value => value.toFixed(5)).join(',');
  if (Object.prototype.hasOwnProperty.call(routeMemo.routes, key)) return routeMemo.routes[key];
  const route = terrain.terrainPath(start, end, settlements, cache);
  routeMemo.routes[key] = route ? { coordinates: route.coordinates, km: route.km, straightKm: route.straightKm,
    waterKm: route.waterKm, via: route.via } : null;
  routeMemo.dirty = true;
  // Saved as it goes too, so a build that dies part way keeps what it has found.
  if (++routeMemo.found % 500 === 0) saveRoutes();
  return routeMemo.routes[key];
}
function saveRoutes() {
  if (!routeMemo.dirty) return;
  fs.writeFileSync(routeMemo.file + '.part', JSON.stringify(routeMemo.routes));
  fs.renameSync(routeMemo.file + '.part', routeMemo.file);
  routeMemo.dirty = false;
}

// Whether a planned line is one to lay: found over the terrain, and crossing no more than a river.
const buildable = line => line.planned && line.waterKm <= MAX_WATER_KM;

// Track distances from one square outward, up to a limit. extra holds joins not yet laid, as { key: [[other, km]] }.
function distancesAlong(network, adjacent, start, limitKm, extra = {}) {
  const distance = new Map([[start, 0]]), settled = new Set(), queue = new Heap();
  queue.push(0, start);
  while (queue.size) {
    const key = queue.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    const km = distance.get(key);
    const steps = adjacent.get(key).map(next => [next, network.edges.get(key < next ? key + '|' + next : next + '|' + key).km])
      .concat(extra[key] || []);
    steps.forEach(([next, stepKm]) => {
      const total = km + stepKm;
      if (total <= limitKm && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); queue.push(total, next); }
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

// Joins between two line ends that face each other across a gap: see END_JOIN_KM. Accepted shortest first, each
// end joined once and each join checked against the ones already accepted, so a join that gives a short way round
// makes the next one across the same gap redundant. plan(join) returns the line to lay, or null to skip the join.
function endJoins(network, grid, plan) {
  const adjacent = network.neighbours(), limitKm = END_JOIN_KM * END_DETOUR_FACTOR;
  const isLongWayRound = (byTrack, km) => byTrack === undefined || (byTrack >= km * END_DETOUR_FACTOR && byTrack - km >= END_DETOUR_MIN_KM);
  const ends = Array.from(network.squares.keys()).sort().filter(key => adjacent.get(key).length === 1);
  const candidates = [];
  ends.forEach((end, index) => {
    if (index && index % 500 === 0) log('facing ends: ' + index + ' of ' + ends.length + ' line ends checked');
    const square = network.squares.get(end);
    const near = ends.slice(index + 1).map(other => ({ other, km: gridKm(square, network.squares.get(other), grid) }))
      .filter(pair => pair.km > STUB_JOIN_KM && pair.km <= END_JOIN_KM);
    if (!near.length) return;
    // Only as far along the track as the farthest of those ends needs to count as the long way round.
    const farthest = Math.max(...near.map(pair => pair.km));
    const along = distancesAlong(network, adjacent, end, Math.min(limitKm, Math.max(farthest * END_DETOUR_FACTOR, farthest + END_DETOUR_MIN_KM)));
    near.forEach(pair => { if (isLongWayRound(along.get(pair.other), pair.km)) candidates.push({ from: end, to: pair.other, km: pair.km }); });
  });
  candidates.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
  const accepted = [], extra = {}, joined = new Set();
  candidates.forEach(candidate => {
    if (joined.has(candidate.from) || joined.has(candidate.to)) return;
    const reach = Math.min(limitKm, Math.max(candidate.km * END_DETOUR_FACTOR, candidate.km + END_DETOUR_MIN_KM));
    if (!isLongWayRound(distancesAlong(network, adjacent, candidate.from, reach, extra).get(candidate.to), candidate.km)) return;
    const line = plan(candidate);
    if (!line) return;
    accepted.push(line);
    joined.add(candidate.from).add(candidate.to);
    (extra[candidate.from] = extra[candidate.from] || []).push([candidate.to, candidate.km]);
    (extra[candidate.to] = extra[candidate.to] || []).push([candidate.from, candidate.km]);
  });
  return accepted;
}

// Shortcuts between two sizeable places that are close together but a long way apart by track: see
// SHORTCUT_POPULATION. Accepted shortest first, each checked against those before it, so one shortcut serves a
// cluster of towns rather than each pair getting its own. plan(join) returns the line to lay, or null to skip it.
function cityShortcuts(network, grid, settlements, plan) {
  const adjacent = network.neighbours(), limitKm = SHORTCUT_KM * SHORTCUT_DETOUR_FACTOR + SHORTCUT_DETOUR_MIN_KM;
  const isLongWayRound = (byTrack, km) => byTrack === undefined || (byTrack >= km * SHORTCUT_DETOUR_FACTOR && byTrack - km >= SHORTCUT_DETOUR_MIN_KM);
  const squares = Array.from(network.squares.values()).map(square => ({ key: square.key, centre: projection.centreOf([square.x, square.y], grid) }));
  const squaresNear = bucketsOf(squares, square => square.centre);
  const cities = [], taken = new Set();
  settlements.filter(place => (place.population || 0) >= SHORTCUT_POPULATION)
    .sort((a, b) => b.population - a.population || a.id.localeCompare(b.id)).forEach(place => {
      let nearest = null;
      squaresNear(place.coordinates).forEach(square => {
        const km = haversineKm(place.coordinates, square.centre);
        if (km <= CITY_TRACK_KM && (!nearest || km < nearest.km)) nearest = { key: square.key, km };
      });
      if (nearest && !taken.has(nearest.key)) { taken.add(nearest.key); cities.push({ place, square: nearest.key }); }
    });
  const candidates = [];
  cities.forEach((city, index) => {
    const near = cities.slice(index + 1).map(other => ({ other, km: haversineKm(city.place.coordinates, other.place.coordinates) }))
      .filter(pair => pair.km <= SHORTCUT_KM);
    if (!near.length) return;
    const farthest = Math.max(...near.map(pair => pair.km));
    const along = distancesAlong(network, adjacent, city.square,
      Math.min(limitKm, Math.max(farthest * SHORTCUT_DETOUR_FACTOR, farthest + SHORTCUT_DETOUR_MIN_KM)));
    near.forEach(pair => {
      if (isLongWayRound(along.get(pair.other.square), pair.km)) {
        candidates.push({ from: city.square, to: pair.other.square, km: pair.km, note: city.place.name + ' to ' + pair.other.place.name });
      }
    });
  });
  candidates.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
  const accepted = [], extra = {};
  candidates.forEach(candidate => {
    if (!isLongWayRound(distancesAlong(network, adjacent, candidate.from, limitKm, extra).get(candidate.to), candidate.km)) return;
    const line = plan(candidate);
    if (!line) return;
    accepted.push(line);
    (extra[candidate.from] = extra[candidate.from] || []).push([candidate.to, candidate.km]);
    (extra[candidate.to] = extra[candidate.to] || []).push([candidate.from, candidate.km]);
  });
  return accepted;
}

// Takes up stretches of line that another way between the same two junctions nearly matches: see PARALLEL_FACTOR.
// keep is a set of squares whose line must stay (cities, authored routes); stationSquares the squares with mapped
// stations, which make a line worth more. Repeats until nothing more comes up, since taking one stretch up can make
// two stretches into one.
const STATUS_VALUE = { current: 3, disused: 2, construction: 1, proposed: 1 };
function pruneParallel(network, keep, stationSquares) {
  let removed = 0, removedKm = 0;
  for (let pass = 0; pass < 8; pass++) {
    const adjacent = network.neighbours(), walked = new Set(), stretches = [];
    const edgeKm = (a, b) => network.edges.get(a < b ? a + '|' + b : b + '|' + a).km;
    Array.from(network.squares.keys()).sort().forEach(start => {
      if (adjacent.get(start).length === 2) return;
      adjacent.get(start).slice().sort().forEach(first => {
        const firstEdge = start < first ? start + '|' + first : first + '|' + start;
        if (walked.has(firstEdge)) return;
        walked.add(firstEdge);
        const path = [start], edges = [firstEdge];
        let previous = start, current = first, km = edgeKm(start, first);
        while (adjacent.get(current).length === 2 && current !== start) {
          path.push(current);
          const next = adjacent.get(current).find(key => key !== previous);
          const edge = current < next ? current + '|' + next : next + '|' + current;
          if (walked.has(edge)) break;
          walked.add(edge);
          edges.push(edge);
          km += edgeKm(current, next);
          previous = current;
          current = next;
        }
        path.push(current);
        if (current === start) return;
        stretches.push({ from: start, to: current, path, edges, km });
      });
    });
    const valueOf = stretch => {
      const inside = stretch.path.slice(1, -1).map(key => network.squares.get(key));
      const track = inside.length ? inside.reduce((sum, square) => sum + (square.railKm > 0
        ? Math.max(1, ...Array.from(square.statuses).map(status => STATUS_VALUE[status] || 1)) : 0), 0) / inside.length : 0;
      return track + stretch.path.filter(key => stationSquares.has(key)).length / Math.max(1, stretch.km) * 10;
    };
    stretches.forEach(stretch => { stretch.value = valueOf(stretch); });
    stretches.sort((a, b) => a.value - b.value || b.km - a.km || a.edges[0].localeCompare(b.edges[0]));
    log('parallel lines, pass ' + (pass + 1) + ': ' + stretches.length + ' stretches between junctions to check');
    let changed = 0;
    const gone = new Set();
    stretches.forEach(stretch => {
      if (stretch.path.slice(1, -1).some(key => keep.has(key) || gone.has(key))) return;
      if (stretch.edges.some(edge => !network.edges.has(edge))) return;
      const limit = stretch.km * PARALLEL_FACTOR + PARALLEL_EXTRA_KM;
      // Take the stretch out of the network and of the adjacency built for this pass, and see how far round it is.
      const saved = stretch.edges.map(edge => network.edges.get(edge));
      const unlink = edge => {
        const a = adjacent.get(edge.a), b = adjacent.get(edge.b);
        a.splice(a.indexOf(edge.b), 1);
        b.splice(b.indexOf(edge.a), 1);
      };
      saved.forEach(edge => { network.edges.delete(edge.key); unlink(edge); });
      const around = distancesAlong(network, adjacent, stretch.from, limit).get(stretch.to);
      if (around === undefined || around > limit) {
        saved.forEach(edge => { network.edges.set(edge.key, edge); adjacent.get(edge.a).push(edge.b); adjacent.get(edge.b).push(edge.a); });
        return;
      }
      stretch.path.slice(1, -1).forEach(key => { network.squares.delete(key); adjacent.delete(key); gone.add(key); });
      network.forgetLive();
      removed++;
      removedKm += stretch.km;
      changed++;
    });
    if (!changed) break;
  }
  return { stretches: removed, km: Math.round(removedKm) };
}

// Squares and places in buckets half a degree across, for "what is near this point" without a scan of everything.
function bucketsOf(items, pointOf, degrees = 0.5) {
  const buckets = new Map(), scale = 1 / degrees;
  items.forEach(item => {
    const point = pointOf(item), key = Math.floor(point[0] * scale) + ',' + Math.floor(point[1] * scale);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  });
  // Everything in the bucket around point and the eight next to it: within about 30 km anywhere south of 55°S.
  return point => {
    const x = Math.floor(point[0] * scale), y = Math.floor(point[1] * scale), found = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) found.push(...(buckets.get((x + dx) + ',' + (y + dy)) || []));
    return found;
  };
}

// The region a point is in: 'urban', 'industrial' or 'rural' (see URBAN_POPULATION and INDUSTRIAL_RAIL_KM).
function regionClassifier(network, settlements, grid) {
  const peopleNear = bucketsOf(settlements, place => place.coordinates);
  const squares = Array.from(network.squares.values()).filter(square => square.railKm > 0)
    .map(square => ({ railKm: square.railKm, centre: projection.centreOf([square.x, square.y], grid) }));
  const trackNear = bucketsOf(squares, square => square.centre);
  const peopleAt = point => peopleNear(point).reduce((sum, place) => sum + (haversineKm(point, place.coordinates) <= URBAN_RADIUS_KM
    ? place.population || DEFAULT_POPULATION[place.kind] || 0 : 0), 0);
  const regionOf = point => {
    if (peopleAt(point) >= URBAN_POPULATION) return 'urban';
    const track = trackNear(point).reduce((sum, square) => sum + (haversineKm(point, square.centre) <= INDUSTRIAL_RADIUS_KM
      ? square.railKm : 0), 0);
    return track >= INDUSTRIAL_RAIL_KM ? 'industrial' : 'rural';
  };
  regionOf.peopleAt = peopleAt;
  // People within a wider radius, for how busy a region is: buckets a degree across, so up to about 60 km.
  const peopleWide = bucketsOf(settlements, place => place.coordinates, 1);
  regionOf.peopleWithin = (point, radiusKm) => peopleWide(point).reduce((sum, place) => sum + (haversineKm(point, place.coordinates) <= radiusKm
    ? place.population || DEFAULT_POPULATION[place.kind] || 0 : 0), 0);
  return regionOf;
}

// A city's railways reduced to a hub and the lines into it. Mapped in full, a big city's suburban network is a maze:
// on 5 km squares its lines cross every few squares, and every crossing is a junction, so a stop and a railyard. So
// each connected area of urban track keeps only the shortest way from every point where a line enters it to its hub
// (an authored city there, else the most crowded square), and the rest of its track inside the area is taken up.
// Every line into the city still reaches every other, through the hub. hubs is a set of square keys that must stay.
// Returns what was taken up.
function simplifyUrban(network, grid, regionOf, hubs) {
  const adjacent = network.neighbours(), urban = new Set();
  network.squares.forEach((square, key) => { if (regionOf(projection.centreOf([square.x, square.y], grid)) === 'urban') urban.add(key); });
  const edgeKm = (a, b) => network.edges.get(a < b ? a + '|' + b : b + '|' + a).km;
  const seen = new Set(), keepEdges = new Set(), dropSquares = new Set();
  let areas = 0;
  Array.from(urban).sort().forEach(start => {
    if (seen.has(start)) return;
    // One connected area of urban track.
    const area = [], stack = [start];
    seen.add(start);
    while (stack.length) {
      const key = stack.pop();
      area.push(key);
      adjacent.get(key).forEach(next => { if (urban.has(next) && !seen.has(next)) { seen.add(next); stack.push(next); } });
    }
    const inArea = new Set(area);
    const entries = area.filter(key => adjacent.get(key).some(next => !inArea.has(next)));
    const cities = area.filter(key => hubs.has(key));
    const people = key => { const square = network.squares.get(key); return regionOf.peopleAt(projection.centreOf([square.x, square.y], grid)); };
    const hub = (cities.length ? cities : area).slice().sort((a, b) => people(b) - people(a) || a.localeCompare(b))[0];
    // The shortest ways out from the hub, inside the area.
    const distance = new Map([[hub, 0]]), previous = new Map(), settled = new Set(), queue = new Heap();
    queue.push(0, hub);
    while (queue.size) {
      const key = queue.pop();
      if (settled.has(key)) continue;
      settled.add(key);
      adjacent.get(key).forEach(next => {
        if (!inArea.has(next)) return;
        const km = distance.get(key) + edgeKm(key, next);
        if (km < (distance.get(next) ?? Infinity)) { distance.set(next, km); previous.set(next, key); queue.push(km, next); }
      });
    }
    const keep = new Set([hub]);
    entries.concat(cities).forEach(target => {
      for (let key = target; previous.has(key); key = previous.get(key)) {
        const back = previous.get(key);
        keep.add(key);
        keepEdges.add(key < back ? key + '|' + back : back + '|' + key);
      }
    });
    area.forEach(key => { if (!keep.has(key)) dropSquares.add(key); });
    areas++;
  });
  let droppedEdges = 0;
  Array.from(network.edges.values()).forEach(edge => {
    const inside = urban.has(edge.a) && urban.has(edge.b);
    if (dropSquares.has(edge.a) || dropSquares.has(edge.b) || (inside && !keepEdges.has(edge.key))) {
      network.edges.delete(edge.key);
      droppedEdges++;
    }
  });
  dropSquares.forEach(key => network.squares.delete(key));
  network.forgetLive();
  return { areas, squares: dropSquares.size, moves: droppedEdges };
}

// Spurs out to places off a rural line: see SPUR_SPACING_KM. places are settlements and outposts; regionOf is from
// regionClassifier. plan(join) returns the line to lay, or null to skip it. Returns the lines and the places they
// reach, as { line, place }.
const PLACE_KIND_RANK = { city: 6, town: 5, village: 4, hamlet: 3, isolated_dwelling: 2, farm: 2 };
function spurs(network, grid, places, regionOf, plan, isHard) {
  const adjacent = network.neighbours();
  const branchPoints = new Set(Array.from(network.squares.keys()).filter(key => adjacent.get(key).length !== 2));
  const squares = Array.from(network.squares.values()).map(square => ({ key: square.key, centre: projection.centreOf([square.x, square.y], grid) }));
  const squaresNear = bucketsOf(squares, square => square.centre);
  const nameCount = new Map();
  places.forEach(place => nameCount.set(place.name, (nameCount.get(place.name) || 0) + 1));
  const candidates = [];
  places.forEach(place => {
    if (!PLACE_KIND_RANK[place.kind] || nameCount.get(place.name) > GENERIC_NAME_COUNT) return;
    let nearest = null;
    squaresNear(place.coordinates).forEach(square => {
      const km = haversineKm(place.coordinates, square.centre);
      if (!nearest || km < nearest.km) nearest = { key: square.key, centre: square.centre, km };
    });
    if (nearest && nearest.km > SPUR_MIN_KM && nearest.km <= SPUR_MAX_KM) candidates.push({ place, from: nearest.key, fromCentre: nearest.centre, km: nearest.km });
  });
  candidates.sort((a, b) => PLACE_KIND_RANK[b.place.kind] - PLACE_KIND_RANK[a.place.kind] || a.km - b.km || a.place.id.localeCompare(b.place.id));
  const laid = [];
  candidates.forEach(candidate => {
    if (branchPoints.has(candidate.from)) return;
    const along = distancesAlong(network, adjacent, candidate.from, SPUR_SPACING_KM);
    for (const key of along.keys()) if (branchPoints.has(key)) return;
    if (regionOf(candidate.fromCentre) !== 'rural' || (isHard && isHard(candidate.fromCentre))) return;
    const cell = projection.cellOf(candidate.place.coordinates, grid);
    const to = keyOf(cell[0], cell[1]);
    if (network.squares.has(to)) return;
    const line = plan({ from: candidate.from, to, km: candidate.km });
    if (!line) return;
    branchPoints.add(candidate.from);
    laid.push({ line, place: candidate.place, square: to });
  });
  return laid;
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
// Mean elevation and relief for every square, resampled from the elevation tiles onto the grid a block of
// ELEVATION_BLOCK squares at a time, each block warping only the tiles under it: one warp over two continents' worth
// of tiles took this server down. squares are the network's square records ({ x, y, elevationM, elevationStdDevM }),
// filled in place. Returns the names of the tiles used.
const ELEVATION_BLOCK = 256;
function fillElevation(squares, grid, cache) {
  const blocks = new Map();
  squares.forEach(square => {
    const key = Math.floor(square.x / ELEVATION_BLOCK) + ',' + Math.floor(square.y / ELEVATION_BLOCK);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(square);
  });
  const origin = projection.project(grid.origin, grid), used = new Set();
  const srs = '+proj=laea +lat_0=' + grid.centre[1] + ' +lon_0=' + grid.centre[0] + ' +x_0=0 +y_0=0 +R=' +
    (projection.EARTH_RADIUS_KM * 1000) + ' +units=m +no_defs';
  let done = 0;
  Array.from(blocks.keys()).sort().forEach(blockKey => {
    const list = blocks.get(blockKey);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const tiles = new Set();
    list.forEach(square => {
      box[0] = Math.min(box[0], square.x); box[1] = Math.min(box[1], square.y);
      box[2] = Math.max(box[2], square.x); box[3] = Math.max(box[3], square.y);
      [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]].forEach(([dx, dy]) => {
        const point = projection.centreOf([square.x + dx, square.y + dy], grid);
        tiles.add(copernicusTileName(point[0], point[1]));
      });
    });
    const files = fetchTiles(Array.from(tiles).sort(), cache);
    files.forEach(file => used.add(path.basename(file)));
    const width = box[2] - box[0] + 1, height = box[3] - box[1] + 1;
    const extent = [(origin[0] + (box[0] - 0.5) * grid.cellKm) * 1000, (origin[1] + (box[1] - 0.5) * grid.cellKm) * 1000,
      (origin[0] + (box[2] + 0.5) * grid.cellKm) * 1000, (origin[1] + (box[3] + 0.5) * grid.cellKm) * 1000];
    const rasters = {};
    if (files.length) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-network-dem-'));
      try {
        const listFile = path.join(temporary, 'tiles.txt');
        fs.writeFileSync(listFile, files.join('\n') + '\n');
        const vrt = path.join(temporary, 'dem.vrt');
        run('gdalbuildvrt', ['-q', '-vrtnodata', String(NODATA), '-input_file_list', listFile, vrt]);
        ['average', 'rms'].forEach(method => {
          const output = path.join(temporary, method + '.bin');
          run('gdalwarp', ['-q', '-overwrite', '-wm', '64', '--config', 'GDAL_CACHEMAX', '64', '-t_srs', srs,
            '-te', ...extent.map(String), '-ts', String(width), String(height), '-r', method,
            '-srcnodata', String(NODATA), '-dstnodata', String(NODATA), '-ot', 'Float32', '-of', 'ENVI', vrt, output]);
          const bytes = fs.readFileSync(output);
          rasters[method] = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + width * height * 4));
        });
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    list.forEach(square => {
      const index = (box[3] - square.y) * width + (square.x - box[0]);
      const mean = rasters.average ? rasters.average[index] : NODATA, rms = rasters.rms ? rasters.rms[index] : NODATA;
      if (mean === NODATA || !Number.isFinite(mean)) {
        square.elevationM = 0; square.elevationStdDevM = 0;
      } else {
        square.elevationM = Math.round(mean * 10) / 10;
        square.elevationStdDevM = Math.round(Math.sqrt(Math.max(0, rms * rms - mean * mean)) * 10) / 10;
      }
    });
    done++;
    if (done % 10 === 0 || done === blocks.size) log('elevation: ' + done + ' of ' + blocks.size + ' blocks');
  });
  return Array.from(used).sort();
}

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
      run('gdalwarp', ['-q', '-overwrite', '-wm', '96', '--config', 'GDAL_CACHEMAX', '96', '-t_srs', srs, '-te', ...extent.map(String),
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
  if (stop.status === 'settlement') return { city: 38, town: 28, village: 15, hamlet: 10, isolated_dwelling: 8, farm: 8 }[stop.kind] || 15;
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

// --- hard regions -------------------------------------------------------------------------------------------------

// world/authored/regions.json: polygons where the builder invents fewer stops (no halts, no spurs, no stops at bare
// line ends, and on new lines only towns and cities): the player's hard sections, such as Alaska and the Yukon.
function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function hardRegionTest(regions) {
  const hard = (regions || []).filter(region => region.hard);
  return point => hard.some(region => insidePolygon(point, region.polygon));
}

// --- authored routes ----------------------------------------------------------------------------------------------

// Places a route can name: the authored cities and every settlement. Names match without regard to case or accents,
// so "Humaita" finds Humaitá.
const PLACE_RANK = { city: 3, town: 2, village: 1 };
const plainName = name => String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function placeIndex(cities, settlements) {
  const index = new Map();
  const add = (name, record) => {
    const key = plainName(name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  };
  cities.forEach(city => add(city.name, { name: city.name, kind: 'city', population: Infinity, coordinates: [city.longitude, city.latitude] }));
  settlements.forEach(place => add(place.name, { name: place.name, kind: place.kind, population: place.population || 0, coordinates: place.coordinates }));
  return index;
}

// One stop of a route, as { name, coordinates }. A stop is a place name, [longitude, latitude], or
// { "name": ..., "near": [longitude, latitude] } to pick one of several places sharing a name. A bare name picks the
// largest place of that name; if two of the same size are far apart, the route has to say which.
function resolveStop(stop, index, label) {
  if (Array.isArray(stop)) {
    assert(stop.length === 2 && stop.every(Number.isFinite), label + ': ' + JSON.stringify(stop) + ' is not [longitude, latitude]');
    return { name: null, coordinates: stop };
  }
  const name = typeof stop === 'string' ? stop : stop && stop.name;
  assert(name, label + ': ' + JSON.stringify(stop) + ' is not a place name, [longitude, latitude] or { name, near }');
  const found = index.get(plainName(name)) || [];
  assert(found.length, label + ': no place called "' + name + '"');
  if (stop.near) {
    const nearest = found.slice().sort((p, q) => haversineKm(p.coordinates, stop.near) - haversineKm(q.coordinates, stop.near))[0];
    return { name: nearest.name, coordinates: nearest.coordinates };
  }
  const ranked = found.slice().sort((p, q) => PLACE_RANK[q.kind] - PLACE_RANK[p.kind] || q.population - p.population);
  const [best, next] = ranked;
  assert(!next || PLACE_RANK[next.kind] < PLACE_RANK[best.kind] || next.population < best.population
    || haversineKm(best.coordinates, next.coordinates) <= SAME_PLACE_KM,
    label + ': "' + name + '" could be any of ' + ranked.filter(place => place.kind === best.kind)
      .map(place => '[' + place.coordinates.join(', ') + ']').join(', ') + '; write { "name": "' + name + '", "near": [longitude, latitude] }');
  return { name: best.name, coordinates: best.coordinates };
}

// An authored route as its stops. { "route": [...] } lists them; the older { "from": ..., "to": ... } is a route of two.
function resolveRoute(join, index) {
  const stops = join.route || [join.from, join.to];
  const label = 'Authored route' + (join.note ? ' "' + join.note + '"' : '');
  assert(Array.isArray(stops) && stops.length >= 2, label + ' needs at least two stops');
  return stops.map(stop => resolveStop(stop, index, label));
}

// --- the stage ----------------------------------------------------------------------------------------------------

function buildNetwork(options) {
  const { geometry, stations, settlements, cities, grid, cache } = options;
  const isHard = hardRegionTest(options.regions);
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
  // 1-3, in passes: short and long joins between the pieces, each laid over the terrain. A join whose line would
  // cross more than MAX_WATER_KM of open water (a strait, a bay: an island's railway) is not laid, and the next pass
  // looks for another way to join those pieces that does not cross the same water; a piece with none is left out.
  const context = { grid, settlements, cache, network };
  const laidLines = [], rejected = [];
  // Authored routes first, before any automatic join: each is a join chosen by hand, and a piece a route reaches (the
  // old railway at Nome on the way to Wales) needs no other join to bring it in.
  const places = placeIndex(cities, settlements), authoredEnds = [];
  (options.authoredJoins || []).forEach(join => {
    const stops = resolveRoute(join, places);
    const ends = [stops[0], stops.at(-1)].map((stop, end) => {
      const point = stop.coordinates;
      const cell = projection.cellOf(point, grid);
      // A route marked "newEnd" runs out to a new terminus where there is no track: its last stop's own square.
      if (end === 1 && join.newEnd) return keyOf(cell[0], cell[1]);
      let best = null;
      const reach = Math.ceil(AUTHORED_SNAP_KM / grid.cellKm);
      for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
        const square = network.squares.get(keyOf(cell[0] + dx, cell[1] + dy));
        if (!square) continue;
        const km = haversineKm(point, projection.centreOf([square.x, square.y], grid));
        if (km <= AUTHORED_SNAP_KM && (!best || km < best.km)) best = { key: square.key, km };
      }
      assert(best, 'Authored route end ' + (stop.name || point.join(',')) + ' is not within ' + AUTHORED_SNAP_KM +
        ' km of the network' + (join.note ? ' (' + join.note + ')' : ''));
      return best.key;
    });
    log('laying authored route ' + (join.note || stops.map(stop => stop.name).join(' - ')));
    laidLines.push(layLine(network, { from: ends[0], to: ends[1], through: stops.slice(1, -1), kind: 'authored',
      note: join.note }, context));
    // The new terminus is a stop, named for the place it runs to.
    if (join.newEnd) authoredEnds.push({ id: 'authored-end:' + ends[1], name: stops.at(-1).name || 'End of the line',
      status: 'settlement', kind: 'town', square: ends[1], coordinates: stops.at(-1).coordinates });
  });
  const centreKm = (a, b) => haversineKm(projection.centreOf(a.split(',').map(Number), grid), projection.centreOf(b.split(',').map(Number), grid));
  const REJECTED_REACH_KM = 150;
  const excluded = (a, b) => rejected.some(join =>
    (centreKm(a, join.from) < REJECTED_REACH_KM && centreKm(b, join.to) < REJECTED_REACH_KM)
    || (centreKm(a, join.to) < REJECTED_REACH_KM && centreKm(b, join.from) < REJECTED_REACH_KM));
  for (let pass = 1; pass <= 4; pass++) {
    pieces = network.pieces();
    const bridges = [];
    const pieceOf = new Map();
    pieces.forEach((piece, index) => piece.keys.forEach(key => pieceOf.set(key, index)));
    // 1. Short joins, shortest first, between any two pieces.
    const sets = unionFind(pieces.length);
    shortCandidates(network, pieceOf, grid, excluded).sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to))
      .forEach(candidate => { if (sets.join(candidate.p, candidate.q)) bridges.push({ from: candidate.from, to: candidate.to, km: candidate.km, kind: 'short' }); });
    // 2. Long joins between the groups the short joins left, among those worth joining.
    const groups = new Map();
    pieces.forEach((piece, index) => {
      const root = sets.find(index);
      if (!groups.has(root)) groups.set(root, { keys: [], km: 0, builtKm: 0 });
      groups.get(root).keys.push(...piece.keys);
      groups.get(root).km += piece.km;
      groups.get(root).builtKm += piece.builtKm;
    });
    const worth = Array.from(groups.values()).filter(group => group.km >= MIN_PIECE_KM || group.keys.some(key => mustKeep.has(key)));
    log('pass ' + pass + ': ' + groups.size + ' groups after short joins, ' + worth.length + ' worth joining');
    longJoins(network, worth, grid, excluded, mustKeep).forEach(join => bridges.push({ ...join, kind: 'long' }));
    log('pass ' + pass + ': ' + bridges.length + ' new lines to lay (' + bridges.filter(bridge => bridge.kind === 'long').length + ' long)');
    if (!bridges.length) break;
    // 3. Lay the new lines: straight when short, over the terrain and through towns when not.
    bridges.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
    let refused = 0;
    bridges.forEach((bridge, index) => {
      if (bridge.km > 100) log('laying new line ' + (index + 1) + ' of ' + bridges.length + ', ' + Math.round(bridge.km) + ' km straight');
      const line = planLine(bridge, context);
      if (line.waterKm > MAX_WATER_KM) {
        rejected.push({ from: bridge.from, to: bridge.to });
        refused++;
        return;
      }
      addLine(network, line);
      laidLines.push(line);
    });
    log('pass ' + pass + ': ' + refused + ' joins not laid for crossing open water');
    if (!refused) break;
  }

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
  network.forgetLive();
  const lostCities = cityStops.filter(stop => !kept.has(stop.square)).map(stop => stop.name);
  log('kept ' + network.squares.size + ' squares; left out ' + dropped.length + ' isolated pieces (' + Math.round(droppedKm) + ' km)');

  const stubs = stubJoins(network, grid);
  log(stubs.length + ' line ends joined to track they only reached the long way round');
  stubs.forEach(join => laidLines.push(layLine(network, { ...join, kind: 'stub' }, context)));
  const facing = endJoins(network, grid, join => {
    const line = planLine({ ...join, kind: 'ends' }, context);
    if (!buildable(line)) { log('not joining ' + join.from + ' to ' + join.to + ': ' + (line.planned ? line.waterKm + ' km of water' : 'no way over the terrain')); return null; }
    return line;
  });
  facing.forEach(line => { addLine(network, line); laidLines.push(line); });
  log(facing.length + ' pairs of facing line ends joined (' + Math.round(facing.reduce((sum, line) => sum + line.km, 0)) + ' km)');
  const shortcuts = cityShortcuts(network, grid, settlements, join => {
    const line = planLine({ ...join, kind: 'shortcut' }, context);
    if (!buildable(line)) { log('no shortcut ' + join.note + ': ' + (line.planned ? line.waterKm + ' km of water' : 'no way over the terrain')); return null; }
    return line;
  });
  shortcuts.forEach(line => { addLine(network, line); laidLines.push(line); });
  log(shortcuts.length + ' shortcuts between towns a long way round by track (' + Math.round(shortcuts.reduce((sum, line) => sum + line.km, 0)) + ' km): '
    + shortcuts.map(line => line.note).join(', '));
  const regionOf = regionClassifier(network, settlements, grid);
  let spurPlaces = settlements.concat(options.outposts || []);
  // The outposts are half a million records on two continents, and nothing after the spurs needs them.
  options.outposts = null;
  const spurLines = spurs(network, grid, spurPlaces, regionOf, join => {
    const line = planLine({ ...join, kind: 'spur' }, context);
    return buildable(line) ? line : null;
  }, isHard);
  spurPlaces = null;
  spurLines.forEach(spur => { addLine(network, spur.line); laidLines.push({ ...spur.line, note: spur.place.name }); });
  log(spurLines.length + ' spurs out to places off rural lines (' + Math.round(spurLines.reduce((sum, spur) => sum + spur.line.km, 0)) + ' km)');
  const simplified = simplifyUrban(network, grid, regionOf, new Set(cityStops.map(stop => stop.square)));
  log('cities reduced to a hub and the lines into it: ' + simplified.areas + ' urban areas, ' + simplified.squares +
    ' squares and ' + simplified.moves + ' moves of track taken up');
  // Lines side by side: the authored routes and the cities stay.
  const mustStay = new Set(cityStops.map(stop => stop.square));
  laidLines.filter(line => line.kind === 'authored').forEach(line => line.parts.forEach(part =>
    traceLine(part.coordinates, grid, {}).forEach(visit => mustStay.add(keyOf(visit.x, visit.y)))));
  const stationSquares = new Set();
  stations.forEach(station => { const found = squareFor(network, station.coordinates, grid); if (found) stationSquares.add(found.square.key); });
  const parallel = pruneParallel(network, mustStay, stationSquares);
  log(parallel.stretches + ' stretches of line taken up where another way between the same junctions nearly matched them ('
    + parallel.km + ' km)');

  // 5. Stops: one per square, the highest ranked.
  const candidates = cityStops.filter(stop => kept.has(stop.square)).map(stop => ({ ...stop }));
  stations.forEach(station => {
    const found = squareFor(network, station.coordinates, grid);
    if (!found) return;
    candidates.push({ id: station.id, name: station.name, status: station.status, kind: station.kind,
      category: station.category, square: found.square.key, coordinates: station.coordinates });
  });
  // The new termini of authored routes, and the place at the end of each spur.
  authoredEnds.forEach(stop => candidates.push(stop));
  spurLines.forEach(spur => candidates.push({ id: spur.place.id, name: spur.place.name, status: 'settlement', kind: spur.place.kind,
    square: spur.square, coordinates: spur.place.coordinates, population: spur.place.population }));
  // Settlements on new lines, where no station was ever mapped.
  const newSquares = new Set();
  network.squares.forEach(square => { if ((square.gapKm || 0) > square.railKm) newSquares.add(square.key); });
  settlements.forEach(settlement => {
    const cell = projection.cellOf(settlement.coordinates, grid), key = keyOf(cell[0], cell[1]);
    if (!newSquares.has(key)) return;
    if (isHard(settlement.coordinates) && settlement.kind === 'village') return;
    candidates.push({ id: settlement.id, name: settlement.name, status: 'settlement', kind: settlement.kind, square: key,
      population: settlement.population,
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
      network.forgetLive();
    });
  }
  stopBySquare = pickStops();
  log('pruned ' + pruned + ' squares of short unnamed stubs');

  // Where the stops go. A railyard has two ends and one line at each, so no stop stands where three or more lines
  // meet: the junction is out on the line, where a driver picks a way, and a station there moves to the square next
  // to it on the line nearest the station. Every end of the line is a stop too, unless a busier one is beside it.
  const adjacentStops = network.neighbours();
  const degreeOf = key => adjacentStops.get(key).length;
  const nearestSettlementName = point => {
    let best = null;
    settlements.forEach(settlement => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > 1) return;
      const km = haversineKm(point, settlement.coordinates);
      if (!best || km < best.km) best = { name: settlement.name, km };
    });
    return best ? best.name : null;
  };
  const centreOfKey = key => { const square = network.squares.get(key); return projection.centreOf([square.x, square.y], grid); };
  let movedOffJunctions = 0, noRoomBesideJunction = 0;
  const placed = [];
  Array.from(stopBySquare.values()).forEach(candidate => {
    if (degreeOf(candidate.square) <= 2) { placed.push(candidate); return; }
    const beside = adjacentStops.get(candidate.square).filter(key => degreeOf(key) === 2)
      .map(key => ({ key, km: haversineKm(candidate.coordinates, centreOfKey(key)) }))
      .sort((a, b) => a.km - b.km || a.key.localeCompare(b.key))[0];
    if (!beside) { noRoomBesideJunction++; return; }
    placed.push({ ...candidate, square: beside.key });
    movedOffJunctions++;
  });
  Array.from(network.squares.keys()).sort().forEach(key => {
    if (degreeOf(key) !== 1) return;
    if (isHard(centreOfKey(key))) return;
    const centre = centreOfKey(key);
    placed.push({ id: 'end:' + key, status: 'end', square: key, coordinates: centre, name: nearestSettlementName(centre) || 'End of the line' });
  });
  const onePerSquare = new Map();
  placed.forEach(candidate => {
    const current = onePerSquare.get(candidate.square);
    if (!current || rank(candidate) > rank(current) || (rank(candidate) === rank(current) && candidate.id < current.id)) {
      onePerSquare.set(candidate.square, candidate);
    }
  });

  // Which stops get a railyard. The authored cities always; then the rest, the busiest place first, each only if
  // the place it serves is big enough for its region (YARD_RULES), no yard already kept is too close along the track
  // for its region and the people around it (DENSITY_RADIUS_KM), and no yard stands in a square touching it.
  const servedBy = bucketsOf(settlements, place => place.coordinates);
  const populationOf = stop => {
    if (stop.status === 'settlement' || stop.status === 'city') return stop.population || DEFAULT_POPULATION[stop.kind] || 0;
    let best = null;
    servedBy(stop.coordinates).forEach(place => {
      const km = haversineKm(stop.coordinates, place.coordinates);
      if (km <= SERVES_KM && (!best || km < best.km)) best = { km, population: place.population || DEFAULT_POPULATION[place.kind] || 0 };
    });
    return best ? best.population : 0;
  };
  const spacingFor = stop => {
    const rule = YARD_RULES[stop.region];
    if (rule.spacingKm !== null) return rule.spacingKm;
    const people = regionOf.peopleWithin(stop.coordinates, DENSITY_RADIUS_KM);
    return people < SPARSE_POPULATION ? 0 : people < DENSE_POPULATION ? RURAL_SPACING_KM : DENSE_SPACING_KM;
  };
  const yards = new Map(), maybe = [];
  onePerSquare.forEach(stop => {
    stop.region = regionOf(stop.coordinates);
    if (stop.status === 'city') yards.set(stop.square, stop);
    else maybe.push({ stop, population: populationOf(stop) });
  });
  const touchingYard = key => {
    const [x, y] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if ((dx || dy) && yards.has(keyOf(x + dx, y + dy))) return true;
    }
    return false;
  };
  maybe.sort((a, b) => b.population - a.population || rank(b.stop) - rank(a.stop) || a.stop.id.localeCompare(b.stop.id));
  const thinned = { urban: 0, industrial: 0, rural: 0 };
  maybe.forEach(({ stop, population }) => {
    let keep = population >= YARD_RULES[stop.region].minPopulation && !touchingYard(stop.square);
    const spacing = keep ? spacingFor(stop) : 0;
    if (keep && spacing > 0) {
      for (const key of distancesAlong(network, adjacentStops, stop.square, spacing).keys()) {
        if (key !== stop.square && yards.has(key)) { keep = false; break; }
      }
    }
    if (keep) yards.set(stop.square, stop);
    else thinned[stop.region]++;
  });
  stopBySquare = yards;
  log(movedOffJunctions + ' stations moved off junctions beside them, ' + noRoomBesideJunction + ' with no room; '
    + (thinned.urban + thinned.industrial + thinned.rural) + ' stops left without a yard: ' + JSON.stringify(thinned));

  // 6. Halts, so that outside a hard region no square is more than MAX_SECTION_KM / 2 from a stop by track, junctions
  // or not: a long line through a string of junctions has nowhere to stop just as surely as one without them. Each
  // halt goes at the square then farthest from any stop, never at a junction or beside a yard, and is named for the
  // nearest settlement within HALT_NAME_KM or for its distance from the stop it was farthest from.
  const adjacent = network.neighbours();
  const edgeKm = (a, b) => network.edges.get(a < b ? a + '|' + b : b + '|' + a).km;
  const nearestSettlement = point => {
    let best = null;
    settlements.forEach(settlement => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > 0.2) return;
      const km = haversineKm(point, settlement.coordinates);
      if (km <= HALT_NAME_KM && (!best || km < best.km)) best = { settlement, km };
    });
    return best && best.settlement;
  };
  const reach = new Map(), from = new Map();
  const spread = (sources, limit) => {
    const queue = new Heap(), settled = new Set();
    sources.forEach(([key, name]) => { reach.set(key, 0); from.set(key, name); queue.push(0, key); });
    while (queue.size) {
      const key = queue.pop();
      if (settled.has(key)) continue;
      settled.add(key);
      const km = reach.get(key);
      adjacent.get(key).forEach(next => {
        const total = km + edgeKm(key, next);
        if (total <= limit && total < (reach.get(next) ?? Infinity)) { reach.set(next, total); from.set(next, from.get(key)); queue.push(total, next); }
      });
    }
  };
  spread(Array.from(stopBySquare.entries()).map(([key, stop]) => [key, stop.name]), Infinity);
  const halfSection = MAX_SECTION_KM / 2;
  const wanted = Array.from(network.squares.keys()).filter(key => adjacent.get(key).length === 2 && !stopBySquare.has(key)
    && (reach.get(key) ?? Infinity) > halfSection && !isHard(centreOfKey(key)))
    .sort((a, b) => (reach.get(b) ?? Infinity) - (reach.get(a) ?? Infinity) || a.localeCompare(b));
  let halts = 0;
  wanted.forEach(key => {
    if ((reach.get(key) ?? Infinity) <= halfSection || touchingYard(key)) return;
    const centre = centreOfKey(key), near = nearestSettlement(centre), km = reach.get(key), startName = from.get(key);
    stopBySquare.set(key, { id: 'halt:' + key, status: 'halt', square: key, coordinates: centre, region: regionOf(centre),
      name: near ? near.name : (startName && km < Infinity ? 'Km ' + Math.round(km) + ' from ' + startName : 'Halt') });
    halts++;
    spread([[key, stopBySquare.get(key).name]], halfSection);
  });
  log(stopBySquare.size + ' stops, ' + halts + ' of them halts on long sections');
  // The points out on the line: junctions, where a driver picks a way, and buffers, where a line ends with no yard.
  const points = Array.from(network.squares.keys()).sort().filter(key => adjacent.get(key).length !== 2 && !stopBySquare.has(key))
    .map(key => {
      const centre = centreOfKey(key), kind = adjacent.get(key).length === 1 ? 'buffer' : 'junction';
      return { square: key, kind, name: nearestSettlementName(centre) || (kind === 'junction' ? 'Junction' : 'End of the line') };
    });
  log(points.filter(point => point.kind === 'junction').length + ' junctions and ' + points.filter(point => point.kind === 'buffer').length
    + ' buffers out on the line');

  // 7. Elevation is filled in afterwards, in blocks, once the network is safely on disk (fillElevation).
  const tiles = [];

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
    region: stop.region || regionOf(stop.coordinates),
    square: stop.square, coordinates: stop.coordinates.map(value => Math.round(value * 1e7) / 1e7)
  }));
  const regionCounts = { urban: 0, industrial: 0, rural: 0 };
  stops.forEach(stop => regionCounts[stop.region]++);
  return {
    squares, stops, points,
    bridges: laidLines,
    startSquare: startKey,
    stats: {
      squareCount: squares.length,
      moveCount: squares.reduce((sum, square) => sum + square.ends.length, 0) / 2,
      stopCount: stops.length, haltCount: halts,
      bridgeCount: laidLines.length, bridgeKm: Math.round(laidLines.reduce((sum, line) => sum + line.km, 0)),
      stubJoinCount: laidLines.filter(line => line.kind === 'stub').length,
      authoredJoinCount: laidLines.filter(line => line.kind === 'authored').length,
      endJoinCount: facing.length, spurCount: spurLines.length, shortcutCount: shortcuts.length,
      parallelStretchesRemoved: parallel.stretches, parallelKmRemoved: parallel.km,
      onExistingTrackKm: Math.round(laidLines.reduce((sum, line) => sum + (line.onExistingTrackKm || 0), 0)),
      stationsMovedOffJunctions: movedOffJunctions, junctionPoints: points.filter(point => point.kind === 'junction').length,
      bufferPoints: points.filter(point => point.kind === 'buffer').length,
      urbanAreas: simplified.areas, urbanSquaresRemoved: simplified.squares, urbanMovesRemoved: simplified.moves,
      stopRegions: regionCounts, stationsWithoutYard: thinned,
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
  const header = Object.entries(artifact).filter(([key]) => !['squares', 'stops', 'points', 'bridges'].includes(key));
  stream.write('{\n' + header.map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join(',\n'));
  ['stops', 'points', 'bridges', 'squares'].forEach(key => {
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
  const grid = scope.grid, cache = defaultCache();
  const joinsFile = path.join(root, 'world/authored/network-joins.json');
  // A route with a "scope" is laid only in that scope's build (a route in Alaska means nothing to South America's).
  const authoredJoins = (fs.existsSync(joinsFile) ? JSON.parse(fs.readFileSync(joinsFile, 'utf8')).joins : [])
    .filter(join => !join.scope || join.scope === AREA.name);
  const outpostCount = { value: 0 };
  const readOutposts = () => {
    const places = fs.existsSync(path.join(root, scope.outposts)) ? read(scope.outposts).places : [];
    outpostCount.value = places.length;
    return places;
  };
  const regionsFile = path.join(root, 'world/authored/regions.json');
  const regions = fs.existsSync(regionsFile) ? JSON.parse(fs.readFileSync(regionsFile, 'utf8')).regions : [];
  const built = buildNetwork({ geometry, stations: stationSet.stations, settlements: settlementSet.places, cities, grid, cache,
    authoredJoins, outposts: readOutposts(), regions });
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
      outposts: { id: AREA.prefix + '-outposts', count: outpostCount.value },
      elevation: { sourceId: 'copernicus-dem-glo90', aggregation: 'mean-and-population-standard-deviation-within-grid-square',
        tileCount: 0 }
    },
    parameters: { traceStepsPerCell: TRACE_STEPS_PER_CELL, shortBridgeKm: SHORT_BRIDGE_KM, straightBridgeKm: STRAIGHT_BRIDGE_KM,
      longBridgeMaxKm: LONG_BRIDGE_MAX_KM, minPieceKm: MIN_PIECE_KM, cityReachKm: CITY_REACH_KM, bridgeMinKm: BRIDGE_MIN_KM,
      tunnelMinShare: TUNNEL_MIN_SHARE, maxSectionKm: MAX_SECTION_KM, minStubKm: MIN_STUB_KM, stubJoinKm: STUB_JOIN_KM,
      stubDetourFactor: STUB_DETOUR_FACTOR, stubDetourMinKm: STUB_DETOUR_MIN_KM, authoredSnapKm: AUTHORED_SNAP_KM,
      endJoinKm: END_JOIN_KM, endDetourFactor: END_DETOUR_FACTOR, endDetourMinKm: END_DETOUR_MIN_KM, maxWaterKm: MAX_WATER_KM,
      spurMinKm: SPUR_MIN_KM, spurMaxKm: SPUR_MAX_KM, spurSpacingKm: SPUR_SPACING_KM, genericNameCount: GENERIC_NAME_COUNT,
      spliceMinKm: SPLICE_MIN_KM, spliceDetourFactor: SPLICE_DETOUR_FACTOR, spliceDetourKm: SPLICE_DETOUR_KM,
      shortcutPopulation: SHORTCUT_POPULATION, shortcutKm: SHORTCUT_KM, shortcutDetourFactor: SHORTCUT_DETOUR_FACTOR,
      shortcutDetourMinKm: SHORTCUT_DETOUR_MIN_KM, cityTrackKm: CITY_TRACK_KM, parallelFactor: PARALLEL_FACTOR,
      parallelExtraKm: PARALLEL_EXTRA_KM, densityRadiusKm: DENSITY_RADIUS_KM, sparsePopulation: SPARSE_POPULATION,
      densePopulation: DENSE_POPULATION, ruralSpacingKm: RURAL_SPACING_KM, denseSpacingKm: DENSE_SPACING_KM,
      urbanPopulation: URBAN_POPULATION, urbanRadiusKm: URBAN_RADIUS_KM, industrialRailKm: INDUSTRIAL_RAIL_KM,
      industrialRadiusKm: INDUSTRIAL_RADIUS_KM, defaultPopulation: DEFAULT_POPULATION, yardRules: YARD_RULES, servesKm: SERVES_KM,
      terrain: terrain.PARAMETERS },
    navigable: true,
    startSquare: built.startSquare,
    stats: built.stats,
    stops: built.stops,
    points: built.points,
    bridges: built.bridges,
    squares: built.squares
  };
  const target = path.join(root, scope.output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // On disk before the elevation, so a failure there costs only `--elevation-only`, not the whole build.
  await writeNetwork(target, artifact);
  saveRoutes();
  log('network written without elevation; filling it in');
  artifact.sources.elevation.tileCount = fillElevation(artifact.squares, grid, cache).length;
  await writeNetwork(target, artifact);
  console.log('Wrote ' + scope.output + ': ' + JSON.stringify(built.stats));
}

// Fills in the elevation of a network already written, and writes it again.
async function elevationOnly() {
  const target = path.join(root, SCOPE.output);
  const artifact = JSON.parse(fs.readFileSync(target, 'utf8'));
  artifact.sources.elevation.tileCount = fillElevation(artifact.squares, artifact.grid, defaultCache()).length;
  await writeNetwork(target, artifact);
  console.log('Wrote ' + SCOPE.output + ' with elevation for ' + artifact.squares.length + ' squares');
}

if (require.main === module) {
  (process.argv.includes('--elevation-only') ? elevationOnly() : main()).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { hardRegionTest, longJoins, buildNetwork, stubJoins, endJoins, cityShortcuts, pruneParallel, spliceOntoTrack, spurs, regionClassifier, simplifyUrban, traceLine, Network, placeIndex, resolveRoute };
