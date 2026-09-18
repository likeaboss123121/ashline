// The first station teaches shunting by asking for it.
//
// Station 1 is laid out so the way out is blocked: the locomotive stands on a stub and a loaded flatcar sits on the
// through track between it and the exit. The hints below follow what the player has actually done rather than a
// stored step counter, so they cannot fall out of step with the yard, and they stop for good once the player has
// left the station for the first time.
setup.tutorial = {
	STATION: 1,

	isFinished: function() {
		return !!State.variables.tutorialDone;
	},
	finish: function() {
		State.variables.tutorialDone = true;
	},
	isActive: function() {
		return !this.isFinished() && Number(State.variables.currentStation) === this.STATION;
	},
	hasFlatcar: function(train) {
		return (Array.isArray(train) ? train : []).some(function(car) { return car && car.type === 'flatcar'; });
	},
	// Which hint belongs on the screen, from the state of the yard itself.
	getHint: function() {
		if (!this.isActive()) {
			return null;
		}
		var variables = State.variables;
		var train = variables.currentTrain;
		var aboard = Array.isArray(train) && train.length;
		var tracks = variables.stationTracks ? variables.stationTracks[this.STATION] : null;
		if (!Array.isArray(tracks)) {
			return null;
		}
		if (!aboard) {
			return {
				id: 'board',
				text: 'Everything you do here happens on the drawing. Click the locomotive on Yard Track 1 to climb aboard, '
					+ 'or use the links underneath: the picture and the list always offer the same moves.'
			};
		}
		if (this.hasFlatcar(train)) {
			return {
				id: 'depart',
				text: 'The flatcar is on your drawbar. Click the far end of the Northbound Track, at the bottom right, to '
					+ 'leave the station, or take the departure link below the drawing.'
			};
		}
		return {
			id: 'couple',
			text: 'You are standing on a stub, and a loaded flatcar is parked across the northbound road out of here. '
				+ 'Nothing leaves this station until it is moved: click the flatcar to couple to it. Every move costs '
				+ 'time, and the clock is in the sidebar.'
		};
	}
};

// The tutorial hint for wherever the player is standing in the first station.
Macro.add('tutorialHint', {
	handler: function() {
		var hint = setup.tutorial.getHint();
		if (!hint) {
			return;
		}
		new Wikifier(this.output, '<p class="tutorial-hint" data-hint="' + hint.id + '">' + hint.text + '</p>');
	}
});
