const fs = require('node:fs');
const path = require('node:path');
const { buildTopology } = require('./build-rail-topology.cjs');

const root = path.resolve(__dirname, '../..');
const checkOnly = process.argv.includes('--check');
const tileKm = 5;

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const parseLine = line => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (character === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (character === ',' && !quoted) {
        values.push(value);
        value = '';
      } else {
        value += character;
      }
    }
    if (quoted) throw new Error('Unclosed CSV quote: ' + line);
    values.push(value);
    return values;
  };
  const headings = parseLine(lines.shift());
  return lines.filter(Boolean).map((line, index) => {
    const values = parseLine(line);
    if (values.length !== headings.length) throw new Error('Bad CSV column count on row ' + (index + 2));
    return Object.fromEntries(headings.map((heading, column) => [heading, values[column]]));
  });
}

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
  const authoredPlayableCorridors = JSON.parse(read('world/authored/playable-corridors.json'));
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
  const railGeometry = importManifest.railGeometry.map(entry => {
    const geometry = JSON.parse(read(entry.file));
    assert(geometry.id === entry.id, 'Rail geometry import ID mismatch: ' + entry.file);
    validateRailGeometry(geometry, sourceManifest.sources);
    return geometry;
  });
  const railTopology = railGeometry.map(geometry => buildTopology(geometry, authoredPlayableCorridors));
  const bundle = {
    formatVersion: 1,
    datasetVersion: sourceManifest.datasetVersion,
    tileKm,
    sources: sourceManifest.sources,
    regions,
    corridors,
    railGeometry,
    railTopology,
    chunks: sortedChunks
  };
  validateBundle(bundle);
  return bundle;
}

function validateRailGeometry(geometry, sources) {
  assert(geometry.formatVersion === 1, 'Unsupported rail geometry format: ' + geometry.id);
  assert(geometry.geometrySource === 'openstreetmap-way', 'Unexpected rail geometry source: ' + geometry.id);
  assert(geometry.navigable === false && geometry.reviewRequired === true, 'Unsafe rail geometry flags: ' + geometry.id);
  const source = sources.find(candidate => candidate.id === geometry.sourceId);
  assert(source && source.status === 'ingested', 'Rail geometry has no ingested source: ' + geometry.id);
  assert(Array.isArray(geometry.bounds) && geometry.bounds.length === 4, 'Invalid bounds: ' + geometry.id);
  const ids = new Set();
  let coordinateCount = 0;
  let lengthKm = 0;
  geometry.ways.forEach(way => {
    assert(!ids.has(way.id), 'Duplicate rail way: ' + way.id);
    ids.add(way.id);
    assert(way.navigable === false && way.reviewRequired === true, 'Unsafe rail way flags: ' + way.id);
    assert(Array.isArray(way.coordinates) && way.coordinates.length >= 2, 'Rail way has no geometry: ' + way.id);
    way.coordinates.forEach(coordinate => {
      assert(Array.isArray(coordinate) && coordinate.length === 2 && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]),
        'Invalid rail coordinate: ' + way.id);
    });
    coordinateCount += way.coordinates.length;
    lengthKm += way.lengthKm;
  });
  assert(ids.size === geometry.stats.wayCount, 'Rail way count mismatch: ' + geometry.id);
  assert(Array.isArray(geometry.points) && geometry.points.length === geometry.stats.pointCount, 'Rail point count mismatch: ' + geometry.id);
  assert(coordinateCount === geometry.stats.coordinateCount, 'Rail coordinate count mismatch: ' + geometry.id);
  assert(Math.abs(Math.round(lengthKm * 10) / 10 - geometry.stats.lengthKm) < 0.11, 'Rail length mismatch: ' + geometry.id);
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
  const topologyGeometryIds = new Set();
  bundle.railTopology.forEach(topology => {
    assert(!topologyGeometryIds.has(topology.geometryId), 'Duplicate rail topology: ' + topology.geometryId);
    topologyGeometryIds.add(topology.geometryId);
    assert(topology.formatVersion === 1 && topology.tileKm === bundle.tileKm, 'Invalid topology header: ' + topology.geometryId);
    topology.corridors.forEach(corridor => {
      assert(corridor.debugOnly === true && corridor.navigable === true,
        'Only explicitly authored debug corridors may be navigable: ' + corridor.id);
      assert(corridor.stations.length === corridor.legs.length + 1, 'Wrong station/leg count: ' + corridor.id);
      const sliceIds = new Set();
      let corridorDistance = 0;
      corridor.legs.forEach((leg, legIndex) => {
        assert(leg.fromStationId === corridor.stations[legIndex].id &&
          leg.toStationId === corridor.stations[legIndex + 1].id, 'Disconnected topology leg: ' + leg.id);
        let legDistance = 0;
        leg.slices.forEach((slice, sliceIndex) => {
          assert(!sliceIds.has(slice.id), 'Duplicate topology slice: ' + slice.id);
          sliceIds.add(slice.id);
          assert(slice.navigable === true && slice.reviewStatus === 'authored-debug-pilot', 'Unsafe topology slice: ' + slice.id);
          assert(slice.distanceKm > 0 && slice.distanceKm <= bundle.tileKm + 0.001, 'Invalid topology slice length: ' + slice.id);
          assert(slice.coordinates.length >= 2 && slice.sourceWayIds.length > 0, 'Topology slice lacks provenance: ' + slice.id);
          if (sliceIndex) {
            const previous = leg.slices[sliceIndex - 1];
            assert(JSON.stringify(previous.coordinates.at(-1)) === JSON.stringify(slice.coordinates[0]),
              'Disconnected topology slices: ' + slice.id);
          }
          legDistance += slice.distanceKm;
        });
        assert(Math.abs(legDistance - leg.distanceKm) < 0.01, 'Topology leg distance mismatch: ' + leg.id);
        corridorDistance += leg.distanceKm;
      });
      assert(sliceIds.size === corridor.sliceCount, 'Topology slice count mismatch: ' + corridor.id);
      assert(Math.abs(Math.round(corridorDistance * 10) / 10 - corridor.distanceKm) < 0.01,
        'Topology corridor distance mismatch: ' + corridor.id);
    });
  });
}

