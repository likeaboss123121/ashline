const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGame } = require('./helpers.cjs');
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/v010', name + '.json')));
const copy = value => JSON.parse(JSON.stringify(value));
const state = (variables, title = 'TrainInterior') => ({ index: 0, history: [{ title, variables }] });

test('v0.1.0 migration converts burden stats once and preserves the actual rolling stock', () => {
  const { setup: s } = loadGame(), old = fixture('interior').live;
  Object.assign(old.player, { fatigue: 12, physicalDamage: 35, mentalHealth: 46, hunger: 25, thirst: 65 });
  old.currentTrain[0].cargo = [{ type: 'diesel', amount: 3200, grade: 30 }];
  const input = state(old), before = JSON.stringify(input);
  const result = s.saveMigrations.upgradeState(input);
  const v = result.state.history[0].variables;
  assert.deepEqual([v.player.health, v.player.sanity, v.player.hunger, v.player.thirst, v.player.fatigue], [65,46,75,35,12]);
  assert.equal(v.currentTrain[0].model, 'diesel-shunter');
  assert.equal(v.currentTrain[0].length, 9);
  assert.equal(v.currentTrain[0].baseWeight, 32000);
  assert.equal(v.currentTrain[0].maxCargoCapacityVolume, 3200);
  assert.equal(v.currentTrain[0].maxCargoCapacityKg, 2720);
  assert.equal(JSON.stringify(v.currentTrain[0].cargo), JSON.stringify(old.currentTrain[0].cargo));
  assert.equal(v.currentTrain[0].inventory.length, 6);
  assert.equal(v.trains.length, 0); assert.equal(v.currentCar, undefined);
  assert.equal(v.settingsMode, undefined); assert.equal(v.tutorialDone, true);
  assert.equal(v.gameTimeTimestampMs, s.time.startTimestampMs);
  assert.ok(v.defaultTrains.steamPrairie); assert.ok(v.cargoTypes.firewood);
  assert.equal(v.defaultTrains.steamLoco, undefined);
  assert.equal(JSON.stringify(input), before, 'original remains untouched');
  const second = s.saveMigrations.upgradeState(result.state, s.saveMigrations.CURRENT);
  assert.equal(second.upgraded, false);
  assert.equal(JSON.stringify(second.state), JSON.stringify(result.state), 'no repeated inversions, kit gifts or cargo changes');
});

test('frozen legacy generation reproduces the released yards, not the new generator', () => {
  const { setup:s } = loadGame();
  for (const name of ['yard-first-entry', 'arrival']) {
    const v = fixture(name).live;
    assert.equal(JSON.stringify(s.saveLegacy010.station(v)), JSON.stringify(v.stationTracks[v.currentStation]), name);
  }
  const old = fixture('arrival').live, expected = copy(old.stationTracks[2]);
  delete old.stationTracks[2];
  const v = s.saveMigrations.upgradeState(state(old, 'DrivingMode')).state.history[0].variables;
  assert.deepEqual(Array.from(v.stationTracks[2],t => t.length), expected.map(t => t.length));
  assert.equal(v.stationTracks[2].flatMap(t=>t.trains).flat().length, expected.flatMap(t=>t.trains).flat().length);
});

test('every history moment migrates and a bad or future moment rejects the entire copy', () => {
  const { setup:s } = loadGame(), v = fixture('interior').live;
  const input = { index: 1, history: [{ title:'StoryInit', variables:copy(v) }, { title:'TrainInterior', variables:copy(v) }] };
  const output = s.saveMigrations.upgradeState(input).state;
  assert.equal(output.history[0].title, 'Introduction');
  assert.ok(output.history.every(m=>m.variables.saveSchemaVersion===s.saveMigrations.CURRENT));
  for (const version of [s.saveMigrations.CURRENT+1, -1, '1']) {
    const bad = copy(input); bad.history[1].variables.saveSchemaVersion = version;
    const before = JSON.stringify(bad);
    assert.throws(()=>s.saveMigrations.upgradeState(bad), /version/i);
    assert.equal(JSON.stringify(bad), before);
  }
  assert.throws(()=>s.saveMigrations.upgradeState(input, 100), /newer/);
  assert.throws(()=>s.saveMigrations.upgradeState(input, 1), /disagree/);
  const bad=copy(input);bad.history[1].variables.stationTracks[1][1].trains=[[null]];
  assert.throws(()=>s.saveMigrations.upgradeState(bad), /train/i);
});

