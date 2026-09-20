// Leaving the train out on the line.
//
// The player can climb down and walk the track, which is slow and hard: an hour and a good part of a day's energy
// for every 5 km tile, against five minutes riding. What it buys is reach: trees a train cannot stop beside, and
// whatever is further up the line.
//
// Standing beside the train, the player has the run of it: its tools, its stores, its bunker. A tile away they have
// only what they carry, which is why there is a pack at all.
setup.onfoot = {
	MINUTES_PER_TILE: 60,
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
	// Where the train is standing, which is where the player climbed down.
	getTrainPosition: function() {
		var journey = setup.worldmap.getJourney();
		return journey ? { tileIndex: journey.tileIndex, branch: journey.branch || null } : null;
	},
	isBesideTrain: function() {
		var foot = this.get();
		var train = this.getTrainPosition();
		return !!foot && !!train && foot.tileIndex === train.tileIndex && (foot.branch || null) === train.branch;
	},
	// Query the walker's route without temporarily moving the parked train.
	getPosition: function() {
		var foot = this.get(), journey = setup.worldmap.getJourney();
		return foot && journey ? { legIndex: journey.legIndex, tileIndex: foot.tileIndex,
			branch: foot.branch || null, forward: true } : null;
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
		State.variables.onFoot = { tileIndex: train.tileIndex, branch: train.branch };
		return true;
	},
	climbAboard: function() {
		if (!this.isBesideTrain()) {
			return false;
		}
		State.variables.onFoot = null;
		return true;
	},
	// One tile up or down the line. The walk is the cost: an hour, and the legs to go with it.
	getWalk: function(direction, branchId) {
		var position = this.getPosition(), world = setup.worldmap;
		if (!position) return null;
		var step;
		if (branchId != null) {
			if (position.branch) return null;
			var branch = (world.getJourneyPath(position).leg.branches || []).filter(function(candidate) {
				return candidate.id === branchId && candidate.tiles.length
					&& (candidate.fromIndex === position.tileIndex || candidate.rejoinIndex === position.tileIndex);
			})[0];
			if (!branch) return null;
			var atStart = branch.fromIndex === position.tileIndex;
			var index = atStart ? 0 : branch.tiles.length - 1;
			step = { toIndex: index, toBranch: branch.id, toMain: null, terrain: branch.tiles[index].terrain,
				heading: world.describeDirection(atStart ? branch.direction : world.opposite(branch.tiles[index].out)) };
		} else {
			// Reuse rail connectivity, but never apply train power/grade restrictions to walking.
			step = world.getJourneyStep(direction, position);
		}
		return step ? { toIndex: step.toIndex, branch: step.toMain != null ? null : (step.toBranch || position.branch),
			terrain: step.terrain, heading: step.heading, minutes: this.MINUTES_PER_TILE } : null;
	},
	getBranchWalks: function() {
		var position = this.getPosition(), self = this;
		if (!position || position.branch) return [];
		return (setup.worldmap.getJourneyPath(position).leg.branches || []).map(function(branch) {
			return self.getWalk(1, branch.id);
		}).filter(function(walk) { return !!walk; });
	},
	walk: function(direction, branchId) {
		var walk = this.getWalk(direction, branchId);
		if (!walk) {
			return false;
		}
		State.variables.onFoot = { tileIndex: walk.toIndex, branch: walk.branch };
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
		[1, -1].forEach(function(direction) {
			var walk = onfoot.getWalk(direction);
			if (!walk) {
				return;
			}
			output += '<<timedlink "Walk ' + setup.units.kilometres(setup.worldmap.TILE_KM) + ' ' + walk.heading + '" '
				+ walk.minutes + ' "walk" "fatigue:+3">><<run setup.onfoot.walk(' + direction + ')>>'
				+ '<<goto "OnFoot">><</timedlink>><br>';
		});
		onfoot.getBranchWalks().forEach(function(walk) {
			output += '<<timedlink "Walk ' + setup.units.kilometres(setup.worldmap.TILE_KM) + ' ' + walk.heading
				+ ' onto the branch" ' + walk.minutes + ' "walk" "fatigue:+3">><<run setup.onfoot.walk(1, '
				+ JSON.stringify(walk.branch) + ')>><<goto "OnFoot">><</timedlink>><br>';
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
		var output = '<p>' + (onfoot.isBesideTrain() ? 'You are on the ballast beside your train.'
			: 'You are walking the track. Your train is standing somewhere behind you.') + '</p>';
		output += '<p class="small-description">' + tile.terrain + ', '
			+ setup.units.temperature(setup.worldmap.getClimate(setup.worldmap.getSeed(), tile.x, tile.y).temperature)
			+ '.</p>';
		output += '<p class="small-description">Carrying: ' + setup.items.describePlayerLoad() + '</p>';
		new Wikifier(this.output, output);
	}
});
