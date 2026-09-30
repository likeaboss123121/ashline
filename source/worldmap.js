// The playable world between stations: the compiled railway network, a square of the grid at a time.
//
// setup.realWorldPilot builds the network and owns its stations, legs and junctions. This module supplies movement
// along it, grades and travel times, compass directions, and the debug map.
setup.worldmap = {
	TILE_KM: 5,
	TILE_METRES: 5000,
	BASE_MINUTES_PER_TILE: 5, // 5 km in 5 minutes on the flat at REFERENCE_SPEED_KMH
	REFERENCE_SPEED_KMH: 60,
	GRADE_STEP: 0.5,
	GRADE_LIMIT: 5,
	ROLLING_RESISTANCE: 0.004, // fraction of weight, as a grade the train is always fighting
	// Compass directions, 45 degrees apart, so index arithmetic gives turns: a step of 1 is 45 degrees.
	DIRECTIONS: [
		{ name: 'n', dx: 0, dy: 1 }, { name: 'ne', dx: 1, dy: 1 },
		{ name: 'e', dx: 1, dy: 0 }, { name: 'se', dx: 1, dy: -1 },
		{ name: 's', dx: 0, dy: -1 }, { name: 'sw', dx: -1, dy: -1 },
		{ name: 'w', dx: -1, dy: 0 }, { name: 'nw', dx: -1, dy: 1 }
	],
	SHAPES: ['straight-ns', 'straight-ew', 'straight-nwse', 'straight-nesw',
		'turn-45', 'turn-90', 't-junction', 'y-junction', 'cross', 'dead-end'],
	// --- seeded values -------------------------------------------------------------------------------------
	getSeed: function() {
		return String((State.variables && State.variables.randomSeed) || 'ashline');
	},
	rngFor: function() {
		return setup.railyard.mulberry32(setup.railyard.seedFromString(Array.prototype.slice.call(arguments).join(':')));
	},
	// The climate of a square of the network: where it is, how high it stands, and how warm that makes it, colder
	// away from the equator and higher up. null off the network.
	getClimate: function(seed, x, y) {
		var tile = setup.realWorldPilot.getTileAt(x, y);
		if (!tile) return null;
		var latitude = tile.geoCoordinate[1];
		return { latitude: latitude, longitude: tile.geoCoordinate[0], elevation: tile.elevation,
			temperature: 34 - 0.48 * Math.abs(latitude) - tile.elevation * 0.0065, humidity: 0.5 };
	},
	// Whether there is water to pump from: the line is bridging it.
	isBesideWater: function(seed, x, y) {
		var tile = setup.realWorldPilot.getTileAt(x, y);
		return !!tile && tile.terrain === 'bridge';
	},
	// --- directions and track shapes ----------------------------------------------------------------------
	// The compass name a player would use for a direction, rather than the two letters the map stores.
	COMPASS_NAMES: { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west' },
	// The compass name of a grid direction. Given the square it is taken from, on the network's grid, it names the true
	// bearing of that step instead: the grid is a projection over a continent or two, and far from its centre grid
	// north is not true north (at Wales, Alaska, tens of degrees off; in Europe, on a grid turned to meet the Americas,
	// grid north points south), which a player reading the sun would notice.
	COMPASS_ORDER: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'],
	describeDirection: function(index, tile) {
		var direction = this.DIRECTIONS[index];
		if (!direction) return '';
		var bearing = this.gridBearing(tile, direction.dx, direction.dy);
		if (bearing !== null) return this.COMPASS_NAMES[this.COMPASS_ORDER[Math.round(bearing / 45) % 8]];
		return this.COMPASS_NAMES[direction.name];
	},
	// The true bearing, in degrees clockwise from north, of a step of (dx, dy) squares from a tile of the network; null
	// for a tile that is not on it.
	gridBearing: function(tile, dx, dy) {
		var data = setup.worldGraphData && setup.worldGraphData.network;
		if (!tile || !data || !data.grid || typeof tile.x !== 'number' || typeof tile.y !== 'number') return null;
		var grid = this.gridFor(tile);
		var a = this.unprojectGrid(tile.x, tile.y, grid), b = this.unprojectGrid(tile.x + dx, tile.y + dy, grid);
		var radians = Math.PI / 180, dLon = (b[0] - a[0]) * radians;
		var bearing = Math.atan2(Math.sin(dLon) * Math.cos(b[1] * radians),
			Math.cos(a[1] * radians) * Math.sin(b[1] * radians) - Math.sin(a[1] * radians) * Math.cos(b[1] * radians) * Math.cos(dLon)) / radians;
		return ((bearing % 360) + 360) % 360;
	},
	opposite: function(index) {
		return (index + 4) % 8;
	},
	turnBetween: function(a, b) {
		return Math.min((a - b + 8) % 8, (b - a + 8) % 8);
	},
	step: function(x, y, index) {
		var direction = this.DIRECTIONS[index];
		return { x: x + direction.dx, y: y + direction.dy };
	},
	key: function(x, y) {
		return x + ',' + y;
	},
	isStraight: function(shape) {
		return shape.indexOf('straight-') === 0;
	},
	// Names the piece of track that joins a tile's ends: two opposite ends are a straight, ends three apart are a
	// 45 degree bend and two apart a right angle, three ends are a T or a Y, and four are a crossing.
	getShape: function(ends) {
		if (ends.length >= 4) return 'cross';
		if (ends.length === 3) {
			for (var i = 0; i < 3; i++) {
				var through = ends[(i + 1) % 3];
				if (ends[(i + 2) % 3] === this.opposite(through)) {
					return this.turnBetween(ends[i], through) === 2 ? 't-junction' : 'y-junction';
				}
			}
			return 'y-junction';
		}
		if (ends.length === 2) {
			if (ends[1] === this.opposite(ends[0])) {
				var pair = this.DIRECTIONS[ends[0]].name + this.DIRECTIONS[ends[1]].name;
				if (pair === 'ns' || pair === 'sn') return 'straight-ns';
				if (pair === 'ew' || pair === 'we') return 'straight-ew';
				if (pair === 'nwse' || pair === 'senw') return 'straight-nwse';
				return 'straight-nesw';
			}
			return this.turnBetween(ends[0], ends[1]) === 3 ? 'turn-45' : 'turn-90';
		}
		return 'dead-end';
	},
	// --- stations and legs -------------------------------------------------------------------------------
	getStationTile: function(seed, stationId) {
		return setup.realWorldPilot.getStationTile(stationId) || { x: 0, y: 0 };
	},
	getLeg: function(seed, legIndex) {
		return setup.realWorldPilot.getLeg(legIndex);
	},
	// What the player calls a station.
	// A junction or buffer as seen from a station: one named for the very place the player stands in is "outside" it.
	describePoint: function(name, stationName) {
		return stationName && name.slice(-(' near ' + stationName).length) === ' near ' + stationName
			? name.slice(0, -(' near ' + stationName).length) + ' outside ' + stationName : name;
	},
	// The name the station's place gives itself, where it is not the English name (Москва for Moscow); '' otherwise.
	getStationLocalName: function(stationId) {
		var station = setup.realWorldPilot.getStation(stationId);
		return station && station.localName && station.localName !== station.name ? station.localName : '';
	},
	getStationName: function(stationId) {
		if (setup.yards && setup.yards.parse(stationId) && !setup.yards.isStation(stationId)) return setup.yards.name(stationId);
		if (setup.realWorldPilot && setup.realWorldPilot.getStation) {
			var station = setup.realWorldPilot.getStation(stationId);
			if (station) return station.name;
		}
		return 'Station ' + stationId;
	},
	// Which of the eight directions leads from one tile to its neighbour, or -1 if they are not neighbours.
	directionBetween: function(from, to) {
		for (var d = 0; d < this.DIRECTIONS.length; d++) {
			var step = this.step(from.x, from.y, d);
			if (step.x === to.x && step.y === to.y) {
				return d;
			}
		}
		return -1;
	},
	// The rectangle a leg occupies, padded so the map shows the land the line is threading through.
	rectFor: function(tiles, padding) {
		var pad = typeof padding === 'number' ? padding : 2;
		var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		tiles.forEach(function(tile) {
			x0 = Math.min(x0, tile.x); x1 = Math.max(x1, tile.x);
			y0 = Math.min(y0, tile.y); y1 = Math.max(y1, tile.y);
		});
		return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
	},
	// --- driving the line ---------------------------------------------------------------------------------
	// The leg's squares, node to node, as the positions a train can stand on.
	getMainLine: function(seed, legIndex) {
		var leg = this.getLeg(seed, legIndex);
		return leg ? leg.tiles : null;
	},
	// What one step costs: five minutes per 5 km on the flat, more up a grade, a little less down, and more again
	// for a heavy consist. Fuel follows, because the time system burns it by the minute while travelling. A step on the
	// geographic grid covers however much track lies between two squares, so km scales it; without it a step is 5 km.
	getTileMinutes: function(grade, train, km) {
		var tractive = this.getTrainTractiveKN(train);
		var tonnesPerKN = tractive > 0 ? (this.getTrainWeightKg(train) / 1000) / tractive : 0;
		var weightFactor = 1 + Math.max(0, tonnesPerKN - 1.2) * 0.12;
		var gradeFactor = grade >= 0 ? 1 + grade * 0.22 : Math.max(0.75, 1 + grade * 0.05);
		var speedFactor = this.REFERENCE_SPEED_KMH / this.getTopSpeedKmh(train);
		var distanceFactor = (Number(km) > 0 ? Number(km) : this.TILE_KM) / this.TILE_KM;
		return Math.max(1, Math.round(this.BASE_MINUTES_PER_TILE * speedFactor * gradeFactor * weightFactor * distanceFactor));
	},
	// The consist runs at the top speed of the locomotive being driven. Another locomotive hauled in neutral is only
	// weight, and does not hold the train back.
	getTopSpeedKmh: function(train) {
		var loco = setup.railyard.getControllingLocomotive(train);
		return loco && Number(loco.topSpeedKmh) > 0 ? Number(loco.topSpeedKmh) : this.REFERENCE_SPEED_KMH;
	},
	// --- a journey in progress -----------------------------------------------------------------------------
	getJourney: function() {
		var journey = State.variables && State.variables.journey;
		return journey && typeof journey.legIndex === 'number' ? journey : null;
	},
	// The leg the train is standing on, and its squares.
	getJourneyPath: function(position) {
		var journey = position || this.getJourney();
		var leg = journey && this.getLeg(this.getSeed(), journey.legIndex);
		return leg ? { tiles: leg.tiles, leg: leg } : null;
	},
	// The other lines leaving the node the train stands at, for the player to choose between: every line at a junction,
	// named for the way it leaves. A train passes through a station only facing into it, onto a line leaving the far end;
	// a walker (anyFacing) can go either way.
	getBranchChoices: function(position, anyFacing) {
		var journey = position || this.getJourney();
		var path = this.getJourneyPath(journey);
		if (!path) return [];
		var self = this, node = setup.realWorldPilot.getNodeAt(journey.legIndex, journey.tileIndex);
		if (node && node.kind === 'station' && !anyFacing
			&& (journey.forward !== false) !== (journey.tileIndex >= path.tiles.length - 1)) return [];
		return setup.realWorldPilot.getJunctionChoices(journey.legIndex, journey.tileIndex).map(function(line) {
			var step = self.getLineChoiceStep(line);
			return { id: 'leg:' + line.legIndex, legIndex: line.legIndex, direction: self.describeDirection(line.direction, path.tiles[journey.tileIndex]),
				tiles: step.tileCount, terrain: step.terrain, grade: step.grade };
		});
	},
	// The track between a square and the next one along the leg.
	getStepKm: function(tiles, index) {
		var tile = tiles[index];
		return tile && Number(tile.distanceKm) > 0 ? Number(tile.distanceKm) : this.TILE_KM;
	},
	// Where the consist stands, for the driving view and the status line.
	getJourneyView: function(position) {
		var journey = position || this.getJourney();
		var path = journey && this.getJourneyPath(journey);
		if (!path) return null;
		var tiles = path.tiles, leg = path.leg, forward = journey.forward !== false;
		var index = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
		var behind = 0, total = 0;
		for (var stepIndex = 0; stepIndex < tiles.length - 1; stepIndex++) {
			var stepKm = this.getStepKm(tiles, stepIndex);
			total += stepKm;
			if (forward ? stepIndex < index : stepIndex >= index) behind += stepKm;
		}
		return {
			legIndex: journey.legIndex, tileIndex: index, tileCount: tiles.length, forward: forward,
			tile: tiles[index], terrain: tiles[index].terrain, shape: tiles[index].shape,
			// The drawing tilts by the grade as the train faces it, not as the leg stores it.
			grade: forward ? tiles[index].grade : -tiles[Math.max(0, index - 1)].grade,
			kilometresDone: Math.round(behind),
			kilometresLeft: Math.round(total - behind),
			fromStation: forward ? leg.fromStation.name : leg.toStation.name,
			toStation: forward ? leg.toStation.name : leg.fromStation.name,
			fromStationIndex: forward ? leg.fromStationIndex : leg.toStationIndex,
			toStationIndex: forward ? leg.toStationIndex : leg.fromStationIndex
		};
	},
	// What a step would cost, wherever it ends up, and why it cannot be taken.
	describeStep: function(grade, terrain, extra) {
		var train = State.variables.currentTrain;
		var limit = this.getClimbLimitPercent(train);
		var step = {
			grade: grade, terrain: terrain, heading: '',
			minutes: this.getTileMinutes(grade, train, extra && extra.distanceKm),
			blocked: (this.getTrainTractiveKN(train) > 0 && grade > limit)
				? 'The grade ahead is ' + grade.toFixed(1) + '%, and your consist can pull ' + limit.toFixed(1) + '%.'
				: '',
			arrivesAt: 0
		};
		for (var key in extra) {
			if (Object.prototype.hasOwnProperty.call(extra, key)) {
				step[key] = extra[key];
			}
		}
		return step;
	},
	// One step along the leg: direction 1 carries on the way the journey faces, -1 backs up. Returns null at either
	// end of the leg, where the ways on are line choices (getBranchChoices).
	getJourneyStep: function(direction, position) {
		var journey = position || this.getJourney();
		var path = journey && this.getJourneyPath(journey);
		if (!path) return null;
		var tiles = path.tiles, from = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
		var to = from + (journey.forward !== false ? 1 : -1) * (direction >= 0 ? 1 : -1);
		if (to < 0 || to >= tiles.length) return null;
		var forwardStep = to > from;
		return this.describeStep(forwardStep ? tiles[from].grade : -tiles[to].grade, tiles[to].terrain, {
			fromIndex: from, toIndex: to, couples: this.parkedOn(tiles[to]),
			distanceKm: this.getStepKm(tiles, Math.min(from, to)),
			heading: this.describeDirection(forwardStep ? tiles[from].out : this.opposite(tiles[to].out), forwardStep ? tiles[from] : tiles[to]),
			destinationName: tiles[to].station || '',
			arrivesAt: to === 0 ? path.leg.fromStationIndex : (to === tiles.length - 1 ? path.leg.toStationIndex : 0)
		});
	},
	// The first step along a line leaving a junction: where it goes and what it costs. line is one of
	// realWorldPilot.getJunctionChoices.
	getLineChoiceStep: function(line) {
		var tiles = setup.realWorldPilot.getLeg(line.legIndex).tiles, last = tiles.length - 1;
		var from = line.forward ? 0 : last, to = line.forward ? 1 : last - 1;
		var leg = setup.realWorldPilot.getLeg(line.legIndex);
		return this.describeStep(line.forward ? tiles[from].grade : -tiles[to].grade, tiles[to].terrain, {
			fromIndex: from, toIndex: to, tileCount: tiles.length,
			couples: this.parkedOn(tiles[to]),
			distanceKm: this.getStepKm(tiles, Math.min(from, to)), heading: this.describeDirection(line.direction, tiles[from]),
			destinationName: tiles[to].station || '',
			arrivesAt: to === 0 ? leg.fromStationIndex : (to === last ? leg.toStationIndex : 0)
		});
	},
	// Whether a train left on the line stands on a square: a step onto it couples to it (setup.yards).
	parkedOn: function(tile) {
		return !!(tile && setup.yards && setup.yards.lineTrainAt(tile.x, tile.y));
	},
	// What taking one of the line choices at a node would cost, by its id ('leg:' and the leg's number).
	getBranchStep: function(branchId, position) {
		var journey = position || this.getJourney();
		if (!journey) return null;
		var line = setup.realWorldPilot.getJunctionChoices(journey.legIndex, journey.tileIndex).filter(function(candidate) {
			return 'leg:' + candidate.legIndex === branchId;
		})[0];
		return line ? this.getLineChoiceStep(line) : null;
	},
	getTrainWeightKg: function(train) {
		if (!Array.isArray(train)) return 0;
		var cargoTypes = (State.variables && State.variables.cargoTypes) || {};
		var total = 0;
		train.forEach(function(car) {
			if (!car) return;
			total += Number(car.baseWeight) || 0;
			(car.cargo || []).forEach(function(cargo) {
				var density = (cargoTypes[cargo.type] || { density: 1 }).density;
				total += (Number(cargo.amount) || 0) * density;
			});
		});
		return total;
	},
	getTrainTractiveKN: function(train) {
		if (!Array.isArray(train)) return 0;
		// What the locomotive being driven can pull now, not what it was built to: degraded diesel derates an engine.
		// Other locomotives are in neutral and add only their weight.
		return setup.fuel.getEffectiveTractiveKN(setup.railyard.getControllingLocomotive(train));
	},
	// The steepest grade a consist can pull at its current weight. Tractive effort has to lift the train up the
	// grade and overcome rolling resistance, so loading cargo flattens the limit: weight is a real decision.
	getClimbLimitPercent: function(train) {
		var tractive = this.getTrainTractiveKN(train);
		var weight = this.getTrainWeightKg(train);
		if (!(tractive > 0) || !(weight > 0)) {
			return 0;
		}
		var limit = ((tractive * 1000) / (weight * 9.81) - this.ROLLING_RESISTANCE) * 100;
		return Math.round(limit / this.GRADE_STEP) * this.GRADE_STEP;
	},
	// A line out of a station, on the side a departure is made from: the given leg, or the first line that side.
	// On the corridor each side has one line; at a junction a side can have several. See realWorldPilot.getStationLines.
	getLine: function(stationId, towardExit, legIndex) {
		var side = towardExit ? 'exit' : 'entry';
		var lines = setup.realWorldPilot.getStationLines(stationId).filter(function(line) {
			return line.side === side && (legIndex === undefined || legIndex === null || line.legIndex === Number(legIndex));
		});
		return lines[0] || null;
	},
	// Time over a leg, tile by tile. Climbing is slow and a heavy train is slower still; running downhill saves a
	// little. Fuel follows from the clock, because the time system burns fuel by the minute while travelling.
	// fromIndex starts part way along the leg, as a departure from a siding does.
	getLegTravel: function(seed, legIndex, train, reverse, fromIndex) {
		var leg = this.getLeg(seed, legIndex);
		if (!leg) return { minutes: 0, tiles: 0, kilometres: 0, steepestClimb: 0,
			climbLimit: this.getClimbLimitPercent(train) };
		// Every square but the last carries one step to its neighbour, and that step's grade. The same steps are
		// travelled either way round, so running the leg backwards is the same list of grades negated.
		var first = 0, last = leg.tiles.length - 1;
		if (Number.isInteger(fromIndex)) {
			if (reverse) last = fromIndex; else first = fromIndex;
		}
		var steps = leg.tiles.slice(first, last);
		var minutes = 0, steepestClimb = 0, kilometres = 0;
		for (var i = 0; i < steps.length; i++) {
			var grade = reverse ? -steps[i].grade : steps[i].grade;
			var stepKm = this.getStepKm(leg.tiles, first + i);
			steepestClimb = Math.max(steepestClimb, grade);
			minutes += this.getTileMinutes(grade, train, stepKm);
			kilometres += stepKm;
		}
		return {
			minutes: Math.max(1, minutes),
			tiles: steps.length + 1,
			kilometres: Math.round(kilometres),
			steepestClimb: steepestClimb,
			climbLimit: this.getClimbLimitPercent(train)
		};
	},
	getTravelMinutes: function(stationId, towardExit, train, legIndex) {
		var line = this.getLine(stationId, towardExit, legIndex);
		if (!line) {
			return 5;
		}
		return this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward, line.tileIndex).minutes;
	},
	// A short line for the travel UI: how far the leg runs, how steep it gets, and what the consist can pull.
	getTravelSummary: function(stationId, towardExit, train, legIndex) {
		var line = this.getLine(stationId, towardExit, legIndex);
		if (!line) {
			return '';
		}
		var travel = this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward, line.tileIndex);
		return setup.units.kilometres(travel.kilometres) + ', steepest climb ' + travel.steepestClimb.toFixed(1) + '%'
			+ (travel.climbLimit > 0 ? ', your consist pulls ' + travel.climbLimit.toFixed(1) + '%' : '') + '.';
	},
	// Why the train cannot make this leg, or '' if it can. A consist with no locomotive is left to the drive
	// capability rules, which explain that case in their own words.
	getClimbBlockReason: function(stationId, towardExit, train, legIndex) {
		if (!Array.isArray(train) || !train.length || !(this.getTrainTractiveKN(train) > 0)) {
			return '';
		}
		var line = this.getLine(stationId, towardExit, legIndex);
		if (!line) {
			return '';
		}
		var travel = this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward, line.tileIndex);
		if (travel.steepestClimb > travel.climbLimit) {
			return 'The line climbs ' + travel.steepestClimb.toFixed(1) + '% on the way, and your consist can pull '
				+ travel.climbLimit.toFixed(1) + '% at this weight.';
		}
		return '';
	},
	// Resolves one square of track into the journey coordinates used by trains and walkers. Debug tools use
	// coordinates rather than array offsets so the map remains the source of truth for what was clicked.
	getDebugTeleportTarget: function(legIndex, x, y) {
		return setup.realWorldPilot.debugTarget(x, y);
	},
	// Debug-only, zero-time movement. An onboard player takes the active consist; a player on foot moves alone and
	// leaves its journey position untouched. With no active train, journey supplies the walking route context only.
	debugTeleportToTile: function(legIndex, x, y) {
		var variables = State.variables;
		if (!variables.debugMode || !setup.isInGame()) return null;
		var target = this.getDebugTeleportTarget(Number(legIndex), Number(x), Number(y));
		if (!target) return null;
		var activeTrain = Array.isArray(variables.currentTrain) && variables.currentTrain.length > 0;
		var onFoot = !!variables.onFoot;
		var currentJourney = this.getJourney();
		var stationId = target.tile && Number(target.tile.stationIndex) || 0;
		if (stationId) {
			// A station marker is an arrival, not a train standing on an endpoint which only happens to share its cell.
			// Walkers keep their remote train parked; an onboard consist enters an available station lead.
			if (activeTrain && onFoot) {
				variables.currentStation = stationId;
				variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex, inRailyard: true };
				return { mode: 'player', passage: 'Railyard', target: target, stationId: stationId };
			}
			if (activeTrain) {
				var finalStation = setup.realWorldPilot.getGridRoute().corridor.stations.length;
				var arriveFromPrevious = stationId === 1 ? false : stationId === finalStation ? true
					: variables.travellingForward !== false;
				if (!setup.railyard.arriveAtStation(stationId, arriveFromPrevious)
					&& !setup.railyard.arriveAtStation(stationId, !arriveFromPrevious)) return null;
				variables.onFoot = null;
				return { mode: 'consist', passage: State.passage === 'TrainInterior' ? 'TrainInterior' : 'DrivingMode',
					target: target, stationId: stationId };
			}
			variables.currentStation = stationId;
			variables.journey = null;
			variables.onFoot = null;
			return { mode: 'player', passage: 'Railyard', target: target, stationId: stationId };
		}
		if (activeTrain && onFoot) {
			variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex };
			return { mode: 'player', passage: 'OnFoot', target: target };
		}
		var forward = currentJourney && currentJourney.legIndex === target.legIndex
			? currentJourney.forward !== false : variables.travellingForward !== false;
		var targetLeg = this.getLeg(this.getSeed(), target.legIndex);
		// The station the train last left: the one behind it on this leg, or, where a leg runs between two junctions,
		// whichever end has a station, else the one it was at.
		variables.currentStation = targetLeg
			? (forward ? targetLeg.fromStationIndex || targetLeg.toStationIndex : targetLeg.toStationIndex || targetLeg.fromStationIndex)
				|| variables.currentStation
			: variables.currentStation;
		variables.journey = {
			legIndex: target.legIndex, tileIndex: target.tileIndex, forward: forward
		};
		if (activeTrain) {
			variables.onFoot = null;
			return { mode: 'consist', passage: State.passage === 'TrainInterior' ? 'TrainInterior' : 'OnTheLine', target: target };
		}
		variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex };
		return { mode: 'player', passage: 'OnFoot', target: target };
	},
	// --- debug map ----------------------------------------------------------------------------------------
	// The grid a square of the network is on. The world is two grids joined at Wales, Alaska (the Americas, and Europe,
	// Asia and Africa: one projection cannot hold both), each chart holding a run of the squares; a square on the
	// second is given with the offset the compiler moved its grid by. Takes a tile or a square's index.
	gridFor: function(tileOrIndex) {
		var data = setup.worldGraphData && setup.worldGraphData.network;
		if (!data) return null;
		var index = typeof tileOrIndex === 'number' ? tileOrIndex : tileOrIndex && tileOrIndex.globalPosition;
		if (data.charts && typeof index === 'number') {
			for (var i = 0; i < data.charts.length; i++) {
				var chart = data.charts[i];
				if (index >= chart.first && index < chart.first + chart.count) return chart.grid;
			}
		}
		return data.grid;
	},
	// The land mask under the network (compile-world.cjs, land-mask.cjs), unpacked once: for each block of land.block
	// squares, whether it is land and which chart's grid it lies on. null when the data has none.
	getLandMask: function() {
		var data = setup.worldGraphData && setup.worldGraphData.network, land = data && data.land;
		if (!land) return null;
		if (this._landMask && this._landMask.source === land) return this._landMask;
		var count = land.width * land.height, isLand = new Uint8Array(count), chart = new Uint8Array(count);
		var at = 0, value = 0;
		land.runs.split(',').forEach(function(run) {
			var length = parseInt(run, 36);
			if (value) isLand.fill(1, at, at + length);
			at += length;
			value = 1 - value;
		});
		if (land.charts) {
			at = 0;
			land.charts.split(',').forEach(function(run) {
				var parts = run.split(':'), length = parseInt(parts[1], 36);
				chart.fill(Number(parts[0]), at, at + length);
				at += length;
			});
		}
		this._landMask = { source: land, block: land.block, x0: land.x0, y0: land.y0, width: land.width, height: land.height,
			isLand: isLand, chart: chart };
		return this._landMask;
	},
	// The grid any square of the joined map lies on, on the network or not: the chart of its block in the land mask.
	gridAt: function(x, y) {
		var data = setup.worldGraphData && setup.worldGraphData.network;
		if (!data) return null;
		var mask = this.getLandMask();
		if (!data.charts || !mask) return data.grid;
		var column = Math.floor((x - mask.x0) / mask.block), row = Math.floor((mask.y0 - y) / mask.block);
		column = Math.max(0, Math.min(mask.width - 1, column));
		row = Math.max(0, Math.min(mask.height - 1, row));
		return data.charts[mask.chart[row * mask.width + column]].grid;
	},
	// Where a longitude and latitude falls on a grid of the joined map, as unrounded square coordinates: the grid's own
	// projection, then its quarter turns and offset (the reverse of unprojectGrid).
	projectToGrid: function(longitude, latitude, grid) {
		var radians = Math.PI / 180, R = 6371.0088;
		var lambda0 = grid.centre[0] * radians, phi0 = grid.centre[1] * radians;
		var forward = function(lon, lat) {
			var lambda = lon * radians, phi = lat * radians;
			var k = Math.sqrt(2 / (1 + Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0)));
			return [R * k * Math.cos(phi) * Math.sin(lambda - lambda0),
				R * k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0))];
		};
		var origin = forward(grid.origin[0], grid.origin[1]), here = forward(longitude, latitude);
		var x = (here[0] - origin[0]) / grid.cellKm, y = (here[1] - origin[1]) / grid.cellKm;
		for (var turn = 0; turn < (((grid.turn || 0) % 4) + 4) % 4; turn++) { var back = x; x = -y; y = back; }
		if (grid.offset) { x += grid.offset[0]; y += grid.offset[1]; }
		return [x, y];
	},
	// Whether a longitude and latitude is land, from the land mask: true, false, or null where the mask does not reach.
	// On a world of several grids the place is tried on each, and counts only where its block is on that grid.
	isLandAt: function(longitude, latitude) {
		var data = setup.worldGraphData && setup.worldGraphData.network, mask = this.getLandMask();
		if (!data || !mask) return null;
		var charts = data.charts || [{ grid: data.grid }];
		for (var i = 0; i < charts.length; i++) {
			var at = this.projectToGrid(longitude, latitude, charts[i].grid);
			var column = Math.floor((at[0] + 0.5 - mask.x0) / mask.block), row = Math.floor((mask.y0 - at[1] + 0.5) / mask.block);
			if (column < 0 || row < 0 || column >= mask.width || row >= mask.height) continue;
			var index = row * mask.width + column;
			if (data.charts && mask.chart[index] !== i) continue;
			return mask.isLand[index] === 1;
		}
		return null;
	},
	// The middle of a grid square as [longitude, latitude], from the grid's projection (scripts/world/projection.cjs),
	// for a grid turned and moved to join another (gridFor) its own square found first: the offset taken away, then
	// its quarter turns undone. The longitude is between -180 and 180.
	unprojectGrid: function(x, y, grid) {
		if (grid.offset) { x -= grid.offset[0]; y -= grid.offset[1]; }
		for (var turn = 0; turn < (((grid.turn || 0) % 4) + 4) % 4; turn++) { var back = x; x = y; y = -back; }
		var radians = Math.PI / 180, R = 6371.0088;
		var lambda0 = grid.centre[0] * radians, phi0 = grid.centre[1] * radians;
		var forward = function(p) {
			var lambda = p[0] * radians, phi = p[1] * radians;
			var k = Math.sqrt(2 / (1 + Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0)));
			return [R * k * Math.cos(phi) * Math.sin(lambda - lambda0),
				R * k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0))];
		};
		var origin = forward(grid.origin), px = origin[0] + x * grid.cellKm, py = origin[1] + y * grid.cellKm;
		var rho = Math.hypot(px, py);
		if (rho === 0) return grid.centre.slice();
		var c = 2 * Math.asin(rho / (2 * R));
		var phi = Math.asin(Math.cos(c) * Math.sin(phi0) + py * Math.sin(c) * Math.cos(phi0) / rho);
		var lambda = lambda0 + Math.atan2(px * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - py * Math.sin(phi0) * Math.sin(c));
		var longitude = ((lambda / radians + 180) % 360 + 360) % 360 - 180;
		return [Math.round(longitude * 1e5) / 1e5, Math.round(phi / radians * 1e5) / 1e5];
	},
	appendDebugMap: function(parent, stationId) {
		if (!parent || typeof document === 'undefined') {
			return;
		}
		var self = this;
		if (!setup.realWorldPilot.getGridRoute()) return;
		if (typeof ResizeObserver !== 'function') {
			this.buildDebugMapPanel(parent, stationId);
			return;
		}
		var holder = document.createElement('div');
		holder.className = 'debug-map-holder';
		var waiting = document.createElement('p');
		waiting.className = 'small-description';
		waiting.textContent = 'Drawing the network…';
		holder.appendChild(waiting);
		parent.appendChild(holder);
		var watcher = new ResizeObserver(function() {
			if (!holder.clientWidth) return;
			watcher.disconnect();
			// Let the message show before the drawing takes over the page for a moment.
			setTimeout(function() {
				holder.removeChild(waiting);
				self.buildDebugMapPanel(holder, stationId);
			}, 0);
		});
		watcher.observe(holder);
	},
	// The debug panel's map: the same globe as the Map tab (source/globe.js) with everything revealed and no fog. A click
	// on the track teleports there; the line under the map names the square under the pointer; the station list is
	// the keyboard way to teleport.
	buildDebugMapPanel: function(parent, stationId) {
		if (!parent || typeof document === 'undefined') {
			return;
		}
		try {
			var route = setup.realWorldPilot.getGridRoute();
			var heading = document.createElement('p');
			heading.className = 'debug-map-heading';
			var networkStats = setup.worldGraphData.network.stats;
			heading.textContent = route.corridor.label + ': ' + route.tiles.length + ' grid squares, '
				+ Object.keys(route.legs).length + ' legs, ' + route.corridor.stations.length + ' stations; '
				+ networkStats.railKm + ' km of mapped railway joined by ' + networkStats.bridgeCount + ' new lines ('
				+ networkStats.bridgeKm + ' km). Yard contents still use seed ' + this.getSeed() + '.';
			parent.appendChild(heading);
			var instructions = document.createElement('p');
			instructions.textContent = 'Debug teleport: Click on the map to teleport, or choose a station in the dropdown below.';
			var self = this;
			var teleport = function(legIndex, x, y) {
				var result = self.debugTeleportToTile(Number(legIndex), Number(x), Number(y));
				if (!result) return;
				setup.debugTeleportNotice = 'Teleported ' + (result.mode === 'consist' ? 'the complete consist' : 'you')
					+ (result.stationId ? ' to ' + setup.worldmap.getStationName(result.stationId) + ' station.'
						: ' to ' + [self.getLeg(self.getSeed(), result.target.legIndex)].map(function(leg) {
							return leg.fromStation.name + '–' + leg.toStation.name; })[0] + ', tile '
							+ (result.target.tileIndex + 1) + ' at ' + result.target.tile.x + ', ' + result.target.tile.y + '.');
				setup.debugReturnToPanel = true;
				Engine.play(result.passage);
			};
			parent.appendChild(instructions);
			var controls = document.createElement('div');
			controls.className = 'debug-map-teleport-controls';
			var label = document.createElement('label');
			label.textContent = 'Station: ';
			var select = document.createElement('select');
			select.setAttribute('aria-label', 'Station to teleport to');
			// Every station: listing hundreds of thousands of squares would make the list useless.
			var listed = route.tiles.filter(function(tile) { return tile.stationIndex; })
				.sort(function(a, b) { return a.stationIndex - b.stationIndex; });
			listed.forEach(function(tile, index) {
				var option = document.createElement('option');
				option.value = '0,' + tile.x + ',' + tile.y;
				option.textContent = (index + 1) + '/' + listed.length + ' — ' + tile.station + ' — ' + tile.x + ', ' + tile.y;
				select.appendChild(option);
			});
			label.appendChild(select);
			controls.appendChild(label);
			var teleportButton = document.createElement('button');
			teleportButton.type = 'button';
			teleportButton.textContent = 'Teleport';
			teleportButton.addEventListener('click', function() {
				var address = select.value.split(',');
				teleport(address[0], address[1], address[2]);
			});
			controls.appendChild(teleportButton);
			parent.appendChild(controls);
			if (setup.debugTeleportNotice) {
				var notice = document.createElement('p');
				notice.className = 'debug-teleport-notice';
				notice.setAttribute('role', 'status');
				notice.textContent = setup.debugTeleportNotice;
				parent.appendChild(notice);
			}
			// One line under the map names the square under the pointer.
			var readout = document.createElement('p');
			readout.className = 'small-description debug-map-hover';
			readout.textContent = 'Point at the map to read a square.';
			var globe = setup.globe.build({
				revealAll: true,
				onPick: function(tile) { teleport(0, tile.x, tile.y); },
				onHover: function(tile, place) {
					readout.textContent = tile ? ((tile.station ? tile.station + ' (' + (tile.stationRegion || 'rural') + ') | ' : '') + (tile.gapFill ? 'new line | ' : '')
						+ 'grid ' + tile.x + ',' + tile.y + ' ' + tile.terrain + ' ' + tile.shape + ' | '
						+ tile.geoCoordinate[1].toFixed(3) + '\u00b0, ' + tile.geoCoordinate[0].toFixed(3) + '\u00b0 | mean '
						+ Math.round(tile.elevation) + ' m, relief \u03c3 ' + Math.round(tile.elevationStdDevM) + ' m')
						: place ? 'no track | ' + place[1].toFixed(2) + '\u00b0, ' + place[0].toFixed(2) + '\u00b0' : 'Point at the map to read a square.';
				}
			});
			globe.classList.add('debug-map-globe');
			parent.appendChild(globe);
			parent.appendChild(readout);
			// The squares of the grid, outlined round the track when zoomed in: the debug map only.
			var gridLabel = document.createElement('label'), gridBox = document.createElement('input');
			gridBox.type = 'checkbox';
			gridBox.className = 'debug-map-grid-toggle';
			gridBox.addEventListener('change', function() { globe.setGrid(gridBox.checked); });
			gridLabel.appendChild(gridBox);
			gridLabel.appendChild(document.createTextNode(' [NEEDS WRITING PASS] Show grid squares (zoom in to see them)'));
			parent.appendChild(gridLabel);
			var legend = document.createElement('p');
			legend.textContent = 'Railways imported from IRL railways appear in white. Programmatically generated railways appear in red. Click on a station or tile in the map to teleport to it with your consist.';
			parent.appendChild(legend);
		} catch (error) {
			var failure = document.createElement('p');
			failure.textContent = 'World map unavailable: ' + error.message;
			parent.appendChild(failure);
		}
	}
};
