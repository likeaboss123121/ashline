const crypto = require('node:crypto');

const TILE_KM = 5;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function key(coordinate) {
  return coordinate[0].toFixed(7) + ',' + coordinate[1].toFixed(7);
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeA = radians(a[1]);
  const latitudeB = radians(b[1]);
  const deltaLatitude = radians(b[1] - a[1]);
  const deltaLongitude = radians(b[0] - a[0]);
  const h = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

class MinHeap {
  constructor() { this.items = []; }
  push(value) {
    this.items.push(value);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= value.distance) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = value;
  }
  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= this.items.length) break;
        if (child + 1 < this.items.length && this.items[child + 1].distance < this.items[child].distance) child++;
        if (this.items[child].distance >= last.distance) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function buildCoordinateGraph(geometry) {
  const nodes = new Map();
  const segments = [];
  function node(coordinate) {
    const id = key(coordinate);
    if (!nodes.has(id)) nodes.set(id, { key: id, coordinate, segments: [] });
    return nodes.get(id);
  }
  geometry.ways.forEach(way => {
    for (let index = 1; index < way.coordinates.length; index++) {
      const from = node(way.coordinates[index - 1]);
      const to = node(way.coordinates[index]);
      if (from.key === to.key) continue;
      const segment = {
        id: way.id + ':' + (index - 1), from: from.key, to: to.key,
        distanceKm: haversineKm(from.coordinate, to.coordinate), way
      };
      const segmentIndex = segments.length;
      segments.push(segment);
      from.segments.push(segmentIndex);
      to.segments.push(segmentIndex);
    }
  });
  return { nodes, segments };
}

function componentStats(graph) {
  const visited = new Set();
  const components = [];
  Array.from(graph.nodes.keys()).sort().forEach(start => {
    if (visited.has(start)) return;
    const pending = [start];
    visited.add(start);
    let segmentCount = 0;
    let lengthKm = 0;
    const seenSegments = new Set();
    while (pending.length) {
      const current = graph.nodes.get(pending.pop());
      current.segments.forEach(index => {
        if (!seenSegments.has(index)) {
          seenSegments.add(index);
          segmentCount++;
          lengthKm += graph.segments[index].distanceKm;
        }
        const segment = graph.segments[index];
        const other = segment.from === current.key ? segment.to : segment.from;
        if (!visited.has(other)) { visited.add(other); pending.push(other); }
      });
    }
    components.push({ nodeCount: visited.size - components.reduce((sum, item) => sum + item.nodeCount, 0), segmentCount,
      lengthKm: Math.round(lengthKm * 10) / 10 });
  });
  return components.sort((a, b) => b.nodeCount - a.nodeCount);
}

