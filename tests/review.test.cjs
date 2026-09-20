const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame } = require('./helpers.cjs');

test('raw food can be packed and eaten; ration yield improves only with an intact kitchen', () => {
  const g = game([lead(), road(), lead()]), { setup:s, State:{variables:v} }=g;
  const box=s.railyard.cloneCar(v.defaultTrains.boxcar); box.cargo=[{type:'food',amount:20,grade:60}];
  v.currentTrain.push(box); v.player.hunger=0;
  assert.equal(s.food.take(),true);
  assert.equal(s.food.count('rawFood'),1);
  assert.equal(s.items.getPlayerCarriedKg(),0.5);
  assert.equal(box.cargo[0].amount,19);
  assert.equal(s.food.eatRaw(),true); assert.equal(v.player.hunger,8);
  assert.equal(s.food.craftPlan().count,2);
  assert.equal(s.food.craft(),true); assert.equal(s.food.count('rations'),2);
  assert.equal(s.condition.eat(v.currentTrain),true); assert.equal(v.player.hunger,42);
  v.currentTrain.push(s.railyard.cloneCar(v.defaultTrains.kitchenCar));
  assert.equal(s.food.craftPlan().count,3);
  v.currentTrain.at(-1).broken=true;
  assert.equal(s.food.craftPlan().count,2);
});

test('food preparation validates weight and grid before taking ingredients; carried food works away from train', () => {
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  v.currentTrain[0].cargo.push({type:'food',amount:20});
  v.player.carried=Array.from({length:16},()=>({item:'rations',count:6}));
  const before=JSON.stringify(v.player.carried), food=v.currentTrain[0].cargo[1].amount;
  assert.equal(s.food.craft(),false); assert.equal(JSON.stringify(v.player.carried),before);
  assert.equal(v.currentTrain[0].cargo[1].amount,food);
  v.player.carried=[{item:'rawFood',count:3,grade:45}];
  v.player.carriedCargo=[{type:'water',amount:2,grade:35}];
  v.journey={legIndex:1,tileIndex:0,forward:true}; v.onFoot={tileIndex:1,branch:null};
  assert.equal(s.food.craft(),true);
  v.player.hunger=0; assert.equal(s.condition.eat(v.currentTrain),true); assert.equal(v.player.hunger,34);
  v.player.thirst=0; assert.equal(s.condition.drink(v.currentTrain),true); assert.equal(v.player.thirst,40);
  assert.equal(s.items.getPlayerCargo().length,0);
  assert.equal(s.food.take(),false,'cannot reach train cargo remotely');
});

test('firebox refuses absent fuel or water at the model boundary',()=>{
  const {setup:s}=game([lead(),road(),lead()]); const engine=s.railyard.createLocomotiveCar('steamShunter');
  engine.cargo=[]; assert.equal(s.railyard.setSteamFireboxEnabled(engine,true),false);
  engine.cargo=[{type:'coal',amount:50,grade:80}]; assert.equal(s.railyard.setSteamFireboxEnabled(engine,true),false);
  engine.cargo.push({type:'water',amount:300}); assert.equal(s.railyard.setSteamFireboxEnabled(engine,true),true);
  assert.equal(s.railyard.setSteamFireboxEnabled(engine,false),true);
});

test('empty engines can collect finite station fuel and recover from the line without propulsion',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  v.currentTrain[0].cargo=[];
  const before=s.recovery.stock(2).diesel;
  assert.equal(s.recovery.collect(2,'diesel',true),true);
  assert.equal(s.recovery.stock(2).diesel,before-400);
  assert.equal(s.railyard.isTrainDriveCapable(v.currentTrain),true);
  v.currentTrain[0].cargo=[];v.journey={legIndex:1,tileIndex:2,forward:true};
  assert.equal(s.onfoot.climbDown(),true);
  const route=s.recovery.stations()[0],clock=s.time.getCurrentTimestampMs();
  assert.equal(s.recovery.collect(route.station,'diesel',false),true);
  assert.ok(s.time.getCurrentTimestampMs()>clock);
  assert.ok(s.items.getPlayerCarriedKg()<=50);
  assert.equal(s.recovery.load('diesel'),true);
  assert.equal(s.railyard.isTrainDriveCapable(v.currentTrain),true);
  assert.equal(s.items.getPlayerCargo().length,0);
  v.player.carriedCargo=[{type:'water',amount:50}];
  assert.equal(s.recovery.plan(route.station,'diesel',false),null);
});

