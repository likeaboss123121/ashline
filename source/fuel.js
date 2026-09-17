// Fuel grades, and what they do to a locomotive.
//
// Diesel, coal, firewood and timber carry a grade from 0 to 100 on each cargo stack. Nothing out here is fresh:
// diesel has sat in tanks for years and oxidised, coal ranges from good steam coal down to crumbling lignite, and
// wood is only as good as it is dry. Pouring one load onto another blends them, so a tank's grade is the average
// of what went in, weighted by volume. Water has no grade. A cargo stack with no grade recorded counts as 100.
//
// What a grade does:
// - Diesel: a degraded fuel makes the engine weaker. The load regulator only asks the engine for what it can give,
//   so the locomotive simply behaves like a less powerful one. Below DIESEL_MIN_GRADE the engine will not run.
// - Coal and firewood: a grade is heat. The firebox burns more of a poor fuel to raise the same steam, up to what
//   the grate can take; past that, steam production falls, and the boiler cannot keep up with the work.
setup.fuel = {
	GRADED: ['diesel', 'coal', 'firewood', 'timber'],
	// Heat per kilogram at grade 100, as a share of good steam coal. Dry firewood gives a little over half.
	HEAT_PER_KG: { coal: 1, firewood: 0.55 },
	// A firebox burns firewood first: it is bulky, and burning it frees the bunker for coal.
	SOLID_FUELS: ['firewood', 'coal'],
	DIESEL_FULL_POWER_GRADE: 90,
	DIESEL_MIN_GRADE: 40,
	DIESEL_POWER_AT_MIN_GRADE: 0.4,
	// The firebox wants 1 kg of good coal a minute per unit of firebox size, and its grate takes at most twice that.
	FIREBOX_HEAT_PER_MINUTE: 1,
	GRATE_KG_PER_MINUTE: 2,
	WATER_LITRES_PER_MINUTE: 3,

	isGraded: function(cargoType) {
		return this.GRADED.indexOf(cargoType) !== -1;
	},
	readGrade: function(stack) {
		var grade = Number(stack && stack.grade);
		return isFinite(grade) && stack.grade !== undefined && stack.grade !== null ? Math.max(0, Math.min(100, grade)) : 100;
	},
	// A car's grade of one cargo: the volume-weighted average of its stacks. An empty hold reads as 100.
	getGrade: function(car, cargoType) {
		var litres = 0;
		var weighted = 0;
		var self = this;
		(car && Array.isArray(car.cargo) ? car.cargo : []).forEach(function(stack) {
			var amount = Math.max(0, Number(stack.amount) || 0);
			if (stack.type === cargoType && amount > 0) {
				litres += amount;
				weighted += amount * self.readGrade(stack);
			}
		});
		return litres > 0 ? weighted / litres : 100;
	},
	// Pours cargo into a car, blending its grade into whatever of the same cargo is already there.
	addCargo: function(car, cargoType, litres, grade) {
		var amount = Math.max(0, Number(litres) || 0);
		if (!car || !amount) {
			return;
		}
		if (!Array.isArray(car.cargo)) {
			car.cargo = [];
		}
		var graded = this.isGraded(cargoType);
		var incoming = graded ? (grade === undefined || grade === null ? 100 : Math.max(0, Math.min(100, Number(grade)))) : null;
		var existing = setup.railyard.getCargoAmount(car, cargoType);
		var blended = graded ? (this.getGrade(car, cargoType) * existing + incoming * amount) / (existing + amount) : null;
		var first = null;
		car.cargo = car.cargo.filter(function(stack) {
			if (stack.type !== cargoType) {
				return true;
			}
			if (!first) {
				first = stack;
				return true;
			}
			return false;
		});
		if (first) {
			first.amount = existing + amount;
		} else {
			first = { type: cargoType, amount: amount };
			car.cargo.push(first);
		}
		if (graded) {
			first.grade = Math.round(blended * 10) / 10;
		}
	},
	// A grade in words. Only diesel can be too far gone to use at all; poor coal or wet wood still burns, badly.
	describeGrade: function(grade, cargoType) {
		var value = Math.round(grade);
		var word = value >= 90 ? 'good' : value >= 70 ? 'fair' : value >= 50 ? 'poor'
			: cargoType === 'diesel' && grade < this.DIESEL_MIN_GRADE ? 'unusable' : 'very poor';
		return value + '% (' + word + ')';
	},

	// --- diesel ---------------------------------------------------------------------------------------------

	// Full power down to DIESEL_FULL_POWER_GRADE, then falling in a straight line to DIESEL_POWER_AT_MIN_GRADE at the
	// lowest grade the engine will run on, and nothing below that.
	getDieselPowerFactor: function(grade) {
		if (grade < this.DIESEL_MIN_GRADE) {
			return 0;
		}
		if (grade >= this.DIESEL_FULL_POWER_GRADE) {
			return 1;
		}
		var span = this.DIESEL_FULL_POWER_GRADE - this.DIESEL_MIN_GRADE;
		return this.DIESEL_POWER_AT_MIN_GRADE + (1 - this.DIESEL_POWER_AT_MIN_GRADE) * (grade - this.DIESEL_MIN_GRADE) / span;
	},
	getDieselLitresPerMinute: function(car) {
		return Number(car && car.dieselLitresPerMinute) > 0 ? Number(car.dieselLitresPerMinute) : 1;
	},
	// Whether a diesel locomotive's engine can run: fuel enough for a minute, of a grade it will burn.
	canDieselRun: function(car) {
		return setup.railyard.getCargoAmount(car, 'diesel') >= this.getDieselLitresPerMinute(car)
			&& this.getGrade(car, 'diesel') >= this.DIESEL_MIN_GRADE;
	},
	// What a locomotive can pull right now. A diesel is derated by its fuel, and pulls nothing with a dead engine.
	// A steam locomotive's limit is its boiler, which the firebox simulation already accounts for minute by minute.
	getEffectiveTractiveKN: function(car) {
		var rated = Number(car && car.tractiveCapacity) || 0;
		if (!(rated > 0)) {
			return 0;
		}
		if (setup.railyard.isDieselLocomotiveCar(car)) {
			return setup.railyard.getCargoAmount(car, 'diesel') > 0
				? rated * this.getDieselPowerFactor(this.getGrade(car, 'diesel'))
				: 0;
		}
		return rated;
	},

	// --- the firebox --------------------------------------------------------------------------------------

	getFireboxScale: function(car) {
		return Number(car && car.fireboxScale) > 0 ? Number(car.fireboxScale) : 1;
	},
	// Works out one minute of firing without burning anything: what to take from each fuel, poorest-to-store first,
	// and the share of the heat the firebox wanted that it would get. The share is below 1 when even a full grate of
	// poor fuel falls short. starved means the bunker ran out before the grate was full or the fire was fed, and
	// then nothing is burnt at all: the fire goes out rather than burning a partial batch.
	planSolidFuelMinute: function(car) {
		var railyard = setup.railyard;
		var scale = this.getFireboxScale(car);
		var wanted = this.FIREBOX_HEAT_PER_MINUTE * scale;
		var grate = this.GRATE_KG_PER_MINUTE * scale;
		var heat = 0;
		var burnt = 0;
		var takes = [];
		for (var i = 0; i < this.SOLID_FUELS.length && heat < wanted - 1e-9 && burnt < grate - 1e-9; i++) {
			var type = this.SOLID_FUELS[i];
			var density = railyard.getCargoDensityKgPerLiter(type);
			var heatPerKg = (this.HEAT_PER_KG[type] || 0) * this.getGrade(car, type) / 100;
			var availableKg = railyard.getCargoAmount(car, type) * density;
			if (!(heatPerKg > 0) || !(availableKg > 0)) {
				continue;
			}
			var kg = Math.min((wanted - heat) / heatPerKg, grate - burnt, availableKg);
			takes.push({ type: type, litres: kg / density });
			heat += kg * heatPerKg;
			burnt += kg;
		}
		var starved = heat < wanted - 1e-9 && burnt < grate - 1e-9;
		return { takes: takes, output: starved ? 0 : Math.min(1, heat / wanted), starved: starved };
	},
	// Burns one minute of solid fuel and returns the share of the wanted heat it gave, or 0 if the fire is starved.
	burnSolidFuelMinute: function(car) {
		var plan = this.planSolidFuelMinute(car);
		if (plan.starved) {
			return 0;
		}
		plan.takes.forEach(function(take) {
			setup.railyard.consumeCargoAmount(car, take.type, Math.min(take.litres, setup.railyard.getCargoAmount(car, take.type)));
		});
		return plan.output;
	},
	// How well the fuel in the bunker would keep the fire, without burning any: for the cab's gauges.
	getFireboxOutput: function(car) {
		return this.planSolidFuelMinute(car).output;
	},
	hasSolidFuel: function(car) {
		var railyard = setup.railyard;
		return this.SOLID_FUELS.some(function(type) { return railyard.getCargoAmount(car, type) > 1e-9; });
	},
	// A short line of what is in the bunker, for the cab.
	describeBunker: function(car) {
		var railyard = setup.railyard;
		var self = this;
		var parts = this.SOLID_FUELS.slice().reverse().filter(function(type) {
			return railyard.getCargoAmount(car, type) > 0;
		}).map(function(type) {
			return type.charAt(0).toUpperCase() + type.slice(1) + ': ' + railyard.getCargoAmount(car, type).toFixed(1)
				+ ' L, grade ' + self.describeGrade(self.getGrade(car, type), type);
		});
		return parts.length ? parts.join('; ') : 'Bunker empty';
	}
};
