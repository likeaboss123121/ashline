// Turns approved routed planning links into a playable corridor.
//
// scripts/world/route-planning-links.cjs routes each planning chord over real rail and proposes straight gap fills
// where the mapped network breaks. Those links are proposals and are never navigable on their own. An authored
// corridor in world/authored/playable-corridors.json can list routed links by id; once listed, the corridor is the
// review decision: its links are joined end to end, stations are placed at the cities at each end and at the named
// OSM stations found along the way, and the whole line is re-cut into 5 km gameplay slices. The result has the same
// shape as a corridor from build-rail-topology.cjs, so the runtime treats both alike.
const crypto = require('node:crypto');
const projection = require('./projection.cjs');

const TILE_KM = 5;
// A named station closer than this to the one before it is left out: two stations on one 5 km tile cannot both be
// stopped at.
const MIN_STATION_SPACING_KM = TILE_KM;
// How far a mapped station may stand from the line and still be a stop on it.
const STATION_ALONG_KM = 1;
// How near a proposed line must pass a settlement for it to be a stop. The line is drawn through settlements over
// cells of about 2 km, so it can miss a town's centre by a cell or so.
const SETTLEMENT_ALONG_KM = 3;
// The longest the line runs without a stop before kilometre-post halts are added. The reserve engine a yard keeps must
// reach the next station on one tank, which a leg much longer than this cannot promise.
const MAX_STATION_GAP_KM = 100;
// Which of two stops too close together to both be kept is the stop: a city, then a working station (the bigger the
// better, by EFE's category), then a working halt, then a closed station or halt, then a kilometre post.
function rank(stop) {
  if (stop.status === 'city') return 100;
  if (stop.status === 'kilometre-post') return 0;
  // A settlement the proposed line runs through, where no station was ever mapped.
  if (stop.status === 'settlement') return { city: 38, town: 28, village: 15 }[stop.kind] || 15;
  const working = stop.status === 'active';
  if (stop.kind === 'halt') return working ? 30 : 5;
  return (working ? 40 : 10) + (stop.category ? 4 - stop.category : 0);
}
// A 5 km tile is drawn as a bridge when it carries a real river crossing, not a culvert or an overpass, and as a
// tunnel only when most of it is underground. Changing either never moves a tile, so neither is in the build ID.
const BRIDGE_MIN_KM = 0.2;
const TUNNEL_MIN_SHARE = 0.5;
// Only what decides where the grid squares fall belongs in the build ID: the elevation samples are keyed to it.
const BUILDER_VERSION = 2;
// How finely the line is followed across the grid, as a fraction of a square.
const TRACE_STEPS_PER_CELL = 8;
// A loop in the line up to this long is folded into the square it leaves from, keeping its length: a switchback or a
// spiral is real climbing. Anything longer is the line running out along a spur to a terminus and back the same way,
// as it does into Puerto Montt, Santiago and Antofagasta; a through train would not make that trip, so it is cut and
// its length left out, and the city's stop stands at the junction.
const LOOP_FOLD_MAX_KM = 15;
// A stop further than this from the square it would stand on lies on a spur the line no longer runs down. Naming the
// junction after it would put the place in the wrong spot, so it is left out (a city is recorded as bypassed) and
// the junction keeps whatever station really stands there.
const OFF_LINE_KM = 20;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = radians(b[1] - a[1]);
  const deltaLongitude = radians(b[0] - a[0]);
  const h = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolate(a, b, ratio) {
  return [Math.round((a[0] + (b[0] - a[0]) * ratio) * 1e7) / 1e7,
    Math.round((a[1] + (b[1] - a[1]) * ratio) * 1e7) / 1e7];
}

