const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGame } = require('./helpers.cjs');

test('geographic locales distinguish the route and preserve crossings and relief', () => {
  const { setup: s } = loadGame();
  for (const [coord, expected] of [
    [[-70.9, -53.2], 'steppe'], [[-60, -34], 'pampas'], [[28, -26], 'savanna'],
    [[105, 58], 'taiga'], [[-90, 30], 'wetland'], [[-60, -3], 'rainforest'],
    [[15, 25], 'desert'], [[20, -34], 'mediterranean'], [[135, 69], 'tundra'], [[10, 48], 'temperate']
  ]) assert.equal(s.locales.profile(coord, 100).biome, expected);
  assert.equal(s.locales.profile([85, 30], 4200).biome, 'alpine');
  assert.equal(s.locales.profile(null).biome, 'temperate');
  for (const terrain of ['mountain', 'bridge', 'tunnel']) {
    assert.equal(s.locales.terrain({ terrain, geoCoordinate: [-60, -3] }), terrain);
  }
  assert.equal(s.locales.terrain({ terrain: 'plains', geoCoordinate: [105, 58] }), 'forest');
});

test('regional stock and industry preferences are weighted, reproducible, and keep every model possible', () => {
  const { setup: s } = loadGame(), yard = s.railyard;
  const sample = fleet => {
    const rng = yard.mulberry32(231), counts = {};
    for (let n = 0; n < 12000; n++) {
      const key = s.locales.choose(yard.locomotiveKeys, s.locales.FLEETS[fleet], rng);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  };
  const old = sample('legacy'), heavy = sample('heavy');
  assert.deepEqual(old, sample('legacy'));
  assert.ok(old.dieselOldRoad > old.dieselRoad * 3);
  assert.ok(heavy.dieselRoad > heavy.dieselOldRoad * 3);
  for (const key of yard.locomotiveKeys) assert.ok(old[key] > 0 && heavy[key] > 0);
  const counts = {}, rng = yard.mulberry32(999);
  for (let n = 0; n < 12000; n++) {
    const key = yard.randomCarKey(rng, { industry: 'farming' });
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.ok(counts.hopper > counts.gondola * 3);
  assert.ok(counts.refrigerated > counts.gondola * 3);
});

test('all regional art exists in both projections with correct car dimensions', () => {
  const { setup: s, State } = loadGame();
  for (const view of ['railyard', 'driving']) {
    const templates = new Map(s[view + 'Templates'].templates.map(t => [t.passage, t]));
    for (const [key, suffix] of [['hopper', 'car-hopper'], ['refrigerated', 'car-refrigerated'],
      ['dieselOldRoad', 'loco-diesel-old-road-right'], ['dieselOldRoad', 'loco-diesel-old-road-left']]) {
      assert.equal(templates.get(view + '-' + suffix).lengthMetres, State.variables.defaultTrains[key].length);
    }
    for (const [key, biome] of Object.entries(s.locales.BIOMES)) {
      if (view === 'railyard') assert.ok(templates.has('railyard-plant-' + biome.plant));
      else for (const suffix of ['', '-mountain']) assert.ok(templates.has('driving-terrain-local-' + key + suffix));
    }
    if (view === 'railyard') for (const key of Object.keys(s.locales.INDUSTRIES)) assert.ok(templates.has('railyard-industry-' + key));
  }
});

test('regional cargo obeys car restrictions, capacities and food remains usable', () => {
  const { setup: s, State } = loadGame(), yard = s.railyard;
  for (const industry of Object.keys(s.locales.INDUSTRIES)) {
    const rng = yard.mulberry32(271);
    for (const key of yard.carKeys) {
      const car = State.variables.defaultTrains[key], accepted = yard.getAcceptedCargoTypes(car);
      for (let n = 0; n < 200; n++) {
        const cargo = yard.generateCargoForCar(key, rng, { industry });
        assert.ok(cargo.every(load => accepted.includes(load.type)), key);
        assert.ok(cargo.reduce((sum, load) => sum + load.amount, 0) <= car.maxCargoCapacityVolume);
        assert.ok(cargo.reduce((sum, load) => sum + load.amount * yard.getCargoDensityKgPerLiter(load.type), 0) <= car.maxCargoCapacityKg);
      }
    }
  }
  const car = yard.cloneCar(State.variables.defaultTrains.refrigerated);
  car.cargo = [{ type: 'food', amount: 12 }];
  State.variables.currentTrain = [car];
  assert.equal(s.food.source('food', 1), car);
});

test('station profiles use stable IDs, and complete regional yards retain escape guarantees', () => {
  const { setup: s, State } = loadGame();
  State.variables.randomSeed = 'locales';
  const route = s.realWorldPilot.getGridRoute();
  const wanted = new Set(['steppe', 'pampas', 'savanna', 'wetland', 'rainforest', 'taiga', 'tundra', 'desert', 'temperate', 'mediterranean', 'alpine']);
  const before = Object.keys(State.variables).sort().join();
  for (let id = 2; id <= route.corridor.stations.length && wanted.size; id++) {
    const profile = s.locales.forStation(id);
    if (!wanted.delete(profile.biome)) continue;
    assert.deepEqual(s.locales.forStation(id), profile);
    const a = s.railyard.generateStationTracks(id, 'locales');
    const b = s.railyard.generateStationTracks(id, 'locales');
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(s.yardGeneration.validate(a), true);
  }
  assert.equal(wanted.size, 0, [...wanted].join());
  assert.equal(Object.keys(State.variables).sort().join(), before, 'no locale data in saves');
});

test('coal in a coupled hopper can actually refuel a steam engine, with grade and mass conserved', () => {
  const { setup: s, State } = loadGame(), v = State.variables;
  const steam = s.railyard.createLocomotiveCar('steamShunter');
  const hopper = s.railyard.cloneCar(v.defaultTrains.hopper);
  steam.inventory = [{ item: 'toolkit', count: 1 }];
  hopper.cargo = [{ type: 'coal', amount: 1000, grade: 63 }];
  v.currentTrain = [steam, hopper]; v.currentCarIndex = 0;
  v.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  s.refuel.getSurroundings = () => ({ onLine: false, waterTank: false });
  const option = s.refuel.getOptions(v.currentTrain, 0).find(job => job.id === 'coal-from-hopper');
  assert.equal(option.reason, ''); assert.equal(option.minutes, 8); assert.equal(option.kg, 200);
  assert.equal(s.refuel.perform('coal-from-hopper', 0), true);
  assert.equal(s.railyard.getCargoAmount(hopper, 'coal'), 750);
  assert.equal(s.railyard.getCargoAmount(steam, 'coal'), 250);
  assert.equal(s.fuel.getGrade(steam, 'coal'), 63);
  hopper.broken = true;
  assert.equal(s.refuel.perform('coal-from-hopper', 0), false);
});

test('schema 2 regional upgrade refreshes catalogues without rerolling a visited yard or carried train', () => {
  const { setup: s, State } = loadGame();
  s.startNewRun();
  const v = State.variables;
  v.saveSchemaVersion = 2;
  v.stationTracks[1] = s.railyard.generateStationTracks(1, 'migration');
  v.currentTrain = [s.railyard.createLocomotiveCar('dieselRoad')];
  v.currentTrain[0].cargo = [{ type: 'diesel', amount: 333, grade: 71 }];
  delete v.defaultTrains.hopper; delete v.defaultTrains.refrigerated; delete v.defaultTrains.dieselOldRoad;
  delete v.cargoTypes['iron ore'];
  const original = JSON.stringify(v);
  const result = s.saveMigrations.upgradeState({ index: 0, history: [{ title: 'Railyard', variables: v }] }, 2);
  const after = result.state.history[0].variables;
  assert.equal(JSON.stringify(v), original, 'upgrade is detached');
  assert.equal(JSON.stringify(after.stationTracks), JSON.stringify(v.stationTracks));
  assert.equal(JSON.stringify(after.currentTrain), JSON.stringify(v.currentTrain));
  assert.equal(after.currentStation, v.currentStation);
  assert.ok(after.defaultTrains.hopper && after.defaultTrains.refrigerated && after.defaultTrains.dieselOldRoad);
  assert.ok(after.cargoTypes['iron ore']);
  assert.equal(s.saveMigrations.upgradeState(result.state, s.saveMigrations.CURRENT).upgraded, false);
});
