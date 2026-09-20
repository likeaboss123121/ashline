const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame } = require('./helpers.cjs');

const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
const road = extra => Object.assign({ length: 120, trains: [] }, extra);
function game(tracks, from = 1) {
  const g = loadGame(), v = g.State.variables;
  g.setup.startNewRun();
  v.randomSeed = 'review'; v.currentStation = 2;
  v.stationTracks = { 2: tracks }; v.drivingTrackIndex = from; v.enteredTrainIndex = 0;
  v.currentTrain = [g.setup.railyard.createLocomotiveCar('dieselShunter')];
  v.currentTrain[0].cargo = [{ type: 'diesel', amount: 400, grade: 80 }];
  v.currentCarIndex = 0;
  return g;
}

test('buffers, absent leads, finite capacity and through-road clearance constrain routes symmetrically', () => {
  const g = game([lead(), road({ connectsToExit: false }), road({ connectsToEntry: false }), lead()], 0);
  const a = g.setup.yardActions, v = g.State.variables;
  assert.equal(a.plan({ kind: 'move', to: 2 }).ok, false);
  v.drivingTrackIndex = 3;
  assert.equal(a.plan({ kind: 'move', to: 1 }).ok, false);
  v.stationTracks[2][1].connectsToExit = true;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, true);
  v.stationTracks[2][1].length = 8;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, false, 'a through road must hold the locomotive');
  v.drivingTrackIndex = 1;
  v.stationTracks[2][0] = { length: 1, trains: [] };
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, false);
  v.stationTracks[2][0].length = 80;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, true);
  v.stationTracks[2][0].hasLead = false;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, false);
});

test('parallel parked cars do not block a ladder, but own-track obstructions do', () => {
  const g = game([lead(), road(), road({ trains: [[{ length: 12 }]], connectsToExit: false }), road(), lead()], 3);
  const a = g.setup.yardActions, v = g.State.variables;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, true);
  v.stationTracks[2][3].trains = [[{ length: 12 }]];
  assert.equal(a.plan({ kind: 'move', to: 4 }).route.leaveEnd, 'entry', 'must run around the obstruction');
  v.enteredTrainIndex = 1;
  assert.equal(a.plan({ kind: 'move', to: 0 }).route.leaveEnd, 'exit');
  v.stationTracks[2][3].trains.push([{ length: 12 }]);
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, false, 'both ends blocked');
});

test('coupling only reaches the exposed end train and preserves driver and car order', () => {
  const g = game([lead(), road({ trains: [[{ length: 12, id: 'near' }], [{ length: 12, id: 'far' }]] }), lead()], 0);
  const a = g.setup.yardActions, v = g.State.variables;
  assert.equal(a.plan({ kind: 'couple', to: 1, train: 1, front: true }).ok, false);
  assert.equal(a.execute({ kind: 'couple', to: 1, train: 0, front: true }).ok, true);
  assert.equal(v.currentTrain[0].id, 'near');
  assert.equal(v.currentCarIndex, 1);
  assert.equal(v.stationTracks[2][1].trains[0][0].id, 'far');
});

test('stale or unaffordable shunting commands do not spend resources or change positions', () => {
  const g = game([lead(), road(), lead()]);
  const a = g.setup.yardActions, v = g.State.variables;
  assert.equal(a.plan({ kind: 'move', to: 0 }).ok, true);
  v.stationTracks[2][0] = { length: 1, trains: [] };
  let before = JSON.stringify(v);
  assert.equal(a.execute({ kind: 'move', to: 0 }).ok, false);
  assert.equal(JSON.stringify(v), before);
  v.currentTrain[0].cargo[0].amount = 1;
  v.stationTracks[2][0] = lead();
  v.stationTracks[2].splice(2, 0, road());
  before = JSON.stringify({ ...v, timedActionFailure: '' });
  assert.equal(a.execute({ kind: 'move', to: 2 }).ok, false, 'runaround needs two minutes');
  assert.equal(JSON.stringify({ ...v, timedActionFailure: '' }), before);
});