function same(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

// The corridor as one list of straight segments, each remembering which routed slice it came from.
function segmentsOf(links) {
  const segments = [];
  let along = 0;
  links.forEach((link, linkIndex) => {
    if (linkIndex) {
      const previous = links[linkIndex - 1].slices.at(-1).coordinates.at(-1);
      assert(same(previous, link.slices[0].coordinates[0]), 'Routed links do not meet: ' + links[linkIndex - 1].id + ' / ' + link.id);
    }
    link.linkStartKm = along;
    link.slices.forEach(slice => {
      const share = km => slice.distanceKm > 0 ? (km || 0) / slice.distanceKm : 0;
      const railShare = share(slice.railKm), bridgeShare = share(slice.bridgeKm), tunnelShare = share(slice.tunnelKm);
      for (let index = 1; index < slice.coordinates.length; index++) {
        const from = slice.coordinates[index - 1], to = slice.coordinates[index];
        const km = haversineKm(from, to);
        if (!(km > 0)) continue;
        segments.push({ from, to, km, startKm: along, slice, railShare, bridgeShare, tunnelShare });
        along += km;
      }
    });
  });
  return { segments, lengthKm: along };
}

// The nearest point of the line to a coordinate, measured on a flat projection around it: exact enough at a kilometre.
function projectOnto(segments, coordinate) {
  const kmPerLatitude = 110.57, kmPerLongitude = 111.32 * Math.cos(coordinate[1] * Math.PI / 180);
  let best = { distanceKm: Infinity };
  segments.forEach(segment => {
    const ax = (segment.from[0] - coordinate[0]) * kmPerLongitude, ay = (segment.from[1] - coordinate[1]) * kmPerLatitude;
    const bx = (segment.to[0] - coordinate[0]) * kmPerLongitude, by = (segment.to[1] - coordinate[1]) * kmPerLatitude;
    if (Math.min(Math.abs(ax), Math.abs(bx)) > best.distanceKm + segment.km && Math.sign(ax) === Math.sign(bx)) return;
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    const distanceKm = Math.hypot(ax + dx * t, ay + dy * t);
    if (distanceKm < best.distanceKm) best = { distanceKm, alongKm: segment.startKm + segment.km * t, segment };
  });
  return best;
}

function pointAt(segments, km) {
  for (const segment of segments) {
    if (km <= segment.startKm + segment.km) {
      return interpolate(segment.from, segment.to, Math.max(0, Math.min(1, (km - segment.startKm) / segment.km)));
    }
  }
  return segments.at(-1).to;
}

// Cuts [startKm, endKm] of the corridor into slices of at most TILE_KM, carrying provenance from the routed slices
// each one overlaps: the OSM ways, lifecycle statuses, bridges and tunnels, and how much of it is real track.
function sliceRange(segments, startKm, endKm, idPrefix) {
  const slices = [];
  let current = null;
  function open(coordinate) {
    current = { coordinates: [coordinate], distanceKm: 0, railKm: 0, gapKm: 0, sourceWayIds: new Set(),
      statuses: new Set(), bridgeKm: 0, tunnelKm: 0, routedSliceIds: new Set() };
  }
  function close() {
    if (!current || !(current.distanceKm > 1e-6)) return;
    const railKm = Math.round(current.railKm * 1000) / 1000;
    const gapKm = Math.round((current.distanceKm - current.railKm) * 1000) / 1000;
    const statuses = Array.from(current.statuses).sort();
    slices.push({
      id: idPrefix + ':slice-' + String(slices.length + 1).padStart(3, '0'),
      distanceKm: Math.round(current.distanceKm * 1000) / 1000,
      railKm, gapKm, gapFill: gapKm > railKm,
      coordinates: current.coordinates,
      sourceWayIds: Array.from(current.sourceWayIds).sort(),
      routedSliceIds: Array.from(current.routedSliceIds).sort(),
      bridge: current.bridgeKm >= BRIDGE_MIN_KM, tunnel: current.tunnelKm >= current.distanceKm * TUNNEL_MIN_SHARE,
      bridgeKm: Math.round(current.bridgeKm * 1000) / 1000, tunnelKm: Math.round(current.tunnelKm * 1000) / 1000,
      service: false,
      railwayStatuses: gapKm > 0 ? Array.from(new Set(statuses.concat('gap-fill'))).sort() : statuses,
      navigable: true,
      reviewStatus: 'approved-routed-link'
    });
  }
  function add(segment, from, to, km) {
    if (!current) open(from);
    current.coordinates.push(to);
    current.distanceKm += km;
    current.railKm += km * segment.railShare;
    current.routedSliceIds.add(segment.slice.id);
    segment.slice.sourceWayIds.forEach(id => current.sourceWayIds.add(id));
    segment.slice.railwayStatuses.forEach(status => current.statuses.add(status));
    current.bridgeKm += km * segment.bridgeShare;
    current.tunnelKm += km * segment.tunnelShare;
  }
  segments.forEach(segment => {
    const segmentEnd = segment.startKm + segment.km;
    if (segmentEnd <= startKm + 1e-9 || segment.startKm >= endKm - 1e-9) return;
    let fromKm = Math.max(segment.startKm, startKm);
    const untilKm = Math.min(segmentEnd, endKm);
    let from = fromKm > segment.startKm ? pointAt([segment], fromKm) : segment.from;
    while (untilKm - fromKm > 1e-9) {
      const room = TILE_KM - (current ? current.distanceKm : 0);
      const stepKm = Math.min(room, untilKm - fromKm);
      const toKm = fromKm + stepKm;
      const to = toKm >= segmentEnd - 1e-9 ? segment.to : pointAt([segment], toKm);
      add(segment, from, to, stepKm);
      if (current.distanceKm >= TILE_KM - 1e-9) {
        close();
        open(to);
      }
      from = to;
      fromKm = toKm;
    }
  });
  close();
  return slices;
}

// The grid squares the line passes through, in order, each carrying the track inside it.
//
// The line is followed in steps of an eighth of a square, so each square entered touches the one before. Where the
// line comes back to a square it already crossed (a terminus it runs into and out of, a switchback, a loop), the
// detour is folded into that square, so no square is visited twice and none of the track's length is lost. Then a
// square that only clips the corner between two diagonal neighbours is folded into them, which turns the stair steps
// of a diagonal line into straight diagonal track.
function traceCells(segments, grid) {
  const path = [];
  const detours = [];
  const indexByKey = new Map();
  const key = cell => cell[0] + ',' + cell[1];
  const blank = (cell, startKm) => ({ x: cell[0], y: cell[1], km: 0, railKm: 0, bridgeKm: 0, tunnelKm: 0,
    sourceWayIds: new Set(), statuses: new Set(), routedSliceIds: new Set(), startKm, endKm: startKm });
  const merge = (into, from, share = 1) => {
    ['km', 'railKm', 'bridgeKm', 'tunnelKm'].forEach(field => { into[field] += from[field] * share; });
    from.sourceWayIds.forEach(id => into.sourceWayIds.add(id));
    from.statuses.forEach(status => into.statuses.add(status));
    from.routedSliceIds.forEach(id => into.routedSliceIds.add(id));
  };
  segments.forEach(segment => {
    const steps = Math.max(1, Math.ceil(segment.km / (grid.cellKm / TRACE_STEPS_PER_CELL)));
    for (let step = 0; step < steps; step++) {
      const km = segment.km / steps, startKm = segment.startKm + km * step;
      const cell = projection.cellOf(interpolate(segment.from, segment.to, (step + 0.5) / steps), grid);
      let current = path.at(-1);
      if (!current || current.x !== cell[0] || current.y !== cell[1]) {
        const seen = indexByKey.get(key(cell));
        if (seen !== undefined) {
          const removed = path.splice(seen + 1);
          removed.forEach(cell => indexByKey.delete(key([cell.x, cell.y])));
          const loopKm = removed.reduce((sum, cell) => sum + cell.km, 0);
          current = path[seen];
          if (loopKm <= LOOP_FOLD_MAX_KM) {
            removed.forEach(cell => merge(current, cell));
          } else {
            // Provenance stays with the square; the kilometres do not.
            removed.forEach(cell => merge(current, cell, 0));
            detours.push({ x: current.x, y: current.y, km: Math.round(loopKm * 1000) / 1000 });
          }
        } else {
          current = blank(cell, startKm);
          path.push(current);
          indexByKey.set(key(cell), path.length - 1);
        }
      }
      current.km += km;
      current.railKm += km * segment.railShare;
      current.bridgeKm += km * segment.bridgeShare;
      current.tunnelKm += km * segment.tunnelShare;
      current.routedSliceIds.add(segment.slice.id);
      segment.slice.sourceWayIds.forEach(id => current.sourceWayIds.add(id));
      segment.slice.railwayStatuses.forEach(status => current.statuses.add(status));
      current.endKm = startKm + km;
    }
  });
  for (let index = 1; index < path.length - 1;) {
    const before = path[index - 1], corner = path[index], after = path[index + 1];
    if (Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1) {
      // Half the corner's track goes each way; the stations on it go to the square it is folded towards first.
      merge(before, corner, 0.5);
      merge(after, corner, 0.5);
      before.endKm = corner.endKm;
      path.splice(index, 1);
      if (index > 1) index--;
    } else {
      index++;
    }
  }
  path.forEach((cell, index) => {
    if (index) {
      const previous = path[index - 1];
      assert(Math.max(Math.abs(cell.x - previous.x), Math.abs(cell.y - previous.y)) === 1,
        'Traced squares do not touch at ' + cell.x + ',' + cell.y);
    }
  });
  path.detours = detours;
  return path;
}

// Which traced square a point along the line ended up in.
function cellIndexAt(path, alongKm) {
  let low = 0, high = path.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (path[middle].startKm <= alongKm + 1e-9) low = middle; else high = middle - 1;
  }
  return low;
}

