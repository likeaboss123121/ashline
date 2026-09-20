// Station supplies are finite, saved on a track object (never an array property).
// They can be carried by hand even when an engine cannot move or its kit is missing.
setup.recovery = {
	INITIAL_STOCK: { diesel: 12000, coal: 5000, water: 30000 },
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
		if (!branch) distances = [{ station: j.legIndex, distance: index }, { station: j.legIndex + 1, distance: main.length - 1 - index }];
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
		var routes = this.stations(), self = this, world = setup.worldmap;
		if (!routes.length || routes.some(function(r) { return self.stock(r.station)[type] >= 1; })) return routes;
		// Exhausted depots stay exhausted. A longer walking trip can reach the next stocked depot instead.
		var onward = routes.filter(function(r) { return typeof r.station === 'number'; }).sort(function(a, b) { return b.station - a.station; })[0];
		if (!onward) {
			var branch = world.getBranchForStation(world.getSeed(), State.variables.currentStation);
			onward = { station: branch.legIndex + 1, distance: branch.tiles.length + world.getMainLine(world.getSeed(), branch.legIndex).length - 1 - branch.fromIndex };
		}
		var station = onward.station, distance = onward.distance;
		do {
			distance += world.getMainLine(world.getSeed(), station).length - 1;
			station++;
		} while (State.variables.stationTracks[station] && this.stock(station)[type] < 1);
		return routes.concat([{ station: station, distance: distance }]);
	},
	plan: function(station, type, intoEngine) {
		if (!Object.prototype.hasOwnProperty.call(this.INITIAL_STOCK, type)) return null;
		var route = this.supplyRoutes(type).find(function(s) { return String(s.station) === String(station); });
		if (!route) return null;
		var v = State.variables, engine = v.currentTrain && v.currentTrain[v.currentCarIndex];
		if (intoEngine && (route.distance || v.journey || !setup.items.isLocomotive(engine) || engine.broken)) return null;
		var density = setup.railyard.getCargoDensityKgPerLiter(type);
		var room = intoEngine ? setup.refuel.getRoom(engine, type)
			: (setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg()) / density;
		var stock = this.stock(route.station);
		var litres = Math.floor(Math.min(stock[type], room, intoEngine ? 400 : 20 / density));
		if (litres < 1) return null;
		return { station: route.station, type: type, litres: litres, intoEngine: !!intoEngine, engine: engine,
			minutes: route.distance * setup.onfoot.MINUTES_PER_TILE * 2 + Math.ceil(litres * density / 10) + 1 };
	},
	collect: function(station, type, intoEngine) {
		var p = this.plan(station, type, intoEngine);
		if (!p) return false;
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
		var density = setup.railyard.getCargoDensityKgPerLiter(type);
		var amount = Math.min(20 / density, setup.railyard.getCargoAmount(engine, type),
			(setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg()) / density);
		if (!(amount > 0)) return false;
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
				link((route.distance ? 'Walk to ' : 'Collect from ') + setup.worldmap.getStationName(route.station)
					+ (route.distance ? ' and back for ' : ': ') + setup.units.litres(p.litres) + ' ' + type
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
