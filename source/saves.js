// Saves, and reminding the player that a browser is not a safe place to keep them.
//
// Saves live in this browser's storage. Clearing site data, a private window closing, or a browser tidying up after
// itself takes them with it, and the player has no warning. So the menu here shows what each slot actually holds
// (where the train is, what the date is, how long has been played), keeps saving and loading in one place, and a
// banner asks for a backup to disk when it has been a while since the last one.
if (typeof Config !== 'undefined') Config.saves.slots = 8;
// SugarCube 2.36 serializes the passage-entry history snapshot, not the live variables.
// Capture completed in-passage actions too, particularly sleep before its return navigation.
if (typeof Save !== 'undefined' && Save.onSave) Save.onSave.add(function(save) {
	if (save.state && save.state.history && save.state.history[save.state.index]) {
		save.state.history[save.state.index].variables = JSON.parse(JSON.stringify(State.variables));
	}
});
setup.saves = {
	SLOT_COUNT: 8,
	REMIND_AFTER_DAYS: 3,
	REMIND_AFTER_SAVES: 8,
	EXPORT_KEY: 'ashline.saves.lastExport',
	SAVES_SINCE_KEY: 'ashline.saves.sinceExport',
	// --- the engine, whichever version of its API is present ---------------------------------------------------
	slotApi: function() {
		if (typeof Save === 'undefined') {
			return null;
		}
		return (Save.browser && Save.browser.slot) ? Save.browser.slot : Save.slots;
	},
	diskApi: function() {
		if (typeof Save === 'undefined') {
			return null;
		}
		return Save.disk || { save: Save.export, load: Save.import };
	},
	getSlot: function(index) {
		if (index === 'auto') {
			try { return Save.autosave.get(); } catch (error) { return null; }
		}
		var slots = this.slotApi();
		try {
			return slots && slots.get ? slots.get(index) : null;
		} catch (error) {
			return null;
		}
	},
	// What a save is of: where the train was standing, the date it was standing there, and the hours played.
	describeCurrent: function() {
		var variables = State.variables;
		var parts = setup.time.getCurrentDateParts();
		var station = variables.currentStation || 1;
		var place = variables.journey ? 'On the line past Station ' + station : 'Station ' + station;
		return {
			place: place,
			when: setup.time.formatDate(parts) + ', ' + setup.time.formatClock(parts),
			turns: State.turns
		};
	},
	save: function(index, automatic) {
		try {
			var detail = this.describeCurrent(), slots = this.slotApi();
			detail.automatic = !!automatic;
			var ok = automatic ? Save.autosave.save('Autosave: ' + detail.place, detail)
				: slots.save(index, detail.place, detail);
			if (ok !== true) return this.fail('Save failed. Export a backup to disk; browser storage may be full or unavailable.');
			this.countSave(); this.error = false; this.message = automatic ? 'Autosaved.' : 'Saved.';
			return true;
		} catch (error) { return this.fail('Save failed. Export a backup to disk. ' + error.message); }
	},
	load: function(index) {
		try {
			if (!this.getSlot(index)) return this.fail('No save was found in this slot.');
			this.error = false; this.message = '';
			var ok = index === 'auto' ? Save.autosave.load() : this.slotApi().load(index);
			if (ok !== true) return this.fail('Load failed. The current game has not been replaced.');
			Dialog.close(); return true;
		} catch (error) { return this.fail('Load failed. ' + error.message); }
	},
	remove: function(index) {
		try {
			var ok = index === 'auto' ? Save.autosave.delete() : this.slotApi().delete(index);
			if (ok !== true) return this.fail('Delete failed.');
			this.error = false; this.message = 'Deleted.'; return true;
		} catch (error) { return this.fail('Delete failed. ' + error.message); }
	},
	fail: function(message) {
		this.error = true;
		this.message = message;
		this.refresh();
		return false;
	},
	confirm: function(message, action) {
		var self = this;
		Dialog.setup('Confirm');
		var body = document.createElement('div'), text = document.createElement('p');
		text.textContent = message; body.appendChild(text);
		body.appendChild(this.button('Confirm', message, function() { if (action() !== true) self.showDialog(); }));
		body.appendChild(this.button('Cancel', 'Keep the existing save', function() { self.showDialog(); }));
		Dialog.append(body); Dialog.open();
	},
	exportFile: function() {
		try {
			if (Config.saves.isAllowed && !Config.saves.isAllowed()) return this.fail('Saving is unavailable here.');
			Save.export('ashline-' + new Date().toISOString().slice(0, 10), this.describeCurrent());
			this.markExported(); this.error = false; this.message = 'Backup download requested. Keep the downloaded file.';
			this.refresh(); return true;
		} catch (error) { return this.fail('Export failed. ' + error.message); }
	},
	importText: function(text) {
		try {
			if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('Invalid or oversized file.');
			var data = JSON.parse(/^\s*\{/.test(text) ? text : LZString.decompressFromBase64(text.trim()));
			if (!data || data.id !== Config.saves.id || !data.state || !Array.isArray(data.state.delta) || !data.state.delta.length)
				throw new Error('This is not an Ashline save.');
			var history = State.deltaDecode(data.state.delta), state = history[data.state.index];
			if (!state || !Story.has(state.title) || !state.variables || typeof state.variables.player !== 'object'
				|| !state.variables.player || typeof state.variables.stationTracks !== 'object' || !state.variables.stationTracks)
				throw new Error('The save is incomplete.');
			var v = state.variables;
			if (['TrainInterior', 'DrivingMode', 'OnTheLine', 'OnFoot', 'Sleep'].indexOf(state.title) >= 0
				&& (!Array.isArray(v.currentTrain) || !v.currentTrain.length)) throw new Error('The train is missing.');
			if (v.currentTrain && (!Array.isArray(v.currentTrain) || v.currentTrain.some(function(car) {
				return !car || typeof car.type !== 'string' || !(Number(car.length) > 0)
					|| (car.cargo != null && !Array.isArray(car.cargo)) || (car.inventory != null && !Array.isArray(car.inventory));
			}))) throw new Error('Invalid train data.');
			if (v.player.carried != null && !Array.isArray(v.player.carried)) throw new Error('Invalid inventory data.');
			if (data.metadata == null) data.metadata = {};
			this.error = false; this.message = '';
			var result = Save.deserialize(LZString.compressToBase64(JSON.stringify(data)));
			if (result === null) return this.fail('Import failed.');
			Dialog.close(); return true;
		} catch (error) { return this.fail('Import failed. ' + error.message); }
	},
	// --- the backup reminder ------------------------------------------------------------------------------------
	readNumber: function(key) {
		try {
			return Number(localStorage.getItem(key)) || 0;
		} catch (error) {
			return 0;
		}
	},
	writeNumber: function(key, value) {
		try {
			localStorage.setItem(key, String(value));
		} catch (error) {
			// A browser that refuses storage is exactly the case the reminder is about, but there is nowhere to note it.
		}
	},
	countSave: function() {
		this.writeNumber(this.SAVES_SINCE_KEY, this.readNumber(this.SAVES_SINCE_KEY) + 1);
	},
	markExported: function() {
		this.writeNumber(this.EXPORT_KEY, Date.now());
		this.writeNumber(this.SAVES_SINCE_KEY, 0);
		this.dismissed = false;
	},
	getDaysSinceExport: function() {
		var last = this.readNumber(this.EXPORT_KEY);
		return last ? (Date.now() - last) / 86400000 : null;
	},
	// Whether to ask for a backup: a good few saves since the last one, or a few days, and never before the player
	// has saved anything at all.
	shouldRemind: function() {
		if (this.dismissed) {
			return false;
		}
		var saves = this.readNumber(this.SAVES_SINCE_KEY);
		if (!saves) {
			return false;
		}
		var days = this.getDaysSinceExport();
		return saves >= this.REMIND_AFTER_SAVES || days === null || days >= this.REMIND_AFTER_DAYS;
	},
	describeReminder: function() {
		var days = this.getDaysSinceExport();
		var saves = this.readNumber(this.SAVES_SINCE_KEY);
		if (days === null) {
			return 'You have saved ' + saves + ' time' + (saves === 1 ? '' : 's') + ' and never saved a copy to disk. '
				+ 'Saves live in this browser only, and clearing its data deletes them.';
		}
		return 'It has been ' + Math.floor(days) + ' day' + (Math.floor(days) === 1 ? '' : 's') + ' and ' + saves
			+ ' save' + (saves === 1 ? '' : 's') + ' since your last backup. Saves live in this browser only.';
	},
	// --- the menu ------------------------------------------------------------------------------------------------
	button: function(label, title, onClick, className) {
		var button = document.createElement('button');
		button.type = 'button';
		button.className = 'saves-button' + (className ? ' ' + className : '');
		button.textContent = label;
		button.title = title || label;
		button.addEventListener('click', onClick);
		return button;
	},
	buildMenu: function() {
		var self = this;
		var body = document.createElement('div');
		body.className = 'saves-menu';
		if (this.message) {
			var feedback = document.createElement('p');
			feedback.className = 'saves-feedback'; feedback.setAttribute('role', 'status');
			feedback.textContent = this.message; body.appendChild(feedback);
		}
		var backup = document.createElement('div');
		backup.className = 'saves-backup';
		var days = this.getDaysSinceExport();
		var summary = document.createElement('p');
		summary.className = 'small-description';
		summary.textContent = days === null
			? 'No backup has been saved to disk from this browser.'
			: 'Last backup to disk: ' + (days < 1 ? 'today' : Math.floor(days) + ' day' + (Math.floor(days) === 1 ? '' : 's') + ' ago') + '.';
		backup.appendChild(summary);
		backup.appendChild(this.button('Save to disk', 'Write a backup file you can keep', function() {
			self.exportFile();
		}, 'saves-primary'));
		var fileLabel = document.createElement('label');
		fileLabel.className = 'saves-button saves-file';
		fileLabel.textContent = 'Load from disk';
		var file = document.createElement('input');
		file.type = 'file';
		file.accept = '.save,.json,application/json';
		file.addEventListener('change', function(event) {
			var selected = event.target.files[0];
			if (!selected) return;
			if (selected.size > 20 * 1024 * 1024) { self.fail('Import failed. The file exceeds 20 MB.'); return; }
			self.confirm('Load this file and replace the current unsaved game?', function() {
				selected.text().then(function(text) { self.importText(text); }, function() { self.fail('Could not read the file.'); });
			});
		});
		fileLabel.appendChild(file);
		backup.appendChild(fileLabel);
		body.appendChild(backup);
		var list = document.createElement('div');
		list.className = 'saves-slots';
		list.appendChild(this.buildSlotRow('auto'));
		for (var index = 0; index < this.SLOT_COUNT; index++) {
			list.appendChild(this.buildSlotRow(index));
		}
		body.appendChild(list);
		return body;
	},
	buildSlotRow: function(index) {
		var self = this;
		var save = this.getSlot(index);
		var row = document.createElement('div');
		row.className = 'saves-slot' + (save ? '' : ' saves-slot-empty');
		row.dataset.slot = String(index);
		var detail = document.createElement('div');
		detail.className = 'saves-detail';
		var heading = document.createElement('span');
		heading.className = 'saves-slot-name';
		var meta = save && save.metadata ? save.metadata : {};
		heading.textContent = index === 'auto' ? 'Sleep autosave' : 'Slot ' + (index + 1) + (meta.automatic ? ' (legacy autosave)' : '');
		detail.appendChild(heading);
		var line = document.createElement('span');
		line.className = 'small-description';
		if (save) {
			var saved = save.date ? new Date(save.date) : null;
			line.textContent = (meta.place || save.title || 'Saved game')
				+ (meta.when ? ' · ' + meta.when : '')
				+ (saved ? ' · saved ' + saved.toLocaleDateString() : '');
		} else {
			line.textContent = 'Empty';
		}
		detail.appendChild(line);
		row.appendChild(detail);
		var actions = document.createElement('div');
		actions.className = 'saves-actions';
		if (index !== 'auto') actions.appendChild(this.button(save ? 'Overwrite' : 'Save', 'Save the game into this slot', function() {
			if (save) self.confirm('Overwrite Slot ' + (index + 1) + '? The existing save will be replaced.', function() { self.save(index); });
			else { self.save(index); self.refresh(); }
		}, 'saves-primary'));
		if (save) {
			actions.appendChild(this.button('Load', 'Load this save', function() {
				self.confirm('Load this save and replace the current unsaved game?', function() { return self.load(index); });
			}));
			actions.appendChild(this.button('Delete', 'Delete this save', function() {
				self.confirm('Delete this save? This cannot be undone without an exported backup.', function() { self.remove(index); });
			}, 'saves-danger'));
		}
		row.appendChild(actions);
		return row;
	},
	refresh: function() {
		var body = document.querySelector('#ui-dialog-body .saves-menu');
		if (body && body.parentNode) {
			body.parentNode.replaceChild(this.buildMenu(), body);
		}
	},
	showDialog: function() {
		if (typeof Dialog === 'undefined') {
			return;
		}
		Dialog.setup('Saves', 'saves');
		Dialog.append(this.buildMenu());
		Dialog.open();
	}
};
// The backup reminder, at the top of the screen where it cannot be missed.
Macro.add('saveReminder', {
	handler: function() {
		if (setup.saves.error) {
			var warning = document.createElement('p'); warning.className = 'save-reminder'; warning.setAttribute('role', 'alert');
			warning.textContent = setup.saves.message + ' ';
			warning.appendChild(setup.saves.button('Saves', 'Open saves and export a backup', function() { setup.saves.showDialog(); }));
			this.output.appendChild(warning);
		}
		if (!setup.saves.shouldRemind()) {
			return;
		}
		var notice = document.createElement('div');
		notice.className = 'save-reminder';
		var text = document.createElement('span');
		text.textContent = setup.saves.describeReminder();
		notice.appendChild(text);
		notice.appendChild(setup.saves.button('Back up now', 'Open the saves menu', function() {
			setup.saves.showDialog();
		}, 'saves-primary'));
		notice.appendChild(setup.saves.button('Later', 'Hide this until next time', function() {
			setup.saves.dismissed = true;
			notice.remove();
		}));
		this.output.appendChild(notice);
	}
});
// The sidebar's Saves button opens this menu rather than the engine's plain slot list.
jQuery(document).one(':storyready', function() {
	jQuery(document).on('click', '#menu-item-saves a', function(event) {
		event.preventDefault();
		event.stopImmediatePropagation();
		setup.saves.showDialog();
	});
});
