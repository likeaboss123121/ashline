const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadGame}=require('./helpers.cjs');
const game=loadGame(),s=game.setup,State=game.State;
const route=s.realWorldPilot.getGridRoute(),originalGet=s.realWorldPilot.getGridRoute;
const revision=s.worldGraphData.networkRevision;
const state=(v,title)=>({index:0,history:[{title,variables:v}]});
const yard=train=>[{length:999999,infinite:true,trains:[]},{length:200,trains:[[train]]},{length:999999,infinite:true,trains:[]}];

test('stable station UUIDs remap numbered yards and relocate missing stations and tiles',()=>{
  assert.match(route.corridor.stations[1].uuid,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(s.saveMigrations.nearestStation([179.9,0],{corridor:{stations:[{square:0},{square:1}]},
    tiles:[{geoCoordinate:[170,0]},{geoCoordinate:[-179.9,0]}]}),2,'nearest station wraps across the date line');
  const changed=Object.assign({},route,{corridor:Object.assign({},route.corridor,
    {stations:route.corridor.stations.filter((_,index)=>index!==1)})});
  function onChanged(testRevision,callback){
    s.realWorldPilot.getGridRoute=()=>changed;s.worldGraphData.networkRevision=testRevision;
    try{return callback();}finally{s.realWorldPilot.getGridRoute=originalGet;s.worldGraphData.networkRevision=revision;}
  }
  // A surviving station changes from index 3 to 2 without moving its yard stock.
  s.startNewRun();let v=State.variables;v.currentStation=3;
  const box=s.railyard.cloneCar(v.defaultTrains.boxcar);v.stationTracks[3]=yard(box);
  const numbered=state(v,'Railyard');s.saveMigrations.stampState(numbered);
  const uuid=numbered.history[0].variables.worldIdentity.station.uuid;
  onChanged('reordered-stations',()=>{
    const out=s.saveMigrations.upgradeState(numbered,5).state.history[0].variables;
    assert.equal(out.currentStation,2);assert.equal(changed.corridor.stations[1].uuid,uuid);
    assert.equal(out.stationTracks[2][1].trains[0][0].type,box.type);
    assert.equal(out.stationTracks[3],undefined);
  });
  // The removed station's visited consist travels with the player; other yard stock is retained.
  s.startNewRun();v=State.variables;v.currentStation=2;
  const engine=s.railyard.cloneCar(v.defaultTrains.dieselShunter);engine.visited=true;
  v.stationTracks[2]=yard(engine);
  const removed=state(v,'Railyard');s.saveMigrations.stampState(removed);
  const oldUuid=removed.history[0].variables.worldIdentity.station.uuid;
  onChanged('removed-station',()=>{
    const out=s.saveMigrations.upgradeState(removed,5).state.history[0];
    assert.equal(removed.history[0].variables.currentStation,2,'source remains intact');
    assert.equal(out.title,'TrainInterior');assert.equal(out.variables.currentTrain[0].visited,true);
    assert.ok(out.variables.orphanedStationYards[oldUuid]);
    assert.notEqual(changed.corridor.stations[out.variables.currentStation-1].uuid,oldUuid);
    assert.equal(s.saveMigrations.upgradeState(state(out.variables,out.title),5).upgraded,false);
  });
  // A tile no longer on the line puts the whole travelling consist at the nearest station.
  s.startNewRun();v=State.variables;
  const leg=Object.values(route.legs).find(item=>item&&item.tiles.length>2);
  v.currentTrain=[s.railyard.cloneCar(v.defaultTrains.dieselShunter),s.railyard.cloneCar(v.defaultTrains.boxcar)];
  v.journey={legIndex:leg.index,tileIndex:1,forward:true};
  const travelling=state(v,'OnTheLine');s.saveMigrations.stampState(travelling);
  const tile=travelling.history[0].variables.worldIdentity.journey;
  const byKey=Object.create(route.byKey);byKey[tile.x+','+tile.y]=undefined;
  const missingTile=Object.assign({},route,{byKey});
  s.realWorldPilot.getGridRoute=()=>missingTile;s.worldGraphData.networkRevision='removed-tile';
  try {
    const out=s.saveMigrations.upgradeState(travelling,5).state.history[0];
    assert.equal(out.title,'TrainInterior');assert.equal(out.variables.journey,null);
    assert.equal(out.variables.currentTrain.length,2);
    assert.equal(out.variables.currentStation,s.saveMigrations.nearestStation(tile.coordinate,missingTile));
  } finally{s.realWorldPilot.getGridRoute=originalGet;s.worldGraphData.networkRevision=revision;}
});

test('bad station numbers and coordinates load at Punta Arenas; a real point with no tile loads at the nearest yard',()=>{
  const start=route.corridor.stations.findIndex(item=>item.name==='Punta Arenas')+1;
  assert.ok(start>0);
  const load=(v,title,version=5)=>s.saveMigrations.upgradeState(state(v,title),version);
  // A clean save is left alone.
  s.startNewRun();let v=State.variables;v.currentStation=3;
  let clean=state(v,'Railyard');s.saveMigrations.stampState(clean);
  assert.equal(s.saveMigrations.upgradeState(clean,5).repaired,false);
  // Station numbers that do not exist.
  for (const bad of [0,route.corridor.stations.length+1,'3',2.5,null]) {
    s.startNewRun();v=JSON.parse(JSON.stringify(State.variables));v.currentStation=bad;
    const out=load(v,'Railyard');
    assert.equal(out.repaired,true);assert.equal(out.state.history[0].variables.currentStation,start,String(bad));
  }
  // A journey off the network, with good and bad saved coordinates.
  const leg=Object.values(route.legs).find(item=>item&&item.tiles.length>2);
  const target=route.corridor.stations[40],point=route.tiles[target.square].geoCoordinate;
  for (const [coordinate,expected] of [[point,41],[[500,0],start],[['x',1],start]]) {
    s.startNewRun();v=State.variables;
    v.currentTrain=[s.railyard.cloneCar(v.defaultTrains.dieselShunter)];
    v.journey={legIndex:leg.index,tileIndex:1,forward:true};
    const travelling=state(v,'OnTheLine');s.saveMigrations.stampState(travelling);
    const saved=travelling.history[0].variables;
    saved.journey={legIndex:leg.index,tileIndex:leg.tiles.length+50,forward:true};
    saved.worldIdentity.journey.coordinate=coordinate;
    const out=s.saveMigrations.upgradeState(travelling,5).state.history[0];
    assert.equal(out.title,'TrainInterior');assert.equal(out.variables.journey,null);
    assert.equal(out.variables.currentStation,expected,JSON.stringify(coordinate));
  }
  // An old map's save whose station anchor is broken no longer refuses to load.
  s.startNewRun();v=State.variables;v.currentStation=3;
  const old=state(v,'Railyard');s.saveMigrations.stampState(old);
  old.history[0].variables.worldIdentity.revision='older-map';
  old.history[0].variables.worldIdentity.station={uuid:'gone',coordinate:[NaN,0]};
  assert.equal(s.saveMigrations.upgradeState(old,5).state.history[0].variables.currentStation,start);
  // A yard filed under a station number that does not exist keeps its stock aside.
  s.startNewRun();v=JSON.parse(JSON.stringify(State.variables));v.stationTracks.nonsense=yard(s.railyard.cloneCar(v.defaultTrains.boxcar));
  const out=load(v,'Railyard').state.history[0].variables;
  assert.equal(out.stationTracks.nonsense,undefined);assert.ok(out.orphanedStationYards['invalid:nonsense']);
});
