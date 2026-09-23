// Station supplies are finite, saved on a track object (never an array property).
// They can be carried by hand even when an engine cannot move; diesel needs the player's 20 L jerrycan.
setup.recovery = {
	INITIAL_STOCK: { diesel: 2000, coal: 5000, water: 12000 },
	GRADE: 89,
	ensureStock: function(tracks) {
		if (!tracks[0].supplies) tracks[0].supplies = Object.assign({}, this.INITIAL_STOCK);
		return tracks[0].supplies;
	},
	stock: function(station) {
		var v = State.variables;
		if (!v.stationTracks[station]) v.stationTracks[station] = setup.railyard.generateStationTracks(station, v.randomSeed);
		return this.ensureStock(v.stationTracks[station]);
	},
	// Distances follow rail connections, including either exit of a rejoining branch.
	stations: function() {
		var v = State.variables, world = setup.worldmap, j = world.getJourney();
		if (!j) return [{ station: v.currentStation, distance: 0 }];
		if (!v.onFoot) return [];
		var foot = setup.onfoot.get(), leg = world.getLeg(world.getSeed(), j.legIndex);
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
		if (!Object.prototype.hasOwnProperty.call(this.INITIAL_STOCK, type)) return null;
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
		this.stock(p.station)[type] -= p.litres;
		if (p.intoEngine) setup.fuel.addCargo(p.engine, type, p.litres, this.GRADE);
		else setup.items.addPlayerCargo(type, p.litres, this.GRADE);
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
		['diesel', 'coal', 'water'].forEach(function(type) {
			recovery.supplyRoutes(type).forEach(function(route) {
				var into = !route.distance && !v.onFoot && !!v.currentTrain;
				var p = recovery.plan(route.station, type, into);
				if (!p) return;
				link('Collect from ' + setup.worldmap.getStationName(route.station) + ': ' + setup.units.litres(p.litres) + ' ' + type
					+ ' (' + setup.time.formatDuration(p.minutes) + ')', function() { return recovery.collect(route.station, type, into); },
					'fatigue:+' + setup.effects.levelForRate(setup.onfoot.FATIGUE_PER_MINUTE));
			});
		});
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
