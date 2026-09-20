const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGame } = require('./helpers.cjs');

test('steam initialization terminates and clamps stored pressure', () => {
  const { setup, State } = loadGame();
  const loco = setup.railyard.cloneCar(State.variables.defaultTrains.steamShunter);
  loco.steamStoredLiters = 1e9;
  assert.equal(setup.railyard.getSteamPressureBar(loco), 14.5);
});

test('the final liter of diesel can complete one minute of movement', () => {
  const { setup, State } = loadGame();
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 1 }];
  State.variables.currentTrain = [loco];
  State.variables.stationTracks = {};
  assert.equal(setup.time.advanceMinutesWithSystems(1, 'shunting'), true);
  assert.equal(loco.cargo[0].amount, 0);
  assert.equal(setup.time.getCurrentTimestampMs(), setup.time.startTimestampMs + 60000);
});

test('duplicate cargo stacks are totaled and consumed without partial failure', () => {
  const { setup } = loadGame();
  const car = { cargo: [{ type: 'coal', amount: 1 }, { type: 'coal', amount: 2 }] };
  assert.equal(setup.railyard.getCargoAmount(car, 'coal'), 3);
  assert.equal(setup.railyard.consumeCargoAmount(car, 'coal', 4), false);
  assert.equal(setup.railyard.getCargoAmount(car, 'coal'), 3);
  assert.equal(setup.railyard.consumeCargoAmount(car, 'coal', 2.5), true);
  assert.equal(setup.railyard.getCargoAmount(car, 'coal'), 0.5);
});

test('front decoupling inserts directly ahead of the player gap', () => {
  const { setup, State } = loadGame();
  const ahead = [{ type: 'ahead', length: 12 }];
  const split = [{ type: 'split', length: 12 }];
  State.variables.stationTracks = { 1: [
    { infinite: true, trains: [] }, { length: 120, trains: [ahead] }, { infinite: true, trains: [] }
  ] };
  State.variables.enteredTrainIndex = 0;
  assert.equal(setup.railyard.placeDecoupledSplitFromCurrentTrain(1, 1, split, true), true);
  assert.equal(State.variables.stationTracks[1][1].trains[0], split);
  assert.equal(State.variables.enteredTrainIndex, 0);
});

test('train numbering includes the player at the end of an empty or occupied track', () => {
  const { setup } = loadGame();
  const tracks = [{ trains: [] }, { trains: [[{ length: 12 }]] }, { trains: [] }];
  assert.equal(setup.railyard.getTrainDisplayNumber(tracks, 1, 0, 0, 0), 2);
});

test('swapping two trains on the same full track preserves capacity', () => {
  const { setup, State } = loadGame();
  const short = [{ length: 12 }], long = [{ length: 18 }];
  State.variables.stationTracks = { 1: [{ length: 30, trains: [short, long] }] };
  assert.equal(setup.railyard.swapDebugTrains(1, 0, 0, 0, 1).ok, true);
  assert.equal(State.variables.stationTracks[1][0].trains[0], long);
});

test('failed multi-minute moves change neither fuel, boilers, nor the clock', () => {
  const { setup, State } = loadGame();
  const diesel = setup.railyard.createLocomotiveCar('dieselShunter');
  diesel.cargo = [{ type: 'diesel', amount: 2 }];
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.fireboxEnabled = true;
  steam.cargo = [{ type: 'coal', amount: 10 }, { type: 'water', amount: 30 }];
  State.variables.currentTrain = [diesel, steam];
  State.variables.stationTracks = {};
  const before = JSON.stringify(State.variables.currentTrain);
  assert.equal(setup.time.advanceMinutesWithSystems(3, 'travel'), false);
  assert.equal(JSON.stringify(State.variables.currentTrain), before);
  assert.equal(setup.time.getCurrentTimestampMs(), setup.time.startTimestampMs);
  assert.match(State.variables.timedActionFailure, /Not enough fuel/);
});

test('steam wait estimate matches the actual simulation without modifying the train', () => {
  const { setup, State } = loadGame();
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.fireboxEnabled = true;
  // Just short of the 10 bar a locomotive needs to pull, whatever size its boiler is.
  steam.steamStoredLiters = setup.railyard.getSteamBoilerVolumeLiters(steam) * 9.9;
  steam.cargo = [{ type: 'coal', amount: 100 }, { type: 'water', amount: 300 }];
  const before = JSON.stringify(steam);
  const minutes = setup.railyard.estimateMinutesUntilSteamUsable([steam], 720);
  assert.ok(minutes > 0);
  assert.equal(JSON.stringify(steam), before);
  State.variables.currentTrain = [steam];
  setup.time.advanceMinutesWithSystems(minutes - 1);
  assert.equal(setup.railyard.isTrainDriveCapable([steam]), false);
  setup.time.advanceMinutesWithSystems(1);
  assert.equal(setup.railyard.isTrainDriveCapable([steam]), true);
});

test('firebox stops when either resource runs out and never consumes a partial batch', () => {
  const { setup } = loadGame();
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.fireboxEnabled = true;
  steam.cargo = [{ type: 'coal', amount: 1 }, { type: 'water', amount: 30 }];
  setup.railyard.processSteamFireboxMinuteForCar(steam);
  assert.equal(steam.fireboxEnabled, false);
  assert.equal(steam.steamStoredLiters, 0);
  assert.deepEqual(steam.cargo.map(c => c.amount), [1, 30]);
});

test('only current and parked trains participate in time simulation', () => {
  const { setup, State } = loadGame();
  const active = [{}], parked = [{}], ghost = [{}];
  State.variables.currentTrain = active;
  State.variables.stationTracks = { 1: [{ trains: [parked] }] };
  State.variables.trains = [ghost];
  const trains = setup.time.getTrackedTrains();
  assert.equal(trains.length, 2);
  assert.ok(trains.includes(active));
  assert.ok(trains.includes(parked));
  assert.ok(!trains.includes(ghost));
});

test('boarding and leaving conserve cars and preserve cargo through JSON saves', () => {
  const { setup, State } = loadGame();
  State.variables.currentStation = 1;
  State.variables.stationTracks = { 1: setup.railyard.generateStationTracks(1, 'test') };
  setup.railyard.boardTrain(1, 1, 0);
  State.variables = JSON.parse(JSON.stringify(State.variables));
  assert.equal(State.variables.stationTracks[1][1].trains.length, 0);
  assert.equal(setup.railyard.leaveCurrentTrain(), true);
  State.variables = JSON.parse(JSON.stringify(State.variables));
  const train = State.variables.stationTracks[1][1].trains[0];
  assert.equal(State.variables.currentTrain, null);
  assert.equal(setup.railyard.isTrainVisited(train), true);
  assert.equal(setup.railyard.getCargoAmount(train[0], 'diesel'), 400);
  assert.equal(State.variables.stationTracks[1][1].trains.length, 1);
});

test('departure rules are symmetric at entry, exit, and blocked yard routes', () => {
  const { setup, State } = loadGame();
  const parked = () => [[{ length: 12 }]];
  const tracks = [
    { infinite: true, trains: parked() }, { length: 120, trains: [] },
    { length: 120, trains: [] }, { infinite: true, trains: parked() }
  ];
  State.variables.stationTracks = { 2: tracks };
  State.variables.enteredTrainIndex = 0;
  assert.match(setup.railyard.getDepartureBlockReason(2, 1, false), /Southbound Track is blocked/);
  assert.match(setup.railyard.getDepartureBlockReason(2, 1, true), /Northbound Track is blocked/);
  assert.equal(setup.railyard.getDepartureBlockReason(2, 0, false), '');
  State.variables.enteredTrainIndex = 1;
  assert.equal(setup.railyard.getDepartureBlockReason(2, 3, true), '');
  tracks[0].trains = [];
  tracks[3].trains = [];
  tracks[2].trains = parked();
  State.variables.enteredTrainIndex = 0;
	assert.equal(setup.railyard.getDepartureBlockReason(2, 1, true), '');
});

test('full-track coupling keeps physical car order in both directions', () => {
  const { setup } = loadGame();
  const trains = [[{ id: 'near-front' }, { id: 'near-rear' }], [{ id: 'far-front' }, { id: 'far-rear' }]];
  for (const reverse of [false, true]) {
    const cars = setup.railyard.flattenTrackTrainsForDirection(trains, reverse);
    assert.equal(cars.map(car => car.id).join(','), 'far-front,far-rear,near-front,near-rear');
  }
});

test('decoupling either side and leaving conserves train order', () => {
  for (const front of [false, true]) {
    const { setup, State } = loadGame();
    const behind = [{ id: 'behind', length: 12 }], ahead = [{ id: 'ahead', length: 12 }];
    const split = [{ id: 'split', length: 12 }], player = [{ id: 'player', length: 18 }];
    State.variables.currentStation = 1;
    State.variables.currentTrain = player;
    State.variables.drivingTrackIndex = 1;
    State.variables.enteredTrainIndex = 1;
    State.variables.stationTracks = { 1: [{ infinite: true, trains: [] }, { length: 120, trains: [behind, ahead] }, { infinite: true, trains: [] }] };
    assert.equal(setup.railyard.placeDecoupledSplitFromCurrentTrain(1, 1, split, front), true);
    assert.equal(setup.railyard.leaveCurrentTrain(), true);
    const order = State.variables.stationTracks[1][1].trains.map(train => train[0].id).join(',');
    assert.equal(order, front ? 'behind,player,split,ahead' : 'behind,split,player,ahead');
  }
});

test('1000 generated yards are repeatable and respect track and cargo limits', () => {
  const { setup, State } = loadGame();
  for (let seed = 0; seed < 1000; seed++) {
    const first = setup.railyard.generateStationTracks(2, `review-${seed}`);
    const second = setup.railyard.generateStationTracks(2, `review-${seed}`);
    assert.equal(JSON.stringify(first), JSON.stringify(second), `seed ${seed}`);
    assert.ok(first.length >= 3 && first.length <= setup.railyard.MAX_GENERATED_YARD_TRACKS + 2,
      `${first.length - 2} yard tracks`);
    const cars = [];
    for (const track of first) {
      assert.ok(track.infinite || setup.railyard.getTrackOccupiedLength(track) <= track.length);
      assert.ok(track.infinite || track.length <= setup.railyard.MAX_GENERATED_TRACK_METRES, `${track.length} m track`);
      for (const train of track.trains) {
        assert.ok(train.length > 0);
        for (const car of train) {
          assert.ok(!cars.includes(car), 'Cars are independently cloned');
          cars.push(car);
          const accepted = setup.railyard.getAcceptedCargoTypes(car);
          let volume = 0, weight = 0;
          for (const cargo of car.cargo) {
            assert.ok(accepted.includes(cargo.type));
            volume += cargo.amount;
            weight += cargo.amount * State.variables.cargoTypes[cargo.type].density;
          }
          assert.ok(volume <= car.maxCargoCapacityVolume);
          assert.ok(weight <= car.maxCargoCapacityKg);
        }
      }
    }
  }
});

