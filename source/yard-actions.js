/* Track endpoints and shunting commands. Neither the renderer nor the tutorial owns movement rules. */
setup.yardActions = {
	context: function() {
		var v = State.variables;
		return { v: v, tracks: v.stationTracks && v.stationTracks[v.currentStation],
			from: Number(v.drivingTrackIndex), gap: Number(v.enteredTrainIndex) || 0, train: v.currentTrain };
	},
	// Each endpoint either reaches one ladder or ends at a buffer. Leads have only one internal end.
	graph: function(tracks) {
		var yard = setup.railyard, leads = yard.getLeads(tracks);
		return tracks.map(function(track, i) {
			if (!yard.trackExists(tracks, i)) return [];
			if (i === 0) return [{ end: 'exit', ladder: 'entry' }];
			if (i === tracks.length - 1) return [{ end: 'entry', ladder: 'exit' }];
			var connections = yard.getTrackConnections(track, leads);
			return ['entry', 'exit'].filter(function(end) { return connections[end]; })
				.map(function(end) { return { end: end, ladder: end }; });
		});
	},
	// Enumerate routes through the two ladders. Switching between parallel roads requires a headshunt;
	// crossing between ladders requires an empty through road. Trains on unrelated roads never obstruct it.
	routes: function(tracks, from, to, length, gap) {
		if (!Array.isArray(tracks) || from === to || !tracks[from] || !tracks[to]) return [];
		var yard = setup.railyard, graph = this.graph(tracks), last = tracks.length - 1, result = [];
		var boundary = function(i) { return i === 0 || i === last; };
		var room = function(i) { return yard.trackExists(tracks, i) && yard.getTrackFreeLength(tracks[i]) >= length; };
		var headshunt = function(ladder) { return ladder === 'entry' ? 0 : last; };
		graph[from].forEach(function(a) {
			if (gap !== undefined && yard.hasTrackObstructionInDirection(tracks, from, gap, a.end === 'exit')) return;
			graph[to].forEach(function(b) {
				var route = { leaveEnd: a.end, arriveEnd: b.end, via: [] };
				if (a.ladder === b.ladder) {
					if (!boundary(from) && !boundary(to)) {
						var lead = headshunt(a.ladder);
						if (!room(lead)) return;
						route.via.push(lead);
					}
					result.push(route);
				} else {
					if (!boundary(from) && !room(headshunt(a.ladder))) return;
					if (!boundary(to) && !room(headshunt(b.ladder))) return;
					for (var i = 1; i < last; i++) {
						if (i === from || i === to || graph[i].length !== 2 || tracks[i].trains.length || !room(i)) continue;
						result.push({ leaveEnd: a.end, arriveEnd: b.end, via:
							(!boundary(from) ? [headshunt(a.ladder)] : []).concat([i], !boundary(to) ? [headshunt(b.ladder)] : []) });
					}
				}
			});
		});
		return result.sort(function(a, b) { return a.via.length - b.via.length; });
	},
	plan: function(command) {
		var c = this.context(), v = c.v, tracks = c.tracks, yard = setup.railyard;
		var fail = function(reason) { return { ok: false, reason: reason }; };
		if (!tracks || !Array.isArray(c.train) || !c.train.length || v.journey || !yard.trackExists(tracks, c.from)) return fail('There is no train in this yard.');
		var length = yard.getTrainLength(c.train), plan = { ok: true, command: command, minutes: Math.max(1, Math.ceil(length / 25)), mode: 'shunting' };
		if (command.kind === 'decouple') {
			var reason = yard.getDecoupleBlockReason(command.front);
			if (reason) return fail(reason);
			plan.mode = 'manual';
			plan.minutes = Math.max(1, Math.ceil(yard.getDecoupleSection(command.front).length / 2));
			return plan;
		}
		if (!yard.isTrainDriveCapable(c.train)) return fail('The locomotive needs usable fuel or steam pressure.');
		var to = command.to;
		if (!Number.isInteger(to) || !yard.trackExists(tracks, to)) return fail('That track does not exist.');
		var routes;
		if (command.kind === 'move') {
			if (!yard.canTrainFitOnTrack(tracks[to], c.train)) return fail('The consist will not fit on that track.');
			routes = this.routes(tracks, c.from, to, length, c.gap);
		} else if (command.kind === 'couple') {
			var target = tracks[to].trains[command.train];
			if (!target) return fail('That train is no longer there.');
			plan.target = target;
			length += yard.getTrainLength(target);
			if (to !== c.from && yard.getTrackFreeLength(tracks[c.from]) < length) return fail('The combined consist will not fit on your current track.');
			if (to === c.from) {
				if (command.train !== c.gap && command.train !== c.gap - 1) return fail('Another train blocks access.');
				plan.front = command.train === c.gap;
				routes = [{ via: [], arriveEnd: plan.front ? 'entry' : 'exit' }];
			} else {
				routes = this.routes(tracks, c.from, to, length, c.gap).filter(function(route) {
					return command.train === (route.arriveEnd === 'entry' ? 0 : tracks[to].trains.length - 1);
				});
			}
			routes = routes.filter(function(route) { return command.front === (route.arriveEnd === 'entry'); });
			plan.front = command.front;
			plan.minutes = Math.max(1, Math.ceil(yard.getTrainLength(target) / 25));
		} else if (command.kind === 'shove') {
			var source = tracks[command.source];
			if (!source || !source.trains.length || command.source === c.from || command.source === to) return fail('No occupied track to shove.');
			plan.target = yard.flattenTrackTrainsForDirection(source.trains, false);
			var combined = length + yard.getTrainLength(plan.target);
			if (yard.getTrackFreeLength(tracks[to]) < combined) return fail('The combined consist will not fit at the destination.');
			var approach = this.routes(tracks, c.from, command.source, length, c.gap);
			routes = this.routes(tracks, command.source, to, combined).filter(function(route) {
				return approach.some(function(first) { return first.arriveEnd !== route.leaveEnd && first.via.length === 0; });
			});
			if (routes.length) plan.front = routes[0].leaveEnd === 'exit';
			plan.minutes = Math.max(1, Math.ceil(yard.getTrainLength(plan.target) / 25));
		} else if (command.kind === 'setout') {
			plan.section = yard.getDecoupleSection(command.front);
			if (!plan.section.length) return fail('There are no cars on that side to leave behind.');
			if (!yard.canTrainFitOnTrack(tracks[to], plan.section)) return fail('The cars will not fit on that track.');
			routes = this.routes(tracks, c.from, to, length, c.gap).filter(function(route) {
				return route.arriveEnd === (command.front ? 'entry' : 'exit');
			});
			plan.minutes = Math.max(2, Math.ceil(length / 25) * 2 + 1);
		} else return fail('Unknown yard action.');
		if (!routes.length) return fail('No clear connected route with enough headshunt space.');
		plan.route = routes[0];
		plan.minutes += plan.route.via.length;
		return plan;
	},
	execute: function(command) {
		// Re-plan at click time. Rejected actions spend no fuel or time and never move rolling stock.
		var plan = this.plan(command), c = this.context(), v = c.v, yard = setup.railyard;
		if (!plan.ok) return plan;
		if (!setup.time.advanceMinutesWithSystems(plan.minutes, plan.mode)) return { ok: false, reason: v.timedActionFailure };
		if (command.kind === 'move') {
			v.drivingTrackIndex = command.to;
			v.enteredTrainIndex = plan.route.arriveEnd === 'entry' ? 0 : c.tracks[command.to].trains.length;
		} else if (command.kind === 'couple') {
			c.tracks[command.to].trains.splice(command.train, 1);
			v.currentCarIndex = (Number(v.currentCarIndex) || 0) + yard.coupleTrainWithDirection(c.train, plan.target, false, plan.front);
			if (command.to === c.from && command.train < c.gap) v.enteredTrainIndex--;
		} else if (command.kind === 'shove') {
			c.tracks[command.source].trains = [];
			v.currentCarIndex = (Number(v.currentCarIndex) || 0) + yard.coupleTrainWithDirection(c.train, plan.target, false, plan.front);
			v.drivingTrackIndex = command.to;
			v.enteredTrainIndex = plan.route.arriveEnd === 'entry' ? 0 : c.tracks[command.to].trains.length;
		} else if (command.kind === 'decouple') {
			yard.decoupleSection(command.front);
		} else if (command.kind === 'setout') {
			var count = plan.section.length;
			var section = command.front ? c.train.splice(0, count) : c.train.splice(c.train.length - count);
			if (command.front) v.currentCarIndex -= count;
			yard.markTrainVisited(section);
			c.tracks[command.to].trains.splice(plan.route.arriveEnd === 'entry' ? 0 : c.tracks[command.to].trains.length, 0, section);
		}
		if (setup.bugReport) setup.bugReport.record(command);
		return { ok: true };
	},
	options: function() {
		var c = this.context(), self = this, yard = setup.railyard, options = [];
		options.reasons = [];
		if (!c.tracks || !c.train) return options;
		var add = function(command, key, label, detail) {
			var plan = self.plan(command);
			if (plan.ok) options.push({ command: command, key: key, label: label, detail: detail || '', plan: plan });
			else options.reasons.push({ key: key, reason: plan.reason });
		};
		c.tracks.forEach(function(track, to) {
			var name = yard.getTrackLabel(c.tracks, to);
			if (to !== c.from) {
				add({ kind: 'move', to: to }, 'track:' + to,
					(to === 0 ? 'Reverse consist to ' : to === c.tracks.length - 1 ? 'Drive consist to ' : c.from === c.tracks.length - 1 ? 'Reverse consist into ' : 'Drive consist into ') + name);
				if (yard.isBoundaryTrackIndex(c.tracks, c.from) && !yard.isBoundaryTrackIndex(c.tracks, to)
					&& !yard.canTrainFitOnTrack(track, c.train)) {
					var destination = c.from === 0 ? c.tracks.length - 1 : 0;
					add({ kind: 'shove', source: to, to: destination }, 'shove:' + to,
						'Couple to entire track and shove to ' + yard.getTrackLabel(c.tracks, destination));
				}
				[true, false].forEach(function(front) {
					add({ kind: 'setout', to: to, front: front }, 'setout:' + to + ':' + front,
						'Push ' + (front ? 'front' : 'rear') + ' section into ' + name + ', detach and return',
						'Leave ' + yard.getDecoupleSection(front).length + ' car(s); return to ' + yard.getTrackLabel(c.tracks, c.from) + '.');
				});
			}
			track.trains.forEach(function(train, index) {
				[true, false].forEach(function(front) {
					add({ kind: 'couple', to: to, train: index, front: front }, 'couple-' + (front ? 'front:' : 'rear:') + to + ':' + index,
						'Couple to the ' + (front ? 'front' : 'rear'), name + ': ' + yard.getTrainCarListText(train));
				});
			});
		});
		return options;
	},
	append: function(parent, option) {
		var span = document.createElement('span'), link = document.createElement('a');
		span.setAttribute('data-yard-action', option.key);
		if (setup.tutorial && setup.tutorial.isSuggested(option.key)) {
			span.className = 'tutorial-next-action';
			span.setAttribute('data-tutorial-action', 'true');
		}
		link.href = '#';
		link.className = 'link-internal';
		link.textContent = setup.time.formatLinkLabel(option.label, option.plan.minutes);
		link.addEventListener('click', function(event) {
			event.preventDefault();
			var result = setup.yardActions.execute(option.command);
			if (result.ok) Engine.play(State.passage);
			else { Dialog.setup('Action unavailable'); Dialog.wiki(result.reason); Dialog.open(); }
		});
		span.appendChild(link);
		new Wikifier(span, setup.effects.describeHtml('fatigue:+1'));
		parent.appendChild(span);
		parent.appendChild(document.createElement('br'));
		if (option.detail) {
			var detail = document.createElement('small');
			detail.textContent = option.detail;
			parent.appendChild(detail);
			parent.appendChild(document.createElement('br'));
		}
	}
};
