/* Worldwide graph runtime. Compiled data lives in setup, never in save state. */
setup.worldGraph = (function () {
	'use strict';

	var data = setup.worldGraphData;
	var loadedRegions = {};
	var nodes = {};
	var links = {};
	var adjacency = {};

	function assert(condition, message) {
		if (!condition) throw new Error('World graph: ' + message);
	}

	function regionMetadata(id) {
		for (var index = 0; index < data.regions.length; index++) {
			if (data.regions[index].id === id) return data.regions[index];
		}
		return null;
	}

	function validateHeader() {
		assert(data && data.formatVersion === 1, 'unsupported or missing data format');
		assert(typeof data.datasetVersion === 'string' && data.datasetVersion.length > 0, 'missing dataset version');
		assert(data.tileKm === 5, 'unexpected gameplay slice length');
		assert(Array.isArray(data.regions) && data.chunks, 'missing region catalogue');
		assert(Array.isArray(data.corridors), 'missing corridor catalogue');
		assert(Array.isArray(data.railGeometry), 'missing sourced rail geometry catalogue');
		assert(Array.isArray(data.railTopology), 'missing compiled rail topology catalogue');
		return true;
	}

	function loadRegion(id) {
		validateHeader();
		if (loadedRegions[id]) return loadedRegions[id];
		var metadata = regionMetadata(id);
		var chunk = data.chunks[id];
		assert(metadata && chunk && chunk.id === id, 'missing region ' + id);
		assert(chunk.nodes.length === metadata.nodeCount, 'node count mismatch in ' + id);
		assert(chunk.portals.length === metadata.portalCount, 'portal count mismatch in ' + id);
		assert(chunk.links.length === metadata.linkCount, 'link count mismatch in ' + id);
		chunk.nodes.concat(chunk.portals).forEach(function (node) {
			if (nodes[node.id]) {
				assert(JSON.stringify(nodes[node.id]) === JSON.stringify(node), 'conflicting node record ' + node.id);
			} else {
				nodes[node.id] = node;
			}
			adjacency[node.id] = adjacency[node.id] || [];
		});
		chunk.links.forEach(function (link) {
			assert(!links[link.id], 'duplicate link ' + link.id);
			assert(link.status === 'planning' && link.navigable === false && link.reviewRequired === true,
				'unsafe planning link ' + link.id);
			links[link.id] = link;
		});
		loadedRegions[id] = chunk;
		return chunk;
	}

	function loadAll() {
		validateHeader();
		data.regions.forEach(function (region) { loadRegion(region.id); });
		Object.keys(links).forEach(function (id) {
			var link = links[id];
			assert(nodes[link.from] && nodes[link.to], 'missing endpoint for ' + id);
			if (adjacency[link.from].indexOf(id) === -1) adjacency[link.from].push(id);
			if (adjacency[link.to].indexOf(id) === -1) adjacency[link.to].push(id);
		});
		return true;
	}

	function getCorridor(id) {
		for (var index = 0; index < data.corridors.length; index++) {
			if (data.corridors[index].id === id) return data.corridors[index];
		}
		return null;
	}

	function getCorridorRoute(id) {
		loadAll();
		var corridor = getCorridor(id);
		if (!corridor) return null;
		return {
			id: corridor.id,
			label: corridor.label,
			waypoints: corridor.waypoints.map(function (nodeId) { return nodes[nodeId]; }),
			links: corridor.planningLinkIds.map(function (linkId) { return links[linkId]; }),
			navigable: false
		};
	}

	function getStats() {
		var nodeCount = 0;
		var linkCount = 0;
		data.regions.forEach(function (region) {
			nodeCount += region.nodeCount;
			linkCount += region.linkCount;
		});
		return {
			datasetVersion: data.datasetVersion,
			regionCount: data.regions.length,
			nodeCount: nodeCount,
			linkCount: linkCount,
			corridorCount: data.corridors.length,
			railGeometrySetCount: data.railGeometry.length,
			railWayCount: data.railGeometry.reduce(function (sum, geometry) { return sum + geometry.stats.wayCount; }, 0),
			railCoordinateCount: data.railGeometry.reduce(function (sum, geometry) { return sum + geometry.stats.coordinateCount; }, 0),
			playableRailCorridorCount: data.railTopology.reduce(function (sum, topology) { return sum + topology.corridors.length; }, 0)
		};
	}

	function getAttributions() {
		return data.sources.filter(function (source) { return source.status === 'ingested'; })
			.map(function (source) { return source.attribution; });
	}

	function appendDebugOverview(parent) {
		loadAll();
		var stats = getStats();
		var summary = document.createElement('p');
		summary.textContent = 'Planning-only worldwide graph ' + stats.datasetVersion + ': ' + stats.nodeCount +
			' places, ' + stats.linkCount + ' non-navigable links in ' + stats.regionCount +
			' regional chunks. Straight lines are corridor proposals, not claimed railway geometry.';
		parent.appendChild(summary);

		var namespace = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(namespace, 'svg');
		svg.setAttribute('class', 'world-graph-debug');
		svg.setAttribute('viewBox', '0 0 520 650');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Three planning corridors from Punta Arenas to Panama City');
		svg.style.width = 'min(100%, 420px)';
		svg.style.height = 'auto';
		svg.style.background = '#151719';
		svg.style.border = '1px solid #555';
		var colors = { pacific: '#d9b45d', 'central-amazon': '#80b77b', atlantic: '#78a9c7' };
		function point(node) {
			return {
				x: 20 + (node.longitude + 82) / 50 * 480,
				y: 20 + (13 - node.latitude) / 69 * 610
			};
		}
		data.corridors.forEach(function (corridor) {
			var route = getCorridorRoute(corridor.id);
			var polyline = document.createElementNS(namespace, 'polyline');
			polyline.setAttribute('points', route.waypoints.map(function (node) {
				var location = point(node);
				return location.x.toFixed(1) + ',' + location.y.toFixed(1);
			}).join(' '));
			polyline.setAttribute('fill', 'none');
			polyline.setAttribute('stroke', colors[corridor.id] || '#bbb');
			polyline.setAttribute('stroke-width', '3');
			polyline.setAttribute('stroke-linejoin', 'round');
			polyline.setAttribute('opacity', '0.85');
			var title = document.createElementNS(namespace, 'title');
			title.textContent = route.label + ' — planning only';
			polyline.appendChild(title);
			svg.appendChild(polyline);
		});
		// Planning links routed over real rail: mapped track solid, proposed gap fills dashed. They are drawn over the
		// chords they replace so the difference between a straight guess and the actual railway is plain to see.
		(data.routedLinks || []).forEach(function (route) {
			assert(route.navigable === false && route.reviewRequired === true, 'unsafe routed link ' + route.id);
			route.runs.forEach(function (run) {
				var line = document.createElementNS(namespace, 'polyline');
				line.setAttribute('class', run.gapFill ? 'world-route-gap' : 'world-route-rail');
				line.setAttribute('points', run.coordinates.map(function (coordinate) {
					var location = point({ longitude: coordinate[0], latitude: coordinate[1] });
					return location.x.toFixed(1) + ',' + location.y.toFixed(1);
				}).join(' '));
				line.setAttribute('fill', 'none');
				line.setAttribute('stroke', run.gapFill ? '#d9624f' : '#f0ead6');
				line.setAttribute('stroke-width', run.gapFill ? '2' : '1.5');
				if (run.gapFill) line.setAttribute('stroke-dasharray', '4 3');
				var title = document.createElementNS(namespace, 'title');
				title.textContent = route.from + ' to ' + route.to + ': ' + route.routedKm + ' km routed, ' + route.railKm +
					' km on mapped rail, ' + route.gapKm + ' km of gap fill in ' + route.gapCount +
					(route.playableCorridorId ? ' — played as ' + route.playableCorridorId : ' — for review, not playable');
				line.appendChild(title);
				svg.appendChild(line);
			});
		});
		Object.keys(nodes).sort().forEach(function (id) {
			var node = nodes[id];
			var location = point(node);
			var circle = document.createElementNS(namespace, 'circle');
			circle.setAttribute('cx', location.x.toFixed(1));
			circle.setAttribute('cy', location.y.toFixed(1));
			circle.setAttribute('r', id === 'cl-punta-arenas' || id === 'pa-panama-city' ? '5' : '3');
			circle.setAttribute('fill', '#eee2c1');
			var title = document.createElementNS(namespace, 'title');
			title.textContent = node.name + ', ' + node.countryCode;
			circle.appendChild(title);
			svg.appendChild(circle);
		});
		parent.appendChild(svg);

		var legend = document.createElement('p');
		data.corridors.forEach(function (corridor, index) {
			if (index) legend.appendChild(document.createTextNode(' · '));
			var key = document.createElement('span');
			key.style.color = colors[corridor.id] || '#bbb';
			key.textContent = corridor.label;
			legend.appendChild(key);
		});
		parent.appendChild(legend);
		if ((data.routedLinks || []).length) {
			var routedSummary = document.createElement('p');
			var railKm = data.routedLinks.reduce(function (sum, route) { return sum + route.railKm; }, 0);
			var gapKm = data.routedLinks.reduce(function (sum, route) { return sum + route.gapKm; }, 0);
			var played = data.routedLinks.filter(function (route) { return !!route.playableCorridorId; }).length;
			routedSummary.textContent = data.routedLinks.length + ' planning links routed over mapped rail: ' +
				Math.round(railKm).toLocaleString('en-US') + ' km on real track (solid) and ' +
				Math.round(gapKm).toLocaleString('en-US') + ' km of gap fill (dashed). ' +
				(played === data.routedLinks.length ? 'All of them are playable.'
					: played ? played + ' of them are playable; the rest are unreviewed.' : 'None of it is playable until reviewed.');
			parent.appendChild(routedSummary);
		}
		appendRailGeometryPreview(parent);
	}

	function appendRailGeometryPreview(parent) {
		if (!data.railGeometry.length) return;
		var namespace = 'http://www.w3.org/2000/svg';
		data.railGeometry.forEach(function (geometry) {
			var heading = document.createElement('h4');
			heading.textContent = geometry.label;
			parent.appendChild(heading);
			var summary = document.createElement('p');
			summary.textContent = geometry.stats.wayCount.toLocaleString() + ' sourced OSM ways, '
				+ geometry.stats.coordinateCount.toLocaleString() + ' coordinates and '
				+ Math.round(geometry.stats.lengthKm).toLocaleString() + ' km of mapped track. All lifecycle statuses are routable by game policy; only authored routes are playable.';
			parent.appendChild(summary);
			var width = 520, height = 600, padding = 16;
			var bounds = geometry.bounds;
			var middleLatitude = (bounds[1] + bounds[3]) / 2;
			var longitudeScale = Math.cos(middleLatitude * Math.PI / 180);
			var spanX = Math.max(0.000001, (bounds[2] - bounds[0]) * longitudeScale);
			var spanY = Math.max(0.000001, bounds[3] - bounds[1]);
			var availableWidth = width - padding * 2;
			var availableHeight = height - padding * 2;
			var scale = Math.min(availableWidth / spanX, availableHeight / spanY);
			var drawnWidth = spanX * scale;
			var drawnHeight = spanY * scale;
			var offsetX = (width - drawnWidth) / 2;
			var offsetY = (height - drawnHeight) / 2;
			var project = function (coordinate) {
				return [offsetX + (coordinate[0] - bounds[0]) * longitudeScale * scale,
					offsetY + (bounds[3] - coordinate[1]) * scale];
			};
			var svg = document.createElementNS(namespace, 'svg');
			svg.setAttribute('class', 'rail-geometry-preview');
			svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
			svg.setAttribute('role', 'img');
			svg.setAttribute('aria-label', geometry.label + ', sourced railway geometry preview');
			svg.style.width = 'min(100%, 420px)';
			svg.style.height = 'auto';
			svg.style.background = '#151719';
			svg.style.border = '1px solid #555';
			var colors = { current: '#d8d2c4', construction: '#d9b45d', proposed: '#8ca9c4', planned: '#8ca9c4',
				disused: '#9a825b', abandoned: '#745f4a', dismantled: '#705747', historic: '#705747',
				razed: '#684d4d', demolished: '#684d4d', removed: '#684d4d' };
			// Thousands of individual SVG nodes made opening Debug needlessly expensive. Batch ways with the same
			// visual meaning into one path; the normalized source still retains each OSM way and its tags.
			var pathGroups = {};
			geometry.ways.forEach(function (way) {
				var groupKey = way.railwayStatus + (way.service ? ':service' : ':route');
				if (!pathGroups[groupKey]) pathGroups[groupKey] = { status: way.railwayStatus, service: !!way.service, ways: 0, commands: [] };
				var group = pathGroups[groupKey];
				group.ways++;
				group.commands.push(way.coordinates.map(function (coordinate, index) {
					var point = project(coordinate);
					return (index ? 'L' : 'M') + point[0].toFixed(2) + ' ' + point[1].toFixed(2);
				}).join(' '));
			});
			Object.keys(pathGroups).sort().forEach(function (groupKey) {
				var group = pathGroups[groupKey];
				var path = document.createElementNS(namespace, 'path');
				path.setAttribute('d', group.commands.join(' '));
				path.setAttribute('fill', 'none');
				path.setAttribute('stroke', colors[group.status] || '#888');
				path.setAttribute('stroke-width', group.service ? '0.45' : '0.8');
				path.setAttribute('opacity', group.service ? '0.45' : '0.9');
				path.setAttribute('data-way-count', group.ways);
				var title = document.createElementNS(namespace, 'title');
				title.textContent = group.ways + ' ' + group.status + (group.service ? ' service' : ' route') + ' ways';
				path.appendChild(title);
				svg.appendChild(path);
			});
			parent.appendChild(svg);
			var legend = document.createElement('p');
			legend.textContent = 'Current · proposed · construction · disused · abandoned · dismantled · razed. Status is historical provenance, not a gameplay restriction. Service, yard, siding and spur tracks are drawn faintly.';
			parent.appendChild(legend);
		});
	}

	validateHeader();
	return {
		FORMAT_VERSION: 1,
		getData: function () { return data; },
		getStats: getStats,
		loadRegion: loadRegion,
		loadAll: loadAll,
		getNode: function (id) { loadAll(); return nodes[id] || null; },
		getLink: function (id) { loadAll(); return links[id] || null; },
		getLinksAtNode: function (id) { loadAll(); return (adjacency[id] || []).slice(); },
		getCorridor: getCorridor,
		getCorridorRoute: getCorridorRoute,
		getAttributions: getAttributions,
		appendDebugOverview: appendDebugOverview
	};
}());
