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
		var pilot = setup.realWorldPilot, route = pilot.getGridRoute(), here = pilot.getStationTile(stationId);
		var grid = setup.worldGraphData.network.grid, reach = Math.round(this.MAP_RADIUS_KM / grid.cellKm);
		var cell = this.MAP_CELL_PX, size = (reach * 2 + 1) * cell, ns = 'http://www.w3.org/2000/svg';
		var left = function(x) { return (x - here.x + reach) * cell + cell / 2; };
		var top = function(y) { return (here.y + reach - y) * cell + cell / 2; };
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'station-map');
		svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Map of the railways around ' + setup.worldmap.getStationName(stationId));
		var add = function(name, attributes, text) {
			var element = document.createElementNS(ns, name);
			Object.keys(attributes).forEach(function(key) { element.setAttribute(key, attributes[key]); });
			if (text) element.textContent = text;
			svg.appendChild(element);
			return element;
		};
		add('rect', { x: 0, y: 0, width: size, height: size, class: 'station-map-ground' });
		var near = route.tiles.filter(function(tile) {
			return Math.abs(tile.x - here.x) <= reach && Math.abs(tile.y - here.y) <= reach;
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
			var isHere = tile.stationIndex === Number(stationId);
			add('circle', { cx: left(tile.x), cy: top(tile.y), r: isHere ? cell / 2 : cell / 3,
				class: isHere ? 'station-map-here' : 'station-map-station' });
			// A name in the right half of the map reads leftwards from its marker, so it stays on the map.
			var leftward = left(tile.x) > size / 2;
			add('text', { x: left(tile.x) + (leftward ? -cell * 0.7 : cell * 0.7), y: top(tile.y) + cell / 3,
				'text-anchor': leftward ? 'end' : 'start', class: 'station-map-label' },
				isHere ? tile.station + ' (you are here)' : tile.station);
		});
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
		return node.lines.map(function(line) {
			var distances = pilot.getNodeDistances(node.square, self.SIGN_LIMIT_KM, line);
			var stations = Object.keys(distances).map(function(square) {
				var reached = route.nodes[square];
				return reached && reached.kind === 'station' && reached.station.status !== 'halt'
					? { name: reached.name, km: distances[square], city: reached.station.status === 'city' } : null;
			}).filter(Boolean).sort(function(a, b) { return a.km - b.km || a.name.localeCompare(b.name); });
			var shown = stations.slice(0, self.SIGN_TOWNS);
			var city = stations.filter(function(station) { return station.city && shown.indexOf(station) < 0; })[0];
			if (city) shown.push(city);
			return { direction: setup.worldmap.describeDirection(line.direction), legIndex: line.legIndex, destinations: shown };
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
			}).join(' &middot; ') : 'no station';
			return '<p><strong>' + heading + '</strong>: ' + places + '</p>';
		}).join('') + '</div>';
	}
};

// The station map building's contents, for the railyard.
Macro.add('stationMap', {
	handler: function() {
		var stationId = Number(State.variables.currentStation);
		if (!setup.wayfinding.hasStationMap(stationId) || typeof document === 'undefined') return;
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
