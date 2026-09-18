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

	// A scatter of stars in the sky part of a backdrop, behind its skyline. Positions are fixed per template, so the
	// sky does not shimmer from one tile to the next.
	addStars: function(group, template, night) {
		var sky = group.querySelector('#sky');
		if (!sky || !template) {
			return;
		}
		var ns = this.SVG_NS;
		var stars = document.createElementNS(ns, 'g');
		stars.setAttribute('class', 'driving-stars');
		stars.setAttribute('opacity', Math.min(1, (night - 0.3) / 0.5).toFixed(2));
		var width = setup.drivingTemplates.terrainTileUnits;
		for (var i = 0; i < 14; i++) {
			var star = document.createElementNS(ns, 'rect');
			star.setAttribute('x', template.anchorX + ((i * 37 + 11) % width));
			star.setAttribute('y', template.anchorY - 40 + ((i * 23 + 5) % 17));
			star.setAttribute('width', 1);
			star.setAttribute('height', 1);
			star.setAttribute('fill', i % 4 === 0 ? '#f4ecd2' : '#aeb8c8');
			stars.appendChild(star);
		}
		sky.parentNode.insertBefore(stars, sky.nextSibling);
	},
	// The headlamp, and the pool of light it throws down the track. The lamp belongs to the leading locomotive that
	// faces the way the train is going, wherever it stands in the consist, and the beam runs out ahead of whatever
	// is in front, so a locomotive shoving cars still lights the road.
	addHeadlight: function(parent, cars, night) {
		var self = this;
		var lit = cars.filter(function(entry) { return /^driving-loco-.*-right$/.test(entry.name); })[0];
		if (!lit) {
			return;
		}
		var template = this.getTemplate(lit.name);
		if (!template || !template.front) {
			return;
		}
		var ns = this.SVG_NS;
		var lamp = { x: lit.u - template.anchorX + template.front[0], y: -template.anchorY + template.front[1] - 5 };
		// The beam starts at the front of the train, which is the leading car whether or not it is the locomotive.
		var head = cars[0];
		var headTemplate = this.getTemplate(head.name);
		var x = headTemplate && headTemplate.front
			? head.u - headTemplate.anchorX + headTemplate.front[0]
			: lamp.x;
		var y = lamp.y;
		var beam = document.createElementNS(ns, 'polygon');
		beam.setAttribute('class', 'driving-headlight');
		beam.setAttribute('points', [x + ',' + (y - 1), (x + 34) + ',' + (y - 4), (x + 40) + ',' + (y + 6), x + ',' + (y + 2)].join(' '));
		beam.setAttribute('fill', '#ffe7a8');
		beam.setAttribute('fill-opacity', (0.22 * night).toFixed(3));
		parent.appendChild(beam);
		var bulb = document.createElementNS(ns, 'rect');
		bulb.setAttribute('class', 'driving-headlamp');
		bulb.setAttribute('x', lamp.x - 1);
		bulb.setAttribute('y', lamp.y - 1);
		bulb.setAttribute('width', 2);
		bulb.setAttribute('height', 2);
		bulb.setAttribute('fill', '#fff4d0');
		parent.appendChild(bulb);
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
		// The light of the time of day. A tunnel is lit the same at any hour, so its backdrop is never graded.
		// Underground there is no daylight to speak of, so a tunnel is always graded as night.
		var light = view.terrain === 'tunnel' ? setup.daylight.getLight(-20) : (view.light || setup.daylight.getLight());
		var graded = setup.daylight.isGraded(light);
		var grader = graded ? setup.daylight.createGrader(light, 'subject') : null;
		var backdropGrader = graded ? setup.daylight.createGrader(light, 'backdrop') : null;
		// The car the player is in is the one with a lamp lit in it, so its windows keep their glow.
		var litGrader = graded ? setup.daylight.createGrader(light, 'subject', true) : null;
		svg.setAttribute('data-light', light.phase);
		var defined = {};
		var define = function(name, lit) {
			var id = name + (lit ? '-lit' : '');
			if (!defined[id]) {
				var group = self.createTemplateGroup(name, idPrefix + id);
				if (grader && name !== 'driving-terrain-tunnel') {
					setup.daylight.applyToElement(group, lit ? litGrader
						: /^driving-terrain-/.test(name) ? backdropGrader : grader);
					if (/^driving-terrain-/.test(name) && light.night > 0.3) {
						self.addStars(group, self.getTemplate(name), light.night);
					}
				}
				defs.appendChild(group);
				defined[id] = true;
			}
		};
		var place = function(parent, name, x, y, title, lit) {
			var template = self.getTemplate(name);
			if (!template) {
				throw new Error('missing driving template "' + name + '"');
			}
			define(name, lit);
			var use = document.createElementNS(ns, 'use');
			var href = '#' + idPrefix + name + (lit ? '-lit' : '');
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
			var template = place(line, entry.name, entry.u, 0, title, entry.isPlayer);
			if (entry.isPlayer) {
				var point = template.cab || template.top;
				marker = {
					x: entry.u - template.anchorX + (point ? point[0] : template.width / 2),
					y: -template.anchorY + (point ? point[1] : 0)
				};
			}
		});
		// A tunnel is night whatever the clock says, so the lamps are lit in there too.
		var lampNight = view.terrain === 'tunnel' ? 1 : light.night;
		if (lampNight > 0.05 && layout.cars.length) {
			this.addHeadlight(line, layout.cars, lampNight);
		}
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
