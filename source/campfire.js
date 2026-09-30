// A small wilderness fire lasts eight hours at the tile where it was built.
setup.campfire = {
	FIREWOOD_KG: 3,
	BUILD_MINUTES: 15,
	DURATION_MINUTES: 8 * 60,
	location: function() {
		var journey = setup.worldmap.getJourney();
		if (!journey) return null;
		var foot = setup.onfoot && setup.onfoot.get();
		return { legIndex: foot && foot.legIndex || journey.legIndex, tileIndex: foot ? foot.tileIndex : journey.tileIndex };
	},
	isHere: function() {
		var fire = State.variables.campfire, here = this.location();
		return !!fire && !!here && fire.expiresAt > setup.time.getCurrentTimestampMs()
			&& fire.legIndex === here.legIndex && fire.tileIndex === here.tileIndex;
	},
	sources: function() {
		var sources = [], carried = setup.items.getPlayerCargo().find(function(s) { return s.type === 'firewood'; });
		if (carried) sources.push({ carried: true, stack: carried });
		setup.food.accessibleTrain().forEach(function(car) {
			if (setup.railyard.getCargoAmount(car, 'firewood') > 0) sources.push({ car: car });
		});
		return sources;
	},
	availableKg: function() {
		var density = setup.railyard.getCargoDensityKgPerLiter('firewood');
		return this.sources().reduce(function(total, source) {
			return total + (source.carried ? source.stack.amount : setup.railyard.getCargoAmount(source.car, 'firewood')) * density;
		}, 0);
	},
	canBuild: function() { return !!this.location() && !this.isHere() && this.availableKg() + 1e-9 >= this.FIREWOOD_KG; },
	build: function() {
		if (!this.canBuild()) return false;
		var litres = this.FIREWOOD_KG / setup.railyard.getCargoDensityKgPerLiter('firewood'), remaining = litres;
		this.sources().forEach(function(source) {
			if (!(remaining > 0)) return;
			var available = source.carried ? source.stack.amount : setup.railyard.getCargoAmount(source.car, 'firewood');
			var take = Math.min(available, remaining);
			if (source.carried) setup.items.removePlayerCargo('firewood', take);
			else setup.railyard.consumeCargoAmount(source.car, 'firewood', take);
			remaining -= take;
		});
		var here = this.location();
		State.variables.campfire = { legIndex: here.legIndex, tileIndex: here.tileIndex,
			expiresAt: setup.time.getCurrentTimestampMs() + this.DURATION_MINUTES * 60000 };
		return true;
	}
};
Macro.add('campfireControls', {
	handler: function() {
		if (!setup.worldmap.getJourney()) return;
		if (setup.campfire.isHere()) new Wikifier(this.output, '<p class="small-description">A campfire is burning here.</p>');
		else if (setup.campfire.canBuild()) new Wikifier(this.output,
			'<<timedlink "Set up a campfire (' + setup.campfire.FIREWOOD_KG + ' kg firewood)" '
			+ setup.campfire.BUILD_MINUTES + ' "manual" "fatigue:+1">><<run setup.campfire.build()>><<run Engine.play(State.passage)>><</timedlink>>');
	}
});
