// Refuelling: the work of keeping a locomotive running between depots.
//
// A diesel locomotive is pumped full from a tanker in its consist. A steam locomotive needs water and coal: water is
// pumped from a tanker, from any water beside the line, or from a station's water tank, and coal is shovelled out of
// a gondola into the coal chute. Tankers and gondolas only count when they are coupled into the consist, so a fuel
// car is something the player chose to haul, with its weight.
//
// The work comes in batches. Each one takes time and tires the player, so refuelling is the first thing that drives
// fatigue. A batch is worked out again when it is carried out, because a firebox keeps burning while the crew works.
setup.refuel = {
	PUMP_LITRES_PER_MINUTE: 20,
	PUMP_BATCH_LITRES: 400,
	SHOVEL_KG_PER_MINUTE: 25,
	SHOVEL_BATCH_KG: 200,
	FATIGUE_PER_MINUTE: { pump: 0.15, shovel: 0.4 },
	WATER_TANK_CHANCE: 0.4, // of stations with a water tank

	// How much more of a cargo a car can take: the lesser of what its volume and its weight limits still allow.
	getRoom: function(car, cargoType) {
		var railyard = setup.railyard;
		if (!car || railyard.getAcceptedCargoTypes(car).indexOf(cargoType) === -1) {
			return 0;
		}
		var usedVolume = 0;
		var usedKg = 0;
		(car.cargo || []).forEach(function(cargo) {
			var amount = Math.max(0, Number(cargo.amount) || 0);
			usedVolume += amount;
			usedKg += amount * railyard.getCargoDensityKgPerLiter(cargo.type);
		});
		var byVolume = (Number(car.maxCargoCapacityVolume) || 0) - usedVolume;
		var byWeight = ((Number(car.maxCargoCapacityKg) || 0) - usedKg) / railyard.getCargoDensityKgPerLiter(cargoType);
		return Math.max(0, Math.floor(Math.min(byVolume, byWeight)));
	},
	addCargo: function(car, cargoType, litres) {
		if (!Array.isArray(car.cargo)) {
			car.cargo = [];
		}
		for (var i = 0; i < car.cargo.length; i++) {
			if (car.cargo[i].type === cargoType) {
				car.cargo[i].amount = (Number(car.cargo[i].amount) || 0) + litres;
				return;
			}
		}
		car.cargo.push({ type: cargoType, amount: litres });
	},
	// The coupled car of a type holding the most of a cargo, so each batch goes as far as it can.
	findSource: function(train, carType, cargoType) {
		var best = null;
		(train || []).forEach(function(car) {
			if (car && car.type === carType) {
				var amount = setup.railyard.getCargoAmount(car, cargoType);
				if (amount > 0 && (!best || amount > best.amount)) {
					best = { car: car, amount: amount };
				}
			}
		});
		return best;
	},
	// Whether a station has a water tank. A fact about the world, so it comes from the seed and is never saved.
	stationHasWaterTank: function(stationId) {
		var worldmap = setup.worldmap;
		return worldmap.rngFor(worldmap.getSeed(), 'water-tank', Math.floor(Number(stationId) || 1))() < this.WATER_TANK_CHANCE;
	},
	// Where the player is, as far as refuelling cares: out on the line, and whether water is beside it; or in a
	// station, and whether it has a water tank.
	getSurroundings: function() {
		var worldmap = setup.worldmap;
		var view = worldmap.getJourneyView();
		if (view) {
			return { onLine: true, besideWater: worldmap.isBesideWater(worldmap.getSeed(), view.tile.x, view.tile.y) };
		}
		var stationId = Number(State.variables.currentStation) || 1;
		return { onLine: false, stationId: stationId, waterTank: this.stationHasWaterTank(stationId) };
	},

	// Every refuelling job that applies to this locomotive. Each is ready to run, with its amount, time and effort,
	// or carries the reason it cannot be done, so the player learns what each one needs.
	getOptions: function(train, locoIndex) {
		var loco = Array.isArray(train) ? train[locoIndex] : null;
		var railyard = setup.railyard;
		var self = this;
		var options = [];
		if (!setup.items.isLocomotive(loco)) {
			return options;
		}
		var hasPump = setup.items.consistHas(train, 'pump');
		var hasShovel = setup.items.consistHas(train, 'toolkit');
		var around = this.getSurroundings();

		// A pumping job, from a coupled car or from a source with no bottom to it.
		var pump = function(id, label, cargoType, sourceCarType, sourceMissing) {
			var source = sourceCarType ? self.findSource(train, sourceCarType, cargoType) : null;
			var room = self.getRoom(loco, cargoType);
			var reason = !hasPump ? 'you need the hand pump'
				: sourceCarType && !source ? 'no ' + sourceCarType + ' in your consist holds ' + cargoType
				: sourceMissing ? sourceMissing
				: room <= 0 ? 'the locomotive can take no more ' + cargoType
				: '';
			var litres = reason ? 0 : Math.floor(Math.min(self.PUMP_BATCH_LITRES, source ? source.amount : Infinity, room));
			var minutes = Math.max(1, Math.ceil(litres / self.PUMP_LITRES_PER_MINUTE));
			options.push({
				id: id, label: label, cargoType: cargoType, sourceCarType: sourceCarType, litres: litres,
				minutes: minutes, fatigue: Math.round(minutes * self.FATIGUE_PER_MINUTE.pump), reason: reason
			});
		};

		if (railyard.isDieselLocomotiveCar(loco)) {
			pump('diesel-from-tanker', 'Pump diesel from the tanker', 'diesel', 'tanker car', '');
		}
		if (railyard.isSteamLocomotiveCar(loco)) {
			pump('water-from-tanker', 'Pump water from the tanker', 'water', 'tanker car', '');
			if (around.onLine) {
				pump('water-from-river', 'Pump water from beside the line', 'water', null,
					around.besideWater ? '' : 'there is no water beside the line here');
			} else {
				pump('water-from-tank', "Pump water from the station's water tank", 'water', null,
					around.waterTank ? '' : 'this station has no water tank');
			}

			// Shovelling is measured in kilograms of coal, and coal is carried by volume.
			var coalDensity = railyard.getCargoDensityKgPerLiter('coal');
			var gondola = this.findSource(train, 'gondola', 'coal');
			var coalRoom = this.getRoom(loco, 'coal');
			var shovelReason = !hasShovel ? 'you need the toolkit for its shovel'
				: !gondola ? 'no gondola in your consist holds coal'
				: coalRoom <= 0 ? 'the coal chute is full'
				: '';
			var coalLitres = shovelReason ? 0
				: Math.floor(Math.min(this.SHOVEL_BATCH_KG / coalDensity, gondola.amount, coalRoom));
			var shovelMinutes = Math.max(1, Math.ceil((coalLitres * coalDensity) / this.SHOVEL_KG_PER_MINUTE));
			options.push({
				id: 'coal-from-gondola', label: 'Shovel coal from the gondola into the chute', cargoType: 'coal',
				sourceCarType: 'gondola', litres: coalLitres, minutes: shovelMinutes,
				fatigue: Math.round(shovelMinutes * this.FATIGUE_PER_MINUTE.shovel), reason: shovelReason
			});
		}
		return options;
	},

	// Carries out one batch. The amount is taken again from the current state, capped by what the source still
	// holds and what the locomotive can still take, so a batch can never overfill or overdraw anything.
	perform: function(id, locoIndex) {
		var train = State.variables.currentTrain;
		var option = this.getOptions(train, locoIndex).filter(function(candidate) { return candidate.id === id; })[0];
		if (!option || option.reason || option.litres <= 0) {
			return false;
		}
		var loco = train[locoIndex];
		var litres = Math.min(option.litres, this.getRoom(loco, option.cargoType));
		if (option.sourceCarType) {
			var source = this.findSource(train, option.sourceCarType, option.cargoType);
			if (!source) {
				return false;
			}
			litres = Math.min(litres, source.amount);
			if (litres <= 0 || !setup.railyard.consumeCargoAmount(source.car, option.cargoType, litres)) {
				return false;
			}
		}
		if (litres <= 0) {
			return false;
		}
		this.addCargo(loco, option.cargoType, litres);
		setup.stats.adjust('fatigue', option.fatigue);
		return true;
	}
};

// The refuelling jobs for the locomotive the player is standing in.
Macro.add('refuelControls', {
	handler: function() {
		var variables = State.variables;
		var train = variables.currentTrain;
		var locoIndex = Number(variables.currentCarIndex);
		var options = setup.refuel.getOptions(train, locoIndex);
		if (!options.length) {
			return;
		}
		var output = '<h4>Refuelling</h4>';
		options.forEach(function(option) {
			if (option.reason) {
				output += '<span class="small-description"><em>' + option.label + ': ' + option.reason + '.</em></span><br>';
				return;
			}
			var amount = option.cargoType === 'coal'
				? Math.round(option.litres * setup.railyard.getCargoDensityKgPerLiter('coal')) + ' kg'
				: option.litres + ' L';
			output += '<<timedlink "' + option.label + ', ' + amount + '" ' + option.minutes + ' "work">>'
				+ '<<run setup.refuel.perform("' + option.id + '", ' + locoIndex + ')>><<goto "TrainInterior">><</timedlink>>'
				+ ' <span class="small-description">(fatigue +' + option.fatigue + ')</span><br>';
		});
		new Wikifier(this.output, output);
	}
});
