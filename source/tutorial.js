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
	flatcarIsAtRear: function(train) {
		if (!Array.isArray(train)) return false;
		var locomotive = train.findIndex(function(car) { return car && car.tractiveCapacity > 0; });
		var flatcar = train.findIndex(function(car) { return car && car.type === 'flatcar'; });
		return locomotive !== -1 && flatcar > locomotive;
	},
	requestExit: function(towardExit) {
		if (!this.isActive() || this.flatcarIsAtRear(State.variables.currentTrain)) {
			return true;
		}
		Dialog.setup('Leave tutorial?');
		Dialog.wiki('<p>Are you sure you want to exit the tutorial without learning how to shunt rail cars?</p>'
			+ '<<link "Exit tutorial">><<run setup.tutorial.finish()>><<run setup.railyard.departOntoLine(' + (!!towardExit) + ')>><<run Dialog.close()>><<goto "OnTheLine">><</link>>'
			+ ' | <<link "Keep shunting">><<run Dialog.close()>><</link>>');
		Dialog.open();
		return false;
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
				text: 'Click on the locomotive below to drive the train, or use the links underneath.'
			};
		}
		if (!this.hasFlatcar(train)) {
			return {
				id: 'couple',
				text: 'The exit to the railyard is blocked. Couple the flatcar to the front of your locomotive to move it.'
			};
		}
		if (!this.flatcarIsAtRear(train)) {
			return {
				id: 'shunt',
				text: 'Good work! Next, we want to attach the flatcar to the rear of the consist. Decouple the front consist, '
					+ 'and navigate to the other track. Then, you can back into the track where the flatcar is to couple to the rear.'
			};
		}
		return {
			id: 'complete',
			text: 'Awesome work! Now you know how to handle basic shunting! There\'s a lot of work ahead of you to survive. Good luck!'
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
