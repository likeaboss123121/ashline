// The player's condition: six stats, the words that describe them, and what drives each one.
//
// There are two kinds. A reserve falls from 100 (fine) to 0 (dire): health, immunity, sanity, hunger and thirst
// all read as how much of something is left, so a full bar is always good news. Fatigue is the one burden, and
// climbs from 0 to 100, because what it measures is how much of it has built up. Holding both kinds in one list
// lets the sidebar draw and word them the same way, and lets the rest of the game move a stat without caring
// which kind it is.
//
// A bar's length is the stat's own value, so it reads as the number it is. Its colour is the judgement: severity
// rises as a burden fills and as a reserve empties, so red always means trouble whichever way the stat runs.
setup.stats = {
	MIN: 0,
	MAX: 100,
	BAND_COUNT: 5, // fine, mild, moderate, severe, critical

	LIST: [
		{
			key: 'fatigue', label: 'Fatigue', kind: 'burden',
			bands: ['Rested', 'Tired', 'Weary', 'Exhausted', 'Collapsing'],
			driver: 'Fatigue is increased by doing work and staying awake for long periods of time. If you\'re tired, take a break!'
		},
		{
			key: 'health', label: 'Health', kind: 'reserve',
			bands: ['Unhurt', 'Bruised', 'Hurt', 'Injured', 'Broken'],
			driver: 'Health represents injuries. In a world without hospitals, even a minor accident can be fatal.'
		},
		{
			key: 'immunity', label: 'Immunity', kind: 'reserve',
			bands: ['Strong', 'Steady', 'Weakened', 'Failing', 'Overwhelmed'],
			driver: 'Immunity represents the status of your immune system. Consuming unclean food or water will make you sick.'
		},
		{
			key: 'sanity', label: 'Sanity', kind: 'reserve',
			bands: ['Sound', 'Strained', 'Fraying', 'Haunted', 'Breaking'],
			driver: 'Sanity is decreased by being alone for long periods of time. Even those with the strongest wills are susceptible to prolonged isolation.'
		},
		{
			key: 'hunger', label: 'Hunger', kind: 'reserve',
			bands: ['Fed', 'Peckish', 'Hungry', 'Starving', 'Wasting'],
			driver: 'Hunger is a major obstacle when food is scarce. Desperation can drive you to eat anything.'
		},
		{
			key: 'thirst', label: 'Thirst', kind: 'reserve',
			bands: ['Watered', 'Dry', 'Thirsty', 'Parched', 'Failing'],
			driver: 'Thirst will kill you if you are not careful. Make sure to carry plenty of water.'
		}
	],

	getStat: function(key) {
		for (var i = 0; i < this.LIST.length; i++) {
			if (this.LIST[i].key === key) {
				return this.LIST[i];
			}
		}
		return null;
	},
	clamp: function(value) {
		var number = Number(value);
		if (!isFinite(number)) {
			return this.MIN;
		}
		return Math.max(this.MIN, Math.min(this.MAX, Math.round(number)));
	},
	// A stat's own scale. Ours all run 0..100, but the drawing asks rather than assumes, so a future stat on a
	// different scale (fuel in litres, hours awake) needs no new bar code.
	getMax: function(key) {
		var stat = this.getStat(key);
		return (stat && Number(stat.max)) || this.MAX;
	},
	getPercent: function(key, value) {
		var reading = typeof value === 'number' ? value : this.getValue(key);
		return Math.max(0, Math.min(100, Math.round((reading / this.getMax(key)) * 100)));
	},
	// Where trouble starts: the value at which this stat first reads as severe. Derived from the bands rather
	// than invented, and drawn on the bar as a marker so the player can see the edge before reaching it.
	getThresholdPercent: function(key) {
		var stat = this.getStat(key);
		if (!stat) {
			return 0;
		}
		var severeAt = (this.BAND_COUNT - 2) / this.BAND_COUNT; // the start of the fourth band of five
		return Math.round((stat.kind === 'reserve' ? 1 - severeAt : severeAt) * 100);
	},
	getValue: function(key) {
		var player = State.variables.player || {};
		return this.clamp(player[key]);
	},
	setValue: function(key, value) {
		if (!State.variables.player) {
			State.variables.player = {};
		}
		State.variables.player[key] = this.clamp(value);
		return State.variables.player[key];
	},
	// The one way the rest of the game should move a stat, so clamping and direction live in a single place.
	adjust: function(key, delta) {
		return this.setValue(key, this.getValue(key) + (Number(delta) || 0));
	},

	// How bad things are, 0 (fine) to 4 (critical). A burden is worse the higher it climbs and a reserve the
	// further it falls, so this is the one place that knows which way each stat runs.
	getSeverity: function(key, value) {
		var stat = this.getStat(key);
		if (!stat) {
			return 0;
		}
		var reading = typeof value === 'number' ? this.clamp(value) : this.getValue(key);
		var towardsTrouble = stat.kind === 'reserve' ? this.MAX - reading : reading;
		return Math.min(this.BAND_COUNT - 1, Math.floor(towardsTrouble / (this.MAX / this.BAND_COUNT)));
	},
	getBand: function(key, value) {
		var stat = this.getStat(key);
		return stat ? stat.bands[this.getSeverity(key, value)] : '';
	},
	// A one-line reading of each stat, for the sidebar, the dialog and the tests alike.
	getReadings: function() {
		var self = this;
		return this.LIST.map(function(stat) {
			var value = self.getValue(stat.key);
			return {
				key: stat.key, label: stat.label, kind: stat.kind, value: value,
				severity: self.getSeverity(stat.key, value), band: self.getBand(stat.key, value),
				driver: stat.driver
			};
		});
	},
	// The stat in the most trouble, so a glance is enough to know what is worst.
	getWorst: function() {
		var readings = this.getReadings();
		var worst = readings[0];
		readings.forEach(function(reading) {
			if (reading.severity > worst.severity) {
				worst = reading;
			}
		});
		return worst;
	},

	SEVERITY_NAMES: ['fine', 'mild', 'moderate', 'severe', 'critical'],

	// The sidebar panel: a row per stat, its name and how it stands, over a bar as long as the number itself.
	createPanel: function() {
		var self = this;
		var panel = document.createElement('div');
		panel.className = 'stats-panel';
		this.getReadings().forEach(function(reading) {
			var row = document.createElement('div');
			row.className = 'stat-row';
			row.setAttribute('data-stat', reading.key);
			row.title = reading.label + ': ' + reading.band + ' (' + reading.value + '/' + self.MAX + '). ' + reading.driver;

			var head = document.createElement('div');
			head.className = 'stat-head';
			var label = document.createElement('span');
			label.className = 'stat-label';
			label.textContent = reading.label;
			var band = document.createElement('span');
			band.className = 'stat-band';
			band.textContent = reading.band;
			head.appendChild(label);
			head.appendChild(band);

			var value = document.createElement('span');
			value.className = 'stat-value';
			value.textContent = reading.value + '/' + self.getMax(reading.key);
			head.appendChild(value);

			var track = document.createElement('div');
			track.className = 'stat-track';
			var fill = document.createElement('div');
			fill.className = 'stat-fill stat-' + self.SEVERITY_NAMES[reading.severity];
			fill.style.width = self.getPercent(reading.key, reading.value) + '%';
			track.appendChild(fill);
			// The marker sits where this stat starts reading as severe, so the edge is visible before it arrives.
			var pin = document.createElement('div');
			pin.className = 'stat-pin';
			pin.style.left = self.getThresholdPercent(reading.key) + '%';
			track.appendChild(pin);

			row.appendChild(head);
			row.appendChild(track);
			panel.appendChild(row);
		});
		// Tapping the panel shows the numbers behind the words, and hides them again.
		panel.addEventListener('click', function() {
			self.expanded = !self.expanded;
			panel.classList.toggle('expanded', !!self.expanded);
		});
		panel.classList.toggle('expanded', !!this.expanded);
		return panel;
	}
};

