// Rail yards, apart from the squares they stand on (Likea, 2026-09-30). A square of the network can have any number of
// yards: a station's, and out on the line a siding, with more kinds of station to come. Arriving on a square with a
// yard does not put the train in it: the train stands on the line, and entering is the player's choice.
//
// Every yard has an id. A station's own yard is its number, the key its tracks have always been saved under; another
// yard on a station's square is 'yard:<station>:<kind>' (its kinds: setup.yardTypes); a siding's names its square, as
// 'siding:x,y'. The tracks of every kind of yard are kept in
// $stationTracks under that id, and $currentStation holds the id of the yard the player is in or last left.
//
// A train the player leaves out on the line, by walking away and boarding another, stands where it was left, in
// $lineTrains under its square ('x,y'). It blocks the line: nothing can pass it, and a train that drives up to it
// couples to it, by the same rule as coupling in a yard. A train put into a siding is in a yard, and blocks nothing.
setup.yards = {
	// A siding stands on about one square in this many along plain, straight line, placed from the run's seed.
	SIDING_EVERY: 10,
	SIDING_METRES: [300, 900],
	route: function() {
		return setup.realWorldPilot && setup.realWorldPilot.getGridRoute ? setup.realWorldPilot.getGridRoute() : null;
	},
	key: function(x, y) {
		return x + ',' + y;
	},
	// { kind: 'station', station }, { kind: 'extra', station, type } or { kind: 'siding', x, y }; null for an id that
	// names no kind of yard.
	parse: function(id) {
		if (typeof id === 'number' || /^\d+$/.test(String(id))) {
			var station = Number(id);
			return Number.isInteger(station) && station >= 1 ? { kind: 'station', station: station } : null;
		}
		var extra = /^yard:(\d+):([a-z-]+)$/.exec(String(id));
		if (extra) return Number(extra[1]) >= 1 ? { kind: 'extra', station: Number(extra[1]), type: extra[2] } : null;
		var siding = /^siding:(-?\d+),(-?\d+)$/.exec(String(id));
		return siding ? { kind: 'siding', x: Number(siding[1]), y: Number(siding[2]) } : null;
	},
	// The station whose square a yard stands on: its own number, the number in another yard's id; 0 for a siding.
	stationOf: function(id) {
		var parsed = this.parse(id);
		return parsed && parsed.kind !== 'siding' ? parsed.station : 0;
	},
	// Station ids are numbers in the game's variables, whatever form they were read in.
	normalise: function(id) {
		var parsed = this.parse(id);
		return parsed && parsed.kind === 'station' ? parsed.station : id;
	},
	isStation: function(id) {
		var parsed = this.parse(id);
		return !!parsed && parsed.kind === 'station';
	},
	// Whether a square of the network has a siding: plain, straight line that is not a bridge or a tunnel.
	hasSiding: function(tile) {
		if (!tile || tile.stationIndex || tile.junction || tile.buffer || !tile.ends || tile.ends.length !== 2
			|| !setup.worldmap.isStraight(tile.shape) || tile.terrain === 'bridge' || tile.terrain === 'tunnel') return false;
		var yard = setup.railyard, seed = (State.variables && State.variables.randomSeed) || 'ashline';
		return yard.mulberry32(yard.seedFromString(seed + ':siding:' + this.key(tile.x, tile.y)))() < 1 / this.SIDING_EVERY;
	},
	// The network square of a yard.
	tile: function(id) {
		var parsed = this.parse(id), route = this.route();
		if (!parsed || !route) return null;
		if (parsed.kind === 'station') return setup.realWorldPilot.getStationTile(parsed.station);
		if (parsed.kind === 'extra') {
			return setup.yardTypes.forStation(parsed.station).indexOf(parsed.type) > 0 ? setup.realWorldPilot.getStationTile(parsed.station) : null;
		}
		var tile = route.byKey[this.key(parsed.x, parsed.y)];
		return tile && this.hasSiding(tile) ? tile : null;
	},
	exists: function(id) {
		return !!this.tile(id);
	},
	// The yards on a square: [{ id, kind, type }], the station's own first, then the others on its square, then a siding.
	at: function(x, y) {
		var route = this.route(), tile = route && route.byKey[this.key(x, y)], yards = [];
		if (!tile) return yards;
		if (tile.stationIndex) setup.yardTypes.forStation(tile.stationIndex).forEach(function(type, index) {
			yards.push(index ? { id: 'yard:' + tile.stationIndex + ':' + type, kind: 'extra', type: type }
				: { id: tile.stationIndex, kind: 'station', type: type });
		});
		if (this.hasSiding(tile)) yards.push({ id: 'siding:' + this.key(tile.x, tile.y), kind: 'siding' });
		return yards;
	},
	// Where a siding lies on its leg: { legIndex, tileIndex }.
	place: function(id) {
		var tile = this.parse(id) && this.parse(id).kind === 'siding' ? this.tile(id) : null, route = this.route();
		return tile ? route.place[tile.globalPosition] || null : null;
	},
	name: function(id) {
		var parsed = this.parse(id);
		if (!parsed) return '';
		if (parsed.kind !== 'siding') return setup.worldmap.getStationName(parsed.station);
		var place = this.place(id), near = place && setup.realWorldPilot.getStationsNear(place.legIndex, place.tileIndex)[0];
		return 'Siding' + (near ? ' near ' + setup.worldmap.getStationName(near.station) : '');
	},
	// The label of the link that takes a train or a walker into a yard.
	enterLabel: function(id) {
		return this.stationOf(id) ? 'Enter ' + this.name(id) + ' ' + setup.yardTypes.label(id) : 'Enter the siding';
	},
	// The lines out of a siding, as realWorldPilot.getStationLines gives them for a station: back along its leg from the
	// entry end, on along it from the exit end. tileIndex is where on the leg a departure starts.
	lines: function(id) {
		// Another yard on a station's square leaves by the station's lines.
		if (this.stationOf(id)) return setup.realWorldPilot.getStationLines(this.stationOf(id));
		var place = this.place(id), leg = place && setup.realWorldPilot.getLeg(place.legIndex);
		if (!leg) return [];
		var tiles = leg.tiles, index = place.tileIndex;
		return [
			{ legIndex: leg.index, forward: false, tileIndex: index, side: 'entry', destination: leg.fromStationIndex,
				destinationName: leg.fromNode.name, direction: setup.worldmap.opposite(tiles[index - 1].out) },
			{ legIndex: leg.index, forward: true, tileIndex: index, side: 'exit', destination: leg.toStationIndex,
				destinationName: leg.toNode.name, direction: tiles[index].out }
		];
	},
	// A siding: the running line through the square as its two leads, and one empty road beside it.
	generateTracks: function(id, baseSeed) {
		var yard = setup.railyard, rng = yard.mulberry32(yard.seedFromString(String(baseSeed) + ':' + id));
		var metres = Math.round(yard.randomInt(rng, this.SIDING_METRES[0], this.SIDING_METRES[1]) / 10) * 10;
		var tracks = [
			{ length: 999999, infinite: true, trains: [], leadTrack: 1 },
			{ length: metres, trains: [] },
			{ length: 999999, infinite: true, trains: [], leadTrack: 1 }
		];
		tracks[0].direction = yard.getLineHeading(id, 'entry') || 'south';
		tracks[2].direction = yard.getLineHeading(id, 'exit') || yard.oppositeDirection(tracks[0].direction);
		return tracks;
	},
	// Which lead a consist standing on the line takes into a yard on its square: for a station, the side its leg meets
	// the yard; for a siding, the end the train faces from, as it pulls in the way it points.
	entersOnEntryLead: function(id, journey) {
		if (this.stationOf(id)) return setup.realWorldPilot.getArrivalSide(journey.legIndex, this.stationOf(id)) === 'entry';
		return journey.forward !== false;
	},
	// Why the consist on the line cannot enter a yard here, or ''.
	getEnterBlockReason: function(id) {
		var v = State.variables, journey = setup.worldmap.getJourney();
		if (!journey) return 'You are not out on the line.';
		var tracks = v.stationTracks[id] || setup.railyard.generateStationTracks(id, v.randomSeed);
		var onEntry = this.entersOnEntryLead(id, journey);
		if (!setup.railyard.trackExists(tracks, onEntry ? setup.railyard.getEntryTrackIndex() : setup.railyard.getExitTrackIndex(tracks)))
			return this.name(id) + ' has no ' + setup.railyard.getTrackLabel(tracks, onEntry ? setup.railyard.getEntryTrackIndex()
				: setup.railyard.getExitTrackIndex(tracks)) + ' to arrive on.';
		return '';
	},
	// The consist on the line pulls into a yard on its square.
	enter: function(id) {
		var journey = setup.worldmap.getJourney();
		if (!journey || this.getEnterBlockReason(id)) return false;
		return setup.railyard.arriveAtStation(this.normalise(id), this.entersOnEntryLead(id, journey));
	},
	// --- trains left on the line -------------------------------------------------------------------------------
	lineTrains: function() {
		var v = State.variables;
		if (!v.lineTrains || typeof v.lineTrains !== 'object') v.lineTrains = {};
		return v.lineTrains;
	},
	lineTrainAt: function(x, y) {
		var trains = State.variables.lineTrains;
		return trains && trains[this.key(x, y)] || null;
	},
	// Leaves the player's consist standing where it is on the line. frontAlongLeg records which way it points: whether
	// its first car is at the end toward the leg's far node. A driven consist leads with its first car when
	// $travellingForward, and drives the way the journey faces.
	parkCurrentTrain: function() {
		var v = State.variables, journey = setup.worldmap.getJourney(), train = v.currentTrain;
		if (!journey || !Array.isArray(train) || !train.length) return false;
		var tiles = setup.worldmap.getJourneyPath(journey).tiles, tile = tiles[journey.tileIndex];
		if (!tile || this.lineTrainAt(tile.x, tile.y)) return false;
		setup.railyard.markTrainVisited(train);
		this.lineTrains()[this.key(tile.x, tile.y)] = { legIndex: journey.legIndex, tileIndex: journey.tileIndex,
			x: tile.x, y: tile.y, coordinate: tile.geoCoordinate,
			frontAlongLeg: (v.travellingForward !== false) === (journey.forward !== false), train: train };
		v.currentTrain = null;
		v.journey = null;
		return true;
	},
	// Which end of a parked train a consist meets when it comes onto the parked train's square along legIndex, moving
	// toward the leg's far node (movingForward) or back toward its start: true for the parked train's first car.
	parkedContactIsFront: function(parked, legIndex, movingForward) {
		if (Number(legIndex) === Number(parked.legIndex)) return movingForward ? !parked.frontAlongLeg : parked.frontAlongLeg;
		// Through the node the parked train stands on, from another line: it is met at its end facing out of its leg.
		return parked.tileIndex === 0 ? !parked.frontAlongLeg : parked.frontAlongLeg;
	},
	// Couples the parked train on a square onto the player's consist, which is coming onto that square along legIndex
	// moving toward the leg's far node or not, and leading with its first car or not. The cars keep the way they face.
	coupleParked: function(x, y, legIndex, movingForward, leadingWithFront) {
		var v = State.variables, parked = this.lineTrainAt(x, y), train = v.currentTrain;
		if (!parked || !Array.isArray(train)) return false;
		var parkedFront = this.parkedContactIsFront(parked, legIndex, movingForward);
		var cars = parked.train.slice();
		// Taken in the consist's own order, a parked train met at the same end as the consist leads with is turned
		// end for end, and so is every car in it.
		if (parkedFront === leadingWithFront) {
			cars.reverse();
			cars.forEach(function(car) { car.facing = -setup.railyard.getCarFacing(car); });
		}
		if (leadingWithFront) {
			Array.prototype.unshift.apply(train, cars);
			if (typeof v.currentCarIndex === 'number') v.currentCarIndex += cars.length;
		} else {
			Array.prototype.push.apply(train, cars);
		}
		delete this.lineTrains()[this.key(x, y)];
		return true;
	},
	// Climbing aboard a train left on the line, from the ballast beside it. The player's own consist, if out on the line
	// somewhere, is left standing where it is.
	boardParked: function(x, y) {
		var v = State.variables, parked = this.lineTrainAt(x, y);
		if (!parked) return false;
		if (Array.isArray(v.currentTrain) && v.currentTrain.length && setup.worldmap.getJourney() && !this.parkCurrentTrain()) return false;
		delete this.lineTrains()[this.key(x, y)];
		v.currentTrain = parked.train;
		v.journey = { legIndex: parked.legIndex, tileIndex: parked.tileIndex, forward: true };
		v.travellingForward = !!parked.frontAlongLeg;
		v.onFoot = null;
		v.currentCarIndex = setup.railyard.getBoardingCarIndex(parked.train);
		return true;
	}
};
