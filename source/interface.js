// Page layout and session-only navigation state never belong in saved game data.
if (typeof Config !== 'undefined') Config.passages.nobr = true;
setup.pages = {
	open: function(name) {
		if (State.passage !== 'Help' && State.passage !== 'Journal') State.variables.utilityReturn = State.passage;
		Engine.play(name);
	}
};
setup.sideTabs = {
	active: null,
	refresh: function() {
		var old = document.getElementById('developer-tabs'), previous = old && old.querySelector('.developer-panel:not([hidden])');
		var scroll = previous ? previous.scrollTop : 0;
		var opened = old ? Array.from(old.querySelectorAll('details[open] > summary')).map(function(s) { return s.textContent; }) : [];
		if (old) old.remove();
		if (!State.variables.debugMode || State.passage === 'Start') { this.active = null; return; }
		var root = document.createElement('aside'); root.id = 'developer-tabs';
		var buttons = document.createElement('div'); buttons.className = 'developer-tab-buttons';
		root.appendChild(buttons);
		var self = this;
		['Debug', 'Wiki'].forEach(function(name) {
			var b = document.createElement('button'); b.type = 'button'; b.textContent = name;
			b.setAttribute('aria-controls', 'developer-' + name); b.setAttribute('aria-expanded', self.active === name ? 'true' : 'false');
			b.addEventListener('click', function() { self.active = self.active === name ? null : name; self.refresh();
				var panel = document.getElementById('developer-' + name); if (panel && !panel.hidden) panel.focus(); });
			buttons.appendChild(b);
			var panel = document.createElement('section'); panel.id = 'developer-' + name; panel.className = 'developer-panel';
			panel.setAttribute('aria-label', name); panel.tabIndex = -1; panel.hidden = self.active !== name;
			root.appendChild(panel);
		});
		var debug = root.querySelector('#developer-Debug'), wiki = root.querySelector('#developer-Wiki');
		new Wikifier(debug, '<<debugTools>>');
		var reference = debug.querySelector('.procedural-wiki');
		if (reference) { reference.open = true; wiki.appendChild(reference); }
		root.querySelectorAll('details > summary').forEach(function(s) { if (opened.indexOf(s.textContent) >= 0) s.parentElement.open = true; });
		root.addEventListener('keydown', function(e) { if (e.key === 'Escape') { var selected = self.active; self.active = null; self.refresh();
			var button = document.querySelector('[aria-controls="developer-' + selected + '"]'); if (button) button.focus(); } });
		document.body.appendChild(root);
		var current = root.querySelector('.developer-panel:not([hidden])'); if (current) current.scrollTop = scroll;
	}
};
jQuery(document).on(':passageinit.ashline-ui', function(event) {
	var map = document.querySelector('.railyard-view-scroll');
	setup.pendingScroll = State.variables.preserveScroll !== false && State.passage === event.passage.title
		? { x: window.scrollX, y: window.scrollY, mapX: map ? map.scrollLeft : 0, mapY: map ? map.scrollTop : 0 } : null;
});
jQuery(document).on(':passageend.ashline-ui', function() {
	setup.sideTabs.refresh();
	var saved = setup.pendingScroll; setup.pendingScroll = null;
	if (saved) requestAnimationFrame(function() {
		var map = document.querySelector('.railyard-view-scroll');
		if (map) { map.scrollLeft = saved.mapX; map.scrollTop = saved.mapY; }
		window.scrollTo(saved.x, saved.y);
	});
});