test('generated broken stock cannot provide supplies, storage, or power and never destroys escape reserves',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  let coaches=0, brokenCoaches=0, freight=0, brokenFreight=0;
  for(let i=2;i<42;i++) {
    const tracks=s.railyard.generateStationTracks(i,'broken-review');
    assert.equal(s.yardGeneration.validate(tracks),true);
    assert.equal(tracks[0].supplies.diesel,s.recovery.INITIAL_STOCK.diesel);
    for(const track of tracks) for(const train of track.trains) for(const car of train) {
      if(/coach|observation|kitchen|private/.test(car.type)) {coaches++;if(car.broken)brokenCoaches++;}
      else if(!car.fuelReserve) {freight++;if(car.broken)brokenFreight++;}
      if(car.broken) {assert.equal(car.cargo.length,0);assert.equal(s.refuel.getRoom(car,'food'),0); assert.equal(s.items.getKit(car).length,0);}
      if(car.fuelReserve) assert.ok(!car.broken);
    }
  }
  assert.ok(brokenCoaches/coaches>brokenFreight/freight+0.2);
  v.currentTrain[0].broken=true; assert.equal(s.railyard.isTrainDriveCapable(v.currentTrain),false);
});

test('reported seed and branch termini draw their true incoming connection, not the first sorted end',()=>{
  const {setup:s}=game([lead(),road(),lead()]);
  for(const seed of ['1832963771','review','branch-check']) for(let leg=1;leg<12;leg++) {
    const generated=s.worldmap.getLeg(seed,leg),main=s.worldmap.getMainLine(seed,leg);
    for(const b of generated.branches) {
      b.tiles.forEach((tile,i)=>{
        const previous=i?b.tiles[i-1]:main[b.fromIndex];
        assert.ok(tile.ends.includes(s.worldmap.directionBetween(tile,previous)),`${seed} (${tile.x},${tile.y}) connects back`);
      });
    }
  }
});

test('journal records actual moves and visits and resets for a new run',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  s.journal.travel();s.journal.visit(2);s.journal.visit(2);s.journal.visit('L1B1');
  assert.equal(v.journal.kilometres,5);assert.equal(v.journal.stations.length,3);
  const restored=JSON.parse(JSON.stringify(v.journal));assert.equal(restored.stations[2],'L1B1');
  s.startNewRun();assert.equal(v.journal.kilometres,0);assert.equal(v.journal.stations.length,1);
});

test('save wrappers respect failed storage writes and keep autosaves outside manual slots',()=>{
  const g=game([lead(),road(),lead()]),s=g.setup.saves;
  s.refresh=()=>{};let count=0,manual=0,auto=0;s.countSave=()=>count++;
  g.Save.slots={save:()=>{manual++;return false;}};
  assert.equal(s.save(0),false);assert.equal(count,0);assert.match(s.message,/Save failed/);
  g.Save.autosave={save:()=>{auto++;return true;}};
  assert.equal(s.save(0,true),true);assert.equal(manual,1);assert.equal(auto,1);assert.equal(count,1);
  g.Save.slots.save=()=>{throw new Error('quota');};assert.equal(s.save(0),false);assert.equal(count,1);
});

