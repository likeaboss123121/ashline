// Static art/catalogue data lives in setup. Only a car's selected graphicVariant is saved.
setup.stockVariety = {
	definition: function(car) {
		var cars = setup.stockCatalogue.cars;
		return Object.keys(cars).map(function(key) { return { key: key, spec: cars[key] }; })
			.find(function(entry) { return car && entry.spec.type === car.type; });
	},
	artNames: function(car, prefix) {
		var entry = this.definition(car);
		if (!entry) return [];
		var base = prefix + '-car-' + entry.key;
		return [base].concat(entry.spec.variants.map(function(variant) { return base + '-' + variant.id; }));
	},
	variantName: function(car, prefix) {
		var entry = this.definition(car);
		if (!entry || !entry.spec.variants.some(function(v) { return v.id === car.graphicVariant; })) return null;
		return prefix + '-car-' + entry.key + '-' + car.graphicVariant;
	},
	assign: function(car, rng, locale) {
		var entry = this.definition(car);
		if (!entry) return car;
		var options = [{ id: '', region: '' }].concat(entry.spec.variants);
		var weights = options.map(function(v) { return locale && v.region === locale.stockRegion ? 4 : 1; });
		var index = setup.locales.choose(options.map(function(_, i) { return i; }), weights, rng);
		if (options[index].id) car.graphicVariant = options[index].id;
		else delete car.graphicVariant;
		return car;
	},
	fleetWeights: function(locale) {
		var weights = Object.assign({}, setup.locales.FLEETS[locale.fleet]);
		setup.stockCatalogue.locomotives.forEach(function(spec) {
			weights[spec.key] = (weights[spec.key] || 1) * (spec.region === locale.stockRegion ? 3 : 1);
		});
		return weights;
	}
};
// This module sorts after scripts.js. Copy base presets before adding new models; existing instances are untouched.
setup.stockCatalogue.locomotives.forEach(function(spec) {
	var defaults = State.variables.defaultTrains, definition = defaults[spec.key];
	if (spec.base) {
		definition = JSON.parse(JSON.stringify(defaults[spec.base]));
		Object.keys(spec).forEach(function(key) {
			if (['key', 'base', 'design', 'colours', 'region'].indexOf(key) === -1) definition[key] = spec[key];
		});
		defaults[spec.key] = definition;
		if (setup.railyard.locomotiveKeys.indexOf(spec.key) < 0) setup.railyard.locomotiveKeys.push(spec.key);
	}
	definition.origin = spec.origin; definition.era = spec.era; definition.drivetrain = spec.drivetrain;
});
setup.currentDefinitions.defaultTrains = JSON.parse(JSON.stringify(State.variables.defaultTrains));