test('every station keeps a lead, and trains never land on one the station lacks', () => {
  const { setup } = loadGame();
  const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
  // A station flagged with neither lead keeps its exit, or the player could never leave it.
  assert.deepEqual({ ...setup.railyard.getLeads([lead({ hasLead: false }), { length: 100, trains: [] }, lead({ hasLead: false })]) },
    { entry: false, exit: true });
  assert.deepEqual({ ...setup.railyard.getLeads(setup.railyard.generateStationTracks(1, 'seed')) }, { entry: true, exit: true });
  assert.deepEqual({ ...setup.railyard.getLeads(setup.railyard.generateStationTracks(2, 'seed')) }, { entry: true, exit: true });
  // Explicit buffers stay closed, even if that disconnects malformed/debug track data.
  assert.deepEqual({ ...setup.railyard.getTrackConnections({ connectsToExit: false }, { entry: false, exit: true }) },
    { entry: false, exit: false });
  assert.equal(setup.railyard.getDeadEndText([lead({ hasLead: false }), { length: 100, trains: [], connectsToEntry: false }, lead()], 1), '');

  const tracks = [lead({ hasLead: false }), { length: 12, trains: [] }, lead()];
  assert.equal(setup.railyard.placeTrainInStationTracks(tracks, [{ length: 24 }], 0), true);
  assert.deepEqual(tracks.map(track => track.trains.length), [0, 0, 1]);
  // Overflow from a yard track goes to the exit when there is no entry track to take it.
  const overflow = [lead({ hasLead: false }), { length: 12, trains: [] }, lead()];
  assert.equal(setup.railyard.placeTrainInStationTracks(overflow, [{ length: 12 }, { length: 12 }], 1), true);
  assert.deepEqual(overflow.map(track => track.trains.length), [0, 1, 1]);
});

test('travel refuses a lead the station or the one it would arrive at does not have', () => {
  const { setup, State } = loadGame();
  const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
  const station = extra => [lead(extra && extra.entry), { length: 120, trains: [] }, lead(extra && extra.exit)];
  State.variables.stationTracks = {
    1: station({ entry: { hasLead: false } }),
    2: station(),
    3: station({ entry: { hasLead: false } })
  };
  State.variables.enteredTrainIndex = 0;
  assert.match(setup.railyard.getDepartureBlockReason(1, 1, false), /no Southbound Track/);
  assert.equal(setup.railyard.getDepartureBlockReason(1, 1, true), '');
  assert.match(setup.railyard.getDepartureBlockReason(2, 1, true), /Station 3 has no Southbound Track/);
  assert.equal(setup.railyard.getDepartureBlockReason(2, 1, false), '');
  State.variables.currentStation = 2;
  State.variables.currentTrain = [{ length: 18 }];
  State.variables.drivingTrackIndex = 1;
  assert.equal(setup.railyard.travelToStation(true), false);
  assert.equal(State.variables.currentStation, 2);
  assert.equal(setup.railyard.travelToStation(false), true);
  assert.equal(State.variables.currentStation, 1);
  assert.equal(State.variables.drivingTrackIndex, 2);
});

test('the debug lead control refuses every change that would strand the player', () => {
  const { setup, State } = loadGame();
  State.variables.stationTracks = {
    1: setup.railyard.generateStationTracks(1, 'seed'),
    2: setup.railyard.generateStationTracks(2, 'seed')
  };
  State.variables.currentStation = 2;
  assert.match(setup.railyard.setDebugLeads(1, true, true), /station 1/);
  assert.match(setup.railyard.setDebugLeads(2, false, false), /at least one way out/);
  assert.equal(setup.railyard.setDebugLeads(2, true, false), '');
  assert.deepEqual({ ...setup.railyard.getLeads(State.variables.stationTracks[2]) }, { entry: true, exit: false });
  State.variables.stationTracks[2][0].trains = [[{ length: 12 }]];
  assert.match(setup.railyard.setDebugLeads(2, false, true), /Track holds trains/);
});

test('lead tracks take their names from the route heading, not from entry and exit', () => {
  const { setup } = loadGame();
  const first = setup.railyard.generateStationTracks(1, 'compass');
  assert.equal(setup.railyard.getTrackLabel(first, 0), 'South Stub');
  assert.equal(setup.railyard.getTrackLabel(first, first.length - 1), 'Northbound Track');
  // Arriving at a station means its other lead points back down the leg just travelled.
  const second = setup.railyard.generateStationTracks(2, 'compass');
  assert.equal(setup.railyard.getLeadDirection(second, 'entry'),
    setup.railyard.oppositeDirection(setup.railyard.getLegHeading(1, 'compass')));
  assert.equal(setup.railyard.getLeadDirection(second, 'exit'), setup.railyard.getLegHeading(2, 'compass'));
  const headings = new Set();
  for (let seed = 0; seed < 10; seed++) {
    for (let stationId = 10; stationId <= 100; stationId++) {
      const heading = setup.railyard.getLegHeading(stationId, 'compass:' + seed);
      assert.ok(setup.railyard.HEADINGS.includes(heading), heading);
      headings.add(heading);
      assert.equal(heading, setup.railyard.getLegHeading(stationId, 'compass:' + seed));
    }
  }
  assert.deepEqual([...headings].sort(), [...setup.railyard.HEADINGS].sort());
  assert.equal(setup.railyard.getDirectionName('northeast'), 'North-eastbound');
  assert.equal(setup.railyard.getDirectionName('southwest'), 'South-westbound');
  // A station where the route turns is named for its own two headings.
  const turn = [{ infinite: true, trains: [], direction: 'west' }, { length: 100, trains: [], connectsToExit: false },
    { infinite: true, trains: [], direction: 'east' }];
  assert.equal(setup.railyard.getTrackLabel(turn, 0), 'Westbound Track');
  assert.equal(setup.railyard.getTrackLabel(turn, 2), 'Eastbound Track');
  assert.equal(setup.railyard.getDeadEndText(turn, 1), 'no link to the Eastbound Track');
});

test('the world map is the same every time and never enters save data', () => {
  const { setup, State } = loadGame();
  State.variables.randomSeed = 'world-a';
  const first = JSON.stringify(setup.worldmap.getLeg('world-a', 1));
  setup.worldmap.clearCache();
  assert.equal(JSON.stringify(setup.worldmap.getLeg('world-a', 1)), first);
  assert.notEqual(JSON.stringify(setup.worldmap.getLeg('world-b', 1)), first);
  // Stations stand where their legs end, so the world is one continuous line from the origin.
  assert.deepEqual({ ...setup.worldmap.getStationTile('world-a', 1) }, { x: 0, y: 0 });
  assert.deepEqual({ ...setup.worldmap.getStationTile('world-a', 3) }, { ...setup.worldmap.getLeg('world-a', 2).end });
  assert.ok(!JSON.stringify(State.variables).includes('terrain'), 'generated tiles must stay out of the save');
});

test('generated track joins up end to end and obeys the terrain rules', () => {
  const { setup } = loadGame();
  const straights = ['straight-ns', 'straight-ew', 'straight-nwse', 'straight-nesw'];
  for (const seed of ['alpha', 'beta', 'gamma']) {
    for (let legIndex = 1; legIndex <= 6; legIndex++) {
      const leg = setup.worldmap.getLeg(seed, legIndex);
      const mainLine = leg.tiles.filter(tile => !tile.branch);
      assert.ok(mainLine.length >= 9, `leg ${legIndex} has ${mainLine.length} tiles`);
      for (const tile of leg.tiles) {
        assert.notEqual(tile.terrain, 'water', 'no track is ever laid on water');
        assert.ok(setup.worldmap.SHAPES.includes(tile.shape), tile.shape);
        if (tile.terrain === 'bridge' || tile.terrain === 'tunnel') {
          assert.ok(straights.includes(tile.shape) || tile.shape === 'dead-end', `${tile.terrain} carries ${tile.shape}`);
        }
        if (tile.terrain === 'mountain') {
          assert.ok(!['t-junction', 'y-junction', 'cross'].includes(tile.shape), `mountain carries ${tile.shape}`);
        }
        assert.equal(tile.grade, Math.round(tile.grade / 0.5) * 0.5, `grade ${tile.grade}`);
        assert.ok(Math.abs(tile.grade) <= 5, `grade ${tile.grade}`);
      }
      // Each step lands on the next tile, and that tile has an end pointing back the way it came.
      for (let i = 0; i < mainLine.length - 1; i++) {
        const tile = mainLine[i];
        const direction = setup.worldmap.DIRECTIONS[tile.out];
        assert.deepEqual([tile.x + direction.dx, tile.y + direction.dy], [mainLine[i + 1].x, mainLine[i + 1].y],
          `leg ${legIndex} tile ${i} steps off the line`);
        assert.ok(mainLine[i + 1].ends.includes(setup.worldmap.opposite(tile.out)),
          `leg ${legIndex} tile ${i + 1} does not join the one before it`);
      }
    }
  }
});

test('grades and weight decide how long a leg takes and what can pull it', () => {
  const { setup, State } = loadGame();
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 400 }];
  const light = [loco];
  const heavy = [loco].concat([1, 2, 3, 4, 5, 6].map(() => {
    const car = JSON.parse(JSON.stringify(State.variables.defaultTrains.boxcar));
    car.cargo = [{ type: 'coal', amount: 200 }];
    return car;
  }));
  assert.ok(setup.worldmap.getClimbLimitPercent(light) > setup.worldmap.getClimbLimitPercent(heavy));
  assert.equal(setup.worldmap.getClimbLimitPercent(heavy),
    Math.round(setup.worldmap.getClimbLimitPercent(heavy) / 0.5) * 0.5);

  const grades = setup.worldmap.getLeg('grades', 1).tiles
    .filter(tile => !tile.branch && tile.out !== -1).map(tile => tile.grade);
  const out = setup.worldmap.getLegTravel('grades', 1, light, false);
  const back = setup.worldmap.getLegTravel('grades', 1, light, true);
  // The same steps are travelled either way round, so the grades simply change sign.
  assert.equal(out.steepestClimb, Math.max(0, ...grades));
  assert.equal(back.steepestClimb, Math.max(0, ...grades.map(grade => -grade)));
  assert.equal(out.kilometres, (out.tiles - 1) * 5);
  assert.ok(setup.worldmap.getLegTravel('grades', 1, heavy, false).minutes >= out.minutes);
});

test('a consist too heavy for the grades ahead is told so instead of travelling', () => {
  const { setup, State } = loadGame();
  State.variables.randomSeed = 'climb';
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 400 }];
  const heavy = [loco].concat([...Array(20)].map(() => {
    const car = JSON.parse(JSON.stringify(State.variables.defaultTrains.boxcar));
    car.cargo = [{ type: 'coal', amount: 3000 }];
    return car;
  }));
  // Find a leg this consist genuinely cannot pull, so the test is about the rule and not about the seed.
  let stationId = 1;
  while (stationId < 40 && setup.worldmap.getClimbBlockReason(stationId, true, heavy) === '') {
    stationId++;
  }
  assert.ok(stationId < 40, 'expected some leg to be too steep for a 20 car consist');
  const lead = () => ({ length: 999999, infinite: true, trains: [] });
  State.variables.stationTracks = { [stationId]: [lead(), { length: 400, trains: [] }, lead()] };
  State.variables.currentStation = stationId;
  State.variables.drivingTrackIndex = 1;
  State.variables.enteredTrainIndex = 0;
  State.variables.currentTrain = heavy;
  assert.match(setup.railyard.getDepartureBlockReason(stationId, 1, true), /climbs \d+\.\d% on the way/);
  assert.equal(setup.railyard.travelToStation(true), false);
  assert.equal(State.variables.currentStation, stationId);
  // The same line is no trouble for the locomotive on its own.
  State.variables.currentTrain = [loco];
  assert.equal(setup.worldmap.getClimbBlockReason(stationId, true, [loco]), '');
});

