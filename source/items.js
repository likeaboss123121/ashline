// A locomotive's kit: a handful of slots for the tools and supplies a crew keeps aboard, kept apart from the bulk
// cargo the train hauls. A slot holds one kind of item, stacked up to that item's limit.
//
// The kit belongs to the locomotive and travels with it. Anything that needs a tool asks the whole consist, since
// the crew can walk the train to fetch the pump from the other engine.
setup.items = {
	SLOTS: 6,
	CATALOGUE: {
		toolkit: { name: 'Toolkit', stack: 1, width: 2, height: 2, weightKg: 5, detail: 'Spanners, a hammer and a coal shovel.' },
		rawFood: { name: 'Raw food', stack: 6, width: 1, height: 1, weightKg: 0.5, detail: 'Food taken from bulk cargo. Eat raw or prepare rations.' },
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
		if (!this.isLocomotive(car) || car.broken) {
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
	add: function(car, item, count, grade) {
		var definition = this.CATALOGUE[item];
		if (!definition || !this.isLocomotive(car) || car.broken) {
			return 0;
		}
		var kit = this.getKit(car);
		var remaining = Math.max(0, Math.floor(Number(count) || 0));
		var added = 0;
		kit.forEach(function(slot) {
			if (remaining && slot.item === item && slot.count < definition.stack) {
				var take = Math.min(remaining, definition.stack - slot.count);
				if (grade != null) slot.grade = ((slot.grade == null ? 70 : slot.grade) * slot.count + grade * take) / (slot.count + take);
				slot.count += take;
				remaining -= take;
				added += take;
			}
		});
		while (remaining && kit.length < this.SLOTS) {
			var fresh = Math.min(remaining, definition.stack);
			var entry = { item: item, count: fresh }; if (grade != null) entry.grade = grade;
			kit.push(entry);
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
setup.items.getPlayerPackLayout = function(kit) {
	var width = this.PLAYER_GRID_WIDTH;
	var height = this.PLAYER_GRID_HEIGHT;
	var cells = [];
	for (var y = 0; y < height; y++) {
		cells[y] = [];
		for (var x = 0; x < width; x++) cells[y][x] = null;
	}
	var placements = [];
	var overflow = [];
	(kit || this.getPlayerKit()).forEach(function(slot) {
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
	var source = this.getKit(car).filter(function(s) { return s.item === item; }).pop();
	var grade = source && source.grade;
	if (!this.playerHasRoom(item) || !this.remove(car, item, 1)) {
		return false;
	}
	var kit = this.getPlayerKit();
	var limit = this.CATALOGUE[item].stack;
	var slot = kit.filter(function(candidate) { return candidate.item === item && candidate.count < limit; })[0];
	if (slot) {
		if (grade != null || slot.grade != null) slot.grade = ((slot.grade == null ? 70 : slot.grade) * slot.count + (grade == null ? 70 : grade)) / (slot.count + 1);
		slot.count++;
	} else {
		var entry = { item: item, count: 1 }; if (grade != null) entry.grade = grade;
		kit.push(entry);
	}
	return true;
};
setup.items.giveToCar = function(car, item) {
	var kit = this.getPlayerKit();
	var slot = kit.filter(function(candidate) { return candidate.item === item; })[0];
	if (!slot || !this.add(car, item, 1, slot.grade)) {
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
	var slot = this.getPlayerKit().filter(function(candidate) { return candidate.item === item && candidate.count < definition.stack; })[0];
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
		var blended = (stack.amount * (stack.grade == null ? 100 : stack.grade) + litres * (grade == null ? 100 : grade)) / (stack.amount + litres);
		stack.amount += litres;
		stack.grade = Math.round(blended * 10) / 10;
	} else {
		cargo.push({ type: type, amount: litres, grade: grade });
	}
};
setup.items.removePlayerCargo = function(type, litres) {
	var cargo = this.getPlayerCargo();
	var remaining = Math.max(0, Number(litres) || 0);
	var available = cargo.reduce(function(n, s) { return n + (s.type === type ? s.amount : 0); }, 0);
	if (available + 1e-9 < remaining) return false;
	for (var i = cargo.length - 1; i >= 0 && remaining > 0; i--) {
		if (cargo[i].type === type) {
			var take = Math.min(remaining, cargo[i].amount);
			cargo[i].amount -= take; remaining -= take;
			if (cargo[i].amount <= 0.001) {
				cargo.splice(i, 1);
			}
		}
	}
	return true;
};
setup.items.describePlayerLoad = function() {
	var kit = this.getPlayerKit().map(function(slot) { return setup.items.describeSlot(slot); });
	var cargo = this.getPlayerCargo().map(function(stack) {
		return setup.units.kilograms(stack.amount * setup.railyard.getCargoDensityKgPerLiter(stack.type)) + ' of ' + stack.type;
	});
	var carried = kit.concat(cargo);
	return carried.length ? carried.join(', ') : 'nothing';
};
setup.items.confirmDiscard = function(item, cargo) {
	var name = cargo ? item : (this.CATALOGUE[item] || { name: item }).name;
	Dialog.setup('Discard');
	var box = document.createElement('div'), message = document.createElement('p');
	message.textContent = 'Discard ' + name + '? It cannot be recovered.'; box.appendChild(message);
	box.appendChild(setup.saves.button('Discard', 'Permanently discard this carried supply', function() {
		if (cargo) State.variables.player.carriedCargo = setup.items.getPlayerCargo().filter(function(s) { return s.type !== item; });
		else setup.food.remove(setup.items.getPlayerKit(), item, 1);
		Dialog.close(); Engine.play(State.passage);
	}));
	box.appendChild(setup.saves.button('Cancel', 'Keep it', function() { Dialog.close(); }));
	Dialog.append(box); Dialog.open();
};
setup.items.getPlayerPackGridHtml = function() {
	var layout = this.getPlayerPackLayout();
	var escape = function(text) { return String(text).replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; }); };
	var svg = '<svg class="pack-grid" viewBox="0 0 240 240" role="img" aria-label="4 by 4 inventory grid"><title>Carried inventory</title>';
	for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) {
		svg += '<rect x="' + (x * 60 + 1) + '" y="' + (y * 60 + 1) + '" width="58" height="58" fill="#161819" stroke="#555"/>';
	}
	layout.placements.forEach(function(p) {
		var name = (setup.items.CATALOGUE[p.slot.item] || { name: '?' }).name;
		svg += '<g><title>' + escape(setup.items.describeSlot(p.slot)) + '</title><rect x="' + (p.x * 60 + 3)
			+ '" y="' + (p.y * 60 + 3) + '" width="' + (p.width * 60 - 6) + '" height="' + (p.height * 60 - 6)
			+ '" fill="#303a3a" stroke="#c9b988"/><text x="' + (p.x * 60 + p.width * 30) + '" y="' + (p.y * 60 + p.height * 30)
			+ '" text-anchor="middle" fill="#eee" font-size="12">' + escape(name.slice(0, p.width > 1 ? 16 : 7))
			+ '<tspan x="' + (p.x * 60 + p.width * 30) + '" dy="16">×' + p.slot.count + '</tspan></text></g>';
	});
	return svg + '</svg>';
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
		if (setup.items.isLocomotive(car) && !car.broken && (!variables.onFoot || setup.onfoot.isBesideTrain())) {
			var moves = [];
			setup.items.getKit(car).forEach(function(slot) {
				if (!setup.items.playerHasRoom(slot.item)) return;
				moves.push('<<link "Take the ' + (setup.items.CATALOGUE[slot.item] || { name: slot.item }).name.toLowerCase() + '">>'
					+ '<<run setup.items.takeFromCar($currentTrain[$currentCarIndex], "' + slot.item + '")>>'
					+ '<<run Engine.play(State.passage)>><</link>>');
			});
			setup.items.getPlayerKit().forEach(function(slot) {
				var kit = setup.items.getKit(car), definition = setup.items.CATALOGUE[slot.item];
				if (kit.length >= setup.items.SLOTS && !kit.some(function(s) { return s.item === slot.item && s.count < definition.stack; })) return;
				moves.push('<<link "Stow the ' + (setup.items.CATALOGUE[slot.item] || { name: slot.item }).name.toLowerCase() + '">>'
					+ '<<run setup.items.giveToCar($currentTrain[$currentCarIndex], "' + slot.item + '")>>'
					+ '<<run Engine.play(State.passage)>><</link>>');
			});
			if (moves.length) {
				output += '<ul><li>' + moves.join('</li><li>') + '</li></ul>';
			}
		}
		new Wikifier(this.output, output);
		var carried = setup.items.getPlayerKit().map(function(s) { return { id: s.item, cargo: false, label: (setup.items.CATALOGUE[s.item] || { name: s.item }).name }; })
			.concat(setup.items.getPlayerCargo().map(function(s) { return { id: s.type, cargo: true, label: s.type }; }));
		if (carried.length) {
			var details = document.createElement('details'), summary = document.createElement('summary');
			summary.textContent = 'Discard carried supplies'; details.appendChild(summary);
			carried.forEach(function(s) { details.appendChild(setup.saves.button('Discard ' + s.label, 'Free carrying capacity', function() { setup.items.confirmDiscard(s.id, s.cargo); })); });
			this.output.appendChild(details);
		}
	}
});
