/* Runtime adapter for authored routes compiled from real railway geometry. This is the playable world: static
   geometry, elevation and provenance stay in setup, while saves contain only a station and journey position. */
setup.realWorldPilot = (function () {
	'use strict';
	var CORRIDOR_ID = 'cl-main-line';
	// The continental network, when one is compiled in, is the world; the corridor is the world without it.
	var NETWORK_ID = 'network';
	var MOUNTAIN_STD_DEV_M = 120;
	var gridCache = {};

	function hasNetwork() {
		return !!(setup.worldGraphData && setup.worldGraphData.network);
	}

	function defaultId() {
		return hasNetwork() ? NETWORK_ID : CORRIDOR_ID;
	}

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
		if ((id || defaultId()) === NETWORK_ID) {
			var route = getGridRoute(NETWORK_ID);
			return route ? route.corridor : null;
		}
		var record = getRecord(id || CORRIDOR_ID);
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

	// The direction of the step from one grid square to its neighbour.
	function directionBetween(from, to) {
		var dx = to.x - from.x, dy = to.y - from.y;
		for (var index = 0; index < setup.worldmap.DIRECTIONS.length; index++) {
			if (setup.worldmap.DIRECTIONS[index].dx === dx && setup.worldmap.DIRECTIONS[index].dy === dy) return index;
		}
		throw new Error('Grid squares ' + from.x + ',' + from.y + ' and ' + to.x + ',' + to.y + ' do not touch.');
	}

	// A corridor laid on the shared geographic grid: its squares are the tiles, where they really are, and each move
	// costs the track it covers rather than a fixed 5 km.
	function buildCellRoute(record) {
		var corridor = record.corridor, cells = corridor.gridCells, elevations = corridor.elevation || [];
		if (elevations.length !== cells.length) return null;
		var tiles = cells.map(function(cell, index) {
			var incoming = index ? setup.worldmap.opposite(directionBetween(cells[index - 1], cell)) : null;
			var outgoing = index < cells.length - 1 ? directionBetween(cell, cells[index + 1]) : null;
			var ends = [];
			if (incoming !== null) ends.push(incoming);
			if (outgoing !== null && ends.indexOf(outgoing) === -1) ends.push(outgoing);
			ends.sort(function(a, b) { return a - b; });
			var elevation = elevations[index], grade = 0;
			if (outgoing !== null) {
				grade = (elevations[index + 1].meanElevationM - elevation.meanElevationM) / (cell.stepKm * 1000) * 100;
				grade = Math.max(-setup.worldmap.GRADE_LIMIT, Math.min(setup.worldmap.GRADE_LIMIT,
					Math.round(grade / setup.worldmap.GRADE_STEP) * setup.worldmap.GRADE_STEP));
			}
			return {
				x: cell.x, y: cell.y, ends: ends, shape: setup.worldmap.getShape(ends),
				terrain: terrainFor(cell, elevation, record.topology.mountainStdDevM),
				elevation: elevation.meanElevationM, elevationStdDevM: elevation.elevationStdDevM,
				grade: grade, out: outgoing === null ? -1 : outgoing, distanceKm: cell.stepKm,
				railwayStatuses: cell.railwayStatuses.slice(), sourceSliceId: cell.id, gapFill: cell.gapFill === true,
				station: 0, stationId: null, stationIndex: 0, geoCoordinate: cell.centre, globalPosition: index
			};
		});
		corridor.stationPositions.forEach(function(position, index) {
			tiles[position].station = corridor.stations[index].name;
			tiles[position].stationId = corridor.stations[index].id;
			tiles[position].stationIndex = index + 1;
		});
		return { tiles: tiles, positions: corridor.stationPositions.slice(), slices: cells };
	}

	// --- the network ------------------------------------------------------------------------------------------------
	//
	// Every mapped railway of the continent on the shared grid (scripts/world/build-network.cjs). Its squares are the
	// tiles. Every junction and every end of the line is a stop, so the track between two stops is always one plain
	// line: a leg, exactly as on a corridor. A station can have any number of lines; each leaves from one side of the
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
	// leg), destination (the station at the far end), direction (the heading out of the station) }. On a corridor
	// the entry line runs back to the station before and the exit line on to the one after.
	function getStationLines(stationIndex) {
		var route = getGridRoute(), id = Math.floor(Number(stationIndex));
		if (!route || !getStation(id)) return [];
		if (route.network) return route.corridor.stations[id - 1].lines.slice();
		var lines = [];
		if (route.legs[id - 1]) lines.push({ legIndex: id - 1, side: 'entry', forward: false, destination: id - 1,
			direction: setup.worldmap.opposite(route.legs[id - 1].tiles[route.legs[id - 1].tiles.length - 2].out) });
		if (route.legs[id]) lines.push({ legIndex: id, side: 'exit', forward: true, destination: id + 1, direction: route.legs[id].tiles[0].out });
		return lines;
	}

	// The side of a station a leg arrives on.
	function getArrivalSide(legIndex, stationIndex) {
		var lines = getStationLines(stationIndex).filter(function(line) { return line.legIndex === Math.floor(Number(legIndex)); });
		return lines.length ? lines[0].side : null;
	}

	function getGridRoute(corridorId) {
		corridorId = corridorId || defaultId();
		if (gridCache[corridorId]) return gridCache[corridorId];
		if (corridorId === NETWORK_ID) return hasNetwork() ? (gridCache[corridorId] = buildNetworkRoute()) : null;
		var record = getRecord(corridorId);
		if (!record) return null;
		if (record.corridor.gridCells) {
			var built = buildCellRoute(record);
			if (!built) return null;
			return (gridCache[corridorId] = finishRoute(record.corridor, built.tiles, built.positions, built.slices));
		}
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
		return (gridCache[corridorId] = finishRoute(corridor, tiles, positions, slices));
	}

	// Legs between stations, and the lookup from a square to its tile, for either kind of corridor.
	function finishRoute(corridor, tiles, positions, slices) {
		var legs = {};
		for (var stationIndex = 0; stationIndex < corridor.stations.length - 1; stationIndex++) {
			var startPosition = positions[stationIndex], endPosition = positions[stationIndex + 1];
			var legTiles = tiles.slice(startPosition, endPosition + 1);
			legs[stationIndex + 1] = {
				index: stationIndex + 1, tiles: legTiles, byKey: {}, branches: [], realWorld: true,
				corridor: corridor, corridorId: corridor.id,
				fromStation: corridor.stations[stationIndex], toStation: corridor.stations[stationIndex + 1],
				fromStationIndex: stationIndex + 1, toStationIndex: stationIndex + 2,
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
		return { corridor: corridor, slices: slices, tiles: tiles, legs: legs, byKey: byKey,
			stationPositions: positions, rect: setup.worldmap.rectFor(tiles) };
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
		if (!corridorId && hasNetwork()) {
			var firstLine = getStationLines(1)[0];
			if (!firstLine || !State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey ||
				State.variables.onFoot) return false;
			State.variables.currentStation = 1;
			State.variables.travellingForward = true;
			State.variables.journey = { legIndex: firstLine.legIndex, tileIndex: firstLine.forward ? 0 : getLeg(firstLine.legIndex).tiles.length - 1,
				forward: firstLine.forward };
			return true;
		}
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
		if (route.network) {
			var tile = route.byKey[setup.worldmap.key(Number(x), Number(y))];
			if (!tile) return null;
			if (tile.stationIndex) {
				// A station square: the end of the leg that arrives there, as on a corridor, else the start of one leaving.
				var lines = getStationLines(tile.stationIndex);
				var line = lines.filter(function(candidate) { return !candidate.forward; })[0] || lines[0], leg = getLeg(line.legIndex);
				return { legIndex: line.legIndex, tileIndex: line.forward ? 0 : leg.tiles.length - 1, branch: null, tile: tile };
			}
			var place = route.place[tile.globalPosition];
			return place ? { legIndex: place.legIndex, tileIndex: place.tileIndex, branch: null, tile: tile } : null;
		}
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
		note.textContent = route.corridor.label + ' is the active gameplay world: ' + route.tiles.length + ' grid squares, '
			+ Object.keys(route.legs).length + ' legs and ' + route.corridor.stations.length + ' stations.';
		parent.appendChild(note);
	}

	var api = {
		CORRIDOR_ID: CORRIDOR_ID, NETWORK_ID: NETWORK_ID, hasNetwork: hasNetwork,
		getCorridor: getCorridor, getGridRoute: getGridRoute, getTileAt: getTileAt,
		getLeg: getLeg, getStation: getStation, getStationTile: getStationTile, getLegHeading: getLegHeading,
		getStationLines: getStationLines, getArrivalSide: getArrivalSide,
		getJourneyRoute: getJourneyRoute, start: start, finish: finish, resumeLegacy: resumeLegacy,
		endpointForView: endpointForView, terrainFor: terrainFor, debugTarget: debugTarget,
		appendDebugControls: appendDebugControls
	};
	// The world in play: the network when one is compiled in, else the Chilean corridor.
	Object.defineProperty(api, 'DEFAULT_CORRIDOR_ID', { enumerable: true, get: defaultId });
	return api;
}());