function shortestPath(graph, start, goal) {
  assert(graph.nodes.has(start), 'Route station is not on imported rail: ' + start);
  assert(graph.nodes.has(goal), 'Route station is not on imported rail: ' + goal);
  const distances = new Map([[start, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ key: start, distance: 0 });
  while (heap.items.length) {
    const current = heap.pop();
    if (current.distance !== distances.get(current.key)) continue;
    if (current.key === goal) break;
    graph.nodes.get(current.key).segments.forEach(segmentIndex => {
      const segment = graph.segments[segmentIndex];
      const next = segment.from === current.key ? segment.to : segment.from;
      // Mainline wins ties over yard/spur geometry without making local connections impossible.
      const cost = segment.distanceKm * (segment.way.tags.service ? 1.35 : 1);
      const distance = current.distance + cost;
      if (distance < (distances.get(next) ?? Infinity)) {
        distances.set(next, distance);
        previous.set(next, { key: current.key, segmentIndex });
        heap.push({ key: next, distance });
      }
    });
  }
  assert(previous.has(goal) || start === goal, 'No imported-rail route between authored stations');
  const path = [];
  let cursor = goal;
  while (cursor !== start) {
    const step = previous.get(cursor);
    const segment = graph.segments[step.segmentIndex];
    path.push({
      from: step.key,
      to: cursor,
      fromCoordinate: graph.nodes.get(step.key).coordinate,
      toCoordinate: graph.nodes.get(cursor).coordinate,
      distanceKm: segment.distanceKm,
      way: segment.way
    });
    cursor = step.key;
  }
  return path.reverse();
}

function interpolate(a, b, ratio) {
  return [Math.round((a[0] + (b[0] - a[0]) * ratio) * 1e7) / 1e7,
    Math.round((a[1] + (b[1] - a[1]) * ratio) * 1e7) / 1e7];
}

function slicesForPath(path, corridorId, legIndex) {
  const slices = [];
  let coordinates = [path[0].fromCoordinate];
  let distanceKm = 0;
  let sourceWayIds = new Set();
  let flags = { bridge: false, tunnel: false, service: true, statuses: new Set() };
  function addWay(way) {
    sourceWayIds.add(way.id);
    flags.bridge = flags.bridge || (!!way.tags.bridge && way.tags.bridge !== 'no');
    flags.tunnel = flags.tunnel || (!!way.tags.tunnel && way.tags.tunnel !== 'no');
    flags.service = flags.service && !!way.tags.service;
    flags.statuses.add(way.railwayStatus);
  }
  function emit() {
    if (!(distanceKm > 0)) return;
    const ordinal = slices.length + 1;
    slices.push({
      id: corridorId + ':leg-' + legIndex + ':slice-' + String(ordinal).padStart(2, '0'),
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      coordinates,
      sourceWayIds: Array.from(sourceWayIds).sort(),
      bridge: flags.bridge,
      tunnel: flags.tunnel,
      service: flags.service,
      railwayStatuses: Array.from(flags.statuses).sort(),
      navigable: true,
      reviewStatus: 'authored-gameplay-route'
    });
    coordinates = [coordinates[coordinates.length - 1]];
    distanceKm = 0;
    sourceWayIds = new Set();
    flags = { bridge: false, tunnel: false, service: true, statuses: new Set() };
  }
  path.forEach(step => {
    let from = step.fromCoordinate;
    const to = step.toCoordinate;
    let remaining = haversineKm(from, to);
    addWay(step.way);
    while (remaining > 0.000001) {
      const room = TILE_KM - distanceKm;
      if (remaining <= room + 0.000001) {
        coordinates.push(to);
        distanceKm += remaining;
        remaining = 0;
      } else {
        const boundary = interpolate(from, to, room / remaining);
        coordinates.push(boundary);
        distanceKm += room;
        emit();
        addWay(step.way);
        from = boundary;
        remaining = haversineKm(from, to);
      }
    }
  });
  emit();
  return slices;
}

function buildTopology(geometry, authored) {
  const graph = buildCoordinateGraph(geometry);
  const pointsById = Object.fromEntries(geometry.points.map(point => [point.id, point]));
  const components = componentStats(graph);
  const corridors = authored.corridors.filter(corridor => corridor.geometryId === geometry.id).map(corridor => {
    const stations = corridor.stationPointIds.map(id => {
      const point = pointsById[id];
      assert(point && point.tags.name, 'Missing named station point: ' + id);
      assert(graph.nodes.has(key(point.coordinates)), 'Station does not lie on imported rail: ' + point.tags.name);
      return { id: point.id, name: point.tags.name, coordinates: point.coordinates };
    });
    const legs = [];
    const corridorPath = [];
    for (let index = 0; index < stations.length - 1; index++) {
      const path = shortestPath(graph, key(stations[index].coordinates), key(stations[index + 1].coordinates));
      corridorPath.push(...path);
      const slices = slicesForPath(path, corridor.id, index + 1);
      legs.push({
        id: corridor.id + ':leg-' + (index + 1),
        fromStationId: stations[index].id,
        toStationId: stations[index + 1].id,
        distanceKm: Math.round(path.reduce((sum, step) => sum + step.distanceKm, 0) * 1000) / 1000,
        sourceSegmentCount: path.length,
        slices
      });
    }
    const gridSlices = slicesForPath(corridorPath, corridor.id, 'grid');
    return {
      id: corridor.id,
      label: corridor.label,
      geometryId: geometry.id,
      debugOnly: corridor.debugOnly === true,
      navigable: true,
      reviewStatus: 'authored-gameplay-route',
      stations,
      legs,
      gridSlices,
      distanceKm: Math.round(legs.reduce((sum, leg) => sum + leg.distanceKm, 0) * 10) / 10,
      sliceCount: legs.reduce((sum, leg) => sum + leg.slices.length, 0),
      gridSliceCount: gridSlices.length
    };
  });
  return {
    formatVersion: 1,
    geometryId: geometry.id,
    tileKm: TILE_KM,
    buildId: crypto.createHash('sha256').update(JSON.stringify({ topologyVersion: 3,
      geometry: geometry.sourceInputSha256,
      // Only this geometry's corridors: adding a corridor elsewhere must not make this topology's elevation stale.
      authored: { corridors: authored.corridors.filter(corridor => corridor.geometryId === geometry.id) } })).digest('hex').slice(0, 16),
    stats: {
      railwayCoordinateNodes: graph.nodes.size,
      railwaySegments: graph.segments.length,
      componentCount: components.length,
      largestComponentNodes: components[0] ? components[0].nodeCount : 0,
      railwayLengthKm: Math.round(graph.segments.reduce((sum, segment) => sum + segment.distanceKm, 0) * 10) / 10
    },
    components,
    corridors
  };
}

module.exports = { TILE_KM, buildCoordinateGraph, buildTopology, shortestPath, slicesForPath };
