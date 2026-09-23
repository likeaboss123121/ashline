/* The playable world: every mapped railway of the continent on the shared geographic grid, compiled offline by
   scripts/world/build-network.cjs into setup.worldGraphData.network. Static geometry, elevation and provenance stay in
   setup; saves contain only a station and a journey position (a leg, a tile along it, and a direction). */
setup.realWorldPilot = (function () {
	'use strict';
	var NETWORK_ID = 'network';
	var MOUNTAIN_STD_DEV_M = 120;
	var cache = null;

	function hasNetwork() {
		return !!(setup.worldGraphData && setup.worldGraphData.network);
	}

	// The network as a corridor-shaped record: { id, label, navigable, stations }.
	function getCorridor() {
		var route = getGridRoute();
		return route ? route.corridor : null;
	}

	function terrainFor(slice, elevation, mountainStdDevM) {
		if (slice.tunnel) return 'tunnel';
		if (slice.bridge) return 'bridge';
		return elevation.elevationStdDevM >= mountainStdDevM ? 'mountain' : 'plains';
	}

	//
	// Every mapped railway of the continent on the shared grid (scripts/world/build-network.cjs). Its squares are the
	// tiles. Every junction and every end of the line is a stop, so the track between two stops is always one plain
	// line: a leg. A station can have any number of lines; each leaves from one side of the
	// yard, the side facing its way, so the yard keeps its two leads and a junction offers a choice of lines from one.
	function buildNetworkRoute() {
		var data = setup.worldGraphData.network, squares = data.squares, count = squares.x.length;
		var directions = setup.worldmap.DIRECTIONS, byKey = {}, tiles = new Array(count), kmByEnd = new Array(count);
		for (var index = 0; index < count; index++) {
			var ends = [], km = {}, used = 0;
			for (var bit = 0; bit < 8; bit++) {
				if (squares.ends[index] & (1 << bit)) { ends.push(bit); km[bit] = squares.km[index][used++]; }
			}
			var flags = squares.flags[index];
			tiles[index] = {
				x: squares.x[index], y: squares.y[index], ends: ends, shape: setup.worldmap.getShape(ends),
				terrain: terrainFor({ bridge: !!(flags & 2), tunnel: !!(flags & 4) }, { elevationStdDevM: squares.relief[index] },
					MOUNTAIN_STD_DEV_M),
				elevation: squares.elevation[index], elevationStdDevM: squares.relief[index], gapFill: !!(flags & 1),
				grade: 0, out: -1, distanceKm: 0, railwayStatuses: [], sourceSliceId: 'square:' + index,
				station: 0, stationId: null, stationIndex: 0,
				geoCoordinate: setup.worldmap.unprojectGrid(squares.x[index], squares.y[index], data.grid), globalPosition: index
			};
			kmByEnd[index] = km;
			byKey[setup.worldmap.key(tiles[index].x, tiles[index].y)] = index;
		}
		var neighbour = function(square, bit) {
			return byKey[setup.worldmap.key(tiles[square].x + directions[bit].dx, tiles[square].y + directions[bit].dy)];
		};
		var stopAtSquare = {};
		data.stops.square.forEach(function(square, stop) { stopAtSquare[square] = stop; });
		// The next stop along the line leaving a stop square by one of its ends.
		var nextStop = function(square, bit) {
			for (;;) {
				var next = neighbour(square, bit);
				if (stopAtSquare[next] !== undefined) return next;
				var back = setup.worldmap.opposite(bit);
				bit = tiles[next].ends.filter(function(end) { return end !== back; })[0];
				square = next;
			}
		};
		// Stations are numbered outward from where the game starts, a line at a time in compass order, so station 2
		// is the first stop up the line from station 1 and the numbers run along the lines the way a player meets them.
		var order = [data.start], queued = {};
		queued[data.start] = true;
		for (var head = 0; head < order.length; head++) {
			tiles[order[head]].ends.forEach(function(bit) {
				var reached = nextStop(order[head], bit);
				if (!queued[reached]) { queued[reached] = true; order.push(reached); }
			});
		}
		data.stops.square.forEach(function(square) { if (!queued[square]) { queued[square] = true; order.push(square); } });
		var stations = order.map(function(square) {
			var stop = stopAtSquare[square];
			return { id: 'stop:' + data.stops.square[stop], name: data.stops.name[stop], status: data.stops.status[stop],
				square: data.stops.square[stop], lines: [] };
		});
		var stationAt = {};
		stations.forEach(function(station, index) {
			stationAt[station.square] = index + 1;
			tiles[station.square].station = station.name;
			tiles[station.square].stationId = station.id;
			tiles[station.square].stationIndex = index + 1;
			tiles[station.square].stationStatus = station.status;
		});
		// Legs: from every station, out along each of its ends to the next station, each stretch once.
		var legs = {}, walked = {}, legCount = 0, place = new Array(count);
		var corridor = { id: NETWORK_ID, label: data.label, navigable: true, stations: stations };
		stations.forEach(function(station, stationOffset) {
			tiles[station.square].ends.forEach(function(firstBit) {
				if (walked[station.square + ':' + firstBit]) return;
				var path = [station.square], bits = [], current = station.square, bit = firstBit;
				for (;;) {
					var next = neighbour(current, bit);
					walked[current + ':' + bit] = true;
					walked[next + ':' + setup.worldmap.opposite(bit)] = true;
					bits.push(bit);
					path.push(next);
					if (stationAt[next]) break;
					var back = setup.worldmap.opposite(bit), onward = tiles[next].ends.filter(function(end) { return end !== back; });
					current = next;
					bit = onward[0];
				}
				var legIndex = ++legCount, fromIndex = stationOffset + 1, toIndex = stationAt[path[path.length - 1]];
				var legTiles = path.map(function(square, position) {
					var tile = Object.assign({}, tiles[square]);
					if (position < bits.length) {
						tile.out = bits[position];
						tile.distanceKm = kmByEnd[square][bits[position]];
						var grade = (tiles[path[position + 1]].elevation - tile.elevation) / (tile.distanceKm * 1000) * 100;
						tile.grade = Math.max(-setup.worldmap.GRADE_LIMIT, Math.min(setup.worldmap.GRADE_LIMIT,
							Math.round(grade / setup.worldmap.GRADE_STEP) * setup.worldmap.GRADE_STEP));
					} else {
						tile.out = -1; tile.distanceKm = 0; tile.grade = 0;
					}
					if (position > 0 && position < path.length - 1) place[square] = { legIndex: legIndex, tileIndex: position };
					return tile;
				});
				var leg = {
					index: legIndex, tiles: legTiles, byKey: {}, branches: [], realWorld: true, corridor: corridor, corridorId: NETWORK_ID,
					fromStation: stations[fromIndex - 1], toStation: stations[toIndex - 1], fromStationIndex: fromIndex, toStationIndex: toIndex,
					start: { x: legTiles[0].x, y: legTiles[0].y }, end: { x: legTiles[legTiles.length - 1].x, y: legTiles[legTiles.length - 1].y },
					rect: setup.worldmap.rectFor(legTiles)
				};
				legTiles.forEach(function(tile) { leg.byKey[setup.worldmap.key(tile.x, tile.y)] = tile; });
				legs[legIndex] = leg;
				stations[fromIndex - 1].lines.push({ legIndex: legIndex, forward: true, destination: toIndex, direction: bits[0] });
				stations[toIndex - 1].lines.push({ legIndex: legIndex, forward: false, destination: fromIndex,
					direction: setup.worldmap.opposite(bits[bits.length - 1]) });
			});
		});
		stations.forEach(assignSides);
		var tileByKey = {};
		Object.keys(byKey).forEach(function(key) { tileByKey[key] = tiles[byKey[key]]; });
		return { corridor: corridor, slices: [], tiles: tiles, legs: legs, byKey: tileByKey, network: true, place: place,
			stationPositions: stations.map(function(station) { return station.square; }), rect: setup.worldmap.rectFor(tiles) };
	}

	// Which side of the yard each line leaves from. The two lines that point most nearly opposite ways go out of
	// opposite ends of the yard, the first of them by compass order from the exit end; every other line leaves from
	// the end whose line it runs closer to. So a station on a plain line, however sharply the line bends there, has
	// one line out of each end, and a junction splits its lines between the two throats of the yard the way they face.
	function assignSides(station) {
		var lines = station.lines;
		lines.sort(function(a, b) { return a.direction - b.direction || a.legIndex - b.legIndex; });
		if (!lines.length) return;
		var exitLine = lines[0], entryLine = null, widest = -1;
		lines.forEach(function(first, i) {
			lines.forEach(function(second, j) {
				if (j <= i) return;
				var turn = setup.worldmap.turnBetween(first.direction, second.direction);
				if (turn > widest) { widest = turn; exitLine = first; entryLine = second; }
			});
		});
		lines.forEach(function(line) {
			if (line === exitLine) line.side = 'exit';
			else if (line === entryLine) line.side = 'entry';
			else line.side = setup.worldmap.turnBetween(exitLine.direction, line.direction)
				<= setup.worldmap.turnBetween(entryLine.direction, line.direction) ? 'exit' : 'entry';
		});
	}

	// The lines leaving a station: { legIndex, side ('entry' or 'exit'), forward (the journey's direction along the
	// leg), destination (the station at the far end), direction (the heading out of the station) }.
	function getStationLines(stationIndex) {
		var route = getGridRoute(), id = Math.floor(Number(stationIndex));
		if (!route || !getStation(id)) return [];
		return route.corridor.stations[id - 1].lines.slice();
	}

	// The side of a station a leg arrives on.
	function getArrivalSide(legIndex, stationIndex) {
		var lines = getStationLines(stationIndex).filter(function(line) { return line.legIndex === Math.floor(Number(legIndex)); });
		return lines.length ? lines[0].side : null;
	}

	// Tiles, stations and legs, built the first time they are asked for and kept.
	function getGridRoute() {
		if (!cache && hasNetwork()) cache = buildNetworkRoute();
		return cache;
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

	function getJourneyRoute(position) {
		var journey = position || (State.variables && State.variables.journey);
		if (!journey) return null;
		var leg = getLeg(journey.legIndex);
		return leg ? { corridor: leg.corridor, tiles: leg.tiles, leg: leg } : null;
	}

	// Puts the active consist on the first line out of station 1, as debug travel does.
	function start() {
		var firstLine = getStationLines(1)[0];
		if (!firstLine || !State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey ||
			State.variables.onFoot) return false;
		State.variables.currentStation = 1;
		State.variables.travellingForward = true;
		State.variables.journey = { legIndex: firstLine.legIndex, tileIndex: firstLine.forward ? 0 : getLeg(firstLine.legIndex).tiles.length - 1,
			forward: firstLine.forward };
		return true;
	}

	function finish() {
		if (!getJourneyRoute()) return false;
		State.variables.journey = null;
		State.variables.onFoot = null;
		return true;
	}

	function endpointForView() { return null; }

	function debugTarget(x, y) {
		var route = getGridRoute();
		if (!route) return null;
		var tile = route.byKey[setup.worldmap.key(Number(x), Number(y))];
		if (!tile) return null;
		if (tile.stationIndex) {
			// A station square: the end of the leg that arrives there, else the start of one leaving.
			var lines = getStationLines(tile.stationIndex);
			var line = lines.filter(function(candidate) { return !candidate.forward; })[0] || lines[0], leg = getLeg(line.legIndex);
			return { legIndex: line.legIndex, tileIndex: line.forward ? 0 : leg.tiles.length - 1, branch: null, tile: tile };
		}
		var place = route.place[tile.globalPosition];
		return place ? { legIndex: place.legIndex, tileIndex: place.tileIndex, branch: null, tile: tile } : null;
	}

	function appendDebugControls(parent) {
		var route = getGridRoute();
		if (!route) return;
		var note = document.createElement('p');
		note.className = 'small-description';
		note.textContent = route.corridor.label + ' is the active gameplay world: ' + route.tiles.length + ' grid squares, '
			+ Object.keys(route.legs).length + ' legs and ' + route.corridor.stations.length + ' stations.';
		parent.appendChild(note);
	}

	return {
		NETWORK_ID: NETWORK_ID, DEFAULT_CORRIDOR_ID: NETWORK_ID, hasNetwork: hasNetwork,
		getCorridor: getCorridor, getGridRoute: getGridRoute, getTileAt: getTileAt,
		getLeg: getLeg, getStation: getStation, getStationTile: getStationTile,
		getStationLines: getStationLines, getArrivalSide: getArrivalSide,
		getJourneyRoute: getJourneyRoute, start: start, finish: finish,
		endpointForView: endpointForView, terrainFor: terrainFor, debugTarget: debugTarget,
		appendDebugControls: appendDebugControls
	};
}());
