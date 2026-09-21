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
			corridorCount: data.corridors.length
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