test('a journey runs tile by tile and ends by arriving at the station at either end', () => {
  const { setup, State } = loadGame();
  State.variables.randomSeed = 'journey';
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 400 }];
  const lead = () => ({ length: 999999, infinite: true, trains: [] });
  State.variables.stationTracks = { 2: [lead(), { length: 400, trains: [] }, lead()] };
  State.variables.currentStation = 2;
  State.variables.drivingTrackIndex = 1;
  State.variables.enteredTrainIndex = 0;
  State.variables.currentTrain = [loco];

  assert.equal(setup.railyard.departOntoLine(true), true);
  const tiles = setup.worldmap.getMainLine('journey', 2).length;
  assert.deepEqual({ ...State.variables.journey }, { legIndex: 2, tileIndex: 0, forward: true });
  assert.equal(setup.worldmap.getJourneyView().tileCount, tiles);
  // There is nothing behind the first tile: that end is the station the train just left.
  assert.equal(setup.worldmap.getJourneyStep(-1), null);

  let guard = 0;
  while (State.variables.journey && guard++ < 40) {
    const step = setup.worldmap.getJourneyStep(1);
    assert.ok(step.minutes >= 1, JSON.stringify(step));
    assert.equal(setup.railyard.moveAlongLine(1), true);
  }
  // Running the line out arrives at the next station, and the journey is over.
  assert.equal(State.variables.journey, null);
  assert.equal(State.variables.currentStation, 3);
  assert.equal(guard, tiles - 1);
  assert.equal(State.variables.drivingTrackIndex, setup.railyard.getEntryTrackIndex());
});

test('backing up on the line returns to the tile before, and the grades reverse with it', () => {
  const { setup, State } = loadGame();
  State.variables.randomSeed = 'journey';
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 400 }];
  const lead = () => ({ length: 999999, infinite: true, trains: [] });
  State.variables.stationTracks = { 2: [lead(), { length: 400, trains: [] }, lead()] };
  State.variables.currentStation = 2;
  State.variables.drivingTrackIndex = 1;
  State.variables.currentTrain = [loco];
  setup.railyard.departOntoLine(true);
  setup.railyard.moveAlongLine(1);
  setup.railyard.moveAlongLine(1);

  const ahead = setup.worldmap.getJourneyStep(1);
  const back = setup.worldmap.getJourneyStep(-1);
  assert.equal(back.toIndex, 1);
  assert.equal(State.variables.journey.tileIndex, 2);
  // The step back is the step just taken, downhill where that one climbed.
  const tiles = setup.worldmap.getMainLine('journey', 2);
  assert.equal(back.grade, -tiles[1].grade);
  assert.equal(ahead.grade, tiles[2].grade);
  assert.equal(setup.railyard.moveAlongLine(-1), true);
  assert.equal(State.variables.journey.tileIndex, 1);
  // The view reports the grade as the train faces it, which is the leg's grade when running forward.
  assert.equal(setup.worldmap.getJourneyView().grade, tiles[1].grade);
});

test('yard track lengths come from the shape of the yard, not from chance', () => {
  const { setup } = loadGame();
  const junction = setup.railyardTemplates.junctionMetres;
  // Leads at opposite corners: every track runs between the same pair of switches, so they all match.
  assert.deepEqual([...setup.railyard.getYardTrackLengths(4, 1, 4, 600)], [600, 600, 600, 600]);
  // Leads in the middle: the tracks between them run the full length, and each row beyond is a junction shorter.
  // Rows 2 and 3 lie between the leads and run full length; row 1 and row 4 are two junctions further out,
  // and row 5 is four.
  assert.deepEqual([...setup.railyard.getYardTrackLengths(5, 3, 2, 600)],
    [600 - 2 * junction, 600, 600, 600 - 2 * junction, 600 - 4 * junction]);
  // However wide the yard, the shortest track stays long enough to be worth having.
  const wide = setup.railyard.getYardTrackLengths(12, 1, 1, 150);
  assert.equal(Math.min(...wide), 120);
  assert.equal(Math.max(...wide), 120 + 22 * junction);

  // A generated station's through tracks are exactly what its own geometry implies; a siding is a stub, so it
  // stops short of the ladder on purpose.
  for (const stationId of [2, 3, 7, 11]) {
    const tracks = setup.railyard.generateStationTracks(stationId, 'shape-seed');
    const yard = tracks.slice(1, -1);
    const fromGeometry = setup.railyard.getYardTrackLengths(yard.length,
      setup.railyard.getLeadTrack(tracks, 'entry'), setup.railyard.getLeadTrack(tracks, 'exit'),
      Math.max(...yard.map(track => track.length)));
    yard.forEach((track, index) => {
      if (track.connectsToExit === false || track.connectsToEntry === false) {
        assert.ok(track.length < fromGeometry[index], `station ${stationId} siding ${index + 1}`);
      } else {
        assert.equal(track.length, fromGeometry[index], `station ${stationId} track ${index + 1}`);
      }
    });
  }
});

test('generated yards keep at least two tracks, and sidings show up among them', () => {
  const { setup } = loadGame();
  let tracksSeen = 0, sidings = 0, closedBoth = 0, onALead = 0, fromEntryLadder = 0, fromExitLadder = 0;
  let yardsWithoutAThroughTrack = 0;

  for (let seed = 0; seed < 200; seed++) {
    const tracks = setup.railyard.generateStationTracks(3, `siding-${seed}`);
    const yard = tracks.slice(1, -1);
    const entryRow = setup.railyard.getLeadTrack(tracks, 'entry');
    const exitRow = setup.railyard.getLeadTrack(tracks, 'exit');
    assert.ok(yard.length >= setup.railyard.MIN_GENERATED_YARD_TRACKS, `${yard.length} yard tracks`);
    tracksSeen += yard.length;
    let through = 0;
    yard.forEach((track, index) => {
      const closedEntry = track.connectsToEntry === false;
      const closedExit = track.connectsToExit === false;
      if (closedEntry || closedExit) {
        sidings++;
        if (closedExit) fromEntryLadder++;
        if (closedEntry) fromExitLadder++;
        if (index + 1 === entryRow || index + 1 === exitRow) onALead++;
      }
      if (closedEntry && closedExit) closedBoth++;
      if (!closedEntry && !closedExit) through++;
    });
    if (!through) yardsWithoutAThroughTrack++;
  }
  assert.ok(sidings > tracksSeen * 0.1, `${sidings} sidings among ${tracksSeen} tracks is too few`);
  // Stubs hang off both ladders, not only the one the player drives in on.
  assert.ok(fromEntryLadder > 0 && fromExitLadder > 0,
    `${fromEntryLadder} stubs trail from the entry ladder and ${fromExitLadder} hang from the exit ladder`);
  assert.equal(closedBoth, 0, 'a track is never closed at both ends');
  // A siding can trail off the northbound or southbound track itself, not only off a middle road.
  assert.ok(onALead > 0, 'sidings sometimes hang off a lead\'s own line');
  assert.equal(yardsWithoutAThroughTrack, 0, 'every yard keeps at least one track running from lead to lead');
});

test('decoupling is all or nothing, and never scatters cars onto other tracks', () => {
  const { setup, State } = loadGame();
  const lead = () => ({ infinite: true, length: 999999, trains: [] });
  const parked = [{ type: 'boxcar', length: 12 }];
  const mine = [{ type: 'diesel loco', length: 18 }, { type: 'boxcar', length: 12 }, { type: 'tanker car', length: 14 }];
  State.variables.stationTracks = { 1: [lead(), { length: 30, trains: [parked] }, lead()] };
  State.variables.currentStation = 1;
  State.variables.drivingTrackIndex = 1;
  State.variables.enteredTrainIndex = 1;
  State.variables.currentTrain = mine;
  State.variables.currentCarIndex = 0;

  // The rear section needs 26 m and the track has 18 m free, so the move is refused and nothing moves at all.
  assert.match(setup.railyard.getDecoupleBlockReason(false), /18 m free, and the section needs 26 m/);
  assert.equal(setup.railyard.decoupleSection(false), false);
  assert.deepEqual(mine.map(car => car.type), ['diesel loco', 'boxcar', 'tanker car']);
  assert.equal(State.variables.stationTracks[1][1].trains.length, 1);
  assert.equal(State.variables.stationTracks[1][0].trains.length, 0, 'nothing is pushed onto the lead track');

  // Given room, the section comes off and stays on the track the consist is standing on.
  State.variables.stationTracks[1][1].length = 100;
  assert.equal(setup.railyard.getDecoupleBlockReason(false), '');
  assert.equal(setup.railyard.decoupleSection(false), true);
  assert.deepEqual(mine.map(car => car.type), ['diesel loco']);
  assert.equal(State.variables.stationTracks[1][1].trains.length, 2);
  assert.equal(State.variables.stationTracks[1][0].trains.length, 0);
});

test('a burden and a reserve are read the same way round: red always means trouble', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };

  // A fresh player is fine on every stat, whichever direction that stat runs.
  assert.deepEqual([...setup.stats.getReadings().map(r => r.severity)], [0, 0, 0, 0, 0, 0]);
  assert.equal(setup.stats.getBand('fatigue'), 'Rested');
  assert.equal(setup.stats.getBand('immunity'), 'Strong');

  // A burden is worse the higher it climbs; a reserve is worse the further it falls. Fatigue is the only burden:
  // everything else reads as how much of something is left, so a full bar is always good news.
  assert.deepEqual([...setup.stats.LIST.filter(stat => stat.kind === 'burden').map(stat => stat.key)], ['fatigue']);
  assert.equal(setup.stats.getSeverity('fatigue', 85), 4);
  assert.equal(setup.stats.getSeverity('hunger', 85), 0);
  assert.equal(setup.stats.getBand('hunger', 85), 'Fed');
  assert.equal(setup.stats.getBand('hunger', 15), 'Wasting');
  assert.equal(setup.stats.getBand('health', 100), 'Unhurt');
  assert.equal(setup.stats.getBand('health', 10), 'Broken');
  assert.equal(setup.stats.getSeverity('immunity', 85), 0);
  assert.equal(setup.stats.getSeverity('immunity', 15), 4);
  assert.equal(setup.stats.getBand('sanity', 50), 'Fraying');

  // Moving a stat goes through one place, which clamps it and keeps it whole.
  assert.equal(setup.stats.adjust('fatigue', 30), 30);
  assert.equal(setup.stats.adjust('fatigue', 500), 100);
  assert.equal(setup.stats.adjust('fatigue', -1000), 0);
  assert.equal(setup.stats.setValue('thirst', 12.4), 12);
  assert.equal(setup.stats.getValue('thirst'), 12);

  // The worst reading is what a glance at the sidebar should land on.
  setup.stats.setValue('immunity', 10);
  setup.stats.setValue('hunger', 45);
  const worst = setup.stats.getWorst();
  assert.equal(worst.key, 'immunity');
  assert.equal(worst.band, 'Overwhelmed');
});

