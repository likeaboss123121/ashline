/* The buildings a station has, and the supplies they keep.

   A yard's own stores are small: an emergency reserve so a player can never be stranded, not a place to fill up.
   The supplies worth having are in the trains parked there, and in the buildings some stations have:

   - Station HQ: a little food and clean drinking water.
   - Water tower: plenty of water for a steam engine, but untreated: drinking it is a gamble on immunity.
   - Coal tower: coal for a steam engine.
   - Diesel tank: diesel for a diesel engine.

   Which buildings a station has follows from what kind of station it is (a city, a working station, a closed one,
   a halt out on a long section, the end of a line) and its region, rolled once per station on the world seed, so a
   station always has the same buildings in a run and none of it is saved. What they hold is rolled the first time
   the yard is generated and saved with it, since the player takes from it. */
setup.stationBuildings = {
	KINDS: {
		hq: { name: 'Station HQ', template: 'railyard-building-station-hq' },
		waterTower: { name: 'Water tower', template: 'railyard-building-water-tower' },
		coalTower: { name: 'Coal tower', template: 'railyard-building-coal-tower' },
		dieselTank: { name: 'Diesel tank', template: 'railyard-building-diesel-tank' }
	},
	ORDER: ['hq', 'waterTower', 'coalTower', 'dieselTank'],
	// The chance of each building, by the kind of station. A working station is likelier to keep diesel, a closed
	// one to still have its steam-era water and coal towers; a city has most things.
	CHANCES: {
		city: { hq: 1, waterTower: 0.7, coalTower: 0.5, dieselTank: 0.9 },
		active: { hq: 0.45, waterTower: 0.35, coalTower: 0.2, dieselTank: 0.45 },
		closed: { hq: 0.3, waterTower: 0.5, coalTower: 0.3, dieselTank: 0.12 },
		settlement: { hq: 0.35, waterTower: 0.3, coalTower: 0.1, dieselTank: 0.15 },
		halt: { hq: 0.12, waterTower: 0.35, coalTower: 0.1, dieselTank: 0.08 },
		end: { hq: 0.2, waterTower: 0.25, coalTower: 0.1, dieselTank: 0.1 }
	},
	// Region bends those chances: works districts keep fuel, cities keep people and so food.
	REGION: {
		industrial: { coalTower: 1.8, dieselTank: 1.6 },
		urban: { hq: 1.3, dieselTank: 1.3 }
	},
	// What a yard keeps with no building, only so a player can always get to the next station.
	EMERGENCY: { diesel: 200, coal: 400, water: 600 },
	// What each building holds when first found: [least, most].
	STORES: {
		hq: { rations: [2, 6], drinkingWater: [30, 90] },
		waterTower: { water: [5000, 14000] },
		coalTower: { coal: [2000, 6000] },
		dieselTank: { diesel: [500, 1500] }
	},
	// How clean the water is, as a grade: the HQ's drinking water, a water tower's, and a yard's emergency butt.
	GRADES: { drinkingWater: 95, towerWater: 55, emergencyWater: 40 },
	// Station 1 teaches the game: it always has its HQ and a diesel tank.
	TUTORIAL: ['hq', 'dieselTank'],

	classOf: function(station) {
		if (!station) return 'halt';
		if (station.status === 'city') return 'city';
		if (station.status === 'active') return 'active';
		if (station.status === 'settlement') return 'settlement';
		if (station.status === 'halt') return 'halt';
		if (station.status === 'end') return 'end';
		return 'closed';
	},

	// The buildings at a station, as kind keys in ORDER.
	get: function(stationId) {
		var id = Number(stationId);
		if (id === 1) return this.TUTORIAL.slice();
		var pilot = setup.realWorldPilot, station = pilot && pilot.getStation ? pilot.getStation(id) : null;
		if (!station) return [];
		var chances = this.CHANCES[this.classOf(station)], region = this.REGION[station.region] || {};
		var yard = setup.railyard, seed = (State.variables && State.variables.randomSeed) || 'ashline';
		var rng = yard.mulberry32(yard.seedFromString(seed + ':buildings:' + station.id));
		return this.ORDER.filter(function(kind) {
			return rng() < Math.min(1, chances[kind] * (region[kind] || 1));
		});
	},
	has: function(stationId, kind) {
		return this.get(stationId).indexOf(kind) !== -1;
	},
	describe: function(stationId) {
		var self = this;
		return this.get(stationId).map(function(kind) { return self.KINDS[kind].name; });
	},

	// A yard's stores when first generated: the emergency reserve, and whatever its buildings hold.
	initialStock: function(stationId, rng) {
		var self = this, roll = rng || Math.random;
		var stock = Object.assign({}, this.EMERGENCY, { waterGrade: this.GRADES.emergencyWater, drinkingWater: 0, rations: 0 });
		this.get(stationId).forEach(function(kind) {
			var store = self.STORES[kind];
			Object.keys(store).forEach(function(type) {
				var range = store[type];
				stock[type] = (stock[type] || 0) + Math.round(range[0] + (range[1] - range[0]) * roll());
			});
			if (kind === 'waterTower') stock.waterGrade = self.GRADES.towerWater;
		});
		return stock;
	}
};
