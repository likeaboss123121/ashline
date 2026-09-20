setup.journal = {
	get: function() {
		var v = State.variables;
		if (!v.journal) v.journal = { started: setup.time.getCurrentTimestampMs(), kilometres: 0, stations: [v.currentStation] };
		return v.journal;
	},
	travel: function() { this.get().kilometres += setup.worldmap.TILE_KM; },
	visit: function(station) {
		var record = this.get();
		if (record.stations.indexOf(station) === -1) record.stations.push(station);
	}
};
Macro.add('journeyRecord', {
	handler: function() {
		var record = setup.journal.get(), dl = document.createElement('dl');
		[['Days survived', Math.max(0, Math.floor((setup.time.getCurrentTimestampMs() - setup.time.startTimestampMs) / 86400000))],
			['Distance travelled', setup.units.kilometres(record.kilometres)], ['Stations visited', record.stations.length]].forEach(function(row) {
			var dt = document.createElement('dt'), dd = document.createElement('dd');
			dt.textContent = row[0]; dd.textContent = row[1]; dl.appendChild(dt); dl.appendChild(dd);
		});
		this.output.appendChild(dl);
		var visits = document.createElement('ul');
		record.stations.forEach(function(id) { var li = document.createElement('li'); li.textContent = setup.worldmap.getStationName(id); visits.appendChild(li); });
		this.output.appendChild(visits);
	}
});
