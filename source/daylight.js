// Time of day in the pictures: the rail yard and driving views are recoloured by where the sun is.
//
// The sun's elevation comes from the game clock and date, read as local solar time, at the latitude of wherever
// the player is. Sourced tiles carry their real latitude, so seasons and day length follow the playable route.
// The light is graded from that elevation:
//   day      above 12 degrees     the art as drawn
//   golden   12 to -2 degrees     warmer and a little darker as the sun gets low
//   dusk     -2 to -12 degrees    sliding into night
//   night    below -12 degrees    moonlight
//
// Night is a colour grade, not a dark overlay. Every colour in the drawing is mapped on its own: darkened in linear
// light, partly desaturated and shifted towards blue, so the relative contrast between neighbouring colours
// survives and nothing turns to a grey wash. Lit windows and lamps are left out of the grade and glow instead.
// The pictures read the clock only; nothing here is saved.
setup.daylight = {
	BASE_LATITUDE: -53.2, // Punta Arenas
	KM_PER_DEGREE: 111,
	// Colours that give off light when something is lighting them: a cab window. A cab is only lit while the player
	// is in that car, so the grade leaves these colours alone in the occupied car and dims them everywhere else.
	EMISSIVE: ['#dec38a'],
	// Night keeps the subject readable: trains and track are graded more gently than the scenery behind them, so
	// they stand out against it the way a lit foreground does.
	NIGHT: {
		subject: { brightness: 0.58, desaturate: 0.3 }, // share of each colour's linear light kept
		backdrop: { brightness: 0.36, desaturate: 0.45 },
		tint: [0.68, 0.8, 1.0], // moonlight
		lift: [0.006, 0.008, 0.016] // keeps the darkest colours from crushing to black
	},
	GOLDEN: { tint: [1.0, 0.86, 0.7], brightness: 0.85 },
	// --- where the sun is -----------------------------------------------------------------------------------
	getLatitude: function() {
		var worldmap = setup.worldmap;
		var view = worldmap && worldmap.getJourneyView ? worldmap.getJourneyView() : null;
		var tile = view ? view.tile : worldmap && State.variables && State.variables.currentStation
			? worldmap.getStationTile(worldmap.getSeed(), Number(State.variables.currentStation) || 1) : null;
		if (tile && Array.isArray(tile.geoCoordinate) && isFinite(Number(tile.geoCoordinate[1]))) {
			return Math.max(-66, Math.min(66, Number(tile.geoCoordinate[1])));
		}
		var y = tile && isFinite(Number(tile.y)) ? Number(tile.y) : 0;
		return Math.max(-66, Math.min(66, this.BASE_LATITUDE + (y * worldmap.TILE_KM) / this.KM_PER_DEGREE));
	},
	// The sun's elevation in degrees, from the usual approximation of its declination through the year.
	getSunElevation: function(timestampMs, latitude) {
		var date = new Date(timestampMs);
		var start = Date.UTC(date.getUTCFullYear(), 0, 1);
		var dayOfYear = Math.floor((timestampMs - start) / 86400000) + 1;
		var hours = date.getUTCHours() + date.getUTCMinutes() / 60;
		var rad = Math.PI / 180;
		var declination = -23.44 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));
		var hourAngle = (hours - 12) * 15;
		var sine = Math.sin(latitude * rad) * Math.sin(declination * rad)
			+ Math.cos(latitude * rad) * Math.cos(declination * rad) * Math.cos(hourAngle * rad);
		return Math.asin(Math.max(-1, Math.min(1, sine))) / rad;
	},
	// How the light is right now: night from 0 (day) to 1 (full night), golden from 0 to 1 at its warmest.
	getLight: function(elevation) {
		if (typeof elevation !== 'number') {
			elevation = this.getSunElevation(setup.time.getCurrentTimestampMs(), this.getLatitude());
		}
		var smooth = function(edge0, edge1, x) {
			var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
			return t * t * (3 - 2 * t);
		};
		var night = 1 - smooth(-12, -2, elevation);
		var golden = smooth(12, 3, elevation) * (1 - smooth(-2, -8, elevation));
		var phase = night >= 0.999 ? 'night' : night > 0.001 ? 'dusk' : golden > 0.001 ? 'golden' : 'day';
		return { elevation: elevation, night: night, golden: golden, phase: phase };
	},
	// --- colour ---------------------------------------------------------------------------------------------
	toLinear: function(channel) {
		var c = channel / 255;
		return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	},
	toByte: function(linear) {
		var c = Math.max(0, Math.min(1, linear));
		var s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
		return Math.round(s * 255);
	},
	parseHex: function(hex) {
		var match = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
		if (!match) {
			return null;
		}
		var value = parseInt(match[1], 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
	},
	toHex: function(rgb) {
		return '#' + rgb.map(function(c) { return (c < 16 ? '0' : '') + c.toString(16); }).join('');
	},
	isEmissive: function(hex) {
		return this.EMISSIVE.indexOf(String(hex).toLowerCase()) !== -1;
	},
	// One colour under the given light. Day returns the colour untouched, so daytime pictures are exactly the art.
	// role is 'subject' (trains, track, the yard) or 'backdrop' (the scenery behind the train). An emissive colour
	// is only left alone in a grader made with lit set: an unoccupied cab has nobody in it to light the lamp.
	grade: function(hex, light, role, lit) {
		var rgb = this.parseHex(hex);
		if (!rgb || !light || (light.night <= 0.001 && light.golden <= 0.001) || (lit && this.isEmissive(hex))) {
			return hex;
		}
		var self = this;
		var linear = rgb.map(function(c) { return self.toLinear(c); });
		var golden = this.GOLDEN;
		var warm = linear.map(function(c, i) {
			var factor = 1 + (golden.tint[i] * golden.brightness - 1) * light.golden;
			return c * factor;
		});
		var night = this.NIGHT;
		var strength = night[role === 'backdrop' ? 'backdrop' : 'subject'];
		var luma = 0.2126 * warm[0] + 0.7152 * warm[1] + 0.0722 * warm[2];
		var moonlit = warm.map(function(c, i) {
			var grey = c + (luma - c) * strength.desaturate;
			return grey * strength.brightness * night.tint[i] + night.lift[i];
		});
		var out = warm.map(function(c, i) { return c + (moonlit[i] - c) * light.night; });
		return this.toHex(out.map(function(c) { return self.toByte(c); }));
	},
	// A grading function that remembers what it has already worked out, for a drawing's many repeated colours.
	createGrader: function(light, role, lit) {
		var self = this;
		var cache = {};
		return function(hex) {
			if (!(hex in cache)) {
				cache[hex] = self.grade(hex, light, role, lit);
			}
			return cache[hex];
		};
	},
	isGraded: function(light) {
		return !!light && (light.night > 0.001 || light.golden > 0.001);
	},
	// Recolours every filled shape inside an element.
	applyToElement: function(element, grader) {
		if (!element || !grader) {
			return;
		}
		var shapes = element.querySelectorAll ? element.querySelectorAll('[fill]') : [];
		for (var i = 0; i < shapes.length; i++) {
			var fill = shapes[i].getAttribute('fill');
			var graded = grader(fill);
			if (graded !== fill) {
				shapes[i].setAttribute('fill', graded);
			}
		}
	}
};
