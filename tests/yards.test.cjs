const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame, stationRun } = require('./helpers.cjs');

const lead = () => ({ length: 999999, infinite: true, trains: [] });
function fresh() {
  const game = loadGame(), { setup, State } = game;
  setup.startNewRun();
  State.variables.randomSeed = 'yards';
  return game;
}
function loco(setup, name) {
  const car = setup.railyard.createLocomotiveCar('dieselShunter');
  car.cargo = [{ type: 'diesel', amount: 400 }];
  car.facing = 1; car.name = name;
  return car;
}
function box(setup, State, name) {
  const car = setup.railyard.cloneCar(State.variables.defaultTrains.boxcar);
  car.facing = 1; car.name = name;
  return car;
}
const names = train => Array.from(train, car => car.name);
// Values made inside the game's sandbox, copied out so they compare with the test's own.
const plain = value => JSON.parse(JSON.stringify(value));

test('sidings stand on plain line apart from any station, with their own yard and both ways along their leg', () => {
  const { setup, State } = fresh();
  const route = setup.realWorldPilot.getGridRoute();
  const sidings = route.tiles.filter(tile => setup.yards.hasSiding(tile));
  assert.ok(sidings.length > 100 && sidings.length < route.tiles.length / 5, sidings.length + ' sidings');
  assert.ok(sidings.every(tile => !tile.stationIndex && tile.ends.length === 2 && tile.terrain !== 'bridge'));
  const tile = sidings.find(candidate => route.place[candidate.globalPosition].tileIndex > 1), id = 'siding:' + tile.x + ',' + tile.y;
  assert.deepEqual(plain(setup.yards.at(tile.x, tile.y)), [{ id, kind: 'siding' }]);
  assert.equal(setup.yards.exists(id), true);
  assert.equal(setup.yards.exists('siding:99999,99999'), false);
  assert.match(setup.worldmap.getStationName(id), /Siding near /);
  const place = setup.yards.place(id), lines = setup.realWorldPilot.getStationLines(id);
  assert.deepEqual(plain(lines.map(line => [line.side, line.legIndex, line.tileIndex, line.forward])),
    [['entry', place.legIndex, place.tileIndex, false], ['exit', place.legIndex, place.tileIndex, true]]);
  const tracks = setup.railyard.generateStationTracks(id, 'yards');
  assert.equal(tracks.length, 3);
  assert.ok(tracks[1].length >= 300 && tracks[1].length <= 900 && !tracks[1].trains.length, 'an empty road');
  assert.ok(tracks[0].direction && tracks[2].direction);
  // A station square has the station's yard, first.
  const station = route.tiles[route.stationPositions[1]];
  assert.equal(setup.yards.at(station.x, station.y)[0].id, 2);

  // A consist on the line pulls into the siding, and leaves it from where it stands, either way.
  State.variables.currentTrain = [loco(setup, 'A')];
  State.variables.journey = { legIndex: place.legIndex, tileIndex: place.tileIndex, forward: true };
  State.variables.travellingForward = true;
  assert.equal(setup.yards.enter(id), true);
  assert.equal(State.variables.currentStation, id);
  assert.equal(State.variables.journey, null);
  assert.equal(State.variables.drivingTrackIndex, 0);
  assert.equal(setup.railyard.getDepartureBlockReason(id, 0, true), '');
  assert.equal(setup.railyard.departOntoLine(true), true);
  assert.deepEqual({ ...State.variables.journey }, { legIndex: place.legIndex, tileIndex: place.tileIndex, forward: true });
  assert.ok(setup.worldmap.getTravelMinutes(id, true, State.variables.currentTrain) <
    setup.worldmap.getLegTravel(setup.worldmap.getSeed(), place.legIndex, State.variables.currentTrain).minutes,
  'the time on from a siding is the rest of the leg');
});

test('a train passes through a station on the line when facing into it, and enters the yard only by choice', () => {
  const { setup, State } = fresh();
  const run = stationRun(setup, 3), [, b] = run.stations, legs = run.legs;
  const last = setup.realWorldPilot.getLeg(legs[0]).tiles.length - 1;
  State.variables.currentTrain = [loco(setup, 'A')];
  State.variables.journey = { legIndex: legs[0], tileIndex: last, forward: true };
  assert.equal(setup.worldmap.getJourneyStep(1), null);
  const choices = setup.worldmap.getBranchChoices();
  assert.deepEqual(plain(choices.map(choice => choice.legIndex)), [legs[1]]);
  assert.equal(setup.railyard.takeBranch(choices[0].id), true);
  assert.equal(State.variables.journey.legIndex, legs[1]);
  assert.equal(State.variables.journey.tileIndex, 1);
  assert.notEqual(State.variables.currentStation, b, 'passing through does not enter the yard');
  // Just out of a station, facing away from it, there is no way on through it; a walker can go either way.
  const outside = { legIndex: legs[1], tileIndex: 0, forward: true };
  assert.deepEqual(plain(setup.worldmap.getBranchChoices(outside)), []);
  assert.ok(setup.worldmap.getBranchChoices(outside, true).length > 0);
});

