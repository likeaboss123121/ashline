// The playable world between stations: sourced rail geometry resampled into fixed 5 km grid moves.
//
// setup.realWorldPilot owns the active route and station topology. This module supplies the common movement,
// grade, rendering and debug-map APIs used by the passages. The older seeded generator helpers remain below only
// as compatibility code for old saves and tests; getLeg() and getStationTile() always select the sourced route.
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
	REJOIN_CHANCE: 0.45, // of branches that try to find their way back to the main line rather than stopping dead
	MOUNTAIN_METRES: 1150,
	// Where the world sits, and what its climate does with that. Station 1 is Punta Arenas.
	BASE_LATITUDE: -53.2,
	BASE_LONGITUDE: -70.9,
	KM_PER_DEGREE: 111,
	ARCTIC_TEMPERATURE: 0, // degrees C, below which the ground stays frozen
	DESERT_HUMIDITY: 0.32,
	FOREST_HUMIDITY: 0.68,
	// Humidity by how far a tile lies from the equator: wet on the equator, dry under the trade winds, wet again
	// under the westerlies, and dry over the poles.
	HUMIDITY_BY_LATITUDE: [[0, 0.88], [12, 0.72], [25, 0.3], [33, 0.28], [45, 0.62], [58, 0.7], [70, 0.45], [90, 0.3]],
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
	// The climate of a tile: where it is, how high it stands, how warm it is and how wet. Terrain is read off these
	// numbers rather than rolled separately, so the world makes sense as you cross it: the dry belt sits where the
	// dry belt belongs, forests follow the rain, and it gets colder as you climb or leave the temperate latitudes.
	getClimate: function(seed, x, y) {
		var sourced = setup.realWorldPilot && setup.realWorldPilot.getTileAt ? setup.realWorldPilot.getTileAt(x, y) : null;
		if (sourced) {
			var sourcedLatitude = sourced.geoCoordinate[1], sourcedElevation = sourced.elevation;
			return { latitude: sourcedLatitude, longitude: sourced.geoCoordinate[0], elevation: sourcedElevation,
				temperature: 34 - 0.48 * Math.abs(sourcedLatitude) - sourcedElevation * 0.0065, humidity: 0.5 };
		}
		var latitude = this.BASE_LATITUDE + (y * this.TILE_KM) / this.KM_PER_DEGREE;
		// A degree of longitude is shorter the further from the equator you stand.
		var shrink = Math.max(0.25, Math.cos(latitude * Math.PI / 180));
		var longitude = this.BASE_LONGITUDE + (x * this.TILE_KM) / (this.KM_PER_DEGREE * shrink);
		var elevation = this.getElevationMetres(seed, x, y);
		var away = Math.abs(latitude);
		// Warm at the equator, colder toward the poles, and colder still with height, give or take the weather.
		var temperature = 34 - 0.48 * away - elevation * 0.0065
			+ (this.smoothNoise(seed, 'temp', x, y, 12) - 0.5) * 8;
		// Wet on the equator, dry in the trade wind belts, wet again under the westerlies, dry at the poles.
		var humidity = Math.max(0, Math.min(1, this.interpolateBand(away, this.HUMIDITY_BY_LATITUDE)
			+ (this.smoothNoise(seed, 'humid', x, y, 9) - 0.5) * 0.45));
		return {
			latitude: latitude, longitude: longitude, elevation: elevation,
			temperature: temperature, humidity: humidity
		};
	},
	// Reads a value off a table of [degrees, value] anchors, sloping smoothly between them.
	interpolateBand: function(degrees, band) {
		for (var i = 1; i < band.length; i++) {
			if (degrees <= band[i][0]) {
				var span = band[i][0] - band[i - 1][0];
				var along = span > 0 ? (degrees - band[i - 1][0]) / span : 0;
				return band[i - 1][1] + (band[i][1] - band[i - 1][1]) * along;
			}
		}
		return band[band.length - 1][1];
	},
	getBaseTerrain: function(seed, x, y) {
		var sourced = setup.realWorldPilot && setup.realWorldPilot.getTileAt ? setup.realWorldPilot.getTileAt(x, y) : null;
		if (sourced) return sourced.terrain;
		// Water is where the land is not, and is decided before any climate question.
		if (this.smoothNoise(seed, 'water', x, y, 7) > 0.74) {
			return 'water';
		}
		var climate = this.getClimate(seed, x, y);
		if (climate.elevation > this.MOUNTAIN_METRES) {
			return 'mountain';
		}
		if (climate.temperature < this.ARCTIC_TEMPERATURE) {
			return 'arctic';
		}
		if (climate.humidity < this.DESERT_HUMIDITY) {
			return 'desert';
		}
		if (climate.humidity > this.FOREST_HUMIDITY) {
			return 'forest';
		}
		return 'plains';
	},
	// Whether there is water to pump from: the tile itself is water (the line is bridging it), or one of the eight
	// tiles around it is.
	isBesideWater: function(seed, x, y) {
		var sourced = setup.realWorldPilot && setup.realWorldPilot.getTileAt ? setup.realWorldPilot.getTileAt(x, y) : null;
		if (sourced) return sourced.terrain === 'bridge';
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
	// The compass name a player would use for a direction, rather than the two letters the map stores.
	COMPASS_NAMES: { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west' },
	describeDirection: function(index) {
		var direction = this.DIRECTIONS[index];
		return direction ? this.COMPASS_NAMES[direction.name] : '';
	},
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
		if (setup.realWorldPilot && setup.realWorldPilot.getStationTile) {
			return setup.realWorldPilot.getStationTile(stationId) || { x: 0, y: 0 };
		}
		if (this.isBranchStation(stationId)) {
			var branch = this.getBranchForStation(seed, stationId);
			return branch ? branch.tiles[branch.tiles.length - 1] : { x: 0, y: 0 };
		}
		var id = Math.floor(Number(stationId));
		if (!isFinite(id) || id < 1) {
			return { x: 0, y: 0 }; // a station id the map does not place, such as one from a branch it cannot find
		}
		var cache = this.cacheFor(seed);
		if (cache.stations[id]) {
			return cache.stations[id];
		}
		cache.stations[id] = id === 1 ? { x: 0, y: 0 } : this.getLeg(seed, id - 1).end;
		return cache.stations[id];
	},
	getLeg: function(seed, legIndex) {
		if (setup.realWorldPilot && setup.realWorldPilot.getLeg) return setup.realWorldPilot.getLeg(legIndex);
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
		var headingName = { north: 'n', northeast: 'ne', east: 'e', southeast: 'se', south: 's', southwest: 'sw',
			west: 'w', northwest: 'nw' }[setup.railyard.getLegHeading(legIndex, seed)] || 'n';
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
		var branches = this.addBranches(seed, legIndex, tiles, byKey, rng);
		return {
			index: legIndex, tiles: tiles, byKey: byKey, branches: branches,
			start: { x: start.x, y: start.y }, end: { x: x, y: y },
			rect: this.rectFor(tiles)
		};
	},
	// Abandoned branches: a junction on the main line and a few tiles of track that stop at a dead end. They go
	// nowhere yet, and become real routes once the world has somewhere to put them.
	addBranches: function(seed, legIndex, tiles, byKey, rng) {
		var self = this;
		var mainLine = tiles.slice();
		var branches = [];
		var mainIndexByKey = {};
		mainLine.forEach(function(tile, index) { mainIndexByKey[self.key(tile.x, tile.y)] = index; });
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
			var branch = this.buildBranch(seed, legIndex, i, tile, branchDirection, byKey, rng, mainIndexByKey, mainLine);
			if (!branch.tiles.length) {
				continue;
			}
			tile.ends = junctionEnds;
			tile.shape = junctionShape;
			branch.tiles.forEach(function(branchTile) {
				tiles.push(branchTile);
				byKey[self.key(branchTile.x, branchTile.y)] = branchTile;
			});
			branches.push(this.finishBranch(legIndex, branches.length, i, branchDirection, branch));
			// Now and then a second branch leaves the far side of the same tile, and the lines cross there.
			var acrossDirection = this.opposite(branchDirection);
			if (rng() < 0.2 && tile.ends.indexOf(acrossDirection) === -1) {
				var crossEnds = tile.ends.concat([acrossDirection]).sort(function(a, b) { return a - b; });
				var crossShape = this.getShape(crossEnds);
				if (this.canPlace(tile.terrain, crossShape)) {
					var across = this.buildBranch(seed, legIndex, i, tile, acrossDirection, byKey, rng, mainIndexByKey, mainLine);
					if (across.tiles.length) {
						tile.ends = crossEnds;
						tile.shape = crossShape;
						across.tiles.forEach(function(branchTile) {
							tiles.push(branchTile);
							byKey[self.key(branchTile.x, branchTile.y)] = branchTile;
						});
						branches.push(this.finishBranch(legIndex, branches.length, i, acrossDirection, across));
					}
				}
			}
		}
		return branches;
	},
	// A branch, as the rest of the game sees it. One that does not find the main line again ends at a station of
	// its own, so every track the player can take leads somewhere they can stop, shunt and turn round.
	finishBranch: function(legIndex, ordinal, fromIndex, direction, built) {
		var branch = {
			id: legIndex + ':' + fromIndex + ':' + direction, legIndex: legIndex, fromIndex: fromIndex,
			direction: direction, tiles: built.tiles, rejoinIndex: built.rejoinIndex, stationId: null
		};
		if (built.rejoinIndex === null && built.tiles.length) {
			branch.stationId = 'L' + legIndex + 'B' + (ordinal + 1);
			built.tiles[built.tiles.length - 1].station = branch.stationId;
		}
		return branch;
	},
	// Station ids are numbers along the main line, and 'L3B1' for the terminus of a branch off leg 3.
	isBranchStation: function(stationId) {
		return /^L\d+B\d+$/.test(String(stationId));
	},
	getBranchForStation: function(seed, stationId) {
		var match = /^L(\d+)B(\d+)$/.exec(String(stationId));
		if (!match) {
			return null;
		}
		var branches = this.getLeg(seed, Number(match[1])).branches || [];
		return branches.filter(function(branch) { return branch.stationId === stationId; })[0] || null;
	},
	// What the player calls a station.
	getStationName: function(stationId) {
		if (setup.realWorldPilot && setup.realWorldPilot.getStation) {
			var station = setup.realWorldPilot.getStation(stationId);
			if (station) return station.name;
		}
		return 'Station ' + String(stationId).replace(/^L/, '').replace('B', 'B');
	},
	// One branch off the main line. Most wander a few tiles and stop at a buffer stop; some bend back and meet the
	// main line again further along, which makes them a real alternative route rather than a dead end with a view.
	buildBranch: function(seed, legIndex, tileIndex, junction, direction, byKey, rng, mainIndexByKey, mainLine) {
		var wantsRejoin = rng() < this.REJOIN_CHANCE;
		var length = wantsRejoin ? 6 : 2 + Math.floor(rng() * 4);
		// A branch meant to rejoin curves steadily back toward the line it left, turning the shorter way round.
		var turnSign = ((direction - (junction.out >= 0 ? junction.out : direction) + 8) % 8) < 4 ? -1 : 1;
		var made = [];
		var rejoinIndex = null;
		var travel = direction;
		var position = this.step(junction.x, junction.y, direction);
		for (var i = 0; i < length; i++) {
			var occupied = byKey[this.key(position.x, position.y)];
			if (occupied) {
				// Running into the main line further along is how a branch rejoins it, if the junction fits there.
				var meetIndex = mainIndexByKey ? mainIndexByKey[this.key(position.x, position.y)] : undefined;
				if (wantsRejoin && made.length && typeof meetIndex === 'number' && meetIndex > tileIndex + 1
					&& !occupied.station) {
					var meetEnds = occupied.ends.concat([this.opposite(travel)]).sort(function(a, b) { return a - b; });
					var meetShape = this.getShape(meetEnds);
					if (occupied.ends.indexOf(this.opposite(travel)) === -1 && this.canPlace(occupied.terrain, meetShape)) {
						occupied.ends = meetEnds;
						occupied.shape = meetShape;
						rejoinIndex = meetIndex;
					}
				}
				break;
			}
			var last = i === length - 1;
			var out = last ? -1
				: wantsRejoin ? (travel + turnSign + 8) % 8
				: (rng() < 0.75 ? travel : (rng() < 0.5 ? (travel + 1) % 8 : (travel + 7) % 8));
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
				out: out, incoming: this.opposite(travel), station: 0, branch: true
			});
			if (out === -1) {
				break;
			}
			position = this.step(position.x, position.y, out);
			travel = out;
		}
		if (made.length && rejoinIndex === null) {
			var end = made[made.length - 1];
			end.ends = [end.incoming];
			end.shape = 'dead-end';
			end.out = -1;
			end.grade = 0;
		} else if (made.length) {
			// The last tile of a rejoining branch points at the main line tile it meets.
			var last = made[made.length - 1];
			var meetTile = mainLine[rejoinIndex];
			var toward = this.directionBetween(last, meetTile);
			if (toward === -1) {
				rejoinIndex = null;
				last.ends = [last.incoming];
				last.shape = 'dead-end';
				last.out = -1;
				last.grade = 0;
			} else {
				last.ends = [last.incoming, toward].sort(function(a, b) { return a - b; });
				last.shape = this.getShape(last.ends);
				last.out = toward;
				last.grade = this.getGradePercent(seed, last.x, last.y, toward);
			}
		}
		return { tiles: made, rejoinIndex: rejoinIndex };
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
	// The leg's main line, station tile to station tile, as the positions a train can stand on. Branch tiles are
	// not part of it: they lead nowhere yet.
	getMainLine: function(seed, legIndex) {
		var sourcedLeg = this.getLeg(seed, legIndex);
		if (sourcedLeg && sourcedLeg.realWorld) return sourcedLeg.tiles;
		var cache = this.cacheFor(seed);
		if (!cache.mainLines) {
			cache.mainLines = {};
		}
		if (!cache.mainLines[legIndex]) {
			cache.mainLines[legIndex] = this.getLeg(seed, legIndex).tiles.filter(function(tile) { return !tile.branch; });
		}
		return cache.mainLines[legIndex];
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
	// The grade of the step between two neighbouring positions, in the direction it is taken.
	getStepGrade: function(tiles, fromIndex, toIndex) {
		return toIndex > fromIndex ? tiles[fromIndex].grade : -tiles[toIndex].grade;
	},
	// --- a journey in progress -----------------------------------------------------------------------------
	getJourney: function() {
		var journey = State.variables && State.variables.journey;
		return journey && (typeof journey.legIndex === 'number' || journey.realWorldCorridorId) ? journey : null;
	},
	// The run of tiles the train is standing on: the leg's main line, or a branch off it if the player took one.
	getJourneyPath: function(position) {
		var journey = position || this.getJourney();
		if (!journey) {
			return null;
		}
		var leg = this.getLeg(this.getSeed(), journey.legIndex);
		if (!leg) return null;
		if (journey.branch) {
			var taken = (leg.branches || []).filter(function(branch) { return branch.id === journey.branch; })[0];
			if (taken) {
				return { tiles: taken.tiles, branch: taken, leg: leg };
			}
		}
		return { tiles: this.getMainLine(this.getSeed(), journey.legIndex), branch: null, leg: leg };
	},
	// The branches leaving the tile the train is standing on, for the player to choose between.
	getBranchChoices: function() {
		var journey = this.getJourney();
		var path = this.getJourneyPath();
		if (!journey || !path || path.branch) {
			return [];
		}
		var self = this;
		return (path.leg.branches || []).filter(function(branch) {
			return branch.fromIndex === journey.tileIndex && branch.tiles.length;
		}).map(function(branch) {
			return {
				id: branch.id, direction: self.describeDirection(branch.direction),
				tiles: branch.tiles.length, terrain: branch.tiles[0].terrain,
				rejoins: branch.rejoinIndex !== null,
				grade: self.getGradePercent(self.getSeed(), path.tiles[journey.tileIndex].x,
					path.tiles[journey.tileIndex].y, branch.direction)
			};
		});
	},
	// Where the consist stands, for the driving view and the status line.
	// The track between a tile and the next one along: a fixed 5 km on the old grid, whatever lies between two squares
	// on the geographic one.
	getStepKm: function(tiles, index) {
		var tile = tiles[index];
		return tile && Number(tile.distanceKm) > 0 ? Number(tile.distanceKm) : this.TILE_KM;
	},
	getJourneyView: function(position) {
		var journey = position || this.getJourney();
		if (!journey) {
			return null;
		}
		var path = this.getJourneyPath(journey);
		var tiles = path.tiles;
		if (path.leg.realWorld) {
			var realIndex = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
			var travelled = journey.forward !== false ? realIndex : tiles.length - 1 - realIndex;
			var behind = 0, total = 0;
			for (var stepIndex = 0; stepIndex < tiles.length - 1; stepIndex++) {
				var stepKm = this.getStepKm(tiles, stepIndex);
				total += stepKm;
				if (journey.forward !== false ? stepIndex < realIndex : stepIndex >= realIndex) behind += stepKm;
			}
			return {
				realWorld: true, corridorId: path.leg.corridorId, legIndex: journey.legIndex,
				tileIndex: realIndex, tileCount: tiles.length, forward: journey.forward !== false,
				tile: tiles[realIndex], terrain: tiles[realIndex].terrain, shape: tiles[realIndex].shape,
				grade: journey.forward !== false ? tiles[realIndex].grade : -tiles[Math.max(0, realIndex - 1)].grade,
				kilometresDone: Math.round(behind),
				kilometresLeft: Math.round(total - behind),
				fromStation: journey.forward !== false ? path.leg.fromStation.name : path.leg.toStation.name,
				toStation: journey.forward !== false ? path.leg.toStation.name : path.leg.fromStation.name,
				fromStationIndex: journey.forward !== false ? path.leg.fromStationIndex : path.leg.toStationIndex,
				toStationIndex: journey.forward !== false ? path.leg.toStationIndex : path.leg.fromStationIndex
			};
		}
		if (path.branch) {
			var onBranch = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
			var branchTile = tiles[onBranch];
			return {
				legIndex: journey.legIndex, tileIndex: onBranch, tileCount: tiles.length, forward: journey.forward,
				tile: branchTile, terrain: branchTile.terrain, shape: branchTile.shape,
				grade: branchTile.grade, branch: path.branch.id, rejoins: path.branch.rejoinIndex !== null,
				kilometresDone: onBranch * this.TILE_KM,
				kilometresLeft: (tiles.length - 1 - onBranch) * this.TILE_KM,
				fromStation: journey.legIndex, toStation: journey.legIndex + 1
			};
		}
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
			arrivesAt: 0, toBranch: null, toMain: null
		};
		for (var key in extra) {
			if (Object.prototype.hasOwnProperty.call(extra, key)) {
				step[key] = extra[key];
			}
		}
		return step;
	},
	// One step along the line: direction 1 carries on, -1 backs up. On a branch, 1 runs further out and -1 comes
	// back toward the junction, and either end of a branch may put the train back on the main line. Returns null
	// where there is nowhere to go.
	getJourneyStep: function(direction, position) {
		var journey = position || this.getJourney();
		var path = this.getJourneyPath(journey);
		if (!journey || !path) {
			return null;
		}
		var tiles = path.tiles;
		var from = Math.max(0, Math.min(journey.tileIndex, tiles.length - 1));
		if (path.leg.realWorld) {
			var realTo = from + (journey.forward !== false ? 1 : -1) * (direction >= 0 ? 1 : -1);
			if (realTo < 0 || realTo >= tiles.length) return null;
			var forwardStep = realTo > from;
			var realStep = this.describeStep(forwardStep ? tiles[from].grade : -tiles[realTo].grade, tiles[realTo].terrain, {
				fromIndex: from, toIndex: realTo, realWorld: true,
				distanceKm: this.getStepKm(tiles, Math.min(from, realTo)),
				heading: this.describeDirection(forwardStep ? tiles[from].out : this.opposite(tiles[realTo].out)),
				destinationName: tiles[realTo].station || '',
				arrivesAt: realTo === 0 ? path.leg.fromStationIndex : (realTo === tiles.length - 1 ? path.leg.toStationIndex : 0)
			});
			return realStep;
		}
		if (path.branch) {
			var branch = path.branch;
			var out = from + (direction >= 0 ? 1 : -1);
			if (out < 0) {
				// Back out of the branch onto the main line tile the junction stands on.
				var mainTiles = this.getMainLine(this.getSeed(), journey.legIndex);
				return this.describeStep(-tiles[0].grade, mainTiles[branch.fromIndex].terrain,
					{ fromIndex: from, toIndex: branch.fromIndex, toMain: branch.fromIndex,
						heading: this.describeDirection(this.opposite(branch.direction)) });
			}
			if (out >= tiles.length) {
				if (branch.rejoinIndex === null) {
					return null; // the branch stops here
				}
				var rejoinTiles = this.getMainLine(this.getSeed(), journey.legIndex);
				return this.describeStep(tiles[tiles.length - 1].grade, rejoinTiles[branch.rejoinIndex].terrain,
					{ fromIndex: from, toIndex: branch.rejoinIndex, toMain: branch.rejoinIndex,
						heading: this.describeDirection(tiles[tiles.length - 1].out) });
			}
			return this.describeStep(this.getStepGrade(tiles, from, out), tiles[out].terrain,
				{ fromIndex: from, toIndex: out,
					arrivesAt: (out === tiles.length - 1 && branch.stationId) ? branch.stationId : 0,
					heading: this.describeDirection(out > from ? tiles[from].out : this.opposite(tiles[out].out)) });
		}
		var to = from + (journey.forward ? 1 : -1) * (direction >= 0 ? 1 : -1);
		if (to < 0 || to >= tiles.length) {
			return null;
		}
		return this.describeStep(this.getStepGrade(tiles, from, to), tiles[to].terrain, {
			fromIndex: from, toIndex: to,
			heading: this.describeDirection(to > from ? tiles[from].out : this.opposite(tiles[to].out)),
			// Reaching either end of the line means arriving at the station standing there.
			arrivesAt: to === 0 ? journey.legIndex : (to === tiles.length - 1 ? journey.legIndex + 1 : 0)
		});
	},
	// What turning off onto a branch would cost.
	getBranchStep: function(branchId) {
		var journey = this.getJourney();
		var path = this.getJourneyPath();
		if (!journey || !path || path.branch) {
			return null;
		}
		var branch = (path.leg.branches || []).filter(function(candidate) { return candidate.id === branchId; })[0];
		if (!branch || branch.fromIndex !== journey.tileIndex || !branch.tiles.length) {
			return null;
		}
		var junction = path.tiles[journey.tileIndex];
		return this.describeStep(this.getGradePercent(this.getSeed(), junction.x, junction.y, branch.direction),
			branch.tiles[0].terrain, { fromIndex: journey.tileIndex, toIndex: 0, toBranch: branch.id,
				heading: this.describeDirection(branch.direction) });
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
	// Which leg a departure uses: heading on takes the leg ahead of the station, turning back takes the one behind.
	// A branch terminus is on no leg of its own; leaving one is handled by the branch it stands at the end of.
	getLegIndexFor: function(stationId, towardExit, legIndex) {
		var line = this.getLine(stationId, towardExit, legIndex);
		return line ? line.legIndex : 0;
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
	getLegTravel: function(seed, legIndex, train, reverse) {
		var leg = this.getLeg(seed, legIndex);
		if (!leg) return { minutes: 0, tiles: 0, kilometres: 0, steepestClimb: 0,
			climbLimit: this.getClimbLimitPercent(train) };
		// Every tile but the last carries one step to its neighbour, and that step's grade. The same steps are
		// travelled either way round, so running the leg backwards is the same list of grades negated.
		var steps = leg.realWorld ? leg.tiles.slice(0, -1)
			: leg.tiles.filter(function(tile) { return !tile.branch && tile.out !== -1; });
		var minutes = 0;
		var steepestClimb = 0;
		var kilometres = 0;
		for (var i = 0; i < steps.length; i++) {
			var grade = reverse ? -steps[i].grade : steps[i].grade;
			var stepKm = leg.realWorld ? this.getStepKm(leg.tiles, i) : this.TILE_KM;
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
		return this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward).minutes;
	},
	// A short line for the travel UI: how far the leg runs, how steep it gets, and what the consist can pull.
	getTravelSummary: function(stationId, towardExit, train, legIndex) {
		var line = this.getLine(stationId, towardExit, legIndex);
		if (!line) {
			return '';
		}
		var travel = this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward);
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
		var travel = this.getLegTravel(this.getSeed(), line.legIndex, train, !line.forward);
		if (travel.steepestClimb > travel.climbLimit) {
			return 'The line climbs ' + travel.steepestClimb.toFixed(1) + '% on the way, and your consist can pull '
				+ travel.climbLimit.toFixed(1) + '% at this weight.';
		}
		return '';
	},
	// Resolves one generated track tile into the journey coordinates used by trains and walkers. Debug tools use
	// coordinates rather than array offsets so the map remains the source of truth for what was clicked.
	getDebugTeleportTarget: function(legIndex, x, y) {
		if (setup.realWorldPilot && setup.realWorldPilot.debugTarget) return setup.realWorldPilot.debugTarget(x, y);
		var leg = this.getLeg(this.getSeed(), legIndex);
		var mainLine = this.getMainLine(this.getSeed(), legIndex);
		for (var mainIndex = 0; mainIndex < mainLine.length; mainIndex++) {
			if (mainLine[mainIndex].x === x && mainLine[mainIndex].y === y) {
				return { legIndex: legIndex, tileIndex: mainIndex, branch: null, tile: mainLine[mainIndex] };
			}
		}
		for (var branchIndex = 0; branchIndex < leg.branches.length; branchIndex++) {
			var branch = leg.branches[branchIndex];
			for (var tileIndex = 0; tileIndex < branch.tiles.length; tileIndex++) {
				if (branch.tiles[tileIndex].x === x && branch.tiles[tileIndex].y === y) {
					return { legIndex: legIndex, tileIndex: tileIndex, branch: branch.id, tile: branch.tiles[tileIndex] };
				}
			}
		}
		return null;
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
				variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex, branch: null, inRailyard: true };
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
			variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex, branch: target.branch };
			return { mode: 'player', passage: 'OnFoot', target: target };
		}
		var forward = currentJourney && currentJourney.legIndex === target.legIndex
			? currentJourney.forward !== false : variables.travellingForward !== false;
		variables.currentStation = forward ? target.legIndex : target.legIndex + 1;
		variables.journey = {
			legIndex: target.legIndex, tileIndex: target.tileIndex, forward: forward
		};
		if (target.branch) variables.journey.branch = target.branch;
		if (activeTrain) {
			variables.onFoot = null;
			return { mode: 'consist', passage: State.passage === 'TrainInterior' ? 'TrainInterior' : 'OnTheLine', target: target };
		}
		variables.onFoot = { legIndex: target.legIndex, tileIndex: target.tileIndex, branch: target.branch };
		return { mode: 'player', passage: 'OnFoot', target: target };
	},
	// --- debug map ----------------------------------------------------------------------------------------
	// A deliberately plain top-down map for debug mode: terrain as coloured cells and track as lines through
	// them. It is a look at what the network builder produced, not a player-facing map.
	// The middle of a grid square as [longitude, latitude], from the grid's projection (scripts/world/projection.cjs).
	unprojectGrid: function(x, y, grid) {
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
		return [Math.round(lambda / radians * 1e5) / 1e5, Math.round(phi / radians * 1e5) / 1e5];
	},
	// The network as a drawing: a plain square per grid square, in its terrain's colour and a teleport target; the
	// track as one path of mapped railway and one of new lines, a fixed width on screen so it shows however far out the
	// map is zoomed; a marker per station with the authored cities named; and the train and the walker. A continent
	// is tens of thousands of squares, so there is no tooltip or keyboard stop per square: the readout under the map
	// names the square under the pointer, and the station list is the keyboard way to teleport.
	//
	// Only what is in view is drawn (see redraw), and the squares and station markers only once the map is zoomed in
	// far enough to click them; zoomed out, the two track paths are the whole map.
	DEBUG_MAP_MARGIN_CELLS: 60, // 300 km of empty ground around the network, so none of it sits against the edge
	DEBUG_MAP_DETAIL_PX: 3, // on screen: a square smaller than this is too small to click, and is not drawn
	DEBUG_MAP_CHUNK_CELLS: 32,
	buildDebugMap: function(stationId, cellSize) {
		var route = setup.realWorldPilot.getGridRoute(), network = route.rect, margin = this.DEBUG_MAP_MARGIN_CELLS;
		var rect = { x0: network.x0 - margin, x1: network.x1 + margin, y0: network.y0 - margin, y1: network.y1 + margin };
		var leg = { tiles: route.tiles, byKey: route.byKey, corridor: route.corridor, rect: network };
		var cell = cellSize || 9;
		var width = (rect.x1 - rect.x0 + 1) * cell;
		var height = (rect.y1 - rect.y0 + 1) * cell;
		var ns = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'worldmap-debug');
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
		svg.style.width = 'min(100%, ' + Math.max(280, width) + 'px)';
		svg.style.height = 'auto';
		// Screen y grows downwards while map y grows north, so rows are drawn from the top of the rectangle down.
		var left = function(x) { return (x - rect.x0) * cell; };
		var top = function(y) { return (rect.y1 - y) * cell; };
		// One background for the empty ground, rather than a square for every empty cell.
		var ground = document.createElementNS(ns, 'rect');
		ground.setAttribute('x', 0);
		ground.setAttribute('y', 0);
		ground.setAttribute('width', width);
		ground.setAttribute('height', height);
		ground.setAttribute('fill', '#1b1d1f');
		ground.setAttribute('class', 'debug-map-ground');
		svg.appendChild(ground);
		var self = this;
		var squares = document.createElementNS(ns, 'g');
		squares.setAttribute('class', 'debug-map-squares');
		svg.appendChild(squares);
		var paths = [['#d8d2c4', 'debug-map-track'], ['#d9624f', 'debug-map-track debug-map-new-track']].map(function(entry) {
			var path = document.createElementNS(ns, 'path');
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', entry[0]);
			path.setAttribute('stroke-width', '1.5');
			path.setAttribute('vector-effect', 'non-scaling-stroke');
			path.setAttribute('pointer-events', 'none');
			path.setAttribute('class', entry[1]);
			svg.appendChild(path);
			return path;
		});
		var stations = document.createElementNS(ns, 'g');
		stations.setAttribute('class', 'debug-map-stations');
		svg.appendChild(stations);
		// The squares in blocks, so drawing a view only looks at the blocks it covers.
		var chunk = this.DEBUG_MAP_CHUNK_CELLS, chunks = {};
		route.tiles.forEach(function(tile) {
			var key = Math.floor(tile.x / chunk) + ',' + Math.floor(tile.y / chunk);
			(chunks[key] = chunks[key] || []).push(tile);
		});
		var drawn = null;
		// Draws what the frame shows, and a screen more each way so a short scroll needs nothing new. Called on every
		// scroll and zoom; it does nothing while the view stays inside what is already drawn at the same zoom.
		var redraw = function(frame) {
			if (!frame || !frame.clientWidth) return;
			var box = svg.getBoundingClientRect(), frameBox = frame.getBoundingClientRect(), scale = box.width / width;
			if (!scale) return;
			var detail = cell * scale >= self.DEBUG_MAP_DETAIL_PX;
			var spanX = Math.ceil(frame.clientWidth / scale / cell), spanY = Math.ceil(frame.clientHeight / scale / cell);
			var column = Math.floor((frameBox.left - box.left) / scale / cell), row = Math.floor((frameBox.top - box.top) / scale / cell);
			var view = { x0: rect.x0 + column, x1: rect.x0 + column + spanX, y0: rect.y1 - row - spanY, y1: rect.y1 - row };
			if (drawn && drawn.scale === scale && view.x0 >= drawn.x0 && view.x1 <= drawn.x1 && view.y0 >= drawn.y0
				&& view.y1 <= drawn.y1) return;
			drawn = { scale: scale, x0: view.x0 - spanX, x1: view.x1 + spanX, y0: view.y0 - spanY, y1: view.y1 + spanY };
			var tileSquares = document.createDocumentFragment(), stationMarkers = document.createDocumentFragment();
			var railPath = [], newPath = [];
			for (var cx = Math.floor(drawn.x0 / chunk); cx <= Math.floor(drawn.x1 / chunk); cx++) {
				for (var cy = Math.floor(drawn.y0 / chunk); cy <= Math.floor(drawn.y1 / chunk); cy++) {
					(chunks[cx + ',' + cy] || []).forEach(function(tile) {
						if (tile.x < drawn.x0 || tile.x > drawn.x1 || tile.y < drawn.y0 || tile.y > drawn.y1) return;
						var middleX = left(tile.x) + cell / 2, middleY = top(tile.y) + cell / 2;
						tile.ends.forEach(function(end) {
							var direction = self.DIRECTIONS[end];
							(tile.gapFill ? newPath : railPath).push('M' + middleX + ' ' + middleY + 'L'
								+ (middleX + direction.dx * cell / 2) + ' ' + (middleY - direction.dy * cell / 2));
						});
						if (!detail) return;
						var square = document.createElementNS(ns, 'rect');
						square.setAttribute('x', left(tile.x));
						square.setAttribute('y', top(tile.y));
						square.setAttribute('width', cell);
						square.setAttribute('height', cell);
						square.setAttribute('fill', self.TERRAIN_COLOURS[tile.terrain] || '#000');
						square.setAttribute('stroke', '#1b1d1f');
						square.setAttribute('stroke-width', '0.5');
						square.setAttribute('class', 'debug-teleport-tile' + (tile.gapFill ? ' debug-gap-tile' : ''));
						square.setAttribute('data-debug-teleport', '0:' + tile.x + ':' + tile.y);
						if (tile.stationIndex) square.setAttribute('data-station-index', String(tile.stationIndex));
						tileSquares.appendChild(square);
						if (!tile.station) return;
						var marker = document.createElementNS(ns, 'circle');
						marker.setAttribute('cx', middleX);
						marker.setAttribute('cy', middleY);
						marker.setAttribute('r', cell / 3);
						marker.setAttribute('fill', '#e5c58a');
						marker.setAttribute('pointer-events', 'none');
						stationMarkers.appendChild(marker);
					});
				}
			}
			squares.textContent = '';
			squares.appendChild(tileSquares);
			stations.textContent = '';
			stations.appendChild(stationMarkers);
			paths[0].setAttribute('d', railPath.join(''));
			paths[1].setAttribute('d', newPath.join(''));
		};
		// Cities are named on the map at every zoom; the other stations are only markers, or the labels would overlap.
		route.tiles.forEach(function(tile) {
			if (!tile.station || tile.stationStatus !== 'city') return;
			var label = document.createElementNS(ns, 'text');
			label.setAttribute('x', left(tile.x) + cell * 1.5);
			label.setAttribute('y', top(tile.y) + cell * 5 / 6);
			label.setAttribute('fill', '#e5c58a');
			label.setAttribute('font-size', String(cell * 1.4));
			label.setAttribute('font-family', 'sans-serif');
			label.setAttribute('pointer-events', 'none');
			label.setAttribute('class', 'debug-station-label');
			label.textContent = tile.station;
			svg.appendChild(label);
		});
		// Where the train is standing, and which way it is going, so the map can be read against the journey.
		var here = this.getJourneyView();
		var hasTrain = Array.isArray(State.variables.currentTrain) && State.variables.currentTrain.length > 0;
		if (hasTrain && here && here.realWorld) {
			var marker = document.createElementNS(ns, 'polygon');
			var mx = left(here.tile.x) + cell / 2;
			var my = top(here.tile.y) + cell / 2;
			var out = here.tile.out >= 0 ? here.tile.out : 0;
			var facing = here.forward ? out : this.opposite(out);
			var pointer = this.DIRECTIONS[facing];
			var angle = Math.atan2(-pointer.dy, pointer.dx);
			var point = function(distance, spread) {
				return (mx + Math.cos(angle + spread) * distance) + ',' + (my + Math.sin(angle + spread) * distance);
			};
			marker.setAttribute('points', [point(cell * 0.55, 0), point(cell * 0.45, 2.5), point(cell * 0.45, -2.5)].join(' '));
			marker.setAttribute('fill', '#e0625c');
			marker.setAttribute('pointer-events', 'none');
			var markerTitle = document.createElementNS(ns, 'title');
			markerTitle.textContent = 'Your train, heading ' + this.describeDirection(facing);
			marker.appendChild(markerTitle);
			svg.appendChild(marker);
		}
		// Walking has a position separate from the parked train. Draw it even when there is no active consist, rather
		// than presenting the route-context journey as a phantom train.
		var footPosition = setup.onfoot && setup.onfoot.getPosition ? setup.onfoot.getPosition() : null;
		var footView = footPosition && this.getJourneyView(footPosition);
		if (footView && footView.realWorld) {
			var footMarker = document.createElementNS(ns, 'circle');
			footMarker.setAttribute('cx', left(footView.tile.x) + cell / 2);
			footMarker.setAttribute('cy', top(footView.tile.y) + cell / 2);
			footMarker.setAttribute('r', cell * 0.42);
			footMarker.setAttribute('fill', 'none');
			footMarker.setAttribute('stroke', '#e0625c');
			footMarker.setAttribute('stroke-width', '1.5');
			footMarker.setAttribute('pointer-events', 'none');
			var footTitle = document.createElementNS(ns, 'title');
			footTitle.textContent = 'You are here on foot';
			footMarker.appendChild(footTitle);
			svg.appendChild(footMarker);
		}
		// Where the map should open: the train, else the player on foot, else the station they are in.
		var focusTile = hasTrain && here && here.realWorld ? here.tile
			: setup.onfoot && setup.onfoot.isOnFoot() ? setup.onfoot.getTile()
				: setup.realWorldPilot.getStationTile(Number(State.variables.currentStation) || 1);
		return { svg: svg, leg: leg, rect: rect, cell: cell, redraw: redraw,
			corridorCentre: { x: left((leg.rect.x0 + leg.rect.x1) / 2), y: top((leg.rect.y0 + leg.rect.y1) / 2) },
			focus: focusTile ? { x: left(focusTile.x) + cell / 2, y: top(focusTile.y) + cell / 2 } : null };
	},
	// Adds the map plus a line of numbers to a debug panel.
	// Zoom for the debug map. It opens fitted to the width of the panel, as before; "Whole map" shrinks it until the
	// entire drawing is in view, and the buttons, Ctrl+wheel or a trackpad pinch zoom from there. Zooming only
	// resizes the drawing that is already on the page and keeps the point under the pointer (or the middle of the
	// view) where it was. A mouse can also drag the map around; a drag never counts as a click on a tile.
	DEBUG_MAP_MAX_SCALE: 4,
	DEBUG_MAP_START_CELL_PX: 6, // on screen, when the map first opens: big enough to click a tile
	createDebugMapZoom: function(svg, frame, built) {
		var self = this;
		var width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'));
		var mode = 'width'; // 'width', 'whole' or 'scale'
		var bar = document.createElement('div');
		bar.className = 'railyard-view-zoom debug-map-zoom';
		var readout = document.createElement('span');
		var currentScale = function() {
			return svg.getBoundingClientRect().width / Math.max(1, width);
		};
		var wholeScale = function() {
			var available = Math.max(120, Math.round(window.innerHeight * 0.7) - 2);
			return Math.min(Math.max(1, frame.clientWidth) / width, available / height);
		};
		var show = function() {
			readout.textContent = mode === 'width' ? 'Fit width' : mode === 'whole' ? 'Whole map'
				: Math.round(currentScale() * 100) + '%';
		};
		// Resizes the drawing and scrolls so the map point at (clientX, clientY) stays under it.
		var zoomTo = function(scale, clientX, clientY) {
			if (!frame.clientWidth) return;
			var frameBox = frame.getBoundingClientRect(), before = svg.getBoundingClientRect(), old = currentScale();
			if (typeof clientX !== 'number') {
				clientX = frameBox.left + frame.clientWidth / 2;
				clientY = frameBox.top + frame.clientHeight / 2;
			}
			var unitX = (clientX - before.left) / old, unitY = (clientY - before.top) / old;
			scale = Math.max(Math.min(wholeScale(), 1), Math.min(self.DEBUG_MAP_MAX_SCALE, scale));
			svg.style.maxWidth = 'none';
			svg.style.width = Math.round(width * scale) + 'px';
			svg.style.height = Math.round(height * scale) + 'px';
			var after = svg.getBoundingClientRect();
			frame.scrollLeft += after.left + unitX * scale - clientX;
			frame.scrollTop += after.top + unitY * scale - clientY;
			show();
			built.redraw(frame);
		};
		var addButton = function(label, title, onClick, parent) {
			var button = document.createElement('button');
			button.type = 'button';
			button.textContent = label;
			button.title = title;
			button.setAttribute('aria-label', title);
			button.addEventListener('click', onClick);
			(parent || bar).appendChild(button);
			return button;
		};
		addButton('\u2212', 'Zoom out', function() { mode = 'scale'; zoomTo(currentScale() / 1.5); });
		addButton('+', 'Zoom in', function() { mode = 'scale'; zoomTo(currentScale() * 1.5); });
		addButton('Whole map', 'Shrink the map until all of it is in view', function() {
			mode = 'whole';
			zoomTo(wholeScale());
			frame.scrollLeft = 0;
			frame.scrollTop = 0;
			show();
		});
		addButton('Fit width', 'Fit the map to the width of the panel', function() {
			mode = 'width';
			zoomTo(frame.clientWidth / width);
			show();
		});
		// Panning by button: a network map is heavy to drag or scroll, so these jump three quarters of the view at once.
		// They sit in a diamond, each arrow on the side it moves towards.
		var pad = document.createElement('div');
		pad.className = 'debug-map-pan';
		[['\u2191', 'Pan up', 0, -1], ['\u2190', 'Pan left', -1, 0], ['\u2192', 'Pan right', 1, 0], ['\u2193', 'Pan down', 0, 1]]
			.forEach(function(pan) {
				addButton(pan[0], pan[1], function() {
					frame.scrollLeft += pan[2] * Math.round(frame.clientWidth * 0.75);
					frame.scrollTop += pan[3] * Math.round(frame.clientHeight * 0.75);
				}, pad).className = 'debug-map-pan-' + pan[1].slice(4);
			});
		bar.appendChild(pad);
		bar.appendChild(readout);
		show();
		// The opening view: close enough to click a tile, centred on the player. A map small enough to fit the panel
		// at that size simply fits its width, as it always did.
		bar.openView = function() {
			if (!frame.clientWidth) return false;
			var fitWidth = frame.clientWidth / width, scale = self.DEBUG_MAP_START_CELL_PX / built.cell;
			mode = scale <= fitWidth ? 'width' : 'scale';
			zoomTo(Math.max(scale, fitWidth));
			var target = built.focus || built.corridorCentre, applied = currentScale();
			frame.scrollLeft = Math.max(0, target.x * applied - frame.clientWidth / 2);
			frame.scrollTop = Math.max(0, target.y * applied - frame.clientHeight / 2);
			show();
			built.redraw(frame);
			return true;
		};
		// Ctrl+wheel, and the pinch a trackpad reports as one, zoom around the pointer; a plain wheel still scrolls.
		frame.addEventListener('wheel', function(event) {
			if (!event.ctrlKey) return;
			event.preventDefault();
			mode = 'scale';
			// About a fifth per wheel notch; a pinch sends many small steps and comes out smooth.
			zoomTo(currentScale() * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
		}, { passive: false });
		// Dragging with a mouse pans. Touch already scrolls the frame by itself.
		// The move and release listeners live only as long as the drag, since the panel is rebuilt on every passage.
		frame.addEventListener('pointerdown', function(event) {
			if (event.pointerType !== 'mouse' || event.button !== 0) return;
			var drag = { x: event.clientX, y: event.clientY, left: frame.scrollLeft, top: frame.scrollTop, moved: false };
			var move = function(moveEvent) {
				var dx = moveEvent.clientX - drag.x, dy = moveEvent.clientY - drag.y;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
				drag.moved = true;
				frame.classList.add('debug-map-dragging');
				frame.scrollLeft = drag.left - dx;
				frame.scrollTop = drag.top - dy;
			};
			var release = function() {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', release);
				frame.classList.remove('debug-map-dragging');
				if (!drag.moved) return;
				// The click that ends a drag must not teleport the player to whatever tile the pointer let go over.
				var swallow = function(clickEvent) { clickEvent.stopPropagation(); clickEvent.preventDefault(); };
				frame.addEventListener('click', swallow, { capture: true, once: true });
				setTimeout(function() { frame.removeEventListener('click', swallow, { capture: true }); }, 0);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', release);
		});
		return bar;
	},
	// The map of a whole network takes a moment to draw, and the debug panel is rebuilt on every passage whether or not
	// anyone is looking at it. So the map is only drawn once the panel is open and it has room on the page.
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
	buildDebugMapPanel: function(parent, stationId) {
		if (!parent || typeof document === 'undefined') {
			return;
		}
		try {
			var built = this.buildDebugMap(stationId);
			var heading = document.createElement('p');
			heading.className = 'debug-map-heading';
			var leg = built.leg, route = setup.realWorldPilot.getGridRoute();
			var mainLine = leg.tiles;
			var networkStats = setup.worldGraphData.network.stats;
			heading.textContent = leg.corridor.label + ': ' + mainLine.length + ' grid squares, '
				+ Object.keys(route.legs).length + ' legs, ' + leg.corridor.stations.length + ' stations; '
				+ networkStats.railKm + ' km of mapped railway joined by ' + networkStats.bridgeCount + ' new lines ('
				+ networkStats.bridgeKm + ' km). Yard contents still use seed ' + this.getSeed() + '.';
			parent.appendChild(heading);
			var instructions = document.createElement('p');
			instructions.textContent = 'Debug teleport: select a track tile on the map or choose one below. If you are aboard, your entire consist moves with you; on foot, only you move.';
			var self = this;
			var teleport = function(legIndex, x, y) {
				var result = self.debugTeleportToTile(Number(legIndex), Number(x), Number(y));
				if (!result) return;
				setup.debugTeleportNotice = 'Teleported ' + (result.mode === 'consist' ? 'the complete consist' : 'you')
					+ (result.stationId ? ' to ' + setup.worldmap.getStationName(result.stationId) + ' station.'
						: ' to ' + setup.worldmap.getStationName(result.target.legIndex) + '–'
							+ setup.worldmap.getStationName(result.target.legIndex + 1) + ', tile '
							+ (result.target.tileIndex + 1) + ' at ' + result.target.tile.x + ', ' + result.target.tile.y + '.');
				setup.debugReturnToPanel = true;
				Engine.play(result.passage);
			};
			// One listener for the whole map: the squares come and go as it scrolls.
			built.svg.addEventListener('click', function(event) {
				var cellRect = event.target.closest && event.target.closest('[data-debug-teleport]');
				if (!cellRect) return;
				var parts = cellRect.getAttribute('data-debug-teleport').split(':');
				teleport(parts[0], parts[1], parts[2]);
			});
			var frame = document.createElement('div');
			frame.className = 'debug-map-frame';
			frame.appendChild(built.svg);
			var pending = false;
			frame.addEventListener('scroll', function() {
				if (pending) return;
				pending = true;
				requestAnimationFrame(function() { pending = false; built.redraw(frame); });
			}, { passive: true });
			var zoomBar = this.createDebugMapZoom(built.svg, frame, built);
			parent.appendChild(zoomBar);
			parent.appendChild(frame);
			built.redraw(frame);
			{
				// One line under the map names the square under the pointer, in place of a tooltip on every square.
				var readout = document.createElement('p');
				readout.className = 'small-description debug-map-hover';
				readout.textContent = 'Point at the map to read a square.';
				parent.appendChild(readout);
				built.svg.addEventListener('mousemove', function(event) {
					var box = built.svg.getBoundingClientRect(), scale = box.width / Number(built.svg.getAttribute('width'));
					var x = built.rect.x0 + Math.floor((event.clientX - box.left) / scale / built.cell);
					var y = built.rect.y1 - Math.floor((event.clientY - box.top) / scale / built.cell);
					var tile = route.byKey[setup.worldmap.key(x, y)];
					readout.textContent = tile ? ((tile.station ? tile.station + ' (' + (tile.stationRegion || 'rural') + ') | ' : '') + (tile.gapFill ? 'new line | ' : '')
						+ 'grid ' + x + ',' + y + ' ' + tile.terrain + ' ' + tile.shape + ' | '
						+ tile.geoCoordinate[1].toFixed(3) + '\u00b0, ' + tile.geoCoordinate[0].toFixed(3) + '\u00b0 | mean '
						+ Math.round(tile.elevation) + ' m, relief \u03c3 ' + Math.round(tile.elevationStdDevM) + ' m')
						: 'grid ' + x + ',' + y + ': no track';
				});
			}
			// The debug tools are built inside a hidden panel and a folded section, so the map has no size until the
			// player opens both. Set the opening view the first time it actually appears.
			if (typeof ResizeObserver === 'function') {
				var watcher = new ResizeObserver(function() { if (zoomBar.openView()) watcher.disconnect(); });
				watcher.observe(frame);
			}
			parent.appendChild(instructions);
			var controls = document.createElement('div');
			controls.className = 'debug-map-teleport-controls';
			var label = document.createElement('label');
			label.textContent = 'Exact track tile: ';
			var select = document.createElement('select');
			select.setAttribute('aria-label', 'Exact track tile');
			// Every station: listing tens of thousands of squares would make the list useless.
			var listed = mainLine.filter(function(tile) { return tile.stationIndex; })
				.sort(function(a, b) { return a.stationIndex - b.stationIndex; });
			listed.forEach(function(tile, index) {
				var option = document.createElement('option');
				option.value = '0,' + tile.x + ',' + tile.y;
				option.textContent = (index + 1) + '/' + listed.length + ' — ' + tile.x + ', ' + tile.y + ' — '
					+ tile.terrain + (tile.station ? ' — ' + tile.station : '');
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
			// Keep the precision control visible before a tall north-south map on phones.
			parent.insertBefore(instructions, frame);
			parent.insertBefore(controls, frame);
			if (setup.debugTeleportNotice) {
				var notice = document.createElement('p');
				notice.className = 'debug-teleport-notice';
				notice.setAttribute('role', 'status');
				notice.textContent = setup.debugTeleportNotice;
				parent.insertBefore(notice, frame);
			}
			var legend = document.createElement('p');
			legend.textContent = 'Each outlined cell is one fixed 5 km gameplay move. Hover it for its sourced coordinates, terrain, grade, mean elevation and relief; every rail cell is a teleport target.';
			parent.appendChild(legend);
		} catch (error) {
			var failure = document.createElement('p');
			failure.textContent = 'World map unavailable: ' + error.message;
			parent.appendChild(failure);
		}
	}
};
