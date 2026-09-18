// The survival loop: what the passing hours do to the player, and what the player can do about it.
//
// Every minute the game advances, this runs. Fatigue climbs with the hours awake and climbs faster while working;
// hunger and thirst fall; sanity mends by day and frays in the small hours; and going without food or water eats
// into health and immunity. Let fatigue fill and the player collapses where they stand.
//
// Three things make everything worse at once, and they are deliberately the same three levers: an empty stomach, a
// dry throat and a failing immune system all make fatigue climb faster and make rest worth less. So neglecting the
// cheap needs makes the expensive one (time asleep) cost more.
setup.condition = {
	// Fatigue fills in about 25 hours of idling, and in about 14 with a working day's worth of jobs on top.
	FATIGUE_PER_MINUTE_AWAKE: 100 / (25.5 * 60),
	// A full night's sleep, eight hours, clears a full bar when the player is fed, watered and well.
	FATIGUE_RECOVERED_PER_MINUTE_ASLEEP: 100 / (8 * 60),
	HUNGER_PER_MINUTE: 100 / (24 * 60), // a day from full to empty
	THIRST_PER_MINUTE: 100 / (14 * 60), // thirst comes on faster than hunger
	SANITY_MEND_PER_MINUTE: 100 / (400 * 60), // a slow drift back up, a few points a day
	SANITY_NIGHT_LOSS_PER_MINUTE: 100 / (60 * 60), // a night spent awake between midnight and five costs about five
	SANITY_ASLEEP_MULTIPLIER: 3,
	NIGHT_FROM_HOUR: 0,
	NIGHT_TO_HOUR: 5,
	// What an empty stomach or a dry throat costs, per minute, once there is nothing left to take.
	STARVED_HEALTH_PER_MINUTE: 100 / (60 * 60),
	STARVED_IMMUNITY_PER_MINUTE: 100 / (40 * 60),
	// Mending, for a player who is fed, watered and not worn out.
	HEALTH_MEND_PER_MINUTE: 100 / (72 * 60),
	IMMUNITY_MEND_PER_MINUTE: 100 / (60 * 60),
	MEND_FATIGUE_LIMIT: 70, // too tired to heal
	NEED_PRESSURE_FROM: 25, // hunger or thirst below this starts to tell on everything else
	FAINT_HOURS: [2, 6],
	FAINT_FATIGUE_RECOVERED: 25,
	FAINT_SANITY_COST: 8,
	// Eating and drinking.
	RATION_HUNGER: 34, // three rations to a day
	RATION_QUALITY: 70,
	DRINK_LITRES: 2,
	DRINK_THIRST: 40,
	// How far a meal or a drink can move immunity, at quality 100 and quality 0.
	CONSUMABLE_IMMUNITY: { best: 1.5, worst: -6 },

	// Fractions carry between minutes so a rate slower than one point a minute still arrives. They live on the
	// player, because they are part of the body's state, not of the world.
	getCarry: function() {
		var player = State.variables.player;
		if (!player) {
			return null;
		}
		if (!player.carry || typeof player.carry !== 'object') {
			player.carry = {};
		}
		return player.carry;
	},
	// Moves a stat by a fractional amount, keeping the remainder for later.
	apply: function(key, delta) {
		var carry = this.getCarry();
		if (!carry || !delta) {
			return;
		}
		var total = (Number(carry[key]) || 0) + delta;
		var whole = total > 0 ? Math.floor(total) : Math.ceil(total);
		carry[key] = total - whole;
		if (whole) {
			setup.stats.adjust(key, whole);
		}
	},
	// 0 when a need is comfortable, rising to 1 when it is empty.
	getNeedPressure: function(key) {
		var value = setup.stats.getValue(key);
		if (value >= this.NEED_PRESSURE_FROM) {
			return 0;
		}
		return (this.NEED_PRESSURE_FROM - value) / this.NEED_PRESSURE_FROM;
	},
	// Hunger, thirst and a failing immune system all make the work harder.
	getFatigueMultiplier: function() {
		return 1 + 0.5 * (1 - setup.stats.getValue('immunity') / 100)
			+ 0.35 * this.getNeedPressure('hunger') + 0.35 * this.getNeedPressure('thirst');
	},
	// The same three take the good out of a night's sleep.
	getRestEfficiency: function() {
		var loss = 0.4 * (1 - setup.stats.getValue('immunity') / 100)
			+ 0.3 * this.getNeedPressure('hunger') + 0.3 * this.getNeedPressure('thirst');
		return Math.max(0.25, 1 - loss);
	},
	isNight: function() {
		var hour = new Date(setup.time.getCurrentTimestampMs()).getUTCHours();
		return hour >= this.NIGHT_FROM_HOUR && hour < this.NIGHT_TO_HOUR;
	},

	// One minute of being alive. mode is 'sleep' while the player is asleep or out cold, and anything else awake.
	tickMinute: function(mode) {
		if (!State.variables.player) {
			return;
		}
		var asleep = mode === 'sleep';
		var stats = setup.stats;

		if (asleep) {
			this.apply('fatigue', -this.FATIGUE_RECOVERED_PER_MINUTE_ASLEEP * this.getRestEfficiency());
		} else {
			this.apply('fatigue', this.FATIGUE_PER_MINUTE_AWAKE * this.getFatigueMultiplier());
		}

		this.apply('hunger', -this.HUNGER_PER_MINUTE * (asleep ? 0.6 : 1));
		this.apply('thirst', -this.THIRST_PER_MINUTE * (asleep ? 0.6 : 1));

		// The small hours are hard on a mind that should be asleep, and kind to one that is.
		if (this.isNight()) {
			this.apply('sanity', asleep
				? this.SANITY_NIGHT_LOSS_PER_MINUTE * this.SANITY_ASLEEP_MULTIPLIER
				: -this.SANITY_NIGHT_LOSS_PER_MINUTE);
		} else {
			this.apply('sanity', this.SANITY_MEND_PER_MINUTE * (asleep ? this.SANITY_ASLEEP_MULTIPLIER : 1));
		}

		// An empty stomach or a dry throat starts taking it out of the body itself.
		var starved = this.getNeedPressure('hunger');
		var parched = this.getNeedPressure('thirst');
		var strain = Math.max(starved, parched);
		if (strain > 0) {
			this.apply('health', -this.STARVED_HEALTH_PER_MINUTE * strain);
			this.apply('immunity', -this.STARVED_IMMUNITY_PER_MINUTE * strain);
		} else if (stats.getValue('fatigue') < this.MEND_FATIGUE_LIMIT) {
			this.apply('health', this.HEALTH_MEND_PER_MINUTE * (asleep ? 2 : 1));
			this.apply('immunity', this.IMMUNITY_MEND_PER_MINUTE * (asleep ? 2 : 1));
		}
	},

	// --- collapsing ------------------------------------------------------------------------------------------

	isCollapsed: function() {
		return !!State.variables.player && setup.stats.getValue('fatigue') >= setup.stats.MAX;
	},
	// How long the player is out for: two to six hours, from the world seed and the clock, so it is not a fresh
	// coin toss on every reload of the same moment.
	getFaintMinutes: function() {
		var rng = setup.worldmap.rngFor(setup.worldmap.getSeed(), 'faint', Math.floor(setup.time.getCurrentTimestampMs() / 60000));
		var span = this.FAINT_HOURS[1] - this.FAINT_HOURS[0];
		return Math.round((this.FAINT_HOURS[0] + rng() * span) * 60);
	},
	// Drops the player where they stand. Returns what happened, for the message the player reads.
	collapse: function() {
		var minutes = this.getFaintMinutes();
		setup.stats.adjust('sanity', -this.FAINT_SANITY_COST);
		var before = setup.stats.getValue('fatigue');
		setup.time.advanceMinutesAsleep(minutes);
		// Collapsing is not sleeping. However long the player was out, they come round a quarter of the bar better
		// and no more, which is what makes lying down in a bedroll worth the time it costs.
		setup.stats.setValue('fatigue', Math.max(0, before - this.FAINT_FATIGUE_RECOVERED));
		State.variables.pendingCollapse = {
			minutes: minutes,
			text: 'You come round on the cab floor with no memory of falling. ' + setup.time.formatDuration(minutes)
				+ ' has gone, and you feel no better for it.'
		};
		return State.variables.pendingCollapse;
	},

	// --- what the player can do ------------------------------------------------------------------------------

	// Moves immunity by the quality of what was just eaten or drunk: good stuff helps a little, bad stuff hurts.
	applyConsumableQuality: function(quality) {
		var scale = Math.max(0, Math.min(100, Number(quality) || 0)) / 100;
		var range = this.CONSUMABLE_IMMUNITY;
		setup.stats.adjust('immunity', Math.round(range.worst + (range.best - range.worst) * scale));
	},
	// The best water the consist can offer: a locomotive's tank or any coupled tanker. Water carries a grade, which
	// is how clean it is, so river water drunk straight is a gamble.
	findDrink: function(train) {
		var best = null;
		(Array.isArray(train) ? train : []).forEach(function(car) {
			var litres = setup.railyard.getCargoAmount(car, 'water');
			if (litres >= setup.condition.DRINK_LITRES) {
				var grade = setup.fuel.getGrade(car, 'water');
				if (!best || grade > best.grade) {
					best = { car: car, grade: grade, litres: litres };
				}
			}
		});
		return best;
	},
	countRations: function(train) {
		return (Array.isArray(train) ? train : []).reduce(function(total, car) {
			return total + setup.items.countItem(car, 'rations');
		}, 0);
	},
	eat: function(train) {
		var car = (Array.isArray(train) ? train : []).filter(function(candidate) {
			return setup.items.countItem(candidate, 'rations') > 0;
		})[0];
		if (!car || !setup.items.remove(car, 'rations', 1)) {
			return false;
		}
		setup.stats.adjust('hunger', this.RATION_HUNGER);
		this.applyConsumableQuality(this.RATION_QUALITY);
		return true;
	},
	drink: function(train) {
		var source = this.findDrink(train);
		if (!source || !setup.railyard.consumeCargoAmount(source.car, 'water', this.DRINK_LITRES)) {
			return false;
		}
		setup.stats.adjust('thirst', this.DRINK_THIRST);
		this.applyConsumableQuality(source.grade);
		return true;
	},
	hasBedroll: function(train) {
		return setup.items.consistHas(train, 'sleepingBag');
	},
	// How long until the player would wake up rested, capped so "until rested" can never run for ever.
	getMinutesUntilRested: function() {
		var rate = this.FATIGUE_RECOVERED_PER_MINUTE_ASLEEP * this.getRestEfficiency();
		return Math.max(1, Math.min(16 * 60, Math.ceil(setup.stats.getValue('fatigue') / rate)));
	},
	sleep: function(minutes) {
		var span = Math.max(1, Math.floor(Number(minutes) || 0));
		setup.time.advanceMinutesAsleep(span);
		return span;
	},
	// Lying down is the natural place to save: the player has stopped, and nothing is half-done.
	AUTOSAVE_SLOT: 0,
	autosaveAfterSleep: function() {
		if (!State.variables.autosaveOnSleep) {
			return false;
		}
		return setup.saves.save(this.AUTOSAVE_SLOT, true);
	}
};

