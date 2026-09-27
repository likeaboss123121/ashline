const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Catalogue/art tests do not need to allocate the entire worldwide railway graph.
function catalogue() {
  const context=vm.createContext({setup:{},State:{variables:{}},Macro:{add(){}},
    document:{querySelector(){return null;}},jQuery:()=>({on(){},one(){}})});
  for(const name of ['scripts','locales','stock-catalogue','stock-variety','vegetation-data',
    'railyard-templates','driving-templates','railyard-view','driving-view']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../source',name+'.js'),'utf8'),context);
  }
  return context;
}

test('twelve functional locomotives include six steam, six diesel, a mechanical drive and a streamliner',()=>{
  const {setup:s,State}=catalogue(), defaults=State.variables.defaultTrains;
  const stock=s.railyard.locomotiveKeys.map(key=>defaults[key]);
  assert.equal(stock.filter(c=>c.type==='steam loco').length,6);
  assert.equal(stock.filter(c=>c.type==='diesel loco').length,6);
  assert.equal(defaults.dieselMechanical.drivetrain,'diesel-mechanical');
  assert.ok(defaults.steamStreamliner.topSpeedKmh>defaults.steamShunter.topSpeedKmh);
  assert.ok(new Set(stock.map(c=>c.origin)).size>=5);
  assert.ok(new Set(stock.map(c=>c.era)).size>=5);
  for(const c of stock) {
    assert.ok(c.tractiveCapacity>0&&c.length>0&&c.topSpeedKmh>0);
    assert.ok(c.type==='steam loco' ? c.fireboxScale>0&&c.boilerSteamVolumeLiters>0 : c.dieselLitresPerMinute>0);
    for(const view of ['railyard','driving']) for(const flipped of [false,true]) {
      const name=s[view+'View'].getCarTemplateName(c,flipped);
      const meta=s[view+'Templates'].templates.find(t=>t.passage===name);
      assert.ok(meta,name);assert.equal(meta.lengthMetres,c.length);assert.ok(meta.cab);
    }
  }
});

test('every car type has several persisted graphic choices with identical gameplay dimensions',()=>{
  const {setup:s,State}=catalogue();
  for(const key of s.railyard.carKeys) {
    const car=State.variables.defaultTrains[key], entry=s.stockVariety.definition(car);
    assert.ok(entry,key);assert.ok(entry.spec.variants.length>=1);
    if(key==='passengerCoach') assert.ok(entry.spec.variants.length>=3);
    const before=JSON.stringify(car), choices=new Set(), rng=s.railyard.mulberry32(123);
    for(let i=0;i<100;i++) {
      const instance=JSON.parse(before);s.stockVariety.assign(instance,rng,{stockRegion:'east-asia'});
      choices.add(instance.graphicVariant||'original');
      for(const view of ['railyard','driving']) {
        const name=s[view+'View'].getCarTemplateName(instance,false);
        const meta=s[view+'Templates'].templates.find(t=>t.passage===name);
        assert.equal(meta.lengthMetres,car.length);
        assert.equal(s[view+'View'].getCarTemplateName(JSON.parse(JSON.stringify(instance)),false),name);
      }
      delete instance.graphicVariant;assert.equal(JSON.stringify(instance),before);
    }
    assert.equal(choices.size,entry.spec.variants.length+1,key);
    assert.equal(JSON.stringify(car),before,'preset is not mutated');
  }
});

test('biome and regional vegetation palettes have flat and mountain art and distinct plant silhouettes',()=>{
  const {setup:s}=catalogue();
  for(const [key,spec] of Object.entries(s.vegetation)) {
    if(!['tundra','desert','alpine'].includes(spec.biome)) assert.ok(spec.plants.length>=4,key);
    for(const plant of spec.plants) assert.ok(s.railyardTemplates.templates.some(t=>t.passage==='railyard-plant-'+plant),plant);
    for(const suffix of ['','-mountain']) assert.ok(s.drivingTemplates.templates.some(t=>t.passage==='driving-terrain-local-'+key+suffix),key+suffix);
  }
  const profiles=[[2,47],[115,30],[-123,47]].map(coord=>s.locales.profile(coord,100));
  assert.ok(profiles.every(p=>p.biome==='temperate'));
  assert.equal(new Set(profiles.map(p=>p.vegetation)).size,3);
  for(const profile of profiles) assert.equal(s.locales.plants(profile).length,4);
  assert.equal(s.locales.profile([85,30],4200).biome,'alpine');
});

test('all generated SVG catalogue entries are unique, bounded and present on disk',()=>{
  const {setup:s}=catalogue();
  for(const [field,file] of [['stockCatalogue','stock-designs.json'],['vegetation','vegetation-designs.json']]) {
    assert.deepEqual(JSON.parse(JSON.stringify(s[field])),JSON.parse(fs.readFileSync(path.join(__dirname,'../scripts',file),'utf8')),
      'Regenerate artwork after changing '+file);
  }
  for(const view of ['railyard','driving']) {
    const entries=s[view+'Templates'].templates;
    assert.equal(new Set(entries.map(t=>t.passage)).size,entries.length);
    for(const t of entries) {
      const svg=fs.readFileSync(path.join(__dirname,'../source/img',view,t.file),'utf8');
      assert.match(svg,/<svg/);assert.doesNotMatch(svg,/NaN|undefined/);
      assert.ok(t.width>0&&t.height>0&&t.width<300&&t.height<300,t.file);
    }
  }
});

test('schema 3 upgrade adds the expanded fleet without repainting or replacing owned stock',()=>{
  const {setup:s,State}=require('./helpers.cjs').loadGame();s.startNewRun();
  const v=State.variables;v.saveSchemaVersion=3;
  v.currentTrain=[s.railyard.cloneCar(v.defaultTrains.boxcar)];
  v.currentTrain[0].graphicVariant='planked';v.currentTrain[0].cargo=[{type:'food',amount:5}];
  delete v.defaultTrains.steamGarratt;delete v.defaultTrains.dieselMechanical;
  const before=JSON.stringify(v.currentTrain);
  const result=s.saveMigrations.upgradeState({index:0,history:[{title:'Railyard',variables:v}]},3);
  const after=result.state.history[0].variables;
  assert.equal(JSON.stringify(after.currentTrain),before);
  assert.ok(after.defaultTrains.steamGarratt&&after.defaultTrains.dieselMechanical);
  assert.equal(s.saveMigrations.upgradeState(result.state,s.saveMigrations.CURRENT).upgraded,false);
});
