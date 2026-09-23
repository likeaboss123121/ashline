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
  v.player.carriedCargo=[{type:'water',amount:2,grade:35},{type:'firewood',amount:7.5,grade:50}];
  v.journey={legIndex:1,tileIndex:0,forward:true}; v.onFoot={tileIndex:1,branch:null};
  assert.equal(s.food.craft(),false,'outdoor cooking needs a fire');
  assert.equal(s.campfire.build(),true);
  assert.equal(s.food.craft(),true);
  v.player.hunger=0; assert.equal(s.condition.eat(v.currentTrain),true); assert.equal(v.player.hunger,34);
  v.player.thirst=0; assert.equal(s.condition.drink(v.currentTrain),true); assert.equal(v.player.thirst,40);
  assert.equal(s.items.getPlayerCargo().length,0);
  assert.equal(s.food.take(),false,'cannot reach train cargo remotely');
});

test('campfires support wilderness cooking and sleep, while passenger cars provide distinct rest tiers',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  v.journey={legIndex:1,tileIndex:1,forward:true};v.onFoot={tileIndex:1,branch:null};
  v.currentTrain[0].cargo.push({type:'firewood',amount:20,grade:50});
  v.player.carried=[{item:'rawFood',count:3,grade:60}];
  const wood=s.railyard.getCargoAmount(v.currentTrain[0],'firewood');
  assert.equal(s.campfire.canBuild(),true);assert.equal(s.campfire.build(),true);
  assert.equal(s.railyard.getCargoAmount(v.currentTrain[0],'firewood'),wood-7.5);
  assert.equal(s.condition.getSleepComfort().multiplier,1.25);
  assert.equal(s.food.craftPlan().campfire,true);

  v.onFoot=null;v.journey=null;v.player.carried=[];
  for(const [key,multiplier] of [['passengerCoach',1],['sleeperCoach',1.25],['privateCar',1.5]]) {
    v.currentTrain=[s.railyard.cloneCar(v.defaultTrains[key])];v.currentCarIndex=0;
    assert.equal(s.condition.hasBedroll(v.currentTrain),true,key);
    assert.equal(s.condition.getSleepComfort().multiplier,multiplier,key);
  }
  v.player.carried=[{item:'rawFood',count:3,grade:60}];
  assert.equal(s.food.craftPlan().count,3,'a private car includes an intact kitchen');
});

test('private cars are much rarer than every other ordinary car',()=>{
  const {setup:s}=game([lead(),road(),lead()]),rng=s.railyard.mulberry32(12345),counts={};
  for(let i=0;i<18000;i++) {const key=s.railyard.randomCarKey(rng);counts[key]=(counts[key]||0)+1;}
  for(const key of s.railyard.carKeys) if(key!=='privateCar') assert.ok(counts[key]>counts.privateCar*3,key+' '+JSON.stringify(counts));
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
  v.currentTrain[0].inventory=s.items.createStartingKit();
  // Stranded well out on a long leg, several tiles from either station.
  const legIndex=Object.values(s.realWorldPilot.getGridRoute().legs).find(leg=>leg.tiles.length>=10).index,stranded=5;
  v.currentTrain[0].cargo=[];v.journey={legIndex,tileIndex:stranded,forward:true};
  assert.equal(s.onfoot.climbDown(),true);
  assert.equal(s.recovery.supplyRoutes('diesel').length,0,'no station collection is offered from a distant tile');
  assert.equal(s.items.takeFromCar(v.currentTrain[0],'jerrycan'),true);
  v.onFoot.tileIndex=0;
  const route=s.recovery.supplyRoutes('diesel')[0],clock=s.time.getCurrentTimestampMs();
  assert.equal(route.station,legIndex);
  assert.equal(s.recovery.collect(route.station,'diesel',false),true);
  assert.ok(s.time.getCurrentTimestampMs()>clock);
  assert.ok(s.items.getPlayerCarriedKg()<=50);
  assert.ok(s.items.getPlayerCargo().find(stack=>stack.type==='diesel').amount<=20);
  v.onFoot.tileIndex=stranded;
  assert.equal(s.items.giveToCar(v.currentTrain[0],'jerrycan'),false,'a filled jerrycan cannot be stowed without its diesel');
  assert.equal(s.recovery.load('diesel'),true);
  assert.equal(s.items.giveToCar(v.currentTrain[0],'jerrycan'),true);
  assert.equal(s.railyard.isTrainDriveCapable(v.currentTrain),true);
  assert.equal(s.items.getPlayerCargo().length,0);
  v.player.carriedCargo=[{type:'water',amount:50}];
  assert.equal(s.recovery.plan(route.station,'diesel',false),null);
});

