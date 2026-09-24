// Generation-only guarantees. A reserved through road stays empty; the other road holds accessible fuel.
setup.yardGeneration = {
	BROKEN_FREIGHT_CHANCE: 0.12,
	BROKEN_PASSENGER_CHANCE: 0.6,
	breakStock: function(tracks, stationId, seed) {
		var self = this, rng = setup.worldmap.rngFor(seed, 'broken-stock', stationId);
		tracks.forEach(function(track) { track.trains.forEach(function(train) { train.forEach(function(car) {
			var passenger = /coach|observation|kitchen|private/.test(car.type);
			if (rng() >= (passenger ? self.BROKEN_PASSENGER_CHANCE : self.BROKEN_FREIGHT_CHANCE)) return;
			car.broken = true; car.hasInterior = false; car.cargo = []; car.inventory = [];
			car.acceptedCargo = []; car.fireboxEnabled = false; car.steamStoredLiters = 0;
		}); }); });
	},
	reserve: function(tracks, stationId, seed) {
		var yard = setup.railyard, world = setup.worldmap;
		this.breakStock(tracks, stationId, seed);
		setup.recovery.ensureStock(tracks, stationId);
		// The engine must stand where it can get out: on a yard track that reaches a lead the station actually has. A
		// station at the end of a line has only one.
		var leads = yard.getLeads(tracks);
		var stockTrack = tracks.slice(1, -1).find(function(track) {
			var ends = yard.getTrackConnections(track, leads);
			return !track.reservedClearance && yard.getTrackFreeLength(track) >= 9 && (ends.entry || ends.exit);
		});
		if (!stockTrack) throw new Error('Generated yard has no room for its reserved locomotive.');
		var engine = yard.createLocomotiveCar('dieselShunter');
		// Price the escape consist with a full tank and a loaded freight car, not an empty locomotive.
		engine.cargo = [{ type: 'diesel', amount: 1500, grade: 80 }];
		engine.inventory = [{ item: 'pump', count: 1 }];
		engine.fuelReserve = true;
		var freight = yard.cloneCar(State.variables.defaultTrains.flatcar);
		freight.cargo = [{ type: 'timber', amount: 20000, grade: 60 }];
		var train = [engine, freight], minutes;
		if (world.isBranchStation(stationId)) {
			var branch = world.getBranchForStation(seed, stationId);
			minutes = branch.tiles.reduce(function(total, tile) { return total + world.getTileMinutes(-tile.grade, train); }, 0);
		} else {
			// The way out: the station's first exit line, or its only line when every line leaves the other side. The
			// line may run to a junction rather than a station, so the tank is sized for the way to the nearest other
			// station by track, at the pace of that first line.
			var line = world.getLine(stationId, true) || world.getLine(stationId, false);
			minutes = line ? world.getLegTravel(seed, line.legIndex, train, !line.forward).minutes : 0;
			var pilot = setup.realWorldPilot, here = line && pilot.getStationTile ? pilot.getStationTile(stationId) : null;
			if (here && pilot.getNodeDistances) {
				var leg = pilot.getLeg(line.legIndex), route = pilot.getGridRoute(), distances = pilot.getNodeDistances(here.globalPosition, 2000);
				var nearest = Object.keys(distances).filter(function(square) { return route.nodes[square].kind === 'station'; })
					.reduce(function(best, square) { return Math.min(best, distances[square]); }, Infinity);
				if (nearest < Infinity && leg.km > 0) minutes = Math.max(minutes, minutes / leg.km * nearest);
			}
		}
		// Include yard work before departure and five percent beyond the route cost.
		var required = Math.ceil(minutes * 1.05) + 20;
		if (required > 1500) throw new Error('Generated escape route exceeds reserve tank capacity.');
		engine.cargo[0].amount = required;
		var connections = yard.getTrackConnections(stockTrack, leads);
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
