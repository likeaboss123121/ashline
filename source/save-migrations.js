// Schema versions describe stored data, independently of the public release number.
// All upgrades run on a detached copy; failed upgrades never modify a slot/file or
// replace the live run. Add the next numbered step instead of rewriting old steps.
setup.saveMigrations = {
	CURRENT: 2,
	notice: '',
	recovery: null,
	copy: function(value) { return JSON.parse(JSON.stringify(value)); },
	object: function(value) { return value && typeof value === 'object' && !Array.isArray(value); },
	checkVersion: function(version) {
		if (version === undefined) return 0;
		if (!Number.isInteger(version) || version < 0) throw new Error('Invalid save schema version.');
		if (version > this.CURRENT) throw new Error('This save needs a newer version of Ashline. Keep it and update the game.');
		return version;
	},
	upgradeState: function(source, envelopeVersion) {
		this.checkVersion(envelopeVersion);
		if (!this.object(source) || !Array.isArray(source.history) || !source.history.length
			|| !Number.isInteger(source.index) || source.index < 0 || source.index >= source.history.length)
			throw new Error('Invalid save history.');
		var self = this, state = this.copy(source), upgraded = false;
		state.history.forEach(function(moment) {
			if (!self.object(moment) || !self.object(moment.variables)) throw new Error('Invalid save history.');
			var v = moment.variables, version = self.checkVersion(v.saveSchemaVersion);
			if (envelopeVersion !== undefined && version !== envelopeVersion)
				throw new Error('The save schema markers disagree.');
			// StoryInit used to be an ordinary introduction. It must never run the new-game initializer on load.
			if (moment.title === 'StoryInit') moment.title = 'Introduction';
			while (version < self.CURRENT) {
				self.steps[version](moment);
				v.saveSchemaVersion = ++version;
				upgraded = true;
			}
		});
		setup.saves.validateState(state);
		if (upgraded) {
			// Persist acknowledgement in history too, otherwise refreshing a converted
			// session restores the old checksum and wrongly asks for a new game.
			var checksum = setup.getBuildChecksum();
			state.history.forEach(function(moment) {
				moment.variables.lastPlayedBuildChecksum = checksum;
				moment.variables.lastPlayedReleaseVersion = setup.releaseVersion;
				moment.variables.pendingBuildNotice = '';
			});
		}
		return { state: state, upgraded: upgraded };
	},
	// Schema 0 includes the public 0.1.0 release and unversioned 0.2.0 development saves.
	upgradeUnversioned: function(moment) {
		var v = moment.variables, self = this;
		if (!this.object(v.player) || !this.object(v.stationTracks)) throw new Error('The save is incomplete.');
		var p = v.player;
		var legacy = Object.prototype.hasOwnProperty.call(p, 'physicalDamage')
			|| Object.prototype.hasOwnProperty.call(p, 'mentalHealth');
		if (v.lastPlayedReleaseVersion && !/^0\.[12]\.0$/.test(v.lastPlayedReleaseVersion))
			throw new Error('This unversioned save is from an unsupported release.');
		if (legacy) {
			function stat(key) {
				if (typeof p[key] !== 'number' || !isFinite(p[key])) throw new Error('Invalid legacy player data.');
				return Math.max(0, Math.min(100, p[key]));
			}
			p.health = 100 - stat('physicalDamage');
			p.sanity = stat('mentalHealth');
			p.hunger = 100 - stat('hunger'); p.thirst = 100 - stat('thirst');
			delete p.physicalDamage; delete p.mentalHealth;
			if (['Railyard', 'TrainInterior', 'DrivingMode'].indexOf(moment.title) >= 0) {
				if (!v.stationTracks[v.currentStation]) v.stationTracks[v.currentStation] = setup.saveLegacy010.station(v);
				v.tutorialDone = true; // the old three-track yard is not the new shunting tutorial
			}
		}
		var defaults = { use24HourTime: false, dateFormat: 'long', imperialUnits: false, showYardTargets: false,
			autosaveOnSleep: true, preserveScroll: true, enableHistoryControls: false, travellingForward: true,
			gameTimeTimestampMs: setup.time.startTimestampMs, debugSelectedTrackIndex: 0,
			debugSelectedTrainIndex: 0, debugSelectedCarIndex: -1 };
		Object.keys(defaults).forEach(function(key) { if (v[key] === undefined) v[key] = defaults[key]; });
		if (p.carried === undefined) p.carried = [];
		if (p.carriedCargo === undefined) p.carriedCargo = [];
		if (p.carry === undefined) p.carry = {};
		delete v.settingsMode;
		if (v.settingsExitPassage === 'StoryInit') v.settingsExitPassage = 'Introduction';
		v.trains = []; delete v.currentCar;
		// A parked currentTrain is an obsolete alias, not another owned train.
		if (moment.title === 'Railyard') v.currentTrain = null;
		var kitCandidates = [];
		function upgradeTrain(train, visited, nearby) {
			if (train == null) return;
			if (!Array.isArray(train)) throw new Error('Invalid train data.');
			train.forEach(function(car) {
				if (!self.object(car)) throw new Error('Invalid train data.');
				if (visited) car.visited = true;
				if (!legacy) return;
				if (car.facing === undefined) car.facing = 1;
				if (car.type !== 'steam loco' && car.type !== 'diesel loco') return;
				var template = setup.currentDefinitions.defaultTrains[car.type === 'steam loco' ? 'steamShunter' : 'dieselShunter'];
				// Approved conversion: new shunter specs, preserving cargo and expanding
				// storage only as far as needed to retain an existing oversized load.
				Object.keys(template).forEach(function(key) { if (key !== 'cargo') car[key] = self.copy(template[key]); });
				delete car.fuelConsumption;
				var volume = 0, weight = 0;
				if (!Array.isArray(car.cargo)) throw new Error('Invalid locomotive cargo.');
				car.cargo.forEach(function(stack) {
					if (!self.object(stack) || typeof stack.amount !== 'number' || !isFinite(stack.amount) || stack.amount < 0)
						throw new Error('Invalid locomotive cargo.');
					volume += stack.amount;
					weight += stack.amount * (v.cargoTypes[stack.type] ? v.cargoTypes[stack.type].density : 1);
				});
				car.maxCargoCapacityVolume = Math.max(car.maxCargoCapacityVolume, volume);
				car.maxCargoCapacityKg = Math.max(car.maxCargoCapacityKg, weight);
				if (car.inventory === undefined) car.inventory = [];
				if (nearby && !car.broken && car.inventory.length === 0) kitCandidates.push(car);
			});
		}
		upgradeTrain(v.currentTrain, true, true);
		upgradeTrain(v.leavingTrain, true, true);
		Object.keys(v.stationTracks).forEach(function(station) {
			var tracks = v.stationTracks[station];
			if (!Array.isArray(tracks)) throw new Error('Invalid station data.');
			tracks.forEach(function(track) {
				if (!self.object(track) || !Array.isArray(track.trains)) throw new Error('Invalid station data.');
				track.trains.forEach(function(train) { upgradeTrain(train, !!train.visited, String(v.currentStation) === station); });
			});
		});
		// Old runs predate tools, food and sleep. Give one accessible engine the starter
		// kit once, without refilling fuel or altering any already-existing inventory.
		if (legacy && kitCandidates.length) kitCandidates[0].inventory = setup.items.createStartingKit();
		if (v.currentTrain && v.currentTrain.length && (!Number.isInteger(v.currentCarIndex)
			|| v.currentCarIndex < 0 || v.currentCarIndex >= v.currentTrain.length))
			v.currentCarIndex = setup.railyard.getBoardingCarIndex(v.currentTrain);
		v.defaultTrains = this.copy(setup.currentDefinitions.defaultTrains);
		v.cargoTypes = Object.assign({}, v.cargoTypes, this.copy(setup.currentDefinitions.cargoTypes));
	},
	// Schema 2 removes the seeded fictional world. Keep every train and yard, but translate any active position
	// onto the sourced Padre Hurtado–Melipilla grid so an old station or branch cannot strand the player.
	upgradeSourcedWorld: function(moment) {
		var v = moment.variables;
		var route = setup.realWorldPilot && setup.realWorldPilot.getGridRoute
			? setup.realWorldPilot.getGridRoute() : null;
		if (!route || !route.legs || !route.corridor || !route.corridor.stations.length)
			throw new Error('The sourced world is unavailable.');
		function targetAt(position) {
			var globalIndex = Math.max(0, Math.min(Math.floor(Number(position) || 0), route.tiles.length - 1));
			var legIndex = 1;
			while (route.legs[legIndex] && globalIndex > route.legs[legIndex].endPosition) legIndex++;
			if (!route.legs[legIndex]) legIndex = route.corridor.stations.length - 1;
			var leg = route.legs[legIndex];
			return { legIndex: legIndex,
				tileIndex: Math.max(0, Math.min(globalIndex - leg.startPosition, leg.tiles.length - 1)), forward: true };
		}
		var journey = v.journey;
		if (v.realWorldJourney) {
			journey = targetAt(v.realWorldJourney.position);
		} else if (journey && journey.realWorldCorridorId) {
			journey = targetAt(journey.tileIndex);
		} else if (journey && Number.isInteger(journey.legIndex) && route.legs[journey.legIndex]) {
			var leg = route.legs[journey.legIndex];
			journey = { legIndex: journey.legIndex,
				tileIndex: Math.max(0, Math.min(Math.floor(Number(journey.tileIndex) || 0), leg.tiles.length - 1)),
				forward: journey.forward !== false };
		} else if (journey) {
			journey = null;
			v.currentStation = 1;
		}
		v.journey = journey || null;
		v.realWorldJourney = null;
		if (!Number.isInteger(v.currentStation) || v.currentStation < 1
			|| v.currentStation > route.corridor.stations.length)
			v.currentStation = 1;
		if (v.onFoot) {
			if (!v.journey) v.onFoot = null;
			else v.onFoot = { legIndex: v.journey.legIndex,
				tileIndex: Math.max(0, Math.min(Math.floor(Number(v.onFoot.tileIndex) || 0),
					route.legs[v.journey.legIndex].tiles.length - 1)), branch: null };
		}
		if (moment.title === 'WorldPilot') moment.title = v.journey ? 'OnTheLine' : 'TrainInterior';
		if ((moment.title === 'OnTheLine' || moment.title === 'OnFoot') && !v.journey)
			moment.title = Array.isArray(v.currentTrain) && v.currentTrain.length ? 'TrainInterior' : 'Railyard';
	},
	steps: {},
	afterUpgrade: function(upgraded) {
		this.recovery = null;
		setup.buildCheckDone = false;
		if (setup.worldmap) setup.worldmap.clearCache();
		if (setup.bugReport) setup.bugReport.recent = [];
		this.notice = upgraded ? 'Save upgraded to v' + setup.releaseVersion
			+ '. Your original save has not been overwritten. Export a new backup from Saves.' : '';
	},
	// Browser-tab restoration bypasses Save.onLoad. Upgrade it before Engine.show(),
	// including every history moment, then persist the converted session snapshot.
	restoreSession: function() {
		if (!State.history.length || State.history.every(function(moment) {
			return moment.variables && moment.variables.saveSchemaVersion === setup.saveMigrations.CURRENT;
		})) return;
		var original = State.marshalForSave();
		var result;
		try {
			result = this.upgradeState(original);
		} catch (error) {
			// Preserve the original session for download, and don't render incompatible gameplay.
			this.recovery = { state: original, error: error.message };
			this.notice = '';
			State.active.title = 'SaveRecovery';
			return;
		}
		State.history.splice.apply(State.history, [0, State.history.length].concat(result.state.history));
		var active = this.copy(result.state.history[result.state.index]);
		State.active.title = active.title; State.active.variables = active.variables;
		this.afterUpgrade(result.upgraded);
		setup.applyHistorySetting();
		// SugarCube exposes marshalForSave(), not its internal session marshaler.
		var snapshot = State.marshalForSave();
		snapshot.delta = State.deltaEncode(snapshot.history); delete snapshot.history;
		try {
			if (!session.set('state', snapshot)) throw new Error('Session storage unavailable.');
		} catch (error) {
			this.notice += ' Browser session storage is unavailable; export a backup before closing this tab.';
		}
	}
};
setup.saveMigrations.steps[0] = function(moment) { setup.saveMigrations.upgradeUnversioned(moment); };
setup.saveMigrations.steps[1] = function(moment) { setup.saveMigrations.upgradeSourcedWorld(moment); };
if (typeof Config !== 'undefined') {
	Config.saves.version = setup.saveMigrations.CURRENT;
	Config.saves.isAllowed = function() { return State.passage !== 'SaveRecovery'; };
}
Save.onLoad.add(function(save) {
	var result = setup.saveMigrations.upgradeState(save.state, save.version);
	save.state = result.state;
	save.version = setup.saveMigrations.CURRENT;
	setup.saveMigrations.afterUpgrade(result.upgraded);
});
jQuery(document).on(':historyupdate.ashline-migrations', function() { setup.saveMigrations.restoreSession(); });
Macro.add('saveMigrationRecovery', {
	handler: function() {
		var recovery = setup.saveMigrations.recovery;
		if (!recovery) return;
		var text = document.createElement('p'); text.textContent = 'This browser session could not be upgraded. ' + recovery.error;
		this.output.appendChild(text);
		var button = document.createElement('button'); button.textContent = 'Download original session';
		button.addEventListener('click', function() {
			var state = setup.saveMigrations.copy(recovery.state);
			state.delta = State.deltaEncode(state.history); delete state.history;
			var file = new Blob([JSON.stringify({ id: Config.saves.id, state: state })], { type: 'application/json' });
			var url = URL.createObjectURL(file), link = document.createElement('a');
			link.href = url; link.download = 'ashline-session-recovery.json'; link.click();
			setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		});
		this.output.appendChild(button);
	}
});