function outputsFor(bundle) {
  const manifest = { ...bundle };
  delete manifest.chunks;
  manifest.railGeometry = bundle.railGeometry.map(geometry => ({
    formatVersion: geometry.formatVersion,
    id: geometry.id,
    label: geometry.label,
    sourceId: geometry.sourceId,
    sourceSnapshotSha256: geometry.sourceSnapshotSha256,
    sourceInputSha256: geometry.sourceInputSha256,
    bounds: geometry.bounds,
    geometrySource: geometry.geometrySource,
    navigable: geometry.navigable,
    reviewRequired: geometry.reviewRequired,
    stats: geometry.stats,
    file: 'geometry/' + geometry.id + '.json'
  }));
  const browserBundle = { ...bundle, railGeometry: bundle.railGeometry.map(geometry => ({
    formatVersion: geometry.formatVersion,
    id: geometry.id,
    label: geometry.label,
    sourceId: geometry.sourceId,
    bounds: geometry.bounds,
    geometrySource: geometry.geometrySource,
    navigable: geometry.navigable,
    reviewRequired: geometry.reviewRequired,
    stats: geometry.stats,
    // The full attributed records remain in the standalone geometry chunk. The browser preview only needs shape,
    // status and whether a line is local service track.
    ways: geometry.ways.map(way => ({
      railwayStatus: way.railwayStatus,
      service: !!way.tags.service,
      coordinates: way.coordinates
    }))
  })) };
  const outputs = new Map([
    ['world/dist/manifest.json', stableJson(manifest)],
    ['source/world-data.js', '// Generated by scripts/world/compile-world.cjs. Do not edit.\nsetup.worldGraphData = ' + stableJson(browserBundle).trimEnd() + ';\n']
  ]);
  Object.entries(bundle.chunks).forEach(([id, chunk]) => {
    outputs.set('world/dist/regions/' + id + '.json', stableJson(chunk));
  });
  bundle.railGeometry.forEach(geometry => {
    outputs.set('world/dist/geometry/' + geometry.id + '.json', stableJson(geometry));
  });
  bundle.railTopology.forEach(topology => {
    outputs.set('world/dist/topology/' + topology.geometryId + '.json', stableJson(topology));
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

try {
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
    ' km; ' + bundle.railGeometry.reduce((sum, geometry) => sum + geometry.stats.wayCount, 0).toLocaleString('en-US') +
    ' sourced rail ways, ' + bundle.railTopology.reduce((sum, topology) => sum + topology.corridors.length, 0) +
    ' playable debug corridor(s)');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