// Opens the full condition screen: every stat with its reading and what drives it.
setup.showConditionDialog = function() {
	if (typeof Dialog === 'undefined') {
		return;
	}
	Dialog.setup('Condition');
	var body = document.createElement('div');
	body.className = 'condition-screen';
	setup.stats.getReadings().forEach(function(reading) {
		var block = document.createElement('div');
		block.className = 'condition-stat';
		var heading = document.createElement('p');
		heading.className = 'condition-heading';
		heading.textContent = reading.label + ': ' + reading.band + ' (' + reading.value + '/' + setup.stats.MAX + ')';
		var track = document.createElement('div');
		track.className = 'stat-track';
		var fill = document.createElement('div');
		fill.className = 'stat-fill stat-' + setup.stats.SEVERITY_NAMES[reading.severity];
		fill.style.width = reading.value + '%';
		track.appendChild(fill);
		var driver = document.createElement('p');
		driver.className = 'condition-driver';
		driver.textContent = reading.driver;
		block.appendChild(heading);
		block.appendChild(track);
		block.appendChild(driver);
		body.appendChild(block);
	});
	Dialog.append(body);
	Dialog.open();
};

// The sidebar's condition panel, under the clock.
Macro.add('playerStats', {
	handler: function() {
		this.output.appendChild(setup.stats.createPanel());
	}
});
