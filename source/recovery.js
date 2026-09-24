// Station supplies are finite and small, saved on a track object (never an array property): a yard's emergency
// reserve and whatever its buildings keep (setup.stationBuildings). They can be carried by hand even when an engine
// cannot move; diesel needs the player's 20 L jerrycan.
setup.recovery = {
	TYPES: ['diesel', 'coal', 'water'],
	GRADE: 89,
	HQ_WATER_FILL: 10,
	ensureStock: function(tracks, stationId) {
		if (!tracks[0].supplies) {
			var yard = setup.railyard, seed = (State.variables && State.variables.randomSeed) || 'ashline';
			tracks[0].supplies = stationId
				? setup.stationBuildings.initialStock(stationId, yard.mulberry32(yard.seedFromString(seed + ':stores:' + stationId)))
				: Object.assign({}, setup.stationBuildings.EMERGENCY);
		}
		return tracks[0].supplies;
	},
	stock: function(station) {
		var v = State.variables;
		if (!v.stationTracks[station]) v.stationTracks[station] = setup.railyard.generateStationTracks(station, v.randomSeed);
		return this.ensureStock(v.stationTracks[station], station);
	},
	// How clean a station's water is: a water tower's, or the yard's emergency butt.
	waterGrade: function(station) {
		var stock = this.stock(station);
		return stock.waterGrade == null ? setup.stationBuildings.GRADES.emergencyWater : stock.waterGrade;
	},
	// Distances follow rail connections, including either exit of a rejoining branch.
	stations: function() {
		var v = State.variables, world = setup.worldmap, j = world.getJourney();
		if (!j) return [{ station: v.currentStation, distance: 0 }];
		if (!v.onFoot) return [];
		var foot = setup.onfoot.get(), leg = world.getLeg(world.getSeed(), foot.legIndex || j.legIndex);
		// On the network, by track through any junctions to the nearest stations.
		if (leg && leg.realWorld) return setup.realWorldPilot.getStationsNear(leg.index, foot.tileIndex);
		var main = world.getMainLine(world.getSeed(), j.legIndex);
		var branch = foot.branch && leg.branches.find(function(b) { return b.id === foot.branch; });
		var index = foot.tileIndex, distances;
		// A leg knows the stations at its two ends; on the corridor they are the leg's own number and the next.
		var fromStation = leg.fromStationIndex || j.legIndex, toStation = leg.toStationIndex || j.legIndex + 1;
		if (!branch) distances = [{ station: fromStation, distance: index }, { station: toStation, distance: main.length - 1 - index }];
		else {
			var back = index + 1;
			distances = [{ station: j.legIndex, distance: back + branch.fromIndex },
				{ station: j.legIndex + 1, distance: back + main.length - 1 - branch.fromIndex }];
			if (branch.stationId) distances.push({ station: branch.stationId, distance: branch.tiles.length - 1 - index });
			if (branch.rejoinIndex !== null) {
				var ahead = branch.tiles.length - index;
				distances[0].distance = Math.min(distances[0].distance, ahead + branch.rejoinIndex);
				distances[1].distance = Math.min(distances[1].distance, ahead + main.length - 1 - branch.rejoinIndex);
			}
		}
		return distances.sort(function(a, b) { return a.distance - b.distance; });
	},
	supplyRoutes: function(type) {
		var self = this;
		return this.stations().filter(function(route) { return route.distance === 0 && self.stock(route.station)[type] >= 1; });
	},
	accessibleJerrycan: function() {
		if (setup.items.playerHas('jerrycan')) return { carried: true };
		if (State.variables.onFoot && !setup.onfoot.isBesideTrain()) return null;
		var train = State.variables.currentTrain || [];
		for (var i = 0; i < train.length; i++) if (setup.items.countItem(train[i], 'jerrycan')) return { car: train[i] };
		return null;
	},
	dieselCarryRoom: function() {
		var can = this.accessibleJerrycan();
		if (!can) return 0;
		var carried = setup.items.getPlayerCargo().filter(function(s) { return s.type === 'diesel'; })
			.reduce(function(total, s) { return total + s.amount; }, 0);
		return Math.max(0, 20 - carried);
	},
	takeJerrycan: function() {
		var can = this.accessibleJerrycan();
		if (!can) return false;
		if (can.car) {
			if (!setup.items.playerHasRoom('jerrycan') || !setup.items.takeFromCar(can.car, 'jerrycan')) return false;
		}
		return true;
	},
	plan: function(station, type, intoEngine) {
		if (this.TYPES.indexOf(type) === -1) return null;
		var route = this.supplyRoutes(type).find(function(s) { return String(s.station) === String(station); });
		if (!route || route.distance) return null;
		var v = State.variables, engine = v.currentTrain && v.currentTrain[v.currentCarIndex];
		if (intoEngine && (route.distance || v.journey || !setup.items.isLocomotive(engine) || engine.broken)) return null;
		if (!intoEngine && type === 'diesel' && (!this.accessibleJerrycan()
			|| (!setup.items.playerHas('jerrycan') && !setup.items.playerHasRoom('jerrycan')))) return null;
		var density = setup.railyard.getCargoDensityKgPerLiter(type);
		var room = intoEngine ? setup.refuel.getRoom(engine, type)
			: Math.min((setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg()
				- (type === 'diesel' && !setup.items.playerHas('jerrycan') ? setup.items.CATALOGUE.jerrycan.weightKg : 0)) / density,
				type === 'diesel' ? this.dieselCarryRoom() : Infinity);
		var stock = this.stock(route.station);
		var litres = Math.floor(Math.min(stock[type], room, intoEngine ? 400 : 20 / density));
		if (litres < 1) return null;
		return { station: route.station, type: type, litres: litres, intoEngine: !!intoEngine, engine: engine,
			minutes: Math.ceil(litres * density / 10) + 1 };
	},
	collect: function(station, type, intoEngine) {
		var p = this.plan(station, type, intoEngine);
		if (!p || (!p.intoEngine && p.type === 'diesel' && !this.takeJerrycan())) return false;
		// Revalidate before spending time; time advances without demanding propulsion.
		if (!setup.time.advanceMinutesWithSystems(p.minutes, 'walk')) return false;
		var grade = type === 'water' ? this.waterGrade(p.station) : this.GRADE;
		this.stock(p.station)[type] -= p.litres;
		if (p.intoEngine) setup.fuel.addCargo(p.engine, type, p.litres, grade);
		else setup.items.addPlayerCargo(type, p.litres, grade);
		return true;
	},
	// The station HQ: a ration from its store, clean water to carry, or a drink there and then. Only standing at the
	// station, with its HQ.
	atHq: function() {
		var v = State.variables;
		if (v.journey && !(v.onFoot && v.onFoot.inRailyard)) return null;
		var station = v.currentStation;
		return setup.stationBuildings.has(station, 'hq') ? station : null;
	},
	canTakeRation: function() {
		var station = this.atHq();
		return !!station && this.stock(station).rations > 0 && setup.items.playerHasRoom('rations');
	},
	takeRation: function() {
		if (!this.canTakeRation()) return false;
		this.stock(this.atHq()).rations--;
		setup.food.add(setup.items.getPlayerKit(), 'rations', 1, setup.condition.RATION_QUALITY);
		return true;
	},
	hqWaterFill: function() {
		var station = this.atHq();
		if (!station) return 0;
		var room = (setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg()) / setup.railyard.getCargoDensityKgPerLiter('water');
		return Math.floor(Math.min(this.HQ_WATER_FILL, room, this.stock(station).drinkingWater || 0));
	},
	fillDrinkingWater: function() {
		var litres = this.hqWaterFill();
		if (!(litres > 0)) return false;
		this.stock(this.atHq()).drinkingWater -= litres;
		setup.items.addPlayerCargo('water', litres, setup.stationBuildings.GRADES.drinkingWater);
		return true;
	},
	canDrinkAtHq: function() {
		var station = this.atHq();
		return !!station && (this.stock(station).drinkingWater || 0) >= setup.condition.DRINK_LITRES;
	},
	drinkAtHq: function() {
		if (!this.canDrinkAtHq()) return false;
		this.stock(this.atHq()).drinkingWater -= setup.condition.DRINK_LITRES;
		setup.stats.adjust('thirst', setup.condition.DRINK_THIRST);
		setup.condition.applyConsumableQuality(setup.stationBuildings.GRADES.drinkingWater);
		return true;
	},
	load: function(type) {
		var v = State.variables;
		if (v.onFoot && !setup.onfoot.isBesideTrain()) return false;
		var engine = setup.railyard.getControllingLocomotive(v.currentTrain);
		if (!engine || engine.broken) return false;
		var stack = setup.items.getPlayerCargo().find(function(s) { return s.type === type; });
		if (!stack) return false;
		var amount = Math.min(stack.amount, setup.refuel.getRoom(engine, type));
		if (!(amount > 0)) return false;
		setup.fuel.addCargo(engine, type, amount, stack.grade);
		setup.items.removePlayerCargo(type, amount);
		return true;
	},
	// Emptying bad fuel is recoverable into the player's cargo, never silently discarded.
	drain: function(type) {
		var v = State.variables, engine = setup.railyard.getControllingLocomotive(v.currentTrain);
		if (!engine || (v.onFoot && !setup.onfoot.isBesideTrain())) return false;
		if (type === 'diesel' && (!this.accessibleJerrycan()
			|| (!setup.items.playerHas('jerrycan') && !setup.items.playerHasRoom('jerrycan')))) return false;
		var density = setup.railyard.getCargoDensityKgPerLiter(type);
		var amount = Math.min(type === 'diesel' ? this.dieselCarryRoom() : 20 / density, setup.railyard.getCargoAmount(engine, type),
			(setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg()
				- (type === 'diesel' && !setup.items.playerHas('jerrycan') ? setup.items.CATALOGUE.jerrycan.weightKg : 0)) / density);
		if (!(amount > 0)) return false;
		if (type === 'diesel' && !this.takeJerrycan()) return false;
		var grade = setup.fuel.getGrade(engine, type);
		setup.railyard.consumeCargoAmount(engine, type, amount);
		setup.items.addPlayerCargo(type, amount, grade); return true;
	}
};
Macro.add('recoveryControls', {
	handler: function() {
		var v = State.variables, recovery = setup.recovery, box = document.createElement('div');
		box.className = 'recovery-controls';
		function link(label, action, effects) {
			var p = document.createElement('p'), a = document.createElement('a');
			a.tabIndex = 0; a.setAttribute('role', 'button'); a.className = 'link-internal'; a.textContent = label;
			a.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } });
			a.addEventListener('click', function(e) { e.preventDefault(); if (action()) Engine.play(State.passage); });
			p.appendChild(a); if (effects) new Wikifier(p, setup.effects.describeHtml(effects)); box.appendChild(p);
		}
		// What stands at the station, so the player knows what it can give.
		var here = !setup.worldmap.getJourney() || (v.onFoot && v.onFoot.inRailyard) ? v.currentStation : null;
		if (here) {
			var buildings = setup.stationBuildings.describe(here), note = document.createElement('p');
			note.className = 'small-description station-buildings';
			note.textContent = buildings.length ? 'Here: ' + buildings.join(', ') + '.' : 'No station buildings here, only a small emergency store.';
			box.appendChild(note);
		}
		['diesel', 'coal', 'water'].forEach(function(type) {
			recovery.supplyRoutes(type).forEach(function(route) {
				var into = !route.distance && !v.onFoot && !!v.currentTrain;
				var p = recovery.plan(route.station, type, into);
				// An engine that takes no water (a diesel) still lets the player carry some away.
				if (!p && into && type === 'water') { into = false; p = recovery.plan(route.station, type, false); }
				if (!p) return;
				link('Collect from ' + setup.worldmap.getStationName(route.station) + ': ' + setup.units.litres(p.litres) + ' ' + type
					+ (type === 'water' ? ' (grade ' + recovery.waterGrade(route.station) + '%)' : '')
					+ ' (' + setup.time.formatDuration(p.minutes) + ')', function() { return recovery.collect(route.station, type, into); },
					'fatigue:+' + setup.effects.levelForRate(setup.onfoot.FATIGUE_PER_MINUTE));
			});
		});
		// The station HQ's food and clean water.
		if (recovery.atHq()) {
			var hqStock = recovery.stock(recovery.atHq());
			var spend = function(minutes, action) {
				return function() { return setup.time.advanceMinutesWithSystems(minutes, 'manual') && action(); };
			};
			if (recovery.canTakeRation()) link('Take a ration from the station HQ (' + hqStock.rations + ' left) (0:01)', spend(1, function() { return recovery.takeRation(); }));
			if (recovery.canDrinkAtHq()) link('Drink at the station HQ (0:02)', spend(2, function() { return recovery.drinkAtHq(); }), 'thirst:+2');
			if (recovery.hqWaterFill() > 0) link('Fill up with ' + setup.units.litres(recovery.hqWaterFill()) + ' of drinking water (grade '
				+ setup.stationBuildings.GRADES.drinkingWater + '%) (0:02)', spend(2, function() { return recovery.fillDrinkingWater(); }));
			if (!hqStock.rations && !(hqStock.drinkingWater >= setup.condition.DRINK_LITRES)) {
				var empty = document.createElement('p');
				empty.className = 'small-description';
				empty.textContent = 'The station HQ has nothing left.';
				box.appendChild(empty);
			}
		}
		if (!v.onFoot || setup.onfoot.isBesideTrain()) {
			var engine = setup.railyard.getControllingLocomotive(v.currentTrain);
			setup.items.getPlayerCargo().forEach(function(stack) {
				if (engine && setup.refuel.getRoom(engine, stack.type) > 0) link('Load carried ' + stack.type + ' into the locomotive', function() { return recovery.load(stack.type); });
			});
			if (engine && setup.items.getPlayerCarriedKg() < setup.items.PLAYER_CARRY_KG) (engine.cargo || []).forEach(function(stack) {
				if (stack.amount > 0) link('Take ' + stack.type + ' from the locomotive into carried supplies', function() { return recovery.drain(stack.type); });
			});
		}
		if (box.children.length) this.output.appendChild(box);
	}
});
