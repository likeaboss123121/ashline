// Page layout and session-only navigation state never belong in saved game data.
if (typeof Config !== 'undefined') Config.passages.nobr = true;
// SugarCube removes its history markup at startup when controls are disabled.
// Restore those same native controls when the player opts in during a run.
setup.refreshHistoryControls = function() {
	var controls = document.getElementById('ui-bar-history');
	if (!Config.history.controls) { if (controls) controls.hidden = true; return; }
	if (!controls) {
		var toggle = document.getElementById('ui-bar-toggle');
		if (!toggle) return;
		controls = document.createElement('div'); controls.id = 'ui-bar-history';
		[['backward', '\uE821', 'uiBarBackward'], ['forward', '\uE822', 'uiBarForward']].forEach(function(spec) {
			var button = document.createElement('button'); button.id = 'history-' + spec[0]; button.type = 'button';
			button.textContent = spec[1]; button.title = L10n.get(spec[2]);
			jQuery(button).ariaClick({ label: button.title }, function() { Engine[spec[0]](); });
			controls.appendChild(button);
		});
		toggle.parentElement.appendChild(controls);
	}
	controls.hidden = false;
	jQuery('#history-backward').ariaDisabled(State.length < 2);
	jQuery('#history-forward').ariaDisabled(State.length === State.size);
};
jQuery(document).on(':historyupdate.ashline-ui', function() { setup.applyHistorySetting(); });
setup.pages = {
	open: function(name) {
		if (State.passage !== 'Help') State.variables.utilityReturn = State.passage;
		Engine.play(name);
	},
	disclosures: function(root) {
		root.querySelectorAll('details').forEach(function(section) {
			var summary = section.querySelector(':scope > summary');
			if (!summary || summary.querySelector('[data-disclosure-label]')) return;
			var label = document.createElement('span'); label.dataset.disclosureLabel = '';
			while (summary.firstChild) label.appendChild(summary.firstChild);
			var marker = document.createElement('span'); marker.setAttribute('aria-hidden', 'true');
			summary.appendChild(marker); summary.appendChild(label);
			function update() { marker.textContent = section.open ? '− ' : '+ '; }
			section.addEventListener('toggle', update); update();
		});
	}
};
// Reuse the existing locomotive disclosure style for optional passage controls.
Macro.add('uiSection', {
	tags: null,
	handler: function() {
		var body = document.createElement('div'); body.className = 'loco-stats';
		new Wikifier(body, this.payload[0].contents);
		if (!body.textContent.trim()) return;
		var section = document.createElement('details'); section.className = 'loco-panel';
		section.dataset.uiSection = this.args[0];
		var saved = setup.pendingSections || {};
		section.open = Object.prototype.hasOwnProperty.call(saved, this.args[0]) ? saved[this.args[0]] : this.args[2] === true;
		var summary = document.createElement('summary');
		summary.textContent = this.args[1];
		section.appendChild(summary); section.appendChild(body); this.output.appendChild(section);
	}
});
// Inspect the shipped artwork, without copying image data into saves or drawing the whole catalogue.
setup.svgWiki = {
	folder: function(parent, title, key) {
		var folder = document.createElement('details'); folder.className = 'debug-section';
		folder.dataset.wikiFolder = key;
		var summary = document.createElement('summary'); summary.textContent = title;
		folder.appendChild(summary); parent.appendChild(folder); return folder;
	},
	carCategory: function(car) {
		if (/ loco$/.test(car.type)) return 'Locomotives';
		return /coach|observation|kitchen|private/.test(car.type) ? 'Passenger cars' : 'Freight cars';
	},
	assetCategory: function(template) {
		var name = template.passage.replace(/^(railyard|driving)-/, '');
		if (name.indexOf('loco-') === 0) return 'Locomotives';
		if (name.indexOf('car-') === 0) return /^car-(passenger|sleeper|observation|kitchen|private)(?:-|$)/.test(name) ? 'Passenger cars' : 'Freight cars';
		return ({ track: 'Tracks', bridge: 'Bridges', building: 'Buildings', plant: 'Vegetation and rocks',
			industry: 'Industry', terrain: 'Terrain and backgrounds' })[name.split('-')[0]] || 'Other';
	},
	catalogue: function() {
		return setup.railyardTemplates.templates.concat(setup.drivingTemplates.templates);
	},
	preview: function(parent, template) {
		var figure = document.createElement('figure');
		figure.style.margin = '1em 0';
		var caption = document.createElement('figcaption');
		caption.textContent = template.file + ' (' + template.width + ' × ' + template.height + ')';
		var description = document.createElement('p'); description.textContent = template.title;
		figure.appendChild(description);
		figure.appendChild(caption);
		var source = Story.has(template.passage) ? Story.get(template.passage).text.trim() : '';
		if (/^data:image\/svg\+xml[;,]/i.test(source)) {
			var img = document.createElement('img');
			img.alt = template.title;
			img.src = source;
			img.width = template.width * 3;
			img.style.maxWidth = '100%';
			img.style.height = 'auto';
			figure.appendChild(img);
		} else {
			var missing = document.createElement('p'); missing.textContent = 'SVG unavailable.';
			figure.appendChild(missing);
		}
		parent.appendChild(figure);
	},
	carEntry: function(car, label) {
		var entry = document.createElement('div'); entry.textContent = label;
		var section = document.createElement('details'); section.className = 'debug-section';
		var summary = document.createElement('summary'); summary.textContent = 'Graphics — ' + label;
		section.appendChild(summary);
		var loaded = false;
		section.addEventListener('toggle', function() {
			if (!section.open || loaded) return;
			loaded = true;
			// Use exactly the same model/type resolution as the actual views (including both facings).
			var names = [];
			['railyard', 'driving'].forEach(function(prefix) { names = names.concat(setup.stockVariety.artNames(car, prefix)); });
			[setup.railyardView, setup.drivingView].forEach(function(view) {
				[false, true].forEach(function(flipped) { names.push(view.getCarTemplateName(car, flipped)); });
			});
			setup.svgWiki.catalogue().filter(function(template) { return names.indexOf(template.passage) >= 0; })
				.forEach(function(template) { setup.svgWiki.preview(section, template); });
		});
		entry.appendChild(section); return entry;
	},
	appendBrowser: function(parent) {
		var section = this.folder(parent, 'SVG browser', 'svg');
		section.id = 'wiki-svg-browser';
		var views = {}, folders = {};
		this.catalogue().forEach(function(template) {
			var view = template.passage.indexOf('railyard-') === 0 ? 'Railyard' : 'Driving';
			var category = setup.svgWiki.assetCategory(template), key = view + '/' + category;
			if (!views[view]) views[view] = setup.svgWiki.folder(section, view, 'svg/' + view);
			if (!folders[key]) folders[key] = { parent: setup.svgWiki.folder(views[view], category, 'svg/' + key), templates: [] };
			folders[key].templates.push(template);
		});
		Object.keys(folders).forEach(function(key) {
			setup.svgWiki.appendPicker(folders[key].parent, folders[key].templates, key);
		});
	},
	appendPicker: function(section, entries, key) {
		var loaded = false;
		section.addEventListener('toggle', function() {
			if (!section.open || loaded) return;
			loaded = true;
			var label = document.createElement('label'); label.textContent = 'Graphic: ';
			var select = document.createElement('select'); select.setAttribute('aria-label', 'SVG graphic: ' + key);
			select.style.maxWidth = '100%';
			var templates = entries.slice().sort(function(a, b) { return a.file.localeCompare(b.file); });
			templates.forEach(function(template, index) {
				var option = document.createElement('option'); option.value = String(index); option.textContent = template.file;
				select.appendChild(option);
			});
			label.appendChild(select); section.appendChild(label);
			var preview = document.createElement('div'); section.appendChild(preview);
			function show() {
				preview.replaceChildren();
				if (templates[select.value]) setup.svgWiki.preview(preview, templates[select.value]);
			}
			select.addEventListener('change', show); show();
		});
	}
};
setup.sideTabs = {
	active: null,
	refresh: function() {
		var old = document.getElementById('developer-tabs'), previous = old && old.querySelector('.developer-panel:not([hidden])');
		var scroll = previous ? previous.scrollTop : 0;
		function sectionKey(s) { return s.parentElement.dataset.wikiFolder || (s.querySelector('[data-disclosure-label]') || s).textContent; }
		var opened = old ? Array.from(old.querySelectorAll('details[open] > summary')).map(sectionKey) : [];
		if (old) old.remove();
		document.querySelectorAll('#menu-story .developer-menu-item').forEach(function(item) { item.remove(); });
		// The debug tools belong to a game in progress, never to the title, the introduction or save recovery.
		if (!State.variables.debugMode || !setup.isInGame()) { this.active = null; return; }
		var menu = document.getElementById('menu-story'); if (!menu) return;
		var root = document.createElement('aside'); root.id = 'developer-tabs';
		var self = this;
		function close() {
			var selected = self.active; self.active = null; self.refresh();
			var button = document.querySelector('[aria-controls="developer-' + selected + '"]'); if (button) button.focus();
		}
		['Debug', 'Wiki'].forEach(function(name) {
			var item = document.createElement('li'); item.className = 'developer-menu-item';
			var b = document.createElement('a'); b.textContent = name; b.tabIndex = 0; b.setAttribute('role', 'button');
			b.setAttribute('aria-controls', 'developer-' + name); b.setAttribute('aria-expanded', self.active === name ? 'true' : 'false');
			b.addEventListener('click', function() { self.active = self.active === name ? null : name; self.refresh();
				var panel = document.getElementById('developer-' + name); if (panel && !panel.hidden) panel.focus(); });
			b.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
			item.appendChild(b); menu.appendChild(item);
			var panel = document.createElement('section'); panel.id = 'developer-' + name; panel.className = 'developer-panel';
			panel.setAttribute('aria-label', name); panel.tabIndex = -1; panel.hidden = self.active !== name;
			var dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'developer-close'; dismiss.textContent = 'Close ' + name;
			dismiss.addEventListener('click', close); panel.appendChild(dismiss);
			root.appendChild(panel);
		});
		var debug = root.querySelector('#developer-Debug'), wiki = root.querySelector('#developer-Wiki');
		new Wikifier(debug, '<<debugTools>>');
		var reference = debug.querySelector('.procedural-wiki');
		if (reference) { reference.open = true; wiki.appendChild(reference); }
		setup.svgWiki.appendBrowser(wiki);
		setup.textWiki.appendBrowser(wiki);
		root.querySelectorAll('details > summary').forEach(function(s) { if (opened.indexOf(sectionKey(s)) >= 0) s.parentElement.open = true; });
		root.addEventListener('keydown', function(e) { if (e.key === 'Escape') close(); });
		document.body.appendChild(root);
		setup.pages.disclosures(root);
		var current = root.querySelector('.developer-panel:not([hidden])'); if (current) current.scrollTop = scroll;
	}
};
// Browser-console shortcut for an existing run. Reading `debug` is intentional: it lets the player type exactly
// that word in the console. The returned function also keeps `debug()` useful for people who add parentheses.
setup.enableDebugMode = function() {
	if (typeof State === 'undefined' || !State.variables) return 'Ashline is not ready yet.';
	State.variables.debugMode = true;
	setup.sideTabs.refresh();
	return setup.isInGame() ? 'Ashline debug mode enabled.'
		: 'Ashline debug mode enabled. The debug tools appear once the game has started.';
};
if (typeof window !== 'undefined') {
	var ashlineDebugCommand = function() { return setup.enableDebugMode(); };
	Object.defineProperty(window, 'debug', {
		configurable: true,
		get: function() {
			setup.enableDebugMode();
			return ashlineDebugCommand;
		}
	});
}
jQuery(document).on(':passageinit.ashline-ui', function(event) {
	setup.pendingSections = {};
	if (State.passage === event.passage.title) document.querySelectorAll('#passages details[data-ui-section]').forEach(function(section) {
		setup.pendingSections[section.dataset.uiSection] = section.open;
	});
	var map = document.querySelector('.railyard-view-scroll');
	setup.pendingScroll = State.variables.preserveScroll !== false && State.passage === event.passage.title
		? { x: window.scrollX, y: window.scrollY, mapX: map ? map.scrollLeft : 0, mapY: map ? map.scrollTop : 0 } : null;
});
jQuery(document).on(':passageend.ashline-ui', function() {
	setup.pages.disclosures(document.getElementById('passages'));
	setup.sideTabs.refresh();
	var saved = setup.pendingScroll; setup.pendingScroll = null;
	if (saved) requestAnimationFrame(function() {
		var map = document.querySelector('.railyard-view-scroll');
		if (map) { map.scrollLeft = saved.mapX; map.scrollTop = saved.mapY; }
		window.scrollTo(saved.x, saved.y);
	});
});