test('a stat bar knows its own scale and where trouble starts', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };

  // The marker sits where the stat first reads as severe: four fifths of the way up a burden, one fifth down
  // a reserve. It comes from the bands rather than from a number invented for the drawing.
  assert.equal(setup.stats.getThresholdPercent('fatigue'), 60);
  assert.equal(setup.stats.getThresholdPercent('hunger'), 40);
  assert.equal(setup.stats.getThresholdPercent('immunity'), 40);
  assert.equal(setup.stats.getThresholdPercent('sanity'), 40);
  assert.equal(setup.stats.getBand('fatigue', 60), 'Exhausted');
  assert.equal(setup.stats.getBand('immunity', 40), 'Failing');

  // The bar asks each stat for its scale rather than assuming everything runs to a hundred.
  assert.equal(setup.stats.getPercent('fatigue', 25), 25);
  setup.stats.getStat('fatigue').max = 200;
  assert.equal(setup.stats.getPercent('fatigue', 100), 50);
  assert.equal(setup.stats.getMax('fatigue'), 200);
  assert.equal(setup.stats.getMax('hunger'), 100);
});

test('a locomotive kit has a few slots, stacks what stacks, and the first engine comes equipped', () => {
  const { setup, State } = loadGame();
  const tutorial = setup.railyard.generateStationTracks(1, 'kit')[1].trains[0][0];
  assert.equal(tutorial.model, 'diesel-shunter');
  assert.deepEqual([...tutorial.inventory].map(slot => [slot.item, slot.count]),
    [['toolkit', 1], ['axe', 1], ['pump', 1], ['sleepingBag', 1], ['rations', 3], ['jerrycan', 1]]);

  // Generated locomotives start with nothing, and cars that are not locomotives have no kit at all.
  const loco = setup.railyard.createLocomotiveCar('steamShunter');
  assert.equal(setup.items.getKit(loco).length, 0);
  const tanker = setup.railyard.cloneCar(State.variables.defaultTrains.tanker);
  assert.equal(setup.items.add(tanker, 'pump', 1), 0);

  // Rations top up their stack before taking a new slot, and a full kit refuses the rest.
  assert.equal(setup.items.add(loco, 'rations', 8), 8);
  assert.deepEqual([...loco.inventory].map(slot => slot.count), [6, 2]);
  assert.equal(setup.items.add(loco, 'toolkit', 10), 4);
  assert.equal(loco.inventory.length, setup.items.SLOTS);
  assert.equal(setup.items.add(loco, 'pump', 1), 0);

  assert.equal(setup.items.remove(loco, 'rations', 9), false);
  assert.equal(setup.items.countItem(loco, 'rations'), 8);
  assert.equal(setup.items.remove(loco, 'rations', 3), true);
  assert.equal(setup.items.countItem(loco, 'rations'), 5);
  assert.equal(loco.inventory.length, 5);

  // A tool anywhere in the consist will do.
  assert.equal(setup.items.consistHas([tanker, loco], 'toolkit'), true);
  assert.equal(setup.items.consistHas([tanker, loco], 'pump'), false);
});

function refuelGame() {
  const game = loadGame();
  game.State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  game.State.variables.randomSeed = 'refuel';
  game.State.variables.currentStation = 2;
  return game;
}
const jobFor = (setup, train, index, id) => setup.refuel.getOptions(train, index).find(option => option.id === id);

test('refuelling pumps and shovels from coupled cars in batches that cost time and fatigue', () => {
  const { setup, State } = refuelGame();
  const defaults = State.variables.defaultTrains;
  const diesel = setup.railyard.createLocomotiveCar('dieselRoad');
  const tanker = setup.railyard.cloneCar(defaults.tanker);
  tanker.cargo = [{ type: 'water', amount: 5000 }];
  State.variables.currentTrain = [diesel, tanker];
  const job = id => jobFor(setup, State.variables.currentTrain, State.variables.currentTrain.indexOf(diesel), id);

  // Without a pump, and then without diesel to pump, the job says what is missing.
  assert.match(job('diesel-from-tanker').reason, /hand pump/);
  diesel.inventory = setup.items.createStartingKit();
  assert.match(job('diesel-from-tanker').reason, /holds diesel/);
  assert.equal(setup.refuel.perform('diesel-from-tanker', 0), false);

  tanker.cargo.push({ type: 'diesel', amount: 1000, grade: 60 });
  const pump = job('diesel-from-tanker');
  assert.deepEqual([pump.reason, pump.amountText, pump.minutes, pump.fatigue, pump.grade], ['', '400 L', 20, 3, 60]);
  assert.equal(setup.refuel.perform('diesel-from-tanker', 0), true);
  assert.equal(setup.railyard.getCargoAmount(diesel, 'diesel'), 400);
  assert.equal(setup.railyard.getCargoAmount(tanker, 'diesel'), 600);
  assert.equal(setup.fuel.getGrade(diesel, 'diesel'), 60);
  assert.equal(setup.stats.getValue('fatigue'), 3);
  // A diesel locomotive has no use for water, coal or wood.
  assert.equal(job('water-from-tanker'), undefined);
  assert.equal(job('cut-timber'), undefined);

  // The last batch stops when the tank is full rather than overfilling it.
  diesel.cargo = [{ type: 'diesel', amount: 5900 }];
  assert.equal(job('diesel-from-tanker').amountText, '100 L');
  diesel.cargo = [{ type: 'diesel', amount: 6000 }];
  assert.match(job('diesel-from-tanker').reason, /no more diesel/);

  // A steam locomotive shovels coal out of a gondola, a batch at a time, keeping the coal's grade.
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  const gondola = setup.railyard.cloneCar(defaults.gondola);
  gondola.cargo = [{ type: 'coal', amount: 1000, grade: 70 }];
  State.variables.currentTrain = [gondola, steam, tanker];
  assert.match(jobFor(setup, State.variables.currentTrain, 1, 'coal-from-gondola').reason, /toolkit/);
  steam.inventory = setup.items.createStartingKit();
  const shovel = jobFor(setup, State.variables.currentTrain, 1, 'coal-from-gondola');
  assert.deepEqual([shovel.reason, shovel.amountText, shovel.minutes, shovel.fatigue], ['', '200 kg', 8, 3]);
  assert.equal(setup.refuel.perform('coal-from-gondola', 1), true);
  assert.equal(setup.railyard.getCargoAmount(steam, 'coal'), 250);
  assert.equal(setup.railyard.getCargoAmount(gondola, 'coal'), 750);
  assert.equal(setup.fuel.getGrade(steam, 'coal'), 70);
  assert.equal(setup.refuel.perform('water-from-tanker', 1), true);
  assert.equal(setup.railyard.getCargoAmount(steam, 'water'), 400);
  assert.equal(setup.railyard.getCargoAmount(tanker, 'water'), 4600);
});

test('water for a steam engine can come from a station tank or from beside the line, where the world has one', () => {
  const { setup, State } = refuelGame();
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.inventory = setup.items.createStartingKit();
  State.variables.currentTrain = [steam];
  const job = id => jobFor(setup, [steam], 0, id);

  // Water tanks are a fact about each station, the same every time it is asked.
  const stations = Array.from({ length: 40 }, (_, i) => i + 1);
  const withTank = stations.find(id => setup.refuel.stationHasWaterTank(id));
  const withoutTank = stations.find(id => !setup.refuel.stationHasWaterTank(id));
  assert.ok(withTank && withoutTank, 'some stations have tanks and some do not');
  State.variables.currentStation = withTank;
  assert.equal(job('water-from-tank').reason, '');
  assert.equal(job('water-from-river'), undefined);
  assert.equal(setup.refuel.perform('water-from-tank', 0), true);
  assert.equal(setup.railyard.getCargoAmount(steam, 'water'), 400);
  State.variables.currentStation = withoutTank;
  assert.match(job('water-from-tank').reason, /no water tank/);
  assert.equal(Object.keys(State.variables).filter(key => /tank/i.test(key)).length, 0, 'tanks are never saved');

  // Out on the line, water is there to pump only where the map puts water next to the track.
  const seed = setup.worldmap.getSeed();
  const found = { wet: null, dry: null };
  for (let legIndex = 1; legIndex < 30 && !(found.wet && found.dry); legIndex++) {
    setup.worldmap.getMainLine(seed, legIndex).forEach((tile, tileIndex) => {
      const kind = setup.worldmap.isBesideWater(seed, tile.x, tile.y) ? 'wet' : 'dry';
      if (!found[kind]) found[kind] = { legIndex, tileIndex, forward: true };
    });
  }
  assert.ok(found.wet && found.dry, 'the line passes both water and dry land');
  State.variables.journey = found.dry;
  assert.match(job('water-from-river').reason, /no water beside the line/);
  assert.equal(job('water-from-tank'), undefined);
  State.variables.journey = found.wet;
  assert.equal(job('water-from-river').reason, '');
});

test('fuel grades blend by volume, derate a diesel, and make a firebox work harder', () => {
  const { setup } = loadGame();
  const fuel = setup.fuel;
  const diesel = setup.railyard.createLocomotiveCar('dieselShunter');
  fuel.addCargo(diesel, 'diesel', 300, 100);
  fuel.addCargo(diesel, 'diesel', 100, 0);
  assert.equal(diesel.cargo.length, 1, 'blending keeps one stack');
  assert.equal(fuel.getGrade(diesel, 'diesel'), 75);
  assert.match(fuel.describeGrade(95, 'diesel'), /bright shade of yellow/);
  assert.match(fuel.describeGrade(75, 'diesel'), /light amber/);
  assert.match(fuel.describeGrade(60, 'diesel'), /brown and hazy/);
  assert.match(fuel.describeGrade(45, 'diesel'), /dark and cloudy/);
  assert.match(fuel.describeGrade(35, 'diesel'), /pitch black/);
  assert.doesNotMatch(fuel.describeGrade(75, 'diesel'), /75%/);

  // Full power down to 90, falling to 40% at grade 40, and a dead engine below it.
  assert.equal(fuel.getDieselPowerFactor(95), 1);
  assert.equal(fuel.getDieselPowerFactor(40), 0.4);
  assert.ok(Math.abs(fuel.getDieselPowerFactor(75) - 0.82) < 1e-9);
  assert.equal(fuel.getDieselPowerFactor(39), 0);
  assert.ok(Math.abs(fuel.getEffectiveTractiveKN(diesel) - 82) < 1e-9);
  assert.equal(setup.railyard.isTrainDriveCapable([diesel]), true);
  diesel.cargo[0].grade = 35;
  assert.equal(fuel.getEffectiveTractiveKN(diesel), 0);
  assert.equal(setup.railyard.isTrainDriveCapable([diesel]), false);
  assert.equal(setup.railyard.consumeShuntingResourcesForMinute([diesel]), false);

  // Degraded diesel lowers the steepest grade a consist can pull.
  const good = setup.railyard.createLocomotiveCar('dieselShunter');
  fuel.addCargo(good, 'diesel', 400, 100);
  const poor = setup.railyard.createLocomotiveCar('dieselShunter');
  fuel.addCargo(poor, 'diesel', 400, 50);
  const boxcars = n => Array.from({ length: n }, () => ({ baseWeight: 20000, cargo: [] }));
  assert.ok(setup.worldmap.getClimbLimitPercent([poor, ...boxcars(6)]) < setup.worldmap.getClimbLimitPercent([good, ...boxcars(6)]));

  // Good coal: one kilogram a minute. Coal at grade 50 takes the grate's full two. Worse than that, the steam falls off.
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.fireboxEnabled = true;
  steam.cargo = [{ type: 'coal', amount: 100, grade: 50 }, { type: 'water', amount: 100 }];
  setup.railyard.processSteamFireboxMinuteForCar(steam);
  assert.equal(steam.fireboxEnabled, true);
  assert.ok(Math.abs(setup.railyard.getCargoAmount(steam, 'coal') - 97.5) < 1e-9);
  steam.cargo[0].grade = 25;
  assert.ok(Math.abs(fuel.getFireboxOutput(steam) - 0.5) < 1e-9);
  const before = steam.steamStoredLiters;
  setup.railyard.processSteamFireboxMinuteForCar(steam);
  assert.equal(steam.fireboxEnabled, true);
  assert.ok(steam.steamStoredLiters > before);
  assert.ok(Math.abs(setup.railyard.getCargoAmount(steam, 'water') - (97 - 1.5)) < 1e-9, 'water boils off with the heat');

  // Firewood burns first, and it takes more of it: dry wood gives a little over half the heat of good coal.
  const woodBurner = setup.railyard.createLocomotiveCar('steamShunter');
  woodBurner.fireboxEnabled = true;
  woodBurner.cargo = [{ type: 'coal', amount: 100 }, { type: 'firewood', amount: 100, grade: 100 }, { type: 'water', amount: 100 }];
  setup.railyard.processSteamFireboxMinuteForCar(woodBurner);
  assert.equal(setup.railyard.getCargoAmount(woodBurner, 'coal'), 100);
  assert.ok(Math.abs(setup.railyard.getCargoAmount(woodBurner, 'firewood') - (100 - (1 / 0.55) / 0.4)) < 1e-9);
});

