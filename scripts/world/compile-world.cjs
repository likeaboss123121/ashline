const fs = require('node:fs');
const path = require('node:path');
const { buildTopology } = require('./build-rail-topology.cjs');
const { simplify } = require('./route-planning-links.cjs');
const { parseCsv } = require('./csv.cjs');
const { buildRoutedTopology } = require('./build-routed-corridor.cjs');

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
  const stationSets = Object.fromEntries((importManifest.stations || []).map(entry => {
    const stationSet = JSON.parse(read(entry.file));
    assert(stationSet.id === entry.id && stationSet.formatVersion === 1, 'Station import ID mismatch: ' + entry.file);
    const source = sourceManifest.sources.find(candidate => candidate.id === stationSet.sourceId);
    assert(source && source.status === 'ingested', 'Station set has no ingested source: ' + entry.id);
    assert(stationSet.stations.length === stationSet.stats.stationCount, 'Station count mismatch: ' + entry.id);
    return [entry.id, stationSet];
  }));
  // Corridors made of routed planning links: listing a link in an authored corridor is what approves it for play.
  (importManifest.routedLinks || []).forEach(entry => {
    if (!authoredPlayableCorridors.corridors.some(corridor => corridor.routedLinkSetId === entry.id)) return;
    railTopology.push(buildRoutedTopology(JSON.parse(read(entry.file)), authoredPlayableCorridors, nodes, stationSets));
  });
  authoredPlayableCorridors.corridors.forEach(corridor => {
    assert(railTopology.some(topology => topology.corridors.some(built => built.id === corridor.id)),
      'Authored playable corridor was not built: ' + corridor.id);
  });
  const elevationByGeometry = Object.fromEntries((importManifest.elevation || []).map(entry => {
    const elevation = JSON.parse(read(entry.file));
    assert(elevation.geometryId === entry.geometryId, 'Elevation import geometry mismatch: ' + entry.file);
    return [entry.geometryId, elevation];
  }));
  railTopology.forEach(topology => {
    const elevation = elevationByGeometry[topology.geometryId];
    assert(elevation, 'Missing elevation import for topology: ' + topology.geometryId);
    validateElevation(elevation, topology, sourceManifest.sources);
    const byCorridor = Object.fromEntries(elevation.corridors.map(corridor => [corridor.corridorId, corridor]));
    topology.corridors.forEach(corridor => { corridor.elevation = byCorridor[corridor.id].positions; });
    topology.elevationSourceId = elevation.sourceId;
    topology.elevationAggregation = elevation.aggregation;
    topology.mountainStdDevM = elevation.mountainStdDevM;
  });
  // Planning links routed over real rail by scripts/world/route-planning-links.cjs. They are proposals: the compiler
  // refuses any that claim to be navigable, and a planning link only learns which route covers it, never loses its
  // own planning status.
  // Two sets can route the same pair of cities over different networks. The first set keeps the plain ID and the
  // rest are qualified by their set, so both stay inspectable and an authored corridor still names one exactly.
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
    // The proposal record never changes; the corridor that plays over it is noted beside it.
    const playable = railTopology.flatMap(topology => topology.corridors)
      .filter(corridor => (corridor.routedLinkIds || []).includes(route.id));
    assert(playable.length <= 1, 'Routed link is played by two corridors: ' + route.id);
    if (playable.length) route.playableCorridorId = playable[0].id;
    route.planningLinkIds.forEach(id => {
      assert(linksById[id], 'Routed link covers unknown planning link: ' + id);
      // A link can be routed by more than one set: the Chile network and the continental one both cover Chile.
      linksById[id].routedBy = (linksById[id].routedBy || []).concat(route.id);
    });
  });
  const bundle = {
    formatVersion: 1,
    datasetVersion: sourceManifest.datasetVersion,
    tileKm,
    sources: sourceManifest.sources,
    regions,
    corridors,
    railGeometry,
    railTopology,
    routedLinks,
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

function validateElevation(elevation, topology, sources) {
  assert(elevation.formatVersion === 1 && elevation.tileKm === tileKm, 'Invalid elevation header: ' + elevation.geometryId);
  assert(elevation.topologyBuildId === topology.buildId, 'Elevation is stale for topology: ' + elevation.geometryId);
  const source = sources.find(candidate => candidate.id === elevation.sourceId);
  assert(source && source.status === 'ingested', 'Elevation has no ingested source: ' + elevation.geometryId);
  assert(elevation.aggregation === 'mean-and-population-standard-deviation-within-geographic-tile',
    'Unexpected elevation aggregation: ' + elevation.geometryId);
  assert(Number.isFinite(elevation.mountainStdDevM) && elevation.mountainStdDevM > 0,
    'Invalid mountain ruggedness threshold: ' + elevation.geometryId);
  const corridors = Object.fromEntries(elevation.corridors.map(corridor => [corridor.corridorId, corridor]));
  topology.corridors.forEach(corridor => {
    const samples = corridors[corridor.id] && corridors[corridor.id].positions;
    assert(Array.isArray(samples) && samples.length === corridor.gridSliceCount + 1,
      'Elevation position count mismatch: ' + corridor.id);
    samples.forEach((sample, index) => {
      assert(sample.position === index && Array.isArray(sample.coordinate) && sample.coordinate.length === 2,
        'Invalid elevation position: ' + corridor.id + ':' + index);
      assert(Number.isFinite(sample.meanElevationM) && Number.isFinite(sample.elevationStdDevM) &&
        sample.elevationStdDevM >= 0 && Number.isInteger(sample.sampleCount) && sample.sampleCount > 0,
      'Invalid elevation statistics: ' + corridor.id + ':' + index);
    });
  });
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
  const topologyGeometryIds = new Set();
  bundle.railTopology.forEach(topology => {
    assert(!topologyGeometryIds.has(topology.geometryId), 'Duplicate rail topology: ' + topology.geometryId);
    topologyGeometryIds.add(topology.geometryId);
    assert(topology.formatVersion === 1 && topology.tileKm === bundle.tileKm, 'Invalid topology header: ' + topology.geometryId);
    topology.corridors.forEach(corridor => {
      assert(corridor.debugOnly === false && corridor.navigable === true,
		'Authored gameplay corridor is not navigable: ' + corridor.id);
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
          assert(slice.navigable === true && slice.reviewStatus === (topology.routed ? 'approved-routed-link'
            : 'authored-gameplay-route'), 'Unsafe topology slice: ' + slice.id);
          assert(slice.distanceKm > 0 && slice.distanceKm <= bundle.tileKm + 0.001, 'Invalid topology slice length: ' + slice.id);
          // A proposed gap fill has no OSM way under it, only the routed slices it was cut from.
          assert(slice.coordinates.length >= 2 && (slice.sourceWayIds.length > 0 ||
            (topology.routed && slice.gapFill && slice.routedSliceIds.length > 0)), 'Topology slice lacks provenance: ' + slice.id);
          assert(Array.isArray(slice.railwayStatuses) && slice.railwayStatuses.length > 0,
            'Topology slice lacks lifecycle provenance: ' + slice.id);
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
      assert(Array.isArray(corridor.gridSlices) && corridor.gridSlices.length === corridor.gridSliceCount,
        'Topology grid slice count mismatch: ' + corridor.id);
      corridor.gridSlices.forEach(slice => {
        assert(slice.distanceKm > 0 && slice.distanceKm <= bundle.tileKm + 0.001 &&
          Array.isArray(slice.railwayStatuses) && slice.railwayStatuses.length > 0,
        'Invalid gameplay grid slice: ' + slice.id);
      });
      assert(Math.abs(Math.round(corridorDistance * 10) / 10 - corridor.distanceKm) < 0.01,
        'Topology corridor distance mismatch: ' + corridor.id);
    });
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
  // A routed corridor runs to thousands of kilometres. The runtime only reads each grid slice's ends and flags, so the
  // browser gets those; the full slices and per-station legs stay in world/dist/topology.
  browserBundle.railTopology = bundle.railTopology.map(topology => !topology.routed ? topology : {
    ...topology,
    corridors: topology.corridors.map(corridor => ({
      ...corridor,
      legs: corridor.legs.map(leg => ({ id: leg.id, fromStationId: leg.fromStationId, toStationId: leg.toStationId,
        distanceKm: leg.distanceKm, sliceCount: leg.slices.length })),
      gridSlices: corridor.gridSlices.map(slice => ({ id: slice.id, distanceKm: slice.distanceKm, gapFill: slice.gapFill,
        coordinates: [slice.coordinates[0], slice.coordinates.at(-1)], bridge: slice.bridge, tunnel: slice.tunnel,
        service: slice.service, railwayStatuses: slice.railwayStatuses })),
      elevation: corridor.elevation.map(sample => ({ position: sample.position, coordinate: sample.coordinate,
        ...(sample.stationId ? { stationId: sample.stationId } : {}), meanElevationM: sample.meanElevationM,
        elevationStdDevM: sample.elevationStdDevM }))
    }))
  });
  manifest.railTopology = bundle.railTopology.map(topology => !topology.routed ? topology : ({ formatVersion: topology.formatVersion,
    geometryId: topology.geometryId, routed: true, buildId: topology.buildId,
    file: 'topology/' + topology.geometryId + '.json',
    corridors: topology.corridors.map(corridor => ({ id: corridor.id, label: corridor.label,
      stationCount: corridor.stations.length, distanceKm: corridor.distanceKm, gridSliceCount: corridor.gridSliceCount,
      routedLinkIds: corridor.routedLinkIds, railKm: corridor.railKm, gapKm: corridor.gapKm })) }));
  manifest.routedLinks = bundle.routedLinks.map(route => ({
    id: route.id, proposalSetId: route.proposalSetId, from: route.from, to: route.to,
    planningLinkIds: route.planningLinkIds, status: route.status, chordKm: route.chordKm, routedKm: route.routedKm,
    railKm: route.railKm, gapKm: route.gapKm, gapCount: route.gaps.length, sliceCount: route.sliceCount,
    stationCount: route.stations.length, navigable: route.navigable, reviewRequired: route.reviewRequired,
    ...(route.playableCorridorId ? { playableCorridorId: route.playableCorridorId } : {})
  }));
  browserBundle.routedLinks = bundle.routedLinks.map(route => ({
    id: route.id, proposalSetId: route.proposalSetId, from: route.from, to: route.to, status: route.status,
    ...(route.detour ? { detour: true } : {}), chordKm: route.chordKm,
    routedKm: route.routedKm, railKm: route.railKm, gapKm: route.gapKm, gapCount: route.gaps.length,
    sliceCount: route.sliceCount, navigable: route.navigable, reviewRequired: route.reviewRequired,
    ...(route.playableCorridorId ? { playableCorridorId: route.playableCorridorId } : {}),
    runs: runsOf(route.slices)
  }));
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
    ' playable sourced corridor(s), ' + bundle.routedLinks.length + ' routed planning link proposal(s)');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
