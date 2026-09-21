/* Debug-only traversal of authored routes compiled from real railway geometry. Static route data stays in setup;
   saves contain only the corridor ID and the train's position along it. */
setup.realWorldPilot = (function () {
	'use strict';

	function allCorridors() {
		var sets = setup.worldGraph.getData().railTopology || [];
		var result = [];
		sets.forEach(function (topology) {
			topology.corridors.forEach(function (corridor) { result.push(corridor); });
		});
		return result;
	}

	function getCorridor(id) {
		var corridors = allCorridors();
		for (var index = 0; index < corridors.length; index++) {
			if (corridors[index].id === id) return corridors[index];
		}
		return null;
	}

	function flatten(corridor) {
		var slices = [];
		var stationPositions = [{ position: 0, station: corridor.stations[0] }];
		corridor.legs.forEach(function (leg, legIndex) {
			leg.slices.forEach(function (slice) {
				slices.push({ slice: slice, leg: leg, legIndex: legIndex });
			});
			stationPositions.push({ position: slices.length, station: corridor.stations[legIndex + 1] });
		});
		return { slices: slices, stationPositions: stationPositions };
	}

	function getJourney() {
		var journey = State.variables.realWorldJourney;
		if (!journey || !getCorridor(journey.corridorId)) return null;
		return journey;
	}

	function start(corridorId) {
		var corridor = getCorridor(corridorId);
		if (!State.variables.debugMode || !corridor || !corridor.debugOnly || !corridor.navigable ||
			!State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey || State.variables.onFoot) return false;
		State.variables.realWorldJourney = { corridorId: corridor.id, position: 0 };
		return true;
	}

	function stop() {
		State.variables.realWorldJourney = null;
		return true;
	}

	function getView() {
		var journey = getJourney();
		if (!journey) return null;
		var corridor = getCorridor(journey.corridorId);
		var route = flatten(corridor);
		var position = Math.max(0, Math.min(Number(journey.position) || 0, route.slices.length));
		var station = null;
		route.stationPositions.forEach(function (entry) { if (entry.position === position) station = entry.station; });
		return { corridor: corridor, route: route, position: position, station: station };
	}

	function getStep(direction) {
		var view = getView();
		if (!view) return null;
		var forward = direction >= 0;
		var sliceIndex = forward ? view.position : view.position - 1;
		if (sliceIndex < 0 || sliceIndex >= view.route.slices.length) return null;
		var entry = view.route.slices[sliceIndex];
		var distanceKm = entry.slice.distanceKm;
		return {
			direction: forward ? 1 : -1,
			fromPosition: view.position,
			toPosition: view.position + (forward ? 1 : -1),
			distanceKm: distanceKm,
			minutes: Math.max(1, Math.round(setup.worldmap.getTileMinutes(0, State.variables.currentTrain) * distanceKm / 5)),
			slice: entry.slice,
			leg: entry.leg,
			destination: view.route.stationPositions.find(function (station) {
				return station.position === view.position + (forward ? 1 : -1);
			}) || null
		};
	}

	function move(direction) {
		var step = getStep(direction);
		if (!step) return false;
		State.variables.realWorldJourney.position = step.toPosition;
		return true;
	}

	function appendMap(parent) {
		var view = getView();
		if (!view) return;
		var coordinates = [];
		view.route.slices.forEach(function (entry, sliceIndex) {
			entry.slice.coordinates.forEach(function (coordinate, coordinateIndex) {
				if (sliceIndex || coordinateIndex) coordinates.push(coordinate);
				else coordinates.push(coordinate);
			});
		});
		var longitudes = coordinates.map(function (coordinate) { return coordinate[0]; });
		var latitudes = coordinates.map(function (coordinate) { return coordinate[1]; });
		var minLongitude = Math.min.apply(null, longitudes), maxLongitude = Math.max.apply(null, longitudes);
		var minLatitude = Math.min.apply(null, latitudes), maxLatitude = Math.max.apply(null, latitudes);
		var namespace = 'http://www.w3.org/2000/svg', width = 760, height = 260, padding = 28;
		var longitudeScale = Math.cos(((minLatitude + maxLatitude) / 2) * Math.PI / 180);
		var spanX = Math.max(0.000001, (maxLongitude - minLongitude) * longitudeScale);
		var spanY = Math.max(0.000001, maxLatitude - minLatitude);
		var scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
		var offsetX = (width - spanX * scale) / 2, offsetY = (height - spanY * scale) / 2;
		function project(coordinate) {
			return [offsetX + (coordinate[0] - minLongitude) * longitudeScale * scale,
				offsetY + (maxLatitude - coordinate[1]) * scale];
		}
		var svg = document.createElementNS(namespace, 'svg');
		svg.setAttribute('class', 'real-world-pilot-map');
		svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', view.corridor.label + ' route map');
		svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.background = '#151719';
		var path = document.createElementNS(namespace, 'polyline');
		path.setAttribute('points', coordinates.map(function (coordinate) { return project(coordinate).join(','); }).join(' '));
		path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#b9ad8d'); path.setAttribute('stroke-width', '4');
		path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
		view.route.stationPositions.forEach(function (entry) {
			var point = project(entry.station.coordinates);
			var circle = document.createElementNS(namespace, 'circle');
			circle.setAttribute('cx', point[0]); circle.setAttribute('cy', point[1]); circle.setAttribute('r', '6');
			circle.setAttribute('fill', '#eee2c1');
			var title = document.createElementNS(namespace, 'title'); title.textContent = entry.station.name;
			circle.appendChild(title); svg.appendChild(circle);
		});
		var markerCoordinate;
		if (view.position === view.route.slices.length) markerCoordinate = view.route.slices.at(-1).slice.coordinates.at(-1);
		else markerCoordinate = view.route.slices[view.position].slice.coordinates[0];
		var markerPoint = project(markerCoordinate);
		var marker = document.createElementNS(namespace, 'circle');
		marker.setAttribute('cx', markerPoint[0]); marker.setAttribute('cy', markerPoint[1]); marker.setAttribute('r', '8');
		marker.setAttribute('fill', '#c44747'); marker.setAttribute('stroke', '#fff'); marker.setAttribute('stroke-width', '2');
		svg.appendChild(marker);
		parent.appendChild(svg);
	}

	function appendDebugControls(parent) {
		var corridors = allCorridors().filter(function (corridor) { return corridor.debugOnly && corridor.navigable; });
		if (!corridors.length) return;
		var heading = document.createElement('h4'); heading.textContent = 'Playable OSM pilot'; parent.appendChild(heading);
		var description = document.createElement('p');
		description.textContent = 'Drive a reviewed section of real track in 5 km-or-shorter steps. This debug trip returns to the train interior without changing the procedural station.';
		parent.appendChild(description);
		corridors.forEach(function (corridor) {
			var button = document.createElement('button');
			button.textContent = 'Drive ' + corridor.label + ' (' + corridor.distanceKm.toFixed(1) + ' km)';
			button.disabled = !State.variables.currentTrain || !State.variables.currentTrain.length ||
				!!State.variables.journey || !!State.variables.onFoot;
			button.title = button.disabled ? 'Board a train in a railyard before starting the pilot.' : '';
			button.addEventListener('click', function () {
				if (!start(corridor.id)) return;
				setup.sideTabs.active = null;
				setup.sideTabs.refresh();
				Engine.play('WorldPilot');
			});
			parent.appendChild(button);
		});
		if (!State.variables.currentTrain || !State.variables.currentTrain.length || State.variables.journey || State.variables.onFoot) {
			var note = document.createElement('p'); note.className = 'small-description';
			note.textContent = 'Board a train in a railyard first; the entire active consist will enter the pilot.'; parent.appendChild(note);
		}
	}

	Macro.add('realWorldPilotView', { handler: function () { appendMap(this.output); } });
	Macro.add('realWorldPilotStatus', { handler: function () {
		var view = getView();
		if (!view) return;
		var travelled = view.route.slices.slice(0, view.position).reduce(function (sum, entry) { return sum + entry.slice.distanceKm; }, 0);
		var place = view.station ? 'At ' + view.station.name : 'On the line';
		new Wikifier(this.output, '<h2>' + view.corridor.label + '</h2><p><strong>' + place + '</strong> · ' +
			travelled.toFixed(1) + ' of ' + view.corridor.distanceKm.toFixed(1) + ' km</p><p class="small-description">'
			+ 'Real OpenStreetMap track geometry. Elevation, weather, bridges and destination yards are not connected yet.</p>');
	} });
	Macro.add('realWorldPilotControls', { handler: function () {
		var output = '';
		[1, -1].forEach(function (direction) {
			var step = getStep(direction); if (!step) return;
			var label = (direction > 0 ? 'Drive ' : 'Reverse ') + setup.units.kilometres(step.distanceKm);
			if (step.destination) label += ' to ' + step.destination.station.name;
			output += '<<timedlink "' + label + '" ' + step.minutes + ' "travel">><<run setup.realWorldPilot.move(' + direction + ')>><<goto "WorldPilot">><</timedlink>><br>';
			output += '<span class="small-description">' + (step.slice.bridge ? 'Bridge · ' : '') +
				(step.slice.tunnel ? 'Tunnel · ' : '') + step.distanceKm.toFixed(1) + ' km of sourced track.</span><br>';
		});
		output += '<p><<link "Leave real-world pilot">><<run setup.realWorldPilot.stop()>><<goto "TrainInterior">><</link>></p>';
		new Wikifier(this.output, output);
	} });

	return { getCorridor: getCorridor, getJourney: getJourney, getView: getView, getStep: getStep, start: start,
		move: move, stop: stop, appendMap: appendMap, appendDebugControls: appendDebugControls };
}());