test('cold and empty engines can uncouple without consuming propulsion resources', () => {
  for (const model of ['dieselShunter', 'steamShunter']) {
    const g = game([lead(), road(), lead()]), v = g.State.variables;
    const engine = g.setup.railyard.createLocomotiveCar(model);
    engine.cargo = [];
    v.currentTrain = [engine, { length: 12 }];
    const before = JSON.stringify(engine);
    assert.equal(g.setup.yardActions.execute({ kind: 'decouple', front: false }).ok, true);
    assert.equal(JSON.stringify(engine), before);
    assert.equal(v.currentTrain.length, 1);
    assert.equal(v.stationTracks[2][1].trains.length, 1);
    assert.ok(v.player.carry.fatigue > 0);
  }
});

test('push, detach and retreat fits wagons in a stub without requiring room for the locomotive', () => {
  for (const front of [true, false]) {
    const tracks = [lead(), road(), road({ length: 14, connectsToEntry: front, connectsToExit: !front }), lead()];
    const g = game(tracks, front ? 0 : 3), v = g.State.variables, a = g.setup.yardActions;
    const wagon = { type: 'flatcar', length: 14, cargo: [{ type: 'timber', amount: 100 }], facing: -1 };
    if (front) { v.currentTrain.unshift(wagon); v.currentCarIndex = 1; } else v.currentTrain.push(wagon);
    const oldTrack = v.drivingTrackIndex, oldGap = v.enteredTrainIndex;
    assert.equal(a.plan({ kind: 'move', to: 2 }).ok, false);
    assert.equal(a.execute({ kind: 'setout', to: 2, front }).ok, true);
    assert.equal(v.drivingTrackIndex, oldTrack);
    assert.equal(v.enteredTrainIndex, oldGap);
    assert.equal(v.currentCarIndex, 0);
    assert.equal(v.currentTrain.length, 1);
    assert.equal(tracks[2].trains[0][0], wagon);
    assert.equal(wagon.cargo[0].amount, 100);
    assert.equal(wagon.facing, -1);
  }
});

test('setout refuses a closed approach, occupied return route, or undersized headshunt atomically', () => {
  const g = game([{ length: 15, trains: [] }, road(), road({ length: 14, connectsToExit: false }), lead()]);
  const v = g.State.variables, a = g.setup.yardActions;
  v.currentTrain.unshift({ length: 14 }); v.currentCarIndex = 1;
  const before = JSON.stringify(v);
  assert.equal(a.execute({ kind: 'setout', to: 2, front: true }).ok, false);
  assert.equal(JSON.stringify(v), before);
});

test('new runs clear direction, collapse, session selection and diagnostics, preserving only preferences/catalogues', () => {
  const g = game([lead(), road(), lead()]), v = g.State.variables;
  Object.assign(v, { travellingForward: false, pendingCollapse: { hours: 3 }, newUnknownRunField: 42, imperialUnits: true });
  const definitions = v.defaultTrains;
  g.setup.startNewRun();
  assert.equal(v.travellingForward, true);
  assert.equal(v.pendingCollapse, undefined);
  assert.equal(v.newUnknownRunField, undefined);
  assert.equal(v.imperialUnits, true);
  assert.equal(v.defaultTrains, definitions);
  assert.deepEqual(Object.keys(v.stationTracks), []);
});

test('inventory insertion and capacity checking agree at stack boundaries', () => {
  const g = game([lead(), road(), lead()]), v = g.State.variables, items = g.setup.items;
  v.player.carried = [{ item: 'rations', count: 6 }];
  const car = v.currentTrain[0]; car.inventory = [{ item: 'rations', count: 2 }];
  assert.equal(items.takeFromCar(car, 'rations'), true);
  assert.equal(items.takeFromCar(car, 'rations'), true);
  assert.deepEqual(Array.from(v.player.carried, s => s.count), [6, 2]);
  v.player.carried = Array.from({ length: 16 }, () => ({ item: 'rations', count: 6 }));
  car.inventory = [{ item: 'rations', count: 1 }];
  assert.equal(items.takeFromCar(car, 'rations'), false);
  assert.equal(car.inventory[0].count, 1);
});