test('wood comes from gondolas, is cut from timber aboard, and is felled green in a forest', () => {
  const { setup, State } = refuelGame();
  const defaults = State.variables.defaultTrains;
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  const flatcar = setup.railyard.cloneCar(defaults.flatcar);
  flatcar.cargo = [{ type: 'timber', amount: 1000, grade: 80 }];
  const gondola = setup.railyard.cloneCar(defaults.gondola);
  gondola.cargo = [{ type: 'firewood', amount: 1000, grade: 90 }];
  State.variables.currentTrain = [steam, flatcar, gondola];
  const job = id => jobFor(setup, State.variables.currentTrain, 0, id);

  // Loading firewood needs no tools; cutting timber needs the axe.
  assert.equal(job('firewood-from-gondola').reason, '');
  assert.match(job('cut-timber').reason, /axe and bow saw/);
  steam.inventory = setup.items.createStartingKit();

  // Cutting keeps the weight and the grade: 150 kg of timber is 150 kg of firewood, stacked looser.
  const cut = job('cut-timber');
  assert.deepEqual([cut.reason, cut.amountText, cut.minutes, cut.fatigue, cut.grade], ['', '150 kg', 10, 6, 80]);
  assert.equal(setup.refuel.perform('cut-timber', 0), true);
  assert.equal(setup.railyard.getCargoAmount(flatcar, 'timber'), 750);
  assert.equal(setup.railyard.getCargoAmount(steam, 'firewood'), 375);
  assert.equal(setup.refuel.perform('firewood-from-gondola', 0), true);
  assert.equal(setup.railyard.getCargoAmount(steam, 'firewood'), 875);
  assert.ok(Math.abs(setup.fuel.getGrade(steam, 'firewood') - (375 * 80 + 500 * 90) / 875) < 0.05, 'blended to a tenth');

  // There is nothing to fell in a station, and out on the line only in a forest.
  assert.match(job('chop-trees').reason, /no trees/);
  const seed = setup.worldmap.getSeed();
  let forest = null;
  let open = null;
  for (let legIndex = 1; legIndex < 40 && !(forest && open); legIndex++) {
    setup.worldmap.getMainLine(seed, legIndex).forEach((tile, tileIndex) => {
      if (tile.terrain === 'forest' && !forest) forest = { legIndex, tileIndex, forward: true };
      if (tile.terrain !== 'forest' && !open) open = { legIndex, tileIndex, forward: true };
    });
  }
  assert.ok(forest && open, 'the line runs through forest and out of it');
  State.variables.journey = open;
  assert.match(job('chop-trees').reason, /no trees/);
  State.variables.journey = forest;
  const chop = job('chop-trees');
  assert.deepEqual([chop.reason, chop.amountText, chop.minutes, chop.fatigue, chop.grade], ['', '300 kg', 30, 21, 50]);
  assert.equal(setup.refuel.perform('chop-trees', 0), true);
  assert.equal(setup.railyard.getCargoAmount(flatcar, 'timber'), 1250, 'felled timber goes onto the flatcar');
  assert.ok(Math.abs(setup.fuel.getGrade(flatcar, 'timber') - (750 * 80 + 500 * 50) / 1250) < 0.05);
  // A diesel crew can fell trees too, but has no firebox to cut wood for.
  const diesel = setup.railyard.createLocomotiveCar('dieselShunter');
  assert.ok(jobFor(setup, [diesel, flatcar], 0, 'chop-trees'));
  assert.equal(jobFor(setup, [diesel, flatcar], 0, 'cut-timber'), undefined);
});

test('the four locomotives differ in pull, speed and art, and a consist runs at its slowest', () => {
  const { setup, State } = loadGame();
  const keys = ['dieselShunter', 'dieselRoad', 'steamShunter', 'steamPrairie'];
  assert.deepEqual([...setup.railyard.locomotiveKeys], keys);
  const locos = keys.map(key => setup.railyard.createLocomotiveCar(key));
  assert.deepEqual(locos.map(loco => setup.railyard.getLocomotiveModel(loco)),
    ['diesel-shunter', 'diesel-road', 'steam-shunter', 'steam-prairie']);
  const templates = new Set([...setup.railyardTemplates.templates].map(t => t.passage));
  const driving = new Set([...setup.drivingTemplates.templates].map(t => t.passage));
  locos.forEach(loco => {
    for (const side of ['right', 'left']) {
      assert.ok(templates.has('railyard-loco-' + loco.model + '-' + side), loco.model + ' yard art');
      assert.ok(driving.has('driving-loco-' + loco.model + '-' + side), loco.model + ' driving art');
    }
  });
  // Locomotives saved before models existed are drawn as shunters.
  assert.equal(setup.railyard.getLocomotiveModel({ type: 'steam loco' }), 'steam-shunter');

  const [shunter, road] = locos;
  shunter.cargo = [{ type: 'diesel', amount: 500 }];
  road.cargo = [{ type: 'diesel', amount: 500 }];
  assert.equal(setup.worldmap.getTileMinutes(0, [road]), 3);
  assert.equal(setup.worldmap.getTileMinutes(0, [shunter]), 8);
  // Only the locomotive being driven works. Another one in the consist is hauled in neutral: it adds its weight,
  // like a boxcar would, but no pull, no speed limit and no fuel burn.
  State.variables.currentCarIndex = 0;
  const pair = [road, shunter];
  const ballast = [road, { baseWeight: shunter.baseWeight, cargo: [{ type: 'diesel', amount: 500 }] }];
  assert.equal(setup.worldmap.getTopSpeedKmh(pair), 100);
  assert.equal(setup.worldmap.getTrainTractiveKN(pair), 320);
  assert.equal(setup.worldmap.getClimbLimitPercent(pair), setup.worldmap.getClimbLimitPercent(ballast));
  assert.equal(setup.worldmap.getTileMinutes(3, pair), setup.worldmap.getTileMinutes(3, ballast));
  assert.equal(setup.railyard.consumeShuntingResourcesForMinute(pair), true);
  assert.equal(setup.railyard.getCargoAmount(shunter, 'diesel'), 500, 'the hauled shunter burns nothing');
  road.cargo = [{ type: 'diesel', amount: 500 }];
  // Driving from the shunter instead, the road diesel is the one along for the ride.
  State.variables.currentCarIndex = 1;
  assert.equal(setup.worldmap.getTopSpeedKmh(pair), 40);
  assert.equal(setup.worldmap.getTrainTractiveKN(pair), 100);
  // A dead locomotive in front does not stop the one being driven, and a live one cannot rescue a dead one.
  road.cargo = [];
  assert.equal(setup.railyard.isTrainDriveCapable(pair), true);
  State.variables.currentCarIndex = 0;
  assert.equal(setup.railyard.isTrainDriveCapable(pair), false);
  State.variables.currentCarIndex = undefined;
  road.cargo = [{ type: 'diesel', amount: 500 }];
  // A road diesel burns more for its power.
  assert.equal(setup.railyard.consumeShuntingResourcesForMinute([road]), true);
  assert.equal(setup.railyard.getCargoAmount(road, 'diesel'), 490, 'a big engine drinks ten litres a minute');
  // The Prairie's bigger firebox raises steam faster than the shunter's.
  const [, , small, prairie] = locos;
  [small, prairie].forEach(loco => {
    loco.fireboxEnabled = true;
    loco.cargo = [{ type: 'coal', amount: 1000 }, { type: 'water', amount: 1000 }];
    setup.railyard.processSteamFireboxMinuteForCar(loco);
  });
  assert.ok(prairie.steamStoredLiters > small.steamStoredLiters * 2);
});

test('forests grow on the map, carry any track, and are drawn', () => {
  const { setup } = loadGame();
  const counts = {};
  for (let x = -40; x < 40; x++) {
    for (let y = 0; y < 400; y += 2) {
      const terrain = setup.worldmap.getBaseTerrain('forests', x, y);
      counts[terrain] = (counts[terrain] || 0) + 1;
    }
  }
  const land = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(counts.forest / land > 0.08 && counts.forest / land < 0.35, JSON.stringify(counts));
  assert.equal(setup.worldmap.canPlace('forest', 'cross'), true);
  assert.ok([...setup.drivingTemplates.templates].some(t => t.passage === 'driving-terrain-forest'));
});

