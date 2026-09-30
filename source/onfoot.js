// Leaving the train out on the line.
//
// The player can climb down and walk the track, which is slow and hard: an hour and a good part of a day's energy
// for every 5 km tile, against five minutes riding. What it buys is reach: trees a train cannot stop beside, and
// whatever is further up the line.
//
// Standing beside the train, the player has the run of it: its tools, its stores, its bunker. A tile away they have
// only what they carry, which is why there is a pack at all.
setup.onfoot = {
	MINUTES_PER_TILE: 60, // for 5 km of track; a longer step between squares takes proportionally longer
	FATIGUE_PER_MINUTE: 0.5,
	CHOP_MINUTES: 30,
	CHOP_KG: 60, // what one session of felling and dragging yields, which is about what a person can carry
	CHOP_GRADE: 50, // green wood, the same as felling from the train
	get: function() {
		var foot = State.variables.onFoot;
		return foot && typeof foot.tileIndex === 'number' ? foot : null;
	},
	isOnFoot: function() {
		return !!this.get();
	},
	isInRailyard: function() {
		var foot = this.get();
		return !!foot && foot.inRailyard === true;
	},
	getStationId: function() {
		var tile = this.getTile();
		return tile && Number(tile.stationIndex) > 0 ? Number(tile.stationIndex) : 0;
	},
	// The yards on the square the walker stands on (setup.yards.at).
	getYards: function() {
		var tile = this.getTile();
		return tile ? setup.yards.at(tile.x, tile.y) : [];
	},
	// Into a yard on this square: the station's, unless another is named.
	enterRailyard: function(yardId) {
		var foot = this.get(), yards = this.getYards(), stationId = yardId === undefined ? this.getStationId() : yardId;
		if (!foot || !stationId || !yards.some(function(yard) { return String(yard.id) === String(stationId); })) return false;
		stationId = setup.yards.normalise(stationId);
		State.variables.currentStation = stationId;
		if (this.getTrainPosition()) {
			foot.inRailyard = true;
			State.variables.onFoot = foot;
		} else {
			State.variables.journey = null;
			State.variables.onFoot = null;
		}
		return true;
	},
	// Out of a yard on foot with no train: onto the line at the station's square, along its first line, the way a walker
	// who climbed down there would stand. The line is only the walker's route; there is no train on it.
	walkOutOfYard: function() {
		var v = State.variables, station = setup.yards.stationOf(v.currentStation) || v.currentStation;
		if ((Array.isArray(v.currentTrain) && v.currentTrain.length) || this.isOnFoot()) return false;
		var line = setup.realWorldPilot.getStationLines(station)[0] || setup.realWorldPilot.getStationLines(v.currentStation)[0];
		var leg = line && setup.realWorldPilot.getLeg(line.legIndex);
		if (!leg) return false;
		var tileIndex = Number.isInteger(line.tileIndex) ? line.tileIndex : line.forward ? 0 : leg.tiles.length - 1;
		v.journey = { legIndex: line.legIndex, tileIndex: tileIndex, forward: line.forward };
		v.onFoot = { legIndex: line.legIndex, tileIndex: tileIndex };
		return true;
	},
	// Asks before the player walks out of a yard with no train, then goes onto the line.
	confirmWalkOut: function() {
		if (typeof Dialog === 'undefined') return;
		Dialog.setup('[NEEDS WRITING PASS] Leave on foot?');
		var body = document.createElement('div'), text = document.createElement('p');
		text.textContent = '[NEEDS WRITING PASS] You have no train. Walk out of the yard onto the line on foot?';
		body.appendChild(text);
		body.appendChild(setup.saves.button('[NEEDS WRITING PASS] Walk out', 'Leave the yard on foot', function() {
			Dialog.close();
			if (setup.onfoot.walkOutOfYard()) Engine.play('OnFoot');
		}, 'saves-primary'));
		body.appendChild(setup.saves.button('Cancel', 'Stay in the yard', function() { Dialog.close(); }));
		Dialog.append(body);
		Dialog.open();
	},
	leaveRailyard: function() {
		var foot = this.get();
		if (!foot || !foot.inRailyard) return false;
		delete foot.inRailyard;
		State.variables.onFoot = foot;
		return true;
	},
	// Where the train is standing, which is where the player climbed down.
	getTrainPosition: function() {
		if (!Array.isArray(State.variables.currentTrain) || !State.variables.currentTrain.length) return null;
		var journey = setup.worldmap.getJourney();
		return journey ? { legIndex: journey.legIndex, tileIndex: journey.tileIndex } : null;
	},
	isBesideTrain: function() {
		var foot = this.get();
		var train = this.getTrainPosition();
		if (!foot || !train) return false;
		if ((foot.legIndex || train.legIndex) === train.legIndex && foot.tileIndex === train.tileIndex) return true;
		// At a junction the same square ends several legs, so compare where each actually stands.
		var world = setup.worldmap, here = world.getJourneyView(this.getPosition()), there = world.getJourneyView();
		return !!here && !!there && here.tile.x === there.tile.x && here.tile.y === there.tile.y;
	},
	// Query the walker's route without temporarily moving the parked train.
	getPosition: function() {
		var foot = this.get(), journey = setup.worldmap.getJourney();
		return foot && journey ? { legIndex: foot.legIndex || journey.legIndex, tileIndex: foot.tileIndex, forward: true } : null;
	},
	// The tile the player is standing on, which is not always the one the train is on.
	getTile: function() {
		var position = this.getPosition();
		var view = position && setup.worldmap.getJourneyView(position);
		return view ? view.tile : null;
	},
	climbDown: function() {
		var train = this.getTrainPosition();
		if (!train || this.isOnFoot()) {
			return false;
		}
		State.variables.onFoot = { legIndex: train.legIndex, tileIndex: train.tileIndex };
		return true;
	},
	climbAboard: function() {
		if (!this.isBesideTrain()) {
			return false;
		}
		State.variables.onFoot = null;
		return true;
	},
	// One square up or down the line, or onto another line at a node (branchId, one of worldmap.getBranchChoices). The walk
	// is the cost: an hour for 5 km, and the legs to go with it. Walking reuses the rails' connections but never a
	// train's power or grade limits.
	getWalk: function(direction, branchId) {
		var position = this.getPosition(), world = setup.worldmap;
		if (!position || this.isInRailyard()) return null;
		var legIndex = position.legIndex, step;
		if (branchId != null) {
			step = world.getBranchStep(branchId, position);
			if (step) legIndex = Number(String(branchId).replace('leg:', ''));
		} else {
			step = world.getJourneyStep(direction, position);
		}
		if (!step) return null;
		var distanceKm = step.distanceKm || world.TILE_KM;
		return { legIndex: legIndex, toIndex: step.toIndex, terrain: step.terrain, heading: step.heading, distanceKm: distanceKm,
			minutes: Math.max(1, Math.round(this.MINUTES_PER_TILE * distanceKm / world.TILE_KM)) };
	},
	getBranchWalks: function() {
		var position = this.getPosition(), self = this;
		if (!position) return [];
		return setup.worldmap.getBranchChoices(position, true).map(function(choice) {
			var walk = self.getWalk(1, choice.id);
			if (walk) walk.choice = choice.id;
			return walk;
		}).filter(function(walk) { return !!walk; });
	},
	walk: function(direction, branchId) {
		var walk = this.getWalk(direction, branchId);
		if (!walk) {
			return false;
		}
		State.variables.onFoot = { legIndex: walk.legIndex, tileIndex: walk.toIndex };
		return true;
	},
	// A tool counts as to hand if the player is carrying it, or if the train is right there to fetch it from.
	hasTool: function(item) {
		return setup.items.playerHas(item) || (this.isBesideTrain() && setup.items.consistHas(State.variables.currentTrain, item));
	},
	canChop: function() {
		var tile = this.getTile();
		if (!tile || tile.terrain !== 'forest') {
			return 'there are no trees here';
		}
		if (!this.hasTool('axe')) {
			return 'you have no axe with you';
		}
		if (setup.items.getPlayerCarriedKg() >= setup.items.PLAYER_CARRY_KG) {
			return 'you are carrying all you can';
		}
		return '';
	},
	// Felling by hand, away from the train: what the player cuts they have to carry.
	chop: function() {
		if (this.canChop()) {
			return false;
		}
		var room = setup.items.PLAYER_CARRY_KG - setup.items.getPlayerCarriedKg();
		var kg = Math.min(this.CHOP_KG, room);
		if (kg <= 0) {
			return false;
		}
		setup.items.addPlayerCargo('timber', kg / setup.railyard.getCargoDensityKgPerLiter('timber'), this.CHOP_GRADE);
		setup.stats.adjust('fatigue', Math.round(this.CHOP_MINUTES * 0.7));
		return true;
	},
	// Putting what the player is carrying into the train, which is the only place to put it.
	stow: function() {
		if (!this.isBesideTrain() && setup.worldmap.getJourney()) {
			return false;
		}
		var carried = setup.items.getPlayerCargo();
		var moved = 0;
		carried.slice().forEach(function(stack) {
			var destination = setup.refuel.findDestinationCar(State.variables.currentTrain, stack.type);
			if (!destination) {
				return;
			}
			var litres = Math.min(stack.amount, destination.room);
			if (litres <= 0) {
				return;
			}
			setup.fuel.addCargo(destination.car, stack.type, litres, stack.grade);
			setup.items.removePlayerCargo(stack.type, litres);
			moved += litres;
		});
		return moved > 0;
	}
};
// What the player can do standing on the ballast.
Macro.add('onFootControls', {
	handler: function() {
		var onfoot = setup.onfoot;
		if (!onfoot.isOnFoot()) {
			return;
		}
		var output = '';
		onfoot.getYards().forEach(function(yard) {
			output += '<<link "' + setup.yards.enterLabel(yard.id) + '">>'
				+ '<<if setup.onfoot.enterRailyard(' + JSON.stringify(yard.id) + ')>><<goto "Railyard">><</if>><</link>><br>';
		});
		// A train the player left standing on the line can be boarded again from beside it.
		var tile = onfoot.getTile();
		if (tile && setup.yards.lineTrainAt(tile.x, tile.y)) {
			output += '<<timedlink "Climb aboard the train you left here" 2 "generic">>'
				+ '<<if setup.yards.boardParked(' + tile.x + ', ' + tile.y + ')>><<goto "OnTheLine">><</if>><</timedlink>><br>';
		}
		[1, -1].forEach(function(direction) {
			var walk = onfoot.getWalk(direction);
			if (!walk) {
				return;
			}
			output += '<<timedlink "Walk ' + setup.units.kilometres(walk.distanceKm) + ' ' + walk.heading + '" '
				+ walk.minutes + ' "walk" "fatigue:+3">><<run setup.onfoot.walk(' + direction + ')>>'
				+ '<<goto "OnFoot">><</timedlink>><br>';
		});
		output += setup.wayfinding.signMarkup(onfoot.getPosition());
		onfoot.getBranchWalks().forEach(function(walk) {
			output += '<<timedlink "Walk ' + setup.units.kilometres(walk.distanceKm) + ' ' + walk.heading
				+ '" ' + walk.minutes + ' "walk" "fatigue:+3">><<run setup.onfoot.walk(1, '
				+ JSON.stringify(walk.choice) + ')>><<goto "OnFoot">><</timedlink>><br>';
		});
		var chopReason = onfoot.canChop();
		if (!chopReason) {
			output += '<<timedlink "Fell trees by hand" ' + onfoot.CHOP_MINUTES + ' "work" "fatigue:+3">>'
				+ '<<run setup.onfoot.chop()>><<goto "OnFoot">><</timedlink>><br>';
		}
		if (onfoot.isBesideTrain()) {
			if (setup.items.getPlayerCargo().some(function(stack) { return stack.amount > 0; })) {
				output += '<<timedlink "Load what you are carrying into the train" 10 "work" "fatigue:+1">>'
					+ '<<run setup.onfoot.stow()>><<goto "OnFoot">><</timedlink>><br>';
			}
			output += '<<timedlink "Climb back aboard" 2 "generic">><<run setup.onfoot.climbAboard()>>'
				+ '<<goto "OnTheLine">><</timedlink>><br>';
		} else {
			output += '<span class="small-description">The train is further down the line. You cannot ride until you '
				+ 'walk back to it.</span><br>';
		}
		new Wikifier(this.output, output);
	}
});
// Where the player is standing, and what they have on them.
Macro.add('onFootStatus', {
	handler: function() {
		var onfoot = setup.onfoot;
		var tile = onfoot.getTile();
		if (!tile) {
			return;
		}
		var hasTrain = Array.isArray(State.variables.currentTrain) && State.variables.currentTrain.length > 0;
		var output = '<p>' + (onfoot.isBesideTrain() ? 'You are on the ballast beside your train.'
			: hasTrain ? 'You are walking the track. Your train is standing somewhere behind you.'
				: 'You are walking the track without a train.') + '</p>';
		output += '<p class="small-description">' + tile.terrain + ', '
			+ setup.units.temperature(setup.worldmap.getClimate(setup.worldmap.getSeed(), tile.x, tile.y).temperature)
			+ '.</p>';
		output += '<p class="small-description">Carrying: ' + setup.items.describePlayerLoad() + '</p>';
		new Wikifier(this.output, output);
	}
});
