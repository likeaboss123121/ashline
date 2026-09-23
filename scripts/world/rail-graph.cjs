// The mapped railway as a graph of coordinates: a node wherever ways share a point, a segment between each pair of
// consecutive points of a way. The planning-link router (route-planning-links.cjs) routes over it.
const TILE_KM = 5;

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

module.exports = { TILE_KM, buildCoordinateGraph };
