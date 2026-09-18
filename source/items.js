// A locomotive's kit: a handful of slots for the tools and supplies a crew keeps aboard, kept apart from the bulk
// cargo the train hauls. A slot holds one kind of item, stacked up to that item's limit.
//
// The kit belongs to the locomotive and travels with it. Anything that needs a tool asks the whole consist, since
// the crew can walk the train to fetch the pump from the other engine.
setup.items = {
	SLOTS: 6,

	CATALOGUE: {
		toolkit: { name: 'Toolkit', stack: 1, detail: 'Spanners, a hammer and a coal shovel.' },
		axe: { name: 'Axe and bow saw', stack: 1, detail: 'For felling trees and cutting timber into firewood.' },
		pump: { name: 'Hand pump', stack: 1, detail: 'Draws diesel or water up a hose.' },
		sleepingBag: { name: 'Sleeping bag', stack: 1, detail: 'Somewhere warm to sleep aboard.' },
		rations: { name: 'Rations', stack: 6, detail: 'A meal each. Three make a day.' }
	},

	// What the first locomotive is found with: the tools to keep it running, a bed, and a day's food.
	STARTING_KIT: [
		{ item: 'toolkit', count: 1 },
		{ item: 'axe', count: 1 },
		{ item: 'pump', count: 1 },
		{ item: 'sleepingBag', count: 1 },
		{ item: 'rations', count: 3 }
	],

	createStartingKit: function() {
		return this.STARTING_KIT.map(function(slot) {
			return { item: slot.item, count: slot.count };
		});
	},
	isLocomotive: function(car) {
		return !!car && Number(car.tractiveCapacity) > 0;
	},
	// A locomotive's kit, made on first use so locomotives from older saves simply start with an empty one.
	getKit: function(car) {
		if (!this.isLocomotive(car)) {
			return [];
		}
		if (!Array.isArray(car.inventory)) {
			car.inventory = [];
		}
		return car.inventory;
	},
	countItem: function(car, item) {
		return this.getKit(car).reduce(function(total, slot) {
			return total + (slot.item === item ? Number(slot.count) || 0 : 0);
		}, 0);
	},
	// Whether anyone in the consist carries this item.
	consistHas: function(train, item) {
		var self = this;
		return Array.isArray(train) && train.some(function(car) {
			return self.countItem(car, item) > 0;
		});
	},
	// Adds as many as the kit has room for, topping up existing stacks before opening new slots. Returns how
	// many went in, so a caller can tell a full kit from a successful add.
	add: function(car, item, count) {
		var definition = this.CATALOGUE[item];
		if (!definition || !this.isLocomotive(car)) {
			return 0;
		}
		var kit = this.getKit(car);
		var remaining = Math.max(0, Math.floor(Number(count) || 0));
		var added = 0;
		kit.forEach(function(slot) {
			if (remaining && slot.item === item && slot.count < definition.stack) {
				var take = Math.min(remaining, definition.stack - slot.count);
				slot.count += take;
				remaining -= take;
				added += take;
			}
		});
		while (remaining && kit.length < this.SLOTS) {
			var fresh = Math.min(remaining, definition.stack);
			kit.push({ item: item, count: fresh });
			remaining -= fresh;
			added += fresh;
		}
		return added;
	},
	// Takes items out, emptying slots as they run out. Returns false, taking nothing, if there are not enough.
	remove: function(car, item, count) {
		var wanted = Math.max(0, Math.floor(Number(count) || 0));
		if (this.countItem(car, item) < wanted) {
			return false;
		}
		var kit = this.getKit(car);
		for (var i = kit.length - 1; i >= 0 && wanted; i--) {
			if (kit[i].item === item) {
				var take = Math.min(wanted, kit[i].count);
				kit[i].count -= take;
				wanted -= take;
				if (!kit[i].count) {
					kit.splice(i, 1);
				}
			}
		}
		return true;
	},
	describeSlot: function(slot) {
		var definition = this.CATALOGUE[slot.item] || { name: slot.item };
		return definition.name + (slot.count > 1 ? ' ×' + slot.count : '');
	}
};

// Lists the kit of the locomotive the player is standing in.
Macro.add('locomotiveKit', {
	handler: function() {
		var variables = State.variables;
		var train = variables.currentTrain;
		var car = Array.isArray(train) ? train[variables.currentCarIndex] : null;
		if (!setup.items.isLocomotive(car)) {
			return;
		}
		var kit = setup.items.getKit(car);
		var list = kit.map(function(slot) {
			var definition = setup.items.CATALOGUE[slot.item] || {};
			return '<span title="' + (definition.detail || '') + '">' + setup.items.describeSlot(slot) + '</span>';
		});
		var output = '<p class="locomotive-kit"><strong>Kit</strong> (' + kit.length + '/' + setup.items.SLOTS + ' slots): '
			+ (list.length ? list.join(' · ') : '<em>empty</em>') + '</p>';
		new Wikifier(this.output, output);
	}
});

// The locomotive's own numbers, folded away in the cab until the player wants them.
Macro.add('locomotivePanel', {
	handler: function() {
		var variables = State.variables;
		var train = variables.currentTrain;
		var car = Array.isArray(train) ? train[variables.currentCarIndex] : null;
		if (!setup.items.isLocomotive(car)) {
			return;
		}
		var rows = setup.railyard.getLocomotiveStats(car).map(function(row) {
			return '<div class="loco-stat"><span class="loco-stat-name">' + row[0] + '</span>'
				+ '<span class="loco-stat-value">' + row[1] + '</span></div>';
		}).join('');
		var panel = document.createElement('details');
		panel.className = 'loco-panel';
		panel.innerHTML = '<summary>Locomotive</summary><div class="loco-stats">' + rows + '</div>';
		this.output.appendChild(panel);
	}
});