test('boarding another train leaves the consist on the line, where it blocks the line until a train couples to it', () => {
  const { setup, State } = fresh();
  const v = State.variables, run = stationRun(setup, 2), [a] = run.stations, leg = run.legs[0];
  const tiles = setup.realWorldPilot.getLeg(leg).tiles;
  // Consist A stands on the fourth square out of station a; the player walked back into a's yard.
  v.currentTrain = [loco(setup, 'A1'), box(setup, State, 'A2')];
  v.journey = { legIndex: leg, tileIndex: 3, forward: true };
  v.travellingForward = true;
  v.onFoot = { legIndex: leg, tileIndex: 0, branch: null, inRailyard: true };
  v.currentStation = a;
  v.stationTracks = { [a]: [lead(), { length: 400, trains: [[loco(setup, 'B1')]] }, lead()] };
  assert.equal(setup.railyard.boardTrain(a, 1, 0), true);
  assert.deepEqual(names(v.currentTrain), ['B1']);
  assert.equal(v.journey, null);
  assert.equal(v.onFoot, null);
  const key = tiles[3].x + ',' + tiles[3].y;
  assert.deepEqual(plain(Object.keys(v.lineTrains)), [key]);
  assert.deepEqual(names(v.lineTrains[key].train), ['A1', 'A2']);
  assert.equal(v.lineTrains[key].frontAlongLeg, true);

  // A second consist C is left two squares behind A.
  const behind = tiles[1];
  v.lineTrains[behind.x + ',' + behind.y] = { legIndex: leg, tileIndex: 1, x: behind.x, y: behind.y, frontAlongLeg: true,
    train: [loco(setup, 'C1'), box(setup, State, 'C2')] };

  // B leaves the yard: C stands on the line outside, so leaving couples to it... but it is two squares on.
  v.enteredTrainIndex = 0;
  assert.equal(setup.railyard.departOntoLine(true), true);
  assert.deepEqual(names(v.currentTrain), ['B1']);
  const toC = setup.worldmap.getJourneyStep(1);
  assert.ok(toC.couples && !toC.blocked, 'driving onto a parked train couples to it');
  assert.equal(setup.railyard.moveAlongLine(1), true);
  // Driving forward, B leads with its first car and meets C's rear: C goes in front, the way it points.
  assert.deepEqual(names(v.currentTrain), ['C1', 'C2', 'B1']);
  assert.ok(v.currentTrain.every(car => car.facing === 1));
  assert.equal(v.journey.tileIndex, 1);
  assert.equal(setup.railyard.moveAlongLine(1), true);
  assert.equal(setup.worldmap.getJourneyStep(1).couples, true);
  assert.equal(setup.railyard.moveAlongLine(1), true);
  assert.deepEqual(names(v.currentTrain), ['A1', 'A2', 'C1', 'C2', 'B1']);
  assert.deepEqual(plain(v.lineTrains), {});

  // Reversing onto a train left behind couples it to the rear; one left pointing the other way is turned with it.
  const back = tiles[1];
  v.lineTrains[back.x + ',' + back.y] = { legIndex: leg, tileIndex: 1, x: back.x, y: back.y, frontAlongLeg: false,
    train: [loco(setup, 'D1'), box(setup, State, 'D2')] };
  assert.equal(setup.railyard.moveAlongLine(-1), true);
  assert.equal(setup.worldmap.getJourneyStep(-1).couples, true);
  assert.equal(setup.railyard.moveAlongLine(-1), true);
  assert.deepEqual(names(v.currentTrain), ['A1', 'A2', 'C1', 'C2', 'B1', 'D2', 'D1']);
  assert.deepEqual(plain(v.currentTrain.slice(-2).map(car => car.facing)), [-1, -1]);
});

