// Rail yard view: draws the current station as isometric pixel art, using the SVG templates in
// source/img/railyard/ and the placement data in railyard-templates.js.
//
// Layout: the entry lead arrives on the first yard track's line, a ladder of Y switches branches
// off to every yard track, the yard tracks run side by side, and a second ladder joins them back
// into the exit lead on the last yard track's line. The view reads game state only; the text
// controls below it are still how the player acts. See docs/RAILYARD_ART.md.
setup.railyardView = {
	SVG_NS: 'http://www.w3.org/2000/svg',
	XLINK_NS: 'http://www.w3.org/1999/xlink',
	SCALE: 2, // whole-number zoom keeps the pixel art crisp
	TRAIN_GAP_METRES: 4, // visual space between separate trains on one track
	FREE_STUB_METRES: 20, // empty track drawn past the last train when a track is too long to show
	MIN_SECTION_METRES: 40,
	ZOOM_STEPS: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4],
	LEAD_CLEARANCE_METRES: 4, // space between the ladder and the nearest train on a lead
	MIN_LEAD_METRES: 30,
	GROUND_MARGIN_METRES: 4,
	GROUND_HALF_WIDTH_UNITS: 16, // how far the ground reaches past each track's centreline
	PADDING: 6,
	LABEL_OFFSET_UNITS: 22, // track labels sit this far left of the entry ladder, clear of the ground's edge
	getTemplate: function(name) {
		if (!this.templatesByName) {
			this.templatesByName = {};
			var templates = setup.railyardTemplates.templates;
			for (var i = 0; i < templates.length; i++) {
				this.templatesByName[templates[i].passage] = templates[i];
			}
		}
		return this.templatesByName[name] || null;
	},
	// Tweego bundles each template SVG as an image passage whose text is a data URI.
	getImageSource: function(name) {
		if (!Story.has(name)) {
			return '';
		}
		var passage = Story.get(name);
		return passage.tags.includes('Twine.image') ? String(passage.text).trim() : '';
	},
	// Named parts that belong on the rail layer. Everything else in a track piece is its bed.
	TRACK_HIT_HALF_BAND: 14, // one consistent finger/mouse band for rails and parked trains
	TRAIN_HIT_HALF_BAND: 14,
	GROUND_COLOUR: '#2b302d', // .railyard-ground in railyard.css, graded here at dusk and night
	RAIL_PARTS: ['rails', 'diagonal-rails', 'diagonal-up-rails', 'branch-rails', 'selection'],
	// Copies a template's shapes out of its image passage. Returns a <g> with the whole template, plus
	// separate bed, branch-rail, ladder-rail, and straight-rail groups, painted in that order across the yard.
	createTemplateGroups: function(name, id) {
		if (!this.templateDocuments) {
			this.templateDocuments = {};
		}
		if (!this.templateDocuments[name]) {
			var source = this.getImageSource(name);
			var comma = source.indexOf(',');
			if (comma === -1) {
				throw new Error('rail yard template "' + name + '" is not bundled');
			}
			var header = source.slice(0, comma);
			var body = source.slice(comma + 1);
			var text = /;base64/i.test(header) ? atob(body) : decodeURIComponent(body);
			var root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
			if (!root || root.localName !== 'svg') {
				throw new Error('rail yard template "' + name + '" could not be read');
			}
			this.templateDocuments[name] = root;
		}
		var ns = this.SVG_NS;
		var make = function(groupId) {
			var group = document.createElementNS(ns, 'g');
			group.setAttribute('id', groupId);
			return group;
		};
		var groups = { all: make(id), bed: make(id + '-bed'), branch: make(id + '-branch'), ladder: make(id + '-ladder'), rails: make(id + '-rails') };
		var children = this.templateDocuments[name].children;
		for (var i = 0; i < children.length; i++) {
			var child = children[i];
			if (child.localName === 'title') {
				continue;
			}
			groups.all.appendChild(document.importNode(child, true));
			var part = child.getAttribute('id');
			var layer = part === 'branch-rails' ? groups.branch
				: part === 'diagonal-rails' || part === 'diagonal-up-rails' ? groups.ladder
				: this.RAIL_PARTS.indexOf(part) === -1 ? groups.bed : groups.rails;
			layer.appendChild(document.importNode(child, true));
		}
		return groups;
	},
	project: function(u, v) {
		return { x: u - v, y: (u + v) / 2 };
	},
	// Every car records which way it physically points (setup.railyard.getCarFacing): 1 towards the station's
	// exit, -1 the other way. Shunting never turns a car round, so the facing survives coupling, decoupling and
	// travel; seeing the yard from its other end is what swaps left for right on screen.
	getCarTemplateName: function(car, flipped) {
		var variant = setup.stockVariety.variantName(car, 'railyard');
		if (variant) return variant;
		var type = car && car.type;
		if (type === 'steam loco' || type === 'diesel loco') {
			var facing = setup.railyard.getCarFacing(car) * (flipped ? -1 : 1);
			return 'railyard-loco-' + setup.railyard.getLocomotiveModel(car) + '-' + (facing >= 0 ? 'right' : 'left');
		}
		if (type === 'flatcar') return 'railyard-car-flatcar';
		if (type === 'tanker car') return 'railyard-car-tanker';
		if (type === 'gondola') return 'railyard-car-gondola';
		if (type === 'hopper car') return 'railyard-car-hopper';
		if (type === 'refrigerated car') return 'railyard-car-refrigerated';
		var passenger = { 'passenger coach': 'passenger', 'sleeper coach': 'sleeper',
			'observation car': 'observation', 'kitchen car': 'kitchen', 'private car': 'private' };
		if (passenger[type]) return 'railyard-car-' + passenger[type];
		return 'railyard-car-boxcar';
	},
	getTrackBadge: function(index) {
		return (index < 10 ? '0' : '') + index;
	},
	// The trains on one track in entry-to-exit order, with the player's consist in its gap.
	getTrainGroups: function(track, trackIndex, player) {
		var trains = Array.isArray(track.trains) ? track.trains : [];
		var hasPlayer = player !== null && player.trackIndex === trackIndex;
		var groups = [];
		for (var j = 0; j <= trains.length; j++) {
			if (hasPlayer && player.gapIndex === j) {
				groups.push({ train: player.train, isPlayer: true });
			}
			if (j < trains.length) {
				groups.push({ train: trains[j], isPlayer: false, trainIndex: j });
			}
		}
		return groups;
	},
	getGroupsLength: function(groups) {
		var total = 0;
		for (var g = 0; g < groups.length; g++) {
			total += setup.railyard.getTrainLength(groups[g].train);
		}
		return total + Math.max(0, groups.length - 1) * this.TRAIN_GAP_METRES;
	},
	// Lays trains out toward the exit (+u) from startMetres. Each car array runs front to rear,
	// so a train's last car comes first.
	packForward: function(groups, startMetres, v, cars, trackIndex, reversed) {
		var cursor = startMetres;
		for (var g = 0; g < groups.length; g++) {
			if (g > 0) {
				cursor += this.TRAIN_GAP_METRES;
			}
			var train = groups[g].train;
			// A car array runs front to rear, and the front points toward the station's exit. Drawing from the
			// other end means laying the cars down the other way round, while each car keeps its real index.
			for (var i = 0, c = 0; i < train.length; i++) {
				c = reversed ? i : train.length - 1 - i;
				cars.push({
					car: train[c], carIndex: c, trainLength: train.length, u: cursor, v: v,
					isPlayer: groups[g].isPlayer, trackIndex: trackIndex, trainIndex: groups[g].trainIndex
				});
				cursor += Number(train[c].length) || 0;
			}
		}
	},
	// Lays trains out toward the entry (-u), ending at endMetres. Used on the entry lead,
	// where the last train in the list is the one nearest the yard.
	packBackward: function(groups, endMetres, v, cars, trackIndex, reversed) {
		var cursor = endMetres;
		for (var g = groups.length - 1; g >= 0; g--) {
			if (g < groups.length - 1) {
				cursor -= this.TRAIN_GAP_METRES;
			}
			var train = groups[g].train;
			for (var i = 0, c = 0; i < train.length; i++) {
				c = reversed ? train.length - 1 - i : i;
				cursor -= Number(train[c].length) || 0;
				cars.push({
					car: train[c], carIndex: c, trainLength: train.length, u: cursor, v: v,
					isPlayer: groups[g].isPlayer, trackIndex: trackIndex, trainIndex: groups[g].trainIndex
				});
			}
		}
	},
	// Places every track piece, car, and label in world coordinates (u in metres, v in units).
	//
	// The yard is always drawn the same way round, with the entry lead on the left, whatever compass headings the
	// station's leads have: only their labels change, so every yard reads alike.
	//
	// Each lead runs along one yard track's line (setup.railyard.getLeadTrack). From the entry lead's track, a
	// ladder branches down the screen to nearer tracks and a horizontal "up" ladder branches to farther ones;
	// the exit side mirrors this. A station may lack a lead entirely (station 1 has nothing behind it, and any
	// station's exit can be closed): that lead, its ladder and its label are not drawn, and every yard track ends
	// in a buffer stop on that side. Track r meets the entry ladder at u = |r - entryRow| x J, and the exit ladder
	// at u = exitBase - |r - exitRow| x J, where exitBase leaves every track room for its section.
	layout: function(tracks, player) {
		var data = setup.railyardTemplates;
		var tile = data.trackTileMetres;
		var J = data.junctionMetres;
		var spacing = data.trackSpacingUnits;
		var entryIndex = setup.railyard.getEntryTrackIndex();
		var exitIndex = setup.railyard.getExitTrackIndex(tracks);
		var yardCount = Math.max(0, exitIndex - entryIndex - 1);
		var roundUp = function(metres) { return Math.ceil(metres / tile) * tile; };
		var isOn = function(index) { return player !== null && player.trackIndex === index; };
		var self = this;
		var result = { flat: [], cars: [], labels: [], groundSpans: [], hits: [], trainCount: player ? 1 : 0 };
		var piece = function(name, u, v) { result.flat.push({ name: 'railyard-track-' + name, u: u, v: v }); };
		var tiles = function(from, to, v, selected) {
			for (var m = from; m < to; m += tile) {
				result.flat.push({ name: selected ? 'railyard-track-tile-selected' : 'railyard-track-tile', u: m, v: v });
			}
		};
		tracks.forEach(function(track) { result.trainCount += Array.isArray(track.trains) ? track.trains.length : 0; });
		var r;
		var rowV = function(row) { return (Math.max(1, row) - 1) * spacing; };
		// The yard is drawn from the player's point of view: the lead they arrived on is always at the top left and
		// the way onward runs to the bottom right, so driving on is always to the right. Arriving from the other end
		// turns the whole yard around, which is the same yard seen from its other end: the leads swap corners and
		// the rows mirror. Only the drawing changes; every index below the surface is still the station's own.
		var flipped = setup.railyard.isYardViewFlipped();
		var dataIndex = function(row) { return flipped ? yardCount + 1 - row : row; };
		var arrivalIndex = flipped ? exitIndex : entryIndex;
		var onwardIndex = flipped ? entryIndex : exitIndex;
		var trackAt = function(row) { return tracks[dataIndex(row)]; };
		var stationLeads = setup.railyard.getLeads(tracks);
		var leads = flipped ? { entry: stationLeads.exit, exit: stationLeads.entry } : stationLeads;
		var connects = function(row) {
			var ends = setup.railyard.getTrackConnections(trackAt(row), stationLeads);
			return flipped ? { entry: ends.exit, exit: ends.entry } : ends;
		};
		var leadRowAt = function(which) {
			var row = setup.railyard.getLeadTrack(tracks, flipped ? (which === 'entry' ? 'exit' : 'entry') : which);
			return flipped ? yardCount + 1 - row : row;
		};
		// Seen from the other end, the trains on a track stand in the opposite order.
		var groupsAt = function(row, index) {
			var groups = self.getTrainGroups(tracks[index], index, player);
			return flipped ? groups.slice().reverse() : groups;
		};
		var entryRow = leadRowAt('entry');
		var exitRow = leadRowAt('exit');
		// Every yard track is drawn at its own length, so a 350 m track is visibly a third of a 950 m one. The
		// generator lays out lengths that fit the ladder, so the merges come out one junction apart; a length
		// that does not fit is still drawn honestly, and the track it cannot reach gets a buffer stop.
		var yardGroups = [];
		var sections = [];
		for (r = 1; r <= yardCount; r++) {
			yardGroups[r] = groupsAt(r, dataIndex(r));
			var content = this.getGroupsLength(yardGroups[r]);
			var stated = trackAt(r).infinite ? content + this.FREE_STUB_METRES : Number(trackAt(r).length) || 0;
			sections[r] = roundUp(Math.max(this.MIN_SECTION_METRES, stated, content));
		}
		// A ladder runs from its lead's track to the farthest tracks, above and below, that connect on its side.
		var extents = function(side, leadRow) {
			var ext = { top: leadRow, bottom: leadRow, any: false };
			for (var row = 1; row <= yardCount; row++) {
				if (connects(row)[side]) {
					ext.any = true;
					ext.top = Math.min(ext.top, row);
					ext.bottom = Math.max(ext.bottom, row);
				}
			}
			return ext;
		};
		var entry = extents('entry', entryRow);
		var exit = extents('exit', exitRow);
		// Without an entry ladder there is nothing to stagger the tracks against, so they all start at the same
		// u, one tile in, leaving room for the buffer stop that closes each of them.
		var entryJunction = function(row) { return leads.entry ? Math.abs(row - entryRow) * J : 0; };
		var sectionStart = function(row) { return entryJunction(row) + (leads.entry ? J : tile); };
		// Each track ends where its length says. The exit ladder is a chain stepping one junction per row, anchored
		// so that no through track overshoots it: with lengths that follow the yard's geometry, every through track
		// ends exactly where the ladder crosses its row. A siding stops short of that and closes with a buffer stop.
		// Which ladder a track hangs from: one closed toward the entry is reached from the exit end, so it starts
		// late and runs to the exit ladder. That puts stubs at both ends of the yard rather than always trailing
		// from the side the player drives in on. Only through tracks anchor the ladder, since an exit-hung stub
		// ends at the ladder by definition.
		var hangsFromExit = function(row) {
			var ends = connects(row);
			return !ends.entry && ends.exit;
		};
		var entryEnd = function(row) { return sectionStart(row) + sections[row]; };
		var exitBase = 0;
		for (r = 1; r <= yardCount; r++) {
			if (connects(r).exit && !hangsFromExit(r)) {
				exitBase = Math.max(exitBase, entryEnd(r) + Math.abs(r - exitRow) * J);
			}
		}
		if (!exitBase) {
			for (r = 1; r <= yardCount; r++) {
				exitBase = Math.max(exitBase, entryEnd(r) + Math.abs(r - exitRow) * J);
			}
		}
		var exitJunction = function(row) { return exitBase - Math.abs(row - exitRow) * J; };
		var rowStart = function(row) { return hangsFromExit(row) ? exitJunction(row) - sections[row] : sectionStart(row); };
		var rowEnd = function(row) { return hangsFromExit(row) ? exitJunction(row) : entryEnd(row); };
		// Connections are rules, not a side effect of drawing lengths. A short usable section gets connecting
		// rail out to its ladder; the renderer must never invent a buffer on a route the planner permits.
		var reachesLadder = function(row) { return row >= 1 && row <= yardCount && connects(row).exit; };
		var deadExit = {};
		// Entry lead: arrives from off the map along the entry track's line and ends at the ladder (u = 0).
		var entryV = rowV(entryRow);
		if (leads.entry) {
			var entryGroups = groupsAt(entryRow, arrivalIndex);
			var entryTrack = tracks[arrivalIndex];
			var entryIsStub = !entryTrack.infinite;
			var entryLead = entryIsStub ? roundUp(Math.max(tile, Number(entryTrack.length) || tile))
				: roundUp(Math.max(this.MIN_LEAD_METRES, this.getGroupsLength(entryGroups) + this.LEAD_CLEARANCE_METRES + this.FREE_STUB_METRES));
			if (entryIsStub) piece('buffer-stop-start', -entryLead, entryV);
			else piece('fade-in', -entryLead, entryV);
			// A finite lead's buffer stop is anchored at the rail end, so its first tile must begin at that same
			// anchor. Starting one tile later left a visible, non-functional gap between a Southbound stub and its ladder.
			tiles(entryIsStub ? -entryLead : -entryLead + tile, 0, entryV, isOn(arrivalIndex));
			if (yardCount && !entry.any) {
				piece('buffer-stop', 0, entryV); // no yard track connects to the entry
			}
			this.packBackward(entryGroups, -this.LEAD_CLEARANCE_METRES, entryV, result.cars, arrivalIndex, flipped);
			result.hits.push({ trackIndex: arrivalIndex, u0: entryIsStub ? -entryLead : -entryLead + tile, u1: 0, v: entryV });
			// The far end of the lead leaves the station: clicking it departs, the way the travel links do.
			if (!entryIsStub) {
				result.hits.push({
					depart: flipped ? 'exit' : 'entry', u0: -entryLead, u1: -entryLead + tile, v: entryV
				});
			}
			var entryName = setup.railyard.getTrackLabel(tracks, arrivalIndex).toUpperCase();
			var entryOccupied = setup.railyard.getTrackOccupiedLength(entryTrack)
				+ (isOn(arrivalIndex) ? setup.railyard.getTrainLength(player.train) : 0);
			result.labels.push({ text: entryIsStub ? entryName + ' · ' + setup.units.metres(Math.max(0, entryTrack.length - entryOccupied))
				+ ' free of ' + setup.units.metres(entryTrack.length) : entryName,
				u: -entryLead, v: entryV, dx: -3, dy: 2, anchor: 'end', player: isOn(arrivalIndex) });
		}
		// Entry ladders. The lead's own track gets a Y switch (or one branching both ways); tracks the ladder
		// continues past get YY switches; tracks that do not connect are passed with a plain diagonal.
		var hasEntryStraight = {};
		var entryPiece = function(row, up) {
			if (!connects(row).entry) {
				return up ? 'diagonal-up' : 'diagonal';
			}
			hasEntryStraight[row] = true;
			return (row === entryRow ? 'y-split' : 'yy-split') + (up ? '-up' : '');
		};
		if (yardCount && leads.entry) {
			var entryDown = entry.bottom > entryRow;
			var entryUp = entry.top < entryRow;
			if (entryDown && entryUp && connects(entryRow).entry) {
				piece('y-split-both', 0, entryV);
				hasEntryStraight[entryRow] = true;
			} else {
				if (entryDown) piece(entryPiece(entryRow, false), 0, entryV);
				if (entryUp) piece(entryPiece(entryRow, true), 0, entryV);
			}
			for (r = entryRow + 1; r < entry.bottom; r++) piece(entryPiece(r, false), entryJunction(r), rowV(r));
			for (r = entryRow - 1; r > entry.top; r--) piece(entryPiece(r, true), entryJunction(r), rowV(r));
		}
		// Exit ladders. A merge piece sits where a track leaves toward the exit track, and carries the straight
		// of the track it joins. When ladders join the exit track from both sides, one piece joins both.
		var hasExitStraight = {};
		var exitPiece = function(source, up) {
			var dest = up ? source - 1 : source + 1;
			if (!connects(dest).exit || !reachesLadder(dest)) {
				// The ladder passes straight over a siding, or over a track that stops short of it.
				if (connects(dest).exit) {
					deadExit[dest] = true;
				}
				return up ? 'diagonal-up' : 'diagonal';
			}
			hasExitStraight[dest] = true;
			return (dest === exitRow ? 'y-merge' : 'yy-merge') + (up ? '-up' : '');
		};
		// The ladder only starts down from a track that actually reaches it.
		var placeExitPiece = function(source, up) {
			if (connects(source).exit && !reachesLadder(source)) {
				deadExit[source] = true;
				return;
			}
			piece(exitPiece(source, up), exitJunction(source), rowV(source));
		};
		if (yardCount && leads.exit) {
			var joinBoth = exit.top < exitRow && exit.bottom > exitRow && connects(exitRow).exit
				&& reachesLadder(exitRow - 1) && reachesLadder(exitRow + 1);
			for (r = exit.top; r < exitRow; r++) {
				if (!(joinBoth && r === exitRow - 1)) placeExitPiece(r, false);
			}
			for (r = exit.bottom; r > exitRow; r--) {
				if (!(joinBoth && r === exitRow + 1)) placeExitPiece(r, true);
			}
			if (joinBoth) {
				piece('y-merge-both', exitJunction(exitRow) - J, rowV(exitRow));
				hasExitStraight[exitRow] = true;
			}
		}
		// Yard tracks.
		for (r = 1; r <= yardCount; r++) {
			var v = rowV(r);
			var selected = isOn(dataIndex(r));
			var start = rowStart(r);
			var end = connects(r).exit ? exitJunction(r) : rowEnd(r);
			var ends = connects(r);
			// The 10 m of track drawn beyond a buffer stop only fits where it will not run into the ladder crossing
			// this row. A generated stub always has that room; a full-length track closed at one end does not, and
			// its stop goes right at the rail end instead.
			var entryStubRoom = start - (entryJunction(r) + (leads.entry ? J : 0)) >= tile;
			var exitStubRoom = exitJunction(r) - end >= tile * 2;
			if (!ends.entry) {
				if (entryStubRoom) {
					tiles(start - tile, start, v, selected);
					piece('buffer-stop-start', start - tile, v);
				} else {
					piece('buffer-stop-start', start, v);
				}
			} else if (!hasEntryStraight[r]) {
				tiles(entryJunction(r), start, v, selected); // the ladder bends into this track, or the lead runs straight in
			}
			// A merge coming into this track carries its straight over the last junction before its end.
			tiles(start, hasExitStraight[r] && ends.exit ? end - J : end, v, selected);
			if (!ends.exit) {
				if (exitStubRoom) {
					tiles(end, end + tile, v, selected);
					piece('buffer-stop', end + tile, v);
				} else {
					piece('buffer-stop', end, v);
				}
			} else if (deadExit[r]) {
				piece('buffer-stop', end, v); // nothing beyond this track runs far enough to take its merge
			}
			this.packForward(yardGroups[r], start, v, result.cars, dataIndex(r), flipped);
			// A target covers the rail the player can see, not merely the clear section where trains are packed. In
			// particular, the entry switch is often a car-length of visible track before `start`; leaving it out made
			// the left side of a yard feel dead while the exit side clicked right to its rail end.
			result.hits.push({
				trackIndex: dataIndex(r),
				u0: ends.entry ? entryJunction(r) : (entryStubRoom ? start - tile : start),
				u1: ends.exit || !exitStubRoom ? end : end + tile,
				v: v
			});
			// Each label sits beside the junction where its track meets the entry ladder, where no car can cover it,
			// and clear of the rails: to the left of the junction for the entry track and nearer tracks, and further
			// out to the left for tracks up the ladder, whose junctions share one screen row. Putting those above
			// the junction instead laid them across the rails of the track above whenever it was a short one.
			var onUpLadder = leads.entry && r < entryRow;
			var occupied = setup.railyard.getTrackOccupiedLength(trackAt(r)) + (selected ? setup.railyard.getTrainLength(player.train) : 0);
			result.labels.push({
				text: this.getTrackBadge(dataIndex(r)) + ' · ' + setup.units.metres(Math.max(0, trackAt(r).length - occupied))
					+ ' free of ' + setup.units.metres(trackAt(r).length),
				// A stub hung from the exit ladder is labelled beside its own start, not away at the entry ladder.
				u: hangsFromExit(r) ? start - J : entryJunction(r),
				v: v, dx: onUpLadder ? -6 : -this.LABEL_OFFSET_UNITS, dy: onUpLadder ? -11 : 10, anchor: 'end', player: selected
			});
			result.groundSpans.push({
				u0: hangsFromExit(r) ? start - tile : entryJunction(r),
				u1: ends.exit || !exitStubRoom ? end : end + tile, v: v
			});
		}
		// Exit lead: leaves the ladder along the exit track's line and runs off the map.
		if (leads.exit) {
			var exitV = rowV(exitRow);
			var exitStart = yardCount ? exitJunction(exitRow) : 0;
			var exitGroups = groupsAt(exitRow, onwardIndex);
			var exitTrack = tracks[onwardIndex];
			var exitIsStub = !exitTrack.infinite;
			var exitLead = exitIsStub ? roundUp(Math.max(tile, Number(exitTrack.length) || tile))
				: roundUp(Math.max(this.MIN_LEAD_METRES, this.getGroupsLength(exitGroups) + this.LEAD_CLEARANCE_METRES + this.FREE_STUB_METRES));
			tiles(exitStart, exitStart + exitLead - tile, exitV, isOn(onwardIndex));
			if (exitIsStub) piece('buffer-stop', exitStart + exitLead - tile, exitV);
			else piece('fade-out', exitStart + exitLead - tile, exitV);
			if (yardCount && !exit.any) {
				piece('buffer-stop-start', exitStart, exitV); // no yard track connects to the exit
			}
			this.packForward(exitGroups, exitStart + this.LEAD_CLEARANCE_METRES, exitV, result.cars, onwardIndex, flipped);
			result.hits.push({ trackIndex: onwardIndex, u0: exitStart, u1: exitStart + exitLead - tile, v: exitV });
			// The far end of the lead leaves the station: clicking it departs, the way the travel links do.
			if (!exitIsStub) {
				result.hits.push({
					depart: flipped ? 'entry' : 'exit',
					u0: exitStart + exitLead - tile, u1: exitStart + exitLead, v: exitV
				});
			}
			var exitName = setup.railyard.getTrackLabel(tracks, onwardIndex).toUpperCase();
			var exitOccupied = setup.railyard.getTrackOccupiedLength(exitTrack)
				+ (isOn(onwardIndex) ? setup.railyard.getTrainLength(player.train) : 0);
			result.labels.push({ text: exitIsStub ? exitName + ' · ' + setup.units.metres(Math.max(0, exitTrack.length - exitOccupied))
				+ ' free of ' + setup.units.metres(exitTrack.length) : exitName,
				u: exitStart + exitLead, v: exitV, dx: 3, dy: 2, anchor: 'start', player: isOn(onwardIndex) });
		}
		// The station's buildings (setup.stationBuildings) stand in a row behind the farthest track, in from the
		// entry end, with ground under them.
		result.buildings = [];
		var buildingU = J;
		setup.stationBuildings.get(State.variables.currentStation).forEach(function(kind) {
			var name = setup.stationBuildings.KINDS[kind].template, width = self.BUILDING_WIDTH_METRES[kind];
			result.buildings.push({ name: name, u: buildingU, v: -self.BUILDING_OFFSET_UNITS,
				title: setup.stationBuildings.KINDS[kind].name + '.' });
			result.groundSpans.push({ u0: buildingU - 2, u1: buildingU + width + 2, v: -self.BUILDING_OFFSET_UNITS - 12 });
			buildingU += width + self.BUILDING_GAP_METRES;
		});
		// What kind of yard this is (setup.yardTypes), as a landmark at the end of the row: scenery, not another supply
		// container, since the station's stores remain authoritative. A siding has none.
		var yardKind = setup.yardTypes.kindOf(State.variables.currentStation);
		if (yardKind && yardKind !== 'siding') {
			result.buildings.push({ name: 'railyard-kind-' + yardKind, u: buildingU, v: -self.BUILDING_OFFSET_UNITS,
				title: setup.yardTypes.KINDS[yardKind].label.charAt(0).toUpperCase() + setup.yardTypes.KINDS[yardKind].label.slice(1) + '.' });
			result.groundSpans.push({ u0: buildingU - 2, u1: buildingU + (self.KIND_WIDTH_METRES[yardKind] || 40) + 2,
				v: -self.BUILDING_OFFSET_UNITS - 12 });
		}
		result.flipped = flipped;
		return result;
	},
	// How far behind the farthest track the buildings stand, and how much room each takes along it.
	BUILDING_OFFSET_UNITS: 26,
	// How much room each kind of yard's landmark takes along the track (scripts/draw-railyard-templates.py).
	KIND_WIDTH_METRES: { 'passenger-rural': 40, 'passenger-urban': 60, 'railyard-rural': 30, 'railyard-urban': 34, factory: 47,
		farm: 37, port: 58, mine: 56, 'engine-shed': 59, 'oil-terminal': 48, 'timber-yard': 50, scrapyard: 47 },
	BUILDING_WIDTH_METRES: { hq: 17, waterTower: 11, coalTower: 12, dieselTank: 17 },
	BUILDING_GAP_METRES: 5,
	// The view opens at the drawing's own size where that fits, and fitted where it does not, which is most yards on
	// a phone: opening scrolled into a corner of a yard four times the width of the screen tells the player nothing.
	// Fit squeezes a whole yard in. The level lives on setup rather than in the save: it is how the player is
	// looking at the yard, not part of the game.
	getViewportWidth: function() {
		return typeof window === 'undefined' ? 1024 : Math.max(240, (window.innerWidth || 1024) - 60);
	},
	// The largest step that fits the screen, never below half, which is the art at one pixel to one pixel: shrinking
	// a yard to fit a phone makes it unreadable and its tap targets too small to hit, so a big yard is scrolled
	// instead. Fit is still a button away.
	// The view opens fitted: the whole yard on screen is what tells the player where everything is. Zooming in is a
	// button away for reading detail or for a finger-sized target.
	getDefaultZoom: function(naturalWidth) {
		return null;
	},
	getZoom: function(naturalWidth) {
		if (this.zoomLevel === 'fit') {
			return null;
		}
		if (typeof this.zoomLevel === 'number') {
			return this.zoomLevel;
		}
		return this.getDefaultZoom(naturalWidth);
	},
	applyZoom: function(svg, naturalWidth) {
		var zoom = this.getZoom(naturalWidth);
		// Fit fills the width of the view either way: it enlarges a small yard as readily as it shrinks a long one.
		svg.style.maxWidth = 'none';
		svg.style.width = zoom === null ? '100%' : Math.round(naturalWidth * zoom) + 'px';
		svg.style.height = 'auto';
	},
	// The zoom buttons redraw nothing: they resize the drawing that is already on the page.
	createZoomControls: function(svg, naturalWidth, wrapper) {
		var self = this;
		var bar = document.createElement('div');
		bar.className = 'railyard-view-zoom';
		var readout = document.createElement('span');
		var update = function() {
			var zoom = self.getZoom(naturalWidth);
			readout.textContent = zoom === null ? 'Fit' : Math.round(zoom * 100) + '%';
			self.applyZoom(svg, naturalWidth);
		};
		var addButton = function(label, title, onClick) {
			var button = document.createElement('button');
			button.type = 'button';
			button.textContent = label;
			button.title = title;
			button.addEventListener('click', function() {
				onClick();
				update();
			});
			bar.appendChild(button);
			return button;
		};
		var stepFrom = function(direction) {
			var steps = self.ZOOM_STEPS;
			var current = self.getZoom(naturalWidth);
			if (current === null) {
				// Coming out of Fit, step to whichever end the player asked for.
				return direction > 0 ? 1 : steps[0];
			}
			var index = steps.indexOf(current);
			if (index === -1) {
				return direction > 0 ? 1 : steps[0];
			}
			return steps[Math.max(0, Math.min(steps.length - 1, index + direction))];
		};
		addButton('\u2212', 'Zoom out', function() { self.zoomLevel = stepFrom(-1); });
		addButton('+', 'Zoom in', function() { self.zoomLevel = stepFrom(1); });
		addButton('Fit', 'Fit the whole yard to the page', function() { self.zoomLevel = 'fit'; });
		var sizeWideView = function() {
			if (!wrapper.classList.contains('railyard-view-wide')) return;
			wrapper.style.removeProperty('width');
			wrapper.style.removeProperty('margin-left');
			var current = wrapper.getBoundingClientRect();
			var story = document.getElementById('story');
			var storyBox = story ? story.getBoundingClientRect() : current;
			var compact = window.innerWidth <= 700;
			var left = compact ? Math.max(0, current.left) : storyBox.left;
			var right = compact ? window.innerWidth - 12 : storyBox.right;
			if (Math.abs(left - current.left) > 0.5) wrapper.style.marginLeft = (left - current.left) + 'px';
			wrapper.style.width = Math.max(240, right - left) + 'px';
		};
		var wide = addButton('Wide', 'Expand the yard view while keeping the sidebar and passage controls visible', function() {
			wrapper.classList.toggle('railyard-view-wide');
			if (wrapper.classList.contains('railyard-view-wide')) sizeWideView();
			else {
				wrapper.style.removeProperty('width');
				wrapper.style.removeProperty('margin-left');
			}
			wide.setAttribute('aria-pressed', wrapper.classList.contains('railyard-view-wide') ? 'true' : 'false');
			wide.textContent = wrapper.classList.contains('railyard-view-wide') ? 'Close wide view' : 'Wide';
		});
		var resizeWideView = function() {
			if (!wrapper.isConnected) return window.removeEventListener('resize', resizeWideView);
			sizeWideView();
		};
		window.addEventListener('resize', resizeWideView);
		wide.setAttribute('aria-pressed', 'false');
		wrapper.addEventListener('keydown', function(event) {
			if (event.key === 'Escape' && wrapper.classList.contains('railyard-view-wide')) {
				wide.click();
				wide.focus();
			}
		});
		bar.appendChild(readout);
		update();
		return bar;
	},
	// Whether this browser has a pointer that can hover. Asked of the browser rather than guessed from the user
	// agent: a touch screen reports no hover, and gets tap then confirm instead of hover then click.
	hasHover: function() {
		if (typeof window === 'undefined' || !window.matchMedia) {
			return true;
		}
		return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
	},
	// What clicking a target would do: the text links that match it, or the reason there are none. Nothing is
	// decided here; these are the same links the controls below the view are showing.
	actionsFor: function(svg, target) {
		var key = target.getAttribute('data-yard-target');
		var kind = key.slice(0, key.indexOf(':'));
		var suffix = key.slice(kind.length + 1);
		if (kind === 'track' && suffix === svg.getAttribute('data-player-track')) {
			return { links: [], reason: 'Your consist is already on this track.' };
		}
		// Aboard, a parked train can be coupled to or pulled up to; from the station view the only thing to do with
		// one is board it. A train ahead couples to the front and one behind to the rear, so only the valid
		// coupling is ever on the page.
		var wanted = kind === 'train'
			? ['couple-front:' + suffix, 'couple-rear:' + suffix, 'board:' + suffix, 'track:' + suffix.split(':')[0], 'shove:' + suffix.split(':')[0]]
			: kind === 'track' ? [key, 'setout:' + suffix + ':true', 'setout:' + suffix + ':false'] : [key];
		var links = [];
		var reason = '';
		wanted.forEach(function(action) {
			var link = document.querySelector('#passages [data-yard-action="' + action + '"] a');
			if (link) {
				links.push(link);
			}
			if (!reason) {
				var why = document.querySelector('#passages [data-yard-reason="' + action + '"]');
				reason = why ? why.textContent : '';
			}
		});
		return {
			links: links,
			reason: links.length ? '' : (reason || 'Nothing can be done in that spot from where you are standing.')
		};
	},
	// A click on the drawing runs the text action that matches what was clicked. Nothing is decided here either:
	// the link's own rules and time cost apply, and where there is no link the view repeats the reason the text
	// list already gives, so the picture and the list can never disagree about what is possible.
	addClickActions: function(svg, message) {
		var self = this;
		var find = function(event) {
			return event.target && event.target.closest ? event.target.closest('[data-yard-target]') : null;
		};
		var say = function(actions) {
			return actions.links.length
				? actions.links.map(function(link) { return link.textContent; }).join('  or  ')
				: actions.reason;
		};
		// With a mouse, hovering says what a click would do before it does it. A choice already on offer is left
		// alone, so moving the pointer does not wipe the buttons out from under it.
		if (this.hasHover()) {
			svg.addEventListener('mouseover', function(event) {
				var target = find(event);
				if (target && !message.querySelector('button')) {
					message.textContent = say(self.actionsFor(svg, target));
				}
			});
			svg.addEventListener('mouseout', function() {
				if (!message.querySelector('button')) {
					message.textContent = '';
				}
			});
		}
		svg.addEventListener('click', function(event) {
			var target = find(event);
			if (!target) {
				return;
			}
			var actions = self.actionsFor(svg, target);
			self.setActiveTarget(svg, null);
			message.textContent = '';
			if (!actions.links.length) {
				message.textContent = actions.reason;
				return;
			}
			// A touch screen has no hover to explain a move before it happens, so the first tap offers the move and
			// the second one takes it. With a mouse, a single possible move just happens.
			if (actions.links.length === 1 && self.hasHover()) {
				actions.links[0].click();
				return;
			}
			self.showChoice(message, target, actions.links);
		});
	},
	// The choice sits under the drawing rather than over it, so it never hides the yard and reads the same on a
	// phone. Each button runs the text link it was built from, wording and time cost included.
	// Marks the target a choice is about, so a touch screen shows what was tapped while the buttons are up. A tap
	// leaves :hover stuck on the element it hit, so the highlight is a class here rather than a hover style.
	setActiveTarget: function(svg, target) {
		var previous = svg.querySelectorAll('.railyard-hit-active');
		for (var i = 0; i < previous.length; i++) {
			previous[i].classList.remove('railyard-hit-active');
		}
		if (target) {
			target.classList.add('railyard-hit-active');
		}
	},
	showChoice: function(message, target, links) {
		var svg = target.ownerSVGElement || target;
		var self = this;
		this.setActiveTarget(svg, target);
		var title = target.querySelector('title');
		message.textContent = links.length > 1
			? (title ? title.textContent + ': ' : '')
			: (title ? 'Confirm on ' + title.textContent + ': ' : 'Confirm: ');
		links.forEach(function(link, index) {
			if (index) {
				message.appendChild(document.createTextNode(' '));
			}
			var button = document.createElement('button');
			button.type = 'button';
			button.className = 'railyard-view-choice';
			button.textContent = link.textContent;
			button.addEventListener('click', function() {
				self.setActiveTarget(svg, null);
				link.click();
			});
			message.appendChild(button);
		});
		// Somewhere to put a tap that was not meant.
		var cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'railyard-view-choice';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', function() {
			self.setActiveTarget(svg, null);
			message.textContent = '';
		});
		message.appendChild(document.createTextNode(' '));
		message.appendChild(cancel);
	},
	// A compass in the yard's own projection: the lead the player is heading for runs to the bottom right, so the
	// heading it carries points that way and the other three follow it round the ground plane. It turns with the
	// view, so when the yard is drawn from its other end the compass is drawn from there too.
	createCompass: function(tracks, flipped) {
		var ns = this.SVG_NS;
		var order = setup.railyard.HEADINGS;
		var onward = setup.railyard.getLeadDirection(tracks, flipped ? 'entry' : 'exit');
		var first = Math.max(0, order.indexOf(onward));
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'railyard-compass');
		svg.setAttribute('width', '72');
		svg.setAttribute('height', '48');
		svg.setAttribute('viewBox', '-36 -24 72 48');
		var title = document.createElementNS(ns, 'title');
		title.textContent = 'Compass: ' + onward + ' lies to the bottom right';
		svg.appendChild(title);
		// Where the ground axes fall on screen in the 2:1 projection: along a track, and across the tracks.
		[{ x: 24, y: 12 }, { x: -24, y: 12 }, { x: -24, y: -12 }, { x: 24, y: -12 }].forEach(function(arm, index) {
			var isOnward = index === 0;
			var line = document.createElementNS(ns, 'line');
			line.setAttribute('x1', '0');
			line.setAttribute('y1', '0');
			line.setAttribute('x2', String(Math.round(arm.x * 0.55)));
			line.setAttribute('y2', String(Math.round(arm.y * 0.55)));
			line.setAttribute('class', 'railyard-compass-arm' + (isOnward ? ' railyard-compass-onward' : ''));
			svg.appendChild(line);
			var label = document.createElementNS(ns, 'text');
			label.setAttribute('x', String(arm.x));
			label.setAttribute('y', String(arm.y + 3));
			label.setAttribute('text-anchor', 'middle');
			label.setAttribute('class', 'railyard-compass-label' + (isOnward ? ' railyard-compass-onward' : ''));
			// The four arms are the yard's own axes, so they are the compass points 90 degrees apart from the one
			// the line leaves by: north, east, south, west for a northbound yard, or NE, SE, SW, NW for a diagonal.
			label.textContent = setup.railyard.DIRECTION_LETTERS[order[(first + index * 2) % 8]] || '?';
			svg.appendChild(label);
		});
		return svg;
	},
	// Dragging scrolls a zoomed-in yard, which is the only practical way to move around one on a phone.
	addDragToPan: function(wrapper) {
		var dragging = false;
		var startX = 0, startY = 0, startLeft = 0, startTop = 0;
		wrapper.addEventListener('pointerdown', function(event) {
			if (event.button && event.button !== 0) return;
			dragging = true;
			startX = event.clientX;
			startY = event.clientY;
			startLeft = wrapper.scrollLeft;
			startTop = wrapper.scrollTop;
		});
		wrapper.addEventListener('pointermove', function(event) {
			if (!dragging) return;
			var dx = event.clientX - startX;
			var dy = event.clientY - startY;
			if (Math.abs(dx) + Math.abs(dy) > 3) {
				wrapper.scrollLeft = startLeft - dx;
				wrapper.scrollTop = startTop - dy;
				wrapper.classList.add('railyard-view-dragging');
			}
		});
		['pointerup', 'pointercancel', 'pointerleave'].forEach(function(name) {
			wrapper.addEventListener(name, function() {
				dragging = false;
				wrapper.classList.remove('railyard-view-dragging');
			});
		});
	},
	convexHull: function(points) {
		var pts = points.slice().sort(function(a, b) { return a.x - b.x || a.y - b.y; });
		if (pts.length < 3) {
			return pts;
		}
		var cross = function(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
		var lower = [];
		var upper = [];
		for (var i = 0; i < pts.length; i++) {
			while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
			lower.push(pts[i]);
		}
		for (var j = pts.length - 1; j >= 0; j--) {
			while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[j]) <= 0) upper.pop();
			upper.push(pts[j]);
		}
		return lower.slice(0, -1).concat(upper.slice(0, -1));
	},
	render: function(tracks, player) {
		var M = setup.railyardTemplates.unitsPerMetre;
		var layout = this.layout(tracks, player);
		var locale = setup.locales.forStation(State.variables.currentStation);
		var biome = setup.locales.BIOMES[locale.biome];
		var self = this;
		var byDepth = function(a, b) { return a.v - b.v || a.u - b.u; };
		var images = [];
		var marker = null;
		var place = function(name, uMetres, v, title, flat) {
			var template = self.getTemplate(name);
			if (!template) {
				throw new Error('missing rail yard template "' + name + '"');
			}
			var point = self.project(uMetres * M, v);
			var item = { name: name, template: template, left: point.x - template.anchorX, top: point.y - template.anchorY, title: title || '', flat: !!flat };
			images.push(item);
			return item;
		};
		// Paint back to front: all flat track pieces first, then the buildings behind the yard, then cars from the
		// farthest track to the nearest.
		layout.flat.sort(byDepth).forEach(function(piece) {
			place(piece.name, piece.u, piece.v, '', true);
		});
		// Vegetation stays behind the building row: never over a rail, train, or click target.
		var sceneryStation = setup.realWorldPilot.getStation(State.variables.currentStation);
		var sceneryRng = setup.railyard.mulberry32(setup.railyard.seedFromString(
			(State.variables.randomSeed || 'ashline') + ':scenery:' + (sceneryStation ? sceneryStation.id : State.variables.currentStation)));
		var sceneryLength = Math.max(60, Math.min(300, tracks.reduce(function(longest, track) {
			return track.infinite ? longest : Math.max(longest, track.length || 0);
		}, 0)));
		layout.groundSpans.push({ u0: 6, u1: sceneryLength, v: -100 });
		var scenery = [];
		var plants = setup.locales.plants(locale);
		function nextPlant() { return plants[Math.floor(sceneryRng() * plants.length)]; }
		for (var vegetationU = 10; vegetationU < sceneryLength; vegetationU += 12 + Math.floor(sceneryRng() * 14)) {
			scenery.push({ plant: nextPlant(), u: vegetationU, v: -82 - Math.floor(sceneryRng() * 25) });
			if (sceneryRng() < 0.55) scenery.push({ plant: nextPlant(), u: vegetationU + 4, v: -100 });
			scenery.push({ plant: locale.biome === 'tundra' ? 'moss' : locale.biome === 'alpine' ? 'rock' : 'scrub',
				u: vegetationU + 3, v: -59 - Math.floor(sceneryRng() * 16) });
		}
		scenery.sort(byDepth).forEach(function(plant) { place('railyard-plant-' + plant.plant, plant.u, plant.v, biome.name); });
		(layout.buildings || []).forEach(function(building) {
			place(building.name, building.u, building.v, building.title);
		});
		var trainSpans = {};
		layout.cars.sort(byDepth).forEach(function(entry) {
			var name = self.getCarTemplateName(entry.car, layout.flipped);
			var title = setup.railyard.getCarDescription(entry.car) + '. ' + entry.car.length + ' m long'
				+ (entry.isPlayer ? '. Your consist.' : '.');
			// Once a train has been boarded its load is known; expose that same information on the car under the pointer.
			// Unvisited trains remain unknown rather than leaking their cargo through the drawing.
			if (entry.car.visited) {
				var cargo = Array.isArray(entry.car.cargo) ? entry.car.cargo : [];
				title += cargo.length
					? ' Contents: ' + cargo.map(function(load) { return load.type + ' ' + load.amount; }).join(', ') + '.'
					: ' Empty.';
			}
			var item = place(name, entry.u, entry.v, title);
			// A parked train's click target is the stretch of its own track that its cars stand on, measured along
			// the rails. A box around them on screen would be a huge upright rectangle over a drawing where nothing
			// is upright, and would cover the tracks in front of and behind the train as well.
			if (!entry.isPlayer && typeof entry.trainIndex === 'number') {
				var spanKey = entry.trackIndex + ':' + entry.trainIndex;
				var span = trainSpans[spanKey] || (trainSpans[spanKey] = {
					trackIndex: entry.trackIndex, v: entry.v, u0: Infinity, u1: -Infinity
				});
				span.u0 = Math.min(span.u0, entry.u);
				span.u1 = Math.max(span.u1, entry.u + (Number(entry.car.length) || 0));
			}
			if (entry.isPlayer && player && entry.carIndex === player.carIndex) {
				// The car the player is in is the one with a lamp lit in it, drawn from its own definition so its
				// windows keep their glow while every other cab stays dark.
				item.lit = setup.items.isLocomotive(entry.car) && !entry.car.broken && !State.variables.onFoot;
				if (item.template.top) {
					marker = { x: item.left + item.template.top[0], y: item.top + item.template.top[1] };
				}
			}
		});
		var labels = layout.labels.map(function(label) {
			var point = self.project(label.u * M, label.v);
			return { text: label.text, x: point.x + label.dx, y: point.y + label.dy, anchor: label.anchor, player: label.player };
		});
		// The ground is the convex hull of every yard track's span, widened to either side of the track.
		var H = this.GROUND_HALF_WIDTH_UNITS;
		var groundPoints = [];
		layout.groundSpans.forEach(function(span) {
			[span.u0 * M, span.u1 * M].forEach(function(u) {
				groundPoints.push(self.project(u, span.v - H), self.project(u, span.v + H));
			});
		});
		// Horizontal ladders extend outside the ground envelope of the parallel roads. Give them the same
		// shoulder width, measured perpendicular to their own direction, before forming the yard's outline.
		layout.flat.forEach(function(piece) {
			if (!/-up$|-both$/.test(piece.name)) return;
			var spacing = setup.railyardTemplates.trackSpacingUnits;
			var v = piece.v + (piece.name === 'railyard-track-y-merge-both' ? spacing : 0);
			var start = self.project(piece.u * M, v);
			var end = self.project((piece.u + setup.railyardTemplates.junctionMetres) * M, v - spacing);
			var shoulder = H / Math.sqrt(2);
			[start, end].forEach(function(point) {
				groundPoints.push({ x: point.x, y: point.y - shoulder }, { x: point.x, y: point.y + shoulder });
			});
		});
		var grounds = groundPoints.length >= 3 ? [this.convexHull(groundPoints)] : [];
		// Size the drawing to fit the ground, every image, and every label.
		var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		var extend = function(x0, y0, x1, y1) {
			minX = Math.min(minX, x0); minY = Math.min(minY, y0);
			maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
		};
		grounds.forEach(function(shape) { shape.forEach(function(p) { extend(p.x, p.y, p.x, p.y); }); });
		images.forEach(function(item) { extend(item.left, item.top, item.left + item.template.width, item.top + item.template.height); });
		labels.forEach(function(label) {
			var width = label.text.length * 3.6; // approximate advance of the 6px monospace label font
			var x0 = label.anchor === 'end' ? label.x - width : label.x;
			extend(x0, label.y - 6, x0 + width, label.y + 2);
		});
		minX = Math.floor(minX - this.PADDING);
		minY = Math.floor(minY - this.PADDING);
		var width = Math.ceil(maxX + this.PADDING) - minX;
		var height = Math.ceil(maxY + this.PADDING) - minY;
		var ns = this.SVG_NS;
		var svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('class', 'railyard-view');
		svg.setAttribute('viewBox', [minX, minY, width, height].join(' '));
		svg.setAttribute('width', width * this.SCALE);
		svg.setAttribute('height', height * this.SCALE);
		svg.setAttribute('shape-rendering', 'crispEdges');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Rail yard: ' + tracks.length + ' tracks, ' + layout.trainCount + ' train' + (layout.trainCount === 1 ? '' : 's'));
		// The light of the time of day grades every colour in the drawing; lit windows keep their glow.
		var light = setup.daylight.getLight();
		var graded = setup.daylight.isGraded(light);
		var grader = graded ? setup.daylight.createGrader(light, 'subject') : null;
		var litGrader = graded ? setup.daylight.createGrader(light, 'subject', true) : null;
		svg.setAttribute('data-light', light.phase);
		svg.setAttribute('data-biome', locale.biome);
		svg.setAttribute('data-industry', locale.industry);
		svg.setAttribute('aria-label', svg.getAttribute('aria-label') + '; ' + biome.name
			+ '; ' + setup.locales.INDUSTRIES[locale.industry].name);
		grounds.forEach(function(shape) {
			var groundShape = document.createElementNS(ns, 'polygon');
			groundShape.setAttribute('class', 'railyard-ground');
			groundShape.style.fill = grader ? grader(biome.ground) : biome.ground;
			groundShape.setAttribute('points', shape.map(function(p) { return p.x + ',' + p.y; }).join(' '));
			svg.appendChild(groundShape);
		});
		// Every template is drawn inline from one shared definition, so the whole yard is a single vector
		// drawing that snaps to pixels together. Separate <image> elements each snapped on their own,
		// which doubled rails and left seams where pieces meet whenever the view was scaled.
		var defs = document.createElementNS(ns, 'defs');
		svg.appendChild(defs);
		this.renderCount = (this.renderCount || 0) + 1;
		var idPrefix = 'railyard-view-' + this.renderCount + '-';
		var hasRails = {};
		var layers = {};
		images.forEach(function(item) {
			if (item.name in hasRails) {
				return;
			}
			var groups = self.createTemplateGroups(item.name, idPrefix + item.name);
			groups.all.querySelectorAll('[fill="#dec38a"]').forEach(function(window) { window.setAttribute('fill', '#273c3e'); });
			if (grader) {
				['all', 'bed', 'branch', 'ladder', 'rails'].forEach(function(key) {
					setup.daylight.applyToElement(groups[key], grader);
				});
			}
			defs.appendChild(groups.all);
			layers[item.name] = {
				branch: groups.branch.childNodes.length > 0,
				ladder: groups.ladder.childNodes.length > 0,
				rails: groups.rails.childNodes.length > 0
			};
			hasRails[item.name] = layers[item.name].branch || layers[item.name].ladder || layers[item.name].rails;
			if (hasRails[item.name]) {
				defs.appendChild(groups.bed);
				if (layers[item.name].branch) defs.appendChild(groups.branch);
				if (layers[item.name].ladder) defs.appendChild(groups.ladder);
				if (layers[item.name].rails) defs.appendChild(groups.rails);
			}
		});
		images.filter(function(item) { return item.lit; }).forEach(function(item) {
			if (defs.querySelector('#' + idPrefix + item.name + '-lit')) {
				return;
			}
			var litGroups = self.createTemplateGroups(item.name, idPrefix + item.name + '-lit');
			if (litGrader) {
				setup.daylight.applyToElement(litGroups.all, litGrader);
			}
			defs.appendChild(litGroups.all);
		});
		var addUse = function(item, suffix, tagged) {
			var use = document.createElementNS(ns, 'use');
			var href = '#' + idPrefix + item.name + suffix;
			use.setAttribute('href', href);
			use.setAttributeNS(self.XLINK_NS, 'xlink:href', href);
			use.setAttribute('x', item.left);
			use.setAttribute('y', item.top);
			if (!tagged) {
				use.setAttribute('data-layer', suffix.slice(1));
			} else {
				use.setAttribute('data-template', item.name);
				if (item.title) {
					var title = document.createElementNS(ns, 'title');
					title.textContent = item.title;
					use.appendChild(title);
				}
			}
			svg.appendChild(use);
		};
		// Paint in layers: every track bed, then YY branch rails, then ladder rails, then straight rails, then
		// objects on the track and cars. Wherever two rails join, the through rail is painted later and covers
		// the joint: the ladder over a YY branch, and a straight track over a ladder's ends. Each piece
		// is drawn inline from one shared definition, so the yard is a single vector drawing. Painting a
		// piece's bed after the previous piece's rails would clip the end of those rails at every join.
		var trackPieces = images.filter(function(item) { return item.flat && hasRails[item.name]; });
		// Switch and ladder beds go before plain tiles: where a ladder's bed reaches into a tile, the tile's
		// ballast and ties cover it, and ladder pieces still join each other along their full width.
		var isTile = function(item) { return /^railyard-track-(tile|fade)/.test(item.name); };
		trackPieces.filter(function(item) { return !isTile(item); }).forEach(function(item) { addUse(item, '-bed', true); });
		trackPieces.filter(isTile).forEach(function(item) { addUse(item, '-bed', true); });
		trackPieces.forEach(function(item) { if (layers[item.name].branch) addUse(item, '-branch', false); });
		trackPieces.forEach(function(item) { if (layers[item.name].ladder) addUse(item, '-ladder', false); });
		trackPieces.forEach(function(item) { if (layers[item.name].rails) addUse(item, '-rails', false); });
		var tutorialLayer = document.createElementNS(ns, 'g');
		tutorialLayer.setAttribute('class', 'tutorial-ground');
		tutorialLayer.setAttribute('pointer-events', 'none');
		svg.appendChild(tutorialLayer);
		images.forEach(function(item) {
			if (!(item.flat && hasRails[item.name])) {
				addUse(item, item.lit ? '-lit' : '', true);
			}
		});
		labels.forEach(function(label) {
			// A plate behind the text, because a label up the ladder has to sit over its own rails: the junctions
			// there share one screen row, and there is no clear ground between the tracks to put it on.
			var width = label.text.length * 3.6;
			var plate = document.createElementNS(ns, 'rect');
			plate.setAttribute('class', 'railyard-label-plate');
			plate.setAttribute('x', (label.anchor === 'end' ? label.x - width : label.x) - 1);
			plate.setAttribute('y', label.y - 6);
			plate.setAttribute('width', width + 2);
			plate.setAttribute('height', 8);
			svg.appendChild(plate);
			var text = document.createElementNS(ns, 'text');
			text.setAttribute('class', 'railyard-label' + (label.player ? ' railyard-label-player' : ''));
			text.setAttribute('x', label.x);
			text.setAttribute('y', label.y);
			text.setAttribute('text-anchor', label.anchor);
			text.textContent = label.text;
			svg.appendChild(text);
		});
		if (marker) {
			var arrow = document.createElementNS(ns, 'polygon');
			arrow.setAttribute('class', 'railyard-player-marker');
			arrow.setAttribute('points', [(marker.x - 3) + ',' + (marker.y - 8), (marker.x + 3) + ',' + (marker.y - 8), marker.x + ',' + (marker.y - 4)].join(' '));
			var arrowTitle = document.createElementNS(ns, 'title');
			arrowTitle.textContent = 'You are here';
			arrow.appendChild(arrowTitle);
			svg.appendChild(arrow);
		}
		// The drawing scrolls inside its own box, while the zoom controls sit on the frame around it, so they stay
		// in the corner of the view rather than sliding away with the yard.
		// Click targets, drawn last so they sit on top. Track bands only appear while the player is aboard, which
		// is when there is a consist to move; parked trains are clickable either way, to couple to one while driving
		// or to board one from the station view.
		var hitLayer = document.createElementNS(ns, 'g');
		hitLayer.setAttribute('class', 'railyard-hits' + (State.variables.showYardTargets ? ' railyard-hits-shown' : ''));
		if (player) {
			// Track bands are generous, since reaching for a track is the common move. The way out of the station is
			// a small box at the very tip of the lead, so it is hard to hit by accident.
			layout.hits.forEach(function(hit) {
				var halfBand = hit.depart ? 8 : self.TRACK_HIT_HALF_BAND;
				var corners = [self.project(hit.u0 * M, hit.v - halfBand), self.project(hit.u1 * M, hit.v - halfBand),
					self.project(hit.u1 * M, hit.v + halfBand), self.project(hit.u0 * M, hit.v + halfBand)];
				var band = document.createElementNS(ns, 'polygon');
				band.setAttribute('points', corners.map(function(point) { return point.x + ',' + point.y; }).join(' '));
				band.setAttribute('class', 'railyard-hit' + (hit.depart ? ' railyard-hit-depart' : ''));
				band.setAttribute('data-yard-target', hit.depart ? 'depart:' + hit.depart : 'track:' + hit.trackIndex);
				setup.tutorial.markTarget(band);
				var bandTitle = document.createElementNS(ns, 'title');
				bandTitle.textContent = hit.depart
					? 'Leave the station this way'
					: setup.railyard.getTrackLabel(tracks, hit.trackIndex);
				band.appendChild(bandTitle);
				hitLayer.appendChild(band);
			});
			svg.setAttribute('data-player-track', player.trackIndex);
		}
		Object.keys(trainSpans).forEach(function(spanKey) {
			var span = trainSpans[spanKey];
			var half = self.TRAIN_HIT_HALF_BAND;
			var corners = [self.project(span.u0 * M, span.v - half), self.project(span.u1 * M, span.v - half),
				self.project(span.u1 * M, span.v + half), self.project(span.u0 * M, span.v + half)];
			var area = document.createElementNS(ns, 'polygon');
			area.setAttribute('points', corners.map(function(point) { return point.x + ',' + point.y; }).join(' '));
			area.setAttribute('class', 'railyard-hit railyard-hit-train');
			area.setAttribute('data-yard-target', 'train:' + spanKey);
			setup.tutorial.markTarget(area);
			var areaTitle = document.createElementNS(ns, 'title');
			var visitingOnFoot = setup.onfoot && setup.onfoot.isInRailyard();
			areaTitle.textContent = (player || visitingOnFoot ? 'Parked train on ' : 'Board the train on ')
				+ setup.railyard.getTrackLabel(tracks, span.trackIndex);
			area.appendChild(areaTitle);
			hitLayer.appendChild(area);
		});
		svg.appendChild(hitLayer);
		hitLayer.querySelectorAll('.tutorial-next-target').forEach(function(target) {
			var ground = target.cloneNode(false);
			ground.removeAttribute('data-yard-target');
			ground.setAttribute('class', 'tutorial-next-target');
			tutorialLayer.appendChild(ground);
			target.classList.remove('tutorial-next-target');
		});
		var wrapper = document.createElement('div');
		wrapper.className = 'railyard-view-wrapper';
		var scroll = document.createElement('div');
		scroll.className = 'railyard-view-scroll';
		scroll.appendChild(svg);
		// A yard wider than the screen opens on the player's own consist, or on the first train parked here, rather
		// than on whichever end of the yard happens to be at x = 0. Done once the box has been laid out.
		var focusX = marker ? marker.x : null;
		if (focusX === null) {
			var firstSpan = Object.keys(trainSpans).map(function(key) { return trainSpans[key]; })
				.sort(function(a, b) { return a.u0 - b.u0; })[0];
			focusX = firstSpan ? self.project((firstSpan.u0 + firstSpan.u1) / 2 * M, firstSpan.v).x : null;
		}
		if (focusX !== null && typeof requestAnimationFrame === 'function') {
			var fraction = (focusX - minX) / width;
			requestAnimationFrame(function() {
				if (scroll.scrollWidth > scroll.clientWidth) {
					scroll.scrollLeft = Math.max(0, fraction * scroll.scrollWidth - scroll.clientWidth / 2);
				}
			});
		}
		wrapper.appendChild(this.createZoomControls(svg, width * this.SCALE, wrapper));
		wrapper.appendChild(scroll);
		wrapper.appendChild(this.createCompass(tracks, layout.flipped));
		this.addDragToPan(scroll);
		var message = document.createElement('div');
		message.className = 'railyard-view-message';
		wrapper.appendChild(message);
		this.addClickActions(svg, message);
		return wrapper;
	}
};
// Draws the current station's rail yard. Reads game state only; it never changes it.
Macro.add('railyardView', {
	handler: function() {
		var variables = State.variables;
		var tracks = variables.stationTracks ? variables.stationTracks[variables.currentStation] : null;
		if (!Array.isArray(tracks) || tracks.length < 2 || typeof setup.railyardTemplates === 'undefined') {
			return;
		}
		// While the player is aboard a train, it is held outside the track arrays at a gap position.
		var player = null;
		var trackIndex = parseInt(variables.drivingTrackIndex, 10);
		if (Array.isArray(variables.currentTrain) && variables.currentTrain.length && !isNaN(trackIndex)
			&& !(setup.onfoot && setup.onfoot.isInRailyard())) {
			trackIndex = Math.max(0, Math.min(trackIndex, tracks.length - 1));
			var trackTrains = Array.isArray(tracks[trackIndex].trains) ? tracks[trackIndex].trains : [];
			var gapIndex = parseInt(variables.enteredTrainIndex, 10);
			if (isNaN(gapIndex)) {
				gapIndex = setup.railyard.getDefaultEnteredTrainIndex(tracks, trackIndex);
			}
			player = {
				trackIndex: trackIndex,
				gapIndex: Math.max(0, Math.min(gapIndex, trackTrains.length)),
				train: variables.currentTrain,
				carIndex: parseInt(variables.currentCarIndex, 10)
			};
		}
		try {
			this.output.appendChild(setup.railyardView.render(tracks, player));
		} catch (error) {
			return this.error('could not draw the rail yard: ' + error.message);
		}
	}
});