test('walking crosses both branch junctions and returns to a stranded train without moving it',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  const tile=(x,y,out)=>({x,y,out,terrain:'plains',grade:0});
  const main=[tile(0,0,0),tile(0,1,0),tile(0,2,0),tile(0,3,0)];
  const branch={id:'B1',fromIndex:1,rejoinIndex:3,direction:2,tiles:[tile(1,1,0),tile(1,2,6)]};
  s.worldmap.getLeg=()=>({tiles:main,branches:[branch]});
  s.worldmap.getMainLine=()=>main;
  v.journey={legIndex:1,tileIndex:0,branch:'B1',forward:false};
  const parked=JSON.stringify(v.journey);
  assert.equal(s.onfoot.climbDown(),true);
  assert.equal(s.onfoot.walk(-1),true,'can leave the branch at its starting junction');
  assert.equal(v.onFoot.branch,null); assert.equal(v.onFoot.tileIndex,1);
  assert.equal(s.onfoot.walk(-1),true);
  assert.equal(s.recovery.supplyRoutes('diesel')[0].station,1);
  assert.equal(s.onfoot.walk(1),true);
  assert.equal(s.onfoot.getBranchWalks().length,1);
  assert.equal(s.onfoot.walk(1,'B1'),true);
  assert.equal(s.onfoot.isBesideTrain(),true);
  assert.equal(s.onfoot.walk(1),true);
  assert.equal(s.onfoot.walk(1),true,'can leave a branch at its rejoining junction');
  assert.equal(v.onFoot.branch,null); assert.equal(v.onFoot.tileIndex,3);
  assert.equal(s.onfoot.walk(1),false,'cannot walk beyond the station');
  assert.equal(s.onfoot.walk(1,'B1'),true,'can return via the rejoining junction');
  assert.equal(v.onFoot.tileIndex,1); assert.equal(v.onFoot.branch,'B1');
  assert.equal(s.onfoot.walk(-1),true); assert.equal(s.onfoot.climbAboard(),true);
  assert.equal(JSON.stringify(v.journey),parked);

  branch.rejoinIndex=null; branch.stationId='L1B1';
  v.stationTracks.L1B1=[lead(),road(),lead()];
  s.onfoot.climbDown(); s.onfoot.walk(1);
  assert.equal(s.onfoot.getWalk(1),null,'terminus is a real endpoint');
  assert.equal(s.recovery.supplyRoutes('diesel')[0].station,'L1B1');
  assert.equal(s.onfoot.walk(-1),true); assert.equal(s.onfoot.walk(-1),true);
  assert.equal(s.onfoot.walk(1,'missing'),false);
  assert.equal(JSON.stringify(v.journey),parked);
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

test('sourced grid cells draw their true incoming connection',()=>{
  const {setup:s}=game([lead(),road(),lead()]);
  const tiles=s.realWorldPilot.getGridRoute().tiles;
  for(let i=1;i<tiles.length;i++) {
    assert.ok(tiles[i].ends.includes(s.worldmap.directionBetween(tiles[i],tiles[i-1])),`(${tiles[i].x},${tiles[i].y}) connects back`);
  }
});

test('the deferred journal neither initializes nor records travel',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  assert.equal(v.journal,undefined);
  v.journey={legIndex:1,tileIndex:0,forward:true};
  s.railyard.moveAlongLine(1);
  assert.equal(v.journal,undefined);
  s.startNewRun();assert.equal(v.journal,undefined);
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

test('a depleted depot stays depleted and does not offer an automated supply run',()=>{
  const {setup:s,State:{variables:v}}=game([lead(),road(),lead()]);
  s.recovery.stock(2).diesel=0;
  assert.equal(s.recovery.supplyRoutes('diesel').length,0);
  assert.equal(s.recovery.plan(3,'diesel',true),null,'cannot carry a bulk tank fill on foot');
  assert.equal(s.recovery.plan(3,'diesel',false),null);
  assert.equal(s.recovery.stock(2).diesel,0);
  assert.equal(s.recovery.collect(3,'diesel',false),false);
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
    for(let station=2;station<5;station++) {
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

test('station lead headings follow the sourced rail grid', () => {
  const g = loadGame(), world = g.setup.worldmap, yard = g.setup.railyard;
  for (let station = 2; station <= 5; station++) {
    const tracks = yard.generateStationTracks(station, 'ignored');
    assert.equal(tracks[0].direction, yard.oppositeDirection(yard.getLegHeading(station - 1)));
    assert.ok(g.setup.yardGeneration.validate(tracks));
  }
  assert.equal(yard.getLegHeading(1), 'north');
  assert.equal(world.getStationName(5), 'Esperanza');
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
