// Units. Everything in the game is worked out in metric; this is only about how a number is written down.
//
// When the player asks for imperial, a value is converted once, on its way to the screen, and shown to a tenth at
// most: a rounded number that reads like a gauge rather than a conversion. Nothing here is ever fed back into the
// simulation, so switching units mid-game changes no outcome.
setup.units = {
	isImperial: function() {
		return !!State.variables.imperialUnits;
	},
	// A tenth, truncated rather than rounded, so a reading never claims more than it has.
	toTenth: function(value) {
		var number = Number(value) || 0;
		var truncated = Math.trunc(number * 10) / 10;
		return String(truncated % 1 === 0 ? truncated : truncated.toFixed(1));
	},
	whole: function(value) {
		return String(Math.trunc(Number(value) || 0));
	},
	kilometres: function(km) {
		return this.isImperial() ? this.toTenth(km * 0.621371) + ' mi' : this.toTenth(km) + ' km';
	},
	metres: function(metres) {
		return this.isImperial() ? this.whole(metres * 3.28084) + ' ft' : this.whole(metres) + ' m';
	},
	kilometresPerHour: function(kmh) {
		return this.isImperial() ? this.whole(kmh * 0.621371) + ' mph' : this.whole(kmh) + ' km/h';
	},
	tonnes: function(tonnes) {
		return this.isImperial() ? this.toTenth(tonnes * 1.10231) + ' tons' : this.toTenth(tonnes) + ' t';
	},
	kilograms: function(kg) {
		return this.isImperial() ? this.whole(kg * 2.20462) + ' lb' : this.whole(kg) + ' kg';
	},
	litres: function(litres) {
		return this.isImperial() ? this.toTenth(litres * 0.264172) + ' gal' : this.whole(litres) + ' L';
	},
	temperature: function(celsius) {
		return this.isImperial()
			? this.toTenth(celsius * 9 / 5 + 32) + '°F'
			: this.toTenth(celsius) + '°C';
	},
	// The weather where the player is standing, which comes from the tile's climate.
	getOutsideTemperature: function() {
		var worldmap = setup.worldmap;
		var view = worldmap.getJourneyView();
		var tile = view ? view.tile : worldmap.getStationTile(worldmap.getSeed(), Number(State.variables.currentStation) || 1);
		return worldmap.getClimate(worldmap.getSeed(), tile.x, tile.y).temperature;
	}
};

// The outside temperature, under the clock in the sidebar.
Macro.add('outsideTemperature', {
	handler: function() {
		var reading = document.createElement('div');
		reading.className = 'small-description sidebar-temperature';
		reading.textContent = setup.units.temperature(setup.units.getOutsideTemperature()) + ' outside';
		this.output.appendChild(reading);
	}
});
