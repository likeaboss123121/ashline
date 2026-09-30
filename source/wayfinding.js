/* Finding the way on the network: a map at the end of a stub line, and signposts at junctions.

   A station at the end of a line, with one line out of its yard, has a building holding a map of the country around
   it: the track within MAP_RADIUS_KM, the stations and junctions on it, and how far the nearest stations are by
   track. It is a reason to go down a branch. At a junction out on the line a signpost gives, for each way on, the
   next towns that way and a city further on, with the distance to each by track, the way a road sign does.

   Everything here is worked out from the compiled network when asked for; nothing is saved. */
setup.wayfinding = {
	MAP_RADIUS_KM: 150,
	MAP_CELL_PX: 8,
	MAP_LIST_COUNT: 8,
	SIGN_TOWNS: 2,
	SIGN_LIMIT_KM: 1500,

	// Whether a station has the map building: the end of a line, one line out of its yard.
	hasStationMap: function(stationId) {
		var pilot = setup.realWorldPilot;
		if (!pilot || !pilot.getStation || !pilot.getStation(stationId)) return false;
		return pilot.getStationLines(stationId).length === 1;
	},

	// The stations nearest a station by track, up to MAP_RADIUS_KM, nearest first: { stationId, name, km }.
	getNearbyStations: function(stationId) {
		var pilot = setup.realWorldPilot, route = pilot.getGridRoute(), tile = pilot.getStationTile(stationId);
		if (!tile) return [];
		var distances = pilot.getNodeDistances(tile.globalPosition, this.MAP_RADIUS_KM);
		return Object.keys(distances).map(function(square) {
			var node = route.nodes[square];
			return node && node.kind === 'station' ? { stationId: node.stationIndex, name: node.name, km: distances[square] } : null;
		}).filter(Boolean).sort(function(a, b) { return a.km - b.km || a.stationId - b.stationId; }).slice(0, this.MAP_LIST_COUNT);
	},

	// The map itself, as an SVG element: the squares within MAP_RADIUS_KM of the station, north up.
	buildStationMap: function(stationId) {
		var here = setup.realWorldPilot.getStationTile(stationId);
		return this.drawAreas([here], here, 'Map of the railways around ' + setup.worldmap.getStationName(stationId));
	},

	// The stations whose maps the player has looked at, in the order they were first seen, as station numbers. Saved
	// by the stations' stable ids (a station's number changes when the network is rebuilt; its id does not): it is
	// what the player knows, not world data.
	getSeenMaps: function() {
		var seen = State.variables.seenMaps, stations = setup.realWorldPilot.getGridRoute().corridor.stations;
		if (!Array.isArray(seen)) return [];
		var numberOf = {};
		stations.forEach(function(station, index) { numberOf[station.id] = index + 1; });
		return seen.map(function(id) { return numberOf[id]; }).filter(Boolean);
	},
	rememberMap: function(stationId) {
		var station = setup.realWorldPilot.getStation(stationId);
		if (!station) return;
		var seen = Array.isArray(State.variables.seenMaps) ? State.variables.seenMaps : [];
		if (seen.indexOf(station.id) < 0) seen.push(station.id);
		State.variables.seenMaps = seen;
	},

	// Where the player is on the grid: the train or the walker out on the line, else the station they are at.
	getHereTile: function() {
		var view = setup.onfoot && setup.onfoot.isOnFoot && setup.onfoot.isOnFoot() && setup.onfoot.getTile
			? { tile: setup.onfoot.getTile() } : setup.worldmap.getJourneyView();
		if (view && view.tile) return view.tile;
		return setup.realWorldPilot.getStationTile(setup.yards.normalise(State.variables.currentStation || 1));
	},

	// The map as the player sees it: the country within MAP_RADIUS_KM of any of centres, drawn from where each square
	// really is (its latitude and longitude, on an azimuthal equidistant projection about the middle of the map), so
	// north is up and nothing is stretched, whichever grid the squares were built on. Land and water come from the land
	// mask; country no map has shown is left in fog. Stations are marked, and named where the names fit without
	// overlapping, the cities first; here is marked when it falls on the drawing. A scale bar and a north arrow finish
	// it. Everything is worked out from the compiled network when asked for.
	MAP_PX_PER_KM: 1.6,
	MAP_MAX_PX: 3200,
	MAP_LAND_CELL_PX: 2,
	drawAreas: function(centres, here, label) {
		var route = setup.realWorldPilot.getGridRoute(), radius = this.MAP_RADIUS_KM, R = 6371.0088;
		var radians = Math.PI / 180;
		var places = centres.map(function(tile) { return tile.geoCoordinate; });
		// The middle of the map: the mean of the centres' directions from the middle of the Earth.
		var sum = [0, 0, 0];
		places.forEach(function(p) {
			var lon = p[0] * radians, lat = p[1] * radians;
			sum[0] += Math.cos(lat) * Math.cos(lon); sum[1] += Math.cos(lat) * Math.sin(lon); sum[2] += Math.sin(lat);
		});
		var lon0 = Math.atan2(sum[1], sum[0]), lat0 = Math.atan2(sum[2], Math.hypot(sum[0], sum[1]));
		// Azimuthal equidistant about the middle: distances from it true, north up through it.
		var project = function(p) {
			var lon = p[0] * radians, lat = p[1] * radians, dLon = lon - lon0;
			var cosC = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dLon);
			var c = Math.acos(Math.max(-1, Math.min(1, cosC))), k = c < 1e-9 ? 1 : c / Math.sin(c);
			return [R * k * Math.cos(lat) * Math.sin(dLon), R * k * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dLon))];
		};
		var unproject = function(x, y) {
			var rho = Math.hypot(x, y);
			if (rho < 1e-9) return [lon0 / radians, lat0 / radians];
			var c = rho / R;
			var lat = Math.asin(Math.cos(c) * Math.sin(lat0) + y * Math.sin(c) * Math.cos(lat0) / rho);
			var lon = lon0 + Math.atan2(x * Math.sin(c), rho * Math.cos(lat0) * Math.cos(c) - y * Math.sin(lat0) * Math.sin(c));
			return [lon / radians, lat / radians];
		};
		var distanceKm = function(a, b) {
			var dLat = (b[1] - a[1]) * radians, dLon = (b[0] - a[0]) * radians;
			var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.pow(Math.sin(dLon / 2), 2);
			return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
		};
		var middles = places.map(project);
		var hereAt = here && here.geoCoordinate && places.some(function(p) { return distanceKm(p, here.geoCoordinate) <= radius * 2; })
			? project(here.geoCoordinate) : null;
		// The drawing's extent in kilometres, and the scale: MAP_PX_PER_KM, or less where many maps would make it huge.
		var box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
		middles.concat(hereAt ? [hereAt] : []).forEach(function(m) {
			box.x0 = Math.min(box.x0, m[0] - radius); box.x1 = Math.max(box.x1, m[0] + radius);
			box.y0 = Math.min(box.y0, m[1] - radius); box.y1 = Math.max(box.y1, m[1] + radius);
		});
		var scale = Math.min(this.MAP_PX_PER_KM, this.MAP_MAX_PX / Math.max(box.x1 - box.x0, box.y1 - box.y0));
		var width = Math.round((box.x1 - box.x0) * scale), height = Math.round((box.y1 - box.y0) * scale);
		var px = function(m) { return [(m[0] - box.x0) * scale, (box.y1 - m[1]) * scale]; };
		var round1 = function(value) { return Math.round(value * 10) / 10; };

		var ns = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'station-map');
		svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', label);
		var add = function(name, attributes, text, parent) {
			var element = document.createElementNS(ns, name);
			Object.keys(attributes).forEach(function(key) { element.setAttribute(key, attributes[key]); });
			if (text) element.textContent = text;
			(parent || svg).appendChild(element);
			return element;
		};
		add('rect', { x: 0, y: 0, width: width, height: height, class: 'station-map-ground' });

		// Land and water: a small picture, a cell of MAP_LAND_CELL_PX a pixel, smoothed as it is drawn larger; from the
		// globe's land and water where the data has it (sharper), else the network's land mask.
		var useFine = !!(setup.globe && setup.globe.getLand && setup.globe.getLand());
		if ((useFine || setup.worldmap.getLandMask()) && document.createElement('canvas').getContext) {
			var cellPx = this.MAP_LAND_CELL_PX, columns = Math.ceil(width / cellPx), rows = Math.ceil(height / cellPx);
			var canvas = document.createElement('canvas');
			canvas.width = columns;
			canvas.height = rows;
			var context = canvas.getContext('2d');
			if (context) {
				var picture = context.createImageData(columns, rows);
				for (var row = 0; row < rows; row++) {
					for (var column = 0; column < columns; column++) {
						var place = unproject(box.x0 + (column + 0.5) * cellPx / scale, box.y1 - (row + 0.5) * cellPx / scale);
						var weight = useFine ? setup.globe.landWeight(place[0], place[1]) : (setup.worldmap.isLandAt(place[0], place[1]) ? 1 : 0);
						var land = weight < 0.35 ? 0 : weight > 0.65 ? 1 : (weight - 0.35) / 0.3, at = (row * columns + column) * 4;
						var colour = [21 + 31 * land, 33 + 25 * land, 42 + 3 * land];
						picture.data[at] = colour[0]; picture.data[at + 1] = colour[1]; picture.data[at + 2] = colour[2]; picture.data[at + 3] = 255;
					}
				}
				context.putImageData(picture, 0, 0);
				add('image', { x: 0, y: 0, width: columns * cellPx, height: rows * cellPx, preserveAspectRatio: 'none',
					href: canvas.toDataURL(), class: 'station-map-land' });
			}
		}

		// The squares shown: those within the radius of a map's centre.
		var shown = {};
		var nearAny = function(p) { return places.some(function(c) { return distanceKm(c, p) <= radius; }); };
		route.tiles.forEach(function(tile) {
			var p = tile.geoCoordinate;
			if (!p || !places.some(function(c) { return Math.abs(c[1] - p[1]) < 3; })) return;
			if (nearAny(p)) shown[tile.globalPosition] = tile;
		});
		var at = {};
		Object.keys(shown).forEach(function(index) { at[index] = px(project(shown[index].geoCoordinate)); });
		// The track, each move once, between the middles of the squares: a dark casing under a light line.
		var track = [];
		Object.keys(shown).forEach(function(index) {
			var tile = shown[index];
			tile.ends.forEach(function(end) {
				var direction = setup.worldmap.DIRECTIONS[end];
				var next = route.byKey[setup.worldmap.key(tile.x + direction.dx, tile.y + direction.dy)];
				if (!next || !shown[next.globalPosition] || next.globalPosition < tile.globalPosition) return;
				var a = at[index], b = at[next.globalPosition];
				track.push('M' + round1(a[0]) + ' ' + round1(a[1]) + 'L' + round1(b[0]) + ' ' + round1(b[1]));
			});
		});
		add('path', { d: track.join(''), class: 'station-map-track-casing' });
		add('path', { d: track.join(''), class: 'station-map-track' });
		Object.keys(shown).forEach(function(index) {
			if (!shown[index].junction) return;
			add('circle', { cx: round1(at[index][0]), cy: round1(at[index][1]), r: 1.8, class: 'station-map-junction' });
		});

		// Fog over country no map has shown: the whole drawing, less a soft-edged circle round each map's centre.
		var fogId = 'station-map-fog-' + (++this._mapCount || (this._mapCount = 1));
		var defs = add('defs', {});
		var blur = add('filter', { id: fogId + '-blur', x: '-20%', y: '-20%', width: '140%', height: '140%' }, null, defs);
		add('feGaussianBlur', { stdDeviation: Math.max(2, radius * scale * 0.06) }, null, blur);
		var mask = add('mask', { id: fogId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: width, height: height }, null, defs);
		add('rect', { x: 0, y: 0, width: width, height: height, fill: 'white' }, null, mask);
		var holes = add('g', { filter: 'url(#' + fogId + '-blur)' }, null, mask);
		middles.forEach(function(m) {
			var p = px(m);
			add('circle', { cx: round1(p[0]), cy: round1(p[1]), r: round1(radius * scale), fill: 'black' }, null, holes);
		});
		add('rect', { x: 0, y: 0, width: width, height: height, mask: 'url(#' + fogId + ')', class: 'station-map-fog' });

		// Stations and their names. Markers first, then names placed greedily, most important first, on whichever side
		// of the marker is clear of the names and markers already placed and inside the drawing.
		var stations = Object.keys(shown).map(function(index) { return shown[index]; }).filter(function(tile) { return tile.stationIndex; });
		var isHereTile = function(tile) { return !!here && tile.x === here.x && tile.y === here.y; };
		var rankOf = function(tile) {
			if (isHereTile(tile)) return 0;
			if (tile.stationStatus === 'city') return 1;
			if (tile.stationStatus === 'halt') return 4;
			return tile.stationStatus === 'active' || tile.stationStatus === 'settlement' ? 2 : 3;
		};
		stations.sort(function(a, b) { return rankOf(a) - rankOf(b) || a.globalPosition - b.globalPosition; });
		var taken = [];
		var overlaps = function(b) {
			if (b.x0 < 2 || b.y0 < 2 || b.x1 > width - 2 || b.y1 > height - 2) return true;
			return taken.some(function(t) { return b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0; });
		};
		stations.forEach(function(tile) {
			var p = at[tile.globalPosition], r = rankOf(tile) === 1 ? 4.5 : 3.2;
			taken.push({ x0: p[0] - r, x1: p[0] + r, y0: p[1] - r, y1: p[1] + r });
		});
		stations.slice().reverse().forEach(function(tile) {
			var p = at[tile.globalPosition];
			if (isHereTile(tile)) return;
			add('circle', { cx: round1(p[0]), cy: round1(p[1]), r: rankOf(tile) === 1 ? 4.5 : 3.2,
				class: 'station-map-station' + (rankOf(tile) === 1 ? ' station-map-city' : '') });
		});
		// gap: from the marker's middle to the name, past the marker itself.
		var placeLabel = function(p, text, size, className, gap) {
			var w = text.length * size * 0.56 + 2, h = size;
			var options = [[p[0] + gap, p[1] + h * 0.35, 'start'], [p[0] - gap, p[1] + h * 0.35, 'end'],
				[p[0], p[1] - gap, 'middle'], [p[0], p[1] + gap + h * 0.8, 'middle']];
			for (var i = 0; i < options.length; i++) {
				var o = options[i], x0 = o[2] === 'start' ? o[0] : o[2] === 'end' ? o[0] - w : o[0] - w / 2;
				var b = { x0: x0, x1: x0 + w, y0: o[1] - h * 0.85, y1: o[1] + h * 0.2 };
				if (overlaps(b)) continue;
				taken.push(b);
				return add('text', { x: round1(o[0]), y: round1(o[1]), 'text-anchor': o[2], class: 'station-map-label' + (className ? ' ' + className : '') }, text);
			}
			return null;
		};
		// Here, on the drawing: at a station, or out on the line.
		var herePoint = null;
		stations.forEach(function(tile) { if (isHereTile(tile)) herePoint = at[tile.globalPosition]; });
		if (!herePoint && hereAt && here && !here.stationIndex) herePoint = px(hereAt);
		if (herePoint) {
			add('circle', { cx: round1(herePoint[0]), cy: round1(herePoint[1]), r: 8, class: 'station-map-here-ring' });
			add('circle', { cx: round1(herePoint[0]), cy: round1(herePoint[1]), r: 4.5, class: 'station-map-here' });
			taken.push({ x0: herePoint[0] - 8, x1: herePoint[0] + 8, y0: herePoint[1] - 8, y1: herePoint[1] + 8 });
		}
		stations.forEach(function(tile) {
			var here_ = isHereTile(tile), city = rankOf(tile) === 1;
			placeLabel(at[tile.globalPosition], here_ ? tile.station + ' (you are here)' : tile.station, here_ || city ? 12 : 10.5,
				here_ ? 'station-map-label-here' : city ? 'station-map-label-city' : '', here_ ? 12 : city ? 8 : 6.5);
		});
		if (herePoint && !stations.some(isHereTile)) placeLabel(herePoint, 'You are here', 12, 'station-map-label-here', 12);

		// A scale bar, bottom left: a round distance near a fifth of the width.
		var steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], target = width / 5 / scale, barKm = steps[0];
		steps.forEach(function(step) { if (step <= target) barKm = step; });
		var barPx = barKm * scale, bx = 10, by = height - 12;
		add('path', { d: 'M' + bx + ' ' + (by - 5) + 'V' + by + 'H' + round1(bx + barPx) + 'V' + (by - 5), class: 'station-map-scale' });
		add('text', { x: bx, y: by - 8, class: 'station-map-scale-label' }, setup.units.kilometres(barKm));
		// A north arrow, top right.
		var nx = width - 16, ny = 12;
		add('path', { d: 'M' + nx + ' ' + ny + 'L' + (nx + 6) + ' ' + (ny + 18) + 'L' + nx + ' ' + (ny + 13) + 'L' + (nx - 6) + ' ' + (ny + 18) + 'Z',
			class: 'station-map-north' });
		return svg;
	},

	// For each way on from the junction at a journey position, the signpost's line: the heading, then the next towns
	// that way and the first city beyond them, each with its distance by track. [] away from a junction.
	getSign: function(position) {
		var pilot = setup.realWorldPilot, self = this;
		if (!position || !pilot || !pilot.getNodeAt) return [];
		var node = pilot.getNodeAt(position.legIndex, position.tileIndex);
		if (!node || node.kind !== 'junction') return [];
		var route = pilot.getGridRoute();
		// Every way's distances first, so each place is signed only on the way that is shortest to it: a road sign
		// does not point to the same city down every road.
		var ways = node.lines.map(function(line) {
			return { line: line, distances: pilot.getNodeDistances(node.square, self.SIGN_LIMIT_KM, line) };
		});
		var best = {};
		ways.forEach(function(way, index) {
			Object.keys(way.distances).forEach(function(square) {
				if (best[square] === undefined || way.distances[square] < ways[best[square]].distances[square]) best[square] = index;
			});
		});
		return ways.map(function(way, index) {
			var distances = way.distances;
			var stations = Object.keys(distances).map(function(square) {
				var reached = route.nodes[square];
				return reached && reached.kind === 'station' && reached.station.status !== 'halt' && best[square] === index
					? { name: reached.name, km: distances[square], city: reached.station.status === 'city' } : null;
			}).filter(Boolean).sort(function(a, b) { return a.km - b.km || a.name.localeCompare(b.name); });
			var shown = stations.slice(0, self.SIGN_TOWNS);
			var city = stations.filter(function(station) { return station.city && shown.indexOf(station) < 0; })[0];
			if (city) shown.push(city);
			return { direction: setup.worldmap.describeDirection(way.line.direction, route.tiles[node.square]), legIndex: way.line.legIndex, destinations: shown };
		});
	},

	// The signpost as markup, for the line and on-foot views.
	signMarkup: function(position) {
		var sign = this.getSign(position);
		if (!sign.length) return '';
		return '<div class="junction-sign" aria-label="Signpost">' + sign.map(function(way) {
			var heading = way.direction.charAt(0).toUpperCase() + way.direction.slice(1);
			var places = way.destinations.length ? way.destinations.map(function(place) {
				return place.name + ' ' + setup.units.kilometres(Math.round(place.km));
			}).join(' &middot; ') : 'no station this way';
			return '<p><strong>' + heading + '</strong>: ' + places + '</p>';
		}).join('') + '</div>';
	}
};

