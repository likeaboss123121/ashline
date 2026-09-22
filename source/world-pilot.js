/* Runtime adapter for authored routes compiled from real railway geometry. This is the playable world: static
   geometry, elevation and provenance stay in setup, while saves contain only a station and journey position. */
setup.realWorldPilot = (function () {
	'use strict';
	var DEFAULT_CORRIDOR_ID = 'cl-main-line';
	var gridCache = {};

	function allCorridors() {
		var sets = setup.worldGraph.getData().railTopology || [], result = [];
		sets.forEach(function(topology) {
			topology.corridors.forEach(function(corridor) { result.push({ corridor: corridor, topology: topology }); });
		});
		return result;
	}

	function getRecord(id) {
		var corridors = allCorridors();
		for (var index = 0; index < corridors.length; index++) {
			if (corridors[index].corridor.id === id) return corridors[index];
		}
		return null;
	}

	function getCorridor(id) {
		var record = getRecord(id || DEFAULT_CORRIDOR_ID);
		return record ? record.corridor : null;
	}

	function directionFor(coordinates) {
		var from = coordinates[0], to = coordinates[coordinates.length - 1];
		var longitude = (to[0] - from[0]) * Math.cos((from[1] + to[1]) / 2 * Math.PI / 180);
		var latitude = to[1] - from[1];
		return (Math.round(Math.atan2(longitude, latitude) / (Math.PI / 4)) + 8) % 8;
	}

	function terrainFor(slice, elevation, mountainStdDevM) {
		if (slice.tunnel) return 'tunnel';
		if (slice.bridge) return 'bridge';
		return elevation.elevationStdDevM >= mountainStdDevM ? 'mountain' : 'plains';
	}

	function mergeFinalRemainder(slices) {
		var result = slices.map(function(slice) {
			return {
				id: slice.id, distanceKm: setup.worldmap.TILE_KM, actualDistanceKm: slice.distanceKm,
				coordinates: slice.coordinates.slice(), sourceWayIds: (slice.sourceWayIds || []).slice(),
				bridge: slice.bridge, tunnel: slice.tunnel, service: slice.service, gapFill: slice.gapFill === true,
				railwayStatuses: slice.railwayStatuses.slice()
			};
		});
		if (result.length > 1 && result[result.length - 1].actualDistanceKm < setup.worldmap.TILE_KM) {
			var remainder = result.pop(), last = result[result.length - 1];
			last.actualDistanceKm += remainder.actualDistanceKm;
			last.coordinates = last.coordinates.concat(remainder.coordinates.slice(1));
			last.sourceWayIds = Array.from(new Set(last.sourceWayIds.concat(remainder.sourceWayIds))).sort();
			last.railwayStatuses = Array.from(new Set(last.railwayStatuses.concat(remainder.railwayStatuses))).sort();
			last.bridge = last.bridge || remainder.bridge;
			last.tunnel = last.tunnel || remainder.tunnel;
			last.service = last.service && remainder.service;
		}
		return result;
	}

	function stationPositions(corridor, slices) {
		var boundaries = [0], actual = 0;
		slices.forEach(function(slice) { actual += slice.actualDistanceKm; boundaries.push(actual); });
		var positions = [], stationDistance = 0;
		corridor.stations.forEach(function(station, stationIndex) {
			if (stationIndex) stationDistance += corridor.legs[stationIndex - 1].distanceKm;
			var best = 0;
			for (var index = 1; index < boundaries.length; index++) {
				if (Math.abs(boundaries[index] - stationDistance) < Math.abs(boundaries[best] - stationDistance)) best = index;
			}
			if (positions.length && best <= positions[positions.length - 1]) best = positions[positions.length - 1] + 1;
			positions.push(Math.min(best, slices.length));
		});
		positions[0] = 0;
		positions[positions.length - 1] = slices.length;
		return positions;
	}

	function getGridRoute(corridorId) {
		corridorId = corridorId || DEFAULT_CORRIDOR_ID;
		if (gridCache[corridorId]) return gridCache[corridorId];
		var record = getRecord(corridorId);
		if (!record) return null;
		var corridor = record.corridor, rawSlices = corridor.gridSlices || [], rawElevations = corridor.elevation || [];
		if (rawElevations.length !== rawSlices.length + 1) return null;
		var slices = mergeFinalRemainder(rawSlices);
		var elevations = rawElevations.slice(0, slices.length);
		elevations.push(rawElevations[rawElevations.length - 1]);
		var positions = stationPositions(corridor, slices), stationByPosition = {};
		positions.forEach(function(position, index) { stationByPosition[position] = corridor.stations[index]; });
		var directions = slices.map(function(slice) { return directionFor(slice.coordinates); });
		var x = 0, y = 0, tiles = [];
		for (var index = 0; index <= slices.length; index++) {
			var incoming = index ? setup.worldmap.opposite(directions[index - 1]) : null;
			var outgoing = index < slices.length ? directions[index] : null;
			var ends = [];
			if (incoming !== null) ends.push(incoming);
			if (outgoing !== null && ends.indexOf(outgoing) === -1) ends.push(outgoing);
			ends.sort(function(a, b) { return a - b; });
			var adjacentSlice = slices[index] || slices[index - 1], elevation = elevations[index];
			var terrain = terrainFor(adjacentSlice, elevation, record.topology.mountainStdDevM);
			var grade = 0;
			if (index < slices.length) {
				grade = (elevations[index + 1].meanElevationM - elevation.meanElevationM)
					/ (setup.worldmap.TILE_KM * 1000) * 100;
				grade = Math.max(-setup.worldmap.GRADE_LIMIT, Math.min(setup.worldmap.GRADE_LIMIT,
					Math.round(grade / setup.worldmap.GRADE_STEP) * setup.worldmap.GRADE_STEP));
			}
			var station = stationByPosition[index] || null;
			tiles.push({
				x: x, y: y, ends: ends, shape: setup.worldmap.getShape(ends), terrain: terrain,
				elevation: elevation.meanElevationM, elevationStdDevM: elevation.elevationStdDevM,
				grade: grade, out: outgoing === null ? -1 : outgoing,
				distanceKm: index < slices.length ? setup.worldmap.TILE_KM : 0,
				railwayStatuses: adjacentSlice.railwayStatuses.slice(), sourceSliceId: adjacentSlice.id,
				gapFill: adjacentSlice.gapFill === true,
				station: station ? station.name : 0, stationId: station ? station.id : null,
				stationIndex: station ? corridor.stations.indexOf(station) + 1 : 0,
				geoCoordinate: elevation.coordinate, globalPosition: index
			});
			if (outgoing !== null) {
				x += setup.worldmap.DIRECTIONS[outgoing].dx;
				y += setup.worldmap.DIRECTIONS[outgoing].dy;
			}
		}
		var legs = {};
		for (var stationIndex = 0; stationIndex < corridor.stations.length - 1; stationIndex++) {
			var startPosition = positions[stationIndex], endPosition = positions[stationIndex + 1];
			var legTiles = tiles.slice(startPosition, endPosition + 1);
			legs[stationIndex + 1] = {
				index: stationIndex + 1, tiles: legTiles, byKey: {}, branches: [], realWorld: true,
				corridor: corridor, corridorId: corridor.id,
				fromStation: corridor.stations[stationIndex], toStation: corridor.stations[stationIndex + 1],
				start: { x: legTiles[0].x, y: legTiles[0].y },
				end: { x: legTiles[legTiles.length - 1].x, y: legTiles[legTiles.length - 1].y },
				rect: setup.worldmap.rectFor(legTiles), startPosition: startPosition, endPosition: endPosition
			};
			legTiles.forEach(function(tile) { legs[stationIndex + 1].byKey[setup.worldmap.key(tile.x, tile.y)] = tile; });
		}
		// The walk can cross itself where the real line doubles back; the first tile to claim a square keeps it.
		var byKey = {};
		tiles.forEach(function(tile) {
			var tileKey = setup.worldmap.key(tile.x, tile.y);
			if (!byKey[tileKey]) byKey[tileKey] = tile;
		});
		gridCache[corridorId] = { corridor: corridor, slices: slices, tiles: tiles, legs: legs, byKey: byKey,
			stationPositions: positions, rect: setup.worldmap.rectFor(tiles) };
		return gridCache[corridorId];
	}

	function getTileAt(x, y) {
		var route = getGridRoute();
		return route ? route.byKey[setup.worldmap.key(Number(x), Number(y))] || null : null;
	}

	function getLeg(legIndex) {
		var route = getGridRoute();
		return route && route.legs[Math.floor(Number(legIndex))] || null;
	}

	function getStation(stationIndex) {
		var corridor = getCorridor();
		var index = Math.floor(Number(stationIndex)) - 1;
		return corridor && index >= 0 && index < corridor.stations.length ? corridor.stations[index] : null;
	}

	function getStationTile(stationIndex) {
		var route = getGridRoute(), station = getStation(stationIndex);
		if (!route || !station) return null;
		return route.tiles[route.stationPositions[Math.floor(Number(stationIndex)) - 1]];
	}

	function headingName(direction) {
		return { n: 'north', ne: 'northeast', e: 'east', se: 'southeast', s: 'south', sw: 'southwest', w: 'west', nw: 'northwest' }[
			setup.worldmap.DIRECTIONS[direction].name];
	}

	function getLegHeading(legIndex) {
		var route = getGridRoute(), numeric = Math.floor(Number(legIndex));
		if (numeric < 1) numeric = 1;
		if (route && numeric >= route.corridor.stations.length) numeric = route.corridor.stations.length - 1;
		var leg = getLeg(numeric);
		return leg && leg.tiles.length > 1 ? headingName(leg.tiles[0].out) : null;
	}

	function getJourneyRoute(position) {
		var journey = position || (State.variables && State.variables.journey);
		if (!journey) return null;
		var leg = getLeg(journey.legIndex);
		return leg ? { corridor: leg.corridor, tiles: leg.tiles, leg: leg } : null;
	}

	function start(corridorId) {
		var corridor = getCorridor(corridorId);
		if (!corridor || !corridor.navigable || !State.variables.currentTrain || !State.variables.currentTrain.length ||
			State.variables.journey || State.variables.onFoot) return false;
		State.variables.currentStation = 1;
		State.variables.travellingForward = true;
		State.variables.journey = { legIndex: 1, tileIndex: 0, forward: true };
		return true;
	}

	function finish() {
		if (!getJourneyRoute()) return false;
		State.variables.journey = null;
		State.variables.onFoot = null;
		return true;
	}

	function resumeLegacy() {
		var legacy = State.variables.realWorldJourney;
		if (!legacy || !getGridRoute(legacy.corridorId)) return false;
		var route = getGridRoute(legacy.corridorId), position = Math.max(0, Number(legacy.position) || 0), legIndex = 1;
		while (route.legs[legIndex] && position > route.legs[legIndex].endPosition) legIndex++;
		if (!route.legs[legIndex]) legIndex--;
		var leg = route.legs[legIndex];
		State.variables.journey = { legIndex: leg.index,
			tileIndex: Math.max(0, Math.min(position - leg.startPosition, leg.tiles.length - 1)), forward: true };
		State.variables.realWorldJourney = null;
		return true;
	}

	function endpointForView() { return null; }

	function debugTarget(x, y) {
		var route = getGridRoute();
		if (!route) return null;
		for (var position = 0; position < route.tiles.length; position++) {
			var tile = route.tiles[position];
			if (tile.x !== Number(x) || tile.y !== Number(y)) continue;
			var legIndex = 1;
			while (route.legs[legIndex] && position > route.legs[legIndex].endPosition) legIndex++;
			if (!route.legs[legIndex]) legIndex--;
			var leg = route.legs[legIndex];
			return { legIndex: legIndex, tileIndex: position - leg.startPosition, branch: null, tile: tile };
		}
		return null;
	}

	function appendDebugControls(parent) {
		var route = getGridRoute();
		if (!route) return;
		var note = document.createElement('p');
		note.className = 'small-description';
		note.textContent = route.corridor.label + ' is the active gameplay world: ' + route.tiles.length
			+ ' grid positions, ' + route.slices.length + ' fixed 5 km moves and ' + route.corridor.stations.length + ' stations.';
		parent.appendChild(note);
	}

	return {
		DEFAULT_CORRIDOR_ID: DEFAULT_CORRIDOR_ID, getCorridor: getCorridor, getGridRoute: getGridRoute, getTileAt: getTileAt,
		getLeg: getLeg, getStation: getStation, getStationTile: getStationTile, getLegHeading: getLegHeading,
		getJourneyRoute: getJourneyRoute, start: start, finish: finish, resumeLegacy: resumeLegacy,
		endpointForView: endpointForView, terrainFor: terrainFor, debugTarget: debugTarget,
		appendDebugControls: appendDebugControls
	};
}());