test('leaving a yard couples to a train left outside it, and a walker can climb aboard a train left on the line', () => {
  const { setup, State } = fresh();
  const v = State.variables, run = stationRun(setup, 2), [a] = run.stations, leg = run.legs[0];
  const tiles = setup.realWorldPilot.getLeg(leg).tiles, outside = tiles[0];
  v.lineTrains = { [outside.x + ',' + outside.y]: { legIndex: leg, tileIndex: 0, x: outside.x, y: outside.y, frontAlongLeg: true,
    train: [loco(setup, 'P1')] } };
  v.currentStation = a;
  v.stationTracks = { [a]: [lead(), { length: 400, trains: [] }, lead()] };
  v.currentTrain = [loco(setup, 'B1')];
  v.drivingTrackIndex = 1; v.enteredTrainIndex = 0;
  assert.equal(setup.railyard.departOntoLine(true), true);
  assert.deepEqual(names(v.currentTrain), ['P1', 'B1']);
  assert.deepEqual(plain(v.lineTrains), {});

  // Walking from B, at square 5, back to a train left at square 2: boarding it leaves B where it stands.
  v.journey = { legIndex: leg, tileIndex: 5, forward: true };
  v.travellingForward = true;
  v.currentTrain = [loco(setup, 'B1')];
  v.lineTrains = { [tiles[2].x + ',' + tiles[2].y]: { legIndex: leg, tileIndex: 2, x: tiles[2].x, y: tiles[2].y, frontAlongLeg: false,
    train: [loco(setup, 'Q1')] } };
  v.onFoot = { legIndex: leg, tileIndex: 2, branch: null };
  assert.equal(setup.yards.boardParked(tiles[2].x, tiles[2].y), true);
  assert.deepEqual(names(v.currentTrain), ['Q1']);
  assert.deepEqual({ ...v.journey }, { legIndex: leg, tileIndex: 2, forward: true });
  assert.equal(v.travellingForward, false);
  assert.equal(v.onFoot, null);
  assert.deepEqual(names(v.lineTrains[tiles[5].x + ',' + tiles[5].y].train), ['B1']);
});

test('saves keep siding yards and trains on the line, and set aside ones that are not on the map', () => {
  const { setup, State } = fresh();
  const v = State.variables, route = setup.realWorldPilot.getGridRoute(), run = stationRun(setup, 2), leg = run.legs[0];
  const tile = route.tiles.find(candidate => setup.yards.hasSiding(candidate)), id = 'siding:' + tile.x + ',' + tile.y;
  const tiles = setup.realWorldPilot.getLeg(leg).tiles;
  v.currentStation = id;
  v.stationTracks = { [id]: setup.railyard.generateStationTracks(id, v.randomSeed) };
  v.lineTrains = { [tiles[2].x + ',' + tiles[2].y]: { legIndex: leg, tileIndex: 2, x: tiles[2].x, y: tiles[2].y, frontAlongLeg: true,
    train: [loco(setup, 'P1')] } };
  const state = variables => ({ index: 0, history: [{ title: 'Railyard', variables }] });
  const saved = state(JSON.parse(JSON.stringify(v)));
  setup.saveMigrations.stampState(saved);
  assert.equal(saved.history[0].variables.worldIdentity.station.siding, id);
  const clean = setup.saveMigrations.upgradeState(saved, setup.saveMigrations.CURRENT);
  assert.equal(clean.repaired, false);
  assert.equal(clean.state.history[0].variables.currentStation, id);

  // A train filed under the wrong square, and a siding id with no siding under it.
  const bad = JSON.parse(JSON.stringify(v));
  bad.lineTrains['1,1'] = bad.lineTrains[tiles[2].x + ',' + tiles[2].y];
  delete bad.lineTrains[tiles[2].x + ',' + tiles[2].y];
  const bare = tiles.find((candidate, index) => index > 0 && index < tiles.length - 1 && !setup.yards.hasSiding(candidate));
  bad.currentStation = 'siding:' + bare.x + ',' + bare.y;
  const out = setup.saveMigrations.upgradeState(state(bad), setup.saveMigrations.CURRENT).state.history[0].variables;
  assert.deepEqual(plain(out.lineTrains), {});
  assert.ok(out.orphanedStationYards['line:1,1']);
  assert.equal(out.currentStation, setup.saveMigrations.nearestStation(bare.geoCoordinate, route), 'nearest station to that square');
  assert.throws(() => setup.saves.validateState(state(Object.assign(JSON.parse(JSON.stringify(v)),
    { lineTrains: { x: { train: [{}] } } }))), /train/i);
});