test('v0.2.0 saves retain survival state while old branches move onto the sourced line', () => {
  const { setup:s, State:{variables:v} } = loadGame();s.startNewRun();
  delete v.saveSchemaVersion;v.lastPlayedReleaseVersion='0.2.0';
  v.player.hunger=23;v.player.health=0;v.player.carried=[{item:'jerrycan',count:1}];
  v.player.carriedCargo=[{type:'diesel',amount:17,grade:65}];v.gameTimeTimestampMs+=345600000;
  v.player.carry={fatigue:0.25,hunger:-0.1};
  v.currentTrain=[s.railyard.cloneCar(v.defaultTrains.dieselRoad)];v.currentTrain[0].inventory=[];
  v.journey={legIndex:2,branch:'2:5:6',tileIndex:0,forward:false};v.onFoot={branch:null,tileIndex:500};
  v.campfires={test:{expiresAt:12345}};
  v.stationTracks[2]=[{length:999999,infinite:true,trains:[],supplies:{diesel:0,coal:0,water:12}},
    {length:100,trains:[]},{length:999999,infinite:true,trains:[]}];
  const result=s.saveMigrations.upgradeState(state(v,'OnFoot')).state.history[0].variables;
  for(const key of ['player','campfires','gameTimeTimestampMs','stationTracks'])
    assert.equal(JSON.stringify(result[key]),JSON.stringify(v[key]),key);
  assert.equal(JSON.stringify(result.journey),JSON.stringify({legIndex:2,tileIndex:0,forward:false}));
  const lastOfLeg=s.realWorldPilot.getGridRoute().legs[2].tiles.length-1;
  assert.equal(JSON.stringify(result.onFoot),JSON.stringify({legIndex:2,tileIndex:lastOfLeg,branch:null}));
  assert.equal(result.currentTrain[0].model,'diesel-road');
  assert.equal(result.currentTrain[0].inventory.length,0,'no gifts to newer or already-depleted kits');
});

test('v0.2.0 saves outside the sourced corridor keep their train and return safely to the first station', () => {
  const {setup:s,State:{variables:v}}=loadGame();s.startNewRun();
  v.saveSchemaVersion=1;v.currentStation=99999;
  v.currentTrain=[s.railyard.cloneCar(v.defaultTrains.dieselShunter)];
  v.journey={legIndex:99999,tileIndex:7,branch:'99999:2:1',forward:true};
  v.onFoot={tileIndex:3,branch:'99999:2:1'};
  const result=s.saveMigrations.upgradeState(state(v,'OnFoot'),1).state.history[0];
  assert.equal(result.title,'TrainInterior');
  assert.equal(result.variables.currentStation,1);
  assert.equal(result.variables.journey,null);assert.equal(result.variables.onFoot,null);
  assert.equal(result.variables.currentTrain[0].model,'diesel-shunter');
  assert.equal(result.variables.saveSchemaVersion,2);
});

test('legacy steam engines and pending placement retain loads and order while adopting shunter specs', () => {
  const {setup:s}=loadGame(),v=fixture('interior').live;
  const steam=copy(v.defaultTrains.steamLoco);steam.cargo=[{type:'coal',amount:8000},{type:'water',amount:5000}];
  v.leavingTrain=[steam,copy(v.defaultTrains.boxcar)];v.currentTrain=copy(v.leavingTrain);
  const result=s.saveMigrations.upgradeState(state(v,'Railyard')).state.history[0].variables;
  assert.equal(result.currentTrain,null);assert.equal(result.leavingTrain.length,2);
  assert.equal(result.leavingTrain[0].length,10);assert.equal(result.leavingTrain[0].model,'steam-shunter');
  assert.equal(result.leavingTrain[0].maxCargoCapacityVolume,13000);
  assert.equal(result.leavingTrain[0].maxCargoCapacityKg,11400);
  assert.equal(JSON.stringify(result.leavingTrain[0].cargo),JSON.stringify(steam.cargo));
  assert.equal(result.leavingTrain[0].steamStoredLiters,0);
});
