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
const { defaultCache, copernicusTileName, fetchTiles, tilesInFrame } = require('./dem.cjs');
const { parseCsv } = require('./csv.cjs');
const { readRecords } = require('./records.cjs');
const { inScope } = require('./scopes.cjs');
const checkpoint = require('./checkpoint.cjs');
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
const MAX_SECTION_KM = 200;
const HALT_NAME_KM = 15;
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
const PARALLEL_FACTOR = 2;
const PARALLEL_EXTRA_KM = 40;
// In the country, how far apart along the track two yards must be depends on how many people live within
// DENSITY_RADIUS_KM: under SPARSE_POPULATION, SPARSE_SPACING_KM; up to DENSE_POPULATION, RURAL_SPACING_KM; beyond,
// DENSE_SPACING_KM. Likea wanted the world's 33,000 stops brought down to about 20,000 (September 2026). Whatever the region, no two yards stand in squares that touch: the busier place keeps its yard.
const DENSITY_RADIUS_KM = 50;
const SPARSE_POPULATION = 150000;
const DENSE_POPULATION = 1000000;
const SPARSE_SPACING_KM = 15;
const RURAL_SPACING_KM = 25;
const DENSE_SPACING_KM = 35;
// A station stands on a square where the line runs straight through (or ends): the yard is drawn straight, with one
// line at each end. A station mapped on a bend or a junction moves to the nearest straight square along the line
// within STATION_SHIFT_SQUARES, or has no yard.
const STATION_SHIFT_SQUARES = 4;
// In a hard region, where every real town is a stop the player's life can depend on, it may move this far instead.
const HARD_STATION_SHIFT_SQUARES = 12;
// A station keeps its yard only if the place it serves has STATION_PEOPLE_PER_TRACK_KM people for every kilometre of
// track within STATION_DENSITY_RADIUS_KM of it: where the rails are dense, only the larger towns; where they are
// sparse, villages too. Hard regions keep every real town. Then only the track that joins the stations up is kept
// (thinTrack): each station's ways to its TRACK_NEIGHBOURS nearest stations by track, within TRACK_NEIGHBOUR_KM.
// Likea wanted about 5,000 stations and a like cut in the railways, keeping the key corridors and plenty of
// alternative routes (September 2026).
const STATION_DENSITY_RADIUS_KM = 50;
const STATION_PEOPLE_PER_TRACK_KM = 80;
const TRACK_NEIGHBOURS = 2;
const TRACK_NEIGHBOUR_KM = 1500;
// ...and a stretch not kept that would save the way round by ALTERNATIVE_FACTOR times plus ALTERNATIVE_EXTRA_KM goes
// back in: the network keeps its real alternative routes and cut-offs, not its lines side by side.
const ALTERNATIVE_FACTOR = 2;
const ALTERNATIVE_EXTRA_KM = 100;
const ALTERNATIVE_SEARCH_KM = 600;
// An authored route's ends must lie within this of the network.
const AUTHORED_SNAP_KM = 10;
// In a hard region, a town or a city this near the line is a stop (stageStops).
const HARD_TOWN_KM = 10;
// Two places of the same name and size further apart than this are different places, and the route must say which.
const SAME_PLACE_KM = 20;
// Hand-made edits (world/authored/network-edits.json). A kept route follows the track already there unless the way by
// track between two of its stops is more than KEEP_DETOUR_FACTOR times the straight line and KEEP_DETOUR_EXTRA_KM more,
// when a new line is laid between them. A removed route leaves the track within REMOVE_CLEAR_KM of its ends, so the
// towns there keep their other lines.
const KEEP_DETOUR_FACTOR = 1.6;
const KEEP_DETOUR_EXTRA_KM = 50;
const REMOVE_CLEAR_KM = 10;
// Significant places (world/external/significant-places.json: capitals, cities of a million, the world's most important
// places) are stations whenever track passes within SIGNIFICANT_REACH_KM of them, and are never thinned away.
const SIGNIFICANT_REACH_KM = 15;
// A long branch of real track to the end of the line (the Hudson Bay Railway to Churchill, the Overseas Railroad to
// Key West) is a destination in itself: a line end at least TERMINUS_BRANCH_KM from the nearest junction, mostly mapped
// railway (TERMINUS_MAPPED_SHARE), keeps a station at a town or city within HALT_NAME_KM of its end.
const TERMINUS_BRANCH_KM = 150;
const TERMINUS_MAPPED_SHARE = 0.5;
// A plain run of mapped railway between two stations kept, with no junction on it, goes back in however long it is when
// the way round by the track kept is ALTERNATIVE_FACTOR times as long (the Qinghai-Tibet railway): the alternatives
// search stops at ALTERNATIVE_SEARCH_KM, which one line across a plateau outruns. Mostly mapped: MAPPED_RUN_SHARE.
const MAPPED_RUN_SHARE = 0.8;
// A station is named for the town or city it stands in (Likea, 2026-09-30: San Francisco, not 22nd Street), within
// TOWN_NAME_BASE_KM plus a kilometre for each TOWN_NAME_PEOPLE_PER_KM squared people, and no more than TOWN_NAME_MAX_KM.
const TOWN_NAME_BASE_KM = 2;
const TOWN_NAME_PEOPLE_PER_KM = 45;
const TOWN_NAME_MAX_KM = 25;
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
  grid: Object.assign({}, projection.GRID, { centre: AREA.gridCentre }, AREA.gridOrigin ? { origin: AREA.gridOrigin } : {})
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Every line of the log says when it was written, how long the build has been running and how much memory it holds,
// so a slow stage or a leak shows in the log of any run.
const STARTED = Date.now();
function log(message) {
  if (process.env.ASHLINE_WORLD_QUIET === '1') return;
  const now = new Date(), memory = process.memoryUsage().rss / 1073741824;
  console.error('[network ' + now.toISOString().slice(11, 19) + ' +' + seconds(Date.now() - STARTED) + ' ' + memory.toFixed(1) + ' GB] ' + message);
}
function seconds(ms) {
  const total = Math.round(ms / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60;
  return (hours ? hours + 'h' : '') + (hours || minutes ? String(minutes).padStart(hours ? 2 : 1, '0') + 'm' : '')
    + String(total % 60).padStart(hours || minutes ? 2 : 1, '0') + 's';
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
  const points = [{ coordinates: from }].concat(join.through || [], [{ coordinates: to, tunnel: !!join.toTunnel }]);
  let coordinates = [from], via = [], waterKm = 0, planned = true;
  const tunnels = [];
  for (let hop = 1; hop < points.length; hop++) {
    const start = coordinates.at(-1), end = points[hop].coordinates, long = haversineKm(start, end) > STRAIGHT_BRIDGE_KM;
    // A hop marked as a tunnel runs straight to its stop under whatever lies between, sea included: a strait crossed
    // on purpose (the Bering Strait by the Diomedes), which the rule against open water must not refuse.
    if (points[hop].tunnel) {
      coordinates.push(end);
      tunnels.push([start, end]);
      if (hop < points.length - 1 && points[hop].name) via.push(points[hop].name);
      continue;
    }
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
    ...(tunnels.length ? { tunnels, tunnelKm: round3(tunnels.reduce((sum, [a, b]) => sum + haversineKm(a, b), 0)) } : {}),
    coordinates: rounded, ...(segments.length !== 1 || laidKm < km - 1 ? { segments } : {}) };
  Object.defineProperty(line, 'planned', { value: planned });
  Object.defineProperty(line, 'grid', { value: grid });
  Object.defineProperty(line, 'parts', { value: segments });
  return line;
}

function addLine(network, line) {
  const grid = line.grid;
  // Points every half kilometre along the line's tunnels: a square the line passes through with its middle this close
  // to one is in the tunnel. Found from the squares the line was traced through, since a tunnel traced on its own can
  // step round a diagonal by the other square of the staircase.
  const underground = (line.tunnels || []).flatMap(([a, b]) => {
    const steps = Math.max(1, Math.ceil(haversineKm(a, b) / 0.5));
    return Array.from({ length: steps + 1 }, (_, step) => [a[0] + (b[0] - a[0]) * step / steps, a[1] + (b[1] - a[1]) * step / steps]);
  });
  const inTunnel = visit => {
    const centre = projection.centreOf([visit.x, visit.y], grid);
    return underground.some(point => haversineKm(point, centre) <= grid.cellKm * 0.75);
  };
  line.parts.forEach(part => {
    const [a, b] = [part.from, part.to].map(key => { const [x, y] = key.split(',').map(Number); return { x, y }; });
    const visits = traceLine(part.coordinates, grid, {});
    if (!visits.length) visits.push({ x: a.x, y: a.y, km: 0 });
    // A line from one square's middle to another's always starts and ends in them.
    if (visits[0].x !== a.x || visits[0].y !== a.y) visits.unshift({ x: a.x, y: a.y, km: 0 });
    if (visits.at(-1).x !== b.x || visits.at(-1).y !== b.y) visits.push({ x: b.x, y: b.y, km: 0 });
    network.add(visits, { id: line.kind + ':' + part.from + '>' + part.to, gap: true });
    // Those squares hold their new track underground: they are written out as tunnels.
    if (underground.length) visits.forEach(visit => {
      if (!inTunnel(visit)) return;
      const square = network.squares.get(keyOf(visit.x, visit.y));
      square.tunnelGapKm = (square.tunnelGapKm || 0) + visit.km;
    });
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
function routeKey(start, end, settlements, cache) {
  if (!routeMemo.routes) {
    routeMemo.file = path.join(cache, 'terrain-routes-' + AREA.prefix + '.json');
    try {
      routeMemo.routes = JSON.parse(fs.readFileSync(routeMemo.file, 'utf8'));
    } catch (error) {
      routeMemo.routes = {};
    }
    routeMemo.stamp = crypto.createHash('sha1').update(JSON.stringify(terrain.PARAMETERS) + ':' + settlements.length).digest('hex').slice(0, 12);
  }
  return routeMemo.stamp + ':' + start.map(value => value.toFixed(5)).join(',') + '>' + end.map(value => value.toFixed(5)).join(',');
}
function routeOverTerrain(start, end, settlements, cache) {
  const key = routeKey(start, end, settlements, cache);
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

// Plans ahead, all at once and a worker thread to a core (terrain-pool.cjs), the terrain routes a batch of joins will
// ask routeOverTerrain for, so laying them one by one finds each already planned. joins are { from, to } square keys;
// only a join's own ends are planned (not the stops of an authored route), and only those long enough to be routed and
// not planned before. The same routes, in the same memo, as without it: only sooner. Across two continents a pass
// can hold tens of thousands of joins, which one thread plans in hours.
const PREFETCH_MIN_ROUTES = 40;
function prefetchRoutes(joins, context) {
  const { grid, settlements, cache, settlementsFile } = context;
  if (!settlementsFile || !joins.length) return;
  const tasks = [], seen = new Set();
  joins.forEach(join => {
    const [start, end] = [join.from, join.to].map(key => projection.centreOf(key.split(',').map(Number), grid));
    if (haversineKm(start, end) <= STRAIGHT_BRIDGE_KM) return;
    const key = routeKey(start, end, settlements, cache);
    if (seen.has(key) || Object.prototype.hasOwnProperty.call(routeMemo.routes, key)) return;
    seen.add(key);
    tasks.push([key, start, end]);
  });
  if (tasks.length < PREFETCH_MIN_ROUTES) return;
  log('planning ' + tasks.length + ' new lines over the terrain in parallel');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-terrain-pool-'));
  try {
    const tasksFile = path.join(temporary, 'tasks.json'), resultsFile = path.join(temporary, 'results.ndjson');
    fs.writeFileSync(tasksFile, JSON.stringify({ settlements: settlementsFile, centre: grid.centre, cache, tasks }));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'terrain-pool.cjs'), tasksFile, resultsFile],
      { stdio: ['ignore', 'inherit', 'inherit'] });
    // Whatever the pool finished is kept even if it failed part way; the rest are planned one by one as before.
    if (fs.existsSync(resultsFile)) {
      fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).forEach(line => {
        const [key, route] = JSON.parse(line);
        routeMemo.routes[key] = route;
        routeMemo.dirty = true;
      });
    }
    if (result.status !== 0) log('the terrain pool stopped early (' + (result.error ? result.error.message : 'status ' + result.status) + '); planning the rest one by one');
    saveRoutes();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

// Track distances from one square to some others, each only as far as it matters: targets maps a square to the
// distance beyond which it counts as far (its threshold). The search stops once every target is either reached or
// has a threshold no further than the search has already gone, so it is certainly beyond it. Returns the reached
// targets' distances; a target missing from the result is at least its threshold away by track. The same answers
// as distancesAlong out to the largest threshold, without searching a continent's track for every line end.
function distancesTo(network, adjacent, start, targets, extra = {}) {
  const distance = new Map([[start, 0]]), settled = new Set(), queue = new Heap(), found = new Map();
  const waiting = new Map(targets);
  let farthest = Math.max(0, ...waiting.values());
  queue.push(0, start);
  while (queue.size && waiting.size) {
    const key = queue.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    const km = distance.get(key);
    if (km >= farthest) break;
    if (waiting.has(key)) {
      found.set(key, km);
      const threshold = waiting.get(key);
      waiting.delete(key);
      if (threshold === farthest) farthest = Math.max(0, ...waiting.values());
      if (!waiting.size) break;
    }
    const steps = adjacent.get(key).map(next => [next, network.edges.get(key < next ? key + '|' + next : next + '|' + key).km])
      .concat(extra[key] || []);
    steps.forEach(([next, stepKm]) => {
      const total = km + stepKm;
      if (total < farthest && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); queue.push(total, next); }
    });
  }
  return found;
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
// makes the next one across the same gap redundant. plan(join) returns the line to lay, or null to skip the join;
// prefetch(joins), when given, is shown every candidate first, to plan their routes ahead (prefetchRoutes).
function endJoins(network, grid, plan, prefetch) {
  const adjacent = network.neighbours(), limitKm = END_JOIN_KM * END_DETOUR_FACTOR;
  const isLongWayRound = (byTrack, km) => byTrack === undefined || (byTrack >= km * END_DETOUR_FACTOR && byTrack - km >= END_DETOUR_MIN_KM);
  // How far by track two ends km apart must be for that: the same limit the search had when it ran out to it.
  const thresholdOf = km => Math.min(limitKm, Math.max(km * END_DETOUR_FACTOR, km + END_DETOUR_MIN_KM));
  const ends = Array.from(network.squares.keys()).sort().filter(key => adjacent.get(key).length === 1);
  const candidates = [];
  ends.forEach((end, index) => {
    if (index && index % 500 === 0) log('facing ends: ' + index + ' of ' + ends.length + ' line ends checked');
    const square = network.squares.get(end);
    const near = ends.slice(index + 1).map(other => ({ other, km: gridKm(square, network.squares.get(other), grid) }))
      .filter(pair => pair.km > STUB_JOIN_KM && pair.km <= END_JOIN_KM);
    if (!near.length) return;
    // Each end only as far along the track as it needs to be to count as the long way round.
    const along = distancesTo(network, adjacent, end, new Map(near.map(pair => [pair.other, thresholdOf(pair.km)])));
    near.forEach(pair => { if (isLongWayRound(along.get(pair.other), pair.km)) candidates.push({ from: end, to: pair.other, km: pair.km }); });
  });
  candidates.sort((a, b) => a.km - b.km || (a.from + a.to).localeCompare(b.from + b.to));
  if (prefetch) prefetch(candidates);
  const accepted = [], extra = {}, joined = new Set();
  candidates.forEach(candidate => {
    if (joined.has(candidate.from) || joined.has(candidate.to)) return;
    const along = distancesTo(network, adjacent, candidate.from, new Map([[candidate.to, thresholdOf(candidate.km)]]), extra);
    if (!isLongWayRound(along.get(candidate.to), candidate.km)) return;
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
// cluster of towns rather than each pair getting its own. plan(join) returns the line to lay, or null to skip it;
// prefetch(joins), when given, is shown every candidate first, as in endJoins.
function cityShortcuts(network, grid, settlements, plan, prefetch) {
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
  if (prefetch) prefetch(candidates);
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

// Items in small buckets, for "everything within this many kilometres of a point": only the buckets the circle can
// reach are read, however far north. Where villages lie a few kilometres apart (the Ganges plain, Europe) the wide
// buckets of bucketsOf hold thousands of places each; these, a tenth of a degree across, hold a few dozen. Each item's
// place in items is kept as its order, so a search that keeps the first of two equally near items keeps the same
// one a scan of items would. The query returns [item, km, order] for every item within radiusKm.
function nearIndex(items, pointOf, degrees = 0.1) {
  const buckets = new Map(), scale = 1 / degrees;
  items.forEach((item, order) => {
    const point = pointOf(item), key = Math.floor(point[0] * scale) + ',' + Math.floor(point[1] * scale);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([item, point, order]);
  });
  return (point, radiusKm) => {
    const rows = Math.ceil(radiusKm / (110.5 * degrees)) + 1;
    const cos = Math.max(0.02, Math.cos(Math.min(89, Math.abs(point[1]) + rows * degrees) * Math.PI / 180));
    const columns = Math.min(Math.ceil(scale * 360), Math.ceil(radiusKm / (111.3 * degrees * cos)) + 1);
    const x = Math.floor(point[0] * scale), y = Math.floor(point[1] * scale), found = [];
    for (let dy = -rows; dy <= rows; dy++) for (let dx = -columns; dx <= columns; dx++) {
      (buckets.get((x + dx) + ',' + (y + dy)) || []).forEach(([item, at, order]) => {
        const km = haversineKm(point, at);
        if (km <= radiusKm) found.push([item, km, order]);
      });
    }
    return found;
  };
}

// The region a point is in: 'urban', 'industrial' or 'rural' (see URBAN_POPULATION and INDUSTRIAL_RAIL_KM).
function regionClassifier(network, settlements, grid) {
  const peopleNear = nearIndex(settlements, place => place.coordinates);
  const squares = Array.from(network.squares.values()).filter(square => square.railKm > 0)
    .map(square => ({ railKm: square.railKm, centre: projection.centreOf([square.x, square.y], grid) }));
  const trackNear = nearIndex(squares, square => square.centre);
  const people = place => place.population || DEFAULT_POPULATION[place.kind] || 0;
  const peopleAt = point => peopleNear(point, URBAN_RADIUS_KM).reduce((sum, [place]) => sum + people(place), 0);
  const regionOf = point => {
    if (peopleAt(point) >= URBAN_POPULATION) return 'urban';
    const track = trackNear(point, INDUSTRIAL_RADIUS_KM).sort((a, b) => a[2] - b[2]).reduce((sum, [square]) => sum + square.railKm, 0);
    return track >= INDUSTRIAL_RAIL_KM ? 'industrial' : 'rural';
  };
  regionOf.peopleAt = peopleAt;
  // People within a wider radius, for how busy a region is.
  const peopleWide = nearIndex(settlements, place => place.coordinates, 0.5);
  regionOf.peopleWithin = (point, radiusKm) => peopleWide(point, radiusKm).reduce((sum, [place]) => sum + people(place), 0);
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
// reach, as { line, place }. prefetch(joins), when given, is shown the next SPUR_LOOKAHEAD spurs that could be laid
// whenever the one to plan was not shown before, to plan their routes ahead (prefetchRoutes): which are laid still
// depends on the ones before them, so only a window ahead is worth planning.
const PLACE_KIND_RANK = { city: 6, town: 5, village: 4, hamlet: 3, isolated_dwelling: 2, farm: 2 };
const SPUR_LOOKAHEAD = 300;
function spurs(network, grid, places, regionOf, plan, isHard, prefetch) {
  const adjacent = network.neighbours();
  const branchPoints = new Set(Array.from(network.squares.keys()).filter(key => adjacent.get(key).length !== 2));
  const squares = Array.from(network.squares.values()).map(square => ({ key: square.key, centre: projection.centreOf([square.x, square.y], grid) }));
  // Squares by where they are: a place with track within SPUR_MIN_KM is passed over at once, and only the rest look
  // out to SPUR_MAX_KM for the nearest square (the first listed of two as near). Two continents' hamlets are millions.
  const squaresNear = nearIndex(squares, square => square.centre);
  const nameCount = new Map();
  places.forEach(place => nameCount.set(place.name, (nameCount.get(place.name) || 0) + 1));
  const candidates = [];
  places.forEach(place => {
    if (!PLACE_KIND_RANK[place.kind] || nameCount.get(place.name) > GENERIC_NAME_COUNT) return;
    if (squaresNear(place.coordinates, SPUR_MIN_KM).length) return;
    let nearest = null;
    squaresNear(place.coordinates, SPUR_MAX_KM).forEach(([square, km, order]) => {
      if (!nearest || km < nearest.km || (km === nearest.km && order < nearest.order)) nearest = { key: square.key, centre: square.centre, km, order };
    });
    if (nearest) candidates.push({ place, from: nearest.key, fromCentre: nearest.centre, km: nearest.km });
  });
  candidates.sort((a, b) => PLACE_KIND_RANK[b.place.kind] - PLACE_KIND_RANK[a.place.kind] || a.km - b.km || a.place.id.localeCompare(b.place.id));
  // The spur a candidate would be, given the spurs laid so far, or null when there is to be none.
  const spurFor = candidate => {
    if (branchPoints.has(candidate.from)) return null;
    const along = distancesAlong(network, adjacent, candidate.from, SPUR_SPACING_KM);
    for (const key of along.keys()) if (branchPoints.has(key)) return null;
    if (regionOf(candidate.fromCentre) !== 'rural' || (isHard && isHard(candidate.fromCentre))) return null;
    const cell = projection.cellOf(candidate.place.coordinates, grid);
    const to = keyOf(cell[0], cell[1]);
    if (network.squares.has(to)) return null;
    return { from: candidate.from, to, km: candidate.km };
  };
  const laid = [];
  let shownUntil = 0;
  candidates.forEach((candidate, index) => {
    const join = spurFor(candidate);
    if (!join) return;
    if (prefetch && index >= shownUntil) {
      const ahead = [];
      for (shownUntil = index; shownUntil < candidates.length && ahead.length < SPUR_LOOKAHEAD; shownUntil++) {
        const next = spurFor(candidates[shownUntil]);
        if (next) ahead.push(next);
      }
      prefetch(ahead);
    }
    const line = plan(join);
    if (!line) return;
    branchPoints.add(candidate.from);
    laid.push({ line, place: candidate.place, square: join.to });
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
// filled in place. Returns the names of the tiles under them.
//
// A square's elevation never changes for a given grid, so every one worked out is kept in a file beside the tiles,
// appended to a block at a time: a rebuild only resamples squares it has not seen, and a build that dies part way
// through keeps every block it finished.
const ELEVATION_BLOCK = 256;
function fillElevation(squares, grid, cache) {
  const known = elevationCache(grid, cache);
  const tileNames = new Set();
  squares.forEach(square => {
    [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]].forEach(([dx, dy]) => {
      const point = projection.centreOf([square.x + dx, square.y + dy], grid);
      tileNames.add(copernicusTileName(point[0], point[1]));
    });
  });
  const missing = squares.filter(square => {
    const found = known.values.get(keyOf(square.x, square.y));
    if (!found) return true;
    square.elevationM = found[0];
    square.elevationStdDevM = found[1];
    return false;
  });
  log('elevation: ' + (squares.length - missing.length) + ' squares already known, ' + missing.length + ' to resample');
  const blocks = new Map();
  missing.forEach(square => {
    const key = Math.floor(square.x / ELEVATION_BLOCK) + ',' + Math.floor(square.y / ELEVATION_BLOCK);
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(square);
  });
  const origin = projection.project(grid.origin, grid);
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
    const width = box[2] - box[0] + 1, height = box[3] - box[1] + 1;
    const extent = [(origin[0] + (box[0] - 0.5) * grid.cellKm) * 1000, (origin[1] + (box[1] - 0.5) * grid.cellKm) * 1000,
      (origin[0] + (box[2] + 0.5) * grid.cellKm) * 1000, (origin[1] + (box[3] + 0.5) * grid.cellKm) * 1000];
    const rasters = {};
    if (files.length) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-network-dem-'));
      try {
        // A block across the 180th meridian (Chukotka) reads its tiles with longitudes from 0 to 360, those west of the
        // meridian moved round to meet the rest, rather than as one mosaic the width of the world.
        const east = files.some(file => /_E17\d_00_DEM/.test(file)), west = files.some(file => /_W1[6-8]\d_00_DEM/.test(file));
        const across = east && west;
        const listFile = path.join(temporary, 'tiles.txt');
        fs.writeFileSync(listFile, (across ? tilesInFrame(files, [0, -90, 360, 90], temporary) : files).join('\n') + '\n');
        const vrt = path.join(temporary, 'dem.vrt');
        run('gdalbuildvrt', ['-q', '-vrtnodata', String(NODATA), '-input_file_list', listFile, vrt]);
        ['average', 'rms'].forEach(method => {
          const output = path.join(temporary, method + '.bin');
          run('gdalwarp', ['-q', '-overwrite', '-wm', '64', '--config', 'GDAL_CACHEMAX', '64',
            ...(across ? ['-s_srs', '+proj=longlat +datum=WGS84 +lon_wrap=180 +no_defs'] : []), '-t_srs', srs,
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
    known.add(list);
    done++;
    if (done % 10 === 0 || done === blocks.size) log('elevation: ' + done + ' of ' + blocks.size + ' blocks');
  });
  // The tiles under the squares that exist (tiles all of sea do not), whether or not this run read them.
  return Array.from(tileNames).filter(name => fs.existsSync(path.join(cache, name + '.tif'))).map(name => name + '.tif').sort();
}

// The elevations already worked out on a grid: { values: Map of 'x,y' -> [elevationM, elevationStdDevM], add(squares) }.
// One tab-separated line per square, appended as blocks finish; a line cut short by a crash is ignored.
function elevationCache(grid, cache) {
  const file = path.join(cache, 'elevation-squares-' + checkpoint.hashOf(grid, NODATA, 'mean-and-rms-v1') + '.tsv');
  const values = new Map();
  if (fs.existsSync(file)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
      const fields = line.split('\t');
      if (fields.length !== 4 || fields.some(field => field === '' || !Number.isFinite(Number(field)))) return;
      values.set(fields[0] + ',' + fields[1], [Number(fields[2]), Number(fields[3])]);
    });
  }
  return {
    values,
    add: squares => {
      fs.mkdirSync(cache, { recursive: true });
      fs.appendFileSync(file, squares.map(square => {
        values.set(keyOf(square.x, square.y), [square.elevationM, square.elevationStdDevM]);
        return [square.x, square.y, square.elevationM, square.elevationStdDevM].join('\t') + '\n';
      }).join(''));
    }
  };
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
  // The authored cities first of all, then the other places that always have a station (routes kept by hand, the
  // significant places).
  if (stop.status === 'city') return String(stop.id).startsWith('place:') ? 101 : 100;
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
  // { ..., "tunnel": true }: the line reaches this stop through a tunnel, straight from the stop before (planLine).
  if (stop && !Array.isArray(stop) && typeof stop === 'object' && stop.tunnel) {
    const { tunnel, ...place } = stop;
    return { ...resolveStop(Object.keys(place).length === 1 && place.name ? place.name : place, index, label), tunnel: true };
  }
  if (Array.isArray(stop)) {
    assert(stop.length === 2 && stop.every(Number.isFinite), label + ': ' + JSON.stringify(stop) + ' is not [longitude, latitude]');
    return { name: null, coordinates: stop };
  }
  // { "name": ..., "coordinates": [longitude, latitude] }: a named point that need not be a mapped place, such as a
  // cape or an island a tunnel passes, or a place outside this build's data (Wales, Alaska, to Europe, Asia and Africa).
  if (stop && Array.isArray(stop.coordinates)) {
    assert(stop.coordinates.length === 2 && stop.coordinates.every(Number.isFinite), label + ': ' + JSON.stringify(stop) + ' has no [longitude, latitude]');
    return { name: stop.name || null, coordinates: stop.coordinates };
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

// The build, in stages. Each stage takes the state the one before it left and returns what it adds; with
// options.checkpoints, the state after each of the first three (the slow ones: tracing, joining the pieces, the new
// lines out from the network) is kept on disk (checkpoint.cjs) and read back while nothing it depends on has changed.
// See stageKeys for what each stage depends on.
const STAGES = ['trace', 'joins', 'outskirts'];
function buildNetwork(options) {
  const began = Date.now(), timings = [];
  const keys = options.checkpoints ? stageKeys(options) : null;
  let state = {};
  // The last stage whose checkpoint can be read: everything up to it is skipped.
  let resumeAt = -1;
  if (keys && !options.checkpoints.fresh) {
    const from = options.checkpoints.from ? STAGES.indexOf(options.checkpoints.from) : STAGES.length;
    assert(from >= 0, 'Unknown stage ' + options.checkpoints.from + '; the stages are ' + STAGES.join(', '));
    for (let index = Math.min(from, STAGES.length) - 1; index >= 0; index--) {
      const at = Date.now(), name = STAGES[index], dir = options.checkpoints.dir, scope = options.checkpoints.scope;
      // --trust-checkpoint <stage>: use that stage's checkpoint whatever it was keyed by, and key it afresh. Only for a
      // checkpoint known by other means to be right, such as one made on another computer before keys held across them.
      const trusted = options.checkpoints.trust === name;
      const read = checkpoint.read(dir, scope, name, trusted ? null : keys[name]);
      if (!read) {
        // Say why a checkpoint there is not used: which of its parts changed.
        const old = checkpoint.header(dir, scope, name);
        if (old) {
          const changed = old.parts ? Object.keys({ ...old.parts, ...keys.parts[name] }).filter(part => old.parts[part] !== keys.parts[name][part]) : null;
          log('stage ' + name + ': its checkpoint is out of date (' + (changed ? 'changed: ' + changed.join(', ') : 'written before checkpoints recorded their parts') + ')');
        }
        continue;
      }
      state = restoreState(read);
      if (trusted) {
        checkpoint.write(dir, scope, name, keys[name], saveState(state), keys.parts[name]);
        log('stage ' + name + ': checkpoint trusted as asked and keyed afresh');
      }
      resumeAt = index;
      log('stage ' + STAGES[index] + ': read back from its checkpoint in ' + seconds(Date.now() - at) + ' (' + STAGES.slice(0, index + 1).join(', ') + ' skipped)');
      timings.push(STAGES[index] + ' read back ' + seconds(Date.now() - at));
      break;
    }
  }
  // --resume-only: build only from the last checkpoint, never from the start (on a machine that cannot).
  assert(!keys || !options.checkpoints.resumeOnly || resumeAt === STAGES.length - 1,
    'No current checkpoint for the ' + STAGES.at(-1) + ' stage, and --resume-only was given: not building from the start');
  const runStage = (index, stage) => {
    if (index <= resumeAt) return;
    const name = STAGES[index], at = Date.now();
    log('stage ' + name + ': starting');
    state = { ...state, ...stage(state, options) };
    let note = '';
    if (keys) {
      const written = Date.now();
      const bytes = checkpoint.write(options.checkpoints.dir, options.checkpoints.scope, name, keys[name], saveState(state), keys.parts[name]);
      note = ', checkpoint of ' + Math.round(bytes / 1048576) + ' MB written in ' + seconds(Date.now() - written);
    }
    log('stage ' + name + ': done in ' + seconds(Date.now() - at) + note);
    timings.push(name + ' ' + seconds(Date.now() - at));
  };
  runStage(0, stageTrace);
  runStage(1, stageJoins);
  runStage(2, stageOutskirts);
  const at = Date.now();
  log('stage stops: starting');
  const built = stageStops(state, options);
  log('stage stops: done in ' + seconds(Date.now() - at));
  timings.push('stops ' + seconds(Date.now() - at));
  log('stages: ' + timings.join(', ') + '; ' + seconds(Date.now() - began) + ' in all');
  return built;
}

// What each stage's checkpoint depends on: the key of the stage before it, the input files it reads, and the source
// of every function, class and constant of this file its code refers to, followed through the functions it calls
// (dependenciesOf), with the other build modules it uses hashed whole. Nothing needs listing by hand: change a rule,
// a constant or a helper and the first stage that uses it runs again, with everything after it.
//
// Each key is the hash of its parts, which the checkpoint keeps beside it, so a checkpoint that no longer matches can
// say which part changed. Returns { trace, joins, outskirts, parts: { trace: {...}, ... } }.
function stageKeys(options) {
  const inputs = options.checkpoints.inputs;
  const hash = value => checkpoint.hashOf(value);
  const withCode = (fields, stage) => ({ ...fields, ...Object.fromEntries(dependenciesOf(stage)) });
  // How a checkpoint is written is part of every key: a change to it makes the old ones unreadable, so unused.
  const parts = {};
  parts.trace = withCode({ builderVersion: hash(BUILDER_VERSION), format: checkpoint.hashOf(saveState, restoreState, HIDDEN_LINE_FIELDS,
    { file: path.join(__dirname, 'checkpoint.cjs') }), grid: hash(options.grid), geometry: hash(inputs.geometry) }, stageTrace);
  const trace = hash(parts.trace);
  parts.joins = withCode({ previous: trace, cities: hash(inputs.cities), settlements: hash(inputs.settlements),
    authoredJoins: hash(inputs.authoredJoins) }, stageJoins);
  const joins = hash(parts.joins);
  parts.outskirts = withCode({ previous: joins, settlements: hash(inputs.settlements), outposts: hash(inputs.outposts),
    regions: hash(inputs.regions) }, stageOutskirts);
  const outskirts = hash(parts.outskirts);
  return { trace, joins, outskirts, parts };
}

// The top-level declarations of this file, read from its own source: name -> { kind, file }. A function, class or
// constant is looked up by name when it is hashed; a module required from beside this one is hashed by its file.
const MODULE_NAMES = (() => {
  const names = new Map(), source = fs.readFileSync(__filename, 'utf8');
  const moduleFile = name => { const entry = names.get(name); return entry && entry.file; };
  source.split('\n').forEach(line => {
    let match;
    if ((match = line.match(/^const \{([^}]+)\} = require\('(\.\/[^']+)'\)/))) {
      match[1].split(',').forEach(name => names.set(name.trim(), { file: path.join(__dirname, match[2]) }));
    } else if ((match = line.match(/^const (\w+) = require\('(\.\/[^']+)'\)/))) {
      names.set(match[1], { file: path.join(__dirname, match[2]) });
    } else if ((match = line.match(/^const \{([^}]+)\} = (\w+);/)) && moduleFile(match[2])) {
      match[1].split(',').forEach(name => names.set(name.trim(), { file: moduleFile(match[2]) }));
    } else if (/require\('node:/.test(line)) {
      // Node's own modules: not the build's to change.
    } else if ((match = line.match(/^(?:async )?function (\w+)|^class (\w+)|^const (\w+) = /))) {
      names.set(match[1] || match[2] || match[3], { kind: 'declaration' });
    }
  });
  // Logging and checks do not change what a stage builds.
  // Nor does the state a run keeps as it goes (the terrain route memo, the clock), where the project is on this
  // machine (root: a checkpoint made on one computer holds on another), or the code that runs the stages rather than
  // being one: a comment that says "main line" must not make a stage depend on main().
  ['log', 'assert', 'seconds', 'MODULE_NAMES', 'STAGES', 'STARTED', 'routeMemo', 'root', 'main', 'elevationOnly', 'buildNetwork',
    'stageKeys', 'dependenciesOf', 'declared', 'saveState', 'restoreState', 'HIDDEN_LINE_FIELDS', 'writeNetwork'].forEach(name => names.delete(name));
  return names;
})();
// The value of a top-level declaration of this file, by name: only ever called with names MODULE_NAMES found here.
function declared(name) {
  return eval(name); // eslint-disable-line no-eval
}
function dependenciesOf(start) {
  const seen = new Set(), queue = [start.name], parts = [];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = MODULE_NAMES.get(name);
    if (!entry) continue;
    if (entry.file) { parts.push([name, checkpoint.hashOf({ file: entry.file })]); continue; }
    const value = declared(name);
    const text = typeof value === 'function' ? value.toString() : JSON.stringify(value, (key, item) =>
      item instanceof Set ? Array.from(item) : item instanceof Map ? Array.from(item.entries()) : item);
    parts.push([name, checkpoint.hashOf(text)]);
    if (typeof value !== 'function' && (!value || typeof value !== 'object')) continue;
    // Every word in the source that names another declaration: over-generous (a word in a comment counts too), never short.
    ((typeof value === 'function' ? text : JSON.stringify(Object.keys(value))).match(/[A-Za-z_$][\w$]*/g) || []).forEach(word => {
      if (MODULE_NAMES.has(word) && !seen.has(word)) queue.push(word);
    });
  }
  return parts.sort((a, b) => a[0].localeCompare(b[0]));
}

// A stage's state, ready for a checkpoint: the network as its squares and moves, in the order they were made, and
// the laid lines with the properties planLine keeps out of the output (planned, grid, parts) written out too.
const HIDDEN_LINE_FIELDS = ['planned', 'grid', 'parts'];
function saveState(state) {
  const { network, ...rest } = state;
  if (rest.laidLines) rest.laidLines = rest.laidLines.map(line => {
    const hidden = {};
    HIDDEN_LINE_FIELDS.forEach(field => { if (line[field] !== undefined) hidden[field] = line[field]; });
    return { ...line, $hidden: hidden };
  });
  return { ...rest, squares: Array.from(network.squares.values()), edges: Array.from(network.edges.values()) };
}
function restoreState(saved) {
  const { squares, edges, ...rest } = saved;
  const network = new Network();
  squares.forEach(square => network.squares.set(square.key, square));
  edges.forEach(edge => network.edges.set(edge.key, edge));
  if (rest.laidLines) rest.laidLines = rest.laidLines.map(({ $hidden, ...line }) => {
    Object.entries($hidden || {}).forEach(([field, value]) => Object.defineProperty(line, field, { value }));
    return line;
  });
  return { ...rest, network };
}

// An input given as data, or as a function that reads it when first wanted: a stage read back from its checkpoint
// never reads the files it would have needed.
function loadInput(input) {
  return typeof input === 'function' ? input() : input;
}

// 1. Every mapped railway, traced across the grid.
function stageTrace(state, options) {
  const { grid } = options;
  const geometry = loadInput(options.geometry);
  const network = new Network();
  log('tracing ' + geometry.ways.length + ' ways');
  geometry.ways.forEach(way => {
    const visits = traceLine(way.coordinates, grid, {});
    const share = tag => way.lengthKm > 0 && way.tags[tag] && way.tags[tag] !== 'no' ? 1 : 0;
    network.add(visits, { id: way.id, status: way.railwayStatus, bridgeShare: share('bridge'), tunnelShare: share('tunnel') });
  });
  // The traced squares hold everything the rest of the build needs; the geometry is the largest thing in memory.
  geometry.ways = null;
  return { network, geometry: { id: geometry.id, sourceId: geometry.sourceId } };
}

// 2. The authored routes, then the pieces of track joined into one network.
function stageJoins(state, options) {
  const { network } = state;
  const { settlements, cities, grid, cache } = options;
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
  const context = { grid, settlements, cache, network, settlementsFile: options.settlementsFile };
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
    laidLines.push(layLine(network, { from: ends[0], to: ends[1], through: stops.slice(1, -1), toTunnel: stops.at(-1).tunnel,
      kind: 'authored', note: join.note }, context));
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
      // One at a time: a continent's main piece has more squares than a call can take as arguments.
      const keys = groups.get(root).keys;
      piece.keys.forEach(key => keys.push(key));
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
    prefetchRoutes(bridges, context);
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

  return { cityStops, laidLines, authoredEnds };
}

// 3. The network the game starts on, and the new lines out from it: stub joins, facing ends, shortcuts and spurs.
function stageOutskirts(state, options) {
  const { network, cityStops } = state;
  const laidLines = state.laidLines.slice();
  const { settlements, grid, cache } = options;
  const isHard = hardRegionTest(options.regions);
  const context = { grid, settlements, cache, network, settlementsFile: options.settlementsFile };
  const prefetch = joins => prefetchRoutes(joins, context);
  // 4. Keep the network the first city stands on.
  const pieces = network.pieces();
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
  prefetch(stubs);
  stubs.forEach(join => laidLines.push(layLine(network, { ...join, kind: 'stub' }, context)));
  const facing = endJoins(network, grid, join => {
    const line = planLine({ ...join, kind: 'ends' }, context);
    if (!buildable(line)) { log('not joining ' + join.from + ' to ' + join.to + ': ' + (line.planned ? line.waterKm + ' km of water' : 'no way over the terrain')); return null; }
    return line;
  }, prefetch);
  facing.forEach(line => { addLine(network, line); laidLines.push(line); });
  log(facing.length + ' pairs of facing line ends joined (' + Math.round(facing.reduce((sum, line) => sum + line.km, 0)) + ' km)');
  const shortcuts = cityShortcuts(network, grid, settlements, join => {
    const line = planLine({ ...join, kind: 'shortcut' }, context);
    if (!buildable(line)) { log('no shortcut ' + join.note + ': ' + (line.planned ? line.waterKm + ' km of water' : 'no way over the terrain')); return null; }
    return line;
  }, prefetch);
  shortcuts.forEach(line => { addLine(network, line); laidLines.push(line); });
  log(shortcuts.length + ' shortcuts between towns a long way round by track (' + Math.round(shortcuts.reduce((sum, line) => sum + line.km, 0)) + ' km): '
    + shortcuts.map(line => line.note).join(', '));
  const regionOf = regionClassifier(network, settlements, grid);
  // The outposts are half a million records on two continents: read only when the spurs are laid, and let go after.
  let spurPlaces = settlements.concat(loadInput(options.outposts) || []);
  const outpostCount = spurPlaces.length - settlements.length;
  const spurLines = spurs(network, grid, spurPlaces, regionOf, join => {
    const line = planLine({ ...join, kind: 'spur' }, context);
    return buildable(line) ? line : null;
  }, isHard, prefetch);
  spurPlaces = null;
  spurLines.forEach(spur => { addLine(network, spur.line); laidLines.push({ ...spur.line, note: spur.place.name }); });
  log(spurLines.length + ' spurs out to places off rural lines (' + Math.round(spurLines.reduce((sum, spur) => sum + spur.line.km, 0)) + ' km)');
  return {
    laidLines, kept: Array.from(kept), startKey, spurLines: spurLines.map(spur => ({ place: spur.place, square: spur.square })),
    outpostCount, facingCount: facing.length, shortcutCount: shortcuts.length, leftOutPieces: dropped.length, leftOutKm: droppedKm, lostCities
  };
}

// Whether the line runs straight through a square: one line out of it (the end of a line), or two in exactly opposite
// directions. A railyard is drawn straight, so only such a square can hold one.
function isStraightSquare(key, adjacent) {
  const lines = adjacent.get(key);
  if (!lines || lines.length > 2) return false;
  if (lines.length < 2) return true;
  const [x, y] = key.split(',').map(Number), [a, b] = lines.map(other => other.split(',').map(Number));
  return a[0] - x === x - b[0] && a[1] - y === y - b[1];
}

// Takes up every dead end that leads to no stop: from each line end that is not a stop, back to the first stop or
// junction. Repeated, since taking one up can leave another. Returns the number of squares taken up.
function pruneDeadEnds(network, isStop) {
  let removed = 0;
  for (let changed = true; changed;) {
    changed = false;
    const adjacent = network.neighbours();
    Array.from(network.squares.keys()).sort().forEach(end => {
      if (!network.squares.has(end) || isStop(end) || adjacent.get(end).length !== 1) return;
      let previous = null, current = end;
      // Each square walked has the one line back towards the network once the one before it is gone; a junction has more.
      while (current && !isStop(current) && adjacent.get(current).filter(key => network.squares.has(key)).length <= 1) {
        const next = adjacent.get(current).find(key => key !== previous && network.squares.has(key));
        network.squares.delete(current);
        removed++;
        previous = current;
        current = next;
      }
      changed = true;
    });
    Array.from(network.edges.keys()).forEach(key => {
      const edge = network.edges.get(key);
      if (!network.squares.has(edge.a) || !network.squares.has(edge.b)) network.edges.delete(key);
    });
    network.forgetLive();
  }
  return removed;
}

// How much track lies near a point: the kilometres of line (mapped or new) in the squares within radiusKm, from an
// index of the network's squares made once. For the population a station needs where the rails are dense.
function trackDensity(network, grid, radiusKm) {
  const squares = Array.from(network.squares.values()).map(square => ({ km: square.km, centre: projection.centreOf([square.x, square.y], grid) }));
  const near = nearIndex(squares, square => square.centre, 0.25);
  return point => near(point, radiusKm).reduce((sum, [square]) => sum + square.km, 0);
}

// Keeps only the track that joins the stations up: from each station, the shortest ways by track to its
// neighbours nearest by track (up to `neighbours` of them, within limitKm), so each keeps several ways out and the
// network keeps its loops and alternative routes; then, while the stations fall into pieces, the shortest way from the
// piece the game starts in to the nearest station of another. Squares in `keep` (the authored routes, the cities)
// stay, with the moves between them. Everything else is taken up. Returns what was taken up.
function thinTrack(network, stations, keep, startKey, neighbours, limitKm) {
  const adjacent = network.neighbours();
  const edgeKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const keptEdges = new Set(), keptSquares = new Set(keep);
  const markPath = (previous, from, to) => {
    for (let key = to; key !== from; key = previous.get(key)) {
      const back = previous.get(key);
      keptEdges.add(edgeKey(key, back));
      keptSquares.add(key);
      keptSquares.add(back);
    }
  };
  // Shortest ways out from one square, stopping at `count` stations or limitKm; calls found(key, previous) for each.
  const searchFrom = (sources, count, limit, isTarget, found) => {
    const distance = new Map(), previous = new Map(), settled = new Set(), queue = new Heap(), isSource = new Set(sources);
    sources.forEach(key => { distance.set(key, 0); queue.push(0, key); });
    let reached = 0;
    while (queue.size && reached < count) {
      const key = queue.pop();
      if (settled.has(key)) continue;
      settled.add(key);
      const km = distance.get(key);
      if (km > limit) break;
      if (!isSource.has(key) && isTarget(key)) {
        reached++;
        found(key, previous);
        continue;
      }
      adjacent.get(key).forEach(next => {
        const total = km + network.edges.get(edgeKey(key, next)).km;
        if (total < (distance.get(next) ?? Infinity)) { distance.set(next, total); previous.set(next, key); queue.push(total, next); }
      });
    }
  };
  const stationSet = new Set(stations);
  stations.forEach(station => searchFrom([station], neighbours, limitKm, key => stationSet.has(key),
    (key, previous) => markPath(previous, station, key)));
  // The authored routes and cities keep the moves between their own squares.
  network.edges.forEach(edge => { if (keep.has(edge.a) && keep.has(edge.b)) keptEdges.add(edge.key); });
  // Join the pieces: the kept track's pieces holding stations, joined to the start's one at a time by the shortest
  // way over the whole network.
  const pieceOf = () => {
    const piece = new Map(), keptAdjacent = new Map();
    keptEdges.forEach(key => {
      const [a, b] = key.split('|');
      (keptAdjacent.get(a) || keptAdjacent.set(a, []).get(a)).push(b);
      (keptAdjacent.get(b) || keptAdjacent.set(b, []).get(b)).push(a);
    });
    let count = 0;
    keptSquares.forEach(start => {
      if (piece.has(start)) return;
      const stack = [start];
      piece.set(start, count);
      while (stack.length) (keptAdjacent.get(stack.pop()) || []).forEach(next => { if (!piece.has(next)) { piece.set(next, count); stack.push(next); } });
      count++;
    });
    return piece;
  };
  for (let joins = 0; joins < 100000; joins++) {
    const piece = pieceOf(), home = piece.get(startKey);
    const stranded = stations.filter(key => piece.get(key) !== home);
    if (!stranded.length) break;
    const homeSquares = Array.from(keptSquares).filter(key => piece.get(key) === home);
    let joined = false;
    searchFrom(homeSquares, 1, Infinity, key => piece.has(key) && piece.get(key) !== home && stationSet.has(key), (key, previous) => {
      // Back from the station reached to the home piece.
      for (let at = key; previous.has(at); at = previous.get(at)) {
        const back = previous.get(at);
        keptEdges.add(edgeKey(at, back));
        keptSquares.add(at);
        keptSquares.add(back);
      }
      joined = true;
    });
    if (!joined) break;
  }
  // Alternatives: a way over track not kept, between two kept squares, goes back in where the way round by the kept
  // track is far longer (ALTERNATIVE_FACTOR times, and ALTERNATIVE_EXTRA_KM more). A line beside another is not one;
  // a loop through other country, or a cut-off, is. The ways are found from each kept square with untaken track
  // leaving it, over that track only (up to ALTERNATIVE_SEARCH_KM), to the kept squares it reaches; shortest first,
  // each checked against the track kept so far.
  const alternatives = [];
  keptSquares.forEach(start => {
    if (!adjacent.get(start).some(next => !keptEdges.has(edgeKey(start, next)))) return;
    const distance = new Map([[start, 0]]), previous = new Map(), settled = new Set(), queue = new Heap();
    queue.push(0, start);
    while (queue.size) {
      const key = queue.pop();
      if (settled.has(key)) continue;
      settled.add(key);
      const km = distance.get(key);
      if (key !== start && keptSquares.has(key)) {
        if (start < key) {
          const path = [key], edges = [];
          for (let at = key; at !== start; at = previous.get(at)) { edges.push(edgeKey(at, previous.get(at))); path.push(previous.get(at)); }
          alternatives.push({ path: path.reverse(), edges, km });
        }
        continue;
      }
      adjacent.get(key).forEach(next => {
        const edge = edgeKey(key, next);
        if (keptEdges.has(edge)) return;
        const total = km + network.edges.get(edge).km;
        if (total <= ALTERNATIVE_SEARCH_KM && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); previous.set(next, key); queue.push(total, next); }
      });
    }
  });
  const keptAdjacent = new Map();
  const link = (a, b) => {
    (keptAdjacent.get(a) || keptAdjacent.set(a, []).get(a)).push(b);
    (keptAdjacent.get(b) || keptAdjacent.set(b, []).get(b)).push(a);
  };
  keptEdges.forEach(key => { const [a, b] = key.split('|'); link(a, b); });
  const keptDistance = (from, to, limit) => {
    const distance = new Map([[from, 0]]), settled = new Set(), queue = new Heap();
    queue.push(0, from);
    while (queue.size) {
      const key = queue.pop();
      if (settled.has(key)) continue;
      settled.add(key);
      if (key === to) return distance.get(key);
      (keptAdjacent.get(key) || []).forEach(next => {
        const total = distance.get(key) + network.edges.get(edgeKey(key, next)).km;
        if (total <= limit && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); queue.push(total, next); }
      });
    }
    return Infinity;
  };
  let restored = 0, restoredKm = 0;
  alternatives.sort((a, b) => a.km - b.km || a.edges[0].localeCompare(b.edges[0])).forEach(alternative => {
    const from = alternative.path[0], to = alternative.path[alternative.path.length - 1];
    const limit = alternative.km * ALTERNATIVE_FACTOR + ALTERNATIVE_EXTRA_KM;
    if (keptDistance(from, to, limit) <= limit) return;
    alternative.edges.forEach(key => { keptEdges.add(key); const [a, b] = key.split('|'); link(a, b); });
    alternative.path.forEach(key => keptSquares.add(key));
    restored++;
    restoredKm += alternative.km;
  });
  // Long real railways: a plain run of mapped track (MAPPED_RUN_SHARE) from one kept square to another, with no junction
  // on it, longer than the alternatives search reaches, goes back in on the same test (the Qinghai-Tibet railway).
  let runs = 0, runsKm = 0;
  Array.from(keptSquares).sort().forEach(start => adjacent.get(start).forEach(first => {
    if (keptEdges.has(edgeKey(start, first))) return;
    let previous = start, current = first, runKm = 0, mappedKm = 0;
    const edges = [], path = [start];
    for (;;) {
      const key = edgeKey(previous, current), edge = network.edges.get(key);
      runKm += edge.km;
      if (!edge.gap) mappedKm += edge.km;
      edges.push(key);
      path.push(current);
      if (keptSquares.has(current) || adjacent.get(current).length !== 2) break;
      const next = adjacent.get(current).find(other => other !== previous);
      previous = current;
      current = next;
    }
    if (!keptSquares.has(current) || !(start < current) || runKm <= ALTERNATIVE_SEARCH_KM || mappedKm < runKm * MAPPED_RUN_SHARE) return;
    const limit = runKm * ALTERNATIVE_FACTOR + ALTERNATIVE_EXTRA_KM;
    if (keptDistance(start, current, limit) <= limit) return;
    edges.forEach(key => { keptEdges.add(key); const [a, b] = key.split('|'); link(a, b); });
    path.forEach(key => keptSquares.add(key));
    runs++;
    runsKm += runKm;
  }));
  let squares = 0, moves = 0, km = 0;
  Array.from(network.edges.keys()).forEach(key => { if (!keptEdges.has(key)) { km += network.edges.get(key).km; network.edges.delete(key); moves++; } });
  // A kept square left with no track (an authored place off the lines kept) goes too.
  const touched = new Set();
  network.edges.forEach(edge => { touched.add(edge.a); touched.add(edge.b); });
  Array.from(network.squares.keys()).forEach(key => { if (!keptSquares.has(key) || !touched.has(key)) { network.squares.delete(key); squares++; } });
  network.forgetLive();
  return { squares, moves, km: Math.round(km), alternatives: restored, alternativeKm: Math.round(restoredKm), runs, runsKm: Math.round(runsKm) };
}

// The shortest way by track between two squares, no longer than limitKm: { keys, edges, km }, or null.
function trackPath(network, from, to, limitKm = Infinity) {
  if (!network.squares.has(from) || !network.squares.has(to)) return null;
  const adjacent = network.neighbours(), distance = new Map([[from, 0]]), previous = new Map(), settled = new Set(), queue = new Heap();
  queue.push(0, from);
  while (queue.size) {
    const key = queue.pop();
    if (settled.has(key)) continue;
    settled.add(key);
    if (key === to) {
      const keys = [to], edges = [];
      for (let at = to; at !== from; at = previous.get(at)) { const back = previous.get(at); edges.push(back < at ? back + '|' + at : at + '|' + back); keys.push(back); }
      return { keys: keys.reverse(), edges, km: distance.get(to) };
    }
    (adjacent.get(key) || []).forEach(next => {
      const total = distance.get(key) + network.edges.get(key < next ? key + '|' + next : next + '|' + key).km;
      if (total <= limitKm && total < (distance.get(next) ?? Infinity)) { distance.set(next, total); previous.set(next, key); queue.push(total, next); }
    });
  }
  return null;
}

// The network square nearest a point within reachKm, or null.
function nearestSquare(network, point, grid, reachKm) {
  const [cx, cy] = projection.cellOf(point, grid), reach = Math.ceil(reachKm / grid.cellKm) + 1;
  let best = null;
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
    const key = keyOf(cx + dx, cy + dy);
    if (!network.squares.has(key)) continue;
    const km = haversineKm(point, projection.centreOf([cx + dx, cy + dy], grid));
    if (km <= reachKm && (!best || km < best.km || (km === best.km && key < best.key))) best = { key, km };
  }
  return best && best.key;
}

// The hand-made edits (world/authored/network-edits.json), made on the network before its stations are chosen. Returns
// the squares the kept routes run through (kept through the thinning), a station for every stop of a kept route, and
// the lines laid.
function applyEdits(network, options, places) {
  const { grid } = options, edits = options.edits || {};
  const context = { grid, settlements: options.settlements, cache: options.cache, network, settlementsFile: options.settlementsFile };
  const keep = new Set(), stops = [], laid = [];
  (edits.remove || []).forEach(edit => {
    const route = resolveRoute(edit, places), label = edit.note || route.map(stop => stop.name).join(' - ');
    let moves = 0, km = 0;
    for (let index = 1; index < route.length; index++) {
      const [a, b] = [route[index - 1], route[index]];
      const [from, to] = [a, b].map(stop => nearestSquare(network, stop.coordinates, grid, AUTHORED_SNAP_KM));
      assert(from && to, 'Removed route "' + label + '": ' + (from ? b : a).name + ' is not within ' + AUTHORED_SNAP_KM + ' km of the network');
      const path = trackPath(network, from, to);
      assert(path, 'Removed route "' + label + '": no track joins ' + a.name + ' and ' + b.name);
      const clear = key => { const centre = projection.centreOf(key.split(',').map(Number), grid);
        return haversineKm(centre, a.coordinates) > REMOVE_CLEAR_KM && haversineKm(centre, b.coordinates) > REMOVE_CLEAR_KM; };
      path.edges.forEach(key => {
        const edge = network.edges.get(key);
        if (!clear(edge.a) && !clear(edge.b)) return;
        km += edge.km; moves++;
        network.edges.delete(key);
      });
      network.forgetLive();
    }
    log('took up the track of "' + label + '": ' + moves + ' moves (' + Math.round(km) + ' km)');
  });
  (edits.keep || []).forEach(edit => {
    const route = resolveRoute(edit, places), label = edit.note || route.map(stop => stop.name).join(' - ');
    // Each stop at the track nearest it, or, with none near, at a new terminus on its own square.
    const squares = route.map(stop => {
      const found = nearestSquare(network, stop.coordinates, grid, AUTHORED_SNAP_KM);
      if (found) return found;
      const cell = projection.cellOf(stop.coordinates, grid);
      return keyOf(cell[0], cell[1]);
    });
    for (let index = 1; index < route.length; index++) {
      let [from, to] = [squares[index - 1], squares[index]];
      const straightKm = haversineKm(route[index - 1].coordinates, route[index].coordinates);
      let path = route[index].tunnel ? null : trackPath(network, from, to, straightKm * KEEP_DETOUR_FACTOR + KEEP_DETOUR_EXTRA_KM);
      if (!path) {
        // A new line needs a square of the network to start from.
        if (!network.squares.has(from)) [from, to] = [to, from];
        assert(network.squares.has(from), 'Kept route "' + label + '": neither ' + route[index - 1].name + ' nor ' + route[index].name + ' is near the network');
        const line = layLine(network, { from, to, toTunnel: route[index].tunnel, kind: 'edit', note: label }, context);
        laid.push(line);
        network.forgetLive();
        path = trackPath(network, squares[index - 1], squares[index]);
        assert(path, 'Kept route "' + label + '": the new line between ' + route[index - 1].name + ' and ' + route[index].name + ' does not join them');
        log('laid a new line for "' + label + '": ' + route[index - 1].name + ' to ' + route[index].name + ', ' + Math.round(line.km) + ' km'
          + (line.waterKm ? ', ' + line.waterKm + ' km over water' : '') + (line.tunnelKm ? ', ' + Math.round(line.tunnelKm) + ' km in tunnel' : ''));
      }
      path.keys.forEach(key => keep.add(key));
    }
    route.forEach((stop, index) => stops.push({ id: 'edit:' + squares[index], name: stop.name, status: 'city', square: squares[index],
      coordinates: stop.coordinates }));
    log('kept route "' + label + '"');
  });
  return { keep, stops, laid };
}

// A station for every significant place track passes near (world/external/significant-places.json), at the square of
// the network nearest it, named for it.
function significantStops(network, options) {
  const stops = [];
  (options.significant || []).forEach(place => {
    const square = nearestSquare(network, place.coordinates, options.grid, SIGNIFICANT_REACH_KM);
    if (square) stops.push({ id: 'significant:' + place.id, name: place.name, status: 'city', square, coordinates: place.coordinates,
      population: place.population, significant: place.reasons });
  });
  return stops;
}

// Stations at the ends of long branches of real track (TERMINUS_BRANCH_KM): for each line end, the way back to the first
// junction, and the town or city nearest the end within HALT_NAME_KM, made a station that keeps its yard.
function terminusStops(network, grid, nearestTown) {
  const adjacent = network.neighbours(), stops = [];
  Array.from(network.squares.keys()).sort().forEach(end => {
    if (adjacent.get(end).length !== 1) return;
    let previous = null, current = end, km = 0, mappedKm = 0;
    while (adjacent.get(current).length <= 2) {
      const next = adjacent.get(current).find(key => key !== previous);
      if (!next) break;
      const edge = network.edges.get(current < next ? current + '|' + next : next + '|' + current);
      km += edge.km;
      if (!edge.gap) mappedKm += edge.km;
      previous = current;
      current = next;
      if (current === end) break;
    }
    if (km < TERMINUS_BRANCH_KM || mappedKm < km * TERMINUS_MAPPED_SHARE) return;
    const square = network.squares.get(end), town = nearestTown(projection.centreOf([square.x, square.y], grid));
    if (town) stops.push({ id: 'terminus:' + end, name: town.name, ...(town.localName ? { localName: town.localName } : {}),
      status: 'settlement', kind: town.kind, square: end, coordinates: town.coordinates, population: town.population, terminus: true });
  });
  return stops;
}

// The town or city a point stands in: of those whose reach (TOWN_NAME_BASE_KM, and more for a bigger place) takes in the
// point, the one it lies deepest inside. null when it is in none.
function townFinder(settlements) {
  const towns = settlements.filter(place => place.kind === 'city' || place.kind === 'town');
  const near = nearIndex(towns, place => place.coordinates, 0.25);
  const reachOf = place => Math.min(TOWN_NAME_MAX_KM, TOWN_NAME_BASE_KM
    + Math.sqrt(place.population || DEFAULT_POPULATION[place.kind] || 0) / TOWN_NAME_PEOPLE_PER_KM);
  return point => {
    let best = null;
    near(point, TOWN_NAME_MAX_KM).forEach(([place, km, order]) => {
      const depth = km / reachOf(place);
      if (depth <= 1 && (!best || depth < best.depth || (depth === best.depth && order < best.order))) best = { place, depth, order };
    });
    return best && best.place;
  };
}

// 4. Cities simplified, parallel lines taken up, and the stops, yards, halts and points placed: the network as the
// game gets it. Quick next to the stages before it, so it always runs.
function stageStops(state, options) {
  const { network, cityStops, spurLines, authoredEnds, startKey } = state;
  const kept = new Set(state.kept);
  const { stations, settlements, grid } = options;
  const isHard = hardRegionTest(options.regions);
  // The hand-made edits first, then the significant places on the network they leave: both are stations the rest of
  // the stage keeps, with the track to them.
  const edited = applyEdits(network, options, placeIndex(options.cities, settlements));
  const laidLines = state.laidLines.concat(edited.laid);
  // A significant place an authored city or a kept route's stop already stands for is not a second station there.
  const covered = cityStops.concat(edited.stops);
  const significant = significantStops(network, options)
    .filter(stop => !covered.some(other => haversineKm(other.coordinates, stop.coordinates) <= SAME_PLACE_KM));
  log(significant.length + ' significant places near the track: ' + significant.map(stop => stop.name).join(', '));
  // The regions from the mapped track, which the new lines of the stage before did not change.
  const regionOf = regionClassifier(network, settlements, grid);
  const simplified = simplifyUrban(network, grid, regionOf, new Set(cityStops.map(stop => stop.square)
    .concat(edited.stops.map(stop => stop.square), significant.map(stop => stop.square))));
  log('cities reduced to a hub and the lines into it: ' + simplified.areas + ' urban areas, ' + simplified.squares +
    ' squares and ' + simplified.moves + ' moves of track taken up');
  // Lines side by side: the authored routes and the cities stay.
  const mustStay = new Set(cityStops.map(stop => stop.square).concat(Array.from(edited.keep), significant.map(stop => stop.square)));
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
    candidates.push({ id: station.id, name: station.name, localName: station.localName, status: station.status, kind: station.kind,
      category: station.category, square: found.square.key, coordinates: station.coordinates });
  });
  // The stops of the kept routes, and the significant places, where an authored city does not already stand for them.
  edited.stops.filter(stop => !cityStops.some(city => haversineKm(city.coordinates, stop.coordinates) <= SAME_PLACE_KM))
    .concat(significant).forEach(stop => { if (network.squares.has(stop.square)) candidates.push(stop); });
  // The new termini of authored routes, and the place at the end of each spur.
  authoredEnds.forEach(stop => candidates.push(stop));
  spurLines.forEach(spur => candidates.push({ id: spur.place.id, name: spur.place.name, localName: spur.place.localName, status: 'settlement', kind: spur.place.kind,
    square: spur.square, coordinates: spur.place.coordinates, population: spur.place.population }));
  // Settlements on new lines, where no station was ever mapped.
  const newSquares = new Set();
  network.squares.forEach(square => { if ((square.gapKm || 0) > square.railKm) newSquares.add(square.key); });
  settlements.forEach(settlement => {
    const cell = projection.cellOf(settlement.coordinates, grid), key = keyOf(cell[0], cell[1]);
    if (!newSquares.has(key)) return;
    if (isHard(settlement.coordinates) && settlement.kind === 'village') return;
    candidates.push({ id: settlement.id, name: settlement.name, localName: settlement.localName, status: 'settlement', kind: settlement.kind, square: key,
      population: settlement.population,
      coordinates: settlement.coordinates });
  });
  // In a hard region the stops are the stations mapped and the towns (Likea: real towns stay, nothing is invented), so
  // every town and city within HARD_TOWN_KM of the line is one, at the square nearest it, whatever track passes it: a
  // line laid through a town can run in the square beside it, or meet mapped track there. Across Chukotka that is the
  // difference between a stop at Lavrentiya, Anadyr and Bilibino and 3,800 km with none.
  const hardTownReach = Math.ceil(HARD_TOWN_KM / grid.cellKm) + 1;
  settlements.forEach(settlement => {
    if ((settlement.kind !== 'town' && settlement.kind !== 'city') || !isHard(settlement.coordinates)) return;
    const [cx, cy] = projection.cellOf(settlement.coordinates, grid);
    let best = null;
    for (let dx = -hardTownReach; dx <= hardTownReach; dx++) for (let dy = -hardTownReach; dy <= hardTownReach; dy++) {
      const key = keyOf(cx + dx, cy + dy);
      if (!network.squares.has(key)) continue;
      const km = haversineKm(settlement.coordinates, projection.centreOf([cx + dx, cy + dy], grid));
      if (km <= HARD_TOWN_KM && (!best || km < best.km || (km === best.km && key < best.key))) best = { key, km };
    }
    if (best) candidates.push({ id: settlement.id, name: settlement.name, localName: settlement.localName, status: 'settlement', kind: settlement.kind, square: best.key,
      population: settlement.population, coordinates: settlement.coordinates });
  });
  // The ends of long branches of real track, at the town there.
  const townOf = townFinder(settlements);
  const townsNear = nearIndex(settlements.filter(place => place.kind === 'city' || place.kind === 'town'), place => place.coordinates, 0.25);
  const termini = terminusStops(network, grid, point => {
    let best = null;
    townsNear(point, HALT_NAME_KM).forEach(([place, km, order]) => { if (!best || km < best.km || (km === best.km && order < best.order)) best = { place, km, order }; });
    return best && best.place;
  });
  termini.forEach(stop => candidates.push(stop));
  log(termini.length + ' long branches of real track keep a station at the town at their end');
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

  // Dead ends lead somewhere: a line that ends with no station at its end is taken up back to the last station on it,
  // or to the junction it leaves, and again after the yards are chosen (a station left without one no longer holds the
  // line out to it).
  let pruned = pruneDeadEnds(network, key => stopBySquare.has(key));
  stopBySquare = pickStops();
  log('took up ' + pruned + ' squares of line leading to no station');

  // Where the stops go. A railyard has two ends and one line at each, so no stop stands where three or more lines
  // meet: the junction is out on the line, where a driver picks a way, and a station there moves to the square next
  // to it on the line nearest the station. Every end of the line is a stop too, unless a busier one is beside it.
  const adjacentStops = network.neighbours();
  const degreeOf = key => adjacentStops.get(key).length;
  // The nearest settlement within a degree of latitude, the first listed of two as near. Found in a small index, out to
  // a hundred kilometres, and only past that by reading every settlement: a scan of two continents' villages for every
  // junction and line end took hours.
  const settlementsNear = nearIndex(settlements, place => place.coordinates);
  const nearestWithin = (point, radiusKm, bandDegrees) => {
    let best = null;
    settlementsNear(point, radiusKm).forEach(([settlement, km, order]) => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > bandDegrees) return;
      if (!best || km < best.km || (km === best.km && order < best.order)) best = { settlement, km, order };
    });
    return best;
  };
  const nearestSettlementName = point => {
    for (const radiusKm of [25, 100]) {
      const near = nearestWithin(point, radiusKm, 1);
      if (near) return near.settlement.name;
    }
    let best = null;
    settlements.forEach(settlement => {
      if (Math.abs(settlement.coordinates[1] - point[1]) > 1) return;
      const km = haversineKm(point, settlement.coordinates);
      if (!best || km < best.km) best = { name: settlement.name, km };
    });
    return best ? best.name : null;
  };
  const centreOfKey = key => { const square = network.squares.get(key); return projection.centreOf([square.x, square.y], grid); };
  // A station on a bend or a junction moves along the line to the nearest square where it runs straight through
  // (STATION_SHIFT_SQUARES), nearest the station itself.
  const straight = key => isStraightSquare(key, adjacentStops);
  let movedOffJunctions = 0, noRoomBesideJunction = 0;
  const placed = [];
  Array.from(stopBySquare.values()).forEach(candidate => {
    if (straight(candidate.square)) { placed.push(candidate); return; }
    const seen = new Set([candidate.square]);
    let ring = [candidate.square];
    const found = [];
    const reach = isHard(candidate.coordinates) ? HARD_STATION_SHIFT_SQUARES : STATION_SHIFT_SQUARES;
    for (let step = 0; step < reach && !found.length; step++) {
      ring = ring.flatMap(key => adjacentStops.get(key)).filter(key => !seen.has(key) && seen.add(key));
      ring.forEach(key => { if (straight(key)) found.push({ key, km: haversineKm(candidate.coordinates, centreOfKey(key)) }); });
    }
    const beside = found.sort((a, b) => a.km - b.km || a.key.localeCompare(b.key))[0];
    if (!beside) { noRoomBesideJunction++; return; }
    placed.push({ ...candidate, square: beside.key });
    movedOffJunctions++;
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
    // In a hard region every real town keeps its yard (Likea: real towns stay there).
    if (isHard(stop.coordinates)) return 0;
    const rule = YARD_RULES[stop.region];
    if (rule.spacingKm !== null) return rule.spacingKm;
    const people = regionOf.peopleWithin(stop.coordinates, DENSITY_RADIUS_KM);
    return people < SPARSE_POPULATION ? SPARSE_SPACING_KM : people < DENSE_POPULATION ? RURAL_SPACING_KM : DENSE_SPACING_KM;
  };
  const yards = new Map(), maybe = [];
  const touchingYard = key => {
    const [x, y] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if ((dx || dy) && yards.has(keyOf(x + dx, y + dy))) return true;
    }
    return false;
  };
  // The stations that always keep their yard, in order (the authored cities, the routes kept by hand, the significant
  // places, the ends of routes and long branches), each unless one before it stands in a square touching it.
  const forcedOrder = stop => String(stop.id).startsWith('place:') ? 0 : String(stop.id).startsWith('edit:') ? 1
    : String(stop.id).startsWith('significant:') ? 2 : 3;
  const forced = [];
  onePerSquare.forEach(stop => {
    stop.region = regionOf(stop.coordinates);
    if (stop.status === 'city' || stop.terminus || String(stop.id).startsWith('authored-end:')) forced.push(stop);
    else maybe.push({ stop, population: populationOf(stop) });
  });
  forced.sort((a, b) => forcedOrder(a) - forcedOrder(b) || a.square.localeCompare(b.square))
    .forEach(stop => { if (!touchingYard(stop.square)) yards.set(stop.square, stop); });
  maybe.sort((a, b) => b.population - a.population || rank(b.stop) - rank(a.stop) || a.stop.id.localeCompare(b.stop.id));
  const thinned = { urban: 0, industrial: 0, rural: 0 };
  const densityAt = trackDensity(network, grid, STATION_DENSITY_RADIUS_KM);
  const busyEnough = (stop, population) => isHard(stop.coordinates)
    || population >= STATION_PEOPLE_PER_TRACK_KM * densityAt(stop.coordinates);
  maybe.forEach(({ stop, population }) => {
    let keep = population >= YARD_RULES[stop.region].minPopulation && busyEnough(stop, population) && !touchingYard(stop.square);
    const spacing = keep ? spacingFor(stop) : 0;
    if (keep && spacing > 0) {
      for (const key of distancesAlong(network, adjacentStops, stop.square, spacing).keys()) {
        if (key !== stop.square && yards.has(key)) { keep = false; break; }
      }
    }
    if (keep) { stop.population = population; yards.set(stop.square, stop); }
    else thinned[stop.region]++;
  });
  stopBySquare = yards;
  const trackTakenUp = thinTrack(network, Array.from(yards.keys()).sort(), new Set(Array.from(mustStay).filter(key => network.squares.has(key))),
    startKey, TRACK_NEIGHBOURS, TRACK_NEIGHBOUR_KM);
  log('kept the track joining the stations up: ' + trackTakenUp.squares + ' squares and ' + trackTakenUp.moves + ' moves ('
    + trackTakenUp.km + ' km) taken up, ' + trackTakenUp.alternatives + ' alternative routes (' + trackTakenUp.alternativeKm + ' km) kept, and '
    + trackTakenUp.runs + ' long runs of real railway (' + trackTakenUp.runsKm + ' km)');
  pruned += pruneDeadEnds(network, key => stopBySquare.has(key));
  // Track the edits cut off from the rest (the Sinai line past Nekhel, the Kolyma lines beyond Zyryanka) goes, and a
  // station whose square is gone, or on such a piece, is not a station.
  const home = network.pieces().find(piece => piece.keys.includes(startKey));
  const homeKeys = new Set(home ? home.keys : []);
  const cutOff = Array.from(network.squares.keys()).filter(key => !homeKeys.has(key));
  cutOff.forEach(key => network.squares.delete(key));
  Array.from(network.edges.keys()).forEach(key => { const edge = network.edges.get(key); if (!homeKeys.has(edge.a)) network.edges.delete(key); });
  network.forgetLive();
  if (cutOff.length) log('took up ' + cutOff.length + ' squares of track cut off from the rest');
  const stranded = Array.from(stopBySquare.keys()).filter(key => !network.squares.has(key));
  if (stranded.length) log(stranded.length + ' stations left with no track: ' + stranded.map(key => stopBySquare.get(key).name).join(', '));
  stranded.forEach(key => stopBySquare.delete(key));
  log(movedOffJunctions + ' stations moved to straight track beside them, ' + noRoomBesideJunction + ' with none near; '
    + (thinned.urban + thinned.industrial + thinned.rural) + ' stops left without a yard: ' + JSON.stringify(thinned));

  // 6. Halts, so that outside a hard region no square is more than MAX_SECTION_KM / 2 from a stop by track, junctions
  // or not: a long line through a string of junctions has nowhere to stop just as surely as one without them. Each
  // halt goes at the square then farthest from any stop that has a real place within HALT_NAME_KM, never at a junction
  // or beside a yard, and is named for that place. Where no place lies near the line there is no halt: a stop is
  // somewhere that exists (Likea, September 2026: no more "Km 123 from" stops), so a long empty stretch stays empty.
  const adjacent = network.neighbours();
  const edgeKm = (a, b) => network.edges.get(a < b ? a + '|' + b : b + '|' + a).km;
  // Where no town or village is near, a hamlet, farm or estancia will do (options.haltPlaces: the outposts beside the
  // track, their too-common names such as a bare "Estancia" left out): the steppe and the outback have few villages
  // but plenty of named places, and a halt at one is a stop somewhere that exists.
  let outpostsNear = () => [];
  if (options.haltPlaces) {
    const cells = new Set();
    network.squares.forEach(square => {
      const centre = projection.centreOf([square.x, square.y], grid);
      cells.add(Math.floor(centre[0] * 4) + ',' + Math.floor(centre[1] * 4));
    });
    const besideTrack = place => {
      const x = Math.floor(place.coordinates[0] * 4), y = Math.floor(place.coordinates[1] * 4);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (cells.has((x + dx) + ',' + (y + dy))) return true;
      return false;
    };
    const outposts = options.haltPlaces(place => !!place.name && besideTrack(place));
    const nameCount = new Map();
    outposts.forEach(place => nameCount.set(place.name, (nameCount.get(place.name) || 0) + 1));
    const named = outposts.filter(place => nameCount.get(place.name) <= GENERIC_NAME_COUNT && !/^(estancia|farm|puesto|hamlet)$/i.test(place.name.trim()));
    outpostsNear = nearIndex(named, place => place.coordinates);
    log(named.length + ' named hamlets, farms and estancias beside the track for halts');
  }
  const nearestSettlement = point => {
    const near = nearestWithin(point, HALT_NAME_KM, 0.2);
    if (near) return near.settlement;
    let best = null;
    outpostsNear(point, HALT_NAME_KM).forEach(([place, km, order]) => {
      if (!best || km < best.km || (km === best.km && order < best.order)) best = { place, km, order };
    });
    return best && best.place;
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
  const wanted = Array.from(network.squares.keys()).filter(key => isStraightSquare(key, adjacent) && adjacent.get(key).length === 2 && !stopBySquare.has(key)
    && (reach.get(key) ?? Infinity) > halfSection && !isHard(centreOfKey(key)))
    .sort((a, b) => (reach.get(b) ?? Infinity) - (reach.get(a) ?? Infinity) || a.localeCompare(b));
  let halts = 0;
  wanted.forEach(key => {
    if ((reach.get(key) ?? Infinity) <= halfSection || touchingYard(key)) return;
    const centre = centreOfKey(key), near = nearestSettlement(centre);
    if (!near) return;
    stopBySquare.set(key, { id: 'halt:' + key, status: 'halt', square: key, coordinates: centre, region: regionOf(centre),
      name: near.name, localName: near.localName });
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
      bridge: square.bridgeKm >= BRIDGE_MIN_KM, tunnel: (square.railKm > 0 && square.tunnelKm >= square.railKm * TUNNEL_MIN_SHARE)
        || (gapKm > square.railKm && (square.tunnelGapKm || 0) >= gapKm * TUNNEL_MIN_SHARE),
      elevationM: square.elevationM, elevationStdDevM: square.elevationStdDevM,
      statuses: Array.from(square.statuses).sort(), sourceWayCount: square.wayIds.size, ends
    };
  });
  // 8. Names. A station is named for the town or city it stands in, not for itself (Likea, 2026-09-30: San Francisco,
  // not 22nd Street or Union Station), unless another station nearer the middle of the same town already has its name;
  // a station in no town keeps its own. Every stop carries the local name of its place where that differs from the
  // English one, found by name among the towns near it for the stops named some other way.
  const nameStats = { town: 0, own: 0, shared: 0 };
  const byTownName = new Map();
  // A town that already has a stop of its own name (a city, a settlement, a halt) keeps it to itself.
  const namedStops = Array.from(stopBySquare.values()).filter(stop => ['city', 'settlement', 'halt'].includes(stop.status));
  const alreadyNamed = (name, point) => namedStops.some(stop => stop.name === name && haversineKm(stop.coordinates, point) <= 2 * TOWN_NAME_MAX_KM);
  stopBySquare.forEach(stop => {
    if (['city', 'settlement', 'halt'].includes(stop.status)) return;
    const town = townOf(stop.coordinates);
    if (!town || alreadyNamed(town.name, stop.coordinates)) { nameStats.own++; return; }
    const km = haversineKm(stop.coordinates, town.coordinates);
    const claimed = byTownName.get(town.id || town.name);
    if (claimed && claimed.km <= km) { nameStats.shared++; return; }
    if (claimed) { claimed.stop.name = claimed.ownName; claimed.stop.localName = claimed.ownLocal; nameStats.shared++; nameStats.town--; }
    byTownName.set(town.id || town.name, { stop, km, ownName: stop.name, ownLocal: stop.localName });
    stop.name = town.name;
    stop.localName = town.localName;
    nameStats.town++;
  });
  stopBySquare.forEach(stop => {
    if (stop.localName) return;
    const same = townsNear(stop.coordinates, TOWN_NAME_MAX_KM).find(([place]) => place.name === stop.name && place.localName);
    if (same) stop.localName = same[0].localName;
  });
  log('stations named for the town they are in: ' + nameStats.town + '; ' + nameStats.shared + ' sharing a town with a station nearer its middle and '
    + nameStats.own + ' in no town keep their own names');
  const stops = Array.from(stopBySquare.values()).sort((a, b) => a.square.localeCompare(b.square)).map(stop => ({
    id: stop.id, name: stop.name, ...(stop.localName && stop.localName !== stop.name ? { localName: stop.localName } : {}),
    status: stop.status, ...(stop.kind ? { kind: stop.kind } : {}),
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
      editLineCount: edited.laid.length, significantStops: significant.length, terminusStops: termini.length, stationNames: nameStats,
      endJoinCount: state.facingCount, spurCount: spurLines.length, shortcutCount: state.shortcutCount,
      parallelStretchesRemoved: parallel.stretches, parallelKmRemoved: parallel.km,
      onExistingTrackKm: Math.round(laidLines.reduce((sum, line) => sum + (line.onExistingTrackKm || 0), 0)),
      stationsMovedOffJunctions: movedOffJunctions, junctionPoints: points.filter(point => point.kind === 'junction').length,
      bufferPoints: points.filter(point => point.kind === 'buffer').length,
      urbanAreas: simplified.areas, urbanSquaresRemoved: simplified.squares, urbanMovesRemoved: simplified.moves,
      stopRegions: regionCounts, stationsWithoutYard: thinned,
      railKm: Math.round(squares.reduce((sum, square) => sum + square.railKm, 0)),
      leftOutPieces: state.leftOutPieces, leftOutKm: Math.round(state.leftOutKm), unreachableCities: state.lostCities, prunedStubSquares: pruned,
      junctionSquares: squares.filter(square => square.ends.length >= 3).length,
      endSquares: squares.filter(square => square.ends.length === 1).length
    },
    elevationTiles: tiles,
    geometry: state.geometry, outpostCount: state.outpostCount
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

async function main() {
  const scope = SCOPE;
  [scope.geometry, scope.stations, scope.settlements].forEach(file =>
    assert(fs.existsSync(path.join(root, file)), 'Missing ' + file + '; see world/README.md'));
  // Read a record to a line: a continent's railways or hamlets are more than one string can hold (records.cjs).
  const read = file => { log('reading ' + file); return readRecords(path.join(root, file)); };
  const args = process.argv.slice(2), option = name => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : null; };
  const grid = scope.grid, cache = defaultCache();
  // Every longitude in the grid's own frame, so nothing is interpolated the long way round across the 180th meridian
  // (projection.inFrame). Changes nothing for the Americas, whose data lies inside their frame already.
  const frame = point => { point[0] = projection.inFrame(point[0], grid); return point; };
  // The geometry is the largest input by far, and only tracing reads it: read when that stage runs, not before.
  const readGeometry = () => {
    const geometry = read(scope.geometry);
    geometry.ways.forEach(way => way.coordinates.forEach(frame));
    return geometry;
  };
  const stationSet = read(scope.stations), settlementSet = read(scope.settlements);
  stationSet.stations.forEach(station => frame(station.coordinates));
  settlementSet.places.forEach(place => frame(place.coordinates));
  // The scope's authored cities, its start place first: the network kept is the one the game starts on (Punta Arenas),
  // or for Europe, Asia and Africa the one the journey ends on (Cape Town).
  const cities = parseCsv(fs.readFileSync(path.join(root, AREA.places), 'utf8'))
    .map(row => ({ id: row.place_id, name: row.name, latitude: Number(row.latitude), longitude: projection.inFrame(Number(row.longitude), grid) }))
    .sort((a, b) => (a.id === AREA.startPlace ? -1 : b.id === AREA.startPlace ? 1 : a.id.localeCompare(b.id)));
  assert(cities.length && cities[0].id === AREA.startPlace, 'No place ' + AREA.startPlace + ' in ' + AREA.places);
  const joinsFile = path.join(root, 'world/authored/network-joins.json');
  // A route with a "scope" is laid only in that scope's builds (a route in Alaska means nothing to South America's).
  const authoredJoins = (fs.existsSync(joinsFile) ? JSON.parse(fs.readFileSync(joinsFile, 'utf8')).joins : [])
    .filter(join => inScope(join, AREA.name));
  authoredJoins.forEach(join => (join.route || [join.from, join.to]).forEach(stop => {
    if (Array.isArray(stop)) frame(stop);
    else if (stop && Array.isArray(stop.coordinates)) frame(stop.coordinates);
  }));
  // Hand-made edits made in the stops stage (world/authored/network-edits.json), in the scope's builds only.
  const editsFile = path.join(root, 'world/authored/network-edits.json');
  const editsRead = fs.existsSync(editsFile) ? JSON.parse(fs.readFileSync(editsFile, 'utf8')) : {};
  const edits = { keep: (editsRead.keep || []).filter(edit => inScope(edit, AREA.name)), remove: (editsRead.remove || []).filter(edit => inScope(edit, AREA.name)) };
  edits.keep.concat(edits.remove).forEach(edit => edit.route.forEach(stop => {
    if (Array.isArray(stop)) frame(stop);
    else if (stop && Array.isArray(stop.coordinates)) frame(stop.coordinates);
    if (stop && Array.isArray(stop.near)) frame(stop.near);
  }));
  // The places every build gives a station (world/external/significant-places.json: scripts/world/significant-places.cjs).
  const significantFile = path.join(root, 'world/external/significant-places.json');
  const significant = fs.existsSync(significantFile) ? JSON.parse(fs.readFileSync(significantFile, 'utf8')).places : [];
  significant.forEach(place => frame(place.coordinates));
  const outpostsFile = path.join(root, scope.outposts);
  // The outposts that pass keep(place), read a line at a time and let go of the rest: on two continents the whole
  // file is half a million records, and the halts want only those beside the track.
  const readOutpostsWhere = keep => {
    if (!fs.existsSync(outpostsFile)) return [];
    const kept = [], descriptor = fs.openSync(outpostsFile, 'r'), buffer = Buffer.alloc(16 << 20);
    const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    let rest = '', read;
    const take = line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{"')) return;
      const place = JSON.parse(trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed);
      if (!place.coordinates) return;
      frame(place.coordinates);
      if (keep(place)) kept.push(place);
    };
    try {
      while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        const lines = (rest + decoder.write(buffer.subarray(0, read))).split('\n');
        rest = lines.pop();
        lines.forEach(take);
      }
      rest += decoder.end();
      if (rest) take(rest);
    } finally {
      fs.closeSync(descriptor);
    }
    return kept;
  };
  const readOutposts = () => {
    if (!fs.existsSync(outpostsFile)) return [];
    const places = read(scope.outposts).places;
    places.forEach(place => frame(place.coordinates));
    return places;
  };
  // Hard regions are drawn in the frame of the builds they belong to (a region across the 180th meridian in Asia's
  // frame runs past 180 degrees east).
  const regionsFile = path.join(root, 'world/authored/regions.json');
  const regions = (fs.existsSync(regionsFile) ? JSON.parse(fs.readFileSync(regionsFile, 'utf8')).regions : [])
    .filter(region => inScope(region, AREA.name));
  // Checkpoints go beside the other build caches, one set per scope. --fresh ignores them all; --from <stage> runs
  // that stage and those after it again.
  const hashInput = file => fs.existsSync(path.join(root, file)) ? checkpoint.hashFile(path.join(root, file)) : null;
  log('hashing the inputs');
  const geometryHash = hashInput(scope.geometry);
  const checkpoints = args.includes('--no-checkpoints') ? null : {
    dir: path.join(process.env.ASHLINE_WORLD_CHECKPOINTS || path.join(cache, 'checkpoints')), scope: AREA.prefix,
    fresh: args.includes('--fresh'), from: option('from'), resumeOnly: args.includes('--resume-only'), trust: option('trust-checkpoint'),
    inputs: { geometry: geometryHash, settlements: hashInput(scope.settlements), outposts: hashInput(scope.outposts),
      cities: cities, authoredJoins: authoredJoins, regions: regions }
  };
  if (checkpoints) log('checkpoints in ' + checkpoints.dir);
  // --keys: print what each stage's checkpoint is keyed by, and stop (to see why a checkpoint is not being used).
  if (checkpoints && args.includes('--keys')) { const { parts, ...keys } = stageKeys({ grid, checkpoints }); console.log(JSON.stringify(keys)); return; }
  const built = buildNetwork({ geometry: readGeometry, stations: stationSet.stations, settlements: settlementSet.places, cities, grid, cache,
    authoredJoins, edits, significant, outposts: readOutposts, regions, checkpoints, settlementsFile: path.join(root, scope.settlements),
    haltPlaces: keep => readOutpostsWhere(keep) });
  const artifact = {
    formatVersion: 1,
    id: scope.id,
    label: scope.label,
    builderVersion: BUILDER_VERSION,
    grid,
    sources: {
      geometry: { id: built.geometry.id, sourceId: built.geometry.sourceId, sha256: geometryHash },
      stations: { id: stationSet.id, sourceId: stationSet.sourceId },
      settlements: { id: settlementSet.id, sourceId: settlementSet.sourceId },
      outposts: { id: AREA.prefix + '-outposts', count: built.outpostCount },
      elevation: { sourceId: 'copernicus-dem-glo90', aggregation: 'mean-and-population-standard-deviation-within-grid-square',
        tileCount: 0 }
    },
    parameters: { traceStepsPerCell: TRACE_STEPS_PER_CELL, shortBridgeKm: SHORT_BRIDGE_KM, straightBridgeKm: STRAIGHT_BRIDGE_KM,
      longBridgeMaxKm: LONG_BRIDGE_MAX_KM, minPieceKm: MIN_PIECE_KM, cityReachKm: CITY_REACH_KM, bridgeMinKm: BRIDGE_MIN_KM,
      tunnelMinShare: TUNNEL_MIN_SHARE, maxSectionKm: MAX_SECTION_KM, stationShiftSquares: STATION_SHIFT_SQUARES, stubJoinKm: STUB_JOIN_KM,
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

module.exports = { trackPath, applyEdits, significantStops, terminusStops, townFinder, thinTrack, isStraightSquare, pruneDeadEnds, distancesAlong, distancesTo, dependenciesOf, stageTrace, stageJoins, stageOutskirts, stageStops, hardRegionTest, longJoins, buildNetwork, stubJoins, endJoins, cityShortcuts, pruneParallel, spliceOntoTrack, spurs, regionClassifier, simplifyUrban, traceLine, Network, placeIndex, resolveRoute, planLine, addLine };
