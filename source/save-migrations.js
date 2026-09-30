// Schema versions describe stored data, independently of the public release number.
// All upgrades run on a detached copy; failed upgrades never modify a slot/file or
// replace the live run. Add the next numbered step instead of rewriting old steps.
setup.saveMigrations = {
	CURRENT: 5,
	notice: '',
	recovery: null,
	copy: function(value) { return JSON.parse(JSON.stringify(value)); },
	object: function(value) { return value && typeof value === 'object' && !Array.isArray(value); },
	// release: the lastPlayedReleaseVersion the newer game stamped into the save, which is the release to name.
	checkVersion: function(version, release) {
		if (version === undefined) return 0;
		if (!Number.isInteger(version) || version < 0) throw new Error('Invalid save schema version.');
		if (version > this.CURRENT) throw new Error('This save is for a newer version of Ashline. Please start a new game to play in this version, or play in '
			+ (typeof release === 'string' && /^\d+(\.\d+)*$/.test(release) ? 'v' + release : 'the version it was saved in')
			+ ' or newer to continue the saved game.');
		return version;
	},
	upgradeState: function(source, envelopeVersion) {
		var latest = this.object(source) && Array.isArray(source.history) && source.history[source.index];
		this.checkVersion(envelopeVersion, latest && this.object(latest.variables) ? latest.variables.lastPlayedReleaseVersion : undefined);
		if (!this.object(source) || !Array.isArray(source.history) || !source.history.length
			|| !Number.isInteger(source.index) || source.index < 0 || source.index >= source.history.length)
			throw new Error('Invalid save history.');
		var self = this, state = this.copy(source), upgraded = false, relocated = false, repaired = false;
		state.history.forEach(function(moment) {
			if (!self.object(moment) || !self.object(moment.variables)) throw new Error('Invalid save history.');
			var v = moment.variables, version = self.checkVersion(v.saveSchemaVersion, v.lastPlayedReleaseVersion);
			if (envelopeVersion !== undefined && version !== envelopeVersion)
				throw new Error('The save schema markers disagree.');
			// StoryInit used to be an ordinary introduction. It must never run the new-game initializer on load.
			if (moment.title === 'StoryInit') moment.title = 'Introduction';
			while (version < self.CURRENT) {
				self.steps[version](moment);
				v.saveSchemaVersion = ++version;
				upgraded = true;
			}
			if (!v.worldIdentity) { v.worldIdentity=self.anchorFor(v); upgraded=true; }
			if (self.relocateMoment(moment)) { upgraded = true; relocated = true; }
			if (self.repairPosition(moment)) repaired = true;
		});
		setup.saves.validateState(state);
		if (upgraded) {
			// Persist acknowledgement in history too, otherwise refreshing a converted
			// session restores the old checksum and wrongly asks for a new game.
			var checksum = setup.getBuildChecksum();
			state.history.forEach(function(moment) {
				moment.variables.lastPlayedBuildChecksum = checksum;
				moment.variables.lastPlayedReleaseVersion = setup.releaseVersion;
				moment.variables.pendingBuildNotice = '';
			});
		}
		return { state: state, upgraded: upgraded, relocated: relocated, repaired: repaired };
	},
	// Schema 0 includes the public 0.1.0 release and unversioned 0.2.0 development saves.
	upgradeUnversioned: function(moment) {
		var v = moment.variables, self = this;
		if (!this.object(v.player) || !this.object(v.stationTracks)) throw new Error('The save is incomplete.');
		var p = v.player;
		var legacy = Object.prototype.hasOwnProperty.call(p, 'physicalDamage')
			|| Object.prototype.hasOwnProperty.call(p, 'mentalHealth');
		if (v.lastPlayedReleaseVersion && !/^0\.[12]\.0$/.test(v.lastPlayedReleaseVersion))
			throw new Error('This unversioned save is from an unsupported release.');
		if (legacy) {
			function stat(key) {
				if (typeof p[key] !== 'number' || !isFinite(p[key])) throw new Error('Invalid legacy player data.');
				return Math.max(0, Math.min(100, p[key]));
			}
			p.health = 100 - stat('physicalDamage');
			p.sanity = stat('mentalHealth');
			p.hunger = 100 - stat('hunger'); p.thirst = 100 - stat('thirst');
			delete p.physicalDamage; delete p.mentalHealth;
			if (['Railyard', 'TrainInterior', 'DrivingMode'].indexOf(moment.title) >= 0) {
				if (!v.stationTracks[v.currentStation]) v.stationTracks[v.currentStation] = setup.saveLegacy010.station(v);
				v.tutorialDone = true; // the old three-track yard is not the new shunting tutorial
			}
		}
		var defaults = { use24HourTime: false, dateFormat: 'long', imperialUnits: false, showYardTargets: false,
			autosaveOnSleep: true, preserveScroll: true, enableHistoryControls: false, travellingForward: true,
			gameTimeTimestampMs: setup.time.startTimestampMs, debugSelectedTrackIndex: 0,
			debugSelectedTrainIndex: 0, debugSelectedCarIndex: -1 };
		Object.keys(defaults).forEach(function(key) { if (v[key] === undefined) v[key] = defaults[key]; });
		if (p.carried === undefined) p.carried = [];
		if (p.carriedCargo === undefined) p.carriedCargo = [];
		if (p.carry === undefined) p.carry = {};
		delete v.settingsMode;
		if (v.settingsExitPassage === 'StoryInit') v.settingsExitPassage = 'Introduction';
		v.trains = []; delete v.currentCar;
		// A parked currentTrain is an obsolete alias, not another owned train.
		if (moment.title === 'Railyard') v.currentTrain = null;
		var kitCandidates = [];
		function upgradeTrain(train, visited, nearby) {
			if (train == null) return;
			if (!Array.isArray(train)) throw new Error('Invalid train data.');
			train.forEach(function(car) {
				if (!self.object(car)) throw new Error('Invalid train data.');
				if (visited) car.visited = true;
				if (!legacy) return;
				if (car.facing === undefined) car.facing = 1;
				if (car.type !== 'steam loco' && car.type !== 'diesel loco') return;
				var template = setup.currentDefinitions.defaultTrains[car.type === 'steam loco' ? 'steamShunter' : 'dieselShunter'];
				// Approved conversion: new shunter specs, preserving cargo and expanding
				// storage only as far as needed to retain an existing oversized load.
				Object.keys(template).forEach(function(key) { if (key !== 'cargo') car[key] = self.copy(template[key]); });
				delete car.fuelConsumption;
				var volume = 0, weight = 0;
				if (!Array.isArray(car.cargo)) throw new Error('Invalid locomotive cargo.');
				car.cargo.forEach(function(stack) {
					if (!self.object(stack) || typeof stack.amount !== 'number' || !isFinite(stack.amount) || stack.amount < 0)
						throw new Error('Invalid locomotive cargo.');
					volume += stack.amount;
					weight += stack.amount * (v.cargoTypes[stack.type] ? v.cargoTypes[stack.type].density : 1);
				});
				car.maxCargoCapacityVolume = Math.max(car.maxCargoCapacityVolume, volume);
				car.maxCargoCapacityKg = Math.max(car.maxCargoCapacityKg, weight);
				if (car.inventory === undefined) car.inventory = [];
				if (nearby && !car.broken && car.inventory.length === 0) kitCandidates.push(car);
			});
		}
		upgradeTrain(v.currentTrain, true, true);
		upgradeTrain(v.leavingTrain, true, true);
		Object.keys(v.stationTracks).forEach(function(station) {
			var tracks = v.stationTracks[station];
			if (!Array.isArray(tracks)) throw new Error('Invalid station data.');
			tracks.forEach(function(track) {
				if (!self.object(track) || !Array.isArray(track.trains)) throw new Error('Invalid station data.');
				track.trains.forEach(function(train) { upgradeTrain(train, !!train.visited, String(v.currentStation) === station); });
			});
		});
		// Old runs predate tools, food and sleep. Give one accessible engine the starter
		// kit once, without refilling fuel or altering any already-existing inventory.
		if (legacy && kitCandidates.length) kitCandidates[0].inventory = setup.items.createStartingKit();
		if (v.currentTrain && v.currentTrain.length && (!Number.isInteger(v.currentCarIndex)
			|| v.currentCarIndex < 0 || v.currentCarIndex >= v.currentTrain.length))
			v.currentCarIndex = setup.railyard.getBoardingCarIndex(v.currentTrain);
		v.defaultTrains = this.copy(setup.currentDefinitions.defaultTrains);
		v.cargoTypes = Object.assign({}, v.cargoTypes, this.copy(setup.currentDefinitions.cargoTypes));
	},
	// Schema 2 removes the seeded fictional world. Keep every train and yard, but translate any active position
	// onto the sourced Padre Hurtado–Melipilla grid so an old station or branch cannot strand the player.
	upgradeSourcedWorld: function(moment) {
		var v = moment.variables;
		var route = setup.realWorldPilot && setup.realWorldPilot.getGridRoute
			? setup.realWorldPilot.getGridRoute() : null;
		if (!route || !route.legs || !route.corridor || !route.corridor.stations.length)
			throw new Error('The sourced world is unavailable.');
		function targetAt(position) {
			var globalIndex = Math.max(0, Math.min(Math.floor(Number(position) || 0), route.tiles.length - 1));
			var legIndex = 1;
			while (route.legs[legIndex] && globalIndex > route.legs[legIndex].endPosition) legIndex++;
			if (!route.legs[legIndex]) legIndex = route.corridor.stations.length - 1;
			var leg = route.legs[legIndex];
			return { legIndex: legIndex,
				tileIndex: Math.max(0, Math.min(globalIndex - leg.startPosition, leg.tiles.length - 1)), forward: true };
		}
		var journey = v.journey;
		if (v.realWorldJourney) {
			journey = targetAt(v.realWorldJourney.position);
		} else if (journey && journey.realWorldCorridorId) {
			journey = targetAt(journey.tileIndex);
		} else if (journey && Number.isInteger(journey.legIndex) && route.legs[journey.legIndex]) {
			var leg = route.legs[journey.legIndex];
			journey = { legIndex: journey.legIndex,
				tileIndex: Math.max(0, Math.min(Math.floor(Number(journey.tileIndex) || 0), leg.tiles.length - 1)),
				forward: journey.forward !== false };
		} else if (journey) {
			journey = null;
			v.currentStation = 1;
		}
		v.journey = journey || null;
		v.realWorldJourney = null;
		if (!Number.isInteger(v.currentStation) || v.currentStation < 1
			|| v.currentStation > route.corridor.stations.length)
			v.currentStation = 1;
		if (v.onFoot) {
			if (!v.journey) v.onFoot = null;
			else v.onFoot = { legIndex: v.journey.legIndex,
				tileIndex: Math.max(0, Math.min(Math.floor(Number(v.onFoot.tileIndex) || 0),
					route.legs[v.journey.legIndex].tiles.length - 1)), branch: null };
		}
		if (moment.title === 'WorldPilot') moment.title = v.journey ? 'OnTheLine' : 'TrainInterior';
		if ((moment.title === 'OnTheLine' || moment.title === 'OnFoot') && !v.journey)
			moment.title = Array.isArray(v.currentTrain) && v.currentTrain.length ? 'TrainInterior' : 'Railyard';
	},
	steps: {},
	// Station UUIDs and grid coordinates are the save identity. Numeric station/leg indexes
	// are only lookup indexes for this particular compiled network.
	anchorFor: function(v) {
		var route=setup.realWorldPilot.getGridRoute(), stations=route.corridor.stations;
		// A yard that is not a station's is named by its square, which is its identity.
		var station=function(index) {
			if(!setup.yards.isStation(index)) {
				var yard=setup.yards.tile(index);
				return yard ? {siding:index,x:yard.x,y:yard.y,coordinate:yard.geoCoordinate} : null;
			}
			var item=stations[Number(index)-1], tile=item && route.tiles[item.square];
			return item && tile ? {uuid:item.uuid,coordinate:tile.geoCoordinate} : null;
		};
		var tile=function(position) {
			var leg=position && route.legs[position.legIndex], item=leg && leg.tiles[position.tileIndex];
			return item ? {x:item.x,y:item.y,coordinate:item.geoCoordinate} : null;
		};
		var yards={};Object.keys(v.stationTracks||{}).forEach(function(key){var found=station(key);if(found) yards[key]=found;});
		return {revision:setup.worldGraphData.networkRevision,station:station(v.currentStation),yards:yards,
			journey:tile(v.journey),onFoot:tile(v.onFoot)};
	},
	stampState: function(state) {
		if(state && Array.isArray(state.history)) state.history.forEach(function(moment){
			if(moment && moment.variables && moment.variables.saveSchemaVersion===5)
				moment.variables.worldIdentity=setup.saveMigrations.anchorFor(moment.variables);
		});
	},
	// No released save has the world map with a bad station number or coordinates, so one is tampering or our bug:
	// it goes to Punta Arenas. A real point on the globe with no tile under it goes to the nearest yard (Likea, 2026-09-29).
	START_STATION: 'place:cl-punta-arenas',
	startStation: function(route) {
		var self=this, index=route.corridor.stations.findIndex(function(item){return item.id===self.START_STATION;});
		return index+1 || 1;
	},
	validCoordinate: function(coordinate) {
		return Array.isArray(coordinate)&&coordinate.length===2&&coordinate.every(function(x){return typeof x==='number'&&isFinite(x);})
			&&Math.abs(coordinate[0])<=180&&Math.abs(coordinate[1])<=90;
	},
	validStation: function(station,route) {
		return Number.isInteger(station)&&station>=1&&station<=route.corridor.stations.length;
	},
	// Any yard: a station by its number, or another kind by its id (setup.yards).
	validYard: function(id,route) {
		return this.validStation(id,route)||(typeof id==='string'&&!setup.yards.isStation(id)&&setup.yards.exists(id));
	},
	// A key of $stationTracks: a station's number as written by JavaScript, or another yard's id.
	validYardKey: function(key,route) {
		return setup.yards.isStation(key) ? this.validStation(Number(key),route)&&String(Number(key))===key : this.validYard(key,route);
	},
	// A train left on the line: whole, on a real position, filed under that position's square.
	validLineTrain: function(key,entry,route) {
		if(!this.object(entry)||!Array.isArray(entry.train)||!entry.train.length||!this.validTile(entry,route)) return false;
		var tile=route.legs[entry.legIndex].tiles[entry.tileIndex];
		return tile.x===entry.x&&tile.y===entry.y&&key===tile.x+','+tile.y;
	},
	validTile: function(position,route) {
		var leg=this.object(position)&&Number.isInteger(position.legIndex)&&route.legs[position.legIndex];
		// A branch position indexes the branch's own tiles, so only its leg can be checked here.
		return !!leg&&Number.isInteger(position.tileIndex)&&position.tileIndex>=0
			&&(!!position.branch||position.tileIndex<leg.tiles.length);
	},
	positionValid: function(v) {
		var route=setup.realWorldPilot.getGridRoute(), self=this;
		return this.validYard(v.currentStation,route)&&(v.enteredStation==null||this.validYard(v.enteredStation,route))
			&&(!v.journey||this.validTile(v.journey,route))&&(!v.onFoot||this.validTile(v.onFoot,route))
			&&Object.keys(v.stationTracks||{}).every(function(key){return self.validYardKey(key,route);})
			&&Object.keys(v.lineTrains||{}).every(function(key){return self.validLineTrain(key,v.lineTrains[key],route);});
	},
	// Leave the line and stand at a station, with the consist if the player is aboard it.
	moveToStation: function(moment,station) {
		var v=moment.variables;
		v.journey=null;v.onFoot=null;v.currentStation=station;v.enteredStation=station;
		delete v.enteredTrackIndex;delete v.enteredTrainIndex;
		if(v.leavingTrain && !(v.currentTrain && v.currentTrain.length)) {v.currentTrain=v.leavingTrain;v.leavingTrain=null;}
		if(['OnTheLine','OnFoot','DrivingMode','Railyard'].indexOf(moment.title)>=0)
			moment.title=Array.isArray(v.currentTrain)&&v.currentTrain.length?'TrainInterior':'Railyard';
	},
	repairPosition: function(moment) {
		var v=moment.variables;
		if(this.positionValid(v)) return false;
		var route=setup.realWorldPilot.getGridRoute(), self=this, identity=this.object(v.worldIdentity)?v.worldIdentity:{};
		if(!this.validYard(v.currentStation,route)) {
			// A siding's id names a square: if that square is a real place, the nearest station to it.
			var named=setup.yards.parse(v.currentStation), square=named&&named.kind==='siding'&&route.byKey[named.x+','+named.y];
			this.moveToStation(moment,square?this.nearestStation(square.geoCoordinate,route):this.startStation(route));
		} else if((v.journey&&!this.validTile(v.journey,route))||(v.onFoot&&!this.validTile(v.onFoot,route))) {
			var anchor=v.onFoot&&identity.onFoot||identity.journey;
			this.moveToStation(moment,this.nearestStation(anchor&&anchor.coordinate,route));
		}
		if(v.enteredStation!=null&&!this.validYard(v.enteredStation,route)) {
			v.enteredStation=v.currentStation;delete v.enteredTrackIndex;delete v.enteredTrainIndex;
		}
		// Keep the stock of a yard filed under a bad station number, as removed yards are kept.
		v.orphanedStationYards=v.orphanedStationYards||{};
		Object.keys(v.stationTracks||{}).forEach(function(key){
			if(self.validYardKey(key,route)) return;
			v.orphanedStationYards['invalid:'+key]=v.stationTracks[key];delete v.stationTracks[key];
		});
		Object.keys(v.lineTrains||{}).forEach(function(key){
			if(self.validLineTrain(key,v.lineTrains[key],route)) return;
			v.orphanedStationYards['line:'+key]=v.lineTrains[key];delete v.lineTrains[key];
		});
		v.worldIdentity=this.anchorFor(v);
		return true;
	},
	nearestStation: function(coordinate,route) {
		if(!this.validCoordinate(coordinate)) return this.startStation(route);
		var best=0,score=Infinity;
		route.corridor.stations.forEach(function(item,index){
			var point=route.tiles[item.square].geoCoordinate;
			var dlon=((point[0]-coordinate[0]+540)%360)-180;
			var lat1=coordinate[1]*Math.PI/180,lat2=point[1]*Math.PI/180;
			var a=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dlon*Math.PI/360)**2;
			var distance=2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
			if(distance<score){score=distance;best=index+1;}
		});
		return best;
	},
	relocateMoment: function(moment) {
		var v=moment.variables, old=v.worldIdentity, revision=setup.worldGraphData.networkRevision;
		if(!old || !old.revision || old.revision===revision) return false;
		var route=setup.realWorldPilot.getGridRoute(), stations=route.corridor.stations, self=this, byUuid={};
		stations.forEach(function(item,index){byUuid[item.uuid]=index+1;});
		function resolve(anchor){
			if(!self.object(anchor)) return self.startStation(route);
			if(anchor.siding) return setup.yards.exists(anchor.siding) ? anchor.siding : self.nearestStation(anchor.coordinate,route);
			return byUuid[anchor.uuid] || self.nearestStation(anchor.coordinate,route);
		}
		function kept(anchor){
			return self.object(anchor)&&(anchor.siding ? setup.yards.exists(anchor.siding) : !!byUuid[anchor.uuid]);
		}
		// null sends the player to the nearest station to the anchor's coordinates, or Punta Arenas if those are bad too.
		function locate(anchor){
			if(!self.object(anchor)||!Number.isInteger(anchor.x)||!Number.isInteger(anchor.y)
				||!self.validCoordinate(anchor.coordinate)) return null;
			var square=route.byKey[anchor.x+','+anchor.y], place=square && route.place[square.globalPosition];
			if(square) {
				var dlon=((square.geoCoordinate[0]-anchor.coordinate[0]+540)%360)-180;
				var a=Math.sin((square.geoCoordinate[1]-anchor.coordinate[1])*Math.PI/360)**2
					+Math.cos(square.geoCoordinate[1]*Math.PI/180)*Math.cos(anchor.coordinate[1]*Math.PI/180)
						*Math.sin(dlon*Math.PI/360)**2;
				if(12742*Math.asin(Math.min(1,Math.sqrt(a)))>15) return null;
			}
			return place ? {legIndex:place.legIndex,tileIndex:place.tileIndex} : null;
		}
		var station=resolve(old.station), moved=false, oldStationKey=String(v.currentStation), oldYard=v.stationTracks[oldStationKey];
		if(v.journey) {
			var journey=locate(old.journey), foot=v.onFoot && locate(old.onFoot);
			if(!journey || (v.onFoot && !foot)) {
				var point=(v.onFoot && old.onFoot || old.journey);
				station=self.nearestStation(point && point.coordinate,route);
				v.journey=null;v.onFoot=null;moved=true;
				moment.title=Array.isArray(v.currentTrain)&&v.currentTrain.length?'TrainInterior':'Railyard';
			} else {
				v.journey={legIndex:journey.legIndex,tileIndex:journey.tileIndex,forward:v.journey.forward!==false};
				if(foot) v.onFoot={legIndex:foot.legIndex,tileIndex:foot.tileIndex,branch:null};
			}
		}
		v.currentStation=station;
		if(v.enteredStation!=null) v.enteredStation=old.yards && old.yards[v.enteredStation]
			? resolve(old.yards[v.enteredStation]) : station;
		var yards={};v.orphanedStationYards=v.orphanedStationYards||{};
		Object.keys(v.stationTracks||{}).forEach(function(key){
			var identity=old.yards&&old.yards[key];
			if(!identity) throw new Error('A visited yard has no stable identity.');
			var exact=identity.siding ? (kept(identity) ? identity.siding : null) : byUuid[identity.uuid];
			if(exact && !yards[exact]) yards[exact]=v.stationTracks[key];
			else v.orphanedStationYards[identity.uuid||identity.siding||key]=v.stationTracks[key];
		});
		v.stationTracks=yards;
		// A removed yard cannot safely be interpreted as a different yard layout. Keep
		// its stock in the save and put the player/consist at the nearest live station.
		if(!kept(old.station)) moved=true;
		// Trains left on the line keep their squares; one whose square has gone is kept aside with its stock.
		var lineTrains={};
		Object.keys(v.lineTrains||{}).forEach(function(key){
			var entry=v.lineTrains[key], square=self.object(entry)&&route.byKey[key], place=square&&route.place[square.globalPosition];
			var node=square&&!place&&route.nodes[square.globalPosition], line=node&&node.lines[0];
			if(line) place={legIndex:line.legIndex,tileIndex:line.forward?0:route.legs[line.legIndex].tiles.length-1};
			if(place) lineTrains[key]=Object.assign(entry,{legIndex:place.legIndex,tileIndex:place.tileIndex,coordinate:square.geoCoordinate});
			else v.orphanedStationYards['line:'+key]=entry;
		});
		if(v.lineTrains) v.lineTrains=lineTrains;
		if(moved) {
			if(!v.currentTrain || !v.currentTrain.length) {
				var selected=null;
				if(oldYard) oldYard.some(function(track){return track.trains.some(function(train,index){
					if(train.visited || train.some(function(car){return car.visited;})) {
						selected=track.trains.splice(index,1)[0];return true;
					} return false;
				});});
				if(selected) v.currentTrain=selected;
			}
			v.enteredStation=station;delete v.enteredTrackIndex;delete v.enteredTrainIndex;
			if(v.leavingTrain && !v.currentTrain) {v.currentTrain=v.leavingTrain;v.leavingTrain=null;}
			if(moment.title==='Railyard' && v.currentTrain && v.currentTrain.length) moment.title='TrainInterior';
		}
		v.worldIdentity=this.anchorFor(v);
		return true;
	},
	afterUpgrade: function(upgraded,relocated,repaired) {
		this.recovery = null;
		setup.buildCheckDone = false;
		if (setup.worldmap) setup.worldmap.clearCache();
		if (setup.bugReport) setup.bugReport.recent = [];
		this.notice = upgraded ? 'Save upgraded to v' + setup.releaseVersion
			+ '. Your original save has not been overwritten. Export a new backup from Saves.' : '';
		if(relocated) this.notice += ' The coordinates in your save no longer exist. You have been moved to a nearby station.';
		if(repaired) this.notice += ' Your saved location does not exist. You have been moved to a nearby station.';
	},
	// Browser-tab restoration bypasses Save.onLoad. Upgrade it before Engine.show(),
	// including every history moment, then persist the converted session snapshot.
	restoreSession: function() {
		if (!State.history.length) return;
		// A moment at the current version with no world identity yet is a game just begun (the new game's first moment
		// is written before it is stamped), not a save from an older map: it is stamped below, not upgraded.
		if (State.history.every(function(moment) {
			return moment.variables && moment.variables.saveSchemaVersion === setup.saveMigrations.CURRENT
				&& (!moment.variables.worldIdentity || moment.variables.worldIdentity.revision===setup.worldGraphData.networkRevision)
				&& setup.saveMigrations.positionValid(moment.variables);
		})) {
			// SugarCube writes session storage before :historyupdate. Refresh the active
			// position anchor and write the completed moment as well.
			this.stampState({history:[State.active]});
			this.persistSession();
			return;
		}
		var original = State.marshalForSave();
		var result;
		try {
			result = this.upgradeState(original);
		} catch (error) {
			// Preserve the original session for download, and don't render incompatible gameplay.
			this.recovery = { state: original, error: error.message };
			this.notice = '';
			State.active.title = 'SaveRecovery';
			return;
		}
		State.history.splice.apply(State.history, [0, State.history.length].concat(result.state.history));
		var active = this.copy(result.state.history[result.state.index]);
		State.active.title = active.title; State.active.variables = active.variables;
		this.afterUpgrade(result.upgraded,result.relocated,result.repaired);
		setup.applyHistorySetting();
		this.persistSession();
	},
	persistSession: function() {
		// SugarCube exposes marshalForSave(), not its internal session marshaler.
		var snapshot = State.marshalForSave();
		snapshot.delta = State.deltaEncode(snapshot.history); delete snapshot.history;
		try {
			if (!session.set('state', snapshot)) throw new Error('Session storage unavailable.');
		} catch (error) {
			this.notice += ' Browser session storage is unavailable, please export your save game before closing the tab or else your save data will be permanently lost.';
		}
	}
};
setup.saveMigrations.steps[0] = function(moment) { setup.saveMigrations.upgradeUnversioned(moment); };
setup.saveMigrations.steps[1] = function(moment) { setup.saveMigrations.upgradeSourcedWorld(moment); };
// Regional generation adds stock/cargo catalogues, not a new world or replacement rolling stock.
// Refresh definitions only; visited yards, carried cars, positions and cargo are byte-for-byte preserved.
setup.saveMigrations.steps[2] = function(moment) {
	var v = moment.variables, definitions = setup.currentDefinitions;
	v.defaultTrains = Object.assign({}, v.defaultTrains, setup.saveMigrations.copy(definitions.defaultTrains));
	v.cargoTypes = Object.assign({}, v.cargoTypes, setup.saveMigrations.copy(definitions.cargoTypes));
};
// Expanded fleet: refresh presets, retaining every instantiated car and its selected artwork.
setup.saveMigrations.steps[3] = function(moment) {
	moment.variables.defaultTrains = Object.assign({}, moment.variables.defaultTrains,
		setup.saveMigrations.copy(setup.currentDefinitions.defaultTrains));
};
setup.saveMigrations.steps[4] = function(moment) {
	moment.variables.worldIdentity=setup.saveMigrations.anchorFor(moment.variables);
};
if (typeof Config !== 'undefined') {
	Config.saves.version = setup.saveMigrations.CURRENT;
	// Saving waits for the game to start; loading is allowed everywhere.
	Config.saves.isAllowed = function() { return setup.isInGame(); };
}
Save.onLoad.add(function(save) {
	var result = setup.saveMigrations.upgradeState(save.state, save.version);
	save.state = result.state;
	save.version = setup.saveMigrations.CURRENT;
	setup.saveMigrations.afterUpgrade(result.upgraded,result.relocated,result.repaired);
});
jQuery(document).on(':historyupdate.ashline-migrations', function() { setup.saveMigrations.restoreSession(); });
Macro.add('saveMigrationRecovery', {
	handler: function() {
		var recovery = setup.saveMigrations.recovery;
		if (!recovery) return;
		var text = document.createElement('p'); text.textContent = 'This browser session could not be upgraded. ' + recovery.error;
		this.output.appendChild(text);
		var button = document.createElement('button'); button.textContent = 'Download original session';
		button.addEventListener('click', function() {
			var state = setup.saveMigrations.copy(recovery.state);
			state.delta = State.deltaEncode(state.history); delete state.history;
			var file = new Blob([JSON.stringify({ id: Config.saves.id, state: state })], { type: 'application/json' });
			var url = URL.createObjectURL(file), link = document.createElement('a');
			link.href = url; link.download = 'ashline-session-recovery.json'; link.click();
			setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		});
		this.output.appendChild(button);
	}
});
