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
		return setup.realWorldPilot.getStationTile(Number(State.variables.currentStation) || 1);
	},

	// Every map the player has seen, drawn together, with where they are now.
	buildCombinedMap: function() {
		var centres = this.getSeenMaps().map(function(stationId) { return setup.realWorldPilot.getStationTile(stationId); });
		return centres.length ? this.drawAreas(centres, this.getHereTile(), 'Map of the railways you have seen') : null;
	},

	// The squares within MAP_RADIUS_KM of any of centres, north up, the stations named and here marked (when it falls
	// on the drawing).
	drawAreas: function(centres, here, label) {
		var route = setup.realWorldPilot.getGridRoute();
		var grid = setup.worldGraphData.network.grid, reach = Math.round(this.MAP_RADIUS_KM / grid.cellKm);
		var x0 = Math.min.apply(null, centres.map(function(tile) { return tile.x; })) - reach;
		var x1 = Math.max.apply(null, centres.map(function(tile) { return tile.x; })) + reach;
		var y0 = Math.min.apply(null, centres.map(function(tile) { return tile.y; })) - reach;
		var y1 = Math.max.apply(null, centres.map(function(tile) { return tile.y; })) + reach;
		var cell = this.MAP_CELL_PX, width = (x1 - x0 + 1) * cell, height = (y1 - y0 + 1) * cell, size = width;
		var ns = 'http://www.w3.org/2000/svg';
		var left = function(x) { return (x - x0) * cell + cell / 2; };
		var top = function(y) { return (y1 - y) * cell + cell / 2; };
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'station-map');
		svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
		svg.setAttribute('width', width);
		svg.setAttribute('height', height);
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', label);
		var add = function(name, attributes, text) {
			var element = document.createElementNS(ns, name);
			Object.keys(attributes).forEach(function(key) { element.setAttribute(key, attributes[key]); });
			if (text) element.textContent = text;
			svg.appendChild(element);
			return element;
		};
		add('rect', { x: 0, y: 0, width: width, height: height, class: 'station-map-ground' });
		var near = route.tiles.filter(function(tile) {
			return centres.some(function(centre) { return Math.abs(tile.x - centre.x) <= reach && Math.abs(tile.y - centre.y) <= reach; });
		});
		var track = [];
		near.forEach(function(tile) {
			tile.ends.forEach(function(end) {
				var direction = setup.worldmap.DIRECTIONS[end];
				track.push('M' + left(tile.x) + ' ' + top(tile.y) + 'L' + (left(tile.x) + direction.dx * cell / 2) + ' '
					+ (top(tile.y) - direction.dy * cell / 2));
			});
		});
		add('path', { d: track.join(''), class: 'station-map-track' });
		near.forEach(function(tile) {
			if (tile.junction) add('circle', { cx: left(tile.x), cy: top(tile.y), r: cell / 5, class: 'station-map-junction' });
		});
		near.forEach(function(tile) {
			if (!tile.stationIndex) return;
			var isHere = !!here && tile.x === here.x && tile.y === here.y;
			add('circle', { cx: left(tile.x), cy: top(tile.y), r: isHere ? cell / 2 : cell / 3,
				class: isHere ? 'station-map-here' : 'station-map-station' });
			// A name in the right half of the map reads leftwards from its marker, so it stays on the map.
			var leftward = left(tile.x) > size / 2;
			add('text', { x: left(tile.x) + (leftward ? -cell * 0.7 : cell * 0.7), y: top(tile.y) + cell / 3,
				'text-anchor': leftward ? 'end' : 'start', class: 'station-map-label' },
				isHere ? tile.station + ' (you are here)' : tile.station);
		});
		// Out on the line, where the train or the walker is.
		if (here && !here.stationIndex && here.x >= x0 && here.x <= x1 && here.y >= y0 && here.y <= y1) {
			add('circle', { cx: left(here.x), cy: top(here.y), r: cell / 2, class: 'station-map-here' });
			add('text', { x: left(here.x) + cell * 0.7, y: top(here.y) + cell / 3, class: 'station-map-label' }, 'You are here');
		}
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

// The Map tab: every station map the player has looked at, drawn together.
setup.showMapDialog = function() {
	if (typeof Dialog === 'undefined') return;
	Dialog.setup('Map');
	var body = document.createElement('div');
	body.className = 'combined-map';
	var map = setup.wayfinding.buildCombinedMap();
	if (map) {
		var frame = document.createElement('div');
		frame.className = 'combined-map-frame';
		frame.appendChild(map);
		body.appendChild(frame);
		var from = document.createElement('p');
		from.className = 'small-description';
		from.textContent = 'Maps from ' + setup.wayfinding.getSeenMaps().map(function(stationId) {
			return setup.worldmap.getStationName(stationId);
		}).join(', ') + '.';
		body.appendChild(from);
	} else {
		var none = document.createElement('p');
		none.textContent = 'You have not seen any maps yet. Stations at the end of a line have one.';
		body.appendChild(none);
	}
	Dialog.append(body);
	Dialog.open();
	// Open on where the player is.
	var here = body.querySelector('.station-map-here');
	if (here && frame) {
		var box = here.getBoundingClientRect(), frameBox = frame.getBoundingClientRect();
		frame.scrollLeft += box.left - frameBox.left - frame.clientWidth / 2;
		frame.scrollTop += box.top - frameBox.top - frame.clientHeight / 2;
	}
};