test('depleted depots lead to a longer supply run without replenishing looted fuel',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  s.recovery.stock(2).diesel=0;
  const route=s.recovery.supplyRoutes('diesel').at(-1);
  assert.equal(route.station,3);assert.ok(route.distance>0);
  assert.equal(s.recovery.plan(3,'diesel',true),null,'cannot carry a bulk tank fill on foot');
  assert.ok(s.recovery.plan(3,'diesel',false));
  assert.equal(s.recovery.stock(2).diesel,0);
  assert.equal(s.recovery.collect(3,'diesel',false),true);
  assert.ok(s.items.getPlayerCarriedKg()<=50);
});

test('a steam bunker filled with only one resource can be unloaded to make room for the other',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  const engine=s.railyard.createLocomotiveCar('steamShunter');engine.cargo=[{type:'coal',amount:7000,grade:80}];
  v.currentTrain=[engine];assert.equal(s.refuel.getRoom(engine,'water'),0);
  assert.equal(s.recovery.drain('coal'),true);assert.ok(s.refuel.getRoom(engine,'water')>0);
  assert.equal(s.recovery.collect(2,'water',true),true);assert.equal(s.railyard.canLightFirebox(engine),true);
});

test('food quality survives kit transfers and zero-grade carried water is not purified by blending',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]),car=v.currentTrain[0];
  v.player.carried=[{item:'rations',count:1,grade:0}];
  assert.equal(s.items.giveToCar(car,'rations'),true);
  assert.equal(s.items.takeFromCar(car,'rations'),true);
  assert.equal(v.player.carried[0].grade,0);
  s.items.addPlayerCargo('water',2,0);s.items.addPlayerCargo('water',2,100);
  assert.equal(s.items.getPlayerCargo()[0].grade,50);
});

test('diesel and steam can complete multi-station runs on generated depot supplies',()=>{
  for(const model of ['dieselShunter','dieselRoad','steamShunter','steamPrairie']) {
    const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);v.randomSeed='release-route-'+model;
    v.currentTrain=[s.railyard.createLocomotiveCar(model)];v.currentTrain[0].cargo=[];
    for(let station=2;station<12;station++) {
      v.currentStation=station;v.stationTracks[station]=s.railyard.generateStationTracks(station,v.randomSeed);
      v.drivingTrackIndex=0;v.enteredTrainIndex=0;v.journey=null;
      const steam=model.startsWith('steam'),engine=v.currentTrain[0];
      engine.fireboxEnabled=false;
      if(steam) {
        // Keep the bunker balanced so coal cannot fill all of the shared tank capacity.
        const waterTarget=model==='steamShunter'?4800:16000;
        const coalTarget=model==='steamShunter'?1500:5000;
        for(const [type,target] of [['water',waterTarget],['coal',coalTarget]])
          while(s.railyard.getCargoAmount(engine,type)<target && s.recovery.plan(station,type,true)) s.recovery.collect(station,type,true);
        assert.equal(s.railyard.setSteamFireboxEnabled(engine,true),true);
        s.time.advanceMinutesWithSystems(model==='steamShunter'?120:540,'generic');
      } else while(s.recovery.plan(station,'diesel',true)) s.recovery.collect(station,'diesel',true);
      assert.equal(s.railyard.departOntoLine(true),true,model+' depart '+station);
      let guard=0;
      while(v.journey && guard++<100) {
        const step=s.worldmap.getJourneyStep(1);assert.ok(step&&!step.blocked);
        if(!s.time.advanceMinutesWithSystems(step.minutes,'travel')) {
          assert.ok(steam,'diesel reserve covers the route');
          assert.ok(engine.fireboxEnabled,'steam has fuel and water');
          s.time.advanceMinutesWithSystems(30,'generic');continue;
        }
        assert.equal(s.railyard.moveAlongLine(1),true);
      }
      assert.ok(guard<100,model+' finishes '+station);
      assert.equal(v.currentStation,station+1);
    }
    assert.ok(v.journal.kilometres>=400);
  }
});

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
