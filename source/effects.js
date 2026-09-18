// What an action costs the body, written on the link that does it.
//
// An action declares its effects as a short spec, "fatigue:+2" or "hunger:+2,immunity:-1", and the link shows
// them beside the time: "Shovel coal into the bunker, 200 kg (0:08, ++fatigue)". The level is how hard it hits,
// one to three, so a player can compare two jobs before taking either. Anything that only passes time says
// nothing: the clock already tells them that.
setup.effects = {
	LEVELS: ['', '+', '++', '+++'],

	parse: function(spec) {
		if (!spec || typeof spec !== 'string') {
			return [];
		}
		return spec.split(',').map(function(part) {
			var pieces = part.split(':');
			var key = pieces[0].trim();
			var amount = String(pieces[1] || '').trim();
			var direction = amount.charAt(0) === '-' ? -1 : 1;
			var level = Math.max(1, Math.min(3, Math.abs(parseInt(amount, 10) || 1)));
			return key ? { key: key, direction: direction, level: level } : null;
		}).filter(Boolean);
	},
	// The wording for one effect: three plusses of fatigue, or three minus signs of it for something that takes it
	// away. The minus is U+2212 rather than a hyphen, because SugarCube's typography turns three hyphens into a dash.
	describeOne: function(effect) {
		var stat = setup.stats.getStat(effect.key);
		var label = (stat ? stat.label : effect.key).toLowerCase();
		return (effect.direction < 0 ? '\u2212' : '+').repeat(effect.level) + label;
	},
	describe: function(spec) {
		var self = this;
		return this.parse(spec).map(function(effect) { return self.describeOne(effect); }).join(', ');
	},
	// The level a job's fatigue rate deserves, so the jobs table sets its rates and the wording follows from them.
	levelForRate: function(perMinute) {
		var rate = Math.abs(Number(perMinute) || 0);
		return rate <= 0.2 ? 1 : rate <= 0.45 ? 2 : 3;
	}
};
