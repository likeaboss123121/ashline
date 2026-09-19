// The first station teaches shunting by asking for it.
//
// Station 1 is laid out so the way out is blocked: the locomotive stands on a stub and a loaded flatcar sits on the
// through track between it and the exit. The hints below follow what the player has actually done rather than a
// stored step counter, so they cannot fall out of step with the yard, and they stop for good once the player has
// left the station for the first time.
setup.tutorial = {
	STATION: 1,
	STUB_TRACK: 0,
	SETOUT_TRACK: 2,
	EXIT_TRACK: 3,

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
	getFlatcarTrackIndex: function(tracks) {
		if (!Array.isArray(tracks)) return -1;
		for (var i = 0; i < tracks.length; i++) {
			for (var j = 0; j < tracks[i].trains.length; j++) {
				if (this.hasFlatcar(tracks[i].trains[j])) return i;
			}
		}
		return -1;
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
		var flatcarTrack = this.getFlatcarTrackIndex(tracks);
		if (!this.hasFlatcar(train) && flatcarTrack === this.EXIT_TRACK) {
			return {
				id: 'couple',
				text: 'The exit to the railyard is blocked. Couple the flatcar to the front of your locomotive to move it.'
			};
		}
		if (!this.flatcarIsAtRear(train)) {
			if (this.hasFlatcar(train) && Number(variables.drivingTrackIndex) !== this.SETOUT_TRACK) {
				return { id: 'move-flatcar', text: 'Move the consist and flatcar to the empty Yard Track 2.' };
			}
			if (this.hasFlatcar(train)) {
				return { id: 'decouple-flatcar', text: 'Decouple the front section to leave the flatcar on Yard Track 2.' };
			}
			if (flatcarTrack === this.SETOUT_TRACK && Number(variables.drivingTrackIndex) === this.SETOUT_TRACK) {
				return { id: 'runaround-stub', text: 'Reverse the locomotive onto the Southbound Track stub so it can run around the flatcar.' };
			}
			if (flatcarTrack === this.SETOUT_TRACK && Number(variables.drivingTrackIndex) === this.STUB_TRACK) {
				return { id: 'runaround-lead', text: 'Drive the locomotive around to the Northbound Track, on the other side of the flatcar.' };
			}
			if (flatcarTrack === this.SETOUT_TRACK && Number(variables.drivingTrackIndex) === this.EXIT_TRACK) {
				return { id: 'couple-rear', text: 'Back into the flatcar and couple it to the rear of the locomotive.' };
			}
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

// The general shunting controls stay available throughout the tutorial.  These short, state-aware links expose
// the intended run-around route so the first lesson cannot depend on discovering a dense yard-control menu.
Macro.add('tutorialControls', {
	handler: function() {
		if (!setup.tutorial.isActive() || !Array.isArray(State.variables.currentTrain)) return;
		var tracks = State.variables.stationTracks[setup.tutorial.STATION];
		var train = State.variables.currentTrain;
		var flatcarTrack = setup.tutorial.getFlatcarTrackIndex(tracks);
		var currentTrack = Number(State.variables.drivingTrackIndex);
		var output = '';
		if (setup.tutorial.hasFlatcar(train) && !setup.tutorial.flatcarIsAtRear(train) && currentTrack !== setup.tutorial.SETOUT_TRACK) {
			output = '<<timedlink "Move consist to Yard Track 2" 1 "shunting" "fatigue:+1">><<set $drivingTrackIndex = 2>><<set $enteredTrainIndex = 0>><<goto "DrivingMode">><</timedlink>>';
		} else if (!setup.tutorial.hasFlatcar(train) && flatcarTrack === setup.tutorial.SETOUT_TRACK && currentTrack === setup.tutorial.SETOUT_TRACK) {
			output = '<<timedlink "Reverse locomotive to Southbound Track" 1 "shunting" "fatigue:+1">><<set $drivingTrackIndex = 0>><<set $enteredTrainIndex = 0>><<goto "DrivingMode">><</timedlink>>';
		} else if (!setup.tutorial.hasFlatcar(train) && flatcarTrack === setup.tutorial.SETOUT_TRACK && currentTrack === setup.tutorial.STUB_TRACK) {
			output = '<<timedlink "Drive locomotive to Northbound Track" 1 "shunting" "fatigue:+1">><<set $drivingTrackIndex = 3>><<set $enteredTrainIndex = 0>><<goto "DrivingMode">><</timedlink>>';
		}
		if (output) new Wikifier(this.output, '<p class="tutorial-controls">' + output + '</p>');
	}
});
