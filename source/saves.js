// Saves, and reminding the player that a browser is not a safe place to keep them.
//
// Saves live in this browser's storage. Clearing site data, a private window closing, or a browser tidying up after
// itself takes them with it, and the player has no warning. So the menu here shows what each slot actually holds
// (where the train is, what the date is, how long has been played), keeps saving and loading in one place, and a
// banner asks for a backup to disk when it has been a while since the last one.
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
		var station = Number(variables.currentStation) || 1;
		var place = variables.journey ? 'On the line past Station ' + station : 'Station ' + station;
		return {
			place: place,
			when: parts.month + ' ' + parts.day + ', ' + parts.year + ', ' + parts.hours + ':' + parts.minutes
				+ (parts.meridiem ? ' ' + parts.meridiem : ''),
			turns: State.turns
		};
	},
	save: function(index) {
		var slots = this.slotApi();
		if (!slots || !slots.save) {
			return false;
		}
		var detail = this.describeCurrent();
		slots.save(index, detail.place, detail);
		this.countSave();
		return true;
	},
	load: function(index) {
		var slots = this.slotApi();
		if (slots && slots.load) {
			slots.load(index);
			return true;
		}
		return false;
	},
	remove: function(index) {
		var slots = this.slotApi();
		if (slots && slots.delete) {
			slots.delete(index);
			return true;
		}
		return false;
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
			var disk = self.diskApi();
			if (disk && disk.save) {
				disk.save('ashline-' + new Date().toISOString().slice(0, 10));
				self.markExported();
				self.refresh();
			}
		}, 'saves-primary'));

		var fileLabel = document.createElement('label');
		fileLabel.className = 'saves-button saves-file';
		fileLabel.textContent = 'Load from disk';
		var file = document.createElement('input');
		file.type = 'file';
		file.accept = '.save,.json,application/json';
		file.addEventListener('change', function(event) {
			var disk = self.diskApi();
			if (disk && disk.load) {
				disk.load(event);
			}
		});
		fileLabel.appendChild(file);
		backup.appendChild(fileLabel);
		body.appendChild(backup);

		var list = document.createElement('div');
		list.className = 'saves-slots';
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
		heading.textContent = 'Slot ' + (index + 1);
		detail.appendChild(heading);
		var line = document.createElement('span');
		line.className = 'small-description';
		if (save) {
			var meta = save.metadata || {};
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
		actions.appendChild(this.button(save ? 'Overwrite' : 'Save', 'Save the game into this slot', function() {
			self.save(index);
			self.refresh();
		}, 'saves-primary'));
		if (save) {
			actions.appendChild(this.button('Load', 'Load this save', function() {
				if (typeof Dialog !== 'undefined') {
					Dialog.close();
				}
				self.load(index);
			}));
			actions.appendChild(this.button('Delete', 'Delete this save', function() {
				self.remove(index);
				self.refresh();
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