// Builds the playable corridors that are made of routed links. routedSet is a parsed proposal file, places the
// compiled place nodes ({ id, name }) and stationSets the imported station files by ID.
// Settlements within reach of the line where it is proposed rather than mapped track: those are the stops of a gap
// fill. The settlements are indexed on a coarse grid of the gap-fill segments, since there are tens of thousands.
function settlementsAlong(segments, settlements) {
  const GRID = 0.1, index = new Map(), found = [];
  const keyOf = (column, row) => column + ',' + row;
  segments.filter(segment => segment.railShare < 0.5).forEach(segment => {
    const west = Math.min(segment.from[0], segment.to[0]), east = Math.max(segment.from[0], segment.to[0]);
    const south = Math.min(segment.from[1], segment.to[1]), north = Math.max(segment.from[1], segment.to[1]);
    for (let column = Math.floor(west / GRID); column <= Math.floor(east / GRID); column++) {
      for (let row = Math.floor(south / GRID); row <= Math.floor(north / GRID); row++) {
        const key = keyOf(column, row);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(segment);
      }
    }
  });
  settlements.forEach(settlement => {
    const column = Math.floor(settlement.coordinates[0] / GRID), row = Math.floor(settlement.coordinates[1] / GRID);
    const nearby = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) (index.get(keyOf(column + dx, row + dy)) || []).forEach(segment => nearby.add(segment));
    if (!nearby.size) return;
    const projected = projectOnto(Array.from(nearby), settlement.coordinates);
    if (projected.distanceKm <= SETTLEMENT_ALONG_KM) found.push({ settlement, alongKm: projected.alongKm });
  });
  return found;
}

