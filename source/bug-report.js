// Diagnostics stay outside story history. Reports are copied only when the player asks.
setup.bugReport = {
	recent: [],
	record: function(action) {
		this.recent.push({ passage: State.passage, time: State.variables.gameTimeTimestampMs, action: action });
		if (this.recent.length > 30) this.recent.shift();
	},
	build: function() {
		var v = State.variables;
		return { version: setup.releaseVersion, build: setup.currentBuildChecksum || setup.getBuildChecksum(),
			seed: v.randomSeed, passage: State.passage, station: v.currentStation,
			track: v.drivingTrackIndex, gap: v.enteredTrainIndex, car: v.currentCarIndex,
			forward: v.travellingForward, time: v.gameTimeTimestampMs, journey: v.journey || null,
			tracks: v.stationTracks && v.stationTracks[v.currentStation], consist: v.currentTrain || [],
			player: v.player, recentActions: this.recent.slice() };
	},
	show: function() {
		Dialog.setup('Bug report');
		var body = Dialog.body();
		var text = document.createElement('textarea');
		text.setAttribute('aria-label', 'Bug report');
		text.rows = 14;
		text.style.width = '100%';
		text.readOnly = true;
		text.value = JSON.stringify(this.build(), null, 2);
		var button = document.createElement('button');
		button.textContent = 'Copy bug report';
		var status = document.createElement('p');
		status.setAttribute('role', 'status');
		status.textContent = 'Includes your current game state, not browser saves or account information.';
		button.addEventListener('click', function() {
			text.focus(); text.select();
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text.value).then(function() { status.textContent = 'Copied.'; },
					function() { status.textContent = 'Copy the selected text manually.'; });
			} else status.textContent = 'Copy the selected text manually.';
		});
		body.appendChild(status); body.appendChild(text); body.appendChild(button);
		Dialog.open();
	}
};

if (typeof document.addEventListener === 'function') {
	document.addEventListener('click', function(event) {
		var node = event.target.closest && event.target.closest('#passages a, #passages button, [data-yard-target], [data-car-index]');
		if (node) setup.bugReport.record({ kind: 'click', label: (node.getAttribute('aria-label') || node.textContent || '').slice(0, 200),
			target: node.getAttribute('data-yard-target') || node.getAttribute('data-car-index'),
			station: State.variables.currentStation, track: State.variables.drivingTrackIndex });
	}, true);
}