test('the sun follows the clock, the season and the latitude, and grades the pictures without flattening them', () => {
  const { setup } = loadGame();
  const light = setup.daylight;
  const at = (month, day, hour) => Date.UTC(2000, month, day, hour);
  // Punta Arenas: a high summer sun, a low winter one, and the sun well down at midnight.
  assert.ok(Math.abs(light.getSunElevation(at(11, 21, 12), -53.2) - 60) < 2);
  assert.ok(Math.abs(light.getSunElevation(at(5, 21, 12), -53.2) - 13.4) < 2);
  assert.ok(light.getSunElevation(at(5, 21, 0), -53.2) < -50);
  // Further north the winter noon sun stands higher.
  assert.ok(light.getSunElevation(at(5, 21, 12), -30) > light.getSunElevation(at(5, 21, 12), -53.2) + 20);

  assert.equal(light.getLight(40).phase, 'day');
  assert.equal(light.getLight(6).phase, 'golden');
  assert.equal(light.getLight(-6).phase, 'dusk');
  assert.equal(light.getLight(-20).phase, 'night');

  // Daytime pictures are exactly the art. A cab window only keeps its glow in the car the player is in; every
  // other cab is dark, because there is nobody in it to light the lamp.
  const day = light.getLight(40), night = light.getLight(-20);
  assert.equal(light.grade('#7a8780', day), '#7a8780');
  assert.equal(light.grade('#dec38a', night, 'subject', true), '#dec38a');
  assert.notEqual(light.grade('#dec38a', night, 'subject'), '#dec38a');

  const luma = hex => { const [r, g, b] = light.parseHex(hex).map(c => light.toLinear(c)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [r, g, b] = light.parseHex(light.grade('#a87555', night));
  assert.ok(b > r * 0.8, 'night turns warm colours towards moonlight blue');
  assert.ok(luma(light.grade('#a87555', night)) < luma('#a87555') * 0.7, 'night is darker');
  // A light colour stays lighter than a dark one, by about the same ratio: night is a grade, not a grey wash.
  const ratio = (a, c) => (luma(a) + 0.01) / (luma(c) + 0.01);
  assert.ok(ratio(light.grade('#b8b6a0', night), light.grade('#232626', night)) > ratio('#b8b6a0', '#232626') * 0.5);
  // The train stays brighter than the scenery behind it.
  assert.ok(luma(light.grade('#4a5640', night, 'subject')) > luma(light.grade('#4a5640', night, 'backdrop')));
});

function survivalGame() {
  const game = loadGame();
  game.State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  game.State.variables.randomSeed = 'survival';
  game.State.variables.currentStation = 1;
  game.State.variables.gameTimeTimestampMs = Date.UTC(2000, 6, 24, 9, 0);
  return game;
}
// Runs the clock the way the game does, without the fuel and firebox systems getting in the way.
function live(setup, minutes, mode) {
  for (let i = 0; i < minutes; i++) {
    setup.condition.tickMinute(mode);
    setup.time.setCurrentTimestampMs(setup.time.getCurrentTimestampMs() + 60000);
  }
}

test('the hours wear the player down at the rates the design asks for', () => {
  const { setup, State } = survivalGame();
  // Doing nothing at all, and keeping fed and watered, a player lasts about a day before they drop.
  const topUp = () => { setup.stats.setValue('hunger', 100); setup.stats.setValue('thirst', 100); };
  for (let hour = 0; hour < 24; hour++) { topUp(); live(setup, 60); }
  const idleFatigue = setup.stats.getValue('fatigue');
  assert.ok(idleFatigue > 90 && idleFatigue < 100, `a day of idling should nearly fill the bar, got ${idleFatigue}`);
  assert.equal(setup.condition.isCollapsed(), false);
  topUp();
  live(setup, 2 * 60);
  assert.equal(setup.condition.isCollapsed(), true, 'somewhere past 24 hours it fills');

  // Hunger and thirst run down on their own, thirst faster, and nothing else has moved without cause.
  const { setup: fresh, State: freshState } = survivalGame();
  live(fresh, 12 * 60);
  assert.ok(Math.abs(fresh.stats.getValue('hunger') - 50) <= 2, fresh.stats.getValue('hunger'));
  assert.ok(Math.abs(fresh.stats.getValue('thirst') - 14) <= 3, fresh.stats.getValue('thirst'));
  assert.equal(fresh.stats.getValue('health'), 100);
  assert.ok(freshState.variables.player.sanity >= 100);
});

test('hunger, thirst and a failing body make work harder and rest worth less', () => {
  const { setup } = survivalGame();
  assert.equal(setup.condition.getFatigueMultiplier(), 1);
  assert.equal(setup.condition.getRestEfficiency(), 1);

  setup.stats.setValue('hunger', 0);
  setup.stats.setValue('thirst', 0);
  setup.stats.setValue('immunity', 20);
  assert.ok(setup.condition.getFatigueMultiplier() > 1.8, setup.condition.getFatigueMultiplier());
  assert.ok(setup.condition.getRestEfficiency() < 0.45, setup.condition.getRestEfficiency());

  // An empty stomach and a dry throat eat into health and immunity; a fed, watered, rested player mends.
  const before = { health: setup.stats.getValue('health'), immunity: setup.stats.getValue('immunity') };
  live(setup, 5 * 60);
  assert.ok(setup.stats.getValue('health') < before.health, 'starving costs health');
  assert.ok(setup.stats.getValue('immunity') < before.immunity, 'starving costs immunity');

  setup.stats.setValue('hunger', 100);
  setup.stats.setValue('thirst', 100);
  setup.stats.setValue('fatigue', 0);
  const mending = setup.stats.getValue('health');
  live(setup, 10 * 60);
  assert.ok(setup.stats.getValue('health') > mending, 'a fed, watered, rested player mends');
});

test('sleep clears the bar, the small hours cost sanity, and collapsing is not a substitute for rest', () => {
  const { setup, State } = survivalGame();
  setup.stats.setValue('fatigue', 100);
  live(setup, 8 * 60, 'sleep');
  assert.equal(setup.stats.getValue('fatigue'), 0, 'eight hours of good sleep clears a full bar');

  // Being awake in the small hours frays the mind; sleeping through them mends it three times as fast.
  State.variables.gameTimeTimestampMs = Date.UTC(2000, 6, 25, 0, 30);
  setup.stats.setValue('sanity', 50);
  State.variables.player.carry = {};
  live(setup, 4 * 60);
  const awake = setup.stats.getValue('sanity');
  assert.ok(awake < 50, `a night awake costs sanity, got ${awake}`);
  State.variables.gameTimeTimestampMs = Date.UTC(2000, 6, 26, 0, 30);
  setup.stats.setValue('sanity', 50);
  State.variables.player.carry = {};
  live(setup, 4 * 60, 'sleep');
  assert.ok(setup.stats.getValue('sanity') > 50 + (50 - awake), 'sleeping through the night mends it faster');

  // Collapsing takes hours and gives back only a quarter of the bar, and costs sanity.
  setup.stats.setValue('fatigue', 100);
  setup.stats.setValue('sanity', 60);
  const clockBefore = setup.time.getCurrentTimestampMs();
  const collapse = setup.condition.collapse();
  assert.ok(collapse.minutes >= 120 && collapse.minutes <= 360, collapse.minutes);
  assert.equal(setup.stats.getValue('fatigue'), 75, 'a faint is worth a quarter of the bar, no more');
  // The faint itself costs eight, of which the hours out cold mend a little back.
  assert.ok(setup.stats.getValue('sanity') < 58 && setup.stats.getValue('sanity') > 50, setup.stats.getValue('sanity'));
  assert.equal(setup.time.getCurrentTimestampMs() - clockBefore, collapse.minutes * 60000);
  assert.deepEqual(JSON.parse(JSON.stringify(State.variables.pendingCollapse)), { minutes: collapse.minutes });
});

test('eating and drinking fill the needs, and their quality decides what they do to immunity', () => {
  const { setup, State } = survivalGame();
  const loco = setup.railyard.createLocomotiveCar('steamShunter');
  loco.inventory = setup.items.createStartingKit();
  setup.fuel.addCargo(loco, 'water', 500, 40); // river water, straight from the tank
  const train = [loco];
  State.variables.currentTrain = train;

  setup.stats.setValue('hunger', 20);
  setup.stats.setValue('thirst', 20);
  setup.stats.setValue('immunity', 60);
  assert.equal(setup.condition.countRations(train), 3);
  assert.equal(setup.condition.eat(train), true);
  assert.equal(setup.stats.getValue('hunger'), 54);
  assert.equal(setup.condition.countRations(train), 2);
  assert.equal(setup.stats.getValue('immunity'), 60 + Math.round(-6 + 7.5 * 0.7), 'decent rations help a little');

  // Dirty water fills the need but costs immunity.
  const immunityBefore = setup.stats.getValue('immunity');
  assert.equal(setup.condition.drink(train), true);
  assert.equal(setup.stats.getValue('thirst'), 60);
  assert.equal(setup.railyard.getCargoAmount(loco, 'water'), 498);
  assert.ok(setup.stats.getValue('immunity') < immunityBefore, 'river water makes you ill');

  // Clean water from a station tank is better for you.
  setup.fuel.addCargo(loco, 'water', 2000, 90);
  const clean = setup.stats.getValue('immunity');
  setup.stats.setValue('thirst', 20);
  assert.equal(setup.condition.drink(train), true);
  assert.ok(setup.stats.getValue('immunity') >= clean, 'clean water does not make you ill');

  // Nothing to eat or drink is reported rather than silently doing nothing.
  setup.items.remove(loco, 'rations', 2);
  assert.equal(setup.condition.eat(train), false);
  loco.cargo = [];
  assert.equal(setup.condition.drink(train), false);
  assert.equal(setup.condition.hasBedroll(train), true);
});

test('an action link says what it costs the body as well as the clock', () => {
  const { setup } = loadGame();
  // The link itself carries the clock.
  assert.equal(setup.time.formatLinkLabel('Drive ahead 5 km', 8), 'Drive ahead 5 km (0:08)');
  assert.equal(setup.time.formatLinkLabel('Sleep', 480), 'Sleep (8:00)');
  // The stats it moves are written beside it, by name, and carry their own colour.
  assert.equal(setup.effects.describe('fatigue:+1'), '+Fatigue');
  assert.equal(setup.effects.describe('fatigue:+3'), '+++Fatigue');
  assert.equal(setup.effects.describe('fatigue:-3'), '\u2212\u2212\u2212Fatigue');
  assert.equal(setup.effects.describe('hunger:+2,immunity:+1'), '++Hunger, +Immunity');
  assert.equal(setup.effects.describeHtml('fatigue:+2'),
    '<span class="effects"><span class="effect effect-fatigue">++Fatigue</span></span>');
  assert.equal(setup.effects.describeHtml(''), '');
  // The level follows from the job's own rate, so the table of jobs decides the wording.
  assert.deepEqual([0.15, 0.4, 0.7].map(rate => setup.effects.levelForRate(rate)), [1, 2, 3]);
});

test('a cold boiler reaches working pressure in the time a real one would', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  const fire = key => {
    const loco = setup.railyard.createLocomotiveCar(key);
    loco.cargo = [{ type: 'coal', amount: 9999 }, { type: 'water', amount: 9999 }];
    loco.fireboxEnabled = true;
    const marks = { working: 0, full: 0 };
    for (let minute = 1; minute <= 24 * 60; minute++) {
      setup.railyard.processSteamFireboxMinuteForCar(loco);
      const bar = setup.railyard.getSteamPressureBar(loco);
      if (!marks.working && bar >= 10) marks.working = minute;
      if (!marks.full && bar >= setup.railyard.getSteamMaxPressureBar(loco) - 0.05) { marks.full = minute; break; }
    }
    marks.coal = 9999 - setup.railyard.getCargoAmount(loco, 'coal');
    marks.capacity = loco.maxCargoCapacityVolume;
    return marks;
  };

  // A shunter: about three quarters of an hour to working pressure, about two to full.
  const shunter = fire('steamShunter');
  assert.ok(shunter.working >= 35 && shunter.working <= 55, `shunter working pressure at ${shunter.working} min`);
  assert.ok(shunter.full >= 90 && shunter.full <= 140, `shunter full pressure at ${shunter.full} min`);
  // A big engine: about three hours to working pressure, and the best part of a day's firing to full.
  const prairie = fire('steamPrairie');
  assert.ok(prairie.working >= 150 && prairie.working <= 220, `prairie working pressure at ${prairie.working} min`);
  assert.ok(prairie.full >= 380 && prairie.full <= 560, `prairie full pressure at ${prairie.full} min`);
  // Warming up has to be affordable: the coal it takes must fit in the locomotive that burns it.
  assert.ok(shunter.coal < shunter.capacity / 4, `shunter burns ${shunter.coal} L warming up`);
  assert.ok(prairie.coal < prairie.capacity / 4, `prairie burns ${prairie.coal} L warming up`);

  // A boiler saved by an older build is normalised to the size this model is built with now.
  const old = setup.railyard.createLocomotiveCar('steamShunter');
  old.boilerSteamVolumeLiters = 300000;
  setup.railyard.ensureSteamLocomotiveState(old);
  assert.equal(old.boilerSteamVolumeLiters, 5000);
});

test('a branch is a route the player can take, and some of them find the main line again', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.randomSeed = 'branchy';
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 4000 }];
  State.variables.currentTrain = [loco];

  // Across a stretch of the world, branches both dead-end and rejoin, and every rejoin lands further along.
  let dead = 0, rejoining = 0;
  for (let legIndex = 1; legIndex < 40; legIndex++) {
    setup.worldmap.getLeg('branchy', legIndex).branches.forEach(branch => {
      assert.ok(branch.tiles.length > 0);
      if (branch.rejoinIndex === null) { dead++; return; }
      rejoining++;
      assert.ok(branch.rejoinIndex > branch.fromIndex, `${branch.id} rejoins at ${branch.rejoinIndex}`);
    });
  }
  assert.ok(dead > 0 && rejoining > 0, `${dead} dead ends and ${rejoining} rejoining branches`);

  // Find a leg with a branch, stand on its junction, and take it.
  let found = null;
  for (let legIndex = 1; legIndex < 40 && !found; legIndex++) {
    const branch = setup.worldmap.getLeg('branchy', legIndex).branches.find(candidate => candidate.rejoinIndex !== null);
    if (branch) found = { legIndex, branch };
  }
  assert.ok(found, 'some leg has a rejoining branch');
  State.variables.journey = { legIndex: found.legIndex, tileIndex: found.branch.fromIndex, forward: true };

  const choices = setup.worldmap.getBranchChoices();
  assert.ok(choices.some(choice => choice.id === found.branch.id), JSON.stringify(choices));
  assert.equal(choices[0].tiles, setup.worldmap.getLeg('branchy', found.legIndex).branches
    .find(branch => branch.id === choices[0].id).tiles.length);

  // Taking it puts the train on the branch, where the view and the steps follow the branch instead of the line.
  assert.equal(setup.railyard.takeBranch(found.branch.id), true);
  assert.equal(setup.worldmap.getJourneyView().branch, found.branch.id);
  assert.equal(setup.worldmap.getJourneyView().tileCount, found.branch.tiles.length);
  assert.equal(setup.worldmap.getBranchChoices().length, 0, 'no branching off a branch');

  // Backing up from the first tile returns to the junction on the main line.
  const back = setup.worldmap.getJourneyStep(-1);
  assert.equal(back.toMain, found.branch.fromIndex);
  assert.equal(setup.railyard.moveAlongLine(-1), true);
  assert.equal(State.variables.journey.branch, null);
  assert.equal(State.variables.journey.tileIndex, found.branch.fromIndex);

  // Running the branch to its far end puts the train back on the main line further along.
  setup.railyard.takeBranch(found.branch.id);
  for (let guard = 0; guard < 20 && State.variables.journey.branch; guard++) {
    assert.equal(setup.railyard.moveAlongLine(1), true);
  }
  assert.equal(State.variables.journey.branch, null);
  assert.equal(State.variables.journey.tileIndex, found.branch.rejoinIndex);
  assert.ok(found.branch.rejoinIndex > found.branch.fromIndex);
});

