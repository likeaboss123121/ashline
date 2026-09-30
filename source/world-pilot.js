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
	// tiles. A station has at most two lines, one out of each end of its yard. Where three or more lines meet there is a
	// junction out on the line, and the driver picks a way there (getJunctionChoices); where a line ends without a
	// station there is a buffer. The track between two of these nodes is one plain line: a leg.
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
				geoCoordinate: setup.worldmap.unprojectGrid(squares.x[index], squares.y[index], setup.worldmap.gridFor(index)), globalPosition: index
			};
			tiles[index].terrain = setup.locales.terrain(tiles[index]);
			kmByEnd[index] = km;
			byKey[setup.worldmap.key(tiles[index].x, tiles[index].y)] = index;
		}
		var neighbour = function(square, bit) {
			return byKey[setup.worldmap.key(tiles[square].x + directions[bit].dx, tiles[square].y + directions[bit].dy)];
		};
		var stopAtSquare = {};
		data.stops.square.forEach(function(square, stop) { stopAtSquare[square] = stop; });
		var pointAtSquare = {};
		if (data.points) data.points.square.forEach(function(square, point) { pointAtSquare[square] = point; });
		// The nodes of the network: stations, and out on the line the junctions where a driver picks a way and the
		// buffers where a line ends without a yard. The track between two nodes is one plain line: a leg.
		var isNode = function(square) { return stopAtSquare[square] !== undefined || tiles[square].ends.length !== 2; };
		// The next node along the line leaving a node square by one of its ends.
		var nextNode = function(square, bit) {
			for (;;) {
				var next = neighbour(square, bit);
				if (isNode(next)) return next;
				var back = setup.worldmap.opposite(bit);
				bit = tiles[next].ends.filter(function(end) { return end !== back; })[0];
				square = next;
			}
		};
		// Stations are numbered outward from where the game starts, a line at a time in compass order, so station 2
		// is the first station up the line from station 1 and the numbers run along the lines the way a player meets
		// them. Junctions and buffers on the way are passed through, not numbered.
		var order = [data.start], queued = {};
		queued[data.start] = true;
		for (var head = 0; head < order.length; head++) {
			tiles[order[head]].ends.forEach(function(bit) {
				var reached = nextNode(order[head], bit);
				if (!queued[reached]) { queued[reached] = true; order.push(reached); }
			});
		}
		data.stops.square.forEach(function(square) { if (!queued[square]) { queued[square] = true; order.push(square); } });
		var stations = order.filter(function(square) { return stopAtSquare[square] !== undefined; }).map(function(square) {
			var stop = stopAtSquare[square];
			return { id: data.stops.id ? data.stops.id[stop] : 'stop:' + data.stops.square[stop], uuid: data.stops.uuid && data.stops.uuid[stop], name: data.stops.name[stop], status: data.stops.status[stop],
				region: data.stops.region ? data.stops.region[stop] : 'rural', square: data.stops.square[stop], lines: [] };
		});
		var stationAt = {};
		stations.forEach(function(station, index) {
			stationAt[station.square] = index + 1;
			tiles[station.square].station = station.name;
			tiles[station.square].stationId = station.id;
			tiles[station.square].stationIndex = index + 1;
			tiles[station.square].stationStatus = station.status;
			tiles[station.square].stationRegion = station.region;
		});
		// What stands at a node, for a leg's ends: a station, or a junction or buffer with the name of the nearest place.
		var nodes = {};
		var nodeAt = function(square) {
			if (nodes[square]) return nodes[square];
			if (stationAt[square]) {
				nodes[square] = { kind: 'station', square: square, stationIndex: stationAt[square], station: stations[stationAt[square] - 1],
					name: stations[stationAt[square] - 1].name, lines: [] };
			} else {
				var point = pointAtSquare[square], buffer = tiles[square].ends.length === 1;
				var place = point !== undefined ? data.points.name[point] : '';
				nodes[square] = { kind: buffer ? 'buffer' : 'junction', square: square, stationIndex: 0, lines: [],
					name: buffer ? 'the end of the line' + (place ? ' near ' + place : '') : 'the junction' + (place ? ' near ' + place : '') };
				tiles[square].junction = !buffer;
				tiles[square].buffer = buffer;
				tiles[square].pointName = nodes[square].name;
			}
			return nodes[square];
		};
		// Legs: from every node, out along each of its ends to the next node, each stretch once.
		var legs = {}, walked = {}, legCount = 0, place = new Array(count);
		var corridor = { id: NETWORK_ID, label: data.label, navigable: true, stations: stations };
		order.concat(Object.keys(byKey).map(function(key) { return byKey[key]; }).filter(function(square) {
			return isNode(square) && !queued[square];
		})).forEach(function(start) {
			var from = nodeAt(start);
			tiles[start].ends.forEach(function(firstBit) {
				if (walked[start + ':' + firstBit]) return;
				var path = [start], bits = [], current = start, bit = firstBit;
				for (;;) {
					var next = neighbour(current, bit);
					walked[current + ':' + bit] = true;
					walked[next + ':' + setup.worldmap.opposite(bit)] = true;
					bits.push(bit);
					path.push(next);
					if (isNode(next)) break;
					var back = setup.worldmap.opposite(bit), onward = tiles[next].ends.filter(function(end) { return end !== back; });
					current = next;
					bit = onward[0];
				}
				var legIndex = ++legCount, to = nodeAt(path[path.length - 1]);
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
					index: legIndex, tiles: legTiles, byKey: {},
					fromStation: from.station || { name: from.name }, toStation: to.station || { name: to.name },
					fromStationIndex: from.stationIndex, toStationIndex: to.stationIndex, fromNode: from, toNode: to,
					start: { x: legTiles[0].x, y: legTiles[0].y }, end: { x: legTiles[legTiles.length - 1].x, y: legTiles[legTiles.length - 1].y },
					rect: setup.worldmap.rectFor(legTiles)
				};
				legTiles.forEach(function(tile) { leg.byKey[setup.worldmap.key(tile.x, tile.y)] = tile; });
				leg.km = legTiles.reduce(function(sum, tile) { return sum + tile.distanceKm; }, 0);
				legs[legIndex] = leg;
				var outbound = { legIndex: legIndex, forward: true, destination: to.stationIndex, destinationName: to.name, direction: bits[0] };
				var inbound = { legIndex: legIndex, forward: false, destination: from.stationIndex, destinationName: from.name,
					direction: setup.worldmap.opposite(bits[bits.length - 1]) };
				from.lines.push(outbound);
				to.lines.push(inbound);
				if (from.station) from.station.lines.push(outbound);
				if (to.station) to.station.lines.push(inbound);
			});
		});
		stations.forEach(assignSides);
		var tileByKey = {};
		Object.keys(byKey).forEach(function(key) { tileByKey[key] = tiles[byKey[key]]; });
		return { corridor: corridor, slices: [], tiles: tiles, legs: legs, byKey: tileByKey, network: true, place: place, nodes: nodes,
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
	// Any yard's lines: a siding's are its two ways along its leg (setup.yards.lines).
	function getStationLines(stationIndex) {
		if (setup.yards && !setup.yards.isStation(stationIndex)) return setup.yards.lines(stationIndex);
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
		if (setup.yards && !setup.yards.isStation(stationIndex)) return setup.yards.tile(stationIndex);
		var route = getGridRoute(), station = getStation(stationIndex);
		if (!route || !station) return null;
		return route.tiles[route.stationPositions[Math.floor(Number(stationIndex)) - 1]];
	}

	// The node at a journey position: at either end of its leg, the station, junction or buffer standing there.
	function getNodeAt(legIndex, tileIndex) {
		var leg = getLeg(legIndex);
		if (!leg) return null;
		if (Number(tileIndex) <= 0) return leg.fromNode;
		if (Number(tileIndex) >= leg.tiles.length - 1) return leg.toNode;
		return null;
	}

	// The ways on from a junction a journey position stands at, other than the leg it is on: { legIndex, forward,
	// destination, destinationName, direction } each, forward saying which way the leg runs away from the junction.
	// A station is passed through on the line, without entering its yard: the ways on are the lines leaving the far end
	// of the yard from the one the leg comes in at.
	function getJunctionChoices(legIndex, tileIndex) {
		var node = getNodeAt(legIndex, tileIndex);
		if (node && node.kind === 'station') {
			var side = getArrivalSide(legIndex, node.stationIndex);
			return getStationLines(node.stationIndex).filter(function(line) {
				return line.legIndex !== Number(legIndex) && line.side !== side;
			});
		}
		if (!node || node.kind !== 'junction') return [];
		return node.lines.filter(function(line) { return line.legIndex !== Number(legIndex); });
	}

	// The stations nearest a journey position by track, through any junctions on the way, nearest first, as
	// { station, distance } with the distance in tiles.
	function getStationsNear(legIndex, tileIndex) {
		var leg = getLeg(legIndex);
		if (!leg) return [];
		var best = {}, queue = [], found = [];
		var reach = function(node, distance) {
			if (best[node.square] !== undefined && best[node.square] <= distance) return;
			best[node.square] = distance;
			queue.push([distance, node]);
		};
		var index = Math.max(0, Math.min(Number(tileIndex) || 0, leg.tiles.length - 1));
		reach(leg.fromNode, index);
		reach(leg.toNode, leg.tiles.length - 1 - index);
		while (queue.length && found.length < 4) {
			queue.sort(function(a, b) { return a[0] - b[0]; });
			var item = queue.shift(), distance = item[0], node = item[1];
			if (distance > best[node.square]) continue;
			if (node.kind === 'station') { found.push({ station: node.stationIndex, distance: distance }); continue; }
			node.lines.forEach(function(line) {
				var next = getLeg(line.legIndex);
				reach(line.forward ? next.toNode : next.fromNode, distance + next.tiles.length - 1);
			});
		}
		return found;
	}

	// How far by track the nodes around one are, in km, up to limitKm: { square: km }, the start left out. first, when
	// given, is the one line to leave by (one of the node's lines), and the search never comes back through the start:
	// what lies that way, as a signpost would put it.
	function getNodeDistances(startSquare, limitKm, first) {
		var route = getGridRoute(), start = route && route.nodes[startSquare];
		if (!start) return {};
		var best = {}, queue = [];
		// A binary heap on km: a signpost looks a long way down the line.
		var push = function(item) {
			var index = queue.push(item) - 1;
			while (index > 0) {
				var parent = (index - 1) >> 1;
				if (queue[parent][0] <= item[0]) break;
				queue[index] = queue[parent]; queue[parent] = item; index = parent;
			}
		};
		var pop = function() {
			var top = queue[0], last = queue.pop();
			if (queue.length) {
				queue[0] = last;
				for (var index = 0;;) {
					var child = index * 2 + 1;
					if (child >= queue.length) break;
					if (child + 1 < queue.length && queue[child + 1][0] < queue[child][0]) child++;
					if (queue[child][0] >= last[0]) break;
					queue[index] = queue[child]; queue[child] = last; index = child;
				}
			}
			return top;
		};
		var reach = function(node, km) {
			if (node.square === start.square || km > limitKm || (best[node.square] !== undefined && best[node.square] <= km)) return;
			best[node.square] = km;
			push([km, node]);
		};
		(first ? [first] : start.lines).forEach(function(line) {
			var leg = getLeg(line.legIndex);
			reach(line.forward ? leg.toNode : leg.fromNode, leg.km);
		});
		while (queue.length) {
			var item = pop(), km = item[0], node = item[1];
			if (km > best[node.square]) continue;
			node.lines.forEach(function(line) {
				var leg = getLeg(line.legIndex);
				reach(line.forward ? leg.toNode : leg.fromNode, km + leg.km);
			});
		}
		return best;
	}

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
		if (place) return { legIndex: place.legIndex, tileIndex: place.tileIndex, branch: null, tile: tile };
		// A junction or a buffer: the end of a leg that meets it.
		var node = route.nodes[tile.globalPosition], line = node && node.lines[0];
		if (!line) return null;
		return { legIndex: line.legIndex, tileIndex: line.forward ? 0 : getLeg(line.legIndex).tiles.length - 1, branch: null, tile: tile };
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
		NETWORK_ID: NETWORK_ID, hasNetwork: hasNetwork,
		getCorridor: getCorridor, getGridRoute: getGridRoute, getTileAt: getTileAt,
		getLeg: getLeg, getStation: getStation, getStationTile: getStationTile,
		getStationLines: getStationLines, getArrivalSide: getArrivalSide, getNodeAt: getNodeAt,
		getJunctionChoices: getJunctionChoices, getStationsNear: getStationsNear, getNodeDistances: getNodeDistances,
		terrainFor: terrainFor, debugTarget: debugTarget,
		appendDebugControls: appendDebugControls
	};
}());
