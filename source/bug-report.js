// Diagnostics stay outside story history. Reports are copied only when the player asks.
// Errors are kept as they happen (uncaught ones, failed promises, SugarCube's error boxes in a passage, and console
// errors), the last ERROR_LIMIT of them, so a report says what went wrong and not only where the player was.
setup.bugReport = {
	recent: [],
	errors: [],
	ERROR_LIMIT: 20,
	record: function(action) {
		this.recent.push({ passage: State.passage, time: State.variables.gameTimeTimestampMs, action: action });
		if (this.recent.length > 30) this.recent.shift();
	},
	recordError: function(kind, message, where, stack) {
		var text = String(message || '').slice(0, 500);
		var last = this.errors[this.errors.length - 1];
		// The same error again and again (a redraw that keeps failing) is counted, not listed each time.
		if (last && last.kind === kind && last.message === text && last.passage === State.passage) { last.count = (last.count || 1) + 1; return; }
		this.errors.push({ kind: kind, message: text, where: where || null, passage: State.passage || null,
			station: State.variables ? (State.variables.currentStation === undefined ? null : State.variables.currentStation) : null,
			at: new Date().toISOString(), stack: stack ? String(stack).split('\n').slice(0, 6).join('\n') : null });
		if (this.errors.length > this.ERROR_LIMIT) this.errors.shift();
	},
	build: function() {
		var v = State.variables;
		// Unset values as null, all the way down: SugarCube's JSON writes undefined as a revival expression, which reads
		// as noise in a report.
		var value = function(x) {
			if (x === undefined) return null;
			if (Array.isArray(x)) return x.map(value);
			if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
				var copy = {};
				Object.keys(x).forEach(function(key) { copy[key] = value(x[key]); });
				return copy;
			}
			return x;
		};
		return value({ version: setup.releaseVersion, build: setup.currentBuildChecksum || setup.getBuildChecksum(),
			seed: v.randomSeed, passage: State.passage, station: value(v.currentStation),
			track: value(v.drivingTrackIndex), gap: value(v.enteredTrainIndex), car: value(v.currentCarIndex),
			forward: value(v.travellingForward), time: value(v.gameTimeTimestampMs), journey: v.journey || null,
			tracks: value(v.stationTracks && v.stationTracks[v.currentStation]), consist: v.currentTrain || [],
			player: value(v.player), errors: this.errors.slice(), recentActions: this.recent.slice() });
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

// Where errors come from: thrown and not caught, a promise rejected with nobody listening, an error box SugarCube
// writes into a passage (a macro that failed), and console errors. Each passage shown is recorded too, so the actions
// before an error read in order.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('error', function(event) {
		setup.bugReport.recordError('uncaught', event.message || (event.error && event.error.message),
			event.filename ? event.filename.split('/').pop() + ':' + event.lineno + ':' + event.colno : null, event.error && event.error.stack);
	});
	window.addEventListener('unhandledrejection', function(event) {
		var reason = event.reason;
		setup.bugReport.recordError('promise', reason && reason.message ? reason.message : String(reason), null, reason && reason.stack);
	});
}
if (typeof window !== 'undefined' && typeof console !== 'undefined' && typeof console.error === 'function' && !console.error.ashlineRecorded) {
	(function(original) {
		var recorded = function() {
			try {
				setup.bugReport.recordError('console', Array.prototype.map.call(arguments, function(part) {
					return part && part.message ? part.message : String(part);
				}).join(' '), null, arguments[0] && arguments[0].stack);
			} catch (error) { /* a report must never break the game */ }
			return original.apply(console, arguments);
		};
		recorded.ashlineRecorded = true;
		console.error = recorded;
	})(console.error);
}
if (typeof jQuery === 'function' && typeof document.querySelectorAll === 'function') {
	jQuery(document).on(':passagedisplay.ashline-bug-report', function() {
		setup.bugReport.record({ kind: 'passage', passage: State.passage, station: State.variables.currentStation });
		document.querySelectorAll('#passages .error').forEach(function(box) {
			setup.bugReport.recordError('macro', (box.textContent || '').trim(), State.passage, null);
		});
	});
}
