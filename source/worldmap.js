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
		return journey && typeof journey.legIndex === 'number' ? journey : null;
	},
	// The run of tiles the train is standing on: the leg's main line, or a branch off it if the player took one.
	getJourneyPath: function(position) {
		var journey = position || this.getJourney();
		if (!journey) {
			return null;
		}
		var leg = this.getLeg(this.getSeed(), journey.legIndex);
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
	getJourneyView: function(position) {
		var journey = position || this.getJourney();
		if (!journey) {
			return null;
		}
		var path = this.getJourneyPath(journey);
		var tiles = path.tiles;
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
			grade: grade, terrain: terrain, heading: '', minutes: this.getTileMinutes(grade, train),
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
	getLegIndexFor: function(stationId, towardExit) {
		var id = Math.floor(Number(stationId));
		if (!isFinite(id)) {
			return 0;
		}
		return towardExit ? id : id - 1;
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
		return setup.units.kilometres(travel.kilometres) + ', steepest climb ' + travel.steepestClimb.toFixed(1) + '%'
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
	// Resolves one generated track tile into the journey coordinates used by trains and walkers. Debug tools use
	// coordinates rather than array offsets so the map remains the source of truth for what was clicked.
	getDebugTeleportTarget: function(legIndex, x, y) {
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
		if (!variables.debugMode) return null;
		var target = this.getDebugTeleportTarget(Number(legIndex), Number(x), Number(y));
		if (!target) return null;
		var activeTrain = Array.isArray(variables.currentTrain) && variables.currentTrain.length > 0;
		var onFoot = !!variables.onFoot;
		var currentJourney = this.getJourney();
		if (activeTrain && onFoot) {
			// The walking model stores the parked train in journey and the player in onFoot. It cannot represent them
			// on different legs, so a map for any other leg must not silently move the train as a side effect.
			if (!currentJourney || currentJourney.legIndex !== target.legIndex) return null;
			variables.onFoot = { tileIndex: target.tileIndex, branch: target.branch };
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
		variables.onFoot = { tileIndex: target.tileIndex, branch: target.branch };
		return { mode: 'player', passage: 'OnFoot', target: target };
	},
	// --- debug map ----------------------------------------------------------------------------------------
	// A deliberately plain top-down map for debug mode: terrain as coloured cells and track as lines through
	// them. It is a look at what the generator produced, not a player-facing map.
	buildDebugMap: function(stationId, cellSize) {
		var seed = this.getSeed();
		var branchHere = this.getBranchForStation(seed, stationId);
		var legIndex = branchHere ? branchHere.legIndex : Math.max(1, Math.floor(stationId));
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
		// A mostly north-south leg may only be a handful of native 9 px cells wide. Enlarge the rendered map while
		// retaining its viewBox so mouse and touch targets are usable without altering generated geometry.
		svg.style.width = 'min(100%, ' + Math.max(280, width) + 'px)';
		svg.style.height = 'auto';
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
				if (tile) {
					cellRect.setAttribute('class', 'debug-teleport-tile');
					cellRect.setAttribute('data-debug-teleport', legIndex + ':' + x + ':' + y);
					cellRect.setAttribute('tabindex', '0');
					cellRect.setAttribute('role', 'button');
					cellRect.setAttribute('aria-label', 'Teleport to track tile ' + x + ', ' + y);
				}
				var title = document.createElementNS(ns, 'title');
				var climate = this.getClimate(seed, x, y);
				title.textContent = x + ',' + y + ' ' + terrain
					+ (tile ? ' ' + tile.shape + ' ' + tile.grade.toFixed(1) + '%' : '')
					+ ' | ' + climate.latitude.toFixed(1) + '\u00b0, ' + climate.longitude.toFixed(1) + '\u00b0'
					+ ' | ' + climate.elevation + ' m, ' + climate.temperature.toFixed(1) + '\u00b0C, humidity '
					+ climate.humidity.toFixed(2);
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
				line.setAttribute('pointer-events', 'none');
				svg.appendChild(line);
			});
			if (tile.station) {
				var marker = document.createElementNS(ns, 'circle');
				marker.setAttribute('cx', cx);
				marker.setAttribute('cy', cy);
				marker.setAttribute('r', cell / 3);
				marker.setAttribute('fill', '#e5c58a');
				marker.setAttribute('pointer-events', 'none');
				var markerTitle = document.createElementNS(ns, 'title');
				markerTitle.textContent = 'Station ' + tile.station;
				marker.appendChild(markerTitle);
				svg.appendChild(marker);
			}
		});
		// Where the train is standing, and which way it is going, so the map can be read against the journey.
		var here = this.getJourneyView();
		var hasTrain = Array.isArray(State.variables.currentTrain) && State.variables.currentTrain.length > 0;
		if (hasTrain && here && here.legIndex === legIndex) {
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
		if (footView && footView.legIndex === legIndex) {
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
			heading.className = 'debug-map-heading';
			var leg = built.leg;
			var mainLine = leg.tiles.filter(function(tile) { return !tile.branch; });
			var grades = mainLine.map(function(tile) { return tile.grade; });
			heading.textContent = 'World map, leg ' + leg.index + ' (station ' + leg.index + ' to ' + (leg.index + 1) + '): '
				+ mainLine.length + ' tiles, ' + (mainLine.length * this.TILE_KM) + ' km, grades '
				+ Math.min.apply(null, grades).toFixed(1) + '% to ' + Math.max.apply(null, grades).toFixed(1) + '%, '
				+ (leg.tiles.length - mainLine.length) + ' branch tiles. Seed ' + this.getSeed() + '.';
			parent.appendChild(heading);
			var instructions = document.createElement('p');
			instructions.textContent = 'Debug teleport: select a track tile on the map or choose one below. If you are aboard, your entire consist moves with you; on foot, only you move.';
			var self = this;
			var teleport = function(legIndex, x, y) {
				var result = self.debugTeleportToTile(Number(legIndex), Number(x), Number(y));
				if (!result) return;
				setup.debugTeleportNotice = 'Teleported ' + (result.mode === 'consist' ? 'the complete consist' : 'you')
					+ ' to leg ' + result.target.legIndex + ', ' + (result.target.branch ? 'branch ' + result.target.branch + ', ' : '')
					+ 'tile ' + (result.target.tileIndex + 1) + ' at ' + result.target.tile.x + ', ' + result.target.tile.y + '.';
				setup.debugReturnToPanel = true;
				Engine.play(result.passage);
			};
			built.svg.querySelectorAll('[data-debug-teleport]').forEach(function(cellRect) {
				var activate = function() {
					var parts = cellRect.getAttribute('data-debug-teleport').split(':');
					teleport(parts[0], parts[1], parts[2]);
				};
				cellRect.addEventListener('click', activate);
				cellRect.addEventListener('keydown', function(event) {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						activate();
					}
				});
			});
			parent.appendChild(built.svg);
			parent.appendChild(instructions);
			var controls = document.createElement('div');
			controls.className = 'debug-map-teleport-controls';
			var label = document.createElement('label');
			label.textContent = 'Exact track tile: ';
			var select = document.createElement('select');
			select.setAttribute('aria-label', 'Exact track tile');
			mainLine.forEach(function(tile, index) {
				var option = document.createElement('option');
				option.value = leg.index + ',' + tile.x + ',' + tile.y;
				option.textContent = 'Main ' + (index + 1) + '/' + mainLine.length + ' — ' + tile.x + ', ' + tile.y + ' — ' + tile.terrain;
				select.appendChild(option);
			});
			leg.branches.forEach(function(branch) {
				branch.tiles.forEach(function(tile, index) {
					var option = document.createElement('option');
					option.value = leg.index + ',' + tile.x + ',' + tile.y;
					option.textContent = 'Branch ' + branch.id + ' ' + (index + 1) + '/' + branch.tiles.length
						+ ' — ' + tile.x + ', ' + tile.y + ' — ' + tile.terrain;
					select.appendChild(option);
				});
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
			parent.insertBefore(instructions, built.svg);
			parent.insertBefore(controls, built.svg);
			if (setup.debugTeleportNotice) {
				var notice = document.createElement('p');
				notice.className = 'debug-teleport-notice';
				notice.setAttribute('role', 'status');
				notice.textContent = setup.debugTeleportNotice;
				parent.insertBefore(notice, built.svg);
			}
			var legend = document.createElement('p');
			legend.textContent = 'plains, forest, desert, arctic, mountain, bridge, tunnel, water. Hover a tile for its terrain, shape and grade; outlined track tiles are teleport targets.';
			parent.appendChild(legend);
		} catch (error) {
			var failure = document.createElement('p');
			failure.textContent = 'World map unavailable: ' + error.message;
			parent.appendChild(failure);
		}
	}
};