test('terrain is read off a tile climate of latitude, longitude, height, warmth and damp', () => {
  const { setup } = loadGame();
  const world = setup.worldmap;

  // Station 1 stands at Punta Arenas, and the map runs north from it.
  const home = world.getClimate('climate', 0, 0);
  assert.ok(Math.abs(home.latitude - (-53.2)) < 0.01);
  assert.ok(Math.abs(home.longitude - (-70.9)) < 0.01);
  const north = world.getClimate('climate', 0, 200);
  assert.ok(north.latitude > home.latitude, 'north is north');
  assert.ok(Math.abs(north.latitude - (-53.2 + 200 * 5 / 111)) < 0.01);

  // It is warmer at the equator than at either end of the world, and colder up a mountain than beside it.
  const equator = Math.round((53.2 * 111) / 5);
  const warm = world.getClimate('climate', 0, equator);
  assert.ok(warm.temperature > home.temperature + 10, `${warm.temperature} vs ${home.temperature}`);
  const flat = { ...world.getClimate('climate', 3, equator) };
  const high = world.getClimate('climate', 3, equator);
  assert.equal(Math.round(high.temperature - (flat.temperature)), 0, 'the same tile reads the same every time');

  // The dry belt sits where the trade winds put it, and the equator is wet.
  const dryBelt = world.getClimate('climate', 0, Math.round(((53.2 - 27) * 111) / 5));
  assert.ok(dryBelt.humidity < warm.humidity, `${dryBelt.humidity} vs ${warm.humidity}`);

  // Terrain follows those numbers: no deserts in the wet, no forests in the ice.
  let checked = 0;
  for (let x = -20; x < 20; x++) {
    for (let y = 0; y < 2600; y += 37) {
      const terrain = world.getBaseTerrain('climate', x, y);
      if (terrain === 'water') continue;
      const climate = world.getClimate('climate', x, y);
      checked++;
      if (terrain === 'desert') assert.ok(climate.humidity < world.DESERT_HUMIDITY && climate.temperature >= world.ARCTIC_TEMPERATURE);
      if (terrain === 'forest') assert.ok(climate.humidity > world.FOREST_HUMIDITY && climate.temperature >= world.ARCTIC_TEMPERATURE);
      if (terrain === 'arctic') assert.ok(climate.temperature < world.ARCTIC_TEMPERATURE);
      if (terrain === 'mountain') assert.ok(climate.elevation > world.MOUNTAIN_METRES);
    }
  }
  assert.ok(checked > 1000, `${checked} tiles checked`);
});

test('each locomotive is worth choosing: range, speed and pull sit in sensible bands', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.randomSeed = 'balance';
  const car = key => setup.railyard.cloneCar(State.variables.defaultTrains[key]);

  const measure = key => {
    const loco = car(key);
    if (setup.railyard.isDieselLocomotiveCar(loco)) {
      setup.fuel.addCargo(loco, 'diesel', loco.maxCargoCapacityVolume, 90);
    } else {
      setup.fuel.addCargo(loco, 'coal', loco.maxCargoCapacityVolume * 0.35, 90);
      setup.fuel.addCargo(loco, 'water', loco.maxCargoCapacityVolume * 0.6, 80);
      loco.fireboxEnabled = true;
      for (let m = 0; m < 3000 && setup.railyard.getSteamPressureBar(loco) < 14; m++) {
        setup.railyard.processSteamFireboxMinuteForCar(loco);
      }
    }
    State.variables.currentTrain = [loco];
    State.variables.currentCarIndex = 0;
    // Measured with fuel aboard: an empty locomotive pulls nothing at all.
    const solo = setup.worldmap.getClimbLimitPercent([loco]);
    const laden = setup.worldmap.getClimbLimitPercent([loco, ...Array.from({ length: 5 }, () => car('boxcar'))]);
    let minutes = 0;
    while (minutes < 20000) {
      setup.railyard.processSteamFireboxMinuteForCar(loco);
      if (!setup.railyard.consumeShuntingResourcesForMinute([loco])) break;
      minutes++;
    }
    const legMinutes = setup.worldmap.getTileMinutes(0, [loco]) * 12;
    return { legs: minutes / legMinutes, speed: loco.topSpeedKmh, solo: solo, laden: laden };
  };

  const locos = {};
  setup.railyard.locomotiveKeys.forEach(key => { locos[key] = measure(key); });

  // Every locomotive runs a good few legs on a full load, and none of them runs for ever: refuelling is a
  // decision, not an errand, and not a wall either.
  Object.keys(locos).forEach(key => {
    assert.ok(locos[key].legs > 8 && locos[key].legs < 25, `${key} runs ${locos[key].legs.toFixed(1)} legs on a load`);
  });
  // Road engines are the fast ones; shunters are not.
  assert.ok(locos.dieselRoad.speed > locos.dieselShunter.speed * 2);
  assert.ok(locos.steamPrairie.speed > locos.steamShunter.speed * 2);
  // A road diesel out-pulls everything, and five empty boxcars are within reach of all of them.
  assert.ok(locos.dieselRoad.laden > locos.steamPrairie.laden);
  Object.keys(locos).forEach(key => {
    assert.ok(locos[key].laden > setup.worldmap.GRADE_LIMIT, `${key} cannot pull five empty boxcars up the steepest grade`);
  });
  // Weight still tells: a loaded train is a different proposition from an empty one.
  const loaded = Array.from({ length: 5 }, () => {
    const boxcar = car('boxcar');
    setup.fuel.addCargo(boxcar, 'coal', 40000, 80);
    return boxcar;
  });
  const fuelled = car('dieselRoad');
  setup.fuel.addCargo(fuelled, 'diesel', 5000, 95);
  State.variables.currentTrain = [fuelled];
  State.variables.currentCarIndex = 0;
  const heavy = setup.worldmap.getClimbLimitPercent([fuelled, ...loaded]);
  assert.ok(heavy < locos.dieselRoad.laden * 0.75, `a loaded train pulls ${heavy}% against ${locos.dieselRoad.laden}% empty`);
  // And a long, loaded train cannot take the steepest grades the world has at all, which is the soft limit on
  // length the design asks for: weight is the reason to run short.
  const longTrain = Array.from({ length: 10 }, () => {
    const boxcar = car('boxcar');
    setup.fuel.addCargo(boxcar, 'coal', 50000, 80);
    return boxcar;
  });
  assert.ok(setup.worldmap.getClimbLimitPercent([fuelled, ...longTrain]) < setup.worldmap.GRADE_LIMIT,
    'ten loaded boxcars are too much for the steepest grades');
});

test('imperial is a way of writing a number down, not a different number', () => {
  const { setup, State } = loadGame();
  State.variables.randomSeed = 'units';
  State.variables.currentStation = 1;

  // Metric by default, and everything reads to a tenth at most.
  assert.equal(setup.units.kilometres(5), '5 km');
  assert.equal(setup.units.kilometresPerHour(40), '40 km/h');
  assert.equal(setup.units.tonnes(32), '32 t');
  assert.equal(setup.units.litres(400), '400 L');
  assert.equal(setup.units.temperature(6.28), '6.2°C');

  State.variables.imperialUnits = true;
  assert.equal(setup.units.kilometres(5), '3.1 mi');
  assert.equal(setup.units.kilometresPerHour(40), '24 mph');
  assert.equal(setup.units.tonnes(32), '35.2 tons');
  assert.equal(setup.units.litres(400), '105.6 gal');
  assert.equal(setup.units.temperature(0), '32°F');
  assert.equal(setup.units.temperature(-10), '14°F');
  // Tenths are truncated, not rounded up, so a reading never claims more than it has.
  assert.equal(setup.units.temperature(21.999), '71.5°F');
  assert.equal(setup.units.kilometres(1.6099), '1 mi');

  // The outside temperature comes from the climate of the tile the player is standing on.
  const climate = setup.worldmap.getClimate(setup.worldmap.getSeed(), 0, 0);
  assert.ok(Math.abs(setup.units.getOutsideTemperature() - climate.temperature) < 0.001);
});

