/* The map: the Earth as a globe that turns and zooms, used by the Map tab and, with everything revealed, by the debug
   panel.

   The land is drawn everywhere from one small texture baked at build time (scripts/world/globe-texture.cjs:
   greyscale, water 0, land its shaded relief), with coastlines from a finer land and water layer, so the shape of the
   country can always be read. On the Map tab the railways, stations and names are drawn only where the player knows
   them: round every station map they have read (MAP_KM), every station they have visited and where they are now
   (NEAR_KM). Elsewhere the land lies under fog, and a known line that runs on into it fades out along the track, so
   the player can see where the lines lead. Stations they have been to are solid, stations they only know of hollow.
   Where they are is a pulsing red mark, and when it is off the view an arrow at the edge points the way to it.

   Two canvases: the globe underneath, drawn a pixel at a time (an orthographic projection) and only when the view
   moves, a third of the resolution while it is moving; and the track, names and marks on top, which the pulse redraws
   on its own. The track is too much to draw line by line many times a second, so while the view moves it is drawn into
   the globe's pixels from a coarse raster, and as lines, with the stations and names, once it stops (Likea,
   2026-09-30). With everything revealed (the debug map) the raster is used far out even when still, and the lines
   only in view from close enough. The debug map can outline the squares of the grid round the track (setGrid).

   Nothing here is saved: what the player knows comes from the seen maps and the journal, the rest from the compiled
   network. */
