// Refuelling: the work of keeping a locomotive running between depots.
//
// A diesel locomotive is pumped full from a tanker in its consist. A steam locomotive needs water and something to
// burn: water is pumped from a tanker, from any water beside the line, or from a station's water tank; coal is
// shovelled out of a gondola, firewood is loaded from one, and timber from a flatcar can be cut into firewood. Out
// in a forest, trees can be felled for timber. Cars only count when they are coupled into the consist, so a fuel
// car is something the player chose to haul, with its weight.
//
// The work comes in batches. Each one takes time and tires the player. A batch is worked out again when it is
// carried out, because a firebox keeps burning while the crew works. Fuel keeps its grade as it moves (see
// fuel.js); freshly felled wood is green and burns poorly.
setup.refuel = {
	WATER_TANK_CHANCE: 0.4, // of stations with a water tank
	GREEN_WOOD_GRADE: 50,
	STATION_WATER_GRADE: 75, // a kept tank is fit to drink
	RIVER_WATER_GRADE: 40, // water out of a river is not

	// Every job, in the order the cab lists them.
	//   loco        which locomotives it is for: 'diesel', 'steam', or 'any'
	//   tool        the kit item it needs anywhere in the consist, if any
	//   from        a coupled car to take from: its cargo, and its car type when only one kind of car will do
	//   where       a source in the world instead: 'station-tank', 'beside-water', or 'forest'
	//   into        the cargo it produces, which goes into the locomotive, or into a coupled car if intoCar
	//   unit        what the batch and rate are measured in: 'L' of what is produced, or 'kg'
	//   fatigue     per minute of work
	JOBS: [
		{ id: 'diesel-from-tanker', label: 'Pump diesel from the tanker', loco: 'diesel', tool: 'pump',
			from: { carType: 'tanker car', cargo: 'diesel' }, into: 'diesel', unit: 'L', rate: 20, batch: 400, fatigue: 0.15 },
		{ id: 'water-from-tanker', label: 'Pump water from the tanker', loco: 'steam', tool: 'pump',
			from: { carType: 'tanker car', cargo: 'water' }, into: 'water', unit: 'L', rate: 20, batch: 400, fatigue: 0.15 },
		{ id: 'water-from-tank', label: "Pump water from the station's water tank", loco: 'steam', tool: 'pump',
			where: 'station-tank', into: 'water', unit: 'L', rate: 20, batch: 400, fatigue: 0.15, grade: 75 },
		{ id: 'water-from-river', label: 'Pump water from beside the line', loco: 'steam', tool: 'pump',
			where: 'beside-water', into: 'water', unit: 'L', rate: 20, batch: 400, fatigue: 0.15, grade: 40 },
		{ id: 'coal-from-gondola', label: 'Shovel coal from the gondola into the bunker', loco: 'steam', tool: 'toolkit',
			from: { carType: 'gondola', cargo: 'coal' }, into: 'coal', unit: 'kg', rate: 25, batch: 200, fatigue: 0.4 },
		{ id: 'firewood-from-gondola', label: 'Load firewood from the gondola', loco: 'steam',
			from: { carType: 'gondola', cargo: 'firewood' }, into: 'firewood', unit: 'kg', rate: 30, batch: 200, fatigue: 0.35 },
		{ id: 'cut-timber', label: 'Cut timber into firewood', loco: 'steam', tool: 'axe',
			from: { cargo: 'timber' }, into: 'firewood', unit: 'kg', rate: 15, batch: 150, fatigue: 0.6 },
		{ id: 'chop-trees', label: 'Fell trees for timber', loco: 'any', tool: 'axe',
			where: 'forest', into: 'timber', intoCar: true, unit: 'kg', rate: 10, batch: 300, fatigue: 0.7, grade: 50 }
	],

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
	// The coupled car holding the most of a cargo, of one type if carType is given, so a batch goes as far as it can.
	findSource: function(train, carType, cargoType, except) {
		var best = null;
		(train || []).forEach(function(car) {
			if (car && car !== except && (!carType || car.type === carType)) {
				var amount = setup.railyard.getCargoAmount(car, cargoType);
				if (amount > 0 && (!best || amount > best.amount)) {
					best = { car: car, amount: amount };
				}
			}
		});
		return best;
	},
	// The coupled car, other than a locomotive, with the most room for a cargo. Flatcars are where timber belongs,
	// so one with room is chosen before anything else.
	findDestinationCar: function(train, cargoType) {
		var self = this;
		var best = null;
		(train || []).forEach(function(car) {
			if (!car || setup.items.isLocomotive(car)) {
				return;
			}
			var room = self.getRoom(car, cargoType);
			var preferred = car.type === 'flatcar';
			if (room > 0 && (!best || preferred > best.preferred || (preferred === best.preferred && room > best.room))) {
				best = { car: car, room: room, preferred: preferred };
			}
		});
		return best;
	},
	// Whether a station has a water tank. A fact about the world, so it comes from the seed and is never saved.
	stationHasWaterTank: function(stationId) {
		var worldmap = setup.worldmap;
		return worldmap.rngFor(worldmap.getSeed(), 'water-tank', Math.floor(Number(stationId) || 1))() < this.WATER_TANK_CHANCE;
	},
	// Where the player is, as far as refuelling cares: out on the line, and whether water or forest is beside it;
	// or in a station, and whether it has a water tank.
	getSurroundings: function() {
		var worldmap = setup.worldmap;
		var view = worldmap.getJourneyView();
		if (view) {
			return {
				onLine: true, inForest: view.terrain === 'forest',
				besideWater: worldmap.isBesideWater(worldmap.getSeed(), view.tile.x, view.tile.y)
			};
		}
		var stationId = Number(State.variables.currentStation) || 1;
		return { onLine: false, stationId: stationId, waterTank: this.stationHasWaterTank(stationId) };
	},
	// Why a job's source in the world is not here, or '' if it is. null means the job does not apply here at all.
	getWorldSourceReason: function(where, around) {
		if (where === 'station-tank') {
			return around.onLine ? null : (around.waterTank ? '' : 'this station has no water tank');
		}
		if (where === 'beside-water') {
			return around.onLine ? (around.besideWater ? '' : 'there is no water beside the line here') : null;
		}
		if (where === 'forest') {
			return around.onLine && around.inForest ? '' : 'there are no trees to fell here; stop in a forest';
		}
		return null;
	},
	describeAmount: function(job, kg) {
		var density = setup.railyard.getCargoDensityKgPerLiter(job.into);
		return job.unit === 'L' ? Math.round(kg / density) + ' L' : Math.round(kg) + ' kg';
	},

	// Every refuelling job that applies to this locomotive. Each is ready to run, with its amount, time and effort,
	// or carries the reason it cannot be done, so the player learns what each one needs.
	getOptions: function(train, locoIndex) {
		var loco = Array.isArray(train) ? train[locoIndex] : null;
		var railyard = setup.railyard;
		var self = this;
		if (!setup.items.isLocomotive(loco)) {
			return [];
		}
		var kind = railyard.isSteamLocomotiveCar(loco) ? 'steam' : railyard.isDieselLocomotiveCar(loco) ? 'diesel' : '';
		var around = this.getSurroundings();
		var options = [];

		this.JOBS.forEach(function(job) {
			if (job.loco !== 'any' && job.loco !== kind) {
				return;
			}
			var worldReason = job.where ? self.getWorldSourceReason(job.where, around) : '';
			if (worldReason === null) {
				return;
			}
			var intoDensity = railyard.getCargoDensityKgPerLiter(job.into);
			var source = job.from ? self.findSource(train, job.from.carType, job.from.cargo, loco) : null;
			var destination = job.intoCar ? self.findDestinationCar(train, job.into) : null;
			var room = job.intoCar ? (destination ? destination.room : 0) : self.getRoom(loco, job.into);
			var toolName = job.tool ? (setup.items.CATALOGUE[job.tool] || {}).name : '';

			var reason = job.tool && !setup.items.consistHas(train, job.tool) ? 'you need the ' + toolName.toLowerCase()
				: job.from && !source ? 'no ' + (job.from.carType || 'car') + ' in your consist holds ' + job.from.cargo
				: worldReason ? worldReason
				: room <= 0 ? (job.intoCar ? 'no car in your consist has room for ' + job.into : 'the locomotive can take no more ' + job.into)
				: '';

			var kg = 0;
			if (!reason) {
				var batchKg = job.unit === 'L' ? job.batch * intoDensity : job.batch;
				var sourceKg = source ? source.amount * railyard.getCargoDensityKgPerLiter(job.from.cargo) : Infinity;
				kg = Math.min(batchKg, sourceKg, room * intoDensity);
			}
			var amount = job.unit === 'L' ? kg / intoDensity : kg;
			var minutes = Math.max(1, Math.ceil(amount / job.rate - 1e-9));
			options.push({
				id: job.id, label: job.label, cargoType: job.into, kg: kg, amountText: self.describeAmount(job, kg),
				minutes: minutes, fatigue: Math.round(minutes * job.fatigue), fatiguePerMinute: job.fatigue, reason: reason,
				grade: !setup.fuel.isGraded(job.into) ? null
					: typeof job.grade === 'number' ? job.grade
					: source ? setup.fuel.getGrade(source.car, job.from.cargo) : 100
			});
		});
		return options;
	},

	// Carries out one batch. The amount is worked out again from the current state, so a batch can never overfill
	// or overdraw anything. Weight is kept: a kilogram of timber cut up is a kilogram of firewood, stacked looser.
	perform: function(id, locoIndex) {
		var railyard = setup.railyard;
		var train = State.variables.currentTrain;
		var job = this.JOBS.filter(function(candidate) { return candidate.id === id; })[0];
		var option = this.getOptions(train, locoIndex).filter(function(candidate) { return candidate.id === id; })[0];
		if (!job || !option || option.reason || !(option.kg > 0)) {
			return false;
		}
		var loco = train[locoIndex];
		var destination = job.intoCar ? this.findDestinationCar(train, job.into).car : loco;
		if (job.from) {
			var source = this.findSource(train, job.from.carType, job.from.cargo, loco);
			var litres = option.kg / railyard.getCargoDensityKgPerLiter(job.from.cargo);
			if (!source || !railyard.consumeCargoAmount(source.car, job.from.cargo, Math.min(litres, source.amount))) {
				return false;
			}
		}
		setup.fuel.addCargo(destination, job.into, option.kg / railyard.getCargoDensityKgPerLiter(job.into), option.grade);
		setup.stats.adjust('fatigue', option.fatigue);
		return true;
	}
};

// The refuelling jobs for the locomotive the player is standing in.
Macro.add('refuelControls', {
	handler: function() {
		var variables = State.variables;
		var locoIndex = Number(variables.currentCarIndex);
		var options = setup.refuel.getOptions(variables.currentTrain, locoIndex);
		if (!options.length) {
			return;
		}
		var output = '<h4>Refuelling</h4>';
		options.forEach(function(option) {
			if (option.reason) {
				output += '<span class="small-description"><em>' + option.label + ': ' + option.reason + '.</em></span><br>';
				return;
			}
			var grade = option.grade === null ? '' : ', grade ' + Math.round(option.grade) + '%';
			output += '<<timedlink "' + option.label + ', ' + option.amountText + '" ' + option.minutes + ' "work" "fatigue:+'
				+ setup.effects.levelForRate(option.fatiguePerMinute) + '">>'
				+ '<<run setup.refuel.perform("' + option.id + '", ' + locoIndex + ')>><<goto "TrainInterior">><</timedlink>>'
				+ ' <span class="small-description">(fatigue +' + option.fatigue + grade + ')</span><br>';
		});
		new Wikifier(this.output, output);
	}
});
