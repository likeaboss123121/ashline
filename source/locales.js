/* Authored regional flavour, not a climate survey or a country's real fleet inventory.
   Coordinates choose scenery and freight/stock tendencies; the seed chooses a yard's industry.
   No network-sized cache, new story variables, or changes to already generated yards. */
setup.locales = {
	BIOMES: {
		steppe: { name: 'Dry steppe', plant: 'scrub', ground: '#69674c' },
		pampas: { name: 'Grassland', plant: 'grass', ground: '#65734c' },
		savanna: { name: 'Savanna', plant: 'acacia', ground: '#81744c' },
		rainforest: { name: 'Tropical rain forest', plant: 'broadleaf', ground: '#384e37' },
		wetland: { name: 'Coastal wetland', plant: 'cypress', ground: '#485b49' },
		desert: { name: 'Desert', plant: 'scrub', ground: '#897b59' },
		mediterranean: { name: 'Dry woodland', plant: 'olive', ground: '#72704e' },
		temperate: { name: 'Temperate forest', plant: 'oak', ground: '#4e6045' },
		taiga: { name: 'Taiga', plant: 'pine', ground: '#485747' },
		tundra: { name: 'Tundra', plant: 'moss', ground: '#777d70' },
		alpine: { name: 'Highland', plant: 'rock', ground: '#73766c' }
	},
	// Weights are gameplay choices, not a ranking of countries. Legacy fleets favour a modest older diesel,
	// not an assumption that every lower-income railway uses steam. All stock remains possible everywhere.
	FLEETS: {
		legacy: { dieselShunter: 5, dieselOldRoad: 12, dieselRoad: 3, steamShunter: 2, steamPrairie: 2 },
		mixed: { dieselShunter: 6, dieselOldRoad: 7, dieselRoad: 7, steamShunter: 1, steamPrairie: 1 },
		heavy: { dieselShunter: 5, dieselOldRoad: 3, dieselRoad: 14, steamShunter: 1, steamPrairie: 1 }
	},
	INDUSTRIES: {
		farming: { name: 'Agriculture', cars: { hopper: 4, refrigerated: 4, boxcar: 2 }, cargo: { food: 12, fertilizer: 4, machinery: 2 } },
		forestry: { name: 'Timber', cars: { flatcar: 5, gondola: 3 }, cargo: { timber: 12, firewood: 8 } },
		mining: { name: 'Mining', cars: { hopper: 5, gondola: 4 }, cargo: { 'iron ore': 12, coal: 8, 'scrap metal': 3 } },
		oil: { name: 'Fuel distribution', cars: { tanker: 6, boxcar: 2 }, cargo: { diesel: 12, machinery: 3 } },
		manufacturing: { name: 'Manufacturing', cars: { boxcar: 4, flatcar: 3 }, cargo: { machinery: 10, 'scrap metal': 6, cotton: 3 } }
	},
	profile: function(coordinate, elevation) {
		var lon = coordinate && coordinate[0], lat = coordinate && coordinate[1];
		var id = 'temperate', fleet = 'mixed', industries = ['manufacturing', 'farming', 'forestry'];
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { biome: id, vegetation: id, stockRegion: 'europe', fleet: fleet, industries: industries };
		if (lon < -30) {
			if (lat < -40) { id = lon < -72 ? 'temperate' : 'steppe'; industries = ['farming', 'mining']; fleet = 'legacy'; }
			else if (lat < -28) { id = lon < -70 ? 'mediterranean' : 'pampas'; industries = ['farming', 'farming', 'manufacturing']; fleet = 'legacy'; }
			else if (lat < -14 && lon < -67) { id = 'desert'; industries = ['mining', 'mining', 'oil']; fleet = 'legacy'; }
			else if (lat < 9) { id = lat > -14 && lon < -48 ? 'rainforest' : 'savanna'; industries = ['forestry', 'farming', 'mining']; fleet = 'legacy'; }
			else if (lat < 24) { id = 'rainforest'; industries = ['farming', 'forestry', 'oil']; fleet = 'legacy'; }
			else if (lat < 35 && lon > -101 && lon < -77) { id = 'wetland'; industries = ['oil', 'forestry', 'farming']; fleet = 'heavy'; }
			else if (lat < 41 && lon < -103) { id = 'desert'; industries = ['mining', 'oil', 'farming']; fleet = 'heavy'; }
			else if (lat >= 66) { id = 'tundra'; industries = ['mining', 'oil']; fleet = 'heavy'; }
			else if (lat >= 40 && lat < 60 && lon < -121) { id = 'temperate'; industries = ['forestry', 'manufacturing']; fleet = 'heavy'; }
			else if (lat >= 51) { id = 'taiga'; industries = ['forestry', 'mining', 'oil']; fleet = 'heavy'; }
			else { id = lon < -95 ? 'pampas' : 'temperate'; industries = ['farming', 'manufacturing', 'forestry']; fleet = 'heavy'; }
		} else if (lon < 53 && lat < 37 && lat > -36) {
			fleet = 'legacy';
			if (lat > 31 || (lat < -31 && lon < 23)) { id = 'mediterranean'; industries = ['farming', 'manufacturing']; }
			else if (lat > 15 || (lat < -17 && lon < 19)) { id = 'desert'; industries = ['oil', 'mining']; }
			else if (lat > -6 && lat < 7 && lon < 31) { id = 'rainforest'; industries = ['forestry', 'mining']; }
			else { id = 'savanna'; industries = ['mining', 'farming', 'farming']; }
		} else if (lat >= 67) { id = 'tundra'; industries = ['mining', 'oil']; fleet = 'heavy'; }
		else if (lat >= 53) { id = 'taiga'; industries = ['forestry', 'mining', 'oil']; fleet = 'heavy'; }
		else if (lat < 27 && lon > 70) { id = 'rainforest'; industries = ['farming', 'forestry', 'manufacturing']; fleet = 'legacy'; }
		else if (lat < 36 && lon < 62) { id = 'desert'; industries = ['oil', 'mining']; }
		else if (lat < 44 && lon < 40) { id = 'mediterranean'; industries = ['farming', 'manufacturing']; }
		else if (lon > 45 && lon < 105) { id = lat < 40 ? 'desert' : 'steppe'; industries = ['mining', 'oil', 'farming']; }
		else { id = 'temperate'; industries = ['manufacturing', 'farming']; fleet = 'heavy'; }
		// Mean elevation supplies a coarse treeline; relief still decides mountain geometry independently.
		if (Number(elevation) > (Math.abs(lat) < 28 ? 3300 : 2200)) id = 'alpine';
		var region = lon < -30 ? 'americas' : lon > 100 ? 'east-asia' : lat < 37 && lon < 53 ? 'africa' : lon > 40 ? 'eurasia' : 'europe';
		var vegetation = id;
		if (id === 'temperate') {
			if (lon < -121 && lat >= 40) vegetation += '-pacific';
			else if (lon < -30 && lat < 0) vegetation += '-south';
			else if (lon < -30) vegetation += '-americas';
			else if (lon > 100) vegetation += '-eastasia';
		} else if (id === 'rainforest') {
			if (region === 'africa') vegetation += '-africa';
			else if (lon > 70) vegetation += '-eastasia';
		} else if (['taiga', 'savanna', 'desert'].indexOf(id) >= 0 && region === 'americas') vegetation += '-americas';
		else if (id === 'pampas' && lat > 0) vegetation += '-north';
		return { biome: id, vegetation: vegetation, stockRegion: region, fleet: fleet, industries: industries };
	},
	plants: function(profile) { return setup.vegetation[profile.vegetation || profile.biome].plants; },
	forTile: function(tile) { return this.profile(tile && tile.geoCoordinate, tile && tile.elevation); },
	forStation: function(stationId, seedOverride) {
		var pilot = setup.realWorldPilot, tile = pilot && pilot.getStationTile(stationId);
		var profile = this.forTile(tile), station = pilot && pilot.getStation(stationId);
		var choices = profile.industries.slice();
		if (station && station.region === 'industrial') choices.push('mining', 'manufacturing', 'manufacturing');
		if (station && station.region === 'urban') choices.push('manufacturing', 'manufacturing');
		var yard = setup.railyard, seed = seedOverride === undefined ? (State.variables.randomSeed || 'ashline') : seedOverride;
		var rng = yard.mulberry32(yard.seedFromString(seed + ':industry:' + (station ? station.id : stationId)));
		profile.industry = choices[Math.floor(rng() * choices.length)];
		return profile;
	},
	choose: function(keys, weights, rng, base) {
		var amounts = keys.map(function(key) { return (base && base[key] || 1) * (weights && weights[key] || 1); });
		var pick = rng() * amounts.reduce(function(sum, value) { return sum + value; }, 0);
		for (var i = 0; i < keys.length; i++) { pick -= amounts[i]; if (pick < 0) return keys[i]; }
		return keys[keys.length - 1];
	},
	terrain: function(tile) {
		if (!tile || tile.terrain !== 'plains') return tile && tile.terrain;
		var biome = this.forTile(tile).biome;
		if (['taiga', 'temperate', 'rainforest', 'wetland'].indexOf(biome) !== -1) return 'forest';
		if (biome === 'desert') return 'desert';
		if (biome === 'tundra') return 'arctic';
		return 'plains';
	}
};
