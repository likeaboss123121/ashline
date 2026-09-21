// Renders the start/settings screen and seeds a random seed value if the player has not chosen one yet.
Macro.add('settingsStart', {
	handler: function() {
		if (!State.variables.randomSeed) {
			State.variables.randomSeed = String(Math.floor(Math.random() * 10000000000) + 1);
		}
		// The seed and the debug tools are for people who came looking for them, so they stay folded away.
		new Wikifier(this.output, `
			<h3>Game Settings</h3>
			<details class="advanced-settings">
				<summary>Advanced</summary>
				<label>Random Seed: <<textbox "$randomSeed" $randomSeed>></label><br><br>
				<label><<checkbox "$debugMode" false true autocheck>> Enable Debug Tools</label>
			</details>
			<br>
			[[Continue|${State.variables.settingsExitPassage}]]
		`.replace(/\r?\n\s*/g, ''));
	}
});
// Small shared helpers used throughout initialization and shunting logic.
setup.initializeStateVar = function(name, defaultValue) {
	if (typeof State.variables[name] === 'undefined') {
		State.variables[name] = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
	}
};
// Safely parses user-provided values and falls back to a known numeric default when parsing fails.
setup.safeParseInt = function(value, fallback) {
	var parsed = parseInt(value, 10);
	return isNaN(parsed) ? (typeof fallback === 'number' ? fallback : 0) : parsed;
};
// Passage back/forward controls duplicate actions in a stateful simulation, so they stay off unless the player
// deliberately asks for them. SugarCube reads this configuration live when it renders the UI.
setup.applyHistorySetting = function(updateHistory) {
	if (typeof Config === 'undefined' || !Config.history) {
		return;
	}
	var enabled = !!State.variables.enableHistoryControls;
	// Going back must not undo the preference and strand the player without Forward.
	if (updateHistory && State.history) State.history.forEach(function(moment) {
		moment.variables.enableHistoryControls = enabled;
	});
	// SugarCube rejects visible history controls while the limit is still one.
	Config.history.controls = false;
	Config.history.maxStates = enabled ? 100 : 1;
	Config.history.controls = enabled;
	if (setup.refreshHistoryControls) setup.refreshHistoryControls();
};
setup.applyHistorySetting();
// Centralized time utilities for clock state, formatting, and reusable time-cost UI labels.
setup.time = {
	startTimestampMs: Date.UTC(2000, 6, 24, 9, 0, 0, 0),
	monthNames: [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	],
	getCurrentTimestampMs: function() {
		if (typeof State.variables.gameTimeTimestampMs !== 'number' || !isFinite(State.variables.gameTimeTimestampMs)) {
			State.variables.gameTimeTimestampMs = this.startTimestampMs;
		}
		return State.variables.gameTimeTimestampMs;
	},
	setCurrentTimestampMs: function(timestampMs) {
		if (typeof timestampMs !== 'number' || !isFinite(timestampMs)) {
			return;
		}
		State.variables.gameTimeTimestampMs = Math.floor(timestampMs);
	},
	resolveMinutes: function(value) {
		var minutes = setup.safeParseInt(value, 0);
		return Math.max(0, minutes);
	},
	incrementMinutes: function(minutes) {
		var delta = this.resolveMinutes(minutes);
		if (!delta) {
			return;
		}
		this.setCurrentTimestampMs(this.getCurrentTimestampMs() + (delta * 60000));
	},
	getTrackedTrains: function() {
		var tracked = [];
		var addTrain = function(train) {
			if (!Array.isArray(train)) {
				return;
			}
			if (tracked.indexOf(train) === -1) {
				tracked.push(train);
			}
		};
		var stationTracksByStation = State.variables.stationTracks || {};
		for (var stationKey in stationTracksByStation) {
			if (!Object.prototype.hasOwnProperty.call(stationTracksByStation, stationKey)) {
				continue;
			}
			var stationTracks = stationTracksByStation[stationKey];
			if (!Array.isArray(stationTracks)) {
				continue;
			}
			for (var ti = 0; ti < stationTracks.length; ti++) {
				var track = stationTracks[ti];
				if (!track || !Array.isArray(track.trains)) {
					continue;
				}
				for (var tr = 0; tr < track.trains.length; tr++) {
					addTrain(track.trains[tr]);
				}
			}
		}
		// SugarCube clones aliases separately; $trains may contain stale copies.
		addTrain(State.variables.currentTrain);
		return tracked;
	},
	processSteamFireboxesMinute: function() {
		var trains = this.getTrackedTrains();
		for (var i = 0; i < trains.length; i++) {
			var train = trains[i];
			for (var ci = 0; ci < train.length; ci++) {
				setup.railyard.processSteamFireboxMinuteForCar(train[ci]);
			}
		}
	},
	// How much harder than idling a minute of this kind of work is. Everything else is just time passing, which the
	// player is never told about: the clock is the only notice they need.
	MODE_FATIGUE_EXTRA: { shunting: 0.1, manual: 0.1 },
	// Sleep and collapse run the clock the same way, but the body is resting rather than wearing out, and the
	// player cannot collapse from exhaustion while already unconscious.
	advanceMinutesAsleep: function(minutes) {
		var delta = this.resolveMinutes(minutes);
		for (var m = 0; m < delta; m++) {
			this.processSteamFireboxesMinute();
			setup.condition.tickMinute('sleep');
			this.setCurrentTimestampMs(this.getCurrentTimestampMs() + 60000);
		}
		return true;
	},
	advanceMinutesWithSystems: function(minutes, actionType) {
		var delta = this.resolveMinutes(minutes);
		var mode = typeof actionType === 'string' ? actionType : 'generic';
		State.variables.timedActionFailure = '';
		// Moves have no intermediate position: check the full cost on a copy first.
		if (mode === 'shunting' || mode === 'travel') {
			var simulation = JSON.parse(JSON.stringify(State.variables.currentTrain || []));
			for (var step = 0; step < delta; step++) {
				for (var ci = 0; ci < simulation.length; ci++) {
					setup.railyard.processSteamFireboxMinuteForCar(simulation[ci]);
				}
				if (!setup.railyard.consumeShuntingResourcesForMinute(simulation)) {
					State.variables.timedActionFailure = 'Not enough fuel or steam to complete this action. No time or fuel was spent.';
					return false;
				}
			}
		}
		for (var m = 0; m < delta; m++) {
			this.processSteamFireboxesMinute();
			if (mode === 'shunting' || mode === 'travel') {
				setup.railyard.consumeShuntingResourcesForMinute(State.variables.currentTrain);
			}
			setup.condition.tickMinute(mode);
			this.setCurrentTimestampMs(this.getCurrentTimestampMs() + 60000);
		}
		// A player who works themselves past the end of the bar drops where they stand, and wakes hours later.
		if (setup.condition.isCollapsed()) {
			setup.condition.collapse();
		}
		return true;
	},
	formatDuration: function(minutes) {
		var totalMinutes = this.resolveMinutes(minutes);
		var hours = Math.floor(totalMinutes / 60);
		var remainder = totalMinutes % 60;
		return hours + ':' + String(remainder).padStart(2, '0');
	},
	// How the date reads. The clock itself is always the same; only the writing of it changes.
	DATE_FORMATS: [
		['long', 'Month dd, yyyy'],
		['dmy', 'dd/mm/yyyy'],
		['mdy', 'mm/dd/yyyy'],
		['ymd', 'yyyy/mm/dd']
	],
	formatDate: function(parts) {
		var pad = function(value) { return String(value).padStart(2, '0'); };
		var monthNumber = pad(this.monthNames.indexOf(parts.month) + 1);
		switch (State.variables.dateFormat) {
			case 'dmy': return pad(parts.day) + '/' + monthNumber + '/' + parts.year;
			case 'mdy': return monthNumber + '/' + pad(parts.day) + '/' + parts.year;
			case 'ymd': return parts.year + '/' + monthNumber + '/' + pad(parts.day);
			default: return parts.month + ' ' + parts.day + ', ' + parts.year;
		}
	},
	formatClock: function(parts) {
		return parts.hours + ':' + parts.minutes + (parts.meridiem ? ' ' + parts.meridiem : '');
	},
	getCurrentDateParts: function() {
		var current = new Date(this.getCurrentTimestampMs());
		var rawHour = current.getUTCHours();
		var use24Hour = !!State.variables.use24HourTime;
		var displayHour = use24Hour ? rawHour : ((rawHour % 12) || 12);
		return {
			day: current.getUTCDate(),
			month: this.monthNames[current.getUTCMonth()],
			year: current.getUTCFullYear(),
			hours: String(displayHour),
			minutes: String(current.getUTCMinutes()).padStart(2, '0'),
			meridiem: use24Hour ? '' : (rawHour >= 12 ? 'PM' : 'AM')
		};
	},
	// A link says what it costs on the clock. The stats it moves are written beside it by the macro below, so they
	// can carry their own colours. Plain time passing is left unmarked.
	formatLinkLabel: function(baseLabel, minutes) {
		return String(baseLabel) + ' (' + this.formatDuration(minutes) + ')';
	}
};
// Container macro for clickable actions with a visible time cost and automatic clock increment.
// Example: <<timedlink "Board Train 1" 1>>...actions...<</timedlink>>
// Example: <<timedlink "Reverse Consist" Math.ceil($currentTrain.length / 2)>>...<</timedlink>>
Macro.add('timedlink', {
	tags: null,
	handler: function() {
		if (this.args.length < 2) {
			return this.error('timedlink requires a label and a minute cost.');
		}
		if (!this.payload || !this.payload.length) {
			return this.error('timedlink must wrap link content.');
		}
		var label = String(this.args[0]);
		var minutes = setup.time.resolveMinutes(this.args[1]);
		var actionType = this.args.length > 2 ? String(this.args[2]) : 'generic';
		// The fourth argument declares which stats this action moves, so every link that costs something says so
		// without each call site writing its own wording. See setup.effects.
		var effects = this.args.length > 3 ? String(this.args[3]) : '';
		var renderedLabel = setup.time.formatLinkLabel(label, minutes)
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"');
		var safeActionType = actionType
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"');
		new Wikifier(
			this.output,
			'<<link "' + renderedLabel + '">><<set _timedActionAllowed = setup.time.advanceMinutesWithSystems(' + minutes + ', "' + safeActionType + '")>><<if _timedActionAllowed>>' + this.payload[0].contents + '<<else>><<run Dialog.setup("Action unavailable")>><<run Dialog.wiki(State.variables.timedActionFailure)>><<run Dialog.open()>><</if>><</link>>' + setup.effects.describeHtml(effects)
		);
	}
});
// Normalizes persistent settings variables so every new session starts from a known state.
Macro.add('initsettings', {
	handler: function() {
		setup.initializeStateVar('randomSeed', '');
		setup.initializeStateVar('gameTimeTimestampMs', function() { return setup.time.startTimestampMs; });
		setup.initializeStateVar('use24HourTime', false);
		setup.initializeStateVar('dateFormat', 'long');
		setup.initializeStateVar('imperialUnits', false);
		setup.initializeStateVar('showYardTargets', false);
		setup.initializeStateVar('autosaveOnSleep', true);
		setup.initializeStateVar('preserveScroll', true);
		setup.initializeStateVar('enableHistoryControls', false);
		setup.initializeStateVar('debugMode', false);
		setup.initializeStateVar('debugSelectedTrackIndex', 0);
		setup.initializeStateVar('debugSelectedTrainIndex', 0);
		setup.initializeStateVar('debugSelectedCarIndex', -1);
		setup.applyHistorySetting();
	}
});
// The title screen always begins a fresh run.  Settings stay available there, but no visited yards, journey
// position, tutorial state, or carried train can leak out of the browser's cached story state into the next game.
setup.startNewRun = function() {
	var v = State.variables;
	// Preferences and static catalogues survive a new run; everything else belongs to that run.
	var keep = ['settingsExitPassage', 'randomSeed', 'use24HourTime', 'dateFormat',
		'imperialUnits', 'showYardTargets', 'autosaveOnSleep', 'preserveScroll', 'enableHistoryControls', 'debugMode',
		'defaultTrains', 'cargoTypes'];
	Object.keys(v).forEach(function(key) { if (keep.indexOf(key) === -1) delete v[key]; });
	Object.assign(v, { player: { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 },
		saveSchemaVersion: setup.saveMigrations ? setup.saveMigrations.CURRENT : 1,
		trains: [], currentStation: 1, stationTracks: {}, travellingForward: true,
		gameTimeTimestampMs: setup.time.startTimestampMs, debugSelectedTrackIndex: 0,
		debugSelectedTrainIndex: 0, debugSelectedCarIndex: -1 });
	if (setup.worldmap) setup.worldmap.clearCache();
	if (setup.railyardView) setup.railyardView.zoomLevel = 'fit';
	if (setup.bugReport) setup.bugReport.recent = [];
	if (setup.saveMigrations) { setup.saveMigrations.notice = ''; setup.saveMigrations.recovery = null; }
	setup.debugReturnToPanel = false;
	setup.debugTeleportNotice = '';
};
Macro.add('startNewGame', { handler: function() { setup.startNewRun(); } });
// Release metadata is used both for the title screen and build-integrity popup.
setup.releaseVersion = '0.3.0';
setup.buildCheckDone = false;
setup.enableBuildChangeAlert = true;
setup.buildCacheStorageKey = 'ashline.buildMeta';
setup.currentBuildChecksum = '';
setup.cachedBuildChecksum = '';
// Build checksums warn players when a save is being opened against a newer story build.
// Uses a lightweight FNV-style hash to fingerprint the current story source.
setup.hashString = function(str) {
	var h = 2166136261;
	for (var i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
};
// Reads the current `tw-storydata` payload and hashes it so saves can detect source changes.
setup.getBuildChecksum = function() {
	var storyData = document.querySelector('tw-storydata');
	if (!storyData) {
		return 'unavailable';
	}
	var source = storyData.outerHTML || storyData.innerHTML || '';
	return this.hashString(source);
};
// Reads cached build metadata from local storage if it exists and is structurally valid.
setup.readCachedBuildMeta = function() {
	try {
		var raw = localStorage.getItem(this.buildCacheStorageKey);
		if (!raw) {
			return null;
		}
		var parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.checksum !== 'string') {
			return null;
		}
		return parsed;
	} catch (e) {
		return null;
	}
};
// Persists build metadata locally so future sessions can compare old and current builds.
setup.writeCachedBuildMeta = function(meta) {
	try {
		localStorage.setItem(this.buildCacheStorageKey, JSON.stringify(meta));
	} catch (e) {
		// Ignore cache write failures (private mode/storage restrictions).
	}
};
// Performs a one-time per-session build mismatch check and stores both warning and last-known build values.
setup.runBuildIntegrityCheck = function() {
	if (this.buildCheckDone) {
		return State.variables.pendingBuildNotice || '';
	}
	this.buildCheckDone = true;
	var currentChecksum = this.getBuildChecksum();
	var currentVersion = this.releaseVersion;
	var cachedMeta = this.readCachedBuildMeta();
	this.currentBuildChecksum = currentChecksum;
	this.cachedBuildChecksum = cachedMeta && cachedMeta.checksum ? cachedMeta.checksum : '';
	if (typeof console !== 'undefined' && typeof console.log === 'function') {
		console.log('[Ashline Build Check] Cached checksum:', this.cachedBuildChecksum || '(none)');
		console.log('[Ashline Build Check] Detected checksum:', this.currentBuildChecksum || '(unavailable)');
	}
	var previousChecksum = State.variables.lastPlayedBuildChecksum;
	var previousVersion = State.variables.lastPlayedReleaseVersion;
	if (typeof previousChecksum !== 'string' && cachedMeta && typeof cachedMeta.checksum === 'string') {
		previousChecksum = cachedMeta.checksum;
		previousVersion = cachedMeta.version || previousVersion;
	}
	var notice = '';
	if (typeof previousChecksum === 'string' && previousChecksum !== currentChecksum
		&& !(setup.saveMigrations && (setup.saveMigrations.notice || setup.saveMigrations.recovery))) {
		var currentShort = currentChecksum.slice(0, 8);
		var previousShort = previousChecksum.slice(0, 8);
		notice = 'There have been changes made to the source file since you last played. Current version ' + currentVersion + ', version last played ' + (previousVersion || 'unknown') + '. Build checksums: ' + currentShort + ' (current) vs ' + previousShort + ' (last played). Unexpected behaviour may occur. If possible, create a new save file.';
		if (this.enableBuildChangeAlert && typeof window !== 'undefined' && typeof window.alert === 'function') {
			window.alert(notice);
		}
	}
	State.variables.pendingBuildNotice = notice;
	State.variables.lastPlayedBuildChecksum = currentChecksum;
	State.variables.lastPlayedReleaseVersion = currentVersion;
	this.writeCachedBuildMeta({ checksum: currentChecksum, version: currentVersion, checkedAt: Date.now() });
	return notice;
};
// Runs the build check once the story is ready so warning state is available before gameplay passages.
jQuery(document).one(':storyready', function () {
	setup.runBuildIntegrityCheck();
});
// Save loading, schema upgrades and build-check reset live in save-migrations.js.
// Forces the build-integrity check to run when a passage asks for it, but leaves the warning popup-only.
Macro.add('buildIntegrityNotice', {
	handler: function() {
		var notice = setup.runBuildIntegrityCheck();
		// The text is intentionally consumed here so passages do not render duplicate inline warnings.
		if (notice) {
			// Notice is intentionally popup-only; do not render inline on passages.
			State.variables.pendingBuildNotice = '';
		}
	}
});
// Opens an external-links credits dialog from the story menu.
setup.showCreditsDialog = function() {
	if (typeof Dialog === 'undefined') {
		return;
	}
	Dialog.setup('Credits');
	// Insert this static HTML directly.  Passing labels such as "World data:" through
	// the Wikifier makes its URL parser mistake "data:" for the start of a link and
	// display the remainder of the HTML tags as text.
	Dialog.body().insertAdjacentHTML('beforeend', '<p><strong>Created by:</strong> likea</p><p><a href="http://likeaserver.myddns.me/" target="_blank" rel="noopener noreferrer">Official Website</a></p><p><a href="https://github.com/likeaboss123121" target="_blank" rel="noopener noreferrer">GitHub</a></p>'
		+ '<p><strong>World data:</strong> City names, coordinates and population from <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>, licensed under CC BY 4.0. Railway geometry © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>, provided by <a href="https://download.geofabrik.de/" target="_blank" rel="noopener noreferrer">Geofabrik</a> under ODbL 1.0.</p>'
		+ '<p><strong>Elevation data:</strong> Produced using Copernicus WorldDEM-90 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</p>'
		+ '<p><strong>AI Generated Content Disclosure:</strong></p>'
		+ '<p>AI was used to make code and .svg art for this game. Diffusion (what people commonly refer to as AI Image Generation) was not used for this game. '
		+ 'Read more about how AI was used and my opinions about AI in video games at '
		+ '<a href="https://likeaserver.myddns.me/ashlinegame/about/#ai-generation-disclosure" target="_blank" rel="noopener noreferrer">'
		+ 'Ashline\'s Page on my Website</a>.</p>');
	Dialog.open();
};
// Opens gameplay options currently focused on time-display preferences.
setup.showOptionsDialog = function() {
	setup.initializeStateVar('preserveScroll', true);
	if (typeof Dialog === 'undefined') {
		return;
	}
	Dialog.setup('Options');
	var formats = setup.time.DATE_FORMATS.map(function(format) {
		return '<label><<radiobutton "$dateFormat" "' + format[0] + '" autocheck>> ' + format[1] + '</label>';
	}).join('<br>');
	Dialog.wiki('<p><strong>Time and date</strong></p>'
		+ '<label><<checkbox "$use24HourTime" false true autocheck>> Use 24-hour time</label><br>'
		+ formats
		+ '<p><strong>Units</strong></p>'
		+ '<label><<checkbox "$imperialUnits" false true autocheck>> Show distances, weights and temperatures in imperial</label>'
		+ '<p><strong>The rail yard</strong></p>'
		+ '<label><<checkbox "$showYardTargets" false true autocheck>> Show clickable areas on railyard</label>'
		+ '<p><label><<checkbox "$preserveScroll" false true autocheck>> Keep page and map position for actions on the same page</label></p>'
		+ '<p><strong>Saving</strong></p>'
		+ '<label><<checkbox "$autosaveOnSleep" false true autocheck>> Autosave when you sleep</label><br>'
		+ '<label><<checkbox "$enableHistoryControls" false true autocheck>> Enable passage back and forward controls</label>');
	jQuery('#ui-dialog-body input').on('change', function() { setup.applyHistorySetting(true); UIBar.update(); });
	Dialog.open();
};
// Default rolling-stock definitions.
State.variables.defaultTrains = {
	// Locomotives: type says how a locomotive works (steam or diesel), model says which one it is. Each model sets
	// its own size, pull, speed and appetite; the art is drawn per model (see scripts/draw-*-templates.py).
	dieselShunter: {
		type: 'diesel loco',
		model: 'diesel-shunter',
		name: 'two axle diesel shunter',
		hasInterior: true,
		cargo: [],
		baseWeight: 32000, // kg
		maxCargoCapacityKg: 1300,
		maxCargoCapacityVolume: 1500, // liters: the fuel tank
		acceptedCargo: ['liquid fuel'],
		tractiveCapacity: 100, // kN
		topSpeedKmh: 40,
		dieselLitresPerMinute: 1,
		length: 9 // meters
	},
	dieselRoad: {
		type: 'diesel loco',
		model: 'diesel-road',
		name: 'six axle road diesel',
		hasInterior: true,
		cargo: [],
		baseWeight: 120000,
		maxCargoCapacityKg: 5200,
		maxCargoCapacityVolume: 6000,
		acceptedCargo: ['liquid fuel'],
		tractiveCapacity: 320,
		topSpeedKmh: 100,
		dieselLitresPerMinute: 10, // a big engine working hard drinks about ten litres a minute
		length: 20
	},
	steamShunter: {
		type: 'steam loco',
		model: 'steam-shunter',
		name: '0-6-0 steam shunter',
		hasInterior: true,
		cargo: [],
		fireboxEnabled: false,
		steamStoredLiters: 0,
		boilerSteamVolumeLiters: 5000, // liters at 1 bar equivalent: about 45 minutes from cold to working pressure
		maxSteamPressureBar: 14.5,
		fireboxScale: 1, // how much fuel and water the firebox takes, and steam it makes, per minute
		steamUseScale: 0.8, // how much steam moving the locomotive costs: a light engine is easy on its boiler
		baseWeight: 45000,
		maxCargoCapacityKg: 7000,
		maxCargoCapacityVolume: 7000, // side tanks and bunker
		acceptedCargo: ['solid fuel', 'water'],
		tractiveCapacity: 120,
		topSpeedKmh: 40,
		length: 10
	},
	steamPrairie: {
		type: 'steam loco',
		model: 'steam-prairie',
		name: '2-6-2 steam engine',
		hasInterior: true,
		cargo: [],
		fireboxEnabled: false,
		steamStoredLiters: 0,
		boilerSteamVolumeLiters: 50000, // a big boiler: about three hours from cold to working pressure
		maxSteamPressureBar: 14.5,
		fireboxScale: 2.5,
		steamUseScale: 2.2,
		baseWeight: 95000,
		maxCargoCapacityKg: 22000,
		maxCargoCapacityVolume: 24000, // engine and tender
		acceptedCargo: ['solid fuel', 'water'],
		tractiveCapacity: 170,
		topSpeedKmh: 90,
		length: 23
	},
	boxcar: {
		type: 'boxcar',
		hasInterior: true,
		cargo: [],
		baseWeight: 20000, // kg
		maxCargoCapacityKg: 85000,
		maxCargoCapacityVolume: 50000, // liters
		acceptedCargo: ['rigid', 'aggregate'],
		fuelConsumption: [],
		tractiveCapacity: 0,
		length: 12
	},
	flatcar: {
		type: 'flatcar',
		hasInterior: false,
		cargo: [],
		baseWeight: 15000, // kg
		maxCargoCapacityKg: 85000,
		maxCargoCapacityVolume: 60000, // liters
		acceptedCargo: ['rigid'],
		fuelConsumption: [],
		tractiveCapacity: 0,
		length: 14
	},
	tanker: {
		type: 'tanker car',
		hasInterior: false,
		cargo: [],
		baseWeight: 22000, // kg
		maxCargoCapacityKg: 85000,
		maxCargoCapacityVolume: 55000, // liters
		acceptedCargo: ['liquid'],
		fuelConsumption: [],
		tractiveCapacity: 0,
		length: 14
	},
	gondola: {
		type: 'gondola',
		hasInterior: false,
		cargo: [],
		baseWeight: 18000, // kg
		maxCargoCapacityKg: 35000,
		maxCargoCapacityVolume: 45000, // liters
		acceptedCargo: ['aggregate', 'rigid'],
		fuelConsumption: [],
		tractiveCapacity: 0,
		length: 13
	},
	passengerCoach: {
		type: 'passenger coach', name: 'passenger coach', hasInterior: true, cargo: [],
		baseWeight: 48000, maxCargoCapacityKg: 5000, maxCargoCapacityVolume: 12000,
		acceptedCargo: ['rigid'], fuelConsumption: [], tractiveCapacity: 0, length: 24
	},
	sleeperCoach: {
		type: 'sleeper coach', name: 'sleeper passenger coach', hasInterior: true, cargo: [],
		baseWeight: 52000, maxCargoCapacityKg: 5000, maxCargoCapacityVolume: 12000,
		acceptedCargo: ['rigid'], fuelConsumption: [], tractiveCapacity: 0, length: 25
	},
	observationCar: {
		type: 'observation car', name: 'passenger observation car', hasInterior: true, cargo: [],
		baseWeight: 46000, maxCargoCapacityKg: 3500, maxCargoCapacityVolume: 8000,
		acceptedCargo: ['rigid'], fuelConsumption: [], tractiveCapacity: 0, length: 23
	},
	kitchenCar: {
		type: 'kitchen car', name: 'passenger kitchen car', hasInterior: true, cargo: [],
		baseWeight: 50000, maxCargoCapacityKg: 8000, maxCargoCapacityVolume: 14000,
		acceptedCargo: ['rigid', 'liquid'], fuelConsumption: [], tractiveCapacity: 0, length: 24
	},
	privateCar: {
		type: 'private car', name: 'private rail car', hasInterior: true, cargo: [],
		baseWeight: 44000, maxCargoCapacityKg: 4000, maxCargoCapacityVolume: 9000,
		acceptedCargo: ['rigid'], fuelConsumption: [], tractiveCapacity: 0, length: 22
	}
};
// Default cargo definitions.
// Tags: 'aggregate'=loose bulk, 'rigid'=discrete items, 'liquid'=fluids,
//        'solid fuel'/'liquid fuel'=loco-specific fuels
State.variables.cargoTypes = {
	coal:          { density: 0.8,  rarity: 'common',   tags: ['aggregate', 'solid fuel'] },
	water:         { density: 1.0,  rarity: 'common',   tags: ['liquid'] },
	timber:        { density: 0.6,  rarity: 'common',   tags: ['rigid'] },
	'scrap metal': { density: 2.0,  rarity: 'uncommon', tags: ['aggregate'] },
	machinery:     { density: 1.5,  rarity: 'uncommon', tags: ['rigid'] },
	food:          { density: 0.5,  rarity: 'rare',     tags: ['rigid'] },
	firewood:      { density: 0.4,  rarity: 'common',   tags: ['aggregate', 'solid fuel'] },
	diesel:        { density: 0.85, rarity: 'uncommon', tags: ['liquid', 'liquid fuel'] }
};
// Release-owned definitions must not come from whichever older save is being loaded.
setup.currentDefinitions = JSON.parse(JSON.stringify({ defaultTrains: State.variables.defaultTrains,
	cargoTypes: State.variables.cargoTypes }));
