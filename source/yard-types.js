// Kinds of yard (Likea, 2026-09-30): what a station's yards are, and what each holds. A stop's square has one or more
// yards; rural stops usually one, big cities two to four. Which a station has is a fact about the world, worked out
// from the world seed, the station's region, the local economy and the coast, and never saved.
//
// The station's own yard (its number, the id its tracks have always been saved under) is the first of its kinds; any
// other yard on its square has the id 'yard:<station>:<kind>' (setup.yards).
//
// A kind decides the yard's size (a size class of setup.railyard.YARD_SIZE_BY_REGION), the cars and the cargo in them
// (weights over those of the local economy), how often a train there has a locomotive and a car its load, and the
// buildings and supplies it keeps (weights over setup.stationBuildings' chances and stores).
setup.yardTypes = {
	KINDS: {
		'railyard-rural': { label: 'railyard', size: 'rural' },
		'railyard-urban': { label: 'railyard', size: 'urban', loco: 1.2 },
		'passenger-rural': { label: 'passenger station', size: 'rural', loco: 0.6, cargo: 0.5,
			cars: { passengerCoach: 8, sleeperCoach: 4, kitchenCar: 3, observationCar: 2, privateCar: 2, boxcar: 1 },
			loads: { food: 8 }, buildings: { hq: 2, coalTower: 0.5, dieselTank: 0.5 }, stores: { rations: 2, drinkingWater: 2 },
			kit: true },
		'passenger-urban': { label: 'passenger station', size: 'urban', loco: 0.7, cargo: 0.5,
			cars: { passengerCoach: 8, sleeperCoach: 5, kitchenCar: 3, observationCar: 3, privateCar: 2, boxcar: 1 },
			loads: { food: 8 }, buildings: { hq: 3, coalTower: 0.5, dieselTank: 0.6 }, stores: { rations: 2.5, drinkingWater: 2.5 },
			kit: true },
		factory: { label: 'factory', size: 'industrial', cargo: 2,
			cars: { boxcar: 5, flatcar: 4, gondola: 3, tanker: 1 }, loads: { machinery: 10, 'scrap metal': 6, cotton: 3 } },
		farm: { label: 'farm', size: 'rural', cargo: 2,
			cars: { hopper: 6, refrigerated: 4, boxcar: 2, flatcar: 1 }, loads: { food: 10, fertilizer: 6, cotton: 3 },
			buildings: { waterTower: 1.5 } },
		port: { label: 'port', size: 'urban', cargo: 1.8,
			cars: { boxcar: 5, flatcar: 3, tanker: 3, refrigerated: 3 }, loads: { machinery: 5, food: 5, diesel: 4, cotton: 3, fertilizer: 2 },
			buildings: { dieselTank: 1.3, waterTower: 1.3 } },
		mine: { label: 'mine', size: 'industrial', cargo: 2.5,
			cars: { hopper: 7, gondola: 6, flatcar: 1 }, loads: { 'iron ore': 12, coal: 10, 'scrap metal': 2 },
			buildings: { coalTower: 2 } },
		'engine-shed': { label: 'engine shed', size: 'industrial', loco: 3, cargo: 0.8,
			cars: { tanker: 2, boxcar: 1, flatcar: 1 }, loads: { diesel: 8, coal: 6, water: 4 },
			buildings: { dieselTank: 2.5, coalTower: 2.5, waterTower: 2 }, stores: { diesel: 1.5, coal: 1.5, water: 1.5 }, kit: true },
		'oil-terminal': { label: 'oil terminal', size: 'industrial', cargo: 2.5,
			cars: { tanker: 10, boxcar: 1 }, loads: { diesel: 12, machinery: 2 },
			buildings: { dieselTank: 3 }, stores: { diesel: 2 } },
		'timber-yard': { label: 'timber yard', size: 'rural', cargo: 2.5,
			cars: { flatcar: 7, gondola: 5, boxcar: 1 }, loads: { timber: 12, firewood: 10 } },
		scrapyard: { label: 'scrapyard', size: 'industrial', loco: 0.8, cargo: 1.5, derelict: 4,
			cars: { gondola: 5, flatcar: 4, boxcar: 2, hopper: 2, tanker: 1, passengerCoach: 1 }, loads: { 'scrap metal': 12, machinery: 5 } }
	},
	// The kind a station's local economy (setup.locales.INDUSTRIES) makes its industrial yard.
	BY_INDUSTRY: { farming: 'farm', forestry: 'timber-yard', mining: 'mine', oil: 'oil-terminal', manufacturing: 'factory' },
	// The local economy a kind of yard stands for, where it is one of them (a factory is manufacturing); null otherwise.
	industryOf: function(kind) {
		var self = this;
		return Object.keys(this.BY_INDUSTRY).filter(function(industry) { return self.BY_INDUSTRY[industry] === kind; })[0] || null;
	},
	// How far out from a station to look for the sea, for a port.
	COAST_KM: 8,
	// The items a passenger station's or an engine shed's locomotives may carry: what travellers and crews left behind.
	KIT: [['toolkit', 3], ['axe', 2], ['pump', 1], ['sleepingBag', 4], ['rations', 5], ['jerrycan', 2], ['rawFood', 3]],

	rng: function(stationIndex, what) {
		var yard = setup.railyard, seed = (State.variables && State.variables.randomSeed) || 'ashline';
		return yard.mulberry32(yard.seedFromString(seed + ':yard-types:' + stationIndex + ':' + what));
	},
	// A kind's own cars dominate its yard; any other car turns up at this weight (against its own cars' 1 to 10).
	OTHER_CAR_WEIGHT: 0.3,
	// The weights over every car for a kind with cars of its own.
	carWeights: function(kind, keys) {
		var own = this.KINDS[kind].cars, other = this.OTHER_CAR_WEIGHT;
		var weights = {};
		keys.forEach(function(key) { weights[key] = own[key] || other; });
		return weights;
	},
	// A weighted pick: weights is { kind: weight }.
	pick: function(weights, rng) {
		var kinds = Object.keys(weights).filter(function(kind) { return weights[kind] > 0; });
		return kinds.length ? setup.locales.choose(kinds, weights, rng) : null;
	},
	// Whether a station stands by the sea: water within COAST_KM of it, from the land mask the globe draws.
	isCoastal: function(tile) {
		var world = setup.worldmap, p = tile && tile.geoCoordinate;
		if (!p || !world.isLandAt) return false;
		var dLat = this.COAST_KM / 111, dLon = dLat / Math.max(0.2, Math.cos(p[1] * Math.PI / 180));
		for (var step = 0; step < 8; step++) {
			var angle = step * Math.PI / 4;
			if (world.isLandAt(p[0] + dLon * Math.cos(angle), p[1] + dLat * Math.sin(angle)) === false) return true;
		}
		return false;
	},
	// The kinds of a station's yards, its own yard's first. Cached per run, since the answer never changes.
	forStation: function(stationIndex) {
		var seed = (State.variables && State.variables.randomSeed) || 'ashline';
		if (!this.cache || this.cache.seed !== seed) this.cache = { seed: seed, kinds: {} };
		var id = Math.floor(Number(stationIndex));
		if (!this.cache.kinds[id]) this.cache.kinds[id] = this.work(id);
		return this.cache.kinds[id];
	},
	work: function(id) {
		var pilot = setup.realWorldPilot, station = pilot.getStation(id), tile = pilot.getStationTile(id);
		if (!station || !tile) return ['railyard-rural'];
		// Station 1 teaches the game on its own fixed yard.
		if (id === 1) return ['railyard-urban'];
		var region = tile.stationRegion || station.region || 'rural', coastal = this.isCoastal(tile);
		var industry = setup.locales.forStation(id).industry, local = this.BY_INDUSTRY[industry] || 'factory';
		var rng = this.rng(id, 'kinds'), self = this;
		if (station.status === 'halt') return [rng() < 0.7 ? 'passenger-rural' : 'railyard-rural'];
		// A city is a stop in an urban region; one kept for its importance (a capital, a million people) is a big one.
		var big = station.status === 'city' && region === 'urban';
		if (region === 'urban') {
			// A city: its railyard and its passenger station, then one or two more by the economy and the coast.
			var kinds = ['railyard-urban', 'passenger-urban'];
			var more = big ? 1 + (rng() < 0.55 ? 1 : 0) : (rng() < 0.5 ? 1 : 0);
			var pool = { factory: 4, 'engine-shed': 2, scrapyard: 1.5, port: coastal ? 6 : 0 };
			pool[local] = (pool[local] || 0) + 3;
			for (var i = 0; i < more; i++) {
				var extra = self.pick(pool, rng);
				if (!extra) break;
				kinds.push(extra);
				delete pool[extra];
			}
			return kinds;
		}
		// A small place kept for its importance or by hand (Churchill, Key West): its railyard and its passenger station,
		// and a port by the sea.
		if (station.status === 'city') {
			return ['railyard-rural', 'passenger-rural'].concat(coastal ? ['port'] : []);
		}
		if (region === 'industrial') {
			var own = [local];
			if (rng() < 0.45) {
				var beside = this.pick({ 'railyard-rural': 4, 'engine-shed': 1.5, scrapyard: 1.5, port: coastal ? 3 : 0 }, rng);
				if (beside && beside !== local) own.push(beside);
			}
			return own;
		}
		// The country: one yard.
		var country = { 'railyard-rural': 35, 'passenger-rural': 25, port: coastal ? 10 : 0, 'engine-shed': 2, scrapyard: 2 };
		country[local] = (country[local] || 0) + 20;
		return [this.pick(country, rng)];
	},
	// The kind of a yard by its id: a station's own, another on its square, or a siding.
	kindOf: function(id) {
		var parsed = setup.yards.parse(id);
		if (!parsed) return null;
		if (parsed.kind === 'siding') return 'siding';
		if (parsed.kind === 'extra') return parsed.type;
		return this.forStation(parsed.station)[0];
	},
	profile: function(id) {
		return this.KINDS[this.kindOf(id)] || this.KINDS['railyard-rural'];
	},
	label: function(id) {
		var kind = this.kindOf(id);
		return kind === 'siding' ? 'siding' : this.profile(id).label;
	},
	// Kit for a locomotive found at a passenger station or an engine shed: one or two things left aboard.
	fillKit: function(car, rng) {
		var count = 1 + (rng() < 0.4 ? 1 : 0), self = this;
		for (var i = 0; i < count; i++) {
			var keys = this.KIT.map(function(entry) { return entry[0]; });
			var weights = {};
			this.KIT.forEach(function(entry) { weights[entry[0]] = entry[1]; });
			var item = setup.locales.choose(keys, weights, rng);
			setup.items.add(car, item, item === 'rations' || item === 'rawFood' ? 1 + Math.floor(rng() * 3) : 1);
		}
		return self;
	}
};