setup.globe = {
	MAP_KM: 150,
	NEAR_KM: 50,
	HINT_SQUARES: 8, // how far a known line is drawn fading into the fog
	EARTH_KM: 6371.0088,
	OPEN_ACROSS_KM: 1500, // how much country the map shows across when it opens
	// The relief is about 20 km a texel and the coastlines about 5, so the globe stops zooming in not far past where the
	// coast turns to blocks: one zoom step (1.6 times) past 1.2, which Likea asked for (2026-09-30).
	MAX_PX_PER_KM: 1.92,
	NAMES_PX_PER_KM: 0.3, // station names from this close in; cities and here always
	VECTOR_PX_PER_KM: 0.12, // with everything revealed, track as lines from this close in, as raster further out
	GRID_PX_PER_KM: 0.6, // the debug map's grid squares from this close in (a 5 km square 3 pixels across)
	FLAT_SHADE: 205, // the texture's value for level ground (see globe-texture.cjs)
	BUCKET_DEGREES: 2,

	// The texture as a byte per texel, decoded once from the embedded PNG. Calls back with it, or null.
	loadTexture: function(done) {
		var self = this, globe = setup.worldGraphData && setup.worldGraphData.globe;
		if (this._texture) return done(this._texture);
		if (!globe || typeof Image === 'undefined') return done(null);
		var image = new Image();
		image.onload = function() {
			var canvas = document.createElement('canvas');
			canvas.width = globe.width;
			canvas.height = globe.height;
			var context = canvas.getContext('2d');
			context.drawImage(image, 0, 0);
			var rgba = context.getImageData(0, 0, globe.width, globe.height).data, bytes = new Uint8Array(globe.width * globe.height);
			for (var i = 0; i < bytes.length; i++) bytes[i] = rgba[i * 4];
			self._texture = { width: globe.width, height: globe.height, bytes: bytes, land: self.getLand() };
			done(self._texture);
		};
		image.onerror = function() { done(null); };
		image.src = globe.texture;
	},

	// The finer land and water (compile-world.cjs), a bit per cell, decoded once: { columns, rows, bits }, or null.
	getLand: function() {
		var globe = setup.worldGraphData && setup.worldGraphData.globe, land = globe && globe.land;
		if (!land) return null;
		if (this._land) return this._land;
		var bits = new Uint8Array(Math.ceil(land.columns * land.rows / 8)), at = 0, isLand = false;
		land.runs.split(',').forEach(function(run) {
			var length = parseInt(run, 36);
			if (isLand) for (var i = at; i < at + length; i++) bits[i >> 3] |= 1 << (i & 7);
			at += length;
			isLand = !isLand;
		});
		this._land = { columns: land.columns, rows: land.rows, bits: bits };
		return this._land;
	},
	// How much land there is at a longitude and latitude (degrees), 0 to 1, from the four cells round it.
	landWeight: function(longitude, latitude) {
		var fine = this.getLand();
		if (!fine) return null;
		var cell = function(column, row) {
			column = ((column % fine.columns) + fine.columns) % fine.columns;
			row = Math.max(0, Math.min(fine.rows - 1, row));
			var i = row * fine.columns + column;
			return (fine.bits[i >> 3] >> (i & 7)) & 1;
		};
		var u = (longitude + 180) / 360 * fine.columns - 0.5, v = (90 - latitude) / 180 * fine.rows - 0.5;
		var u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
		return (1 - fu) * (1 - fv) * cell(u0, v0) + fu * (1 - fv) * cell(u0 + 1, v0) + (1 - fu) * fv * cell(u0, v0 + 1) + fu * fv * cell(u0 + 1, v0 + 1);
	},

	distanceKm: function(a, b) {
		var radians = Math.PI / 180, dLat = (b[1] - a[1]) * radians, dLon = (b[0] - a[0]) * radians;
		var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.pow(Math.sin(dLon / 2), 2);
		return 2 * this.EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
	},
	bucketOf: function(longitude, latitude) {
		return Math.floor((latitude + 90) / this.BUCKET_DEGREES) * 1000 + Math.floor((longitude + 180) / this.BUCKET_DEGREES);
	},

	// What the map shows. revealAll: every square. Otherwise the squares the player knows, and a few beyond them along
	// the track as hints. Returns { areas, tiles, segments, stations, buckets, here }: segments as { a, b, kind, fade }
	// in radians, kind 'rail' or 'new' (a new line, told apart only on the debug map), fade 1 for known track and less
	// along a hint; stations as { tile, visited, city }; buckets group segments and stations by place, so only those
	// in view are looked at.
	getKnown: function(revealAll) {
		var pilot = setup.realWorldPilot, route = pilot.getGridRoute(), self = this, areas = [], radians = Math.PI / 180;
		var visited = {};
		var journal = State.variables.journal;
		(journal && Array.isArray(journal.stations) ? journal.stations : []).forEach(function(stationId) {
			var tile = pilot.getStationTile(Number(stationId));
			if (!tile) return;
			visited[tile.globalPosition] = true;
			areas.push({ place: tile.geoCoordinate, km: self.NEAR_KM });
		});
		setup.wayfinding.getSeenMaps().forEach(function(stationId) {
			var tile = pilot.getStationTile(stationId);
			if (tile) areas.push({ place: tile.geoCoordinate, km: self.MAP_KM });
		});
		var here = setup.wayfinding.getHereTile();
		if (here && here.stationIndex) visited[here.globalPosition] = true;
		if (here && here.geoCoordinate) areas.push({ place: here.geoCoordinate, km: this.NEAR_KM });
		var shown = {};
		if (revealAll) {
			route.tiles.forEach(function(tile) { if (tile.geoCoordinate) shown[tile.globalPosition] = 1; });
		} else {
			route.tiles.forEach(function(tile) {
				var p = tile.geoCoordinate;
				if (!p) return;
				for (var i = 0; i < areas.length; i++) {
					if (Math.abs(areas[i].place[1] - p[1]) > 3) continue;
					if (self.distanceKm(p, areas[i].place) <= areas[i].km) { shown[tile.globalPosition] = 1; return; }
				}
			});
			// Hints: out along the track from the known squares, HINT_SQUARES deep, fading.
			var frontier = Object.keys(shown).map(Number);
			for (var depth = 1; depth <= this.HINT_SQUARES && frontier.length; depth++) {
				var next = [];
				frontier.forEach(function(index) {
					var tile = route.tiles[index];
					tile.ends.forEach(function(end) {
						var direction = setup.worldmap.DIRECTIONS[end];
						var other = route.byKey[setup.worldmap.key(tile.x + direction.dx, tile.y + direction.dy)];
						if (!other || shown[other.globalPosition]) return;
						shown[other.globalPosition] = 1 - depth / (self.HINT_SQUARES + 1);
						next.push(other.globalPosition);
					});
				});
				frontier = next;
			}
		}
		var segments = [], stations = [], buckets = {};
		var bucket = function(key) { return buckets[key] || (buckets[key] = { segments: [], stations: [], lon: 0, lat: 0 }); };
		Object.keys(shown).forEach(function(key) {
			var index = Number(key), tile = route.tiles[index], fade = shown[key];
			tile.ends.forEach(function(end) {
				var direction = setup.worldmap.DIRECTIONS[end];
				var next = route.byKey[setup.worldmap.key(tile.x + direction.dx, tile.y + direction.dy)];
				if (!next || !shown[next.globalPosition] || next.globalPosition < index) return;
				var segment = { a: [tile.geoCoordinate[0] * radians, tile.geoCoordinate[1] * radians],
					b: [next.geoCoordinate[0] * radians, next.geoCoordinate[1] * radians],
					kind: tile.gapFill && next.gapFill ? 'new' : 'rail', fade: Math.min(fade, shown[next.globalPosition]), tiles: [tile, next] };
				segments.push(segment);
				bucket(self.bucketOf(tile.geoCoordinate[0], tile.geoCoordinate[1])).segments.push(segment);
			});
			if (tile.stationIndex && fade === 1) {
				var station = { tile: tile, visited: !!visited[index], city: tile.stationStatus === 'city' };
				stations.push(station);
				bucket(self.bucketOf(tile.geoCoordinate[0], tile.geoCoordinate[1])).stations.push(station);
			}
		});
		Object.keys(buckets).forEach(function(key) {
			var row = Math.floor(Number(key) / 1000), column = Number(key) % 1000;
			buckets[key].lat = ((row + 0.5) * self.BUCKET_DEGREES - 90) * radians;
			buckets[key].lon = ((column + 0.5) * self.BUCKET_DEGREES - 180) * radians;
		});
		return { areas: areas, tiles: shown, segments: segments, stations: stations, buckets: buckets, here: here, revealAll: !!revealAll };
	},

	// How known each texel of the texture is, 0 to 255, for the fog: full inside each area, fading over its outer fifth.
	knownTexture: function(texture, areas) {
		var width = texture.width, height = texture.height, known = new Uint8Array(width * height), radians = Math.PI / 180;
		var self = this;
		areas.forEach(function(area) {
			var lat0 = area.place[1], reach = area.km * 1.2, dLat = reach / 111.2;
			var dLon = Math.min(180, reach / (111.2 * Math.max(0.05, Math.cos(lat0 * radians))));
			var row0 = Math.max(0, Math.floor((90 - lat0 - dLat) / 180 * height)), row1 = Math.min(height - 1, Math.ceil((90 - lat0 + dLat) / 180 * height));
			for (var row = row0; row <= row1; row++) {
				var lat = 90 - (row + 0.5) * 180 / height;
				var c0 = Math.floor((area.place[0] - dLon + 180) / 360 * width), c1 = Math.ceil((area.place[0] + dLon + 180) / 360 * width);
				for (var c = c0; c <= c1; c++) {
					var column = ((c % width) + width) % width, lon = -180 + (column + 0.5) * 360 / width;
					var km = self.distanceKm([lon, lat], area.place);
					var value = km <= area.km ? 255 : km >= reach ? 0 : Math.round(255 * (reach - km) / (reach - area.km));
					var at = row * width + column;
					if (value > known[at]) known[at] = value;
				}
			}
		});
		return known;
	},
	// The track as a raster the size of the texture, for drawing it far out and while the view moves: 1 for mapped
	// railway and, with everything revealed, 2 for new line (on the Map tab all track is the same).
	trackTexture: function(texture, known) {
		var width = texture.width, height = texture.height, track = new Uint8Array(width * height);
		var route = setup.realWorldPilot.getGridRoute();
		Object.keys(known.tiles).forEach(function(key) {
			// The track fading into the fog is only hinted at: not in the raster.
			if (!known.revealAll && known.tiles[key] < 1) return;
			var tile = route.tiles[Number(key)], p = tile.geoCoordinate;
			var column = Math.min(width - 1, Math.floor((p[0] + 180) / 360 * width)), row = Math.min(height - 1, Math.floor((90 - p[1]) / 180 * height));
			var at = row * width + column;
			if (!track[at] || !tile.gapFill) track[at] = tile.gapFill && known.revealAll ? 2 : 1;
		});
		return track;
	},

	// The globe, in a holder. options: revealAll (the debug map: everything, no fog), onPick(tile) (a click on the
	// track, not a drag), onHover(tile, place) (the square nearest the pointer, or null, and the place under it).
	// Returns the holder; the globe is drawn once its texture is in.
	build: function(options) {
		options = options || {};
		var self = this, known = this.getKnown(options.revealAll), R = this.EARTH_KM, radians = Math.PI / 180;
		var holder = document.createElement('div');
		holder.className = 'globe-map' + (options.revealAll ? ' globe-map-debug' : '');
		var canvas = document.createElement('canvas');
		canvas.className = 'globe-map-canvas';
		canvas.setAttribute('role', 'img');
		canvas.setAttribute('aria-label', options.revealAll ? 'World railway network' : 'Map of the railways you have seen');
		var overlay = document.createElement('canvas');
		overlay.className = 'globe-map-overlay';
		overlay.setAttribute('aria-hidden', 'true');
		var bar = document.createElement('div');
		bar.className = 'globe-map-controls';
		// The pad: three by three buttons, their glyph in a span so a pan arrow can turn to point its way on the map.
		var button = function(text, label, onClick, className) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = className || '';
			var glyph = document.createElement('span');
			glyph.className = 'globe-map-glyph';
			glyph.textContent = text;
			b.appendChild(glyph);
			b.title = label;
			b.setAttribute('aria-label', label);
			b.addEventListener('click', onClick);
			bar.appendChild(b);
			return b;
		};
		holder.appendChild(canvas);
		holder.appendChild(overlay);
		holder.appendChild(bar);

		// The view: the point at the middle of the globe, and its size in pixels per kilometre.
		var start = known.here && known.here.geoCoordinate ? known.here.geoCoordinate : [0, 0];
		// rotation: the bearing at the top of the view, in radians; 0 is north up.
		var view = { lon: start[0] * radians, lat: start[1] * radians, pxPerKm: null, rotation: 0 };
		var texture = null, knownBytes = null, trackBytes = null, settleTimer = null, pixels = null, lastSize = null;
		// moving: the view is being dragged, turned or zoomed, and is drawn the quick way until it settles. showGrid: the
		// debug map's outlines of the squares.
		var moving = false, showGrid = false;
		var size = function() {
			var width = Math.max(260, Math.round(holder.clientWidth || 600));
			var height = Math.round(Math.min(width * 0.8, (window.innerHeight || 800) * 0.65));
			return { width: width, height: Math.max(240, height) };
		};
		var fitPxPerKm = function(s) { return 0.45 * Math.min(s.width, s.height) / R; };
		var clampZoom = function() {
			view.pxPerKm = Math.max(fitPxPerKm(size()), Math.min(self.MAX_PX_PER_KM, view.pxPerKm));
		};
		// A longitude and latitude (radians) on the view, or null on the far side of the globe. The globe is worked out
		// north up and turned by the view's rotation.
		var toScreen = function(lon, lat, s) {
			var cosC = Math.sin(view.lat) * Math.sin(lat) + Math.cos(view.lat) * Math.cos(lat) * Math.cos(lon - view.lon);
			if (cosC < 0) return null;
			var r = R * view.pxPerKm, c = Math.cos(view.rotation), sn = Math.sin(view.rotation);
			var east = r * Math.cos(lat) * Math.sin(lon - view.lon);
			var north = r * (Math.cos(view.lat) * Math.sin(lat) - Math.sin(view.lat) * Math.cos(lat) * Math.cos(lon - view.lon));
			return [s.width / 2 + east * c - north * sn, s.height / 2 - (east * sn + north * c)];
		};
		// A point of the view back to longitude and latitude (degrees), or null off the globe.
		var fromScreen = function(x, y, s) {
			var r = R * view.pxPerKm, c = Math.cos(view.rotation), sn = Math.sin(view.rotation);
			var right = (x - s.width / 2) / r, up = (s.height / 2 - y) / r;
			var nx = right * c + up * sn, ny = -right * sn + up * c, rho2 = nx * nx + ny * ny;
			if (rho2 > 1) return null;
			var z = Math.sqrt(1 - rho2);
			var lat = Math.asin(z * Math.sin(view.lat) + ny * Math.cos(view.lat));
			var lon = view.lon + Math.atan2(nx, z * Math.cos(view.lat) - ny * Math.sin(view.lat));
			return [((lon / radians + 540) % 360) - 180, lat / radians];
		};
		// The buckets that can be in view: within the view's reach of its middle, and on the near side.
		var bucketsInView = function(s) {
			var reach = Math.min(Math.PI / 2, Math.hypot(s.width, s.height) / 2 / (R * view.pxPerKm)) + self.BUCKET_DEGREES * 1.5 * radians;
			var sinLat0 = Math.sin(view.lat), cosLat0 = Math.cos(view.lat), limit = Math.cos(reach);
			return Object.keys(known.buckets).map(function(key) { return known.buckets[key]; }).filter(function(b) {
				return sinLat0 * Math.sin(b.lat) + cosLat0 * Math.cos(b.lat) * Math.cos(b.lon - view.lon) >= limit;
			});
		};

		var resize = function(s, ratio) {
			[canvas, overlay].forEach(function(c) {
				if (c.width !== Math.round(s.width * ratio) || c.height !== Math.round(s.height * ratio)) {
					c.width = Math.round(s.width * ratio);
					c.height = Math.round(s.height * ratio);
					c.style.width = s.width + 'px';
					c.style.height = s.height + 'px';
					if (c === canvas) pixels = null;
				}
			});
			holder.style.height = s.height + 'px';
		};

		// The globe itself, a pixel at a time; step > 1 draws coarser while it moves.
		var drawGlobe = function(step) {
			if (!texture) return;
			var s = size(), ratio = Math.min(1.5, window.devicePixelRatio || 1);
			resize(s, ratio);
			lastSize = s;
			var context = canvas.getContext('2d');
			var w = canvas.width, h = canvas.height;
			if (!pixels) pixels = context.createImageData(w, h);
			var data = pixels.data, r = R * view.pxPerKm * ratio, cx = w / 2, cy = h / 2;
			var sinLat0 = Math.sin(view.lat), cosLat0 = Math.cos(view.lat);
			var tw = texture.width, th = texture.height, bytes = texture.bytes, fine = texture.land;
			var rasterTrack = trackBytes && (moving || (known.revealAll && view.pxPerKm < self.VECTOR_PX_PER_KM));
			var landAt = function(column, row) {
				column = ((column % fine.columns) + fine.columns) % fine.columns;
				row = Math.max(0, Math.min(fine.rows - 1, row));
				var i = row * fine.columns + column;
				return (fine.bits[i >> 3] >> (i & 7)) & 1;
			};
			var graticule = 15 * radians, lineWidth = 0.7 / r, turnC = Math.cos(view.rotation), turnS = Math.sin(view.rotation);
			for (var y = 0; y < h; y += step) {
				for (var x = 0; x < w; x += step) {
					// Screen right and up, turned back to east and north.
					var right = (x + step / 2 - cx) / r, up = (cy - y - step / 2) / r;
					var nx = right * turnC + up * turnS, ny = -right * turnS + up * turnC, rho2 = nx * nx + ny * ny, red, green, blue;
					if (rho2 > 1) {
						// Space, with a faint glow round the edge of the Earth.
						var glow = Math.max(0, 1 - (Math.sqrt(rho2) - 1) * r / (14 * ratio));
						red = 10 + 14 * glow; green = 13 + 22 * glow; blue = 17 + 30 * glow;
					} else {
						var z = Math.sqrt(1 - rho2);
						var lat = Math.asin(z * sinLat0 + ny * cosLat0);
						var lon = view.lon + Math.atan2(nx, z * cosLat0 - ny * sinLat0);
						// Bilinear over the relief texture: its shading, from the land texels round the point.
						var u = ((lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1 * tw - 0.5, v = (0.5 - lat / Math.PI) * th - 0.5;
						var u0 = Math.floor(u), v0 = Math.max(0, Math.min(th - 1, Math.floor(v))), fu = u - u0, fv = Math.max(0, Math.min(1, v - v0));
						var u1 = (u0 + 1) % tw, v1 = Math.min(th - 1, v0 + 1);
						u0 = (u0 + tw) % tw;
						var a = bytes[v0 * tw + u0], b = bytes[v0 * tw + u1], c = bytes[v1 * tw + u0], d = bytes[v1 * tw + u1];
						var wa = (1 - fu) * (1 - fv), wb = fu * (1 - fv), wc = (1 - fu) * fv, wd = fu * fv;
						var landWeight = (a ? wa : 0) + (b ? wb : 0) + (c ? wc : 0) + (d ? wd : 0);
						var shadeValue = landWeight > 0 ? ((a ? wa * a : 0) + (b ? wb * b : 0) + (c ? wc * c : 0) + (d ? wd * d : 0)) / landWeight : self.FLAT_SHADE;
						// Land or water from the finer mask, bilinear too.
						if (fine) {
							var lu = ((lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1 * fine.columns - 0.5, lv = (0.5 - lat / Math.PI) * fine.rows - 0.5;
							var lu0 = Math.floor(lu), lv0 = Math.floor(lv), gu = lu - lu0, gv = lv - lv0;
							landWeight = (1 - gu) * (1 - gv) * landAt(lu0, lv0) + gu * (1 - gv) * landAt(lu0 + 1, lv0)
								+ (1 - gu) * gv * landAt(lu0, lv0 + 1) + gu * gv * landAt(lu0 + 1, lv0 + 1);
						}
						var land = landWeight < 0.35 ? 0 : landWeight > 0.65 ? 1 : (landWeight - 0.35) / 0.3;
						var relief = Math.max(0.6, Math.min(1.3, 1 + (shadeValue - self.FLAT_SHADE) / 45));
						// Colour: water, and land lit by its relief, the far north and south paler.
						var polar = Math.max(0, Math.min(1, (Math.abs(lat) / radians - 62) / 12));
						var landR = (80 + 50 * polar) * relief, landG = (88 + 46 * polar) * relief, landB = (64 + 70 * polar) * relief;
						red = 24 + (landR - 24) * land; green = 44 + (landG - 44) * land; blue = 64 + (landB - 64) * land;
						// Fog: unknown country darker and greyer, its edge as smooth as the land's.
						if (knownBytes) {
							var k = (wa * knownBytes[v0 * tw + u0] + wb * knownBytes[v0 * tw + u1] + wc * knownBytes[v1 * tw + u0]
								+ wd * knownBytes[v1 * tw + u1]) / 255, fog = 0.55 + 0.45 * k, grey = (red + green + blue) / 3;
							red = (grey + (red - grey) * (0.5 + 0.5 * k)) * fog;
							green = (grey + (green - grey) * (0.5 + 0.5 * k)) * fog;
							blue = (grey + (blue - grey) * (0.5 + 0.5 * k)) * fog;
						}
						// Far out, with everything revealed, the track from its raster.
						if (rasterTrack) {
							var t = trackBytes[Math.round(v) * tw + ((Math.round(u) % tw) + tw) % tw];
							if (t === 1) { red = 216; green = 210; blue = 196; } else if (t === 2) { red = 217; green = 98; blue = 79; }
						}
						// Lines of latitude and longitude every 15 degrees, faintly.
						var latLine = Math.abs(lat / graticule - Math.round(lat / graticule)) * graticule;
						var lonLine = Math.abs(lon / graticule - Math.round(lon / graticule)) * graticule * Math.cos(lat);
						if (latLine < lineWidth * step || lonLine < lineWidth * step) { red += 12; green += 14; blue += 16; }
						// Darker towards the edge of the disc, so it reads as a ball.
						var limb = 0.55 + 0.45 * z;
						red *= limb; green *= limb; blue *= limb;
					}
					for (var yy = y; yy < Math.min(h, y + step); yy++) {
						for (var xx = x; xx < Math.min(w, x + step); xx++) {
							var at = (yy * w + xx) * 4;
							data[at] = red; data[at + 1] = green; data[at + 2] = blue; data[at + 3] = 255;
						}
					}
				}
			}
			context.putImageData(pixels, 0, 0);
		};

		// The track, stations, names and marks, on the canvas over the globe. pulse: 0 to 1, the here mark's beat.
		var drawOverlay = function(pulse) {
			var s = lastSize || size(), ratio = Math.min(1.5, window.devicePixelRatio || 1);
			var context = overlay.getContext('2d');
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(0, 0, overlay.width, overlay.height);
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			var zoom = view.pxPerKm, width = Math.max(1, Math.min(3, zoom * 2.2)), inView = null;
			var vectors = !moving && (!known.revealAll || zoom >= self.VECTOR_PX_PER_KM);
			if (vectors) {
				inView = bucketsInView(s);
				// Known track: a dark casing under a light line. New lines red on the debug map. Hints fade out.
				var paths = { rail: new Path2D(), 'new': new Path2D() }, hints = [];
				inView.forEach(function(b) {
					b.segments.forEach(function(segment) {
						var p = toScreen(segment.a[0], segment.a[1], s), q = toScreen(segment.b[0], segment.b[1], s);
						if (!p || !q) return;
						if (segment.fade < 1) { hints.push([p, q, segment.fade]); return; }
						var path = known.revealAll && segment.kind === 'new' ? paths['new'] : paths.rail;
						path.moveTo(p[0], p[1]);
						path.lineTo(q[0], q[1]);
					});
				});
				context.lineCap = 'round';
				context.lineJoin = 'round';
				['rail', 'new'].forEach(function(kind) {
					context.strokeStyle = '#101416';
					context.lineWidth = width + 2.5;
					context.stroke(paths[kind]);
					context.strokeStyle = kind === 'new' ? '#d9624f' : '#d8d2c4';
					context.lineWidth = width;
					context.stroke(paths[kind]);
				});
				// A line running on into country not seen: dashed, fading as it goes.
				context.setLineDash([3, 3]);
				context.lineWidth = Math.max(1, width * 0.8);
				hints.forEach(function(hint) {
					context.strokeStyle = 'rgba(216, 210, 196, ' + (0.75 * hint[2]).toFixed(2) + ')';
					context.beginPath();
					context.moveTo(hint[0][0], hint[0][1]);
					context.lineTo(hint[1][0], hint[1][1]);
					context.stroke();
				});
				context.setLineDash([]);
			}
			// The squares of the grid round the track, outlined, close in on the debug map.
			if (vectors && showGrid && zoom >= self.GRID_PX_PER_KM) drawGrid(context, s, inView);
			var here = known.here, hereIndex = here && here.stationIndex ? here.globalPosition : null;
			var placed = [], labels = [];
			var fits = function(box) {
				if (box.x0 < 2 || box.y0 < 2 || box.x1 > s.width - 2 || box.y1 > s.height - 2) return false;
				return !placed.some(function(t) { return box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0; });
			};
			// Stations: solid where the player has been, hollow where they only know of one; cities larger. On the
			// debug map, only once close enough to tell them apart.
			var dot = Math.max(1.5, Math.min(4.5, zoom * 6));
			var stations = [];
			if (vectors && (!known.revealAll || zoom >= self.NAMES_PX_PER_KM / 2)) {
				inView.forEach(function(b) {
					b.stations.forEach(function(station) {
						if (station.tile.globalPosition === hereIndex) return;
						var p = toScreen(station.tile.geoCoordinate[0] * radians, station.tile.geoCoordinate[1] * radians, s);
						if (p && p[0] > -10 && p[1] > -10 && p[0] < s.width + 10 && p[1] < s.height + 10) stations.push({ station: station, p: p });
					});
				});
			}
			stations.sort(function(a, b) {
				return (b.station.city - a.station.city) || (b.station.visited - a.station.visited) || a.station.tile.globalPosition - b.station.tile.globalPosition;
			});
			stations.forEach(function(item) {
				var radius = item.station.city ? dot + 1.2 : dot, solid = known.revealAll || item.station.visited;
				context.beginPath();
				context.arc(item.p[0], item.p[1], radius, 0, 2 * Math.PI);
				context.lineWidth = 1.5;
				if (solid) {
					context.fillStyle = item.station.city ? '#f2dcae' : '#e5c58a';
					context.fill();
					context.strokeStyle = '#101416';
					context.stroke();
				} else {
					context.fillStyle = '#101416';
					context.fill();
					context.strokeStyle = item.station.city ? '#f2dcae' : '#e5c58a';
					context.stroke();
				}
				placed.push({ x0: item.p[0] - radius, x1: item.p[0] + radius, y0: item.p[1] - radius, y1: item.p[1] + radius });
			});
			// Here: a red dot in a ring that beats, or an arrow at the edge pointing the way when it is off the view.
			var hereAt = here && here.geoCoordinate ? toScreen(here.geoCoordinate[0] * radians, here.geoCoordinate[1] * radians, s) : null;
			var onView = hereAt && hereAt[0] >= 0 && hereAt[1] >= 0 && hereAt[0] <= s.width && hereAt[1] <= s.height;
			arrowBox = null;
			if (onView) {
				context.beginPath();
				context.arc(hereAt[0], hereAt[1], 9 + 7 * pulse, 0, 2 * Math.PI);
				context.strokeStyle = 'rgba(224, 98, 92, ' + (0.9 * (1 - pulse)).toFixed(2) + ')';
				context.lineWidth = 2.5;
				context.stroke();
				context.beginPath();
				context.arc(hereAt[0], hereAt[1], 9, 0, 2 * Math.PI);
				context.strokeStyle = '#e0625c';
				context.lineWidth = 2;
				context.stroke();
				context.beginPath();
				context.arc(hereAt[0], hereAt[1], 4.5, 0, 2 * Math.PI);
				context.fillStyle = '#e0625c';
				context.fill();
				context.lineWidth = 1.5;
				context.strokeStyle = '#101416';
				context.stroke();
				placed.push({ x0: hereAt[0] - 10, x1: hereAt[0] + 10, y0: hereAt[1] - 10, y1: hereAt[1] + 10 });
				labels.push({ p: hereAt, gap: 13, text: here.stationIndex ? here.station + ' (you are here)' : 'You are here', size: 12.5, colour: '#f08a84', bold: true });
			} else if (here && here.geoCoordinate) {
				// The way to here from the middle of the view: straight at it where it is in front, along the great circle
				// where it is round the back.
				var angle;
				if (hereAt) {
					angle = Math.atan2(hereAt[1] - s.height / 2, hereAt[0] - s.width / 2);
				} else {
					var lat2 = here.geoCoordinate[1] * radians, dLon = here.geoCoordinate[0] * radians - view.lon;
					var bearing = Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(view.lat) * Math.sin(lat2) - Math.sin(view.lat) * Math.cos(lat2) * Math.cos(dLon));
					angle = bearing - view.rotation - Math.PI / 2;
				}
				var ex = Math.cos(angle), ey = Math.sin(angle), inset = 26;
				var t = Math.min((s.width / 2 - inset) / Math.max(1e-6, Math.abs(ex)), (s.height / 2 - inset) / Math.max(1e-6, Math.abs(ey)));
				var ax = s.width / 2 + ex * t, ay = s.height / 2 + ey * t;
				context.save();
				context.translate(ax, ay);
				context.rotate(angle);
				context.beginPath();
				context.moveTo(14, 0); context.lineTo(-6, -9); context.lineTo(-2, 0); context.lineTo(-6, 9); context.closePath();
				context.fillStyle = 'rgba(224, 98, 92, ' + (0.75 + 0.25 * (1 - pulse)).toFixed(2) + ')';
				context.fill();
				context.lineWidth = 1.5;
				context.strokeStyle = '#101416';
				context.stroke();
				context.restore();
				arrowBox = { x: ax, y: ay };
				placed.push({ x0: ax - 14, x1: ax + 14, y0: ay - 14, y1: ay + 14 });
				labels.push({ p: [ax, ay], gap: 16, text: 'You are here', size: 12, colour: '#f08a84', bold: true });
			}
			stations.forEach(function(item) {
				if (!item.station.city && zoom < self.NAMES_PX_PER_KM) return;
				var radius = item.station.city ? dot + 1.2 : dot;
				labels.push({ p: item.p, gap: radius + 4, text: item.station.tile.station, size: item.station.city ? 12.5 : 11,
					colour: item.station.city ? '#f2dcae' : '#e5c58a', bold: item.station.city });
			});
			// Names placed greedily, on whichever side of the mark is clear, each with a dark halo.
			context.textBaseline = 'middle';
			context.lineJoin = 'round';
			labels.forEach(function(label) {
				context.font = (label.bold ? 'bold ' : '') + label.size + 'px sans-serif';
				var w = context.measureText(label.text).width, h = label.size, gap = label.gap;
				var candidates = [[label.p[0] + gap, label.p[1]], [label.p[0] - gap - w, label.p[1]],
					[label.p[0] - w / 2, label.p[1] - gap - h / 2], [label.p[0] - w / 2, label.p[1] + gap + h / 2]];
				for (var i = 0; i < candidates.length; i++) {
					var o = candidates[i], box = { x0: o[0] - 1, x1: o[0] + w + 1, y0: o[1] - h / 2 - 1, y1: o[1] + h / 2 + 1 };
					if (!fits(box)) continue;
					placed.push(box);
					context.textAlign = 'left';
					context.strokeStyle = '#101416';
					context.lineWidth = 3.5;
					context.strokeText(label.text, o[0], o[1]);
					context.fillStyle = label.colour;
					context.fillText(label.text, o[0], o[1]);
					return;
				}
			});
			// A compass needle, top left, pointing north; a click on it turns the map back to north up.
			var nx0 = 20, ny0 = 22;
			context.save();
			context.translate(nx0, ny0);
			context.rotate(-view.rotation);
			context.beginPath();
			context.moveTo(0, -13); context.lineTo(5, 0); context.lineTo(-5, 0); context.closePath();
			context.fillStyle = '#e0625c'; context.fill();
			context.beginPath();
			context.moveTo(0, 13); context.lineTo(5, 0); context.lineTo(-5, 0); context.closePath();
			context.fillStyle = '#d8d2c4'; context.fill();
			context.beginPath();
			context.moveTo(0, -13); context.lineTo(5, 0); context.lineTo(0, 13); context.lineTo(-5, 0); context.closePath();
			context.strokeStyle = '#101416'; context.lineWidth = 1.2; context.stroke();
			context.restore();
			compassBox = { x: nx0, y: ny0 };
			// A scale bar, bottom left, true at the middle of the view.
			var steps = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000], target = s.width / 5 / zoom, barKm = steps[0];
			steps.forEach(function(km) { if (km <= target) barKm = km; });
			var barPx = barKm * zoom, bx = 12, by = s.height - 14;
			context.beginPath();
			context.moveTo(bx, by - 5); context.lineTo(bx, by); context.lineTo(bx + barPx, by); context.lineTo(bx + barPx, by - 5);
			context.strokeStyle = '#101416'; context.lineWidth = 4; context.stroke();
			context.strokeStyle = '#d8d2c4'; context.lineWidth = 1.5; context.stroke();
			context.font = '11px sans-serif';
			context.textAlign = 'left';
			context.strokeStyle = '#101416'; context.lineWidth = 3;
			context.strokeText(setup.units.kilometres(barKm), bx, by - 11);
			context.fillStyle = '#d8d2c4';
			context.fillText(setup.units.kilometres(barKm), bx, by - 11);
		};
		var arrowBox = null, compassBox = null;

		// The here mark beats while the map is on the page (not on the debug map, whose overlay is heavy).
		var beatStart = Date.now(), beating = false;
		var beat = function() {
			if (!holder.isConnected) { beating = false; return; }
			drawOverlay(((Date.now() - beatStart) % 1600) / 1600);
			requestAnimationFrame(beat);
		};
		var draw = function(step) {
			drawGlobe(step);
			if (!beating) drawOverlay(0);
			if (typeof turnArrows === 'function') turnArrows();
		};

		// Moving: a third of the resolution and the track from its raster now, sharp and in lines once it has stopped for a
		// moment.
		var redraw = function() {
			moving = true;
			draw(3);
			clearTimeout(settleTimer);
			settleTimer = setTimeout(function() { moving = false; draw(1); }, 160);
		};
		// The outline of every square of the track in view: its corners, from the grid it is on, joined.
		var drawGrid = function(context, s, inView) {
			var world = setup.worldmap, path = new Path2D(), seen = {};
			inView.forEach(function(b) {
				b.segments.forEach(function(segment) {
					segment.tiles.forEach(function(tile) {
						var index = tile.globalPosition;
						if (seen[index]) return;
						seen[index] = true;
						var grid = world.gridFor(index);
						var corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(function(d) {
							var c = world.unprojectGrid(tile.x + d[0], tile.y + d[1], grid);
							return toScreen(c[0] * radians, c[1] * radians, s);
						});
						if (corners.some(function(c) { return !c; })) return;
						path.moveTo(corners[0][0], corners[0][1]);
						for (var i = 1; i < 4; i++) path.lineTo(corners[i][0], corners[i][1]);
						path.closePath();
					});
				});
			});
			context.strokeStyle = 'rgba(120, 190, 230, 0.7)';
			context.lineWidth = 1;
			context.stroke(path);
		};
		var zoomBy = function(factor) {
			view.pxPerKm *= factor;
			clampZoom();
			redraw();
		};
		var centreOnHere = function() {
			if (!known.here || !known.here.geoCoordinate) return;
			view.lon = known.here.geoCoordinate[0] * radians;
			view.lat = known.here.geoCoordinate[1] * radians;
			redraw();
		};
		// Pan: a third of the view's width towards a compass bearing (radians), along the great circle.
		var panTowards = function(bearing) {
			var s = lastSize || size(), d = s.width / 3 / view.pxPerKm / R, lat1 = view.lat;
			var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
			view.lon += Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
			view.lat = Math.max(-1.5, Math.min(1.5, lat2));
			redraw();
		};
		var turnTo = function(rotation) {
			var full = 2 * Math.PI;
			view.rotation = ((rotation % full) + full) % full;
			if (Math.abs(view.rotation - full) < 1e-9) view.rotation = 0;
			redraw();
		};
		var turnStep = 15 * radians;
		var pans = [];
		var pan = function(glyph, label, bearing) {
			var b = button(glyph, label, function() { panTowards(bearing * radians); }, 'globe-map-pan');
			pans.push({ element: b.firstChild, bearing: bearing });
			return b;
		};
		button('↺', 'Turn the map 15 degrees anticlockwise', function() { turnTo(view.rotation - turnStep); });
		pan('↑', 'Pan north', 0);
		button('↻', 'Turn the map 15 degrees clockwise', function() { turnTo(view.rotation + turnStep); });
		pan('↑', 'Pan west', 270);
		button('◎', 'Centre on where you are', centreOnHere);
		pan('↑', 'Pan east', 90);
		button('−', 'Zoom out', function() { zoomBy(1 / 1.6); });
		pan('↑', 'Pan south', 180);
		button('+', 'Zoom in', function() { zoomBy(1.6); });
		// Each pan arrow points the way it pans, as the map is turned.
		var turnArrows = function() {
			pans.forEach(function(item) {
				item.element.style.transform = 'rotate(' + Math.round(item.bearing - view.rotation / radians) + 'deg)';
			});
		};

		// The square nearest a point of the view, within a few pixels, from the buckets round it: for picking.
		var nearestTile = function(x, y) {
			var s = lastSize || size(), place = fromScreen(x, y, s);
			if (!place) return { tile: null, place: null };
			var best = null, limitKm = 10 / view.pxPerKm;
			for (var dLat = -1; dLat <= 1; dLat++) {
				for (var dLon = -1; dLon <= 1; dLon++) {
					var b = known.buckets[self.bucketOf(place[0] + dLon * self.BUCKET_DEGREES, place[1] + dLat * self.BUCKET_DEGREES)];
					if (!b) continue;
					b.segments.forEach(function(segment) {
						segment.tiles.forEach(function(tile) {
							var km = self.distanceKm(place, tile.geoCoordinate);
							if (km <= limitKm && (!best || km < best.km)) best = { km: km, tile: tile };
						});
					});
				}
			}
			return { tile: best ? best.tile : null, place: place };
		};

		// Dragging turns the globe under the pointer; two pointers pinch to zoom. A press that does not move is a
		// click: on the arrow to here it centres on here, on the debug map it picks the square under it.
		var pointers = {}, pinch = null, moved = false, down = null;
		overlay.addEventListener('pointerdown', function(event) {
			pointers[event.pointerId] = [event.clientX, event.clientY];
			down = [event.clientX, event.clientY];
			moved = false;
			if (overlay.setPointerCapture) overlay.setPointerCapture(event.pointerId);
			var ids = Object.keys(pointers);
			if (ids.length === 2) {
				var a = pointers[ids[0]], b = pointers[ids[1]];
				pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: view.pxPerKm };
			}
		});
		overlay.addEventListener('pointermove', function(event) {
			var last = pointers[event.pointerId];
			if (!last) {
				if (options.onHover) {
					var box = overlay.getBoundingClientRect(), found = nearestTile(event.clientX - box.left, event.clientY - box.top);
					options.onHover(found.tile, found.place);
				}
				return;
			}
			if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) moved = true;
			pointers[event.pointerId] = [event.clientX, event.clientY];
			var ids = Object.keys(pointers);
			if (ids.length === 2 && pinch) {
				var a = pointers[ids[0]], b = pointers[ids[1]];
				view.pxPerKm = pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, pinch.distance);
				clampZoom();
			} else if (ids.length === 1 && moved) {
				var perRadian = R * view.pxPerKm;
				// The drag in screen right and up, turned into east and north.
				var dRight = event.clientX - last[0], dUp = last[1] - event.clientY;
				var dEast = dRight * Math.cos(view.rotation) + dUp * Math.sin(view.rotation);
				var dNorth = -dRight * Math.sin(view.rotation) + dUp * Math.cos(view.rotation);
				view.lon -= dEast / perRadian / Math.max(0.2, Math.cos(view.lat));
				view.lat = Math.max(-1.5, Math.min(1.5, view.lat - dNorth / perRadian));
			} else {
				return;
			}
			redraw();
		});
		var release = function(event) {
			var wasClick = pointers[event.pointerId] && !moved && Object.keys(pointers).length === 1 && event.type === 'pointerup';
			delete pointers[event.pointerId];
			if (Object.keys(pointers).length < 2) pinch = null;
			if (!wasClick) return;
			var box = overlay.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
			if (arrowBox && Math.hypot(x - arrowBox.x, y - arrowBox.y) < 20) { centreOnHere(); return; }
			if (compassBox && Math.hypot(x - compassBox.x, y - compassBox.y) < 16) { turnTo(0); return; }
			if (options.onPick) {
				var found = nearestTile(x, y);
				if (found.tile) options.onPick(found.tile);
			}
		};
		overlay.addEventListener('pointerup', release);
		overlay.addEventListener('pointercancel', release);
		overlay.addEventListener('wheel', function(event) {
			event.preventDefault();
			zoomBy(Math.exp(-event.deltaY * 0.0015));
		}, { passive: false });

		this.loadTexture(function(loaded) {
			texture = loaded;
			if (!texture) return;
			if (!options.revealAll) knownBytes = self.knownTexture(texture, known.areas);
			trackBytes = self.trackTexture(texture, known);
			view.pxPerKm = size().width / self.OPEN_ACROSS_KM;
			clampZoom();
			draw(1);
			if (!options.revealAll && typeof requestAnimationFrame === 'function') {
				beating = true;
				requestAnimationFrame(beat);
			}
			// A redraw sets the holder's height, so it waits for the next frame: done inside the resize notification it
			// would resize what is being observed, which the browser reports as a loop (and SugarCube as an error).
			if (typeof ResizeObserver === 'function') {
				var lastWidth = holder.clientWidth, pendingResize = false;
				new ResizeObserver(function() {
					if (holder.clientWidth === lastWidth || pendingResize) return;
					pendingResize = true;
					requestAnimationFrame(function() {
						pendingResize = false;
						if (holder.clientWidth === lastWidth) return;
						lastWidth = holder.clientWidth;
						clampZoom();
						draw(1);
					});
				}).observe(holder);
			}
		});
		holder.globeView = view;
		holder.globeKnown = known;
		holder.redrawGlobe = function() { draw(1); };
		holder.centreOn = function(longitude, latitude, pxPerKm) {
			view.lon = longitude * radians;
			view.lat = latitude * radians;
			if (pxPerKm) view.pxPerKm = pxPerKm;
			clampZoom();
			draw(1);
		};
		holder.screenOf = function(longitude, latitude) { return toScreen(longitude * radians, latitude * radians, lastSize || size()); };
		// The debug map's grid squares, on or off.
		holder.setGrid = function(on) { showGrid = !!on; draw(1); };
		return holder;
	},

	// The legend under the Map tab's globe: what each mark means.
	legend: function() {
		var list = document.createElement('ul');
		list.className = 'globe-map-legend';
		var ns = 'http://www.w3.org/2000/svg';
		var item = function(draw, text) {
			var li = document.createElement('li');
			var swatch = document.createElementNS(ns, 'svg');
			swatch.setAttribute('viewBox', '0 0 24 14');
			swatch.setAttribute('width', 24);
			swatch.setAttribute('height', 14);
			swatch.setAttribute('aria-hidden', 'true');
			swatch.innerHTML = draw;
			li.appendChild(swatch);
			li.appendChild(document.createTextNode(' ' + text));
			list.appendChild(li);
		};
		item('<circle cx="12" cy="7" r="5.5" fill="none" stroke="#e0625c" stroke-width="1.6"/><circle cx="12" cy="7" r="2.8" fill="#e0625c"/>', 'You are here');
		item('<circle cx="12" cy="7" r="3.5" fill="#e5c58a" stroke="#101416" stroke-width="1.2"/>', 'A station you have been to');
		item('<circle cx="12" cy="7" r="3.5" fill="#101416" stroke="#e5c58a" stroke-width="1.4"/>', 'A station you know of');
		item('<path d="M1 7H23" stroke="#101416" stroke-width="4"/><path d="M1 7H23" stroke="#d8d2c4" stroke-width="2"/>', 'Railway you know');
		item('<path d="M1 7H23" stroke="#d8d2c4" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.6"/>', 'The line runs on into country you have not seen');
		item('<rect x="1" y="1" width="22" height="12" fill="#3a3d38"/>', 'Fog: country you have not seen');
		return list;
	}
};