// Core railyard helpers power train generation, placement, shunting, and debug tooling.
setup.railyard = {
	locomotiveKeys: ['dieselShunter', 'dieselRoad', 'steamShunter', 'steamPrairie'],
	carKeys: ['boxcar', 'flatcar', 'tanker', 'gondola', 'passengerCoach', 'sleeperCoach', 'observationCar', 'kitchenCar', 'privateCar'],
	carWeights: { boxcar: 5, flatcar: 5, tanker: 5, gondola: 5, passengerCoach: 5,
		sleeperCoach: 5, observationCar: 5, kitchenCar: 5, privateCar: 1 },
	DERELICT_CHANCE: 0.2, // of stations with a dead car standing in the way of something
	cargoPresets: [
		// grade: the range a found load is drawn from. Years of storage mean most diesel is well past its best.
		// cars: which cars a preset is found in, where it is narrower than what the car accepts.
		{type: 'coal', amount: 6000, rarity: 'common', grade: [35, 100]},
		{type: 'water', amount: 8000, rarity: 'common', grade: [40, 90]},
		{type: 'diesel', amount: 6000, rarity: 'uncommon', grade: [30, 89]},
		{type: 'firewood', amount: 8000, rarity: 'common', grade: [45, 95], cars: ['gondola']},
		{type: 'timber', amount: 8000, rarity: 'common', grade: [50, 95], cars: ['flatcar']},
		{type: 'scrap metal', amount: 20, rarity: 'uncommon'},
		{type: 'machinery', amount: 10, rarity: 'uncommon'},
		{type: 'food', amount: 45, rarity: 'rare'}
	],
	// Deep-clones a car/template object so runtime edits do not mutate shared defaults.
	cloneCar: function(car) {
		return JSON.parse(JSON.stringify(car));
	},
	// Array custom properties are not preserved by JSON saves. Store discovery on cars.
	markTrainVisited: function(train) {
		for (var i = 0; i < train.length; i++) {
			train[i].visited = true;
		}
	},
	isTrainVisited: function(train) {
		return !!train.visited || train.some(function(car) { return !!car.visited; });
	},
	boardTrain: function(stationId, trackIndex, trainIndex) {
		var variables = State.variables;
		var train = variables.stationTracks[stationId][trackIndex].trains.splice(trainIndex, 1)[0];
		variables.enteredStation = stationId;
		variables.enteredTrackIndex = trackIndex;
		variables.drivingTrackIndex = trackIndex;
		variables.enteredTrainIndex = trainIndex;
		variables.currentTrain = train;
		variables.currentCarIndex = this.getBoardingCarIndex(train);
		this.markTrainVisited(train);
	},
	leaveCurrentTrain: function() {
		var variables = State.variables;
		this.markTrainVisited(variables.currentTrain);
		var placed = this.placeTrainInStationTracks(variables.stationTracks[variables.currentStation],
			variables.currentTrain, variables.drivingTrackIndex, variables.enteredTrainIndex);
		if (placed) {
			variables.currentTrain = null;
			variables.leavingTrain = null;
			variables.trains = [];
			delete variables.currentCar;
		}
		return placed;
	},
	// Clamps a track index into a safe in-range value for the current station layout.
	safeTrackIndex: function(index, maxIndex) {
		return Math.max(0, Math.min(setup.safeParseInt(index, 0), maxIndex));
	},
	// Returns true for boundary tracks (entry/exit), which have special shunting and travel rules.
	isBoundaryTrackIndex: function(stationTracks, index) {
		return index === this.getEntryTrackIndex() || index === this.getExitTrackIndex(stationTracks);
	},
	// Computes remaining free length on a track, treating infinite tracks as effectively unbounded.
	getTrackFreeLength: function(track) {
		if (!track) {
			return 0;
		}
		return track.infinite ? Number.MAX_SAFE_INTEGER : Math.max(0, track.length - this.getTrackOccupiedLength(track));
	},
	// Returns cargoType names accepted by this car.
	// `acceptedCargo` can include tag names (e.g. "liquid") and/or exact cargo names (e.g. "water").
	getAcceptedCargoTypes: function(car) {
		var result = [];
		var accepted = car.acceptedCargo || [];
		var types = State.variables.cargoTypes;
		var keys = Object.keys(types);
		for (var k = 0; k < keys.length; k++) {
			var name = keys[k];
			if (accepted.indexOf(name) !== -1) {
				result.push(name);
				continue;
			}
			var tags = types[name].tags;
			for (var t = 0; t < tags.length; t++) {
				if (accepted.indexOf(tags[t]) !== -1) {
					result.push(name);
					break;
				}
			}
		}
		return result;
	},
	// Returns cargo density in kg/L, defaulting to 1 for unknown types.
	getCargoDensityKgPerLiter: function(cargoType) {
		var cargoDef = State.variables.cargoTypes[cargoType];
		return cargoDef && typeof cargoDef.density === 'number' ? cargoDef.density : 1;
	},
	// Reads the current quantity of a cargo type on a car (in liters).
	getCargoAmount: function(car, cargoType) {
		if (!car || !Array.isArray(car.cargo)) {
			return 0;
		}
		var total = 0;
		for (var i = 0; i < car.cargo.length; i++) {
			if (car.cargo[i].type === cargoType) {
				total += Math.max(0, Number(car.cargo[i].amount) || 0);
			}
		}
		return total;
	},
	// Consumes a cargo volume from a car when enough is available.
	consumeCargoAmount: function(car, cargoType, amountLiters) {
		if (!car || !Array.isArray(car.cargo)) {
			return false;
		}
		var required = Math.max(0, Number(amountLiters) || 0);
		if (!required) {
			return true;
		}
		if (!isFinite(required) || this.getCargoAmount(car, cargoType) + 1e-9 < required) {
			return false;
		}
		for (var i = 0; i < car.cargo.length && required > 0; i++) {
			if (car.cargo[i].type === cargoType) {
				var available = Math.max(0, Number(car.cargo[i].amount) || 0);
				var consumed = Math.min(available, required);
				car.cargo[i].amount = available - consumed;
				required -= consumed;
			}
		}
		return true;
	},
	// Identifies steam locomotives by type.
	isSteamLocomotiveCar: function(car) {
		return !!car && car.type === 'steam loco';
	},
	// Identifies diesel locomotives by type.
	isDieselLocomotiveCar: function(car) {
		return !!car && car.type === 'diesel loco';
	},
	// What the locomotive being driven has left to burn, for the screens where the player is driving it.
	getFuelReadout: function(train) {
		var loco = this.getControllingLocomotive(train);
		if (!loco) {
			return '';
		}
		if (this.isDieselLocomotiveCar(loco)) {
			var litres = this.getCargoAmount(loco, 'diesel');
			var minutes = Math.floor(litres / setup.fuel.getDieselLitresPerMinute(loco));
			return '<p><strong>Fuel:</strong> ' + setup.units.litres(litres) + ' of diesel. '
				+ setup.fuel.describeGrade(setup.fuel.getGrade(loco, 'diesel'), 'diesel') + ' About '
				+ setup.time.formatDuration(minutes) + ' of running.</p>';
		}
		if (this.isSteamLocomotiveCar(loco)) {
			return '<p><strong>Boiler:</strong> ' + this.getSteamPressureBar(loco).toFixed(1) + ' bar. '
				+ setup.fuel.describeBunker(loco) + '. Water: ' + setup.units.litres(this.getCargoAmount(loco, 'water')) + '.</p>';
		}
		return '';
	},
	// What a locomotive is and what it can do, as rows for the cab's own panel.
	getLocomotiveStats: function(car) {
		var rows = [
			['Model', car.name || car.type],
			['Pull', setup.units.force(car.tractiveCapacity)],
			['Top speed', setup.units.kilometresPerHour(car.topSpeedKmh || setup.worldmap.REFERENCE_SPEED_KMH)],
			['Weight', setup.units.tonnes(Math.round(car.baseWeight / 100) / 10)],
			['Length', setup.units.metres(car.length)]
		];
		if (this.isDieselLocomotiveCar(car)) {
			rows.push(['Tank', setup.units.litres(this.getCargoAmount(car, 'diesel')) + ' of '
				+ setup.units.litres(car.maxCargoCapacityVolume)]);
		} else if (this.isSteamLocomotiveCar(car)) {
			rows.push(['Boiler', this.getSteamPressureBar(car).toFixed(1) + ' of '
				+ this.getSteamMaxPressureBar(car).toFixed(1) + ' bar']);
			rows.push(['Bunker and tanks', setup.units.litres(car.maxCargoCapacityVolume)]);
		}
		return rows;
	},
	// Which locomotive this is, for its art and its specs. Locomotives from before there were models are shunters.
	getLocomotiveModel: function(car) {
		if (car && car.model) {
			return car.model;
		}
		return this.isSteamLocomotiveCar(car) ? 'steam-shunter' : 'diesel-shunter';
	},
	// Ensures all steam-locomotive runtime state fields exist for both new and old saves.
	ensureSteamLocomotiveState: function(car) {
		if (!this.isSteamLocomotiveCar(car)) {
			return;
		}
		if (typeof car.fireboxEnabled !== 'boolean') {
			car.fireboxEnabled = false;
		}
		if (typeof car.steamStoredLiters !== 'number' || !isFinite(car.steamStoredLiters)) {
			car.steamStoredLiters = 0;
		}
		if (typeof car.boilerSteamVolumeLiters !== 'number' || !isFinite(car.boilerSteamVolumeLiters)
			|| car.boilerSteamVolumeLiters <= 0 || car.boilerSteamVolumeLiters === 3000 || car.boilerSteamVolumeLiters >= 100000) {
			// Boilers from before the warm-up rebalance were hundreds of times too large, which put a cold start two
			// days away. Take the size this model of locomotive is built with now.
			car.boilerSteamVolumeLiters = this.getModelDefault(car, 'boilerSteamVolumeLiters', 5000);
		}
		if (typeof car.maxSteamPressureBar !== 'number' || !isFinite(car.maxSteamPressureBar) || car.maxSteamPressureBar <= 0) {
			car.maxSteamPressureBar = 14.5;
		}
		// Public getters call this initializer, so use the normalized fields directly.
		var maxStored = car.boilerSteamVolumeLiters * car.maxSteamPressureBar;
		car.steamStoredLiters = Math.max(0, Math.min(car.steamStoredLiters, maxStored));
	},
	// A field from the definition of this locomotive's model, for normalising a car built by an older build.
	getModelDefault: function(car, field, fallback) {
		var defaults = State.variables.defaultTrains || {};
		var model = this.getLocomotiveModel(car);
		for (var key in defaults) {
			if (Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key].model === model
				&& typeof defaults[key][field] !== 'undefined') {
				return defaults[key][field];
			}
		}
		return fallback;
	},
	// Returns the max configured boiler pressure.
	getSteamMaxPressureBar: function(car) {
		this.ensureSteamLocomotiveState(car);
		return car.maxSteamPressureBar;
	},
	// Returns the effective boiler volume used for pressure/storage conversion.
	getSteamBoilerVolumeLiters: function(car) {
		this.ensureSteamLocomotiveState(car);
		return car.boilerSteamVolumeLiters;
	},
	// Returns max storable steam (in liters at 1 bar equivalent) at relief-valve pressure.
	getSteamMaxStoredLiters: function(car) {
		return this.getSteamBoilerVolumeLiters(car) * this.getSteamMaxPressureBar(car);
	},
	// Returns current stored steam quantity.
	getSteamStoredLiters: function(car) {
		this.ensureSteamLocomotiveState(car);
		return car.steamStoredLiters;
	},
	// Returns current boiler pressure in bar.
	getSteamPressureBar: function(car) {
		var volume = this.getSteamBoilerVolumeLiters(car);
		if (volume <= 0) {
			return 0;
		}
		return Math.max(0, Math.min(this.getSteamStoredLiters(car) / volume, this.getSteamMaxPressureBar(car)));
	},
	// Adds steam to the boiler, discarding overflow via safety valve behavior.
	addSteamLiters: function(car, amountLiters) {
		this.ensureSteamLocomotiveState(car);
		var delta = Math.max(0, Number(amountLiters) || 0);
		if (!delta) {
			return;
		}
		car.steamStoredLiters = Math.min(this.getSteamMaxStoredLiters(car), car.steamStoredLiters + delta);
	},
	// Consumes steam from the boiler when enough is available.
	consumeSteamLiters: function(car, amountLiters) {
		this.ensureSteamLocomotiveState(car);
		var required = Math.max(0, Number(amountLiters) || 0);
		if (!required) {
			return true;
		}
		if (car.steamStoredLiters + 1e-9 < required) {
			return false;
		}
		car.steamStoredLiters = Math.max(0, car.steamStoredLiters - required);
		return true;
	},
	// Sets steam firebox state for a specific locomotive.
	setSteamFireboxEnabled: function(car, enabled) {
		if (!this.isSteamLocomotiveCar(car)) {
			return;
		}
		this.ensureSteamLocomotiveState(car);
		if (enabled && !this.canLightFirebox(car)) return false;
		car.fireboxEnabled = !!enabled;
		return true;
	},
	canLightFirebox: function(car) {
		return this.isSteamLocomotiveCar(car) && !car.broken && !setup.fuel.planSolidFuelMinute(car).starved
			&& this.getCargoAmount(car, 'water') >= setup.fuel.WATER_LITRES_PER_MINUTE * setup.fuel.getFireboxScale(car);
	},
	// Toggles steam firebox state by index in the current consist.
	toggleSteamFireboxByIndex: function(train, index) {
		if (!Array.isArray(train) || typeof index !== 'number' || !train[index]) {
			return;
		}
		if (!this.isSteamLocomotiveCar(train[index])) {
			return;
		}
		this.ensureSteamLocomotiveState(train[index]);
		return this.setSteamFireboxEnabled(train[index], !train[index].fireboxEnabled);
	},
	// Steam production slows as pressure rises while the firebox still eats the same fuel, so the last few bar are
	// the slow ones: a shunter is at working pressure in about three quarters of an hour and full in about two.
	getSteamProductionLitersPerMinute: function(car) {
		var pressure = this.getSteamPressureBar(car);
		var maxPressure = this.getSteamMaxPressureBar(car);
		var pressureFactor = Math.max(0.08, 1 - ((pressure / maxPressure) * 0.92));
		return 1750 * pressureFactor * setup.fuel.getFireboxScale(car);
	},
	// Computes shunting steam use per minute from pressure with piecewise exponential anchors.
	getSteamShuntingCostPerMinute: function(car) {
		var pressure = this.getSteamPressureBar(car);
		// Working costs more steam than the fire makes at working pressure, so a long spell of shunting or a hard
		// leg pulls the needle down and the crew has to stop and let her build up again.
		var base = 800 * (Number(car.steamUseScale) > 0 ? Number(car.steamUseScale) : 1);
		if (pressure >= 10) {
			var highRate = Math.log(800 / 600) / 5;
			return Math.round(base * Math.exp(highRate * (10 - pressure)));
		}
		var lowRate = Math.log(1600 / 800) / 5;
		return Math.round(base * Math.exp(lowRate * (10 - pressure)));
	},
	// Runs one minute of steam-firebox simulation and handles auto-shutdown on missing fuel/water.
	processSteamFireboxMinuteForCar: function(car) {
		if (!this.isSteamLocomotiveCar(car) || car.broken) {
			return;
		}
		this.ensureSteamLocomotiveState(car);
		if (!car.fireboxEnabled) {
			return;
		}
		// The fire goes out without fuel, and is dropped without water to keep the boiler safe. Poor fuel burns at
		// a fraction of the heat, and the steam and the water it boils off follow that fraction.
		var fuel = setup.fuel;
		var scale = fuel.getFireboxScale(car);
		var waterLitersRequired = fuel.WATER_LITRES_PER_MINUTE * scale;
		if (fuel.planSolidFuelMinute(car).starved || this.getCargoAmount(car, 'water') + 1e-9 < waterLitersRequired) {
			car.fireboxEnabled = false;
			return;
		}
		var output = fuel.burnSolidFuelMinute(car);
		if (!(output > 0)) {
			car.fireboxEnabled = false;
			return;
		}
		this.consumeCargoAmount(car, 'water', waterLitersRequired * output);
		this.addSteamLiters(car, this.getSteamProductionLitersPerMinute(car) * output);
	},
	// Which locomotive is being driven: the one the player stands in, or failing that the first in the consist.
	// Without multiple unit control (not built yet), that locomotive alone pulls, sets the speed and burns fuel.
	// Any other locomotive is in neutral: hauled like a car of the same weight. Every train passed here is the
	// player's consist or a copy of it, so the player's car index applies to it.
	getControllingLocomotiveIndex: function(train) {
		if (!Array.isArray(train)) {
			return -1;
		}
		var index = Number(State.variables && State.variables.currentCarIndex);
		if (train[index] && !train[index].broken && train[index].tractiveCapacity > 0) {
			return index;
		}
		for (var i = 0; i < train.length; i++) {
			if (train[i] && !train[i].broken && train[i].tractiveCapacity > 0) {
				return i;
			}
		}
		return -1;
	},
	getControllingLocomotive: function(train) {
		var index = this.getControllingLocomotiveIndex(train);
		return index === -1 ? null : train[index];
	},
	// Whether the locomotive being driven can provide traction right now.
	isTrainDriveCapable: function(train) {
		var car = this.getControllingLocomotive(train);
		if (!car || car.broken) {
			return false;
		}
		if (this.isDieselLocomotiveCar(car)) {
			return setup.fuel.canDieselRun(car);
		}
		return this.isSteamLocomotiveCar(car) && this.getSteamPressureBar(car) >= 10;
	},
	// Spends one minute of moving from the locomotive being driven, and returns whether it had the power to.
	consumeShuntingResourcesForMinute: function(train) {
		if (!this.isTrainDriveCapable(train)) {
			return false;
		}
		var car = this.getControllingLocomotive(train);
		if (this.isDieselLocomotiveCar(car)) {
			return this.consumeCargoAmount(car, 'diesel', setup.fuel.getDieselLitresPerMinute(car));
		}
		return this.consumeSteamLiters(car, this.getSteamShuntingCostPerMinute(car));
	},
	// Estimates the wait until the locomotive being driven reaches usable steam pressure (10 bar), by running a copy
	// of the whole consist, so car positions stay the same as in the real one.
	estimateMinutesUntilSteamUsable: function(train, maxMinutes) {
		if (!Array.isArray(train) || !train.length) {
			return -1;
		}
		if (this.isTrainDriveCapable(train)) {
			return 0;
		}
		var limit = Math.max(1, setup.safeParseInt(maxMinutes, 720));
		var sim = train.map(function(car) { return this.cloneCar(car); }, this);
		var driven = this.getControllingLocomotive(sim);
		if (!this.isSteamLocomotiveCar(driven)) {
			return -1;
		}
		for (var minute = 1; minute <= limit; minute++) {
			for (var si = 0; si < sim.length; si++) {
				this.processSteamFireboxMinuteForCar(sim[si]);
			}
			if (this.isTrainDriveCapable(sim)) return minute;
			if (!driven.fireboxEnabled) break;
		}
		return -1;
	},
	// Converts a string seed into a deterministic unsigned integer seed value.
	seedFromString: function(str) {
		var h = 2166136261;
		for (var i = 0; i < str.length; i++) {
			h = Math.imul(h ^ str.charCodeAt(i), 16777619);
		}
		return h >>> 0;
	},
	// Deterministic pseudo-random generator used for reproducible yard generation from a seed.
	mulberry32: function(a) {
		return function() {
			a |= 0;
			a = Math.imul(a + 0x6D2B79F5, 1);
			var t = a ^ (a >>> 15);
			t = Math.imul(t, t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	},
	// Inclusive integer random helper.
	randomInt: function(rng, min, max) {
		return Math.floor(rng() * (max - min + 1)) + min;
	},
	// Selects either uniformly or rarity-weighted, depending on whether the array items define rarity.
	randomChoice: function(rng, array) {
		if (array[0] && array[0].rarity) {
			// Weighted by rarity
			var weights = array.map(function(item) {
				switch(item.rarity) {
					case 'common': return 4;
					case 'uncommon': return 2;
					case 'rare': return 1;
					default: return 1;
				}
			});
			var total = weights.reduce(function(a, b) { return a + b; }, 0);
			var r = rng() * total;
			var sum = 0;
			for (var i = 0; i < array.length; i++) {
				sum += weights[i];
				if (r < sum) return array[i];
			}
			return array[array.length - 1];
		} else {
			return array[this.randomInt(rng, 0, array.length - 1)];
		}
	},
	// Private cars are deliberately uncommon; every other ordinary car has five times its weight.
	randomCarKey: function(rng) {
		var self = this;
		var total = this.carKeys.reduce(function(sum, key) { return sum + (self.carWeights[key] || 1); }, 0);
		var pick = rng() * total;
		for (var i = 0; i < this.carKeys.length; i++) {
			pick -= this.carWeights[this.carKeys[i]] || 1;
			if (pick < 0) return this.carKeys[i];
		}
		return this.carKeys[this.carKeys.length - 1];
	},
	// Generates initial cargo for a newly spawned car while respecting accepted cargo constraints.
	generateCargoForCar: function(carKey, rng) {
		if (this.locomotiveKeys.indexOf(carKey) !== -1) {
			return [];
		}
		// 20% chance to have cargo (for ~3 in 15 cars)
		if (rng() > 0.2) {
			return [];
		}
		var carDef = State.variables.defaultTrains[carKey];
		var acceptedTypes = this.getAcceptedCargoTypes(carDef);
		var filteredPresets = this.cargoPresets.filter(function(p) {
			return acceptedTypes.indexOf(p.type) !== -1 && (!p.cars || p.cars.indexOf(carKey) !== -1);
		});
		if (!filteredPresets.length) return [];
		var count = carKey === 'boxcar' ? this.randomInt(rng, 1, 2) : 1;
		var cargo = [];
		for (var i = 0; i < count; i++) {
			var item = this.randomChoice(rng, filteredPresets);
			var stack = {
				type: item.type,
				amount: this.randomInt(rng, Math.max(1, Math.floor(item.amount * 0.5)), item.amount)
			};
			if (item.grade) {
				stack.grade = this.randomInt(rng, item.grade[0], item.grade[1]);
			}
			cargo.push(stack);
		}
		return cargo;
	},
	// Now and then a station has a dead car standing in the way. It carries nothing and is worth nothing, so the
	// only thing to do with it is shift it, which is the point of it.
	addDerelict: function(tracks, rng) {
		if (rng() >= this.DERELICT_CHANCE) {
			return null;
		}
		var candidates = [];
		for (var index = 1; index < tracks.length - 1; index++) {
			var track = tracks[index];
			if (!track.reservedClearance && track.length - this.getTrackOccupiedLength(track) >= 25) {
				candidates.push(index);
			}
		}
		if (!candidates.length) {
			return null;
		}
		var trackIndex = candidates[this.randomInt(rng, 0, candidates.length - 1)];
		var selected = tracks[trackIndex];
		var connections = this.getTrackConnections(selected, this.getLeads(tracks));
		// Keep the reserved locomotive exposed at the connected end of a siding.
		selected.trains.splice(connections.entry ? selected.trains.length : 0, 0,
			[this.createDerelictCar(this.randomCarKey(rng), rng)]);
		return trackIndex;
	},
	// A derelict: a car that carries nothing, takes nothing and is worth nothing.
	createDerelictCar: function(carKey, rng) {
		var car = this.cloneCar(State.variables.defaultTrains[carKey]);
		car.cargo = [];
		car.acceptedCargo = [];
		car.derelict = true;
		car.broken = true;
		car.name = 'derelict ' + car.type;
		car.hasInterior = false;
		car.facing = rng() < 0.5 ? -1 : 1;
		return car;
	},
	isDerelictCar: function(car) {
		return !!car && car.derelict === true;
	},
	// Creates a locomotive instance from defaults and guarantees it starts empty.
	createLocomotiveCar: function(locoKey) {
		var loco = this.cloneCar(State.variables.defaultTrains[locoKey]);
		// Newly spawned locomotives should start empty.
		loco.cargo = [];
		return loco;
	},
	// Creates a one-car train from a preset key for debug placement tools.
	createTrainFromPreset: function(presetKey) {
		if (this.locomotiveKeys.indexOf(presetKey) !== -1) {
			return [this.createLocomotiveCar(presetKey)];
		}
		var preset = State.variables.defaultTrains[presetKey];
		if (!preset) {
			return [];
		}
		var car = this.cloneCar(preset);
		car.cargo = [];
		return [car];
	},
	// Builds dropdown-friendly train type options for debug UI controls.
	getDebugTrainTypeOptions: function() {
		var options = [];
		var presetKeys = this.locomotiveKeys.concat(this.carKeys);
		for (var i = 0; i < presetKeys.length; i++) {
			var presetKey = presetKeys[i];
			var preset = State.variables.defaultTrains[presetKey];
			if (!preset) {
				continue;
			}
			var label = (preset.name || preset.type)
				.split(' ')
				.map(function(word) {
					return word.charAt(0).toUpperCase() + word.slice(1);
				})
				.join(' ');
			options.push({ value: presetKey, label: label });
		}
		return options;
	},
	// Sums total train length in meters from all cars in the consist.
	getTrainLength: function(train) {
		var total = 0;
		for (var i = 0; i < train.length; i++) {
			total += train[i].length;
		}
		return total;
	},
	// Ensures a track has a valid `trains` array and filters out malformed entries.
	ensureTrackTrainArray: function(stationTracks, trackIndex) {
		if (!stationTracks || !stationTracks[trackIndex]) {
			return null;
		}
		if (!Array.isArray(stationTracks[trackIndex].trains)) {
			stationTracks[trackIndex].trains = [];
		} else {
			stationTracks[trackIndex].trains = stationTracks[trackIndex].trains.filter(function(train) {
				return Array.isArray(train);
			});
		}
		return stationTracks[trackIndex];
	},
	// Inserts a train into a track at a safe index and returns success/failure.
	insertTrainIntoTrack: function(stationTracks, trackIndex, train, insertAt) {
		var track = this.ensureTrackTrainArray(stationTracks, trackIndex);
		if (!track || !Array.isArray(train)) {
			return false;
		}
		var safeInsertAt = typeof insertAt === 'number'
			? Math.max(0, Math.min(insertAt, track.trains.length))
			: track.trains.length;
		track.trains.splice(safeInsertAt, 0, train);
		return true;
	},
	// Sums occupied length for all trains currently on a track.
	getTrackOccupiedLength: function(track) {
		if (!track || !Array.isArray(track.trains)) {
			return 0;
		}
		var total = 0;
		for (var i = 0; i < track.trains.length; i++) {
			total += this.getTrainLength(track.trains[i]);
		}
		return total;
	},
	// Returns the canonical entry track index.
	getEntryTrackIndex: function() {
		return 0;
	},
	// Returns the canonical exit track index for a station layout.
	getExitTrackIndex: function(stationTracks) {
		return stationTracks.length - 1;
	},
	// Compass headings along the route. The journey runs north out of Punta Arenas and turns east or west as it
	// crosses continents, so each leg between two stations has a heading of its own, seeded from the save so the
	// answer never changes. The first legs, up Patagonia, always run north.
	// The eight points a leg can run on. A station's two leads always face opposite ways, so a yard drawn from
	// either end reads the same; which pair it uses is what varies.
	HEADINGS: ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'],
	// The route trends north over all, but a leg can strike off in any compass direction.
	HEADING_WEIGHTS: [
		['north', 29], ['northeast', 16], ['northwest', 16], ['east', 12], ['west', 12],
		['southeast', 5], ['south', 5], ['southwest', 5]
	],
	getLegHeading: function(stationId, baseSeed) {
		// Keep the opening journey north through Patagonia. Later legs can use every compass point.
		if (stationId < 10) {
			return 'north';
		}
		var rng = this.mulberry32(this.seedFromString(String(baseSeed || '') + stationId + ':heading'));
		var roll = this.randomInt(rng, 1, 100);
		var running = 0;
		for (var i = 0; i < this.HEADING_WEIGHTS.length; i++) {
			running += this.HEADING_WEIGHTS[i][1];
			if (roll <= running) {
				return this.HEADING_WEIGHTS[i][0];
			}
		}
		return 'north';
	},
	oppositeDirection: function(direction) {
		var index = this.HEADINGS.indexOf(direction);
		return index === -1 ? 'south' : this.HEADINGS[(index + 4) % 8];
	},
	// The heading a train takes when it leaves the station by this lead: the exit lead follows the leg ahead, and
	// the entry lead points back down the leg the player arrived on. Each is stored on its own lead track object,
	// so a station keeps its headings however it was built.
	getLeadDirection: function(stationTracks, which) {
		if (!stationTracks || !stationTracks.length) {
			return which === 'exit' ? 'north' : 'south';
		}
		var track = which === 'exit' ? stationTracks[stationTracks.length - 1] : stationTracks[0];
		return (track && track.direction) || (which === 'exit' ? 'north' : 'south');
	},
	// Turns a heading into the name the player reads, as in 'Northbound'.
	// What a lead is called: Northbound, North-eastbound, and so on.
	DIRECTION_NAMES: {
		north: 'North', northeast: 'North-east', east: 'East', southeast: 'South-east',
		south: 'South', southwest: 'South-west', west: 'West', northwest: 'North-west'
	},
	DIRECTION_LETTERS: {
		north: 'N', northeast: 'NE', east: 'E', southeast: 'SE',
		south: 'S', southwest: 'SW', west: 'W', northwest: 'NW'
	},
	getDirectionName: function(direction) {
		return (this.DIRECTION_NAMES[direction] || 'North') + 'bound';
	},
	// Which way a car physically points: 1 toward the station's exit, -1 the other way. Shunting never turns a car
	// round, so a car keeps its facing through coupling, decoupling, travel and being parked.
	getCarFacing: function(car) {
		return car && Number(car.facing) === -1 ? -1 : 1;
	},
	// True when the player arrived travelling back down the route. The yard is then drawn from its other end, so
	// the lead they came in on is still at the top left and the way onward still runs to the bottom right.
	isYardViewFlipped: function() {
		return State.variables.travellingForward === false;
	},
	// Which leads a station has. Station 1 has no entry, because no station lies behind it, and any station's
	// entry or exit can be closed with hasLead: false on that lead's track object. The object stays in the array,
	// so track indices never shift. A station always keeps at least one lead, or the player could never leave,
	// so a station flagged with neither keeps its exit.
	getLeads: function(stationTracks) {
		var entryTrack = stationTracks && stationTracks[0];
		var exitTrack = stationTracks && stationTracks[stationTracks.length - 1];
		var entry = !entryTrack || entryTrack.hasLead !== false;
		var exit = !exitTrack || exitTrack.hasLead !== false;
		return entry || exit ? { entry: entry, exit: exit } : { entry: false, exit: true };
	},
	// False for an index outside the station and for an entry or exit track the station does not have.
	trackExists: function(stationTracks, index) {
		if (!stationTracks || typeof index !== 'number' || index < 0 || index >= stationTracks.length) {
			return false;
		}
		var leads = this.getLeads(stationTracks);
		if (index === this.getEntryTrackIndex()) return leads.entry;
		if (index === this.getExitTrackIndex(stationTracks)) return leads.exit;
		return true;
	},
	// The nearest track that exists: a missing entry or exit track gives way to the yard track beside it.
	getNearestExistingTrackIndex: function(stationTracks, index) {
		var lastIndex = stationTracks.length - 1;
		var safeIndex = this.safeTrackIndex(index, lastIndex);
		if (this.trackExists(stationTracks, safeIndex)) {
			return safeIndex;
		}
		return safeIndex === this.getEntryTrackIndex() ? Math.min(1, lastIndex) : Math.max(0, lastIndex - 1);
	},
	// Random yards are kept small on purpose: a handful of short tracks is far better to shunt than a realistic
	// mainline yard, which is enormous and tedious to read. These caps apply to generation only — the debug tools
	// can still add longer tracks, and more of them.
	MAX_GENERATED_YARD_TRACKS: 5,
	MIN_GENERATED_YARD_TRACKS: 2, // a through track and a siding is the smallest yard worth shunting
	SIDING_CHANCE: 0.35,          // sidings are common, and a siding is a dead end by definition
	MAX_GENERATED_TRACK_METRES: 300,
	MIN_GENERATED_TRACK_METRES: 160,
	// How long each yard track is, worked out from the shape of the yard rather than picked at random. A track
	// runs from its switch on the entry ladder to its switch on the exit ladder: the tracks between the two leads
	// get the full length, and every row beyond them is one junction shorter, because its switches sit one
	// junction further in at each end. Drawing each track at its stated length then reproduces this geometry
	// exactly, so the picture and the numbers always agree.
	getYardTrackLengths: function(yardCount, entryRow, exitRow, longest) {
		var junction = (typeof setup.railyardTemplates !== 'undefined' && setup.railyardTemplates.junctionMetres) || 20;
		var minimum = 120; // even the shortest track has to hold a train or two
		var spans = [];
		var shortest = Infinity;
		var deepest = 0;
		var r;
		for (r = 1; r <= yardCount; r++) {
			spans[r] = Math.abs(r - exitRow) + Math.abs(r - entryRow);
			shortest = Math.min(shortest, spans[r]);
		}
		for (r = 1; r <= yardCount; r++) {
			deepest = Math.max(deepest, spans[r] - shortest);
		}
		var top = Math.max(longest, minimum + deepest * junction);
		var lengths = [];
		for (r = 1; r <= yardCount; r++) {
			lengths.push(top - (spans[r] - shortest) * junction);
		}
		return lengths;
	},
	// Returns only yard (non-boundary) track indices.
	getYardTrackIndices: function(stationTracks) {
		var idx = [];
		for (var i = 1; i < stationTracks.length - 1; i++) {
			idx.push(i);
		}
		return idx;
	},
	// Boundary interactions unlock only when at least one middle track is empty.
	hasEmptyMiddleTrack: function(stationTracks) {
		if (!stationTracks || stationTracks.length < 3) {
			return false;
		}
		for (var i = 1; i < stationTracks.length - 1; i++) {
			if (!stationTracks[i].trains.length) {
				return true;
			}
		}
		return false;
	},
	// True when a track index is between entry and exit.
	isYardTrackIndex: function(stationTracks, index) {
		return index > 0 && index < stationTracks.length - 1;
	},
	// Produces player-facing track names. A lead is named for the compass direction a train takes when it leaves
	// by it, so the player reads real directions while the code goes on working in entry and exit.
	getTrackLabel: function(stationTracks, index) {
		if (index === 0 || index === stationTracks.length - 1) {
			var which = index === 0 ? 'entry' : 'exit';
			var direction = this.getDirectionName(this.getLeadDirection(stationTracks, which));
			var boundary = stationTracks[index];
			return boundary && !boundary.infinite
				? direction.replace(/bound$/, '') + ' Stub'
				: direction + ' Track';
		}
		return 'Yard Track ' + index;
	},
	// Returns track indices in current travel orientation order (forward or reversed).
	getDirectionalTrackIndices: function(stationTracks, reverse) {
		var order = [];
		if (!stationTracks || !stationTracks.length) {
			return order;
		}
		if (reverse) {
			for (var r = stationTracks.length - 1; r >= 0; r--) {
				order.push(r);
			}
		} else {
			for (var i = 0; i < stationTracks.length; i++) {
				order.push(i);
			}
		}
		return order;
	},
	// Builds converters between oriented and actual indices for direction-aware shunting logic.
	getDirectionalContext: function(stationTracks, playerTrackIndex) {
		var exitIndex = this.getExitTrackIndex(stationTracks);
		// The player reads the station left-to-right from Entry Track, but when positioned on
		// the Exit Track the interaction order must be reversed so "front" and "rear" still
		// mean "toward the current direction of travel".
		var safeTrackIndex = this.safeTrackIndex(playerTrackIndex, exitIndex);
		var reverse = safeTrackIndex === exitIndex;
		var order = this.getDirectionalTrackIndices(stationTracks, reverse);
		var actualToOriented = {};
		for (var oi = 0; oi < order.length; oi++) {
			actualToOriented[order[oi]] = oi;
		}
		return {
			reverse: reverse,
			order: order,
			playerTrackIndex: safeTrackIndex,
			playerOrientedIndex: actualToOriented[safeTrackIndex],
			// Maps oriented (directional) index back to actual station array index.
			toActualTrackIndex: function(orientedIndex) {
				return order[orientedIndex];
			},
			// Maps actual station array index into oriented (directional) index.
			toOrientedTrackIndex: function(actualIndex) {
				return actualToOriented[actualIndex];
			}
		};
	},
	// Flattens all trains on a track into one ordered car list for mass-couple shove operations.
	flattenTrackTrainsForDirection: function(trackTrains, reverse) {
		var mergedCars = [];
		// Tracks run entry-to-exit; car arrays run front-to-rear (exit-to-entry).
		for (var i = trackTrains.length - 1; i >= 0; i--) {
			Array.prototype.push.apply(mergedCars, trackTrains[i]);
		}
		return mergedCars;
	},
	// Couples one train into another, returning the front-insert delta for car index adjustments.
	coupleTrainWithDirection: function(currentTrain, mergeTrain, reverse, toFrontInForward) {
		if (toFrontInForward) {
			Array.prototype.unshift.apply(currentTrain, mergeTrain);
			return mergeTrain.length;
		}
		Array.prototype.push.apply(currentTrain, mergeTrain);
		return 0;
	},
	// Checks whether a train can fit on a track under finite/infinite capacity rules.
	canTrainFitOnTrack: function(track, train) {
		if (!track) {
			return false;
		}
		if (track.infinite) {
			return true;
		}
		return this.getTrackOccupiedLength(track) + this.getTrainLength(train) <= track.length;
	},
	// Determines if any train blocks movement from the player's current gap in a chosen direction.
	hasTrackObstructionInDirection: function(stationTracks, playerTrackIndex, enteredTrainIndex, towardExit) {
		if (!stationTracks || !stationTracks.length) {
			return false;
		}
		var exitIndex = this.getExitTrackIndex(stationTracks);
		var safeIndex = this.safeTrackIndex(playerTrackIndex, exitIndex);
		var currentTrack = this.ensureTrackTrainArray(stationTracks, safeIndex);
		if (!currentTrack) {
			return false;
		}
		if (typeof enteredTrainIndex !== 'undefined' && enteredTrainIndex !== null) {
			var gap = parseInt(enteredTrainIndex, 10);
			if (isNaN(gap)) {
				gap = this.getDefaultEnteredTrainIndex(stationTracks, safeIndex);
			}
			gap = Math.max(0, Math.min(gap, currentTrack.trains.length));
			return towardExit ? currentTrack.trains.length > gap : gap > 0;
		}
		return currentTrack.trains.length > 0;
	},
	// Convenience wrapper for "ahead" in current orientation, delegating to directional obstruction logic.
	hasTrackObstructionAhead: function(stationTracks, playerTrackIndex) {
		if (!stationTracks || !stationTracks.length) {
			return false;
		}
		var exitIndex = this.getExitTrackIndex(stationTracks);
		var safeIndex = this.safeTrackIndex(playerTrackIndex, exitIndex);
		var reverseDir = safeIndex === exitIndex;
		var enteredTrainIndex = arguments[2];
		return this.hasTrackObstructionInDirection(stationTracks, safeIndex, enteredTrainIndex, !reverseDir);
	},
	// A ladder is not blocked merely because a train is standing on a parallel track.  The old index-by-index
	// check treated every road between two array positions as if it lay across the route, which stranded a train
	// on Track 03 behind an occupied stub on Track 02.  The actual route is determined by the shared ladder end.
	hasClearPathBetweenTracks: function(stationTracks, fromTrackIndex, toTrackIndex) {
		if (!this.trackExists(stationTracks, fromTrackIndex) || !this.trackExists(stationTracks, toTrackIndex)) return false;
		return fromTrackIndex === toTrackIndex || setup.yardActions.routes(stationTracks, fromTrackIndex, toTrackIndex, 0).length > 0;
	},
	// Validates that the player is positioned at the departure edge of a boundary track.
	isAtBoundaryDeparturePosition: function(stationTracks, playerTrackIndex, enteredTrainIndex, towardExit) {
		if (!stationTracks || !stationTracks.length) {
			return false;
		}
		var boundaryIndex = towardExit ? this.getExitTrackIndex(stationTracks) : this.getEntryTrackIndex();
		var safeIndex = this.safeTrackIndex(playerTrackIndex, stationTracks.length - 1);
		if (safeIndex !== boundaryIndex) {
			return false;
		}
		var boundaryTrack = this.ensureTrackTrainArray(stationTracks, safeIndex);
		if (!boundaryTrack) {
			return false;
		}
		var gap = parseInt(enteredTrainIndex, 10);
		if (isNaN(gap)) {
			gap = this.getDefaultEnteredTrainIndex(stationTracks, safeIndex);
		}
		gap = Math.max(0, Math.min(gap, boundaryTrack.trains.length));
		return towardExit ? gap === boundaryTrack.trains.length : gap === 0;
	},
	// Both travel directions use the same obstruction and route checks as shunting.
	getDepartureBlockReason: function(stationId, playerTrackIndex, towardExit) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || tracks.length < 3) {
			return 'No valid station track layout.';
		}
		if (!(towardExit ? this.getLeads(tracks).exit : this.getLeads(tracks).entry)) {
			return 'This station has no ' + this.getTrackLabel(tracks, towardExit ? this.getExitTrackIndex(tracks) : this.getEntryTrackIndex()) + '.';
		}
		var destination = Number(stationId) + (towardExit ? 1 : -1);
		if (destination < 1) {
			return 'There is no station before this one.';
		}
		// A station not generated yet always has the lead the player arrives on (only station 1 lacks one).
		var destinationTracks = State.variables.stationTracks[destination];
		if (destinationTracks && !(towardExit ? this.getLeads(destinationTracks).entry : this.getLeads(destinationTracks).exit)) {
			return 'Station ' + destination + ' has no '
				+ this.getTrackLabel(destinationTracks, towardExit ? this.getEntryTrackIndex() : this.getExitTrackIndex(destinationTracks))
				+ ' to arrive on.';
		}
		// The world between the stations has the last word: a heavy consist cannot pull the steepest grade there.
		var climbReason = setup.worldmap.getClimbBlockReason(stationId, towardExit, State.variables.currentTrain);
		if (climbReason) {
			return climbReason;
		}
		var gap = State.variables.enteredTrainIndex;
		playerTrackIndex = this.safeTrackIndex(playerTrackIndex, tracks.length - 1);
		if (this.hasTrackObstructionInDirection(tracks, playerTrackIndex, gap, towardExit)) {
			return 'A consist on your current track blocks departure in this direction.';
		}
		var boundaryIndex = towardExit ? this.getExitTrackIndex(tracks) : this.getEntryTrackIndex();
		var boundary = tracks[boundaryIndex];
		if (!boundary.infinite) {
			return this.getTrackLabel(tracks, boundaryIndex) + ' ends at a buffer stop.';
		}
		if (boundary.trains.length && !this.isAtBoundaryDeparturePosition(tracks, playerTrackIndex, gap, towardExit)) {
			return this.getTrackLabel(tracks, boundaryIndex) + ' is blocked.';
		}
		if (playerTrackIndex === boundaryIndex) {
			return '';
		}
		return setup.yardActions.routes(tracks, playerTrackIndex, boundaryIndex,
			this.getTrainLength(State.variables.currentTrain || []), gap).length
			? '' : 'No clear yard track with enough space on the departure route.';
	},
	canAdvanceToNextStation: function(stationId, playerTrackIndex) {
		return this.getDepartureBlockReason(stationId, playerTrackIndex, true) === '';
	},
	getAdvanceBlockReason: function(stationId, playerTrackIndex) {
		return this.getDepartureBlockReason(stationId, playerTrackIndex, true);
	},
	travelToStation: function(towardExit) {
		var variables = State.variables;
		var destination = variables.currentStation + (towardExit ? 1 : -1);
		if (destination < 1 || this.getDepartureBlockReason(variables.currentStation, variables.drivingTrackIndex, towardExit)) {
			return false;
		}
		return this.arriveAtStation(destination, towardExit);
	},
	// Rolling into a station: the consist comes off the line and stands on the lead it arrived by. Shared by the
	// tile-by-tile journey and by the whole-leg jump the tests and debug tools use.
	arriveAtStation: function(destination, towardExit) {
		var variables = State.variables;
		if (!variables.stationTracks[destination]) {
			variables.stationTracks[destination] = this.generateStationTracks(destination, variables.randomSeed);
		}
		var tracks = variables.stationTracks[destination];
		var arrivalTrackIndex = towardExit ? this.getEntryTrackIndex() : this.getExitTrackIndex(tracks);
		if (!this.trackExists(tracks, arrivalTrackIndex)) {
			return false;
		}
		// Which way the player is going decides which end of the yard they are looking from. Backing into the
		// station they just left is not a change of direction: they are still heading the way they were, so the
		// yard keeps its orientation and nothing appears to turn round.
		if (String(destination) !== String(variables.currentStation)) {
			variables.travellingForward = !!towardExit;
		}
		variables.currentStation = destination;
		variables.drivingTrackIndex = arrivalTrackIndex;
		variables.enteredTrainIndex = this.getDefaultEnteredTrainIndex(tracks, variables.drivingTrackIndex);
		variables.journey = null;
		return true;
	},
	// Leaving a yard puts the consist on the first tile of the leg, and from there it moves a tile at a time.
	departOntoLine: function(towardExit) {
		var variables = State.variables;
		if (setup.worldmap.isBranchStation(variables.currentStation)) {
			return this.departFromBranchTerminus();
		}
		var stationId = Number(variables.currentStation);
		if (this.getDepartureBlockReason(stationId, variables.drivingTrackIndex, towardExit)) {
			return false;
		}
		setup.tutorial.finish();
		var legIndex = setup.worldmap.getLegIndexFor(stationId, towardExit);
		if (legIndex < 1) {
			return false;
		}
		var tiles = setup.worldmap.getMainLine(setup.worldmap.getSeed(), legIndex);
		variables.travellingForward = !!towardExit;
		variables.journey = { legIndex: legIndex, tileIndex: towardExit ? 0 : tiles.length - 1, forward: !!towardExit };
		return true;
	},
	// Leaving a branch terminus: back onto the branch at its far end, facing the junction it came from.
	departFromBranchTerminus: function() {
		var variables = State.variables;
		var branch = setup.worldmap.getBranchForStation(setup.worldmap.getSeed(), variables.currentStation);
		if (!branch || !branch.tiles.length) {
			return false;
		}
		if (this.getDepartureBlockReason(variables.currentStation, variables.drivingTrackIndex, false)) {
			return false;
		}
		variables.journey = {
			legIndex: branch.legIndex, branch: branch.id, tileIndex: branch.tiles.length - 1,
			forward: variables.travellingForward !== false
		};
		return true;
	},
	// One 5 km step: direction 1 carries on toward the destination, -1 backs up the way the train came. Reaching
	// either end of the line arrives at the station standing there and ends the journey.
	// Turning off the main line onto a branch. The branch is then the line the train is running on.
	takeBranch: function(branchId) {
		var step = setup.worldmap.getBranchStep(branchId);
		if (!step || step.blocked) {
			return false;
		}
		var journey = setup.worldmap.getJourney();
		journey.branch = branchId;
		journey.tileIndex = 0;
		State.variables.journey = journey;
		return true;
	},
	moveAlongLine: function(direction) {
		var step = setup.worldmap.getJourneyStep(direction);
		if (!step || step.blocked) {
			return false;
		}
		var journey = setup.worldmap.getJourney();
		// A branch can end on the main line at either end: back at its junction, or further along where it rejoins.
		if (step.toMain !== null && typeof step.toMain !== 'undefined') {
			journey.branch = null;
		}
		journey.tileIndex = step.toIndex;
		State.variables.journey = journey;
		if (step.arrivesAt) {
			// Arriving forward means coming in on the next station's entry lead, and backing in means its exit lead.
			// A branch terminus has only the one lead, so a train always arrives on it.
			var onEntryLead = setup.worldmap.isBranchStation(step.arrivesAt) || step.arrivesAt > journey.legIndex;
			this.arriveAtStation(step.arrivesAt, onEntryLead);
		}
		return true;
	},
	// Counts how many leading cars can fit inside a finite remaining track length.
	getCarsFitCountForLength: function(train, maxLength) {
		var used = 0;
		var count = 0;
		for (var i = 0; i < train.length; i++) {
			if (used + train[i].length > maxLength) {
				break;
			}
			used += train[i].length;
			count++;
		}
		return count;
	},
	placeTrainInStationTracks: function(stationTracks, train, preferredTrackIndex, preferredTrainIndex, overflowTrackIndex) {
		// Placement always tries the requested track first, then gracefully falls back through
		// split-overflow, yard tracks, and finally the boundary tracks.
		if (typeof preferredTrackIndex !== 'undefined' && this.trackExists(stationTracks, preferredTrackIndex)) {
			var preferredTrack = this.ensureTrackTrainArray(stationTracks, preferredTrackIndex);
			if (this.canTrainFitOnTrack(preferredTrack, train)) {
				var insertAt = Math.max(0, Math.min(preferredTrainIndex || 0, preferredTrack.trains.length));
				this.insertTrainIntoTrack(stationTracks, preferredTrackIndex, train, insertAt);
				return true;
			}
			// If the preferred track is a finite yard track, allow overflow into entry/exit.
			if (this.isYardTrackIndex(stationTracks, preferredTrackIndex) && !preferredTrack.infinite) {
				var availableLength = Math.max(0, preferredTrack.length - this.getTrackOccupiedLength(preferredTrack));
				var fitCount = this.getCarsFitCountForLength(train, availableLength);
				if (fitCount > 0 && fitCount < train.length) {
					var primaryPart = train.slice(0, fitCount);
					var overflowPart = train.slice(fitCount);
					if (this.isTrainVisited(train)) {
						this.markTrainVisited(primaryPart);
						this.markTrainVisited(overflowPart);
					}
					var insertAtSplit = Math.max(0, Math.min(preferredTrainIndex || 0, preferredTrack.trains.length));
					this.insertTrainIntoTrack(stationTracks, preferredTrackIndex, primaryPart, insertAtSplit);
					var resolvedOverflowIndex;
					if (this.trackExists(stationTracks, overflowTrackIndex)) {
						resolvedOverflowIndex = overflowTrackIndex;
					} else {
						var entryIndex = this.getEntryTrackIndex();
						var exitIndex = this.getExitTrackIndex(stationTracks);
						var distanceToEntry = preferredTrackIndex - entryIndex;
						var distanceToExit = exitIndex - preferredTrackIndex;
						var overflowLeads = this.getLeads(stationTracks);
						resolvedOverflowIndex = !overflowLeads.exit || (overflowLeads.entry && distanceToEntry <= distanceToExit) ? entryIndex : exitIndex;
					}
					if (!this.insertTrainIntoTrack(stationTracks, resolvedOverflowIndex, overflowPart)) {
						return false;
					}
					return true;
				}
			}
		}
		var yardIndices = this.getYardTrackIndices(stationTracks);
		for (var yi = 0; yi < yardIndices.length; yi++) {
			var yardTrack = stationTracks[yardIndices[yi]];
			if (this.canTrainFitOnTrack(yardTrack, train)) {
				this.insertTrainIntoTrack(stationTracks, yardIndices[yi], train);
				return true;
			}
		}
		if (this.trackExists(stationTracks, this.getEntryTrackIndex())) {
			this.insertTrainIntoTrack(stationTracks, this.getEntryTrackIndex(), train);
			return true;
		}
		if (this.trackExists(stationTracks, this.getExitTrackIndex(stationTracks))) {
			this.insertTrainIntoTrack(stationTracks, this.getExitTrackIndex(stationTracks), train);
			return true;
		}
		return false;
	},
	placeDecoupledSplitFromCurrentTrain: function(stationId, drivingTrackIndex, splitTrain, isFrontSplit) {
		if (!Array.isArray(splitTrain) || !splitTrain.length) {
			return false;
		}
		if (typeof State.variables.stationTracks[stationId] === 'undefined') {
			State.variables.stationTracks[stationId] = this.generateStationTracks(stationId, State.variables.randomSeed);
		}
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || !tracks.length) {
			return false;
		}
		var safeTrackIndex = this.safeTrackIndex(drivingTrackIndex, tracks.length - 1);
		var track = this.ensureTrackTrainArray(tracks, safeTrackIndex);
		if (!track) {
			return false;
		}
		var rawGap = parseInt(State.variables.enteredTrainIndex, 10);
		if (isNaN(rawGap)) {
			rawGap = this.getDefaultEnteredTrainIndex(tracks, safeTrackIndex);
		}
		var gap = Math.max(0, Math.min(rawGap, track.trains.length));
		// The player is absent from track.trains; both adjacent sides insert at the gap.
		var insertAt = gap;
		// Strictly this track: a section that will not fit here is not scattered onto other tracks. Shunting moves
		// cars along rails, so a full track means the move cannot happen, not that the cars go somewhere else.
		if (!this.canTrainFitOnTrack(track, splitTrain)) {
			return false;
		}
		if (!this.insertTrainIntoTrack(tracks, safeTrackIndex, splitTrain, insertAt)) {
			return false;
		}
		var trackAfterPlacement = this.ensureTrackTrainArray(tracks, safeTrackIndex);
		if (!trackAfterPlacement) {
			return false;
		}
		State.variables.enteredTrainIndex = isFrontSplit
			? Math.min(trackAfterPlacement.trains.length, gap)
			: Math.min(trackAfterPlacement.trains.length, gap + 1);
		return true;
	},
	// The section that comes off when the player decouples: everything ahead of the car they occupy, or
	// everything behind it.
	getDecoupleSection: function(isFront) {
		var train = State.variables.currentTrain;
		if (!Array.isArray(train) || train.length < 2) {
			return [];
		}
		var carIndex = Math.max(0, Math.min(setup.safeParseInt(State.variables.currentCarIndex, 0), train.length - 1));
		return isFront ? train.slice(0, carIndex) : train.slice(carIndex + 1);
	},
	// Why that section cannot be left here, or '' if it can.
	getDecoupleBlockReason: function(isFront) {
		var variables = State.variables;
		var section = this.getDecoupleSection(isFront);
		if (!section.length) {
			return 'There is nothing to decouple on that side.';
		}
		var tracks = variables.stationTracks[variables.currentStation];
		if (!tracks || !tracks.length) {
			return 'There is no track to leave it on.';
		}
		var trackIndex = this.safeTrackIndex(variables.drivingTrackIndex, tracks.length - 1);
		var track = this.ensureTrackTrainArray(tracks, trackIndex);
		if (!track) {
			return 'There is no track to leave it on.';
		}
		if (!this.canTrainFitOnTrack(track, section)) {
			return this.getTrackLabel(tracks, trackIndex) + ' has ' + this.getTrackFreeLength(track)
				+ ' m free, and the section needs ' + this.getTrainLength(section) + ' m.';
		}
		return '';
	},
	// Decoupling, in one step. The cars only leave the consist once there is room for the whole section beside
	// what is already on this track, and if the move cannot be completed nothing changes at all.
	decoupleSection: function(isFront) {
		var variables = State.variables;
		if (this.getDecoupleBlockReason(isFront)) {
			return false;
		}
		var train = variables.currentTrain;
		var carIndex = Math.max(0, Math.min(setup.safeParseInt(variables.currentCarIndex, 0), train.length - 1));
		var section = isFront ? train.splice(0, carIndex) : train.splice(carIndex + 1);
		this.markTrainVisited(section);
		if (!this.placeDecoupledSplitFromCurrentTrain(variables.currentStation, variables.drivingTrackIndex, section, isFront)) {
			// Put the cars back rather than losing them because a track turned out to be full.
			if (isFront) {
				Array.prototype.unshift.apply(train, section);
			} else {
				Array.prototype.push.apply(train, section);
			}
			return false;
		}
		if (isFront) {
			variables.currentCarIndex = Math.max(0, carIndex - section.length);
		}
		return true;
	},
	// Deletes a selected debug target (either entire train or one car) and prunes empty trains afterward.
	deleteDebugTarget: function(stationId, trackIndex, trainIndex, carIndex) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || !tracks[trackIndex] || !tracks[trackIndex].trains[trainIndex]) {
			return;
		}
		if (carIndex === -1) {
			tracks[trackIndex].trains.splice(trainIndex, 1);
		} else {
			tracks[trackIndex].trains[trainIndex].splice(carIndex, 1);
		}
		for (var i = 0; i < tracks.length; i++) {
			tracks[i].trains = tracks[i].trains.filter(function(train) {
				return train && train.length > 0;
			});
		}
	},
	// Inserts a new debug yard track immediately before exit, respecting yard track count limits.
	addDebugTrack: function(stationId, length) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || tracks.length < 2) {
			tracks = this.generateStationTracks(stationId, State.variables.randomSeed || 'ashline');
			State.variables.stationTracks[stationId] = tracks;
		}
		if (this.getYardTrackIndices(tracks).length >= 15) {
			return;
		}
		var trackLength = Math.max(1, Math.floor(length || 0));
		var insertAt = this.getExitTrackIndex(tracks);
		tracks.splice(insertAt, 0, { length: trackLength, trains: [] });
		State.variables.debugSelectedTrackIndex = insertAt;
		State.variables.debugSelectedTrainIndex = 0;
		State.variables.debugSelectedCarIndex = -1;
	},
	// Marks which ends of a yard track connect to the entry and exit ladders. Connected ends store no flag,
	// so tracks without flags (including older saves) stay connected at both ends.
	setDebugTrackConnections: function(stationId, trackIndex, connectsToEntry, connectsToExit) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || !this.isYardTrackIndex(tracks, trackIndex)) {
			return;
		}
		var track = tracks[trackIndex];
		if (!connectsToEntry && !connectsToExit) {
			return; // a track must reach the entry or the exit, or the trains on it could never leave
		}
		if (connectsToEntry) { delete track.connectsToEntry; } else { track.connectsToEntry = false; }
		if (connectsToExit) { delete track.connectsToExit; } else { track.connectsToExit = false; }
	},
	// Which yard track's line the entry or exit lead runs along (1 = the farthest yard track). Leads without
	// a stored track default to the corners: entry on the first yard track, exit on the last.
	getLeadTrack: function(stationTracks, which) {
		var yardCount = Math.max(0, stationTracks.length - 2);
		if (!yardCount) return 1;
		var lead = which === 'exit' ? stationTracks[stationTracks.length - 1] : stationTracks[0];
		var value = parseInt(lead && lead.leadTrack, 10);
		return isNaN(value) ? (which === 'exit' ? yardCount : 1) : Math.max(1, Math.min(yardCount, value));
	},
	// Debug: sets which yard track's line the entry and exit leads run along.
	setDebugLeadTracks: function(stationId, entryTrack, exitTrack) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || tracks.length < 3) return;
		tracks[0].leadTrack = entryTrack;
		tracks[tracks.length - 1].leadTrack = exitTrack;
	},
	// Debug: points the station's two leads along new compass headings. Both pointing the same way would mean
	// arriving and leaving in one direction, so that is refused.
	setDebugLeadDirections: function(stationId, entryDirection, exitDirection) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || tracks.length < 3 || entryDirection === exitDirection) {
			return false;
		}
		tracks[0].direction = entryDirection;
		tracks[tracks.length - 1].direction = exitDirection;
		return true;
	},
	// Why the station's entry and exit tracks cannot be set this way, or '' if they can. A station needs at least
	// one of them, station 1 never has an entry, and a track that holds trains or the player cannot be removed.
	getLeadChangeBlockReason: function(stationId, hasEntry, hasExit) {
		var variables = State.variables;
		var tracks = variables.stationTracks[stationId];
		if (!tracks || tracks.length < 3) {
			return 'no valid station track layout';
		}
		if (!hasEntry && !hasExit) {
			return 'a station needs at least one way out';
		}
		if (hasEntry && Number(stationId) === 1) {
			return 'station 1 has no station behind it';
		}
		var leads = this.getLeads(tracks);
		var removing = [];
		if (leads.entry && !hasEntry) removing.push(this.getEntryTrackIndex());
		if (leads.exit && !hasExit) removing.push(this.getExitTrackIndex(tracks));
		var playerAboard = Array.isArray(variables.currentTrain) && variables.currentTrain.length > 0
			&& Number(variables.currentStation) === Number(stationId);
		for (var i = 0; i < removing.length; i++) {
			var label = this.getTrackLabel(tracks, removing[i]);
			if (tracks[removing[i]].trains && tracks[removing[i]].trains.length) {
				return label + ' holds trains';
			}
			if (playerAboard && Number(variables.drivingTrackIndex) === removing[i]) {
				return 'your train is on the ' + label;
			}
		}
		return '';
	},
	// Debug: gives a station its entry and exit tracks or takes one away. Returns '' or the reason it refused.
	setDebugLeads: function(stationId, hasEntry, hasExit) {
		var reason = this.getLeadChangeBlockReason(stationId, hasEntry, hasExit);
		if (reason) {
			return reason;
		}
		var tracks = State.variables.stationTracks[stationId];
		if (hasEntry) { delete tracks[0].hasLead; } else { tracks[0].hasLead = false; }
		if (hasExit) { delete tracks[tracks.length - 1].hasLead; } else { tracks[tracks.length - 1].hasLead = false; }
		return '';
	},
	// Which ends of a yard track connect to the entry and exit ladders (pass setup.railyard.getLeads to leave out
	// a lead the station does not have). Tracks connect at both ends unless flagged. A track must reach at least
	// one lead, or the trains on it could never leave, so a track closed toward every lead the station has
	// counts as connected to all of them.
	getTrackConnections: function(track, leads) {
		leads = leads || { entry: true, exit: true };
		var entry = leads.entry && (!track || track.connectsToEntry !== false);
		var exit = leads.exit && (!track || track.connectsToExit !== false);
		return { entry: entry, exit: exit };
	},
	// Describes a yard track's dead end for the text yard list, naming the lead it cannot reach; empty when the
	// track connects to every lead its station has.
	getDeadEndText: function(stationTracks, trackIndex) {
		var leads = this.getLeads(stationTracks);
		var connections = this.getTrackConnections(stationTracks[trackIndex], leads);
		if (leads.entry && !connections.entry) return 'no link to the ' + this.getTrackLabel(stationTracks, this.getEntryTrackIndex());
		if (leads.exit && !connections.exit) return 'no link to the ' + this.getTrackLabel(stationTracks, this.getExitTrackIndex(stationTracks));
		return '';
	},
	// Removes a debug yard track while preserving boundary tracks and minimum yard count.
	deleteDebugTrack: function(stationId, trackIndex) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks || trackIndex < 0 || trackIndex >= tracks.length) {
			return;
		}
		if (!this.isYardTrackIndex(tracks, trackIndex)) {
			return;
		}
		if (this.getYardTrackIndices(tracks).length <= 1) {
			return;
		}
		tracks.splice(trackIndex, 1);
		State.variables.debugSelectedTrackIndex = Math.max(0, Math.min(State.variables.debugSelectedTrackIndex || 0, tracks.length - 1));
		State.variables.debugSelectedTrainIndex = 0;
		State.variables.debugSelectedCarIndex = -1;
	},
	// Swaps two trains when both destination tracks can still satisfy length constraints after swap.
	swapDebugTrains: function(stationId, aTrackIndex, aTrainIndex, bTrackIndex, bTrainIndex) {
		var tracks = State.variables.stationTracks[stationId];
		if (!tracks) {
			return { ok: false, reason: 'No station tracks available.' };
		}
		aTrackIndex = parseInt(aTrackIndex, 10);
		aTrainIndex = parseInt(aTrainIndex, 10);
		bTrackIndex = parseInt(bTrackIndex, 10);
		bTrainIndex = parseInt(bTrainIndex, 10);
		if (isNaN(aTrackIndex) || isNaN(aTrainIndex) || isNaN(bTrackIndex) || isNaN(bTrainIndex)) {
			return { ok: false, reason: 'Invalid train selection.' };
		}
		if (!tracks[aTrackIndex] || !tracks[bTrackIndex]) {
			return { ok: false, reason: 'Selected track does not exist.' };
		}
		if (!tracks[aTrackIndex].trains[aTrainIndex] || !tracks[bTrackIndex].trains[bTrainIndex]) {
			return { ok: false, reason: 'Selected train does not exist.' };
		}
		if (aTrackIndex === bTrackIndex && aTrainIndex === bTrainIndex) {
			return { ok: false, reason: 'Select two different trains.' };
		}
		var trainA = tracks[aTrackIndex].trains[aTrainIndex];
		var trainB = tracks[bTrackIndex].trains[bTrainIndex];
		if (aTrackIndex === bTrackIndex) {
			tracks[aTrackIndex].trains[aTrainIndex] = trainB;
			tracks[aTrackIndex].trains[bTrainIndex] = trainA;
			return { ok: true };
		}
		var occupiedAWithoutA = this.getTrackOccupiedLength(tracks[aTrackIndex]) - this.getTrainLength(trainA);
		var occupiedBWithoutB = this.getTrackOccupiedLength(tracks[bTrackIndex]) - this.getTrainLength(trainB);
		var lengthA = this.getTrainLength(trainA);
		var lengthB = this.getTrainLength(trainB);
		if (!tracks[aTrackIndex].infinite && occupiedAWithoutA + lengthB > tracks[aTrackIndex].length) {
			return { ok: false, reason: 'Train B does not fit on ' + this.getTrackLabel(tracks, aTrackIndex) + '.' };
		}
		if (!tracks[bTrackIndex].infinite && occupiedBWithoutB + lengthA > tracks[bTrackIndex].length) {
			return { ok: false, reason: 'Train A does not fit on ' + this.getTrackLabel(tracks, bTrackIndex) + '.' };
		}
		tracks[aTrackIndex].trains[aTrainIndex] = trainB;
		tracks[bTrackIndex].trains[bTrainIndex] = trainA;
		return { ok: true };
	},
	// Generates one train candidate for a finite remaining length budget, with optional locomotive spawn.
	buildTrainForRemainingTrack: function(rng, remainingLength, canSpawnLoco) {
		var train = [];
		var trainLength = 0;
		var forcedTrackBreak = false;
		if (canSpawnLoco && rng() < 1 / 15) {
			var locoKey = this.randomChoice(rng, this.locomotiveKeys);
			var loco = this.createLocomotiveCar(locoKey);
			if (loco.length <= remainingLength) {
				train.push(loco);
				trainLength += loco.length;
			}
		}
		var minCars = train.length ? 1 : 1;
		var maxCars = this.randomInt(rng, 1, 3);
		var carAttempts = 0;
		while (carAttempts < maxCars) {
			var carKey = this.randomCarKey(rng);
			var car = this.cloneCar(State.variables.defaultTrains[carKey]);
			car.cargo = this.generateCargoForCar(carKey, rng);
			if (trainLength + car.length > remainingLength) {
				forcedTrackBreak = true;
				break;
			}
			train.push(car);
			trainLength += car.length;
			carAttempts++;
			if (carAttempts >= minCars && rng() < 0.35) {
				break;
			}
		}
		if (!train.length) {
			return null;
		}
		return {train: train, forceNextTrack: forcedTrackBreak};
	},
	// Procedurally generates middle-yard tracks and train placements from a deterministic seed.
	// Fills a yard whose track lengths have already been settled by its geometry (getYardTrackLengths).
	generateRailyardTracks: function(seed, lengths, reservedIndex) {
		var rng = this.mulberry32(this.seedFromString(seed));
		var trackCount = lengths.length;
		var tracks = [];
		var hasLoco = false;
		// A clear road is the yard's escape valve: without one, every boundary crossover is locked and a player can
		// be forced to couple an unrelated car merely to leave.  Reserve it before placing stock, not afterward.
		var clearTrackIndex = Number.isInteger(reservedIndex) ? reservedIndex : this.randomInt(rng, 0, Math.max(0, trackCount - 1));
		// Weighted toward fewer trains: 0 and 1 are most common, 4 is rare.
		var pickTrainCount = function(rngFn) {
			var r = rngFn();
			if (r < 0.30) return 0;
			if (r < 0.60) return 1;
			if (r < 0.80) return 2;
			if (r < 0.93) return 3;
			return 4;
		};
		for (var i = 0; i < trackCount; i++) {
			var trackLength = lengths[i];
			var track = {length: trackLength, trains: [], reservedClearance: i === clearTrackIndex};
			var remaining = trackLength;
			var trainsToGenerate = i === clearTrackIndex ? 0 : pickTrainCount(rng);
			for (var t = 0; t < trainsToGenerate; t++) {
				if (remaining < 12) {
					break;
				}
				var train = [];
				var trainLength = 0;
				var carTarget = this.randomInt(rng, 1, 10);
				// Occasional locomotive, or force one if none have spawned yet.
				var shouldStartWithLoco = (!hasLoco && rng() < 0.45) || (hasLoco && rng() < 0.12);
				if (shouldStartWithLoco) {
					var locoKey = this.randomChoice(rng, this.locomotiveKeys);
					var loco = this.createLocomotiveCar(locoKey);
					if (loco.length <= remaining) {
						train.push(loco);
						trainLength += loco.length;
						hasLoco = true;
					}
				}
				for (var c = train.length; c < carTarget; c++) {
					var carKey = this.randomCarKey(rng);
					var car = this.cloneCar(State.variables.defaultTrains[carKey]);
					car.cargo = this.generateCargoForCar(carKey, rng);
					if (trainLength + car.length > remaining) {
						break;
					}
					train.push(car);
					trainLength += car.length;
				}
				if (train.length) {
					// Cars stand whichever way they were last left, and the drawing reads that rather than guessing.
					for (var fi = 0; fi < train.length; fi++) {
						train[fi].facing = rng() < 0.5 ? -1 : 1;
					}
					track.trains.push(train);
					remaining -= trainLength;
				}
			}
			tracks.push(track);
		}
		if (!hasLoco) {
			for (var ti = 0; ti < tracks.length; ti++) {
				if (ti === clearTrackIndex) continue;
				var locoKey = this.randomChoice(rng, this.locomotiveKeys);
				var fallbackLoco = this.createLocomotiveCar(locoKey);
				if (this.getTrackOccupiedLength(tracks[ti]) + fallbackLoco.length <= tracks[ti].length) {
					tracks[ti].trains.unshift([fallbackLoco]);
					hasLoco = true;
					break;
				}
			}
		}
		return tracks;
	},
	// Builds a full station layout (entry + generated yard + exit), with a fixed tutorial station at id 1.
	generateStationTracks: function(stationId, baseSeed) {
		if (stationId === 1) {
			// Station 1 is a fixed layout that teaches shunting by making the player do it: the locomotive stands on
			// a short stub, and a flatcar sits on the through track between it and the way out. Getting out of the
			// station means driving across to the flatcar, coupling to it, and only then leaving.
			var tutorialLoco = this.createLocomotiveCar('dieselShunter');
			tutorialLoco.cargo = [{ type: 'diesel', amount: 400 }];
			tutorialLoco.inventory = setup.items.createStartingKit();
			tutorialLoco.facing = 1;
			var tutorialFlatcar = this.cloneCar(State.variables.defaultTrains.flatcar);
			tutorialFlatcar.cargo = [{ type: 'timber', amount: 400, grade: 80 }];
			tutorialFlatcar.facing = 1;
			return [
				// The Southbound boundary track is finite: it is a real connected stub, not a disconnected yard road.
				// Its buffer is at the outer end and its inner end joins the entry ladder, making it the tutorial run-around.
				{ length: 80, trains: [], direction: 'south', leadTrack: 1 },
				{ length: 140, trains: [[tutorialLoco]] },
				{ length: 140, trains: [] },
				{ length: 999999, infinite: true, trains: [[tutorialFlatcar]], direction: this.getLegHeading(1, baseSeed) }
			];
		}
		if (setup.worldmap.isBranchStation(stationId)) {
			return this.generateBranchTerminus(stationId, baseSeed);
		}
		// The yard's shape is settled first: how many tracks it has, which track each lead runs along, and how
		// long its longest track is. Every other length follows from that geometry, so no track is drawn at a
		// length its switches could not give it.
		var shapeRng = this.mulberry32(this.seedFromString(baseSeed + stationId + ':shape'));
		var yardCount = this.randomInt(shapeRng, this.MIN_GENERATED_YARD_TRACKS, this.MAX_GENERATED_YARD_TRACKS);
		var entryRow = this.randomInt(shapeRng, 1, yardCount);
		var exitRow = this.randomInt(shapeRng, 1, yardCount);
		// With at most five tracks the geometry never needs more than the cap, so the yard stays inside it.
		var lengths = this.getYardTrackLengths(yardCount, entryRow, exitRow,
			this.randomInt(shapeRng, this.MIN_GENERATED_TRACK_METRES, this.MAX_GENERATED_TRACK_METRES));
		// Sidings: a stub off one ladder, closed at the other end, which is how most small yards are actually
		// arranged. They never sit on a lead's own line, because that line has to carry the ladder through.
		var closures = [];
		var throughRows = yardCount;
		for (var row = 1; row <= yardCount; row++) {
			// A lead's own line can be a stub too, which is how a yard ends up with a siding trailing off the
			// northbound or southbound track itself. What the yard cannot do is close every track: something has to
			// run from one lead to the other, or a train could never cross the station.
			if (shapeRng() >= this.SIDING_CHANCE || throughRows <= 1 || (row === entryRow && row === exitRow)) {
				continue;
			}
			throughRows--;
			// Which ladder the stub hangs from: closed toward the exit it trails from the entry ladder, and closed
			// toward the entry it hangs off the exit ladder at the far end of the yard. Either way it is a stub, so
			// it is shorter than the through tracks around it.
			closures[row] = shapeRng() < 0.5 ? 'exit' : 'entry';
			lengths[row - 1] = Math.max(80, Math.round(lengths[row - 1] * (0.4 + 0.3 * shapeRng()) / 10) * 10);
		}
		var clearRow = lengths.findIndex(function(_, index) { return !closures[index + 1]; });
		var reserveRow = clearRow === 0 ? 1 : 0;
		var generationLengths = lengths.slice();
		generationLengths[reserveRow] -= 9;
		var yardTracks = this.generateRailyardTracks(baseSeed + stationId, generationLengths, clearRow);
		yardTracks[reserveRow].length = lengths[reserveRow];
		for (var closed = 1; closed <= yardCount; closed++) {
			if (closures[closed] === 'exit') {
				yardTracks[closed - 1].connectsToExit = false;
			} else if (closures[closed] === 'entry') {
				yardTracks[closed - 1].connectsToEntry = false;
			}
		}
		var tracks = [{ length: 999999, infinite: true, trains: [] }]
			.concat(yardTracks)
			.concat([{ length: 999999, infinite: true, trains: [] }]);
		tracks[0].leadTrack = entryRow;
		tracks[tracks.length - 1].leadTrack = exitRow;
		// Each lead is named for where it points: ahead along the next leg, and back down the one just travelled.
		tracks[0].direction = this.oppositeDirection(this.getLegHeading(stationId - 1, baseSeed));
		tracks[tracks.length - 1].direction = this.getLegHeading(stationId, baseSeed);
		setup.yardGeneration.reserve(tracks, stationId, baseSeed);
		this.addDerelict(tracks, shapeRng);
		setup.yardGeneration.validate(tracks);
		return tracks;
	},
	// A station must not strand a player who arrived with an empty tank.  Keep enough usable diesel on one
	// locomotive to run the next leg plus a five-percent margin; this is calculated from the same travel clock
	// that burns fuel, rather than from a fixed distance guess.
	// The end of a branch: a couple of short roads and one way out, the way the train came in. Shunting here is
	// the whole point of the place, so it gets no second lead to escape through.
	generateBranchTerminus: function(stationId, baseSeed) {
		var branch = setup.worldmap.getBranchForStation(baseSeed, stationId);
		var rng = this.mulberry32(this.seedFromString(baseSeed + stationId + ':terminus'));
		var yardCount = this.randomInt(rng, 2, 3);
		var lengths = [];
		for (var row = 0; row < yardCount; row++) {
			lengths.push(this.randomInt(rng, 8, 18) * 10);
		}
		var generationLengths = lengths.slice();
		generationLengths[1] -= 9;
		var yardTracks = this.generateRailyardTracks(baseSeed + stationId, generationLengths, 0);
		yardTracks[1].length = lengths[1];
		var tracks = [{ length: 999999, infinite: true, trains: [] }]
			.concat(yardTracks)
			.concat([{ length: 999999, infinite: true, trains: [], hasLead: false }]);
		tracks[0].leadTrack = 1;
		tracks[tracks.length - 1].leadTrack = yardCount;
		// The way in is the way the branch runs, so the lead is named for the direction a train leaves by.
		var last = branch && branch.tiles.length ? branch.tiles[branch.tiles.length - 1] : null;
		var back = last && last.ends.length ? last.ends[0] : 0;
		// Preserve all eight headings, including the diagonal route back to the junction.
		var heading = setup.worldmap.DIRECTIONS[back].name;
		var cardinal = { n: 'north', ne: 'northeast', nw: 'northwest', s: 'south', se: 'southeast', sw: 'southwest', e: 'east', w: 'west' };
		tracks[0].direction = cardinal[heading] || 'north';
		setup.yardGeneration.reserve(tracks, stationId, baseSeed);
		setup.yardGeneration.validate(tracks);
		return tracks;
	},
	// Chooses the preferred car index to board when entering a train (locomotive first, then interior car).
	getBoardingCarIndex: function(train) {
		for (var i = 0; i < train.length; i++) {
			if (train[i].tractiveCapacity > 0) {
				return i;
			}
		}
		for (var j = 0; j < train.length; j++) {
			if (train[j].hasInterior) {
				return j;
			}
		}
		return 0;
	},
	// Returns a grammatically correct location string for the current car.
	getCarLocationText: function(car) {
		return (car.hasInterior ? 'in the ' : 'on the ') + (car.broken ? 'broken ' : '') + (car.name || car.type);
	},
	// Serializes car type names for compact consist labels.
	getTrainCarListText: function(train) {
		var names = [];
		for (var i = 0; i < train.length; i++) {
			names.push(train[i].type);
		}
		return names.join(', ');
	},
	// Computes global train display numbering across all tracks, accounting for the player's removed train gap.
	getTrainDisplayNumber: function(stationTracks, trackIndex, trainIndex) {
		if (!stationTracks || !stationTracks.length) {
			return 0;
		}
		var playerTrackIndex = arguments[3];
		var enteredTrainIndex = arguments[4];
		var number = 1;
		var playerTrainAlreadyAdded = false;
		for (var i = 0; i < stationTracks.length; i++) {
			var track = stationTracks[i];
			if (!track || !track.trains) {
				continue;
			}
			for (var j = 0; j < track.trains.length; j++) {
				// If we're on the player's track and we've reached the gap position, count the player's removed train
				if (i === playerTrackIndex && !playerTrainAlreadyAdded && j === enteredTrainIndex) {
					number++;
					playerTrainAlreadyAdded = true;
				}
				if (i === trackIndex && j === trainIndex) {
					return number;
				}
				number++;
			}
			if (i === playerTrackIndex && !playerTrainAlreadyAdded) {
				number++;
				playerTrainAlreadyAdded = true;
			}
		}
		return 0;
	},
	// Provides default player gap index based on boundary/yard track semantics.
	getDefaultEnteredTrainIndex: function(stationTracks, trackIndex) {
		if (!stationTracks || !stationTracks.length) {
			return 0;
		}
		var safeTrackIndex = this.safeTrackIndex(trackIndex, stationTracks.length - 1);
		var track = stationTracks[safeTrackIndex];
		if (!track || !track.trains) {
			return 0;
		}
		var entryIndex = this.getEntryTrackIndex();
		var exitIndex = this.getExitTrackIndex(stationTracks);
		if (safeTrackIndex === entryIndex) {
			return track.trains.length;
		}
		if (safeTrackIndex === exitIndex) {
			return 0;
		}
		return 0;
	},
	// Builds the visible station inventory: track headers, train summaries, and boarding links.
	getCarDescription: function(car) {
		if (!car) {
			return 'Unknown railcar';
		}
		if (car.name) {
			return (car.broken ? 'Broken ' : '') + car.name.replace(/\b\w/g, function(letter) { return letter.toUpperCase(); });
		}
		var names = {
			boxcar: 'Boxcar', flatcar: 'Flatcar', gondola: 'Gondola', 'tanker car': 'Tank car',
			'passenger coach': 'Passenger coach', 'sleeper coach': 'Sleeper passenger coach',
			'observation car': 'Passenger observation car', 'kitchen car': 'Passenger kitchen car',
			'private car': 'Private rail car'
		};
		return (car.broken ? 'Broken ' : '') + (names[car.type] || String(car.type || 'Railcar').replace(/\b\w/g, function(letter) { return letter.toUpperCase(); }));
	},
	trainSummaryHtml: function(train, index) {
		var trainLength = this.getTrainLength(train);
		var html = '<div class="railyard-train">';
		html += '<h3>Train ' + (index + 1) + ' · ' + trainLength + ' m</h3>';
		html += '<p>' + train.slice(0, 2).map(function(car) { return setup.railyard.getCarDescription(car); }).join(', ')
			+ (train.length > 2 ? ' and ' + (train.length - 2) + ' more' : '') + '.</p>';
		html += '<details class="loco-panel"><summary>Car details (' + train.length + ')</summary><div class="loco-stats">';
		html += '<ol>';
		for (var j = 0; j < train.length; j++) {
			var car = train[j];
			html += '<li><strong>' + this.getCarDescription(car) + '</strong> — ' + car.length + ' m long; ' + car.baseWeight + ' kg empty';
			if (car.maxCargoCapacityKg > 0) {
				html += '; ' + car.maxCargoCapacityKg + ' kg cargo capacity';
			}
			html += '.';
			if (this.isTrainVisited(train) && car.cargo && car.cargo.length) {
				html += '<ul>';
				for (var k = 0; k < car.cargo.length; k++) {
					var cargo = car.cargo[k];
					html += '<li>' + String(cargo.type).replace(/\b\w/g, function(letter) { return letter.toUpperCase(); }) + ': ' + cargo.amount + '.</li>';
				}
				html += '</ul>';
			} else if (this.isTrainVisited(train)) {
				html += ' Empty.';
			}
			html += '</li>';
		}
		html += '</ol></div></details>';
		html += '</div>';
		return html;
	}
};
// Presents the current station as a browseable list of tracks and trains, and lets the player board one.
Macro.add('railyardButtons', {
	handler: function() {
		// Count trains up front so the station header can summarize how busy the yard is before listing details.
		var tracks = State.variables.stationTracks[State.variables.currentStation];
		var totalTrains = 0;
		var trackCount = 0;
		for (var t = 0; t < tracks.length; t++) {
			totalTrains += tracks[t].trains.length;
			trackCount += setup.railyard.trackExists(tracks, t) ? 1 : 0;
		}
		var output = '<h2>Station ' + State.variables.currentStation + '</h2>';
		output += '<p>There ' + (totalTrains === 1 ? 'is ' : 'are ') + totalTrains + ' train' + (totalTrains === 1 ? '' : 's') + ' staged across ' + trackCount + ' track' + (trackCount === 1 ? '' : 's') + '.</p>';
		var displayNumber = 1;
		// Each track is rendered independently so empty tracks, finite length, and train numbering stay readable.
		for (var i = 0; i < tracks.length; i++) {
			if (!setup.railyard.trackExists(tracks, i)) {
				continue;
			}
			var occupied = setup.railyard.getTrackOccupiedLength(tracks[i]);
			var remaining = tracks[i].infinite ? 'infinite' : Math.max(0, tracks[i].length - occupied) + 'm';
			var trackLabel = setup.railyard.getTrackLabel(tracks, i);
			var deadEndText = setup.railyard.isYardTrackIndex(tracks, i) ? setup.railyard.getDeadEndText(tracks, i) : '';
			output += '<h3>' + trackLabel + '</h3><p class="small-description">' + (tracks[i].infinite ? 'Infinite' : tracks[i].length + 'm') + ' long, ' + remaining + ' free' + (deadEndText ? ', ' + deadEndText : '') + '.</p>';
			if (!tracks[i].trains.length) {
				continue;
			}
			// Boarding removes the selected train from the yard and turns it into the player's active consist.
			for (var j = 0; j < tracks[i].trains.length; j++) {
				output += setup.railyard.trainSummaryHtml(tracks[i].trains[j], displayNumber - 1);
				output += '<span data-yard-action="board:' + i + ':' + j + '">'
					+ '<<timedlink "Board Train ' + displayNumber + '" 1>><<run setup.railyard.boardTrain($currentStation, ' + i + ', ' + j + ')>><<goto "TrainInterior">><</timedlink>></span><br>';
				displayNumber++;
			}
		}
		new Wikifier(this.output, output);
	}
});
// Builds the full shunting UI from the player's current gap: cross-track moves, coupling, and push options.
Macro.add('drivingMergeButtons', {
	handler: function() {
		var options = setup.yardActions.options();
		options.forEach(function(option) { setup.yardActions.append(this.output, option); }, this);
		options.reasons.forEach(function(item) {
			var span = document.createElement('span');
			span.className = 'yard-reason';
			span.setAttribute('data-yard-reason', item.key);
			span.textContent = item.reason;
			this.output.appendChild(span);
		}, this);
	}
});
// Says where the consist stands on the line: how far along the leg, on what ground, and facing what grade.
Macro.add('lineStatus', {
	handler: function() {
		var view = setup.worldmap.getJourneyView();
		if (!view) {
			new Wikifier(this.output, '<p><em>You are not out on the line.</em></p>');
			return;
		}
		var grade = view.grade;
		var slope = grade > 0 ? 'climbing ' + grade.toFixed(1) + '%'
			: grade < 0 ? 'descending ' + Math.abs(grade).toFixed(1) + '%' : 'level';
		var output = '<h2>On the line</h2>';
		if (view.realWorld) output += '<p><strong>' + setup.realWorldPilot.getCorridor(view.corridorId).label + '</strong></p>';
		output += '<p>Tile ' + (Math.min(view.tileIndex, view.tileCount - 1) + 1) + ' of ' + view.tileCount
			+ ' &middot; ' + view.terrain + ' &middot; ' + slope + '</p>';
		output += '<p class="small-description">' + (view.branch
			? setup.units.kilometres(view.kilometresDone) + ' from the junction.'
			: setup.units.kilometres(view.kilometresDone) + ' behind you, ' + setup.units.kilometres(view.kilometresLeft) + ' to run.') + '</p>';
		if (view.realWorld && State.variables.debugMode) output += '<p class="small-description">Mean elevation '
			+ view.tile.elevation.toFixed(1) + ' m &middot; within-tile relief &sigma; '
			+ view.tile.elevationStdDevM.toFixed(1) + ' m.</p>';
		output += setup.railyard.getFuelReadout(State.variables.currentTrain);
		new Wikifier(this.output, output);
	}
});
// The moves available on the line: one 5 km tile at a time, onward or back the way you came.
Macro.add('lineControls', {
	handler: function() {
		var view = setup.worldmap.getJourneyView();
		if (!view) {
			return;
		}
		var output = '';
		// On a station's own tile the yard is right there, so backing in ends the journey at no cost. It is also
		// the way out for a consist that cannot move at all, which is why it is offered before anything else.
		var escapeLink = '';
		var realEndpoint = setup.realWorldPilot.endpointForView(view);
		if (realEndpoint) {
			escapeLink = '<<link "Leave the sourced route at ' + realEndpoint.name + '">>'
				+ '<<run setup.realWorldPilot.finish()>><<goto "TrainInterior">><</link>><br>';
		} else if (!view.realWorld && !setup.worldmap.getJourneyStep(-1)) {
			var backStation = view.forward ? view.legIndex : view.legIndex + 1;
			escapeLink = '<<link "Back into Station ' + backStation + '">>'
				+ '<<run setup.railyard.arriveAtStation(' + backStation + ', ' + (!view.forward) + ')>>'
				+ '<<goto "DrivingMode">><</link>><br>';
		}
		if (!setup.railyard.isTrainDriveCapable(State.variables.currentTrain)) {
			output += '<p class="small-description"><em>Your train cannot move: it has no diesel or steam pressure. '
				+ 'Enter the train and work the firebox.</em></p>';
			output += escapeLink;
			output += '<<link "Enter the train">><<goto "TrainInterior">><</link>><br>';
			new Wikifier(this.output, output);
			return;
		}
		[1, -1].forEach(function(direction) {
			var step = setup.worldmap.getJourneyStep(direction);
			if (!step) {
				return;
			}
			var stepDistance = step.distanceKm || setup.worldmap.TILE_KM;
			var label = (direction > 0 ? 'Drive ' : 'Reverse ') + setup.units.kilometres(stepDistance)
				+ ' ' + (step.heading || 'on');
			var slope = step.grade > 0 ? 'climbs ' + step.grade.toFixed(1) + '%'
				: step.grade < 0 ? 'falls ' + Math.abs(step.grade).toFixed(1) + '%' : 'runs level';
			if (step.blocked) {
				return;
			}
			// Arriving ends the journey, so the link lands back in the yard rather than on the line.
			output += '<<timedlink "' + label + '" ' + step.minutes + ' "travel">>'
				+ '<<run setup.railyard.moveAlongLine(' + direction + ')>>'
				+ '<<set _linePassage = State.variables.journey ? "OnTheLine" : "DrivingMode">>'
				+ '<<goto _linePassage>><</timedlink>><br>';
			output += '<span class="small-description">Into ' + step.terrain + ', ' + slope
				+ (step.destinationName ? ', reaching ' + step.destinationName : '')
				+ (step.arrivesAt ? ', arriving at Station ' + step.arrivesAt : '') + '.</span><br>';
		});
		// At a junction the player knows only which way the rails immediately run. Whether a track reconnects or
		// ends is deliberately not exposed: there is no map to consult out here.
		setup.worldmap.getBranchChoices().forEach(function(choice) {
			var step = setup.worldmap.getBranchStep(choice.id);
			if (!step) {
				return;
			}
			var label = 'Drive ' + setup.units.kilometres(setup.worldmap.TILE_KM) + ' ' + choice.direction;
			if (step.blocked) {
				return;
			}
			output += '<<timedlink "' + label + '" ' + step.minutes + ' "travel">>'
				+ '<<run setup.railyard.takeBranch("' + choice.id + '")>><<goto "OnTheLine">><</timedlink>><br>';
			output += '<span class="small-description">A track leads ' + choice.direction + ' into '
				+ choice.terrain + '.</span><br>';
		});
		output += escapeLink;
		output += '<<link "Enter the train">><<goto "TrainInterior">><</link>><br>';
		new Wikifier(this.output, output);
	}
});
// Ensures driving mode always has a valid station, track, and player gap before any driving UI renders.
Macro.add('initDrivingModeState', {
	handler: function() {
		State.variables.currentStation = State.variables.currentStation || 1;
		if (typeof State.variables.stationTracks[State.variables.currentStation] === 'undefined') {
			State.variables.stationTracks[State.variables.currentStation] = setup.railyard.generateStationTracks(State.variables.currentStation, State.variables.randomSeed);
		}
		if (typeof State.variables.drivingTrackIndex === 'undefined') {
			if (typeof State.variables.enteredTrackIndex !== 'undefined' && State.variables.enteredStation === State.variables.currentStation) {
				State.variables.drivingTrackIndex = State.variables.enteredTrackIndex;
			} else {
				State.variables.drivingTrackIndex = setup.railyard.getEntryTrackIndex();
			}
		}
		var stationTracks = State.variables.stationTracks[State.variables.currentStation];
		if (Array.isArray(stationTracks) && stationTracks.length) {
			var existingTrackIndex = setup.railyard.getNearestExistingTrackIndex(stationTracks, State.variables.drivingTrackIndex);
			if (existingTrackIndex !== setup.railyard.safeTrackIndex(State.variables.drivingTrackIndex, stationTracks.length - 1)) {
				// The station has no track where the player was (an entry or exit track that was taken away).
				State.variables.drivingTrackIndex = existingTrackIndex;
				delete State.variables.enteredTrainIndex;
			}
		}
		if (typeof State.variables.enteredTrainIndex === 'undefined') {
			State.variables.enteredTrainIndex = setup.railyard.getDefaultEnteredTrainIndex(
				State.variables.stationTracks[State.variables.currentStation],
				State.variables.drivingTrackIndex
			);
		}
	}
});
// Renders inter-station travel controls and explains why departure is blocked when the yard state forbids it.
Macro.add('drivingTravelButtons', {
	handler: function() {
		if (!setup.railyard.isTrainDriveCapable(State.variables.currentTrain)) {
			return;
		}
		var stationId = State.variables.currentStation;
		var tracks = State.variables.stationTracks[stationId];
		if (!Array.isArray(tracks) || !tracks.length) {
			return;
		}
		var trackIndex = State.variables.drivingTrackIndex;
		var output = '';
		if (setup.worldmap.isBranchStation(stationId)) {
			var terminus = setup.worldmap.getBranchForStation(setup.worldmap.getSeed(), stationId);
			var terminusReason = setup.railyard.getDepartureBlockReason(stationId, trackIndex, false);
			var terminusHeading = setup.railyard.getDirectionName(setup.railyard.getLeadDirection(tracks, 'entry'));
			var terminusLabel = 'Depart ' + terminusHeading;
			if (terminusReason) {
				output += '<span class="yard-reason" data-yard-reason="depart:entry"><em>' + terminusLabel
					+ ' unavailable: ' + terminusReason + '</em></span>';
			} else {
				output += '<span data-yard-action="depart:entry"><<link "' + terminusLabel + '">>'
					+ '<<run setup.railyard.departOntoLine(false)>><<goto "OnTheLine">><</link>></span><br>';
				output += '<span class="small-description">'
					+ 'the only track back from this station.</span><br>';
			}
			new Wikifier(this.output, output);
			return;
		}
		[false, true].forEach(function(towardExit) {
			if (!towardExit && stationId <= 1) return;
			// Travelling reads as the heading the lead track is named for, not as next and previous.
			var heading = setup.railyard.getDirectionName(setup.railyard.getLeadDirection(tracks, towardExit ? 'exit' : 'entry'));
			var label = 'Depart ' + heading + ' toward Station ' + (stationId + (towardExit ? 1 : -1));
			// The leg is a run of 5 km world tiles: climbing one costs more time, and so more fuel, than rolling
			// along a flat one, and a heavy consist is slower over all of them.
			var minutes = setup.worldmap.getTravelMinutes(stationId, towardExit, State.variables.currentTrain);
			var summary = setup.worldmap.getTravelSummary(stationId, towardExit, State.variables.currentTrain);
			var reason = setup.railyard.getDepartureBlockReason(stationId, trackIndex, towardExit);
			if (reason) {
				output += '<span class="yard-reason" data-yard-reason="depart:' + (towardExit ? 'exit' : 'entry') + '">'
					+ '<em>' + label + ' unavailable: ' + reason + '</em></span>';
			} else {
				// Departing costs nothing by itself: the time and the fuel are spent tile by tile out on the line.
				output += '<span data-yard-action="depart:' + (towardExit ? 'exit' : 'entry') + '">'
					+ '<<link "Depart ' + heading + ' toward Station ' + (stationId + (towardExit ? 1 : -1)) + '">>'
					+ '<<if setup.tutorial.requestExit(' + towardExit + ')>><<run setup.railyard.departOntoLine(' + towardExit + ')>><<goto "OnTheLine">><</if>><</link>></span><br>';
				output += '<span class="small-description">' + summary + ' About ' + setup.time.formatDuration(minutes) + ' at this weight.</span><br>';
			}
		});
		new Wikifier(this.output, output);
	}
});
// Lets the player split their current consist around the occupied car/gap and leave each section on the track layout.
// Where the consist stands, which way it faces, and what it has left to burn.
Macro.add('drivingStatus', {
	handler: function() {
		var variables = State.variables;
		var tracks = variables.stationTracks ? variables.stationTracks[variables.currentStation] : null;
		if (!Array.isArray(tracks) || !Array.isArray(variables.currentTrain) || !variables.currentTrain.length) {
			return;
		}
		var trackIndex = Math.max(0, Math.min(setup.safeParseInt(variables.drivingTrackIndex, 0), tracks.length - 1));
		var reverse = variables.travellingForward === false;
		var fromLabel = setup.railyard.getTrackLabel(tracks, reverse ? tracks.length - 1 : 0);
		var output = '<h3>Shunting</h3>';
		output += '<p><strong>Current track:</strong> ' + setup.railyard.getTrackLabel(tracks, trackIndex) + '</p>';
		output += '<p><strong>Direction:</strong> ' + (reverse ? 'Reversing from the ' : 'Forward from the ') + fromLabel + ' side</p>';
		output += '<p><strong>Current consist:</strong> ' + setup.railyard.getTrainCarListText(variables.currentTrain) + '</p>';
		output += setup.railyard.getFuelReadout(variables.currentTrain);
		new Wikifier(this.output, output);
	}
});
Macro.add('drivingShuntingControls', {
	handler: function() {
		[true, false].forEach(function(front) {
			var command = { kind: 'decouple', front: front };
			var plan = setup.yardActions.plan(command);
			if (!plan.ok) return;
			var section = setup.railyard.getDecoupleSection(front);
			setup.yardActions.append(this.output, { command: command, plan: plan,
				key: 'decouple:' + (front ? 'front' : 'rear'),
				label: 'Decouple the ' + (front ? 'front' : 'rear') + ' section (' + section.length + ' car' + (section.length === 1 ? '' : 's') + ')' });
		}, this);
	}
});
// Debug tools are passage-aware: each passage gets only the controls that make sense for its current state.
Macro.add('debugTools', {
	handler: function() {
		if (!State.variables.debugMode) return;
		// This wrapper keeps all debug DOM isolated from story markup and makes it easy to rebuild on passage refresh.
		var currentPassage = State.passage;
		var panel = document.createElement('div');
		panel.className = 'debug-container';
		this.output.appendChild(panel);
		var reportButton = document.createElement('button');
		reportButton.className = 'saves-button';
		reportButton.textContent = 'Copy bug report';
		reportButton.addEventListener('click', function() { setup.bugReport.show(); });
		panel.appendChild(reportButton);
		// Running a debug tool replays the passage. Without this the page would jump back to the top every time,
		// which makes the tools unusable at the bottom of a long yard.
		setup.debugReturnToPanel = false;
		// Everything written from here lands in the section opened last, so each block of tools carries its own
		// heading and can be folded out of the way. wrapper is reassigned rather than replaced so the many
		// appendChild calls below need no rewriting.
		var wrapper = panel;
		var startSection = function (title, open) {
			var section = document.createElement('details');
			section.className = 'debug-section';
			section.open = !!open;
			var summary = document.createElement('summary');
			summary.textContent = title;
			section.appendChild(summary);
			var body = document.createElement('div');
			body.className = 'debug-body';
			section.appendChild(body);
			panel.appendChild(section);
			wrapper = body;
			return body;
		};
		var wiki = function (markup) {
			jQuery(wrapper).wiki(markup);
		};
		// Cargo helpers centralize weight/volume math so every debug cargo editor uses the same capacity rules.
		var getCurrentCargoLoad = function (car) {
			var weightUsed = 0, volumeUsed = 0;
			for (var ci = 0; ci < car.cargo.length; ci++) {
				var cd = (State.variables.cargoTypes[car.cargo[ci].type] || { density: 1 }).density;
				weightUsed += car.cargo[ci].amount * cd; // liters * kg/L = kg
				volumeUsed += car.cargo[ci].amount;      // already in liters
			}
			return { weightUsed: weightUsed, volumeUsed: volumeUsed };
		};
		var getMaxAmountForCargo = function (car, cargoType) {
			var limits = getCapacityLimitsForCargo(car, cargoType);
			return limits.max;
		};
		var getCapacityLimitsForCargo = function (car, cargoType) {
			var load = getCurrentCargoLoad(car);
			var density = (State.variables.cargoTypes[cargoType] || { density: 1 }).density;
			var remainingWeightKg = car.maxCargoCapacityKg > 0
				? Math.max(0, car.maxCargoCapacityKg - load.weightUsed)
				: 999999;
			var remainingVolumeL = car.maxCargoCapacityVolume > 0
				? Math.max(0, car.maxCargoCapacityVolume - load.volumeUsed)
				: 999999;
			var maxByWeightL = Math.floor(remainingWeightKg / density);
			var maxByVolumeL = Math.floor(remainingVolumeL);
			// Allowed amount is the lesser of the selected cargo's weight-limited and volume-limited space.
			return {
				weight: Math.max(0, maxByWeightL),
				volume: Math.max(0, maxByVolumeL),
				max: Math.max(0, Math.min(maxByWeightL, maxByVolumeL))
			};
		};
		// Builds an interactive cargo editor for the selected car, including dynamic capacity limits and validation.
		var buildAddCargoSection = function (car) {
			if (!car || !car.acceptedCargo || !car.acceptedCargo.length) return;
			var acceptedTypes = setup.railyard.getAcceptedCargoTypes(car);
			if (!acceptedTypes.length) return;
			var h4 = document.createElement('h4');
			h4.textContent = 'Add Cargo';
			wrapper.appendChild(h4);
			var typeLabel = document.createElement('label');
			typeLabel.textContent = 'Type: ';
			var typeSelect = document.createElement('select');
			for (var aci = 0; aci < acceptedTypes.length; aci++) {
				var ct = acceptedTypes[aci];
				var ctOpt = document.createElement('option');
				ctOpt.value = ct;
				ctOpt.textContent = ct;
				typeSelect.appendChild(ctOpt);
			}
			typeLabel.appendChild(typeSelect);
			wrapper.appendChild(typeLabel);
			var qtyLabel = document.createElement('label');
			qtyLabel.textContent = ' Amount: ';
			var qtyInput = document.createElement('input');
			qtyInput.type = 'number';
			qtyInput.id = 'debugCargoAmount';
			qtyInput.min = '1';
			var initLimits = typeSelect.value ? getCapacityLimitsForCargo(car, typeSelect.value) : { weight: 0, volume: 0, max: 0 };
			var initMax = initLimits.max;
			qtyInput.max = String(initMax);
			qtyInput.value = String(Math.min(1, initMax));
			qtyInput.style.width = '80px';
			var maxSpan = document.createElement('span');
			maxSpan.textContent = ' (max: ' + initMax + ')';
			var breakdown = document.createElement('div');
			breakdown.style.fontSize = '0.9em';
			breakdown.style.opacity = '0.9';
			breakdown.textContent = 'Weight limit: ' + initLimits.weight + 'L | Volume limit: ' + initLimits.volume + 'L | Applied max: ' + initLimits.max + 'L';
			typeSelect.addEventListener('change', function () {
				var limits = getCapacityLimitsForCargo(car, this.value);
				var newMax = limits.max;
				qtyInput.max = String(newMax);
				maxSpan.textContent = ' (max: ' + newMax + ')';
				breakdown.textContent = 'Weight limit: ' + limits.weight + 'L | Volume limit: ' + limits.volume + 'L | Applied max: ' + limits.max + 'L';
				if (parseInt(qtyInput.value, 10) > newMax) {
					qtyInput.value = String(Math.max(0, newMax));
				}
			});
			qtyLabel.appendChild(qtyInput);
			wrapper.appendChild(qtyLabel);
			var gradeLabel = document.createElement('label');
			gradeLabel.textContent = ' Grade: ';
			var gradeInput = document.createElement('input');
			gradeInput.type = 'number';
			gradeInput.id = 'debugCargoGrade';
			gradeInput.min = '0';
			gradeInput.max = '100';
			gradeInput.value = '100';
			gradeInput.style.width = '60px';
			gradeInput.title = 'Only diesel, coal, firewood and timber have a grade.';
			gradeLabel.appendChild(gradeInput);
			wrapper.appendChild(gradeLabel);
			wrapper.appendChild(maxSpan);
			wrapper.appendChild(document.createElement('br'));
			wrapper.appendChild(breakdown);
			wrapper.appendChild(document.createElement('br'));
			var addBtn = document.createElement('button');
			addBtn.textContent = 'Add Cargo';
			addBtn.addEventListener('click', function () {
				var cargoType = typeSelect.value;
				var amount = parseInt(qtyInput.value, 10);
				if (!cargoType || isNaN(amount) || amount <= 0) return;
				var maxNow = getMaxAmountForCargo(car, cargoType);
				if (amount > maxNow) amount = maxNow;
				if (amount <= 0) return;
				var grade = parseInt(gradeInput.value, 10);
				setup.fuel.addCargo(car, cargoType, amount, isNaN(grade) ? 100 : grade);
				setup.debugReturnToPanel = true; Engine.play(State.passage);
			});
			wrapper.appendChild(addBtn);
			wrapper.appendChild(document.createElement('br'));
		};
		// The panel's own heading, then a line of what this session is: passage, seed, build.
		var heading = document.createElement('h3');
		heading.className = 'debug-heading';
		heading.textContent = 'Debug tools';
		panel.appendChild(heading);
		var status = document.createElement('p');
		status.className = 'debug-status';
		var seedValue = typeof State.variables.randomSeed !== 'undefined' ? String(State.variables.randomSeed) : 'not set';
		var cachedBuild = setup.readCachedBuildMeta ? setup.readCachedBuildMeta() : null;
		var currentBuildChecksum = setup.getBuildChecksum ? setup.getBuildChecksum() : 'unavailable';
		status.textContent = currentPassage + ' \u00b7 seed ' + seedValue + ' \u00b7 v' + (setup.releaseVersion || 'unknown')
			+ ' \u00b7 build ' + currentBuildChecksum.slice(0, 8)
			+ (cachedBuild && cachedBuild.checksum && cachedBuild.checksum !== currentBuildChecksum
				? ' (last played ' + cachedBuild.checksum.slice(0, 8) + ')' : '');
		panel.appendChild(status);
		// A live reference sheet for balancing and debugging. Every value comes straight from the definitions the game
		// is using, so it cannot drift from the train, fuel or pack systems as a separately written wiki would.
		startSection('Reference data');
		wrapper.parentElement.classList.add('procedural-wiki');
		var addReferenceTable = function(title, headings, rows) {
			var block = document.createElement('details');
			block.className = 'debug-section';
			var summary = document.createElement('summary');
			summary.textContent = title;
			block.appendChild(summary);
			var table = document.createElement('table');
			var head = document.createElement('tr');
			headings.forEach(function(text) {
				var cell = document.createElement('th');
				cell.textContent = text;
				head.appendChild(cell);
			});
			table.appendChild(head);
			rows.forEach(function(row) {
				var line = document.createElement('tr');
				row.forEach(function(value) {
					var cell = document.createElement('td');
					cell.textContent = String(value);
					line.appendChild(cell);
				});
				table.appendChild(line);
			});
			block.appendChild(table);
			wrapper.appendChild(block);
		};
		var stock = State.variables.defaultTrains || {};
		addReferenceTable('Railcars', ['Type', 'Length', 'Empty weight', 'Cargo capacity', 'Pull', 'Top speed'],
			Object.keys(stock).map(function(key) {
				var car = stock[key];
				return [car.name || car.type || key, (car.length || 0) + ' m', (car.baseWeight || 0) + ' kg',
					(car.maxCargoCapacityKg || 0) + ' kg / ' + (car.maxCargoCapacityVolume || 0) + ' L',
					(car.tractiveCapacity || 0) + ' kN', (car.topSpeedKmh || 0) + ' km/h'];
			}));
		var cargoTypes = State.variables.cargoTypes || {};
		addReferenceTable('Cargo', ['Cargo', 'Density', 'Rarity', 'Tags'], Object.keys(cargoTypes).map(function(key) {
			var cargo = cargoTypes[key];
			return [key, cargo.density + ' kg/L', cargo.rarity || '', (cargo.tags || []).join(', ')];
		}));
		addReferenceTable('Fuel', ['Rule', 'Value'], [
			['Diesel minimum usable grade', setup.fuel.DIESEL_MIN_GRADE + '%'],
			['Diesel full-power grade', setup.fuel.DIESEL_FULL_POWER_GRADE + '%']
		]);
		var catalogue = (setup.items && setup.items.CATALOGUE) || {};
		addReferenceTable('Pack items', ['Item', 'Grid', 'Weight', 'Stack limit'], Object.keys(catalogue).map(function(key) {
			var item = catalogue[key];
			return [item.name || key, (item.width || 1) + ' × ' + (item.height || 1), (item.weightKg || 0) + ' kg', item.stack || 1];
		}));
		addReferenceTable('Food preparation', ['Rule', 'Value'], [
			['Raw portion', setup.food.PORTION_KG + ' kg / +' + setup.food.RAW_HUNGER + ' Hunger'],
			['Recipe input', setup.food.RECIPE_PORTIONS * setup.food.PORTION_KG + ' kg food'],
			['Basic yield', setup.food.BASIC_YIELD + ' rations'], ['Intact kitchen yield', setup.food.KITCHEN_YIELD + ' rations'],
			['Ration', '+' + setup.condition.RATION_HUNGER + ' Hunger']
		]);
		addReferenceTable('Station depots', ['Resource', 'Initial volume'], Object.keys(setup.recovery.INITIAL_STOCK).map(function(type) {
			return [type, setup.recovery.INITIAL_STOCK[type] + ' L'];
		}));
		addReferenceTable('Broken stock', ['Stock', 'Probability'], [
			['Passenger', setup.yardGeneration.BROKEN_PASSENGER_CHANCE * 100 + '%'],
			['Other generated stock', setup.yardGeneration.BROKEN_FREIGHT_CHANCE * 100 + '%'], ['Reserved escape engine', '0%']
		]);
		// Time of day drives the lighting of the yard and driving views, so debug can jump the clock to any hour.
		startSection('Clock and light', true);
		var lightInfo = document.createElement('p');
		var debugLight = setup.daylight.getLight();
		lightInfo.textContent = 'Light: ' + debugLight.phase + ', sun ' + debugLight.elevation.toFixed(1) + '\u00b0 at latitude '
			+ setup.daylight.getLatitude().toFixed(1) + '\u00b0. ';
		var hourSelect = document.createElement('select');
		hourSelect.id = 'debugClockHour';
		var clockNow = new Date(setup.time.getCurrentTimestampMs());
		for (var hour = 0; hour < 24; hour++) {
			var hourOption = document.createElement('option');
			hourOption.value = String(hour);
			hourOption.textContent = (hour < 10 ? '0' : '') + hour + ':00';
			hourOption.selected = hour === clockNow.getUTCHours();
			hourSelect.appendChild(hourOption);
		}
		lightInfo.appendChild(hourSelect);
		var hourButton = document.createElement('button');
		hourButton.textContent = 'Set Clock';
		hourButton.addEventListener('click', function() {
			var now = new Date(setup.time.getCurrentTimestampMs());
			setup.time.setCurrentTimestampMs(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), parseInt(hourSelect.value, 10), 0, 0, 0));
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		lightInfo.appendChild(hourButton);
		wrapper.appendChild(lightInfo);
		// The player's condition, for setting a stat straight to a value worth testing against.
		startSection('Condition');
		var conditionLabel = document.createElement('label');
		conditionLabel.textContent = 'Condition: ';
		var conditionSelect = document.createElement('select');
		conditionSelect.id = 'debugConditionSelect';
		setup.stats.LIST.forEach(function (stat) {
			var option = document.createElement('option');
			option.value = stat.key;
			option.textContent = stat.label + ' (' + setup.stats.getValue(stat.key) + ')';
			conditionSelect.appendChild(option);
		});
		var conditionValue = document.createElement('input');
		conditionValue.type = 'number';
		conditionValue.id = 'debugConditionValue';
		conditionValue.min = String(setup.stats.MIN);
		conditionValue.max = String(setup.stats.MAX);
		conditionValue.value = String(setup.stats.getValue(conditionSelect.value || 'fatigue'));
		conditionValue.style.width = '70px';
		conditionSelect.addEventListener('change', function () {
			conditionValue.value = String(setup.stats.getValue(conditionSelect.value));
		});
		var conditionBtn = document.createElement('button');
		conditionBtn.textContent = 'Set Stat';
		conditionBtn.addEventListener('click', function () {
			setup.stats.setValue(conditionSelect.value, conditionValue.value);
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		conditionLabel.appendChild(conditionSelect);
		wrapper.appendChild(conditionLabel);
		wrapper.appendChild(conditionValue);
		wrapper.appendChild(conditionBtn);
		wrapper.appendChild(document.createElement('br'));
		// The generated world between this station and the next, read straight from the seed. Deliberately plain:
		// it is here to check what the generator produced, not to be a player-facing map.
		startSection('World map', true);
		setup.worldmap.appendDebugMap(wrapper, State.variables.currentStation);
		// The worldwide planning chords remain non-navigable. Explicitly authored OSM pilot corridors are offered
		// below the overview and require an active train so the consist and its fuel remain authoritative.
		startSection('Global rail map and pilot');
		setup.worldGraph.appendDebugOverview(wrapper);
		setup.realWorldPilot.appendDebugControls(wrapper);
		// TrainInterior debug mode focuses on cargo editing for the active consist and current car.
		if (currentPassage === 'TrainInterior') {
			startSection('Cargo', true);
			var currentTrain = State.variables.currentTrain;
			if (!currentTrain || !currentTrain.length) {
				wiki('<p><em>No active train available.</em></p>');
				return;
			}
			var currentCarIndex = State.variables.currentCarIndex;
			if (typeof currentCarIndex === 'undefined' || currentCarIndex < 0 || currentCarIndex >= currentTrain.length) {
				currentCarIndex = setup.railyard.getBoardingCarIndex(currentTrain);
				State.variables.currentCarIndex = currentCarIndex;
			}
			var currentCar = currentTrain[currentCarIndex];
			var interiorInfo = document.createElement('p');
			interiorInfo.textContent = 'Current car: ' + currentCar.type + ' (car ' + (currentCarIndex + 1) + ' of ' + currentTrain.length + ')';
			wrapper.appendChild(interiorInfo);
			wiki('<<link "Clear Current Car Cargo">><<run setup.debugReturnToPanel = true>><<run State.variables.currentTrain[State.variables.currentCarIndex].cargo = []>><<goto "TrainInterior">><</link>><br>');
			wiki('<<link "Clear Current Train Cargo">><<run setup.debugReturnToPanel = true>><<run (function() { for (var i = 0; i < State.variables.currentTrain.length; i++) { State.variables.currentTrain[i].cargo = []; } })()>><<goto "TrainInterior">><</link>><br>');
			buildAddCargoSection(currentCar);
			return;
		}
		// DrivingMode debug output is intentionally read-only for now so shunting logic is not bypassed accidentally.
		if (currentPassage === 'DrivingMode') {
			startSection('Consist', true);
			var drivingTrain = State.variables.currentTrain;
			var drivingInfo = document.createElement('p');
			drivingInfo.textContent = 'Driving track: ' + (typeof State.variables.drivingTrackIndex !== 'undefined' ? setup.railyard.getTrackLabel(State.variables.stationTracks[State.variables.currentStation] || [], State.variables.drivingTrackIndex) : 'unknown');
			wrapper.appendChild(drivingInfo);
			if (drivingTrain && drivingTrain.length) {
				var consistInfo = document.createElement('p');
				consistInfo.textContent = 'Current consist: ' + setup.railyard.getTrainCarListText(drivingTrain);
				wrapper.appendChild(consistInfo);
			}
			return;
		}
		// The railyard debug panel is the full editor: selection, deletion, cargo editing, swapping, and track management.
		if (currentPassage !== 'Railyard') {
			startSection('Yard', true);
			wiki('<p><em>This passage has no yard tools.</em></p>');
			return;
		}
		var stationId = State.variables.currentStation;
		if (typeof State.variables.stationTracks[stationId] === 'undefined') {
			startSection('Yard', true);
			wiki('<p><em>No station track data available.</em></p>');
			return;
		}
		var tracks = State.variables.stationTracks[stationId];
		// Count total trains
		var totalTrains = 0;
		for (var t = 0; t < tracks.length; t++) {
			totalTrains += tracks[t].trains.length;
		}
		if (!totalTrains) {
			startSection('Yard', true);
			wiki('<p><em>No trains in this yard.</em></p>');
		}
		// Build the train/car selectors first so every later debug action has a stable target.
		if (totalTrains > 0) {
			startSection('Train and car selection', true);
			// Build train dropdown
			var trainEntries = [];
			var trainNumber = 1;
			for (var i = 0; i < tracks.length; i++) {
				for (var j = 0; j < tracks[i].trains.length; j++) {
					var trainLength = setup.railyard.getTrainLength(tracks[i].trains[j]);
					trainEntries.push({
						trackIndex: i,
						trainIndex: j,
						label: 'Train ' + trainNumber + ' (' + trainLength + 'm, Track ' + (i + 1) + ')'
					});
					trainNumber++;
				}
			}
			var selectedTrackIndex = Math.max(0, Math.min(State.variables.debugSelectedTrackIndex || 0, tracks.length - 1));
			var selectedTrack = tracks[selectedTrackIndex];
			var selectedTrainIndex = selectedTrack && selectedTrack.trains.length > 0
				? Math.max(0, Math.min(State.variables.debugSelectedTrainIndex || 0, selectedTrack.trains.length - 1))
				: 0;
			if (!selectedTrack || !selectedTrack.trains[selectedTrainIndex]) {
				selectedTrackIndex = trainEntries[0].trackIndex;
				selectedTrainIndex = trainEntries[0].trainIndex;
			}
			State.variables.debugSelectedTrackIndex = selectedTrackIndex;
			State.variables.debugSelectedTrainIndex = selectedTrainIndex;
			var trainLabel = document.createElement('label');
			trainLabel.textContent = 'Select Train: ';
			var trainSelect = document.createElement('select');
			trainSelect.id = 'debugTrainSelect';
			for (var trainEntryIndex = 0; trainEntryIndex < trainEntries.length; trainEntryIndex++) {
				var trainEntry = trainEntries[trainEntryIndex];
				var trainOption = document.createElement('option');
				trainOption.value = trainEntry.trackIndex + ':' + trainEntry.trainIndex;
				trainOption.textContent = trainEntry.label;
				if (trainEntry.trackIndex === selectedTrackIndex && trainEntry.trainIndex === selectedTrainIndex) {
					trainOption.selected = true;
				}
				trainSelect.appendChild(trainOption);
			}
			trainSelect.addEventListener('change', function () {
				var parts = this.value.split(':');
				State.variables.debugSelectedTrackIndex = parseInt(parts[0], 10);
				State.variables.debugSelectedTrainIndex = parseInt(parts[1], 10);
				State.variables.debugSelectedCarIndex = -1;
				setup.debugReturnToPanel = true; Engine.play(State.passage);
			});
			trainLabel.appendChild(trainSelect);
			wrapper.appendChild(trainLabel);
			wrapper.appendChild(document.createElement('br'));
			wrapper.appendChild(document.createElement('br'));
			// Re-resolve selected references after dropdown normalization to avoid stale indices.
			selectedTrack = tracks[State.variables.debugSelectedTrackIndex];
			var selectedTrain = selectedTrack && selectedTrack.trains[State.variables.debugSelectedTrainIndex];
			if (selectedTrain) {
				// Car-level targeting supports both whole-train and single-car actions.
				var selectedCarIndex = State.variables.debugSelectedCarIndex;
			if (selectedCarIndex < -1 || selectedCarIndex >= selectedTrain.length) {
				selectedCarIndex = -1;
				State.variables.debugSelectedCarIndex = -1;
			}
			var carLabel = document.createElement('label');
			carLabel.textContent = 'Select Target: ';
			var carSelect = document.createElement('select');
			carSelect.id = 'debugCarSelect';
			var entireTrainOption = document.createElement('option');
			entireTrainOption.value = '-1';
			entireTrainOption.textContent = 'Entire Train';
			entireTrainOption.selected = selectedCarIndex === -1;
			carSelect.appendChild(entireTrainOption);
			for (var c = 0; c < selectedTrain.length; c++) {
				var car = selectedTrain[c];
				var carOption = document.createElement('option');
				carOption.value = String(c);
				carOption.textContent = car.type + ' (Car ' + (c + 1) + ')';
				carOption.selected = c === selectedCarIndex;
				carSelect.appendChild(carOption);
			}
			carSelect.addEventListener('change', function () {
				State.variables.debugSelectedCarIndex = parseInt(this.value, 10);
				setup.debugReturnToPanel = true; Engine.play(State.passage);
			});
			carLabel.appendChild(carSelect);
			wrapper.appendChild(carLabel);
			wrapper.appendChild(document.createElement('br'));
			wrapper.appendChild(document.createElement('br'));
			var targetName = State.variables.debugSelectedCarIndex === -1 ? 'Train' : 'Car ' + (State.variables.debugSelectedCarIndex + 1);
				startSection('Actions on the selected train', true);
				wiki('<<link "Delete ' + targetName + '">><<run setup.railyard.deleteDebugTarget(State.variables.currentStation, State.variables.debugSelectedTrackIndex, State.variables.debugSelectedTrainIndex, State.variables.debugSelectedCarIndex)>><<goto "Railyard">><</link>><br>');
				wiki('<<link "Clear Cargo of ' + targetName + '">><<run (function() { if (State.variables.debugSelectedCarIndex === -1) { var train = State.variables.stationTracks[State.variables.currentStation][State.variables.debugSelectedTrackIndex].trains[State.variables.debugSelectedTrainIndex]; for (var i = 0; i < train.length; i++) { train[i].cargo = []; } } else { State.variables.stationTracks[State.variables.currentStation][State.variables.debugSelectedTrackIndex].trains[State.variables.debugSelectedTrainIndex][State.variables.debugSelectedCarIndex].cargo = []; } })()>><<goto "Railyard">><</link>><br><br>');
				if (selectedCarIndex !== -1) {
					buildAddCargoSection(selectedTrain[selectedCarIndex]);
				}
			}
		}
		// Swapping is separated from deletion/editing because it needs two train selections and fit validation.
		if (totalTrains >= 2) {
			startSection('Swap two trains');
			var swapEntries = [];
			var swapNumber = 1;
			for (var sti = 0; sti < tracks.length; sti++) {
				for (var stj = 0; stj < tracks[sti].trains.length; stj++) {
					var swapLen = setup.railyard.getTrainLength(tracks[sti].trains[stj]);
					swapEntries.push({
						trackIndex: sti,
						trainIndex: stj,
						label: 'Train ' + swapNumber + ' (' + swapLen + 'm, ' + setup.railyard.getTrackLabel(tracks, sti) + ')'
					});
					swapNumber++;
				}
			}
			var swapALabel = document.createElement('label');
			swapALabel.textContent = 'Train A: ';
			var swapASelect = document.createElement('select');
			swapASelect.id = 'debugSwapTrainASelect';
			for (var sae = 0; sae < swapEntries.length; sae++) {
				var saOpt = document.createElement('option');
				saOpt.value = swapEntries[sae].trackIndex + ':' + swapEntries[sae].trainIndex;
				saOpt.textContent = swapEntries[sae].label;
				swapASelect.appendChild(saOpt);
			}
			swapALabel.appendChild(swapASelect);
			wrapper.appendChild(swapALabel);
			wrapper.appendChild(document.createElement('br'));
			var swapBLabel = document.createElement('label');
			swapBLabel.textContent = 'Train B: ';
			var swapBSelect = document.createElement('select');
			swapBSelect.id = 'debugSwapTrainBSelect';
			for (var sbe = 0; sbe < swapEntries.length; sbe++) {
				var sbOpt = document.createElement('option');
				sbOpt.value = swapEntries[sbe].trackIndex + ':' + swapEntries[sbe].trainIndex;
				sbOpt.textContent = swapEntries[sbe].label;
				swapBSelect.appendChild(sbOpt);
			}
			if (swapBSelect.options.length > 1) {
				swapBSelect.selectedIndex = 1;
			}
			swapBLabel.appendChild(swapBSelect);
			wrapper.appendChild(swapBLabel);
			wrapper.appendChild(document.createElement('br'));
			var swapStatus = document.createElement('div');
			swapStatus.className = 'small-description';
			swapStatus.style.margin = '6px 0';
			wrapper.appendChild(swapStatus);
			var swapBtn = document.createElement('button');
			swapBtn.textContent = 'Swap Selected Trains';
			swapBtn.addEventListener('click', function () {
				var aParts = swapASelect.value.split(':');
				var bParts = swapBSelect.value.split(':');
				var result = setup.railyard.swapDebugTrains(
					State.variables.currentStation,
					aParts[0],
					aParts[1],
					bParts[0],
					bParts[1]
				);
				if (!result.ok) {
					swapStatus.textContent = 'Swap failed: ' + result.reason;
					return;
				}
				setup.debugReturnToPanel = true; Engine.play(State.passage);
			});
			wrapper.appendChild(swapBtn);
			wrapper.appendChild(document.createElement('br'));
			wrapper.appendChild(document.createElement('br'));
		}
		// Placement and track management live at the end because they mutate the yard layout itself.
		startSection('Place a new train');
		var placeTrackLabel = document.createElement('label');
		placeTrackLabel.textContent = 'Select Track: ';
		var placeTrackSelect = document.createElement('select');
		placeTrackSelect.id = 'debugPlaceTrackSelect';
		for (var i = 0; i < tracks.length; i++) {
			if (!setup.railyard.trackExists(tracks, i)) {
				continue;
			}
			var occupied = setup.railyard.getTrackOccupiedLength(tracks[i]);
			var remaining = tracks[i].infinite ? 'infinite' : (Math.max(0, tracks[i].length - occupied) + 'm');
			var trackOption = document.createElement('option');
			trackOption.value = String(i);
			trackOption.textContent = setup.railyard.getTrackLabel(tracks, i) + ' (' + remaining + ' free)';
			placeTrackSelect.appendChild(trackOption);
		}
		placeTrackLabel.appendChild(placeTrackSelect);
		wrapper.appendChild(placeTrackLabel);
		wrapper.appendChild(document.createElement('br'));
		var trainTypeLabel = document.createElement('label');
		trainTypeLabel.textContent = 'Select Car Type: ';
		var trainTypeSelect = document.createElement('select');
		trainTypeSelect.id = 'debugTrainTypeSelect';
		var trainTypeValues = setup.railyard.getDebugTrainTypeOptions();
		for (var typeIndex = 0; typeIndex < trainTypeValues.length; typeIndex++) {
			var typeOption = document.createElement('option');
			typeOption.value = trainTypeValues[typeIndex].value;
			typeOption.textContent = trainTypeValues[typeIndex].label;
			trainTypeSelect.appendChild(typeOption);
		}
		trainTypeLabel.appendChild(trainTypeSelect);
		wrapper.appendChild(trainTypeLabel);
		wrapper.appendChild(document.createElement('br'));
		wiki('<<link "Place Train">><<run (function() { var trackIdx = parseInt(document.getElementById("debugPlaceTrackSelect").value, 10); var carType = document.getElementById("debugTrainTypeSelect").value; var newTrain = setup.railyard.createTrainFromPreset(carType); if (!newTrain.length) { return; } setup.railyard.placeTrainInStationTracks(State.variables.stationTracks[State.variables.currentStation], newTrain, trackIdx); })()>><<goto "Railyard">><</link>><br>');
		startSection('Track management');
		var deleteTrackLabel = document.createElement('label');
		deleteTrackLabel.textContent = 'Delete Yard Track: ';
		var deleteTrackSelect = document.createElement('select');
		deleteTrackSelect.id = 'debugDeleteTrackSelect';
		for (var deleteTrackIndex = 1; deleteTrackIndex < tracks.length - 1; deleteTrackIndex++) {
			var deleteTrack = tracks[deleteTrackIndex];
			var deleteOccupied = setup.railyard.getTrackOccupiedLength(deleteTrack);
			var deleteOption = document.createElement('option');
			deleteOption.value = String(deleteTrackIndex);
			deleteOption.textContent = setup.railyard.getTrackLabel(tracks, deleteTrackIndex) + ' (' + deleteTrack.length + 'm, ' + deleteOccupied + 'm occupied)';
			deleteTrackSelect.appendChild(deleteOption);
		}
		deleteTrackLabel.appendChild(deleteTrackSelect);
		wrapper.appendChild(deleteTrackLabel);
		wrapper.appendChild(document.createElement('br'));
		var deleteTrackBtn = document.createElement('button');
		deleteTrackBtn.textContent = 'Delete Track';
		deleteTrackBtn.disabled = deleteTrackSelect.options.length <= 1;
		deleteTrackBtn.addEventListener('click', function () {
			var selected = parseInt(deleteTrackSelect.value, 10);
			if (isNaN(selected)) return;
			setup.railyard.deleteDebugTrack(State.variables.currentStation, selected);
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(deleteTrackBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('br'));
		var connectionTrackLabel = document.createElement('label');
		connectionTrackLabel.textContent = 'Track Connections: ';
		var connectionTrackSelect = document.createElement('select');
		connectionTrackSelect.id = 'debugConnectionTrackSelect';
		for (var connectionTrackIndex = 1; connectionTrackIndex < tracks.length - 1; connectionTrackIndex++) {
			var connectionOption = document.createElement('option');
			connectionOption.value = String(connectionTrackIndex);
			var connectionNote = setup.railyard.getDeadEndText(tracks, connectionTrackIndex);
			connectionOption.textContent = setup.railyard.getTrackLabel(tracks, connectionTrackIndex) + (connectionNote ? ' (' + connectionNote + ')' : '');
			connectionTrackSelect.appendChild(connectionOption);
		}
		connectionTrackLabel.appendChild(connectionTrackSelect);
		wrapper.appendChild(connectionTrackLabel);
		var connectionModeSelect = document.createElement('select');
		connectionModeSelect.id = 'debugConnectionModeSelect';
		[['both', 'Connects to both leads'],
			['entry', 'Only the ' + setup.railyard.getTrackLabel(tracks, 0)],
			['exit', 'Only the ' + setup.railyard.getTrackLabel(tracks, tracks.length - 1)]].forEach(function (mode) {
			var modeOption = document.createElement('option');
			modeOption.value = mode[0];
			modeOption.textContent = mode[1];
			connectionModeSelect.appendChild(modeOption);
		});
		wrapper.appendChild(connectionModeSelect);
		wrapper.appendChild(document.createElement('br'));
		var connectionBtn = document.createElement('button');
		connectionBtn.textContent = 'Set Connections';
		connectionBtn.disabled = connectionTrackSelect.options.length === 0;
		connectionBtn.addEventListener('click', function () {
			var selected = parseInt(connectionTrackSelect.value, 10);
			if (isNaN(selected)) return;
			var mode = connectionModeSelect.value;
			setup.railyard.setDebugTrackConnections(State.variables.currentStation, selected, mode === 'both' || mode === 'entry', mode === 'both' || mode === 'exit');
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(connectionBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('br'));
		var leadLabel = document.createElement('label');
		leadLabel.textContent = 'Lead Tracks: ' + setup.railyard.getTrackLabel(tracks, 0) + ' on ';
		wrapper.appendChild(leadLabel);
		var makeLeadSelect = function (id, current) {
			var select = document.createElement('select');
			select.id = id;
			for (var leadIndex = 1; leadIndex < tracks.length - 1; leadIndex++) {
				var leadOption = document.createElement('option');
				leadOption.value = String(leadIndex);
				leadOption.textContent = setup.railyard.getTrackLabel(tracks, leadIndex);
				leadOption.selected = leadIndex === current;
				select.appendChild(leadOption);
			}
			return select;
		};
		var debugLeads = setup.railyard.getLeads(tracks);
		var entryLeadSelect = makeLeadSelect('debugEntryLeadSelect', setup.railyard.getLeadTrack(tracks, 'entry'));
		var exitLeadSelect = makeLeadSelect('debugExitLeadSelect', setup.railyard.getLeadTrack(tracks, 'exit'));
		entryLeadSelect.disabled = !debugLeads.entry;
		exitLeadSelect.disabled = !debugLeads.exit;
		wrapper.appendChild(entryLeadSelect);
		wrapper.appendChild(document.createTextNode(', ' + setup.railyard.getTrackLabel(tracks, tracks.length - 1) + ' on '));
		wrapper.appendChild(exitLeadSelect);
		wrapper.appendChild(document.createElement('br'));
		var leadBtn = document.createElement('button');
		leadBtn.textContent = 'Set Lead Tracks';
		leadBtn.disabled = entryLeadSelect.options.length === 0;
		leadBtn.addEventListener('click', function () {
			setup.railyard.setDebugLeadTracks(State.variables.currentStation, parseInt(entryLeadSelect.value, 10), parseInt(exitLeadSelect.value, 10));
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(leadBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('br'));
		// Options that would strand the player (no entry and no exit) or lose trains are listed but disabled.
		var leadModesLabel = document.createElement('label');
		leadModesLabel.textContent = 'Station Leads: ';
		var leadModesSelect = document.createElement('select');
		leadModesSelect.id = 'debugLeadModesSelect';
		var leadModes = [['both', 'Both lead tracks', true, true],
			['exit', 'Only the ' + setup.railyard.getTrackLabel(tracks, tracks.length - 1), false, true],
			['entry', 'Only the ' + setup.railyard.getTrackLabel(tracks, 0), true, false]];
		leadModes.forEach(function (mode) {
			var modeOption = document.createElement('option');
			var blockReason = setup.railyard.getLeadChangeBlockReason(State.variables.currentStation, mode[2], mode[3]);
			var isCurrent = debugLeads.entry === mode[2] && debugLeads.exit === mode[3];
			modeOption.value = mode[0];
			modeOption.textContent = mode[1] + (blockReason && !isCurrent ? ' (unavailable: ' + blockReason + ')' : '');
			modeOption.disabled = !!blockReason && !isCurrent;
			modeOption.selected = isCurrent;
			leadModesSelect.appendChild(modeOption);
		});
		leadModesLabel.appendChild(leadModesSelect);
		wrapper.appendChild(leadModesLabel);
		wrapper.appendChild(document.createElement('br'));
		var leadModesBtn = document.createElement('button');
		leadModesBtn.textContent = 'Set Station Leads';
		leadModesBtn.addEventListener('click', function () {
			var mode = leadModes.filter(function (candidate) { return candidate[0] === leadModesSelect.value; })[0];
			if (!mode) return;
			setup.railyard.setDebugLeads(State.variables.currentStation, mode[2], mode[3]);
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(leadModesBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('br'));
		// The headings the two leads point along. Generated stations take these from the route's own legs.
		var directionsLabel = document.createElement('label');
		directionsLabel.textContent = 'Lead Directions: back ';
		var makeDirectionSelect = function (id, current) {
			var select = document.createElement('select');
			select.id = id;
			['north', 'south', 'east', 'west'].forEach(function (heading) {
				var headingOption = document.createElement('option');
				headingOption.value = heading;
				headingOption.textContent = setup.railyard.getDirectionName(heading);
				headingOption.selected = heading === current;
				select.appendChild(headingOption);
			});
			return select;
		};
		var entryDirectionSelect = makeDirectionSelect('debugEntryDirectionSelect', setup.railyard.getLeadDirection(tracks, 'entry'));
		var exitDirectionSelect = makeDirectionSelect('debugExitDirectionSelect', setup.railyard.getLeadDirection(tracks, 'exit'));
		directionsLabel.appendChild(entryDirectionSelect);
		wrapper.appendChild(directionsLabel);
		wrapper.appendChild(document.createTextNode(', onward '));
		wrapper.appendChild(exitDirectionSelect);
		wrapper.appendChild(document.createElement('br'));
		var directionsBtn = document.createElement('button');
		directionsBtn.textContent = 'Set Lead Directions';
		directionsBtn.addEventListener('click', function () {
			setup.railyard.setDebugLeadDirections(State.variables.currentStation, entryDirectionSelect.value, exitDirectionSelect.value);
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(directionsBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('br'));
		var addTrackLabel = document.createElement('label');
		addTrackLabel.textContent = 'New Track Length (m): ';
		var addTrackInput = document.createElement('input');
		addTrackInput.type = 'number';
		addTrackInput.min = '1';
		addTrackInput.step = '1';
		addTrackInput.value = '120';
		addTrackInput.style.width = '90px';
		addTrackLabel.appendChild(addTrackInput);
		wrapper.appendChild(addTrackLabel);
		wrapper.appendChild(document.createElement('br'));
		var addTrackBtn = document.createElement('button');
		addTrackBtn.textContent = 'Add Track';
		addTrackBtn.disabled = setup.railyard.getYardTrackIndices(tracks).length >= 15;
		addTrackBtn.addEventListener('click', function () {
			var length = parseInt(addTrackInput.value, 10);
			if (isNaN(length) || length <= 0) return;
			setup.railyard.addDebugTrack(State.variables.currentStation, length);
			setup.debugReturnToPanel = true; Engine.play(State.passage);
		});
		wrapper.appendChild(addTrackBtn);
		wrapper.appendChild(document.createElement('br'));
		wrapper.appendChild(document.createElement('hr'));
	}
});
