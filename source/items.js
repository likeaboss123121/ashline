// A locomotive's kit: a handful of slots for the tools and supplies a crew keeps aboard, kept apart from the bulk
// cargo the train hauls. A slot holds one kind of item, stacked up to that item's limit.
//
// The kit belongs to the locomotive and travels with it. Anything that needs a tool asks the whole consist, since
// the crew can walk the train to fetch the pump from the other engine.
setup.items = {
	SLOTS: 6,

	CATALOGUE: {
		toolkit: { name: 'Toolkit', stack: 1, width: 2, height: 2, weightKg: 5, detail: 'Spanners, a hammer and a coal shovel.' },
		axe: { name: 'Axe and bow saw', stack: 1, width: 2, height: 2, weightKg: 3, detail: 'For felling trees and cutting timber into firewood.' },
		pump: { name: 'Hand pump', stack: 1, width: 3, height: 2, weightKg: 7, detail: 'Draws diesel or water up a hose.' },
		sleepingBag: { name: 'Sleeping bag', stack: 1, width: 2, height: 2, weightKg: 2, detail: 'Somewhere warm to sleep aboard.' },
		rations: { name: 'Rations', stack: 6, width: 1, height: 1, weightKg: 0.4, detail: 'A meal each. Three make a day.' }
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

// What the player has on them, as opposed to what the locomotive holds. Beside the train it hardly matters: the
// cab is right there. A tile away it is everything they have.
setup.items.PLAYER_GRID_WIDTH = 4;
setup.items.PLAYER_GRID_HEIGHT = 4;
setup.items.PLAYER_CARRY_KG = 50;

setup.items.getPlayerKit = function() {
	var player = State.variables.player;
	if (!player) {
		return [];
	}
	if (!Array.isArray(player.carried)) {
		player.carried = [];
	}
	return player.carried;
};
setup.items.playerHas = function(item) {
	return this.getPlayerKit().some(function(slot) { return slot.item === item && slot.count > 0; });
};
// Packs each carried stack into the first place it fits. Coordinates are derived rather than saved, so older saves
// with the former slot-only pack migrate cleanly and reordering a stack cannot corrupt the player's inventory.
setup.items.getPlayerPackLayout = function() {
	var width = this.PLAYER_GRID_WIDTH;
	var height = this.PLAYER_GRID_HEIGHT;
	var cells = [];
	for (var y = 0; y < height; y++) {
		cells[y] = [];
		for (var x = 0; x < width; x++) cells[y][x] = null;
	}
	var placements = [];
	var overflow = [];
	this.getPlayerKit().forEach(function(slot) {
		var definition = setup.items.CATALOGUE[slot.item];
		if (!definition || !slot.count) return;
		var itemWidth = definition.width || 1;
		var itemHeight = definition.height || 1;
		var placed = false;
		for (var top = 0; top <= height - itemHeight && !placed; top++) {
			for (var left = 0; left <= width - itemWidth && !placed; left++) {
				var clear = true;
				for (var row = top; row < top + itemHeight && clear; row++) {
					for (var column = left; column < left + itemWidth; column++) {
						if (cells[row][column]) clear = false;
					}
				}
				if (clear) {
					for (var fillY = top; fillY < top + itemHeight; fillY++) {
						for (var fillX = left; fillX < left + itemWidth; fillX++) cells[fillY][fillX] = slot;
					}
					placements.push({ slot: slot, x: left, y: top, width: itemWidth, height: itemHeight });
					placed = true;
				}
			}
		}
		if (!placed) overflow.push(slot);
	});
	return { cells: cells, placements: placements, overflow: overflow };
};
setup.items.getPlayerKitKg = function() {
	return this.getPlayerKit().reduce(function(total, slot) {
		var definition = setup.items.CATALOGUE[slot.item] || {};
		return total + (Number(definition.weightKg) || 0) * (Number(slot.count) || 0);
	}, 0);
};
setup.items.getPlayerPackSquares = function() {
	return this.getPlayerPackLayout().placements.reduce(function(total, placement) {
		return total + placement.width * placement.height;
	}, 0);
};
// Moves one item between a locomotive's kit and the player's pack, in either direction.
setup.items.takeFromCar = function(car, item) {
	if (!this.playerHasRoom(item) || !this.remove(car, item, 1)) {
		return false;
	}
	var kit = this.getPlayerKit();
	var slot = kit.filter(function(candidate) { return candidate.item === item; })[0];
	if (slot) {
		slot.count++;
	} else {
		kit.push({ item: item, count: 1 });
	}
	return true;
};
setup.items.giveToCar = function(car, item) {
	var kit = this.getPlayerKit();
	var slot = kit.filter(function(candidate) { return candidate.item === item; })[0];
	if (!slot || !this.add(car, item, 1)) {
		return false;
	}
	slot.count--;
	if (!slot.count) {
		kit.splice(kit.indexOf(slot), 1);
	}
	return true;
};
setup.items.playerHasRoom = function(item) {
	var definition = this.CATALOGUE[item];
	if (!definition) {
		return false;
	}
	if (this.getPlayerCarriedKg() + (Number(definition.weightKg) || 0) > this.PLAYER_CARRY_KG) {
		return false;
	}
	var slot = this.getPlayerKit().filter(function(candidate) { return candidate.item === item; })[0];
	if (slot && slot.count < definition.stack) {
		return true;
	}
	// Test the new stack without leaving it in saved state.
	var kit = this.getPlayerKit();
	kit.push({ item: item, count: 1 });
	var fits = !this.getPlayerPackLayout().overflow.length;
	kit.pop();
	return fits;
};

// Cargo the player is carrying in their arms: timber cut away from the train, mostly. Limited by weight, not slots.
setup.items.getPlayerCargo = function() {
	var player = State.variables.player;
	if (!player) {
		return [];
	}
	if (!Array.isArray(player.carriedCargo)) {
		player.carriedCargo = [];
	}
	return player.carriedCargo;
};
setup.items.getPlayerCargoKg = function() {
	return this.getPlayerCargo().reduce(function(total, stack) {
		return total + stack.amount * setup.railyard.getCargoDensityKgPerLiter(stack.type);
	}, 0);
};
setup.items.getPlayerCarriedKg = function() {
	return this.getPlayerKitKg() + this.getPlayerCargoKg();
};
setup.items.addPlayerCargo = function(type, litres, grade) {
	var cargo = this.getPlayerCargo();
	var stack = cargo.filter(function(candidate) { return candidate.type === type; })[0];
	if (stack) {
		var blended = (stack.amount * (stack.grade || 100) + litres * (grade || 100)) / (stack.amount + litres);
		stack.amount += litres;
		stack.grade = Math.round(blended * 10) / 10;
	} else {
		cargo.push({ type: type, amount: litres, grade: grade });
	}
};
setup.items.removePlayerCargo = function(type, litres) {
	var cargo = this.getPlayerCargo();
	for (var i = cargo.length - 1; i >= 0; i--) {
		if (cargo[i].type === type) {
			cargo[i].amount -= litres;
			if (cargo[i].amount <= 0.001) {
				cargo.splice(i, 1);
			}
		}
	}
};
setup.items.describePlayerLoad = function() {
	var kit = this.getPlayerKit().map(function(slot) { return setup.items.describeSlot(slot); });
	var cargo = this.getPlayerCargo().map(function(stack) {
		return setup.units.kilograms(stack.amount * setup.railyard.getCargoDensityKgPerLiter(stack.type)) + ' of ' + stack.type;
	});
	var carried = kit.concat(cargo);
	return carried.length ? carried.join(', ') : 'nothing';
};
setup.items.getPlayerPackGridHtml = function() {
	var layout = this.getPlayerPackLayout();
	var labels = {};
	layout.placements.forEach(function(placement) {
		labels[placement.x + ',' + placement.y] = (setup.items.CATALOGUE[placement.slot.item] || { name: '?' }).name.charAt(0);
	});
	var rows = layout.cells.map(function(row, y) {
		return row.map(function(slot, x) {
			return labels[x + ',' + y] || (slot ? '&middot;' : '&nbsp;');
		}).join(' | ');
	});
	return '<pre aria-label="4 by 4 inventory grid">' + rows.join('\n') + '</pre>';
};

// The sidebar inventory is a read-only view of everything the player can use without hunting through the train
// or the railyard text. It deliberately follows the player: a parked train remains its own station inventory.
setup.items.showInventoryDialog = function() {
	var variables = State.variables;
	var playerKit = this.getPlayerKit();
	var playerCargo = this.getPlayerCargo();
	var playerItems = playerKit.map(function(slot) { return setup.items.describeSlot(slot); });
	var playerLoads = playerCargo.map(function(stack) {
		return setup.units.kilograms(stack.amount * setup.railyard.getCargoDensityKgPerLiter(stack.type)) + ' of ' + stack.type;
	});
	var carriedKg = this.getPlayerCarriedKg();
	var html = '<p><strong>On you</strong> (' + this.getPlayerPackSquares() + '/' + (this.PLAYER_GRID_WIDTH * this.PLAYER_GRID_HEIGHT) + ' pack squares, '
		+ setup.units.kilograms(carriedKg) + '/' + setup.units.kilograms(this.PLAYER_CARRY_KG) + ' carried): '
		+ (playerItems.concat(playerLoads).join(' · ') || '<em>nothing</em>') + '</p>';
	html += '<p class="small-description"><strong>Pack (4 × 4)</strong></p>' + this.getPlayerPackGridHtml();
	if (this.getPlayerPackLayout().overflow.length) {
		html += '<p><em>Some carried items do not fit the pack. Stow them before leaving the train.</em></p>';
	}
	var train = Array.isArray(variables.currentTrain) ? variables.currentTrain : null;
	if (train && train.length) {
		html += '<h3>Your train</h3><ul>';
		train.forEach(function(car, index) {
			var contents = [];
			if (setup.items.isLocomotive(car)) {
				var kit = setup.items.getKit(car).map(function(slot) { return setup.items.describeSlot(slot); });
				contents.push('kit: ' + (kit.join(', ') || 'empty'));
			}
			if (Array.isArray(car.cargo) && car.cargo.length) {
				contents.push(car.cargo.map(function(stack) {
					return setup.units.litres(stack.amount) + ' ' + stack.type;
				}).join(', '));
			}
			html += '<li><strong>' + (car.type || 'Railcar') + '</strong>' + (contents.length ? ': ' + contents.join('; ') : ': empty') + '</li>';
		});
		html += '</ul>';
	} else {
		html += '<p class="small-description"><em>Board a train to inspect its kits and cargo here.</em></p>';
	}
	Dialog.setup('Inventory');
	Dialog.wiki(html);
	Dialog.open();
};

// The player's pack, and moving things between it and the locomotive's kit.
Macro.add('playerPack', {
	handler: function() {
		var variables = State.variables;
		var train = variables.currentTrain;
		var car = Array.isArray(train) ? train[variables.currentCarIndex] : null;
		var output = '<p class="player-pack"><strong>You are carrying</strong> (' + setup.items.getPlayerPackSquares()
			+ '/' + (setup.items.PLAYER_GRID_WIDTH * setup.items.PLAYER_GRID_HEIGHT) + ' squares, '
			+ setup.units.kilograms(setup.items.getPlayerCarriedKg()) + '/' + setup.units.kilograms(setup.items.PLAYER_CARRY_KG)
			+ '): ' + setup.items.describePlayerLoad() + '</p>';
		if (setup.items.isLocomotive(car)) {
			var moves = [];
			setup.items.getKit(car).forEach(function(slot) {
				moves.push('<<link "Take the ' + (setup.items.CATALOGUE[slot.item] || { name: slot.item }).name.toLowerCase() + '">>'
					+ '<<run setup.items.takeFromCar($currentTrain[$currentCarIndex], "' + slot.item + '")>>'
					+ '<<goto "TrainInterior">><</link>>');
			});
			setup.items.getPlayerKit().forEach(function(slot) {
				moves.push('<<link "Stow the ' + (setup.items.CATALOGUE[slot.item] || { name: slot.item }).name.toLowerCase() + '">>'
					+ '<<run setup.items.giveToCar($currentTrain[$currentCarIndex], "' + slot.item + '")>>'
					+ '<<goto "TrainInterior">><</link>>');
			});
			if (moves.length) {
				output += '<p class="small-description">' + moves.join(' &middot; ') + '</p>';
			}
		}
		new Wikifier(this.output, output);
	}
});
