// Turns approved routed planning links into a playable corridor.
//
// scripts/world/route-planning-links.cjs routes each planning chord over real rail and proposes straight gap fills
// where the mapped network breaks. Those links are proposals and are never navigable on their own. An authored
// corridor in world/authored/playable-corridors.json can list routed links by id; once listed, the corridor is the
// review decision: its links are joined end to end, stations are placed at the cities at each end and at the named
// OSM stations found along the way, and the whole line is re-cut into 5 km gameplay slices. The result has the same
// shape as a corridor from build-rail-topology.cjs, so the runtime treats both alike.
const crypto = require('node:crypto');

const TILE_KM = 5;
// A named station closer than this to the one before it is left out: two stations on one 5 km tile cannot both be
// stopped at.
const MIN_STATION_SPACING_KM = TILE_KM;
// How far a mapped station may stand from the line and still be a stop on it.
const STATION_ALONG_KM = 1;
// The longest the line runs without a stop before kilometre-post halts are added. The reserve engine a yard keeps must
// reach the next station on one tank, which a leg much longer than this cannot promise.
const MAX_STATION_GAP_KM = 100;
// Which of two stops too close together to both be kept is the stop: a city, then a working station (the bigger the
// better, by EFE's category), then a working halt, then a closed station or halt, then a kilometre post.
function rank(stop) {
  if (stop.status === 'city') return 100;
  if (stop.status === 'kilometre-post') return 0;
  const working = stop.status === 'active';
  if (stop.kind === 'halt') return working ? 30 : 5;
  return (working ? 40 : 10) + (stop.category ? 4 - stop.category : 0);
}
// A 5 km tile is drawn as a bridge when it carries a real river crossing, not a culvert or an overpass, and as a
// tunnel only when most of it is underground. Changing either never moves a tile, so neither is in the build ID.
const BRIDGE_MIN_KM = 0.2;
const TUNNEL_MIN_SHARE = 0.5;
// Only what decides where the slices fall belongs in the build ID: the elevation samples are keyed to it.
const BUILDER_VERSION = 1;

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

// Builds the playable corridors that are made of routed links. routedSet is a parsed proposal file, places the
// compiled place nodes ({ id, name }) and stationSets the imported station files by ID.
function buildRoutedTopology(routedSet, authored, places, stationSets = {}) {
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
    const gridSlices = sliceRange(segments, 0, lengthKm, corridor.id + ':grid');
    const railKm = gridSlices.reduce((sum, slice) => sum + slice.railKm, 0);
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
      skippedStationIds: skippedStations,
      legs,
      gridSlices,
      distanceKm: Math.round(legs.reduce((sum, leg) => sum + leg.distanceKm, 0) * 10) / 10,
      railKm: Math.round(railKm * 10) / 10,
      gapKm: Math.round((lengthKm - railKm) * 10) / 10,
      sliceCount: legs.reduce((sum, leg) => sum + leg.slices.length, 0),
      gridSliceCount: gridSlices.length
    };
  });
  return {
    formatVersion: 1,
    geometryId: routedSet.id,
    routed: true,
    tileKm: TILE_KM,
    buildId: crypto.createHash('sha256').update(JSON.stringify({ builderVersion: BUILDER_VERSION,
      geometry: routedSet.geometrySha256, links: routedSet.links.map(link => [link.id, link.routedKm, link.sliceCount]),
      corridors: authored.corridors.filter(corridor => corridor.routedLinkSetId === routedSet.id)
        .map(corridor => [corridor.id, corridor.routedLinkIds]) }))
      .digest('hex').slice(0, 16),
    corridors
  };
}

module.exports = { TILE_KM, MIN_STATION_SPACING_KM, MAX_STATION_GAP_KM, STATION_ALONG_KM, BRIDGE_MIN_KM, TUNNEL_MIN_SHARE, buildRoutedTopology, sliceRange, segmentsOf };