// The eating, drinking and sleeping controls, shown wherever the player is standing in their train.
Macro.add('conditionControls', {
	handler: function() {
		var train = State.variables.currentTrain;
		if (!Array.isArray(train) || !train.length) {
			return;
		}
		var condition = setup.condition;
		var rations = condition.countRations(train);
		var drink = condition.findDrink(train);
		var output = '<h4>Rest and rations</h4>';

		if (rations > 0) {
			output += '<<timedlink "Eat a ration" 10 "rest" "hunger:+2">><<run setup.condition.eat($currentTrain)>>'
				+ '<<goto "TrainInterior">><</timedlink>> <span class="small-description">('
				+ rations + ' left)</span><br>';
		} else {
			output += '<span class="small-description"><em>Eat a ration: you have none left.</em></span><br>';
		}

		if (drink) {
			output += '<<timedlink "Drink" 2 "rest" "thirst:+2">><<run setup.condition.drink($currentTrain)>>'
				+ '<<goto "TrainInterior">><</timedlink>> <span class="small-description">(water at grade '
				+ Math.round(drink.grade) + '%)</span><br>';
		} else {
			output += '<span class="small-description"><em>Drink: there is no water aboard to drink.</em></span><br>';
		}

		if (condition.hasBedroll(train)) {
			output += '<<link "Lie down to sleep">><<goto "Sleep">><</link>><br>';
		} else {
			output += '<span class="small-description"><em>Sleep: you have no bedroll aboard.</em></span><br>';
		}
		new Wikifier(this.output, output);
	}
});

// The sleep screen: a handful of hours, or as long as it takes.
Macro.add('sleepChoices', {
	handler: function() {
		var condition = setup.condition;
		var untilRested = condition.getMinutesUntilRested();
		var output = '';
		for (var hours = 1; hours <= 8; hours++) {
			output += '<<timedlink "Sleep ' + hours + ' hour' + (hours === 1 ? '' : 's') + '" ' + (hours * 60)
				+ ' "sleep" "fatigue:-3">><<run setup.condition.autosaveAfterSleep()>><<goto "TrainInterior">><</timedlink>><br>';
		}
		output += '<<timedlink "Sleep until rested" ' + untilRested + ' "sleep" "fatigue:-3">>'
			+ '<<run setup.condition.autosaveAfterSleep()>><<goto "TrainInterior">><</timedlink>><br>';
		new Wikifier(this.output, output);
	}
});

// What the player reads after waking from a collapse, shown once wherever they come round.
Macro.add('collapseNotice', {
	handler: function() {
		var collapse = State.variables.pendingCollapse;
		if (!collapse || !collapse.text) {
			return;
		}
		State.variables.pendingCollapse = null;
		new Wikifier(this.output, '<p class="collapse-notice">' + collapse.text + '</p>');
	}
});
