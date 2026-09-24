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
	enterRailyard: function() {
		var foot = this.get(), stationId = this.getStationId();
		if (!foot || !stationId) return false;
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
		return journey ? { legIndex: journey.legIndex, tileIndex: journey.tileIndex, branch: journey.branch || null } : null;
	},
	isBesideTrain: function() {
		var foot = this.get();
		var train = this.getTrainPosition();
		if (!foot || !train) return false;
		if ((foot.legIndex || train.legIndex) === train.legIndex && foot.tileIndex === train.tileIndex
			&& (foot.branch || null) === train.branch) return true;
		// At a junction the same square ends several legs, so compare where each actually stands.
		var world = setup.worldmap, here = world.getJourneyView(this.getPosition()), there = world.getJourneyView();
		return !!here && !!there && !!here.realWorld && here.tile.x === there.tile.x && here.tile.y === there.tile.y;
	},
	// Query the walker's route without temporarily moving the parked train.
	getPosition: function() {
		var foot = this.get(), journey = setup.worldmap.getJourney();
		return foot && journey ? { legIndex: foot.legIndex || journey.legIndex, tileIndex: foot.tileIndex,
			branch: foot.branch || null, forward: true, realWorldCorridorId: journey.realWorldCorridorId } : null;
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
		State.variables.onFoot = { legIndex: train.legIndex, tileIndex: train.tileIndex, branch: train.branch };
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
		if (!position || this.isInRailyard()) return null;
		var step, legIndex = position.legIndex;
		if (branchId != null && world.getJourneyPath(position).leg.realWorld) {
			// A line leaving the junction the walker stands at.
			step = world.getBranchStep(branchId, position);
			if (step) legIndex = Number(String(branchId).replace('leg:', ''));
		} else if (branchId != null) {
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
		var distanceKm = step && step.distanceKm ? step.distanceKm : setup.worldmap.TILE_KM;
		if (step && step.realWorld) return { legIndex: legIndex, toIndex: step.toIndex, branch: null, terrain: step.terrain,
			heading: step.heading, distanceKm: distanceKm,
			minutes: Math.max(1, Math.round(this.MINUTES_PER_TILE * distanceKm / setup.worldmap.TILE_KM)) };
		return step ? { toIndex: step.toIndex, branch: step.toMain != null ? null : (step.toBranch || position.branch),
			terrain: step.terrain, heading: step.heading, distanceKm: distanceKm,
			minutes: Math.max(1, Math.round(this.MINUTES_PER_TILE * distanceKm / setup.worldmap.TILE_KM)) } : null;
	},
	getBranchWalks: function() {
		var position = this.getPosition(), self = this;
		if (!position || position.branch) return [];
		if (setup.worldmap.getJourneyPath(position).leg.realWorld) {
			return setup.worldmap.getBranchChoices(position).map(function(choice) {
				var walk = self.getWalk(1, choice.id);
				if (walk) walk.choice = choice.id;
				return walk;
			}).filter(function(walk) { return !!walk; });
		}
		return (setup.worldmap.getJourneyPath(position).leg.branches || []).map(function(branch) {
			return self.getWalk(1, branch.id);
		}).filter(function(walk) { return !!walk; });
	},
	walk: function(direction, branchId) {
		var walk = this.getWalk(direction, branchId);
		if (!walk) {
			return false;
		}
		State.variables.onFoot = { legIndex: walk.legIndex || this.getPosition().legIndex, tileIndex: walk.toIndex, branch: walk.branch };
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
		var stationId = onfoot.getStationId();
		if (stationId) {
			output += '<<link "Enter ' + setup.worldmap.getStationName(stationId) + ' railyard">>'
				+ '<<if setup.onfoot.enterRailyard()>><<goto "Railyard">><</if>><</link>><br>';
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
			output += '<<timedlink "Walk ' + setup.units.kilometres(walk.distanceKm || setup.worldmap.TILE_KM) + ' ' + walk.heading
				+ (walk.choice ? '' : ' onto the branch') + '" ' + walk.minutes + ' "walk" "fatigue:+3">><<run setup.onfoot.walk(1, '
				+ JSON.stringify(walk.choice || walk.branch) + ')>><<goto "OnFoot">><</timedlink>><br>';
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