test('completed generated yards preserve a usable clear road, accessible reserve and passenger spawning', () => {
  const g = loadGame(), v = g.State.variables, yard = g.setup.railyard;
  const types = new Set();
  for (let n = 0; n < 120; n++) {
    v.randomSeed = 'review-' + n;
    const tracks = yard.generateStationTracks(2, v.randomSeed);
    assert.equal(g.setup.yardGeneration.validate(tracks), true, v.randomSeed);
    const clear = tracks.find(t => t.reservedClearance);
    assert.equal(clear.trains.length, 0, v.randomSeed);
    assert.ok(yard.getTrackConnections(clear).entry && yard.getTrackConnections(clear).exit);
    const reserves = tracks.flatMap(t => t.trains.map(train => ({ t, train }))).filter(({ train }) => train.length === 1 && train[0].inventory?.some(s => s.item === 'pump'));
    assert.ok(reserves.length, v.randomSeed);
    const { t, train } = reserves[0];
    assert.ok(t.trains[0] === train || t.trains[t.trains.length - 1] === train);
    assert.ok(g.setup.fuel.canDieselRun(train[0]));
    assert.ok(yard.getCargoAmount(train[0], 'diesel') >= g.setup.worldmap.getTravelMinutes(2, true, train) * 1.05);
    tracks.flatMap(t => t.trains).flat().forEach(car => types.add(car.type));
  }
  for (const type of ['passenger coach', 'sleeper coach', 'observation car', 'kitchen car', 'private car']) assert.ok(types.has(type), type);
});

test('branch terminus headings retain all eight directions and their generated escape route', () => {
  const g = loadGame(), world = g.setup.worldmap, yard = g.setup.railyard;
  g.State.variables.randomSeed = 'termini';
  let diagonal = false;
  for (let leg = 1; leg < 15; leg++) {
    for (const branch of world.getLeg('termini', leg).branches) {
      if (!branch.stationId) continue;
      const tracks = yard.generateStationTracks(branch.stationId, 'termini');
      const end = branch.tiles.at(-1).ends[0];
      const expected = world.describeDirection(end).replace('-', '');
      assert.equal(tracks[0].direction, expected);
      assert.ok(g.setup.yardGeneration.validate(tracks));
      if (end % 2) diagonal = true;
    }
  }
  assert.ok(diagonal);
});

test('passenger templates exist at their catalogue lengths in both projections', () => {
  const { setup, State } = loadGame();
  for (const [key, suffix] of [['passengerCoach', 'passenger'], ['sleeperCoach', 'sleeper'], ['observationCar', 'observation'], ['kitchenCar', 'kitchen'], ['privateCar', 'private']]) {
    assert.ok(setup.railyard.carKeys.includes(key));
    assert.ok(setup.railyard.getDebugTrainTypeOptions().some(option => JSON.stringify(option).includes(key)));
    for (const view of ['railyard', 'driving']) {
      const template = setup[view + 'Templates'].templates.find(t => t.passage === view + '-car-' + suffix);
      assert.ok(template, suffix);
      assert.equal(template.lengthMetres, State.variables.defaultTrains[key].length);
    }
  }
});

test('diagnostic reports retain bounded recent actions without storing generated world data', () => {
  const g = game([lead(), road(), lead()]);
  g.setup.currentBuildChecksum = 'test-build';
  for (let i = 0; i < 40; i++) g.setup.bugReport.record({ kind: 'test', i });
  const report = g.setup.bugReport.build();
  assert.equal(report.recentActions.length, 30);
  assert.equal(report.seed, 'review');
  assert.equal(report.track, 1);
  assert.equal(report.build, 'test-build');
  assert.equal(g.State.variables.recentActions, undefined);
});