test('the date can be written four ways, and the clock behind it never changes', () => {
  const { setup, State } = loadGame();
  State.variables.gameTimeTimestampMs = Date.UTC(2000, 6, 4, 15, 7);
  const parts = () => setup.time.getCurrentDateParts();
  assert.deepEqual([...setup.time.DATE_FORMATS.map(format => format[0])], ['long', 'dmy', 'mdy', 'ymd']);

  State.variables.dateFormat = 'long';
  assert.equal(setup.time.formatDate(parts()), 'July 4, 2000');
  State.variables.dateFormat = 'dmy';
  assert.equal(setup.time.formatDate(parts()), '04/07/2000');
  State.variables.dateFormat = 'mdy';
  assert.equal(setup.time.formatDate(parts()), '07/04/2000');
  State.variables.dateFormat = 'ymd';
  assert.equal(setup.time.formatDate(parts()), '2000/07/04');

  // The clock is separate from the date, and follows the 24-hour setting.
  assert.equal(setup.time.formatClock(parts()), '3:07 PM');
  State.variables.use24HourTime = true;
  assert.equal(setup.time.formatClock(parts()), '15:07');
  assert.equal(setup.time.getCurrentTimestampMs(), Date.UTC(2000, 6, 4, 15, 7));
});

test('a branch that never finds the main line ends at a station of its own', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.randomSeed = 'termini';
  State.variables.stationTracks = {};
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.cargo = [{ type: 'diesel', amount: 1400 }];
  State.variables.currentTrain = [loco];
  State.variables.currentCarIndex = 0;

  // Every branch either rejoins the line or runs to a terminus; none of them simply stops in open country.
  let terminus = null;
  for (let legIndex = 1; legIndex < 25; legIndex++) {
    setup.worldmap.getLeg('termini', legIndex).branches.forEach(branch => {
      assert.ok(branch.rejoinIndex !== null || branch.stationId, `${branch.id} leads nowhere`);
      if (branch.stationId && !terminus) terminus = { legIndex, branch };
      if (branch.stationId) {
        const last = branch.tiles[branch.tiles.length - 1];
        assert.equal(last.station, branch.stationId, 'the last tile is the station');
      }
    });
  }
  assert.ok(terminus, 'some branch runs to a terminus');
  assert.match(terminus.branch.stationId, /^L\d+B\d+$/);
  assert.equal(setup.worldmap.isBranchStation(terminus.branch.stationId), true);
  assert.equal(setup.worldmap.isBranchStation(4), false);
  assert.equal(setup.worldmap.getStationName(terminus.branch.stationId), 'Station ' + terminus.branch.stationId.slice(1));

  // The terminus is a real station: a yard to shunt in, with one way in and out.
  const tracks = setup.railyard.generateStationTracks(terminus.branch.stationId, 'termini');
  assert.ok(tracks.length >= 4, `${tracks.length} tracks`);
  const leads = setup.railyard.getLeads(tracks);
  assert.equal(leads.entry, true);
  assert.equal(leads.exit, false, 'a terminus has no way on');
  assert.ok(setup.railyard.HEADINGS.includes(tracks[0].direction), tracks[0].direction);

  // Driving out to the end of the branch arrives there, and leaving again puts the train back on the branch.
  State.variables.journey = { legIndex: terminus.legIndex, tileIndex: terminus.branch.fromIndex, forward: true };
  assert.equal(setup.railyard.takeBranch(terminus.branch.id), true);
  for (let guard = 0; guard < 20 && State.variables.journey; guard++) {
    if (!setup.railyard.moveAlongLine(1)) break;
  }
  assert.equal(State.variables.journey, null, 'the journey ends at the terminus');
  assert.equal(State.variables.currentStation, terminus.branch.stationId);
  assert.ok(State.variables.stationTracks[terminus.branch.stationId], 'its yard was generated on arrival');

  assert.equal(setup.railyard.departOntoLine(false), true);
  assert.equal(State.variables.journey.branch, terminus.branch.id);
  assert.equal(State.variables.journey.tileIndex, terminus.branch.tiles.length - 1);
  // And from there the only way is back toward the junction.
  assert.equal(setup.worldmap.getJourneyStep(1), null);
  assert.ok(setup.worldmap.getJourneyStep(-1));
});

test('a dead car in the road has to be shunted, and another engine can be robbed of its fuel', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };

  // About one station in five has a derelict standing in it: no cargo, no room for any, and nothing to loot.
  let stations = 0;
  let derelicts = 0;
  for (let stationId = 2; stationId < 102; stationId++) {
    const tracks = setup.railyard.generateStationTracks(stationId, 'junk');
    const cars = tracks.flatMap(track => (track.trains || []).flat());
    const found = cars.filter(car => setup.railyard.isDerelictCar(car));
    stations++;
    if (found.length) {
      derelicts++;
      assert.deepEqual([...found[0].cargo], []);
      assert.deepEqual([...found[0].acceptedCargo], [], 'nothing can be loaded into a derelict');
      assert.equal(setup.refuel.getRoom(found[0], 'coal'), 0);
      assert.match(found[0].name, /^derelict /);
    }
  }
  assert.ok(derelicts > stations * 0.1 && derelicts < stations * 0.35, `${derelicts} of ${stations} stations`);

  // Siphoning: another locomotive is a fuel source, and each one is offered separately.
  State.variables.currentStation = 5;
  State.variables.drivingTrackIndex = 1;
  const mine = setup.railyard.createLocomotiveCar('dieselShunter');
  mine.inventory = setup.items.createStartingKit();
  const coupled = setup.railyard.createLocomotiveCar('dieselRoad');
  setup.fuel.addCargo(coupled, 'diesel', 3000, 80);
  const parked = setup.railyard.createLocomotiveCar('dieselRoad');
  setup.fuel.addCargo(parked, 'diesel', 500, 40);
  State.variables.stationTracks = { 5: [{ infinite: true, trains: [] }, { length: 300, trains: [[parked]] }, { infinite: true, trains: [] }] };
  State.variables.currentTrain = [mine, coupled];
  State.variables.currentCarIndex = 0;

  const options = setup.refuel.getSiphonOptions(State.variables.currentTrain, 0);
  assert.equal(options.length, 2, JSON.stringify(options.map(option => option.label)));
  assert.match(options[0].label, /Siphon diesel from the six axle road diesel in your consist/);
  assert.match(options[1].label, /parked alongside/);

  // Taking a batch moves it, at the grade it was stored at, and costs the work it should.
  assert.equal(setup.refuel.performSiphon(options[0].id, 0), true);
  assert.equal(setup.railyard.getCargoAmount(mine, 'diesel'), 400);
  assert.equal(setup.railyard.getCargoAmount(coupled, 'diesel'), 2600);
  assert.equal(setup.fuel.getGrade(mine, 'diesel'), 80);
  assert.equal(setup.stats.getValue('fatigue'), 5);

  // A steam locomotive takes coal and water instead, and a locomotive with nothing aboard is not offered.
  const steam = setup.railyard.createLocomotiveCar('steamShunter');
  steam.inventory = setup.items.createStartingKit();
  const donor = setup.railyard.createLocomotiveCar('steamPrairie');
  setup.fuel.addCargo(donor, 'coal', 2000, 70);
  setup.fuel.addCargo(donor, 'water', 5000, 60);
  State.variables.stationTracks[5][1].trains = [];
  State.variables.currentTrain = [steam, donor];
  const steamOptions = setup.refuel.getSiphonOptions(State.variables.currentTrain, 0).map(option => option.id.split(':')[0]);
  assert.deepEqual([...steamOptions], ['siphon-water', 'siphon-coal']);
});

test('the player can climb down, walk the line, fell trees by hand, and carry what they cut', () => {
  const { setup, State } = loadGame();
  State.variables.player = { fatigue: 0, health: 100, immunity: 100, sanity: 100, hunger: 100, thirst: 100 };
  State.variables.randomSeed = 'onfoot';
  const loco = setup.railyard.createLocomotiveCar('dieselShunter');
  loco.inventory = setup.items.createStartingKit();
  loco.cargo = [{ type: 'diesel', amount: 400 }];
  const flatcar = setup.railyard.cloneCar(State.variables.defaultTrains.flatcar);
  State.variables.currentTrain = [loco, flatcar];
  State.variables.currentCarIndex = 0;

  // Find a leg with a forest tile on it, and stand the train there.
  const seed = setup.worldmap.getSeed();
  let spot = null;
  for (let legIndex = 1; legIndex < 30 && !spot; legIndex++) {
    setup.worldmap.getMainLine(seed, legIndex).forEach((tile, tileIndex) => {
      if (!spot && tile.terrain === 'forest' && tileIndex > 0 && tileIndex < setup.worldmap.getMainLine(seed, legIndex).length - 1) {
        spot = { legIndex, tileIndex };
      }
    });
  }
  assert.ok(spot, 'the line runs through a forest somewhere');
  State.variables.journey = { legIndex: spot.legIndex, tileIndex: spot.tileIndex, forward: true };

  // Climbing down puts the player beside the train, where the train's tools are still to hand.
  assert.equal(setup.onfoot.isOnFoot(), false);
  assert.equal(setup.onfoot.climbDown(), true);
  assert.equal(setup.onfoot.isBesideTrain(), true);
  assert.equal(setup.onfoot.hasTool('axe'), true, 'the axe is in the cab, and the cab is right there');
  assert.equal(setup.onfoot.canChop(), '');

  // Felling by hand fills the player's arms rather than a car, and costs real effort.
  assert.equal(setup.onfoot.chop(), true);
  const carried = setup.items.getPlayerCarriedKg();
  assert.ok(Math.abs(carried - setup.items.PLAYER_CARRY_KG) < 0.001, `carrying ${carried} kg`);
  assert.equal(setup.items.getPlayerCargo()[0].type, 'timber');
  assert.equal(setup.items.getPlayerCargo()[0].grade, setup.onfoot.CHOP_GRADE);
  assert.ok(setup.stats.getValue('fatigue') >= 20, setup.stats.getValue('fatigue'));
  assert.match(setup.onfoot.canChop(), /carrying all you can/);

  // Beside the train, what is carried can go into a car with room for it.
  assert.equal(setup.onfoot.stow(), true);
  assert.equal(setup.items.getPlayerCarriedKg(), 0);
  assert.ok(setup.railyard.getCargoAmount(flatcar, 'timber') > 0);

  // A tile away, the train's tools are no longer to hand: only what the player packed.
  assert.ok(setup.onfoot.getWalk(1));
  assert.equal(setup.onfoot.walk(1), true);
  assert.equal(setup.onfoot.isBesideTrain(), false);
  assert.equal(setup.onfoot.hasTool('axe'), false);
  assert.equal(setup.items.takeFromCar(loco, 'axe'), true, 'the axe can be packed before setting off');
  assert.equal(setup.items.playerHas('axe'), true);
  assert.equal(setup.items.countItem(loco, 'axe'), 0);
  assert.equal(setup.onfoot.hasTool('axe'), true);
  assert.equal(setup.items.takeFromCar(loco, 'pump'), true, 'the pump fits below the axe');
  const pack = setup.items.getPlayerPackLayout();
  assert.equal(setup.items.PLAYER_GRID_WIDTH * setup.items.PLAYER_GRID_HEIGHT, 16);
  assert.equal(setup.items.getPlayerPackSquares(), 10, 'an axe is 2 by 2 and a pump is 3 by 2');
  assert.equal(pack.overflow.length, 0);
  // Putting tools back frees their physical space in the pack.
  assert.equal(setup.items.giveToCar(loco, 'axe'), true);
  assert.equal(setup.items.giveToCar(loco, 'pump'), true);
  assert.equal(setup.items.playerHas('axe'), false);

  // Walking back to the train is the only way to ride again.
  assert.equal(setup.onfoot.climbAboard(), false);
  assert.equal(setup.onfoot.walk(-1), true);
  assert.equal(setup.onfoot.isBesideTrain(), true);
  assert.equal(setup.onfoot.climbAboard(), true);
  assert.equal(State.variables.onFoot, null);
});