function buildRoutedTopology(routedSet, authored, places, stationSets = {}, settlementSets = {}) {
  const placesById = Object.fromEntries(places.map(place => [place.id, place]));
  const linksById = Object.fromEntries(routedSet.links.map(link => [link.id, link]));
  const corridors = authored.corridors.filter(corridor => corridor.routedLinkSetId === routedSet.id).map(corridor => {
    assert(Array.isArray(corridor.routedLinkIds) && corridor.routedLinkIds.length, 'Routed corridor lists no links: ' + corridor.id);
    const links = corridor.routedLinkIds.map(id => {
      assert(linksById[id], 'Routed corridor uses unknown link: ' + id);
      return JSON.parse(JSON.stringify(linksById[id]));
    });
    const { segments, lengthKm } = segmentsOf(links);
    // Stations: the city at the start of every link and at the end of the last, and every named station of the
    // corridor's station set that stands within a kilometre of mapped track on the line.
    const candidates = [];
    links.forEach(link => {
      const place = placesById[link.from];
      assert(place, 'Routed link starts at an unknown place: ' + link.from);
      candidates.push({ id: 'place:' + place.id, name: place.name, alongKm: link.linkStartKm, status: 'city' });
    });
    const lastPlace = placesById[links.at(-1).to];
    assert(lastPlace, 'Routed link ends at an unknown place: ' + links.at(-1).to);
    candidates.push({ id: 'place:' + lastPlace.id, name: lastPlace.name, alongKm: lengthKm, status: 'city' });
    if (corridor.stationSetId) {
      const stationSet = stationSets[corridor.stationSetId];
      assert(stationSet, 'Routed corridor uses unknown station set: ' + corridor.stationSetId);
      stationSet.stations.forEach(station => {
        const projected = projectOnto(segments, station.coordinates);
        if (projected.distanceKm > STATION_ALONG_KM || projected.segment.railShare < 0.5) return;
        candidates.push({ id: station.id, name: station.name, alongKm: projected.alongKm, status: station.status,
          kind: station.kind, category: station.category });
      });
    } else {
      links.forEach(link => link.stations.forEach(station => {
        candidates.push({ id: station.id, name: station.name, alongKm: link.linkStartKm + station.alongKm, status: 'active' });
      }));
    }
    if (corridor.settlementSetId) {
      const settlementSet = settlementSets[corridor.settlementSetId];
      assert(settlementSet, 'Routed corridor uses unknown settlement set: ' + corridor.settlementSetId);
      settlementsAlong(segments, settlementSet.places).forEach(({ settlement, alongKm }) => {
        candidates.push({ id: settlement.id, name: settlement.name, alongKm, status: 'settlement', kind: settlement.kind });
      });
    }
    candidates.sort((a, b) => a.alongKm - b.alongKm || rank(b) - rank(a) || a.id.localeCompare(b.id));
    // Two stops closer than a tile cannot both be stopped at: the higher ranked is kept, or the first of equals.
    const stations = [];
    const skippedStations = [];
    candidates.forEach(candidate => {
      while (stations.length && candidate.alongKm - stations.at(-1).alongKm < MIN_STATION_SPACING_KM
        && rank(candidate) > rank(stations.at(-1)) && stations.length > 1) {
        skippedStations.push(stations.pop().id);
      }
      if (stations.length && candidate.alongKm - stations.at(-1).alongKm < MIN_STATION_SPACING_KM) {
        // The final city always ends the line, even when a station stands just short of it.
        if (candidate.alongKm === lengthKm && candidate.status === 'city') skippedStations.push(stations.pop().id);
        else { skippedStations.push(candidate.id); return; }
      }
      stations.push(candidate);
    });
    // Where the line runs further than MAX_STATION_GAP_KM with nowhere to stop, as it does over a long gap fill,
    // halts are spaced evenly along it and named for their distance from the start of the line.
    for (let index = stations.length - 1; index > 0; index--) {
      const from = stations[index - 1], to = stations[index];
      const count = Math.ceil((to.alongKm - from.alongKm) / MAX_STATION_GAP_KM) - 1;
      const halts = [];
      for (let halt = 1; halt <= count; halt++) {
        const alongKm = from.alongKm + (to.alongKm - from.alongKm) * halt / (count + 1);
        const kilometre = Math.round(alongKm);
        halts.push({ id: 'halt:' + corridor.id + ':km-' + kilometre, name: 'Km ' + kilometre, alongKm, status: 'kilometre-post' });
      }
      stations.splice(index, 0, ...halts);
    }
    // Lay the line on the shared grid, then give each stop the square it stands in. Two stops that land in one
    // square cannot both be stopped at, so the higher ranked keeps it, as with stops closer than a square.
    const grid = { ...projection.GRID, cellKm: corridor.cellKm || projection.GRID.cellKm };
    const cells = traceCells(segments, grid);
    cells[0].startKm = 0;
    const placed = [];
    const bypassedCities = [];
    stations.forEach(station => {
      station.cellIndex = cellIndexAt(cells, station.alongKm);
      if (station === stations.at(-1)) station.cellIndex = cells.length - 1;
      if (station !== stations[0] && station !== stations.at(-1)) {
        const square = cells[station.cellIndex];
        const offKm = haversineKm(pointAt(segments, station.alongKm), projection.centreOf([square.x, square.y], grid));
        if (offKm > OFF_LINE_KM) {
          if (station.status === 'city') bypassedCities.push({ id: station.id, name: station.name, offKm: Math.round(offKm) });
          skippedStations.push(station.id);
          return;
        }
      }
      const previous = placed.at(-1);
      if (previous && station.cellIndex <= previous.cellIndex) {
        if (station === stations.at(-1) || (rank(station) > rank(previous) && placed.length > 1)) {
          skippedStations.push(placed.pop().id);
          if (placed.length && station.cellIndex <= placed.at(-1).cellIndex) { skippedStations.push(station.id); return; }
        } else {
          skippedStations.push(station.id);
          return;
        }
      }
      placed.push(station);
    });
    stations.length = 0;
    stations.push(...placed);
    stations.forEach(station => { station.coordinates = pointAt(segments, station.alongKm); });
    const legs = [];
    for (let index = 0; index < stations.length - 1; index++) {
      const from = stations[index], to = stations[index + 1];
      const slices = sliceRange(segments, from.alongKm, to.alongKm, corridor.id + ':leg-' + (index + 1));
      legs.push({
        id: corridor.id + ':leg-' + (index + 1),
        fromStationId: from.id,
        toStationId: to.id,
        distanceKm: Math.round(slices.reduce((sum, slice) => sum + slice.distanceKm, 0) * 1000) / 1000,
        slices
      });
    }
    // What a move from one square to the next costs: half the track in each. The first and last moves take the whole
    // of the end squares, so the moves add up to the full length of the line.
    const round3 = value => Math.round(value * 1000) / 1000;
    const gridCells = cells.map((cell, index) => {
      const last = cells.length - 1;
      const stepKm = index === last ? 0 : (index === 0 ? cell.km : cell.km / 2)
        + (index + 1 === last ? cells[index + 1].km : cells[index + 1].km / 2);
      const railKm = Math.min(cell.km, cell.railKm), gapKm = Math.max(0, cell.km - railKm);
      const statuses = Array.from(cell.statuses).sort();
      return {
        id: corridor.id + ':cell-' + String(index + 1).padStart(4, '0'),
        x: cell.x, y: cell.y,
        centre: projection.centreOf([cell.x, cell.y], grid),
        km: round3(cell.km), stepKm: round3(stepKm), railKm: round3(railKm), gapKm: round3(gapKm),
        gapFill: gapKm > railKm,
        bridge: cell.bridgeKm >= BRIDGE_MIN_KM, tunnel: cell.tunnelKm >= cell.km * TUNNEL_MIN_SHARE,
        bridgeKm: round3(cell.bridgeKm), tunnelKm: round3(cell.tunnelKm),
        sourceWayIds: Array.from(cell.sourceWayIds).sort(),
        routedSliceIds: Array.from(cell.routedSliceIds).sort(),
        railwayStatuses: gapKm > 0 ? Array.from(new Set(statuses.concat('gap-fill'))).sort() : statuses,
        navigable: true,
        reviewStatus: 'approved-routed-link'
      };
    });
    const railKm = gridCells.reduce((sum, cell) => sum + cell.railKm, 0);
    return {
      id: corridor.id,
      label: corridor.label,
      geometryId: routedSet.id,
      debugOnly: corridor.debugOnly === true,
      navigable: true,
      reviewStatus: 'authored-gameplay-route',
      routedLinkIds: corridor.routedLinkIds.slice(),
      stations: stations.map(station => ({ id: station.id, name: station.name, status: station.status,
        coordinates: station.coordinates, alongKm: Math.round(station.alongKm * 1000) / 1000 })),
      grid,
      stationPositions: stations.map(station => station.cellIndex),
      // Out-and-back runs to termini that a through train skips; the moves cover the rest of the line.
      skippedDetours: cells.detours,
      bypassedCities,
      playableKm: Math.round(gridCells.reduce((sum, cell) => sum + cell.stepKm, 0) * 10) / 10,
      skippedStationIds: skippedStations,
      legs,
      gridCells,
      distanceKm: Math.round(legs.reduce((sum, leg) => sum + leg.distanceKm, 0) * 10) / 10,
      railKm: Math.round(railKm * 10) / 10,
      gapKm: Math.round((lengthKm - railKm) * 10) / 10,
      sliceCount: legs.reduce((sum, leg) => sum + leg.slices.length, 0),
      gridCellCount: gridCells.length
    };
  });
  return {
    formatVersion: 1,
    geometryId: routedSet.id,
    routed: true,
    tileKm: TILE_KM,
    buildId: crypto.createHash('sha256').update(JSON.stringify({ builderVersion: BUILDER_VERSION,
      geometry: routedSet.geometrySha256, links: routedSet.links.map(link => [link.id, link.routedKm, link.sliceCount]),
      grid: projection.GRID, traceStepsPerCell: TRACE_STEPS_PER_CELL,
      corridors: authored.corridors.filter(corridor => corridor.routedLinkSetId === routedSet.id)
        .map(corridor => [corridor.id, corridor.routedLinkIds, corridor.cellKm || null]) }))
      .digest('hex').slice(0, 16),
    corridors
  };
}

module.exports = { TILE_KM, MIN_STATION_SPACING_KM, MAX_STATION_GAP_KM, STATION_ALONG_KM, BRIDGE_MIN_KM, TUNNEL_MIN_SHARE,
  buildRoutedTopology, sliceRange, segmentsOf, traceCells };
