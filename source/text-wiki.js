// Authoring tools only. Do not put this catalogue, filters or search results in State.variables.
// New AI-written interface wording is explicitly marked, just like future game prose.
setup.textWiki = {
	selection: { query: '', category: '', file: '', placeholders: false, page: 0 },
	entries: null,
	categories: {
		passages: 'PLACEHOLDER — Passages and sidebar text',
		scripts: 'PLACEHOLDER — Script text, labels and templates',
		graphics: 'PLACEHOLDER — SVG captions and text',
		styles: 'PLACEHOLDER — CSS text',
		world: 'PLACEHOLDER — Geographic names and data text',
		engine: 'PLACEHOLDER — SugarCube interface text'
	},
	catalogue: function() {
		if (this.entries) return this.entries;
		var rows = JSON.parse(setup.textCatalogueSource || '[]');
		function strings(value, location, category, source) {
			if (typeof value === 'string') {
				if (value.trim()) rows.push([category, source, 0, location, value]);
			} else if (value && typeof value === 'object') {
				// The large geographic coordinate arrays contain no writing.
				if (Array.isArray(value) && value.every(function(v) { return typeof v === 'number'; })) return;
				Object.keys(value).forEach(function(key) { strings(value[key], location + '.' + key, category, source); });
			}
		}
		strings(setup.worldGraphData, 'setup.worldGraphData', 'world', 'source/world-data.js');
		if (typeof l10nStrings !== 'undefined') strings(l10nStrings, 'l10nStrings', 'engine', 'SugarCube');
		this.entries = rows;
		return rows;
	},
	find: function(selection) {
		var needle = selection.query.trim().toLocaleLowerCase();
		return this.catalogue().filter(function(row) {
			return (!selection.category || row[0] === selection.category) && (!selection.file || row[1] === selection.file) &&
				(!selection.placeholders || /\bPLACEHOLDER\b/.test(row[4])) &&
				(!needle || [row[1], row[3], row[4]].join('\n').toLocaleLowerCase().indexOf(needle) !== -1);
		});
	},
	appendBrowser: function(parent) {
		var self = this, section = setup.svgWiki.folder(parent, 'PLACEHOLDER — Game text', 'text');
		section.id = 'wiki-text-browser';
		var loaded = false;
		section.addEventListener('toggle', function() {
			if (!section.open || loaded) return;
			loaded = true; self.controls(section); setup.pages.disclosures(section);
		});
	},
	controls: function(section) {
		var self = this, state = this.selection, rows = this.catalogue();
		var note = document.createElement('p');
		note.textContent = 'PLACEHOLDER — Read-only source text, including inactive branches and internal identifiers. Markup is shown, never executed. {Expressions} are dynamic values. Existing unmarked text has unverified authorship; new AI-written text must say PLACEHOLDER.';
		section.appendChild(note);
		function field(labelText, element) {
			var p = document.createElement('p'), label = document.createElement('label');
			element.setAttribute('aria-label', labelText);
			label.appendChild(document.createTextNode(labelText + ' ')); label.appendChild(element);
			p.appendChild(label); section.appendChild(p); element.style.maxWidth = '100%'; return element;
		}
		var query = field('PLACEHOLDER — Search', document.createElement('input'));
		query.type = 'search'; query.value = state.query;
		function picker(label, entries, selected) {
			var select = field(label, document.createElement('select'));
			entries.forEach(function(pair) {
				var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; select.appendChild(option);
			});
			select.value = selected; return select;
		}
		var category = picker('PLACEHOLDER — Category', [['', 'PLACEHOLDER — All categories']].concat(
			Object.keys(this.categories).map(function(key) { return [key, self.categories[key]]; })), state.category);
		var file = field('PLACEHOLDER — Source', document.createElement('select'));
		function files() {
			file.replaceChildren();
			[['', 'PLACEHOLDER — All sources']].concat(Array.from(new Set(rows.filter(function(row) {
				return !state.category || row[0] === state.category;
			}).map(function(row) { return row[1]; }))).sort().map(function(name) { return [name,name]; })).forEach(function(pair) {
				var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; file.appendChild(option);
			});
			file.value = state.file;
		}
		files();
		var placeholders = field('PLACEHOLDER — Only marked text', document.createElement('input'));
		placeholders.type = 'checkbox'; placeholders.checked = state.placeholders;
		var count = document.createElement('p'); count.setAttribute('role', 'status'); section.appendChild(count);
		var results = document.createElement('div'); results.dataset.textResults = ''; section.appendChild(results);
		var nav = document.createElement('p'); section.appendChild(nav);
		function button(label, change) {
			var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
			b.addEventListener('click', function() { state.page += change; show(); }); nav.appendChild(b); return b;
		}
		var previous = button('PLACEHOLDER — Previous', -1), next = button('PLACEHOLDER — Next', 1);
		function show() {
			var matches = self.find(state), pages = Math.max(1, Math.ceil(matches.length / 25));
			state.page = Math.max(0, Math.min(state.page, pages - 1));
			count.textContent = 'PLACEHOLDER — ' + matches.length + ' entries; page ' + (state.page + 1) + ' / ' + pages;
			previous.disabled = state.page === 0; next.disabled = state.page + 1 >= pages;
			results.replaceChildren();
			matches.slice(state.page * 25, state.page * 25 + 25).forEach(function(row) {
				var entry = document.createElement('details'), summary = document.createElement('summary');
				entry.className = 'debug-section';
				summary.textContent = row[1] + (row[2] ? ':' + row[2] : '') + (row[3] ? ' — ' + row[3] : '') +
					' — ' + row[4].replace(/\s+/g, ' ').slice(0, 110);
				summary.style.overflowWrap = 'anywhere'; entry.appendChild(summary);
				entry.addEventListener('toggle', function() {
					if (!entry.open || entry.querySelector('pre')) return;
					var text = document.createElement('pre'); text.textContent = row[4];
					text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; entry.appendChild(text);
				});
				results.appendChild(entry);
			});
			setup.pages.disclosures(results);
		}
		var timer;
		query.addEventListener('input', function() {
			state.query = query.value; state.page = 0; clearTimeout(timer);
			timer = setTimeout(function() { if (section.isConnected) show(); }, 120);
		});
		category.addEventListener('change', function() { state.category = category.value; state.file = ''; state.page = 0; files(); show(); });
		file.addEventListener('change', function() { state.file = file.value; state.page = 0; show(); });
		placeholders.addEventListener('change', function() { state.placeholders = placeholders.checked; state.page = 0; show(); });
		show();
	}
};
