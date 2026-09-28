/* The Map tab: the Earth as a globe the player can turn and zoom, with fog of war.

   The land is drawn everywhere from one small texture baked at build time (scripts/world/globe-texture.cjs:
   greyscale, water 0, land its shaded relief), so the shape of the country can always be read. The railways, the
   stations and their names are drawn only where the player knows them: round every station map they have read
   (MAP_KM), every station they have visited and where they are now (NEAR_KM). Elsewhere the land lies under fog.

   The globe is an orthographic projection drawn a pixel at a time into a canvas, the track and names on top.
   Dragging turns it, the wheel, a pinch or the buttons zoom it, and it opens on the player. While it is moving it is
   drawn at a third of the resolution, and sharp again once it stops. Nothing here is saved: what the player knows comes from
   the seen maps and the journal, and the rest from the compiled network. */
setup.globe = {
	MAP_KM: 150,
	NEAR_KM: 50,
	EARTH_KM: 6371.0088,
	OPEN_ACROSS_KM: 1500, // how much country the map shows across when it opens
	// The relief is about 20 km a texel and the coastlines about 5, so the globe stops zooming in before the coast turns
	// to blocks: closer detail is the station maps' job.
	MAX_PX_PER_KM: 1.2,
	NAMES_PX_PER_KM: 0.3, // station names from this close in; cities and here always
	FLAT_SHADE: 205, // the texture's value for level ground (see globe-texture.cjs)

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

	// What the player knows: [{ place: [longitude, latitude], km }], and the squares of track within it.
	getKnown: function() {
		var pilot = setup.realWorldPilot, route = pilot.getGridRoute(), self = this, areas = [];
		setup.wayfinding.getSeenMaps().forEach(function(stationId) {
			var tile = pilot.getStationTile(stationId);
			if (tile) areas.push({ place: tile.geoCoordinate, km: self.MAP_KM });
		});
		var journal = State.variables.journal;
		(journal && Array.isArray(journal.stations) ? journal.stations : []).forEach(function(stationId) {
			var tile = pilot.getStationTile(Number(stationId));
			if (tile) areas.push({ place: tile.geoCoordinate, km: self.NEAR_KM });
		});
		var here = setup.wayfinding.getHereTile();
		if (here && here.geoCoordinate) areas.push({ place: here.geoCoordinate, km: this.NEAR_KM });
		var radians = Math.PI / 180, R = this.EARTH_KM;
		var within = function(p, area) {
			var dLat = (p[1] - area.place[1]) * radians, dLon = (p[0] - area.place[0]) * radians;
			var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(p[1] * radians) * Math.cos(area.place[1] * radians) * Math.pow(Math.sin(dLon / 2), 2);
			return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))) <= area.km;
		};
		var shown = {};
		route.tiles.forEach(function(tile) {
			var p = tile.geoCoordinate;
			if (!p) return;
			for (var i = 0; i < areas.length; i++) {
				if (Math.abs(areas[i].place[1] - p[1]) > 3) continue;
				if (within(p, areas[i])) { shown[tile.globalPosition] = tile; return; }
			}
		});
		// The track as segments between the middles of known squares, each move once; the stations on it.
		var segments = [], stations = [];
		Object.keys(shown).forEach(function(index) {
			var tile = shown[index];
			tile.ends.forEach(function(end) {
				var direction = setup.worldmap.DIRECTIONS[end];
				var next = route.byKey[setup.worldmap.key(tile.x + direction.dx, tile.y + direction.dy)];
				if (!next || !shown[next.globalPosition] || next.globalPosition < tile.globalPosition) return;
				segments.push([tile.geoCoordinate[0] * radians, tile.geoCoordinate[1] * radians, next.geoCoordinate[0] * radians, next.geoCoordinate[1] * radians]);
			});
			if (tile.stationIndex) stations.push(tile);
		});
		return { areas: areas, segments: segments, stations: stations, here: here };
	},

	// How known each texel of the texture is, 0 to 255, for the fog: full inside each area, fading over its outer fifth.
	knownTexture: function(texture, areas) {
		var width = texture.width, height = texture.height, known = new Uint8Array(width * height), radians = Math.PI / 180;
		var R = this.EARTH_KM;
		areas.forEach(function(area) {
			var lat0 = area.place[1], reach = area.km * 1.2, dLat = reach / 111.2;
			var dLon = Math.min(180, reach / (111.2 * Math.max(0.05, Math.cos(lat0 * radians))));
			var row0 = Math.max(0, Math.floor((90 - lat0 - dLat) / 180 * height)), row1 = Math.min(height - 1, Math.ceil((90 - lat0 + dLat) / 180 * height));
			for (var row = row0; row <= row1; row++) {
				var lat = 90 - (row + 0.5) * 180 / height;
				var c0 = Math.floor((area.place[0] - dLon + 180) / 360 * width), c1 = Math.ceil((area.place[0] + dLon + 180) / 360 * width);
				for (var c = c0; c <= c1; c++) {
					var column = ((c % width) + width) % width, lon = -180 + (column + 0.5) * 360 / width;
					var a = Math.pow(Math.sin((lat - lat0) * radians / 2), 2) + Math.cos(lat * radians) * Math.cos(lat0 * radians)
						* Math.pow(Math.sin((lon - area.place[0]) * radians / 2), 2);
					var km = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
					var value = km <= area.km ? 255 : km >= reach ? 0 : Math.round(255 * (reach - km) / (reach - area.km));
					var at = row * width + column;
					if (value > known[at]) known[at] = value;
				}
			}
		});
		return known;
	},

	// The globe, in a holder: a canvas, and zoom and centre buttons. Returns the holder; draws once the texture is in.
	build: function() {
		var self = this, known = this.getKnown(), R = this.EARTH_KM, radians = Math.PI / 180;
		var holder = document.createElement('div');
		holder.className = 'globe-map';
		var canvas = document.createElement('canvas');
		canvas.className = 'globe-map-canvas';
		canvas.setAttribute('role', 'img');
		canvas.setAttribute('aria-label', 'Map of the railways you have seen');
		var bar = document.createElement('div');
		bar.className = 'globe-map-controls';
		var button = function(text, label, onClick) {
			var b = document.createElement('button');
			b.type = 'button';
			b.textContent = text;
			b.title = label;
			b.setAttribute('aria-label', label);
			b.addEventListener('click', onClick);
			bar.appendChild(b);
			return b;
		};
		holder.appendChild(canvas);
		holder.appendChild(bar);

		// The view: the point at the middle of the globe, and its size in pixels per kilometre.
		var start = known.here && known.here.geoCoordinate ? known.here.geoCoordinate : [0, 0];
		var view = { lon: start[0] * radians, lat: start[1] * radians, pxPerKm: null };
		var texture = null, knownBytes = null, settleTimer = null, pixels = null;
		var size = function() {
			var width = Math.max(260, Math.round(holder.clientWidth || 600));
			var height = Math.round(Math.min(width * 0.8, (window.innerHeight || 800) * 0.65));
			return { width: width, height: Math.max(240, height) };
		};
		var fitPxPerKm = function(s) { return 0.45 * Math.min(s.width, s.height) / R; };
		var clampZoom = function() {
			var s = size();
			view.pxPerKm = Math.max(fitPxPerKm(s), Math.min(self.MAX_PX_PER_KM, view.pxPerKm));
		};
		// A longitude and latitude (radians) on the canvas, or null on the far side of the globe.
		var toScreen = function(lon, lat, s) {
			var cosC = Math.sin(view.lat) * Math.sin(lat) + Math.cos(view.lat) * Math.cos(lat) * Math.cos(lon - view.lon);
			if (cosC < 0) return null;
			var r = R * view.pxPerKm;
			return [s.width / 2 + r * Math.cos(lat) * Math.sin(lon - view.lon),
				s.height / 2 - r * (Math.cos(view.lat) * Math.sin(lat) - Math.sin(view.lat) * Math.cos(lat) * Math.cos(lon - view.lon))];
		};

		var draw = function(step) {
			if (!texture) return;
			var s = size(), ratio = Math.min(1.5, window.devicePixelRatio || 1);
			if (canvas.width !== Math.round(s.width * ratio) || canvas.height !== Math.round(s.height * ratio)) {
				canvas.width = Math.round(s.width * ratio);
				canvas.height = Math.round(s.height * ratio);
				canvas.style.width = s.width + 'px';
				canvas.style.height = s.height + 'px';
				pixels = null;
			}
			var context = canvas.getContext('2d');
			var w = canvas.width, h = canvas.height;
			if (!pixels) pixels = context.createImageData(w, h);
			var data = pixels.data, r = R * view.pxPerKm * ratio, cx = w / 2, cy = h / 2;
			var sinLat0 = Math.sin(view.lat), cosLat0 = Math.cos(view.lat);
			var tw = texture.width, th = texture.height, bytes = texture.bytes, fine = texture.land;
			var landAt = function(column, row) {
				column = ((column % fine.columns) + fine.columns) % fine.columns;
				row = Math.max(0, Math.min(fine.rows - 1, row));
				var i = row * fine.columns + column;
				return (fine.bits[i >> 3] >> (i & 7)) & 1;
			};
			var graticule = 15 * radians, lineWidth = 0.7 / r;
			for (var y = 0; y < h; y += step) {
				for (var x = 0; x < w; x += step) {
					var nx = (x + step / 2 - cx) / r, ny = (cy - y - step / 2) / r, rho2 = nx * nx + ny * ny, red, green, blue;
					if (rho2 > 1) {
						// Space, with a faint glow round the edge of the Earth.
						var glow = Math.max(0, 1 - (Math.sqrt(rho2) - 1) * r / (14 * ratio));
						red = 10 + 14 * glow; green = 13 + 22 * glow; blue = 17 + 30 * glow;
					} else {
						var z = Math.sqrt(1 - rho2);
						var lat = Math.asin(z * sinLat0 + ny * cosLat0);
						var lon = view.lon + Math.atan2(nx, z * cosLat0 - ny * sinLat0);
						// Bilinear: how much of the four texels round the point is land, and their shading.
						var u = ((lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1 * tw - 0.5, v = (0.5 - lat / Math.PI) * th - 0.5;
						var u0 = Math.floor(u), v0 = Math.max(0, Math.min(th - 1, Math.floor(v))), fu = u - u0, fv = Math.max(0, Math.min(1, v - v0));
						var u1 = (u0 + 1) % tw, v1 = Math.min(th - 1, v0 + 1);
						u0 = (u0 + tw) % tw;
						var a = bytes[v0 * tw + u0], b = bytes[v0 * tw + u1], c = bytes[v1 * tw + u0], d = bytes[v1 * tw + u1];
						var wa = (1 - fu) * (1 - fv), wb = fu * (1 - fv), wc = (1 - fu) * fv, wd = fu * fv;
						var landWeight = (a ? wa : 0) + (b ? wb : 0) + (c ? wc : 0) + (d ? wd : 0);
						var shadeValue = landWeight > 0 ? ((a ? wa * a : 0) + (b ? wb * b : 0) + (c ? wc * c : 0) + (d ? wd * d : 0)) / landWeight : self.FLAT_SHADE;
						// Land or water from the finer mask, bilinear too, where there is one.
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
						var k = (wa * knownBytes[v0 * tw + u0] + wb * knownBytes[v0 * tw + u1] + wc * knownBytes[v1 * tw + u0]
							+ wd * knownBytes[v1 * tw + u1]) / 255, fog = 0.62 + 0.38 * k, grey = (red + green + blue) / 3;
						red = (grey + (red - grey) * (0.6 + 0.4 * k)) * fog;
						green = (grey + (green - grey) * (0.6 + 0.4 * k)) * fog;
						blue = (grey + (blue - grey) * (0.6 + 0.4 * k)) * fog;
						// Lines of latitude and longitude every 15 degrees, faintly.
						var latLine = Math.abs(lat / graticule - Math.round(lat / graticule)) * graticule;
						var lonLine = Math.abs(lon / graticule - Math.round(lon / graticule)) * graticule * Math.cos(lat);
						if (latLine < lineWidth * step || lonLine < lineWidth * step) { red += 14; green += 16; blue += 18; }
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
			context.save();
			context.scale(ratio, ratio);
			drawTrack(context, s);
			context.restore();
		};

		// The known track, stations, names and here, over the globe.
		var drawTrack = function(context, s) {
			var zoom = view.pxPerKm, width = Math.max(1, Math.min(3, zoom * 2.2));
			context.lineCap = 'round';
			context.lineJoin = 'round';
			var path = new Path2D();
			known.segments.forEach(function(segment) {
				var a = toScreen(segment[0], segment[1], s), b = toScreen(segment[2], segment[3], s);
				if (!a || !b) return;
				path.moveTo(a[0], a[1]);
				path.lineTo(b[0], b[1]);
			});
			context.strokeStyle = '#101416';
			context.lineWidth = width + 2.5;
			context.stroke(path);
			context.strokeStyle = '#d8d2c4';
			context.lineWidth = width;
			context.stroke(path);
			var here = known.here, hereTile = here && here.stationIndex ? here : null;
			var placed = [], labels = [];
			var fits = function(box) {
				if (box.x0 < 2 || box.y0 < 2 || box.x1 > s.width - 2 || box.y1 > s.height - 2) return false;
				return !placed.some(function(t) { return box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0; });
			};
			var rank = function(tile) {
				if (hereTile && tile.globalPosition === hereTile.globalPosition) return 0;
				if (tile.stationStatus === 'city') return 1;
				if (tile.stationStatus === 'halt') return 4;
				return tile.stationStatus === 'active' || tile.stationStatus === 'settlement' ? 2 : 3;
			};
			var stations = known.stations.map(function(tile) {
				var p = toScreen(tile.geoCoordinate[0] * radians, tile.geoCoordinate[1] * radians, s);
				return p ? { tile: tile, p: p, rank: rank(tile) } : null;
			}).filter(Boolean).sort(function(a, b) { return a.rank - b.rank || a.tile.globalPosition - b.tile.globalPosition; });
			var dot = Math.max(1.5, Math.min(4.5, zoom * 6));
			stations.forEach(function(station) {
				if (station.rank === 0) return;
				var radius = station.rank === 1 ? dot + 1.2 : dot;
				context.beginPath();
				context.arc(station.p[0], station.p[1], radius, 0, 2 * Math.PI);
				context.fillStyle = station.rank === 1 ? '#f2dcae' : '#e5c58a';
				context.fill();
				context.lineWidth = 1.5;
				context.strokeStyle = '#101416';
				context.stroke();
				placed.push({ x0: station.p[0] - radius, x1: station.p[0] + radius, y0: station.p[1] - radius, y1: station.p[1] + radius });
			});
			// Here: a red dot in a ring, at the station or out on the line.
			var hereAt = here && here.geoCoordinate ? toScreen(here.geoCoordinate[0] * radians, here.geoCoordinate[1] * radians, s) : null;
			if (hereAt) {
				context.beginPath();
				context.arc(hereAt[0], hereAt[1], 9, 0, 2 * Math.PI);
				context.strokeStyle = 'rgba(224, 98, 92, 0.85)';
				context.lineWidth = 2;
				context.stroke();
				context.beginPath();
				context.arc(hereAt[0], hereAt[1], 4.5, 0, 2 * Math.PI);
				context.fillStyle = '#e0625c';
				context.fill();
				context.lineWidth = 1.5;
				context.strokeStyle = '#101416';
				context.stroke();
				placed.push({ x0: hereAt[0] - 9, x1: hereAt[0] + 9, y0: hereAt[1] - 9, y1: hereAt[1] + 9 });
				labels.push({ p: hereAt, gap: 13, text: hereTile ? hereTile.station + ' (you are here)' : 'You are here', size: 12.5, colour: '#f08a84', bold: true });
			}
			stations.forEach(function(station) {
				if (station.rank === 0) return;
				if (station.rank > 1 && zoom < self.NAMES_PX_PER_KM) return;
				labels.push({ p: station.p, gap: (station.rank === 1 ? dot + 1.2 : dot) + 4, text: station.tile.station, size: station.rank === 1 ? 12.5 : 11,
					colour: station.rank === 1 ? '#f2dcae' : '#e5c58a', bold: station.rank === 1 });
			});
			// Names placed greedily, on whichever side of the marker is clear, each with a dark halo.
			context.textBaseline = 'middle';
			context.lineJoin = 'round';
			labels.forEach(function(label) {
				context.font = (label.bold ? 'bold ' : '') + label.size + 'px sans-serif';
				var w = context.measureText(label.text).width, h = label.size, gap = label.gap;
				var options = [[label.p[0] + gap, label.p[1], 'left'], [label.p[0] - gap - w, label.p[1], 'left'],
					[label.p[0] - w / 2, label.p[1] - gap - h / 2, 'left'], [label.p[0] - w / 2, label.p[1] + gap + h / 2, 'left']];
				for (var i = 0; i < options.length; i++) {
					var o = options[i], box = { x0: o[0] - 1, x1: o[0] + w + 1, y0: o[1] - h / 2 - 1, y1: o[1] + h / 2 + 1 };
					if (!fits(box)) continue;
					placed.push(box);
					context.textAlign = o[2];
					context.strokeStyle = '#101416';
					context.lineWidth = 3.5;
					context.strokeText(label.text, o[0], o[1]);
					context.fillStyle = label.colour;
					context.fillText(label.text, o[0], o[1]);
					return;
				}
			});
			// A scale bar, bottom left, where the middle of the view is.
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

		// Moving: a third of the resolution now, sharp once it has stopped for a moment.
		var redraw = function() {
			draw(3);
			clearTimeout(settleTimer);
			settleTimer = setTimeout(function() { draw(1); }, 160);
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
		button('+', '[NEEDS WRITING PASS] Zoom in', function() { zoomBy(1.6); });
		button('−', '[NEEDS WRITING PASS] Zoom out', function() { zoomBy(1 / 1.6); });
		button('◎', '[NEEDS WRITING PASS] Centre on where you are', centreOnHere);

		// Dragging turns the globe under the pointer; two pointers pinch to zoom.
		var pointers = {}, pinch = null;
		canvas.addEventListener('pointerdown', function(event) {
			pointers[event.pointerId] = [event.clientX, event.clientY];
			if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
			var ids = Object.keys(pointers);
			if (ids.length === 2) {
				var a = pointers[ids[0]], b = pointers[ids[1]];
				pinch = { distance: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: view.pxPerKm };
			}
		});
		canvas.addEventListener('pointermove', function(event) {
			var last = pointers[event.pointerId];
			if (!last) return;
			pointers[event.pointerId] = [event.clientX, event.clientY];
			var ids = Object.keys(pointers);
			if (ids.length === 2 && pinch) {
				var a = pointers[ids[0]], b = pointers[ids[1]];
				view.pxPerKm = pinch.zoom * Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, pinch.distance);
				clampZoom();
			} else if (ids.length === 1) {
				var perRadian = R * view.pxPerKm;
				view.lon -= (event.clientX - last[0]) / perRadian / Math.max(0.2, Math.cos(view.lat));
				view.lat = Math.max(-1.5, Math.min(1.5, view.lat + (event.clientY - last[1]) / perRadian));
			}
			redraw();
		});
		var release = function(event) {
			delete pointers[event.pointerId];
			if (Object.keys(pointers).length < 2) pinch = null;
		};
		canvas.addEventListener('pointerup', release);
		canvas.addEventListener('pointercancel', release);
		canvas.addEventListener('wheel', function(event) {
			event.preventDefault();
			zoomBy(Math.exp(-event.deltaY * 0.0015));
		}, { passive: false });
		canvas.style.touchAction = 'none';

		this.loadTexture(function(loaded) {
			texture = loaded;
			if (!texture) return;
			knownBytes = self.knownTexture(texture, known.areas);
			var s = size();
			view.pxPerKm = s.width / self.OPEN_ACROSS_KM;
			clampZoom();
			draw(1);
			if (typeof ResizeObserver === 'function') {
				var lastWidth = holder.clientWidth;
				new ResizeObserver(function() {
					if (holder.clientWidth === lastWidth) return;
					lastWidth = holder.clientWidth;
					clampZoom();
					draw(1);
				}).observe(holder);
			}
		});
		holder.globeView = view;
		holder.redrawGlobe = function() { draw(1); };
		return holder;
	}
};
