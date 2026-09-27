const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { scriptEntries, passageEntries, buildCatalogue } = require('../scripts/build-text-catalogue.cjs');

test('text extraction preserves labels, tooltips, branches, escapes and dynamic templates without executing code', () => {
  const input = [
    'throw new Error("Never run this");',
    '// "not game text"',
    'const pattern = /"not a string"/;',
    String.raw`button.title = "Fuel \"grade\"";`,
    'button.textContent = "Leave " + station.name + " now";',
    'const subtitle = `Cold ${weather.temperature} degrees`;',
    'const hint = ready ? "Ready" : "Wait";'
  ].join('\n');
  const rows = scriptEntries(input, 'source/fixture.js');
  const texts = rows.map(row => row[4]);
  assert.ok(texts.includes('Fuel "grade"'));
  assert.ok(texts.includes('Leave {station.name} now'));
  assert.ok(texts.includes('Cold {weather.temperature} degrees'));
  assert.ok(texts.includes('Ready') && texts.includes('Wait'));
  assert.ok(!texts.includes('not game text') && !texts.includes('not a string'));
  assert.equal(rows.find(row => row[4] === 'Fuel "grade"')[2], 4);
});

test('passage index retains exact inert markup and includes special sidebar passages', () => {
  const rows = passageEntries(':: StorySubtitle\r\nA subtitle\r\n:: Yard [nobr] {"position":"0,0"}\r\n<<set $fuel = 0>>\r\nLeave the train.\r\n', 'source/test.tw');
  assert.deepEqual(rows[0], ['passages','source/test.tw',2,'StorySubtitle','A subtitle']);
  assert.equal(rows[1][3], 'Yard');
  assert.equal(rows[1][4], '<<set $fuel = 0>>\r\nLeave the train.');
});

test('generated catalogue covers every script and passage file and stays current without indexing itself', () => {
  const rows = buildCatalogue();
  const setup = {};
  vm.runInNewContext(fs.readFileSync('source/text-catalogue.js','utf8'), { setup });
  assert.deepEqual(JSON.parse(setup.textCatalogueSource), rows);
  const files = new Set(rows.map(row => row[1]));
  for (const name of fs.readdirSync('source').filter(name => /\.(js|tw)$/.test(name))) {
    if (['world-data.js','text-catalogue.js'].includes(name)) continue;
    assert.ok(files.has('source/'+name), name);
  }
  assert.ok(rows.some(row => row[0] === 'graphics'));
  assert.ok(rows.some(row => row[3] === 'Help'));
  assert.ok(rows.some(row => row[1] === 'source/tutorial.js'));
  assert.ok(!files.has('source/text-catalogue.js'));
});

test('text search is lazy, read-only, includes geographic and engine text, and filters placeholders without guessing authorship', () => {
  const setup = { textCatalogueSource: JSON.stringify([
    ['passages','source/test.tw',2,'Start','Human wording'],
    ['scripts','source/test.js',8,'','PLACEHOLDER — Write a hint here']
  ]), worldGraphData: { names: ['Punta Arenas'], coords: [1,2,3] } };
  const State = { variables: { health: 7 } }, before = JSON.stringify(State);
  vm.runInNewContext(fs.readFileSync('source/text-wiki.js','utf8'), {setup,State,l10nStrings:{savesTitle:'Saves'}});
  assert.equal(setup.textWiki.entries, null);
  const filter = {query:'',category:'',file:'',placeholders:false};
  assert.equal(setup.textWiki.find({...filter,query:'PUNTA ARENAS'})[0][0], 'world');
  assert.equal(setup.textWiki.find({...filter,query:'Saves'})[0][0], 'engine');
  assert.equal(setup.textWiki.find({...filter,placeholders:true}).length, 1);
  assert.equal(setup.textWiki.find({...filter,category:'passages'})[0][4], 'Human wording');
  assert.equal(setup.textWiki.find({...filter,file:'source/test.js'}).length, 1);
  assert.equal(JSON.stringify(State), before);
});

test('watch builds refresh the catalogue without reacting to their own generated output', () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  let refreshes=0, changes, closed=false;
  vm.runInNewContext('(function(){\n'+fs.readFileSync('scripts/build.cjs','utf8')+'\n}());', {
    __dirname: require('node:path').resolve('scripts'), console,
    require(name) {
      if (name === 'node:child_process') return {spawnSync:()=>({status:0}),spawn:()=>child};
      if (name === 'node:fs') return {watch:(dir,options,callback)=>{
        changes=callback; return {close:()=>{closed=true;}};
      }};
      if (name === './build-text-catalogue.cjs') return {compile:()=>{refreshes++;}};
      return require(name);
    },
    process:{execPath:process.execPath,platform:'linux',env:{},argv:['node','build.cjs','--watch'],on(){}},
    setTimeout:callback=>{callback();return 1;}, clearTimeout(){}
  });
  assert.equal(refreshes,1);
  changes('change','text-catalogue.js'); assert.equal(refreshes,1);
  changes('change','main.tw'); assert.equal(refreshes,2);
  child.emit('exit',0); assert.equal(closed,true);
});
