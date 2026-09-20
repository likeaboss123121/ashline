// Frozen v0.1.0 generator, from GitHub tag MajorUpdate (a7b0d213).
// SugarCube saved BEFORE passage rendering. An arriving station may therefore be
// absent from the snapshot even though the old player saw it. Reconstruct only
// that missing station with its original rules; never regenerate a saved yard.
setup.saveLegacy010 = {
	station: function(v) {
		var defaults = v.defaultTrains, types = v.cargoTypes;
		function copy(value) { return JSON.parse(JSON.stringify(value)); }
		function locomotive(key) { var car = copy(defaults[key]); car.cargo = []; return car; }
		function lead() { return { length: 999999, infinite: true, trains: [] }; }
		if (v.currentStation === 1) {
			var starter = locomotive('dieselLoco'); starter.cargo = [{ type: 'diesel', amount: 400 }];
			return [lead(), { length: 120, trains: [[starter]] }, lead()];
		}
		var seed = v.randomSeed + v.currentStation, hash = 2166136261;
		for (var si = 0; si < seed.length; si++) hash = Math.imul(hash ^ seed.charCodeAt(si), 16777619);
		var a = hash >>> 0;
		function rng() {
			a |= 0; a = Math.imul(a + 0x6D2B79F5, 1);
			var t = a ^ (a >>> 15); t = Math.imul(t, t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		}
		function integer(min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
		function pick(values) { return values[integer(0, values.length - 1)]; }
		var locos = ['steamLoco', 'dieselLoco'], cars = ['boxcar', 'flatcar', 'tanker', 'gondola'];
		var presets = [
			{ type: 'coal', amount: 25, weight: 4 }, { type: 'water', amount: 1200, weight: 4 },
			{ type: 'timber', amount: 35, weight: 4 }, { type: 'scrap metal', amount: 20, weight: 2 },
			{ type: 'machinery', amount: 10, weight: 2 }, { type: 'food', amount: 45, weight: 1 }
		];
		function cargo(key) {
			if (rng() > 0.2) return [];
			var accepted = defaults[key].acceptedCargo || [];
			var filtered = presets.filter(function(preset) {
				return Object.keys(types).some(function(name) {
					return name === preset.type && (accepted.indexOf(name) !== -1
						|| types[name].tags.some(function(tag) { return accepted.indexOf(tag) !== -1; }));
				});
			});
			if (!filtered.length) return [];
			var count = key === 'boxcar' ? integer(1, 2) : 1, result = [];
			for (var i = 0; i < count; i++) {
				var r = rng() * filtered.reduce(function(total, p) { return total + p.weight; }, 0), sum = 0;
				var item = filtered[filtered.length - 1];
				for (var j = 0; j < filtered.length; j++) { sum += filtered[j].weight; if (r < sum) { item = filtered[j]; break; } }
				result.push({ type: item.type, amount: integer(Math.max(1, Math.floor(item.amount * 0.5)), item.amount) });
			}
			return result;
		}
		var count = integer(1, 15), tracks = [], hasLoco = false, previous = integer(100, 1000);
		for (var i = 0; i < count; i++) {
			var length = i === 0 ? previous : integer(Math.max(100, previous - 15), Math.min(1000, previous + 15));
			previous = length;
			var track = { length: length, trains: [] }, remaining = length, roll = rng();
			var trainCount = roll < 0.30 ? 0 : roll < 0.60 ? 1 : roll < 0.80 ? 2 : roll < 0.93 ? 3 : 4;
			for (var ti = 0; ti < trainCount && remaining >= 12; ti++) {
				var train = [], trainLength = 0, target = integer(1, 10);
				if ((!hasLoco && rng() < 0.45) || (hasLoco && rng() < 0.12)) {
					var loco = locomotive(pick(locos));
					if (loco.length <= remaining) { train.push(loco); trainLength += loco.length; hasLoco = true; }
				}
				for (var ci = train.length; ci < target; ci++) {
					var key = pick(cars), car = copy(defaults[key]); car.cargo = cargo(key);
					if (trainLength + car.length > remaining) break;
					train.push(car); trainLength += car.length;
				}
				if (train.length) { track.trains.push(train); remaining -= trainLength; }
			}
			tracks.push(track);
		}
		if (!hasLoco) {
			for (var fi = 0; fi < tracks.length; fi++) {
				var fallback = locomotive(pick(locos));
				var used = tracks[fi].trains.reduce(function(total, train) {
					return total + train.reduce(function(sum, car) { return sum + car.length; }, 0);
				}, 0);
				if (used + fallback.length <= tracks[fi].length) { tracks[fi].trains.unshift([fallback]); break; }
			}
		}
		return [lead()].concat(tracks, [lead()]);
	}
};
