// Driving view: draws the consist on the tile it currently occupies, using the SVG templates in
// source/img/driving/ and the placement data in driving-templates.js.
//
// The camera is perpendicular to the train (yaw 90) and pitched 45 degrees down, with the train's
// forward to the right, so the consist reads as a side view with the top of every car showing. The
// tile's terrain is drawn behind it, the track under it, and the whole line is tilted by the tile's
// grade. The view reads game state only. See docs/DRIVING_ART.md.
setup.drivingView = {
	SVG_NS: 'http://www.w3.org/2000/svg',
	XLINK_NS: 'http://www.w3.org/1999/xlink',
	SCALE: 2, // whole-number zoom keeps the pixel art crisp
	CAR_GAP_UNITS: 1,
	MARGIN_UNITS: 30, // track and terrain drawn past each end of the consist
	PADDING: 2,
	MAX_TILT_DEGREES: 3,

	getTemplate: function(name) {
		if (!this.templatesByName) {
			this.templatesByName = {};
			var templates = setup.drivingTemplates.templates;
			for (var i = 0; i < templates.length; i++) {
				this.templatesByName[templates[i].passage] = templates[i];
			}
		}
		return this.templatesByName[name] || null;
	},

	// Tweego bundles each template SVG as an image passage whose text is a data URI.
	getImageSource: function(name) {
		if (!Story.has(name)) {
			return '';
		}
		var passage = Story.get(name);
		return passage.tags.includes('Twine.image') ? String(passage.text).trim() : '';
	},

	// Copies a template's shapes out of its image passage into a <g> the view can place with <use>.
	createTemplateGroup: function(name, id) {
		if (!this.templateDocuments) {
			this.templateDocuments = {};
		}
		if (!this.templateDocuments[name]) {
			var source = this.getImageSource(name);
			var comma = source.indexOf(',');
			if (comma === -1) {
				throw new Error('driving template "' + name + '" is not bundled');
			}
			var header = source.slice(0, comma);
			var body = source.slice(comma + 1);
			var text = /;base64/i.test(header) ? atob(body) : decodeURIComponent(body);
			var root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
			if (!root || root.localName !== 'svg') {
				throw new Error('driving template "' + name + '" could not be read');
			}
			this.templateDocuments[name] = root;
		}
		var group = document.createElementNS(this.SVG_NS, 'g');
		group.setAttribute('id', id);
		var children = this.templateDocuments[name].children;
		for (var i = 0; i < children.length; i++) {
			if (children[i].localName !== 'title') {
				group.appendChild(document.importNode(children[i], true));
			}
		}
		return group;
	},

	// Right on screen is the direction of travel, and every car keeps its own facing, so a locomotive pointing the
	// other way is drawn with the mirrored texture. Running a leg backwards mirrors the whole consist with it.
	getCarTemplateName: function(car, reversed) {
		var type = car && car.type;
		if (type === 'steam loco' || type === 'diesel loco') {
			var facing = setup.railyard.getCarFacing(car) * (reversed ? -1 : 1);
			return 'driving-loco-' + setup.railyard.getLocomotiveModel(car) + '-' + (facing >= 0 ? 'right' : 'left');
		}
		if (type === 'flatcar') return 'driving-car-flatcar';
		if (type === 'tanker car') return 'driving-car-tanker';
		if (type === 'gondola') return 'driving-car-gondola';
		return 'driving-car-boxcar';
	},

	// Water never carries track, so a tile the train is standing on always has a backdrop to draw.
	getTerrainTemplateName: function(terrain) {
		var known = ['plains', 'forest', 'desert', 'arctic', 'mountain', 'bridge', 'tunnel'];
		return 'driving-terrain-' + (known.indexOf(terrain) === -1 ? 'plains' : terrain);
	},

	getCarLengthUnits: function(car) {
		var metres = Number(car && car.length) || 12;
		return metres * setup.drivingTemplates.unitsPerMetre;
	},

	// Places the consist with the car leading the way at the right, and works out how wide the scene has to be.
	layout: function(train, carIndex, reversed) {
		var self = this;
		var gap = this.CAR_GAP_UNITS;
		var cars = Array.isArray(train) ? train : [];
		var total = 0;
		for (var i = 0; i < cars.length; i++) {
			total += this.getCarLengthUnits(cars[i]) + (i ? gap : 0);
		}
		var placed = [];
		// Car 0 is the front of the consist. Running forward it leads and takes the rightmost slot; running the
		// leg backwards the rear of the consist leads instead, so the cars are laid down the other way round.
		var right = this.MARGIN_UNITS + total;
		for (var c = 0; c < cars.length; c++) {
			var index = reversed ? cars.length - 1 - c : c;
			var length = this.getCarLengthUnits(cars[index]);
			placed.push({
				car: cars[index], name: self.getCarTemplateName(cars[index], reversed), u: right - length,
				isPlayer: index === carIndex
			});
			right -= length + gap;
		}
		return { cars: placed, width: total + this.MARGIN_UNITS * 2, consistUnits: total };
	},

	render: function(view, train, carIndex) {
		var data = setup.drivingTemplates;
		var ns = this.SVG_NS;
		var self = this;
		var layout = this.layout(train, carIndex, !view.forward);
		var width = Math.max(layout.width, data.terrainTileUnits * 2);
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'driving-view');
		svg.setAttribute('shape-rendering', 'crispEdges');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Your consist on ' + (view.terrain || 'plains') + ' terrain, grade '
			+ view.grade.toFixed(1) + ' percent');

		this.renderCount = (this.renderCount || 0) + 1;
		var idPrefix = 'driving-view-' + this.renderCount + '-';
		var defs = document.createElementNS(ns, 'defs');
		svg.appendChild(defs);
		var defined = {};
		var define = function(name) {
			if (!defined[name]) {
				defs.appendChild(self.createTemplateGroup(name, idPrefix + name));
				defined[name] = true;
			}
		};
		var place = function(parent, name, x, y, title) {
			var template = self.getTemplate(name);
			if (!template) {
				throw new Error('missing driving template "' + name + '"');
			}
			define(name);
			var use = document.createElementNS(ns, 'use');
			var href = '#' + idPrefix + name;
			use.setAttribute('href', href);
			use.setAttributeNS(self.XLINK_NS, 'xlink:href', href);
			use.setAttribute('x', x - template.anchorX);
			use.setAttribute('y', y - template.anchorY);
			use.setAttribute('data-template', name);
			if (title) {
				var titleNode = document.createElementNS(ns, 'title');
				titleNode.textContent = title;
				use.appendChild(titleNode);
			}
			parent.appendChild(use);
			return template;
		};

		// The backdrop stays level: it is scenery, not the line the train is standing on.
		var terrainName = this.getTerrainTemplateName(view.terrain);
		var terrainTemplate = this.getTemplate(terrainName);
		var backdrop = document.createElementNS(ns, 'g');
		svg.appendChild(backdrop);
		for (var t = -data.terrainTileUnits; t < width + data.terrainTileUnits; t += data.terrainTileUnits) {
			place(backdrop, terrainName, t, 0, null);
		}

		// Track and train tilt together by the tile's grade, so a climb reads as a climb. Forward is to
		// the right, so a positive grade lifts the right-hand end.
		var tilt = Math.max(-this.MAX_TILT_DEGREES, Math.min(this.MAX_TILT_DEGREES, Math.atan(view.grade / 100) * 180 / Math.PI));
		var line = document.createElementNS(ns, 'g');
		line.setAttribute('transform', 'rotate(' + (-tilt).toFixed(3) + ' ' + (width / 2) + ' 0)');
		svg.appendChild(line);
		for (var r = -data.trackTileUnits; r < width + data.trackTileUnits; r += data.trackTileUnits) {
			place(line, 'driving-track', r, 0, null);
		}

		var marker = null;
		layout.cars.forEach(function(entry) {
			var title = String(entry.car.type || 'car') + ', ' + entry.car.length + ' m'
				+ (entry.isPlayer ? ' (you are here)' : '');
			var template = place(line, entry.name, entry.u, 0, title);
			if (entry.isPlayer) {
				var point = template.cab || template.top;
				marker = {
					x: entry.u - template.anchorX + (point ? point[0] : template.width / 2),
					y: -template.anchorY + (point ? point[1] : 0)
				};
			}
		});
		if (marker) {
			var arrow = document.createElementNS(ns, 'polygon');
			arrow.setAttribute('class', 'driving-player-marker');
			arrow.setAttribute('points', [(marker.x - 3) + ',' + (marker.y - 9), (marker.x + 3) + ',' + (marker.y - 9),
				marker.x + ',' + (marker.y - 4)].join(' '));
			var arrowTitle = document.createElementNS(ns, 'title');
			arrowTitle.textContent = 'You are here';
			arrow.appendChild(arrowTitle);
			line.appendChild(arrow);
		}

		// Size the view around everything drawn, once the tilt has moved things about.
		var top = -terrainTemplate.anchorY - this.PADDING;
		var bottom = terrainTemplate.height - terrainTemplate.anchorY + this.PADDING;
		var height = bottom - top;
		svg.setAttribute('viewBox', [0, top, width, height].join(' '));
		svg.setAttribute('width', width * this.SCALE);
		svg.setAttribute('height', height * this.SCALE);

		var wrapper = document.createElement('div');
		wrapper.className = 'driving-view-wrapper';
		wrapper.appendChild(svg);
		return wrapper;
	}
};

// Draws the consist where it stands on the line. Reads game state only; it never changes it.
Macro.add('drivingView', {
	handler: function() {
		var variables = State.variables;
		if (typeof setup.drivingTemplates === 'undefined' || !Array.isArray(variables.currentTrain) || !variables.currentTrain.length) {
			return;
		}
		var view = setup.worldmap.getJourneyView();
		if (!view) {
			return;
		}
		var carIndex = parseInt(variables.currentCarIndex, 10);
		try {
			this.output.appendChild(setup.drivingView.render(view, variables.currentTrain, isNaN(carIndex) ? 0 : carIndex));
		} catch (error) {
			return this.error('could not draw the line: ' + error.message);
		}
	}
});