// The station map building's contents, for the railyard.
Macro.add('stationMap', {
	handler: function() {
		var stationId = Number(State.variables.currentStation);
		if (!setup.wayfinding.hasStationMap(stationId) || typeof document === 'undefined') return;
		setup.wayfinding.rememberMap(stationId);
		var holder = document.createElement('div');
		holder.className = 'station-map-holder';
		holder.appendChild(setup.wayfinding.buildStationMap(stationId));
		var list = document.createElement('ul');
		list.className = 'station-map-list';
		setup.wayfinding.getNearbyStations(stationId).forEach(function(station) {
			var item = document.createElement('li');
			item.textContent = station.name + ': ' + setup.units.kilometres(Math.round(station.km));
			list.appendChild(item);
		});
		holder.appendChild(list);
		this.output.appendChild(holder);
	}
});

// The Map tab: the globe, with what the player knows drawn on it (source/globe.js), and which maps they have read.
setup.showMapDialog = function() {
	if (typeof Dialog === 'undefined') return;
	Dialog.setup('Map');
	var body = document.createElement('div');
	body.className = 'combined-map';
	Dialog.append(body);
	Dialog.open();
	body.appendChild(setup.globe.build());
	body.appendChild(setup.globe.legend());
	var seen = setup.wayfinding.getSeenMaps();
	var note = document.createElement('p');
	note.className = 'small-description';
	note.textContent = seen.length ? 'Maps from ' + seen.map(function(stationId) {
		return setup.worldmap.getStationName(stationId);
	}).join(', ') + '.' : 'You have not seen any maps yet.';
	body.appendChild(note);
};
