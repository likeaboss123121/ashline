// Page layout and session-only navigation state never belong in saved game data.
if (typeof Config !== 'undefined') Config.passages.nobr = true;
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
setup.sideTabs = {
	active: null,
	refresh: function() {
		var old = document.getElementById('developer-tabs'), previous = old && old.querySelector('.developer-panel:not([hidden])');
		var scroll = previous ? previous.scrollTop : 0;
		var opened = old ? Array.from(old.querySelectorAll('details[open] > summary')).map(function(s) { return (s.querySelector('[data-disclosure-label]') || s).textContent; }) : [];
		if (old) old.remove();
		document.querySelectorAll('#menu-story .developer-menu-item').forEach(function(item) { item.remove(); });
		if (!State.variables.debugMode || State.passage === 'Start') { this.active = null; return; }
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
		root.querySelectorAll('details > summary').forEach(function(s) { if (opened.indexOf(s.textContent) >= 0) s.parentElement.open = true; });
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
	return 'Ashline debug mode enabled.';
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
