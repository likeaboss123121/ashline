// Authoring tools only. Do not put this catalogue, filters or search results in State.variables.
// New AI-written interface wording is explicitly marked, just like future game prose.
setup.textWiki = {
	appendWarning: function(parent) {
		var count=setup.textWritingPendingCount||0;
		if(!count) return;
		var warning=document.createElement('p');
		warning.setAttribute('role','alert');warning.dataset.writingWarning='';
		var text=document.createElement('strong');
		text.textContent='[NEEDS WRITING PASS] — Writing review outstanding: '+count+' marked text entries. See Wiki → Game text → Only marked text.';
		warning.appendChild(text);parent.appendChild(warning);
	},
	selection: { query: '', category: '', file: '', placeholders: false, page: 0, mode: 'tokens' },
	overrides: new Map(),
	previewContext: function(row,interactive) {
		if(!this.overrides.has(row)) this.overrides.set(row,Object.create(null));
		return {mode:this.selection.mode,overrides:this.overrides.get(row),bindings:row[6]||[],interactive:interactive,
			source:row[2]?{file:row[1],line:row[2]}:null};
	},
	entries: null,
	categories: {
		passages: '[NEEDS WRITING PASS] — Passages and sidebar text',
		scripts: '[NEEDS WRITING PASS] — Script text, labels and templates',
		graphics: '[NEEDS WRITING PASS] — SVG captions and text',
		styles: '[NEEDS WRITING PASS] — CSS text',
		world: '[NEEDS WRITING PASS] — Geographic names and data text',
		engine: '[NEEDS WRITING PASS] — SugarCube interface text'
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
				(!selection.placeholders || (typeof row[5] === 'boolean' ? row[5] : /\[NEEDS WRITING PASS\]/.test(row[4]))) &&
				(!needle || [row[1] + (row[2] ? ':' + row[2] : ''), row[3], row[4]].join('\n').toLocaleLowerCase().indexOf(needle) !== -1);
		});
	},
	appendBrowser: function(parent) {
		var self = this, section = setup.svgWiki.folder(parent, '[NEEDS WRITING PASS] — Game text', 'text');
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
		note.textContent = '[NEEDS WRITING PASS] — This is the Game Text reader. Use this to find how text appears, and where it\'s located in the code.';
		section.appendChild(note);
		function field(labelText, element) {
			var p = document.createElement('p'), label = document.createElement('label');
			element.setAttribute('aria-label', labelText);
			label.appendChild(document.createTextNode(labelText + ' ')); label.appendChild(element);
			p.appendChild(label); section.appendChild(p); element.style.maxWidth = '100%'; return element;
		}
		var query = field('[NEEDS WRITING PASS] — Search', document.createElement('input'));
		query.type = 'search'; query.value = state.query;
		function picker(label, entries, selected) {
			var select = field(label, document.createElement('select'));
			entries.forEach(function(pair) {
				var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; select.appendChild(option);
			});
			select.value = selected; return select;
		}
		var category = picker('[NEEDS WRITING PASS] — Category', [['', '[NEEDS WRITING PASS] — All categories']].concat(
			Object.keys(this.categories).map(function(key) { return [key, self.categories[key]]; })), state.category);
		var mode=picker('[NEEDS WRITING PASS] — Preview default',[
			['zero','0 / null'],['memory','Current values'],['tokens','[VALUE], [LINK], [STAT]']
		],state.mode);
		var file = field('[NEEDS WRITING PASS] — Source', document.createElement('select'));
		function files() {
			file.replaceChildren();
			[['', '[NEEDS WRITING PASS] — All sources']].concat(Array.from(new Set(rows.filter(function(row) {
				return !state.category || row[0] === state.category;
			}).map(function(row) { return row[1]; }))).sort().map(function(name) { return [name,name]; })).forEach(function(pair) {
				var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; file.appendChild(option);
			});
			file.value = state.file;
		}
		files();
		var placeholders = field('[NEEDS WRITING PASS] — View pending unfinished writing passes', document.createElement('input'));
		placeholders.type = 'checkbox'; placeholders.checked = state.placeholders;
		var count = document.createElement('p'); count.setAttribute('role', 'status'); section.appendChild(count);
		var results = document.createElement('div'); results.dataset.textResults = ''; section.appendChild(results);
		var nav = document.createElement('p'); section.appendChild(nav);
		// show() clamps the page, so Last can ask for any page past the end.
		function button(label, target) {
			var b = document.createElement('button'); b.type = 'button'; b.textContent = label;
			b.addEventListener('click', function() { state.page = target(); show(); }); nav.appendChild(b); return b;
		}
		var first = button('[NEEDS WRITING PASS] — First', function() { return 0; });
		var previous = button('[NEEDS WRITING PASS] — Previous', function() { return state.page - 1; });
		var jump = document.createElement('input'); jump.type = 'number'; jump.min = 1; jump.step = 1; jump.style.width = '6em';
		jump.setAttribute('aria-label', '[NEEDS WRITING PASS] — Page number'); nav.appendChild(jump);
		jump.addEventListener('change', function() {
			var page = Math.floor(Number(jump.value));
			if (jump.value !== '' && isFinite(page)) state.page = page - 1;
			show();
		});
		var next = button('[NEEDS WRITING PASS] — Next', function() { return state.page + 1; });
		var last = button('[NEEDS WRITING PASS] — Last', function() { return Infinity; });
		function show() {
			var opened=new Set(Array.from(results.children).filter(function(entry){return entry.open;}).map(function(entry){return entry.textRow;}));
			var matches = self.find(state), pages = Math.max(1, Math.ceil(matches.length / 25));
			state.page = Math.max(0, Math.min(state.page, pages - 1));
			count.textContent = '[NEEDS WRITING PASS] — ' + matches.length + ' entries; page ' + (state.page + 1) + ' / ' + pages;
			first.disabled = previous.disabled = state.page === 0; next.disabled = last.disabled = state.page + 1 >= pages;
			jump.max = pages; jump.value = state.page + 1;
			results.replaceChildren();
			matches.slice(state.page * 25, state.page * 25 + 25).forEach(function(row) {
				var entry = document.createElement('details'), summary = document.createElement('summary');
				var preview = setup.textPreview.render(row[4],self.previewContext(row,false));
				entry.textRow=row;
				entry.className = 'debug-section';
				summary.textContent = row[1] + (row[2] ? ':' + row[2] : '') + (row[0] === 'passages' && row[3] ? ' — ' + row[3] : '') +
					' — ' + preview.textContent.replace(/\s+/g, ' ').slice(0, 110);
				summary.style.overflowWrap = 'anywhere'; entry.appendChild(summary);
				entry.addEventListener('toggle', function() {
					if (!entry.open || entry.querySelector('[data-text-preview]')) return;
					entry.appendChild(setup.textPreview.render(row[4],self.previewContext(row,true)));
				});
				entry.open=opened.has(row);
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
		mode.addEventListener('change',function(){state.mode=mode.value;show();});
		file.addEventListener('change', function() { state.file = file.value; state.page = 0; show(); });
		placeholders.addEventListener('change', function() { state.placeholders = placeholders.checked; state.page = 0; show(); });
		show();
	}
};
