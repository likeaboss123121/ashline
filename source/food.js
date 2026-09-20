// Bulk food, portable portions and ration preparation share one inventory transaction.
setup.food = {
	RAW_HUNGER: 8,
	PORTION_KG: 0.5,
	RECIPE_PORTIONS: 3,
	BASIC_YIELD: 2,
	KITCHEN_YIELD: 3,
	accessibleTrain: function(train) {
		if (State.variables.onFoot && !setup.onfoot.isBesideTrain()) return [];
		return (train || State.variables.currentTrain || []).filter(function(car) { return !car.broken; });
	},
	count: function(item) {
		return setup.items.getPlayerKit().reduce(function(n, slot) { return n + (slot.item === item ? slot.count : 0); }, 0);
	},
	fits: function(kit) {
		var kg = kit.reduce(function(n, slot) { return n + setup.items.CATALOGUE[slot.item].weightKg * slot.count; }, 0);
		return kg + setup.items.getPlayerCargoKg() <= setup.items.PLAYER_CARRY_KG + 1e-9
			&& !setup.items.getPlayerPackLayout(kit).overflow.length;
	},
	add: function(kit, item, count, grade) {
		var limit = setup.items.CATALOGUE[item].stack;
		while (count-- > 0) {
			var slot = kit.find(function(s) { return s.item === item && s.count < limit; });
			if (slot) {
				slot.grade = ((slot.grade == null ? 70 : slot.grade) * slot.count + grade) / (slot.count + 1);
				slot.count++;
			} else kit.push({ item: item, count: 1, grade: grade });
		}
	},
	remove: function(kit, item, count) {
		var quality = 0, removed = 0;
		for (var i = kit.length - 1; i >= 0 && count > 0; i--) {
			var slot = kit[i];
			if (slot.item !== item) continue;
			var take = Math.min(count, slot.count);
			quality += take * (slot.grade == null ? 70 : slot.grade);
			removed += take; count -= take; slot.count -= take;
			if (!slot.count) kit.splice(i, 1);
		}
		return { count: removed, quality: quality };
	},
	source: function(type, minimum) {
		return this.accessibleTrain().find(function(car) { return setup.railyard.getCargoAmount(car, type) >= minimum; });
	},
	portionLitres: function() { return this.PORTION_KG / setup.railyard.getCargoDensityKgPerLiter('food'); },
	takePlan: function() {
		var litres = this.portionLitres(), car = this.source('food', litres);
		if (!car) return null;
		var kit = JSON.parse(JSON.stringify(setup.items.getPlayerKit()));
		this.add(kit, 'rawFood', 1, setup.fuel.getGrade(car, 'food'));
		return this.fits(kit) ? { kit: kit, car: car, litres: litres } : null;
	},
	take: function() {
		var p = this.takePlan();
		if (!p || !setup.railyard.consumeCargoAmount(p.car, 'food', p.litres)) return false;
		State.variables.player.carried = p.kit;
		return true;
	},
	craftPlan: function() {
		var kit = JSON.parse(JSON.stringify(setup.items.getPlayerKit()));
		var removed = this.remove(kit, 'rawFood', this.RECIPE_PORTIONS);
		var needed = this.RECIPE_PORTIONS - removed.count;
		var car = needed ? this.source('food', needed * this.portionLitres()) : null;
		if (needed && !car) return null;
		var kitchen = this.accessibleTrain().some(function(c) { return c.type === 'kitchen car'; });
		var count = kitchen ? this.KITCHEN_YIELD : this.BASIC_YIELD;
		var grade = (removed.quality + needed * (car ? setup.fuel.getGrade(car, 'food') : 0)) / this.RECIPE_PORTIONS;
		this.add(kit, 'rations', count, grade);
		return this.fits(kit) ? { kit: kit, car: car, litres: needed * this.portionLitres(), count: count, kitchen: kitchen } : null;
	},
	craft: function() {
		var p = this.craftPlan();
		if (!p) return false;
		if (p.car && !setup.railyard.consumeCargoAmount(p.car, 'food', p.litres)) return false;
		State.variables.player.carried = p.kit;
		return true;
	},
	eatRaw: function() {
		var quality;
		if (this.count('rawFood')) quality = this.remove(setup.items.getPlayerKit(), 'rawFood', 1).quality;
		else {
			var car = this.source('food', this.portionLitres());
			if (!car) return false;
			quality = setup.fuel.getGrade(car, 'food');
			setup.railyard.consumeCargoAmount(car, 'food', this.portionLitres());
		}
		setup.stats.adjust('hunger', this.RAW_HUNGER);
		setup.condition.applyConsumableQuality(quality);
		return true;
	},
	// Water stays bulk cargo in the pack, so its grade survives every transfer.
	waterPlan: function() {
		var litres = setup.condition.DRINK_LITRES;
		var car = this.source('water', litres);
		if (!car || setup.items.getPlayerCarriedKg() + litres > setup.items.PLAYER_CARRY_KG) return null;
		return { car: car, litres: litres, grade: setup.fuel.getGrade(car, 'water') };
	},
	takeWater: function() {
		var p = this.waterPlan();
		if (!p || !setup.railyard.consumeCargoAmount(p.car, 'water', p.litres)) return false;
		setup.items.addPlayerCargo('water', p.litres, p.grade);
		return true;
	}
};
Macro.add('foodControls', {
	handler: function() {
		var food = setup.food, out = '', craft = food.craftPlan();
		function link(label, action, minutes, effects) {
			return '<<timedlink "' + label + '" ' + minutes + ' "manual" "' + (effects || '') + '">><<run setup.food.' + action
				+ '()>><<run Engine.play(State.passage)>><</timedlink>><br>';
		}
		if (food.takePlan()) out += link('Pack raw food (0.5 kg)', 'take', 1);
		if (food.count('rawFood') || food.source('food', food.portionLitres())) out += link('Eat raw food', 'eatRaw', 5, 'hunger:+1');
		if (craft) out += link('Prepare ' + craft.count + ' rations' + (craft.kitchen ? ' in the kitchen car' : '') + ' (1.5 kg food)', 'craft', 15, 'fatigue:+1');
		if (food.waterPlan()) out += link('Pack 2 L of drinking water', 'takeWater', 1);
		new Wikifier(this.output, out ? '<h4>Food and supplies</h4>' + out : '');
	}
});
