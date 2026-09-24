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
	isSuggested: function(key) {
		var hint = this.getHint();
		var actions = { couple: 'couple-front:3:0', 'move-flatcar': 'track:2',
			'decouple-flatcar': 'decouple:front', 'runaround-stub': 'track:0',
			'runaround-lead': 'track:3', 'couple-rear': 'couple-rear:2:0' };
		return !!hint && actions[hint.id] === key;
	},
	markTarget: function(element) {
		var key = element.getAttribute('data-yard-target');
		var hint = this.getHint();
		if (!hint) return;
		var suffix = key.replace(/^train:/, '');
		if (this.isSuggested(key) || (key.indexOf('train:') === 0
			&& (this.isSuggested('couple-front:' + suffix) || this.isSuggested('couple-rear:' + suffix)
				|| (hint.id === 'board' && key === 'train:1:0')))) {
			element.classList.add('tutorial-next-target');
		}
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
				text: 'Click on the locomotive above to drive the train, or use the links underneath.'
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
				return { id: 'runaround-stub', text: 'Reverse the locomotive onto the ' + setup.railyard.getTrackLabel(tracks, this.STUB_TRACK) + ' so it can run around the flatcar.' };
			}
			if (flatcarTrack === this.SETOUT_TRACK && Number(variables.drivingTrackIndex) === this.STUB_TRACK) {
				return { id: 'runaround-lead', text: 'Drive through the clear yard track to the ' + setup.railyard.getTrackLabel(tracks, this.EXIT_TRACK) + ', on the other side of the flatcar.' };
			}
			if (flatcarTrack === this.SETOUT_TRACK && Number(variables.drivingTrackIndex) === this.EXIT_TRACK) {
				return { id: 'couple-rear', text: 'Back into the flatcar and couple it to the rear of the locomotive.' };
			}
			return {
				id: 'shunt',
				text: 'Good work! Next, we want to attach the flatcar to the rear of the consist. Navigate '
					+ 'to the other track. Then, you can back into the track where the flatcar is to couple to the rear.'
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
