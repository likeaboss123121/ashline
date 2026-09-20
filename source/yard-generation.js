// Generation-only guarantees. A reserved through road stays empty; the other road holds accessible fuel.
setup.yardGeneration = {
	reserve: function(tracks, stationId, seed) {
		var yard = setup.railyard, world = setup.worldmap;
		var stockTrack = tracks.slice(1, -1).find(function(track) { return !track.reservedClearance && yard.getTrackFreeLength(track) >= 9; });
		if (!stockTrack) throw new Error('Generated yard has no room for its reserved locomotive.');
		var engine = yard.createLocomotiveCar('dieselShunter');
		// Price the escape consist with a full tank and a loaded freight car, not an empty locomotive.
		engine.cargo = [{ type: 'diesel', amount: 1500, grade: 80 }];
		engine.inventory = [{ item: 'pump', count: 1 }];
		var freight = yard.cloneCar(State.variables.defaultTrains.flatcar);
		freight.cargo = [{ type: 'timber', amount: 20000, grade: 60 }];
		var train = [engine, freight], minutes;
		if (world.isBranchStation(stationId)) {
			var branch = world.getBranchForStation(seed, stationId);
			minutes = branch.tiles.reduce(function(total, tile) { return total + world.getTileMinutes(-tile.grade, train); }, 0);
		} else {
			minutes = world.getLegTravel(seed, stationId, train, false).minutes;
		}
		// Include yard work before departure and five percent beyond the route cost.
		var required = Math.ceil(minutes * 1.05) + 20;
		if (required > 1500) throw new Error('Generated escape route exceeds reserve tank capacity.');
		engine.cargo[0].amount = required;
		var leads = yard.getLeads(tracks), connections = yard.getTrackConnections(stockTrack, leads);
		stockTrack.trains.splice(connections.entry ? 0 : stockTrack.trains.length, 0, [engine]);
	},
	validate: function(tracks) {
		var yard = setup.railyard, leads = yard.getLeads(tracks);
		var clear = tracks.slice(1, -1).some(function(track) {
			var ends = yard.getTrackConnections(track, leads);
			return !track.trains.length && track.length >= 80 && (!leads.entry || ends.entry) && (!leads.exit || ends.exit);
		});
		if (!clear) throw new Error('Generated yard has no usable clear route.');
		var reachableReserve = tracks.slice(1, -1).some(function(track) {
			var ends = yard.getTrackConnections(track, leads);
			return track.trains.some(function(train, index) {
				return train.length === 1 && yard.isDieselLocomotiveCar(train[0]) && setup.fuel.canDieselRun(train[0])
					&& ((ends.entry && index === 0) || (ends.exit && index === track.trains.length - 1));
			});
		});
		if (!reachableReserve) throw new Error('Generated fuel reserve is not accessible from a connected end.');
		tracks.forEach(function(track) {
			if (!track.infinite && yard.getTrackOccupiedLength(track) > track.length) throw new Error('Generated track exceeds capacity.');
		});
		return true;
	}
};
