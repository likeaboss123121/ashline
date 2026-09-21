/* Debug entry point and grid adapter for authored routes compiled from real railway geometry. Static route,
   elevation and provenance data stay in setup; saves contain only the corridor ID and ordinary journey position. */
setup.realWorldPilot = (function () {
	'use strict';
	var gridCache = {};

	function allCorridors() {
		var sets = setup.worldGraph.getData().railTopology || [], result = [];
		sets.forEach(function (topology) {
			topology.corridors.forEach(function (corridor) { result.push({ corridor: corridor, topology: topology }); });
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
		var record = getRecord(id);
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

	function getGridRoute(corridorId) {
		if (gridCache[corridorId]) return gridCache[corridorId];
		var record = getRecord(corridorId);
		if (!record) return null;
		var corridor = record.corridor, slices = corridor.gridSlices || [], elevations = corridor.elevation || [];
		if (elevations.length !== slices.length + 1) return null;
		var directions = slices.map(function (slice) { return directionFor(slice.coordinates); });
		var x = 0, y = 0, tiles = [], stationByPosition = {};
		stationByPosition[0] = corridor.stations[0];
		stationByPosition[slices.length] = corridor.stations[corridor.stations.length - 1];
		for (var index = 0; index <= slices.length; index++) {
			var incoming = index ? setup.worldmap.opposite(directions[index - 1]) : null;
			var outgoing = index < slices.length ? directions[index] : null;
			var ends = [];
			if (incoming !== null) ends.push(incoming);
			if (outgoing !== null && ends.indexOf(outgoing) === -1) ends.push(outgoing);
			ends.sort(function (a, b) { return a - b; });
			var adjacentSlice = slices[index] || slices[index - 1], elevation = elevations[index];
			var terrain = terrainFor(adjacentSlice, elevation, record.topology.mountainStdDevM);
			var grade = 0;
			if (index < slices.length) {
				var distanceMetres = Math.max(1, slices[index].distanceKm * 1000);
				grade = (elevations[index + 1].meanElevationM - elevation.meanElevationM) / distanceMetres * 100;
				grade = Math.max(-setup.worldmap.GRADE_LIMIT, Math.min(setup.worldmap.GRADE_LIMIT,
					Math.round(grade / setup.worldmap.GRADE_STEP) * setup.worldmap.GRADE_STEP));
			}
			tiles.push({
				x: x, y: y, ends: ends, shape: setup.worldmap.getShape(ends), terrain: terrain,
				elevation: elevation.meanElevationM, elevationStdDevM: elevation.elevationStdDevM,
				grade: grade, out: outgoing === null ? -1 : outgoing,
				distanceKm: index < slices.length ? slices[index].distanceKm : 0,
				railwayStatuses: adjacentSlice.railwayStatuses.slice(), sourceSliceId: adjacentSlice.id,
				station: stationByPosition[index] ? stationByPosition[index].name : 0,
				stationId: stationByPosition[index] ? stationByPosition[index].id : null,
				geoCoordinate: elevation.coordinate
			});
			if (outgoing !== null) {
				x += setup.worldmap.DIRECTIONS[outgoing].dx;
				y += setup.worldmap.DIRECTIONS[outgoing].dy;
			}
		}
		var leg = { index: corridor.id, tiles: tiles, branches: [], realWorld: true, corridor: corridor,
			start: { x: tiles[0].x, y: tiles[0].y }, end: { x: tiles[tiles.length - 1].x, y: tiles[tiles.length - 1].y },
			rect: setup.worldmap.rectFor(tiles) };
		gridCache[corridorId] = { corridor: corridor, slices: slices, tiles: tiles, leg: leg };
		return gridCache[corridorId];
	}

	function getJourneyRoute(position) {
		var journey = position || (State.variables && State.variables.journey);
		return journey && journey.realWorldCorridorId ? getGridRoute(journey.realWorldCorridorId) : null;
	}

	function start(corridorId) {
		var corridor = getCorridor(corridorId);
		if (!State.variables.debugMode || !corridor || !corridor.debugOnly || !corridor.navigable ||
			!State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey || State.variables.onFoot ||
			!getGridRoute(corridorId)) return false;
		State.variables.travellingForward = true;
		State.variables.journey = { legIndex: 0, tileIndex: 0, forward: true, realWorldCorridorId: corridor.id };
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
		State.variables.journey = { legIndex: 0, tileIndex: Math.max(0, Number(legacy.position) || 0),
			forward: true, realWorldCorridorId: legacy.corridorId };
		State.variables.realWorldJourney = null;
		return true;
	}

	function endpointForView(view) {
		if (!view || !view.realWorld || (view.tileIndex !== 0 && view.tileIndex !== view.tileCount - 1)) return null;
		return { name: view.tile.station, start: view.tileIndex === 0 };
	}

	function appendDebugControls(parent) {
		var corridors = allCorridors().map(function (record) { return record.corridor; })
			.filter(function (corridor) { return corridor.debugOnly && corridor.navigable; });
		if (!corridors.length) return;
		var heading = document.createElement('h4'); heading.textContent = 'Playable OSM route'; parent.appendChild(heading);
		var description = document.createElement('p');
		description.textContent = 'Load a sourced railway into the normal 5 km grid, On the line passage, driving view, and fuel/time systems.';
		parent.appendChild(description);
		corridors.forEach(function (corridor) {
			var button = document.createElement('button');
			button.textContent = 'Drive ' + corridor.label + ' (' + corridor.distanceKm.toFixed(1) + ' km)';
			button.disabled = !State.variables.currentTrain || !State.variables.currentTrain.length ||
				!!State.variables.journey || !!State.variables.onFoot;
			button.title = button.disabled ? 'Board a train in a railyard before starting the route.' : '';
			button.addEventListener('click', function () {
				if (!start(corridor.id)) return;
				setup.sideTabs.active = null;
				setup.sideTabs.refresh();
				Engine.play('OnTheLine');
			});
			parent.appendChild(button);
		});
		if (!State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey || State.variables.onFoot) {
			var note = document.createElement('p'); note.className = 'small-description';
			note.textContent = 'Board a train in a railyard first; the entire active consist will enter the route.'; parent.appendChild(note);
		}
	}

	return { getCorridor: getCorridor, getGridRoute: getGridRoute, getJourneyRoute: getJourneyRoute,
		start: start, finish: finish, resumeLegacy: resumeLegacy, endpointForView: endpointForView, terrainFor: terrainFor,
		appendDebugControls: appendDebugControls };
}());
