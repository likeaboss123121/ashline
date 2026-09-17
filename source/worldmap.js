// The world between stations: a grid of 5 km tiles, each carrying one piece of track.
//
// Everything here is a pure function of the world seed. Nothing is ever written into State.variables, so the map
// costs nothing in a save and cannot drift out of step with one: ask for the same seed and you get the same world
// back, every time. Results are memoised in setup.worldmap.cache, which SugarCube does not persist.
//
// Coordinates are whole tiles, x east and y north, with station 1 at the origin. A leg is the run of track from
// station N to station N + 1; its heading comes from setup.railyard.getLegHeading, so the map and the compass
// names the player reads are the same route. Each tile records the directions its track points (its ends), the
// terrain it crosses, and the grade of the step leaving it, quantised to the half percent between -5% and 5%.
setup.worldmap = {
	TILE_KM: 5,
	TILE_METRES: 5000,
	BASE_MINUTES_PER_TILE: 5, // 5 km in 5 minutes on the flat at REFERENCE_SPEED_KMH
	REFERENCE_SPEED_KMH: 60,
	GRADE_STEP: 0.5,
	GRADE_LIMIT: 5,
	ROLLING_RESISTANCE: 0.004, // fraction of weight, as a grade the train is always fighting
	MIN_LEG_TILES: 8,
	MAX_LEG_TILES: 20,
	BRANCH_CHANCE: 0.12,
	MOUNTAIN_METRES: 1150,
	FOREST_THRESHOLD: 0.58, // of the forest noise; woods cover roughly a fifth of the land that is not desert or ice
	TUNNEL_METRES: 1450,

	// Compass directions, 45 degrees apart, so index arithmetic gives turns: a step of 1 is 45 degrees.
	DIRECTIONS: [
		{ name: 'n', dx: 0, dy: 1 }, { name: 'ne', dx: 1, dy: 1 },
		{ name: 'e', dx: 1, dy: 0 }, { name: 'se', dx: 1, dy: -1 },
		{ name: 's', dx: 0, dy: -1 }, { name: 'sw', dx: -1, dy: -1 },
		{ name: 'w', dx: -1, dy: 0 }, { name: 'nw', dx: -1, dy: 1 }
	],

	SHAPES: ['straight-ns', 'straight-ew', 'straight-nwse', 'straight-nesw',
		'turn-45', 'turn-90', 't-junction', 'y-junction', 'cross', 'dead-end'],

	// What each terrain will carry. Mountains are too tight for a three or four way junction, a bridge or a
	// tunnel holds one straight track and nothing else, and water carries no track at all: the line bridges it.
	TERRAIN_RULES: {
		plains: {},
		desert: {},
		arctic: {},
		forest: {},
		mountain: { forbidden: ['t-junction', 'y-junction', 'cross'] },
		bridge: { straightOnly: true },
		tunnel: { straightOnly: true },
		water: { noTrack: true }
	},

	TERRAIN_COLOURS: {
		plains: '#3f4a36', forest: '#2c4a2e', desert: '#6b5a36', arctic: '#5d6a72', mountain: '#4a4340',
		bridge: '#5a4a3a', tunnel: '#332f2c', water: '#24384a'
	},

	// --- seeded values -------------------------------------------------------------------------------------

	getSeed: function() {
		return String((State.variables && State.variables.randomSeed) || 'ashline');
	},
	rngFor: function() {
		return setup.railyard.mulberry32(setup.railyard.seedFromString(Array.prototype.slice.call(arguments).join(':')));
	},
	noise: function(seed, channel, x, y) {
		return this.rngFor(seed, channel, x, y)();
	},
	// Value noise: one random number per lattice corner, smoothly blended, so neighbouring tiles agree with each
	// other. Terrain and elevation both need that: a mountain is a range, not a scatter of unrelated peaks.
	smoothNoise: function(seed, channel, x, y, scale) {
		var gx = Math.floor(x / scale);
		var gy = Math.floor(y / scale);
		var fx = x / scale - gx;
		var fy = y / scale - gy;
		var sx = fx * fx * (3 - 2 * fx);
		var sy = fy * fy * (3 - 2 * fy);
		var v00 = this.noise(seed, channel, gx, gy);
		var v10 = this.noise(seed, channel, gx + 1, gy);
		var v01 = this.noise(seed, channel, gx, gy + 1);
		var v11 = this.noise(seed, channel, gx + 1, gy + 1);
		return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
	},
	getElevationMetres: function(seed, x, y) {
		var broad = this.smoothNoise(seed, 'elev', x, y, 9);
		var ridge = this.smoothNoise(seed, 'ridge', x, y, 4);
		return Math.round(broad * 900 + ridge * ridge * 900);
	},
	// The grade of the step out of one tile in a given direction, as a percentage of the run, quantised to half a
	// percent and capped at 5%. Travelling the other way is the same number negated, so a climb one way is a
	// descent the other.
	getGradePercent: function(seed, x, y, directionIndex) {
		var direction = this.DIRECTIONS[directionIndex];
		var target = this.step(x, y, directionIndex);
		var run = this.TILE_METRES * (direction.dx && direction.dy ? Math.SQRT2 : 1);
		var rise = this.getElevationMetres(seed, target.x, target.y) - this.getElevationMetres(seed, x, y);
		var percent = Math.max(-this.GRADE_LIMIT, Math.min(this.GRADE_LIMIT, (rise / run) * 100));
		return Math.round(percent / this.GRADE_STEP) * this.GRADE_STEP;
	},
	// The land before any track is laid on it. y counts tiles north of Punta Arenas, so the far south is subpolar
	// and the dry belt sits well up the continent.
	getBaseTerrain: function(seed, x, y) {
		if (this.smoothNoise(seed, 'water', x, y, 7) > 0.74) {
			return 'water';
		}
		if (this.getElevationMetres(seed, x, y) > this.MOUNTAIN_METRES) {
			return 'mountain';
		}
		var km = y * this.TILE_KM;
		if (km < 200 && this.smoothNoise(seed, 'cold', x, y, 8) > 0.45) {
			return 'arctic';
		}
		var dry = this.smoothNoise(seed, 'dry', x, y, 10);
		if (dry > (km > 900 && km < 3200 ? 0.5 : 0.78)) {
			return 'desert';
		}
		if (this.smoothNoise(seed, 'forest', x, y, 6) > this.FOREST_THRESHOLD) {
			return 'forest';
		}
		return 'plains';
	},

	// Whether there is water to pump from: the tile itself is water (the line is bridging it), or one of the eight
	// tiles around it is.
	isBesideWater: function(seed, x, y) {
		for (var dx = -1; dx <= 1; dx++) {
			for (var dy = -1; dy <= 1; dy++) {
				if (this.getBaseTerrain(seed, x + dx, y + dy) === 'water') {
					return true;
				}
			}
		}
		return false;
	},

	// --- directions and track shapes ----------------------------------------------------------------------

	directionIndex: function(name) {
		for (var i = 0; i < this.DIRECTIONS.length; i++) {
			if (this.DIRECTIONS[i].name === name) return i;
		}
		return 0;
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
	canPlace: function(terrain, shape) {
		var rules = this.TERRAIN_RULES[terrain] || {};
		if (rules.noTrack) return false;
		if (rules.straightOnly) return this.isStraight(shape);
		return !(rules.forbidden && rules.forbidden.indexOf(shape) !== -1);
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

	// --- generation ---------------------------------------------------------------------------------------

	cache: {},
	cacheFor: function(seed) {
		if (!this.cache[seed]) {
			this.cache[seed] = { legs: {}, stations: {} };
		}
		return this.cache[seed];
	},
	clearCache: function() {
		this.cache = {};
	},
	// Station 1 sits at the origin; every station after it stands at the end of the leg that reaches it.
	getStationTile: function(seed, stationId) {
		var id = Math.max(1, Math.floor(stationId));
		var cache = this.cacheFor(seed);
		if (cache.stations[id]) {
			return cache.stations[id];
		}
		cache.stations[id] = id === 1 ? { x: 0, y: 0 } : this.getLeg(seed, id - 1).end;
		return cache.stations[id];
	},
	getLeg: function(seed, legIndex) {
		var cache = this.cacheFor(seed);
		if (!cache.legs[legIndex]) {
			cache.legs[legIndex] = this.buildLeg(seed, legIndex);
		}
		return cache.legs[legIndex];
	},
	// The terrain a tile ends up with once track is laid: water is bridged, and a straight run under a high
	// enough mountain is tunnelled.
	trackTerrain: function(seed, x, y, straight) {
		var base = this.getBaseTerrain(seed, x, y);
		if (base === 'water') {
			return straight ? 'bridge' : null; // a bridge carries a straight track only, so a bend cannot cross
		}
		if (base === 'mountain' && straight && this.getElevationMetres(seed, x, y) > this.TUNNEL_METRES) {
			return 'tunnel';
		}
		return base;
	},
	// Builds one leg: a walk from its station towards the leg's heading, mostly straight on, bending where the
	// land makes it easier, and dropping abandoned branches along the way.
	buildLeg: function(seed, legIndex) {
		var self = this;
		var headingName = { north: 'n', south: 's', east: 'e', west: 'w' }[setup.railyard.getLegHeading(legIndex, seed)] || 'n';
		var start = this.getStationTile(seed, legIndex);
		var rng = this.rngFor(seed, 'leg', legIndex);
		var count = this.MIN_LEG_TILES + Math.floor(rng() * (this.MAX_LEG_TILES - this.MIN_LEG_TILES + 1));
		var tiles = [];
		var byKey = {};
		var travel = this.directionIndex(headingName);
		var x = start.x;
		var y = start.y;

		var addTile = function(tile) {
			tiles.push(tile);
			byKey[self.key(tile.x, tile.y)] = tile;
		};
		for (var i = 0; i < count; i++) {
			// Candidates in order of preference: straight on, then a 45 degree bend, then a right angle.
			var candidates = [travel, (travel + 1) % 8, (travel + 7) % 8, (travel + 2) % 8, (travel + 6) % 8];
			if (rng() < 0.5) {
				var swapA = candidates[1];
				candidates[1] = candidates[2];
				candidates[2] = swapA;
			}
			var chosen = null;
			var terrain = null;
			for (var c = 0; c < candidates.length && chosen === null; c++) {
				var out = candidates[c];
				var ends = [this.opposite(travel), out].sort(function(a, b) { return a - b; });
				var candidateTerrain = this.trackTerrain(seed, x, y, this.isStraight(this.getShape(ends)));
				var nextTile = this.step(x, y, out);
				if (candidateTerrain === null || !this.canPlace(candidateTerrain, this.getShape(ends))) {
					continue;
				}
				if (byKey[this.key(nextTile.x, nextTile.y)]) {
					continue; // never cross the line the leg has already laid
				}
				// Prefer not to bridge, but take the crossing rather than double back.
				if (this.getBaseTerrain(seed, nextTile.x, nextTile.y) === 'water' && c < candidates.length - 1 && rng() < 0.8) {
					continue;
				}
				chosen = out;
				terrain = candidateTerrain;
			}
			if (chosen === null) {
				chosen = travel;
				terrain = this.trackTerrain(seed, x, y, true) || 'bridge';
			}
			var tileEnds = [this.opposite(travel), chosen].sort(function(a, b) { return a - b; });
			addTile({
				x: x, y: y, ends: tileEnds, shape: this.getShape(tileEnds), terrain: terrain,
				elevation: this.getElevationMetres(seed, x, y),
				grade: this.getGradePercent(seed, x, y, chosen),
				out: chosen, station: i === 0 ? legIndex : 0
			});
			var moved = this.step(x, y, chosen);
			x = moved.x;
			y = moved.y;
			travel = chosen;
		}
		// The last tile is where the next station stands, so its track simply ends there.
		var endEnds = [this.opposite(travel)];
		addTile({
			x: x, y: y, ends: endEnds, shape: this.getShape(endEnds), terrain: this.trackTerrain(seed, x, y, true) || 'bridge',
			elevation: this.getElevationMetres(seed, x, y), grade: 0, out: -1, station: legIndex + 1
		});

		this.addBranches(seed, legIndex, tiles, byKey, rng);
		return {
			index: legIndex, tiles: tiles, byKey: byKey,
			start: { x: start.x, y: start.y }, end: { x: x, y: y },
			rect: this.rectFor(tiles)
		};
	},
	// Abandoned branches: a junction on the main line and a few tiles of track that stop at a dead end. They go
	// nowhere yet, and become real routes once the world has somewhere to put them.
	addBranches: function(seed, legIndex, tiles, byKey, rng) {
		var self = this;
		var mainLine = tiles.slice();
		for (var i = 1; i < mainLine.length - 1; i++) {
			var tile = mainLine[i];
			if (rng() > this.BRANCH_CHANCE || tile.station) {
				continue;
			}
			var options = [];
			for (var d = 0; d < 8; d++) {
				if (tile.ends.indexOf(d) !== -1) continue;
				// 45 degrees off an end makes a Y and a right angle makes a T. Both are junctions a train can take.
				var turn = Math.min(this.turnBetween(d, tile.ends[0]), this.turnBetween(d, tile.ends[1]));
				if (turn >= 1 && turn <= 3) options.push(d);
			}
			if (!options.length) {
				continue;
			}
			var branchDirection = options[Math.floor(rng() * options.length)];
			var junctionEnds = tile.ends.concat([branchDirection]).sort(function(a, b) { return a - b; });
			var junctionShape = this.getShape(junctionEnds);
			if (!this.canPlace(tile.terrain, junctionShape)) {
				continue; // mountains, bridges and tunnels have no room for a junction
			}
			var branchTiles = this.buildBranch(seed, legIndex, i, tile, branchDirection, byKey, rng);
			if (!branchTiles.length) {
				continue;
			}
			tile.ends = junctionEnds;
			tile.shape = junctionShape;
			branchTiles.forEach(function(branchTile) {
				tiles.push(branchTile);
				byKey[self.key(branchTile.x, branchTile.y)] = branchTile;
			});

			// Now and then a second branch leaves the far side of the same tile, and the lines cross there.
			var acrossDirection = this.opposite(branchDirection);
			if (rng() < 0.2 && tile.ends.indexOf(acrossDirection) === -1) {
				var crossEnds = tile.ends.concat([acrossDirection]).sort(function(a, b) { return a - b; });
				var crossShape = this.getShape(crossEnds);
				if (this.canPlace(tile.terrain, crossShape)) {
					var crossTiles = this.buildBranch(seed, legIndex, i, tile, acrossDirection, byKey, rng);
					if (crossTiles.length) {
						tile.ends = crossEnds;
						tile.shape = crossShape;
						crossTiles.forEach(function(branchTile) {
							tiles.push(branchTile);
							byKey[self.key(branchTile.x, branchTile.y)] = branchTile;
						});
					}
				}
			}
		}
	},
	buildBranch: function(seed, legIndex, tileIndex, junction, direction, byKey, rng) {
		var length = 2 + Math.floor(rng() * 4);
		var made = [];
		var travel = direction;
		var position = this.step(junction.x, junction.y, direction);
		for (var i = 0; i < length; i++) {
			if (byKey[this.key(position.x, position.y)]) {
				break;
			}
			var last = i === length - 1;
			var out = last ? -1 : (rng() < 0.75 ? travel : (rng() < 0.5 ? (travel + 1) % 8 : (travel + 7) % 8));
			var ends = last ? [this.opposite(travel)] : [this.opposite(travel), out].sort(function(a, b) { return a - b; });
			var shape = this.getShape(ends);
			var terrain = this.trackTerrain(seed, position.x, position.y, this.isStraight(shape) || last);
			if (terrain === null || !this.canPlace(terrain, shape)) {
				break;
			}
			made.push({
				x: position.x, y: position.y, ends: ends, shape: shape, terrain: terrain,
				elevation: this.getElevationMetres(seed, position.x, position.y),
				grade: out === -1 ? 0 : this.getGradePercent(seed, position.x, position.y, out),
				out: out, station: 0, branch: true
			});
			if (out === -1) {
				break;
			}
			position = this.step(position.x, position.y, out);
			travel = out;
		}
		if (made.length) {
			var end = made[made.length - 1];
			end.ends = [end.ends[0]];
			end.shape = 'dead-end';
			end.out = -1;
			end.grade = 0;
		}
		return made;
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

	// The leg's main line, station tile to station tile, as the positions a train can stand on. Branch tiles are
	// not part of it: they lead nowhere yet.
	getMainLine: function(seed, legIndex) {
		var cache = this.cacheFor(seed);
		if (!cache.mainLines) {
			cache.mainLines = {};
		}
		if (!cache.mainLines[legIndex]) {
			cache.mainLines[legIndex] = this.getLeg(seed, legIndex).tiles.filter(function(tile) { return !tile.branch; });
		}
		return cache.mainLines[legIndex];
	},
	// What one 5 km step costs: five minutes on the flat, more up a grade, a little less down, and more again
	// for a heavy consist. Fuel follows, because the time system burns it by the minute while travelling.
	getTileMinutes: function(grade, train) {
		var tractive = this.getTrainTractiveKN(train);
		var tonnesPerKN = tractive > 0 ? (this.getTrainWeightKg(train) / 1000) / tractive : 0;
		var weightFactor = 1 + Math.max(0, tonnesPerKN - 1.2) * 0.12;
		var gradeFactor = grade >= 0 ? 1 + grade * 0.22 : Math.max(0.75, 1 + grade * 0.05);
		var speedFactor = this.REFERENCE_SPEED_KMH / this.getTopSpeedKmh(train);
		return Math.max(1, Math.round(this.BASE_MINUTES_PER_TILE * speedFactor * gradeFactor * weightFactor));
	},
	// A consist runs no faster than its slowest locomotive: a shunter hauled in a road train still holds it back.
	getTopSpeedKmh: function(train) {
		var speeds = (Array.isArray(train) ? train : []).filter(function(car) {
			return car && Number(car.tractiveCapacity) > 0 && Number(car.topSpeedKmh) > 0;
		}).map(function(car) { return Number(car.topSpeedKmh); });
		return speeds.length ? Math.min.apply(null, speeds) : this.REFERENCE_SPEED_KMH;
	},
	// The grade of the step between two neighbouring positions, in the direction it is taken.
	getStepGrade: function(tiles, fromIndex, toIndex) {
		return toIndex > fromIndex ? tiles[fromIndex].grade : -tiles[toIndex].grade;
	},

	// --- a journey in progress -----------------------------------------------------------------------------

	getJourney: function() {
		var journey = State.variables && State.variables.journey;
		return journey && typeof journey.legIndex === 'number' ? journey : null;
	},
	// Where the consist stands, for the driving view and the status line.
	getJourneyView: function() {
		var journey = this.getJourney();
		if (!journey) {
			return null;
		}
		var tiles = this.getMainLine(this.getSeed(), journey.legIndex);
		var index = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
		var tile = tiles[index];
		var travelled = journey.forward ? index : tiles.length - 1 - index;
		return {
			legIndex: journey.legIndex, tileIndex: index, tileCount: tiles.length, forward: journey.forward,
			tile: tile, terrain: tile.terrain, shape: tile.shape,
			// The drawing tilts by the grade as the train faces it, not as the leg stores it.
			grade: journey.forward ? tile.grade : -tile.grade,
			kilometresDone: travelled * this.TILE_KM,
			kilometresLeft: (tiles.length - 1 - travelled) * this.TILE_KM,
			fromStation: journey.forward ? journey.legIndex : journey.legIndex + 1,
			toStation: journey.forward ? journey.legIndex + 1 : journey.legIndex
		};
	},
	// One step along the line: direction 1 carries on, -1 backs up. Returns null where there is nowhere to go.
	getJourneyStep: function(direction) {
		var journey = this.getJourney();
		if (!journey) {
			return null;
		}
		var tiles = this.getMainLine(this.getSeed(), journey.legIndex);
		var from = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
		var to = from + (journey.forward ? 1 : -1) * (direction >= 0 ? 1 : -1);
		if (to < 0 || to >= tiles.length) {
			return null;
		}
		var train = State.variables.currentTrain;
		var grade = this.getStepGrade(tiles, from, to);
		var limit = this.getClimbLimitPercent(train);
		return {
			fromIndex: from, toIndex: to, grade: grade, terrain: tiles[to].terrain,
			minutes: this.getTileMinutes(grade, train),
			blocked: (this.getTrainTractiveKN(train) > 0 && grade > limit)
				? 'The grade ahead is ' + grade.toFixed(1) + '%, and your consist can pull ' + limit.toFixed(1) + '%.'
				: '',
			// Reaching either end of the line means arriving at the station standing there.
			arrivesAt: to === 0 ? journey.legIndex : (to === tiles.length - 1 ? journey.legIndex + 1 : 0)
		};
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
		// What the locomotives can pull now, not what they were built to: degraded diesel derates an engine.
		return train.reduce(function(total, car) {
			return total + setup.fuel.getEffectiveTractiveKN(car);
		}, 0);
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
	// Which leg a departure uses: heading on takes the leg ahead of the station, turning back takes the one behind.
	getLegIndexFor: function(stationId, towardExit) {
		return towardExit ? Math.floor(stationId) : Math.floor(stationId) - 1;
	},
	// Time over a leg, tile by tile. Climbing is slow and a heavy train is slower still; running downhill saves a
	// little. Fuel follows from the clock, because the time system burns fuel by the minute while travelling.
	getLegTravel: function(seed, legIndex, train, reverse) {
		var leg = this.getLeg(seed, legIndex);
		// Every tile but the last carries one step to its neighbour, and that step's grade. The same steps are
		// travelled either way round, so running the leg backwards is the same list of grades negated.
		var steps = leg.tiles.filter(function(tile) { return !tile.branch && tile.out !== -1; });
		var minutes = 0;
		var steepestClimb = 0;
		for (var i = 0; i < steps.length; i++) {
			var grade = reverse ? -steps[i].grade : steps[i].grade;
			steepestClimb = Math.max(steepestClimb, grade);
			minutes += this.getTileMinutes(grade, train);
		}
		return {
			minutes: Math.max(1, minutes),
			tiles: steps.length + 1,
			kilometres: steps.length * this.TILE_KM,
			steepestClimb: steepestClimb,
			climbLimit: this.getClimbLimitPercent(train)
		};
	},
	getTravelMinutes: function(stationId, towardExit, train) {
		var legIndex = this.getLegIndexFor(stationId, towardExit);
		if (legIndex < 1) {
			return 5;
		}
		return this.getLegTravel(this.getSeed(), legIndex, train, !towardExit).minutes;
	},
	// A short line for the travel UI: how far the leg runs, how steep it gets, and what the consist can pull.
	getTravelSummary: function(stationId, towardExit, train) {
		var legIndex = this.getLegIndexFor(stationId, towardExit);
		if (legIndex < 1) {
			return '';
		}
		var travel = this.getLegTravel(this.getSeed(), legIndex, train, !towardExit);
		return travel.kilometres + ' km, steepest climb ' + travel.steepestClimb.toFixed(1) + '%'
			+ (travel.climbLimit > 0 ? ', your consist pulls ' + travel.climbLimit.toFixed(1) + '%' : '') + '.';
	},
	// Why the train cannot make this leg, or '' if it can. A consist with no locomotive is left to the drive
	// capability rules, which explain that case in their own words.
	getClimbBlockReason: function(stationId, towardExit, train) {
		if (!Array.isArray(train) || !train.length || !(this.getTrainTractiveKN(train) > 0)) {
			return '';
		}
		var legIndex = this.getLegIndexFor(stationId, towardExit);
		if (legIndex < 1) {
			return '';
		}
		var travel = this.getLegTravel(this.getSeed(), legIndex, train, !towardExit);
		if (travel.steepestClimb > travel.climbLimit) {
			return 'The line climbs ' + travel.steepestClimb.toFixed(1) + '% on the way, and your consist can pull '
				+ travel.climbLimit.toFixed(1) + '% at this weight.';
		}
		return '';
	},

	// --- debug map ----------------------------------------------------------------------------------------

	// A deliberately plain top-down map for debug mode: terrain as coloured cells and track as lines through
	// them. It is a look at what the generator produced, not a player-facing map.
	buildDebugMap: function(stationId, cellSize) {
		var seed = this.getSeed();
		var legIndex = Math.max(1, Math.floor(stationId));
		var leg = this.getLeg(seed, legIndex);
		var rect = leg.rect;
		var cell = cellSize || 9;
		var width = (rect.x1 - rect.x0 + 1) * cell;
		var height = (rect.y1 - rect.y0 + 1) * cell;
		var ns = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'worldmap-debug');
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
		// Screen y grows downwards while map y grows north, so rows are drawn from the top of the rectangle down.
		var left = function(x) { return (x - rect.x0) * cell; };
		var top = function(y) { return (rect.y1 - y) * cell; };

		for (var y = rect.y0; y <= rect.y1; y++) {
			for (var x = rect.x0; x <= rect.x1; x++) {
				var tile = leg.byKey[this.key(x, y)];
				var terrain = tile ? tile.terrain : this.getBaseTerrain(seed, x, y);
				var cellRect = document.createElementNS(ns, 'rect');
				cellRect.setAttribute('x', left(x));
				cellRect.setAttribute('y', top(y));
				cellRect.setAttribute('width', cell);
				cellRect.setAttribute('height', cell);
				cellRect.setAttribute('fill', this.TERRAIN_COLOURS[terrain] || '#000');
				cellRect.setAttribute('stroke', '#1b1d1f');
				cellRect.setAttribute('stroke-width', '0.5');
				var title = document.createElementNS(ns, 'title');
				title.textContent = x + ',' + y + ' ' + terrain
					+ (tile ? ' ' + tile.shape + ' ' + tile.grade.toFixed(1) + '%' : '')
					+ ' ' + this.getElevationMetres(seed, x, y) + ' m';
				cellRect.appendChild(title);
				svg.appendChild(cellRect);
			}
		}
		// Track: a line from the middle of a tile out to each end it points at.
		leg.tiles.forEach(function(tile) {
			var cx = left(tile.x) + cell / 2;
			var cy = top(tile.y) + cell / 2;
			tile.ends.forEach(function(end) {
				var direction = setup.worldmap.DIRECTIONS[end];
				var line = document.createElementNS(ns, 'line');
				line.setAttribute('x1', cx);
				line.setAttribute('y1', cy);
				line.setAttribute('x2', cx + direction.dx * cell / 2);
				line.setAttribute('y2', cy - direction.dy * cell / 2);
				line.setAttribute('stroke', tile.branch ? '#8a7a55' : '#d8d2c4');
				line.setAttribute('stroke-width', tile.branch ? '1' : '1.5');
				svg.appendChild(line);
			});
			if (tile.station) {
				var marker = document.createElementNS(ns, 'circle');
				marker.setAttribute('cx', cx);
				marker.setAttribute('cy', cy);
				marker.setAttribute('r', cell / 3);
				marker.setAttribute('fill', '#e5c58a');
				var markerTitle = document.createElementNS(ns, 'title');
				markerTitle.textContent = 'Station ' + tile.station;
				marker.appendChild(markerTitle);
				svg.appendChild(marker);
			}
		});
		return { svg: svg, leg: leg, rect: rect };
	},
	// Adds the map plus a line of numbers to a debug panel.
	appendDebugMap: function(parent, stationId) {
		if (!parent || typeof document === 'undefined') {
			return;
		}
		try {
			var built = this.buildDebugMap(stationId);
			var heading = document.createElement('p');
			var leg = built.leg;
			var mainLine = leg.tiles.filter(function(tile) { return !tile.branch; });
			var grades = mainLine.map(function(tile) { return tile.grade; });
			heading.textContent = 'World map, leg ' + leg.index + ' (station ' + leg.index + ' to ' + (leg.index + 1) + '): '
				+ mainLine.length + ' tiles, ' + (mainLine.length * this.TILE_KM) + ' km, grades '
				+ Math.min.apply(null, grades).toFixed(1) + '% to ' + Math.max.apply(null, grades).toFixed(1) + '%, '
				+ (leg.tiles.length - mainLine.length) + ' branch tiles. Seed ' + this.getSeed() + '.';
			parent.appendChild(heading);
			parent.appendChild(built.svg);
			var legend = document.createElement('p');
			legend.textContent = 'plains, forest, desert, arctic, mountain, bridge, tunnel, water. Hover a tile for its terrain, shape and grade.';
			parent.appendChild(legend);
		} catch (error) {
			var failure = document.createElement('p');
			failure.textContent = 'World map unavailable: ' + error.message;
			parent.appendChild(failure);
		}
	}
};
