const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

let browser;
before(async () => {
  // On ARM Linux use the bundled Chromium headless shell, not its desktop-app integration.
  const channel = process.env.ASHLINE_BROWSER === 'chromium' ? undefined : (process.env.ASHLINE_BROWSER || 'chrome');
  // Make V8 collect before a large debug-map redraw reaches the server's process-group memory cap.
  browser = await chromium.launch({ channel, headless: true,
    args: channel ? [] : ['--js-flags=--max-old-space-size=512'] });
});
after(async () => { if (browser) await browser.close(); });

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A run of stations one after another on a plain stretch of line, found in the page as tests/helpers.cjs stationRun
// finds it: each has a line at both ends and leaves by its exit line, running forward, straight to the next.
const stationRunIn = (page, length = 3) => page.evaluate(length => {
  const pilot = SugarCube.setup.realWorldPilot, count = pilot.getGridRoute().corridor.stations.length;
  for (let first = 2; first + length - 1 <= count; first++) {
    const stations = [], legs = [];
    let ok = true;
    for (let i = 0; i < length && ok; i++) {
      const id = first + i, lines = pilot.getStationLines(id);
      const exit = lines.find(line => line.side === 'exit'), entry = lines.find(line => line.side === 'entry');
      if (!exit || !entry) ok = false;
      else if (i < length - 1) {
        if (exit.destination !== id + 1 || !exit.forward) ok = false;
        else legs.push(exit.legIndex);
      }
      stations.push(id);
    }
    if (ok) return { stations, legs };
  }
  return null;
}, length);
// A station's name, and where its exit line leads as its departure link names it: the network is rebuilt from map
// data, so tests look the names up rather than pinning them.
const stationName = (page, id) => page.evaluate(id => SugarCube.setup.worldmap.getStationName(id), id);
const exitName = (page, id) => page.evaluate(id => {
  const world = SugarCube.setup.worldmap, line = SugarCube.setup.realWorldPilot.getStationLines(id).find(candidate => candidate.side === 'exit');
  return line.destination ? world.getStationName(line.destination) : world.describePoint(line.destinationName, world.getStationName(id));
}, id);
const departTo = async (page, id) => new RegExp('^Depart \\S+ toward ' + escapeRegExp(await exitName(page, id)), 'm');

async function openGame(t, options) {
  const page = await browser.newPage(options);
  // Bound failures and capture state instead of masking broken selectors with retries.
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.dismiss(); });
  // Multi-fixture/viewport tests must release each full world before opening the next one.
  page.closeChecked = async () => {
    if (page.isClosed()) return;
    const markupErrors = await page.locator('#passages .error').allTextContents();
    if (t.passed !== true || errors.length || markupErrors.length) {
      const artifact = path.join('test-results', t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 140));
      fs.mkdirSync('test-results', { recursive: true });
      const state = await page.evaluate(() => window.SugarCube && SugarCube.setup.bugReport.build()).catch(() => null);
      fs.writeFileSync(artifact + '.json', JSON.stringify({ errors, markupErrors, state }, null, 2));
      await page.screenshot({ path: artifact + '.png', fullPage: true });
    }
    await page.close();
    assert.deepEqual(errors, [], 'No uncaught errors or error dialogs');
    assert.deepEqual(markupErrors, [], 'No SugarCube macro errors');
  };
  t.after(() => page.closeChecked());
  await page.goto(pathToFileURL(path.resolve(process.env.ASHLINE_HTML || 'index.html')).href);
  // Each newPage has isolated browser storage; clear slots explicitly for fixture clarity.
  await page.waitForFunction(() => !!window.SugarCube);
  await page.evaluate(() => {
    localStorage.removeItem('ashline.saves.sinceExport');
    localStorage.removeItem('ashline.saves.lastExport');
    for (let slot = 0; slot < 8; slot++) {
      try { SugarCube.Save.slots.delete(slot); } catch (error) { /* an empty slot is what we wanted anyway */ }
    }
  });
  await passage(page, 'Start');
  await page.evaluate(() => { SugarCube.State.variables.randomSeed = 'browser-regression'; });
  return page;
}

test('six bridge structures stay with graded track and render by day and night', async t => {
  const page=await openGame(t);await beginTutorial(page);
  const result=await page.evaluate(()=>{
    const s=SugarCube.setup,v=SugarCube.State.variables,host=document.querySelector('#passages');
    host.replaceChildren();const names=new Set();let drawings=0;
    for(const hour of [12,0]) for(const bridgeEra of ['old','modern']) for(const bridgeSpanMetres of [10,30,100]) {
      v.gameTimeTimestampMs=Date.UTC(2000,2,21,hour);
      const wrapper=s.drivingView.render({terrain:'bridge',grade:hour===12?4:-4,forward:hour===12,
        tile:{terrain:'bridge',geoCoordinate:[2,47],bridgeEra,bridgeSpanMetres}},
        [s.railyard.createLocomotiveCar('steamStreamliner')],0);
      const svg=wrapper.querySelector('svg'),name=svg.getAttribute('data-bridge');names.add(name);
      if(svg.getAttribute('data-light')!==(hour===12?'day':'night')) throw Error('Wrong lighting fixture');
      const structure=svg.querySelector('use[data-template="'+name+'"]'),track=svg.querySelector('use[data-template="driving-track"]');
      if(!structure||!track||structure.parentElement!==track.parentElement) throw Error('Bridge deck does not follow track');
      if(!structure.parentElement.getAttribute('transform').startsWith('rotate(')) throw Error('Bridge grade missing');
      const uses=[...structure.parentElement.children];
      if(uses.indexOf(structure)>uses.indexOf(track)) throw Error('Bridge obscures rails');
      if(!SugarCube.Story.has(name)) throw Error('Bridge not bundled');
      if(s.svgWiki.assetCategory(s.drivingView.getTemplate(name))!=='Bridges') throw Error('Bridge wiki folder missing');
      host.appendChild(wrapper);drawings++;
    }
    return {count:names.size,drawings};
  });
  assert.deepEqual(result,{count:6,drawings:12});
  await page.screenshot({path:'test-results/bridge-art-gallery.png',fullPage:true});
});

test('steam wheel assemblies remain pixel-connected to their chassis in both views', async t => {
  // Small standalone SVG fixtures: no world generation or game boot needed.
  const page = await browser.newPage();
  t.after(() => page.close());
  const axles = {
    'steam-shunter': [[5.5,2.4],[10.5,2.4],[15.5,2.4]],
    'steam-american': [[3,1.5],[7,1.5],[16,3.2],[23,3.2],[29,1.5],[32,1.5]],
    'steam-streamliner': [[3,1.5],[7,1.5],[18,1.5],[24,3.2],[30,3.2],[36,3.2],[39,1.5],[42,1.5]],
    'steam-mikado': [[3,1.5],[7,1.5],[14,1.5],[19,2.2],[24,2.2],[29,2.2],[34,2.2],[38,1.5]],
    'steam-garratt': [2,4,7,11,15,19,23,33,37,41,45,49,52,54].map(u =>
      [u,[2,4,23,33,52,54].includes(u) ? .9 : 1.8])
  };
  const fixtures = [];
  for (const [model,wheels] of Object.entries(axles)) for (const view of ['railyard','driving']) {
    for (const facing of ['left','right']) {
      const name = `${view}-loco-${model}-${facing}`;
      fixtures.push({name,model,view,facing,wheels,
        svg:fs.readFileSync(path.join('source/img',view,name+'.svg'),'utf8')});
    }
  }
  const failures = await page.evaluate(async fixtures => {
    const failures = [];
    for (const {name,model,view,facing,wheels,svg} of fixtures) {
      const root = new DOMParser().parseFromString(svg,'image/svg+xml').documentElement;
      const img = new Image(); img.src = 'data:image/svg+xml;base64,'+btoa(svg); await img.decode();
      const scale=4, canvas=document.createElement('canvas');
      canvas.width=img.naturalWidth*scale; canvas.height=img.naturalHeight*scale;
      const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const labels=new Int32Array(canvas.width*canvas.height), sizes=[0];
      for (let start=0;start<labels.length;start++) {
        if (labels[start] || pixels[start*4+3]<128) continue;
        const id=sizes.length, queue=[start]; labels[start]=id;
        for (let at=0;at<queue.length;at++) {
          const p=queue[at], x=p%canvas.width;
          for (const next of [x>0?p-1:-1,x+1<canvas.width?p+1:-1,p-canvas.width,p+canvas.width]) {
            if (next>=0 && next<labels.length && !labels[next] && pixels[next*4+3]>=128) {
              labels[next]=id; queue.push(next);
            }
          }
        }
        sizes.push(queue.length);
      }
      const body=sizes.indexOf(Math.max(...sizes));
      const ax=Number(root.getAttribute('data-anchor-x')), ay=Number(root.getAttribute('data-anchor-y'));
      const length=Number(root.getAttribute('data-length-m'))*2;
      for (const [axle,radius] of wheels) {
        const u=facing==='left'?length-axle:axle;
        const v=model==='steam-shunter'?(view==='driving'?5.5:5):5.2;
        const x=(ax+(view==='railyard'?u-v:u))*scale;
        const y=(ay+(view==='railyard'?(u+v)/2-radius:(v-radius)*Math.SQRT1_2))*scale;
        // Half a native pixel accommodates the SVG's intentional pixel snapping.
        const nearby=[];
        for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
          nearby.push(labels[Math.floor(y+dy)*canvas.width+Math.floor(x+dx)]);
        }
        if(!nearby.includes(body)) failures.push(`${name}: disconnected axle ${axle}`);
      }
    }
    return failures;
  },fixtures);
  assert.deepEqual(failures,[]);
});

test('expanded stock renders both facings and visual variants survive browser saves', async t => {
  const page=await openGame(t);await begin(page);await board(page);
  const result=await page.evaluate(()=>{
    const s=SugarCube.setup,v=SugarCube.State.variables,host=document.querySelector('#passages');
    const models=s.railyard.locomotiveKeys.map(key=>s.railyard.createLocomotiveCar(key));
    const variants=[];
    for(const key of s.railyard.carKeys) {
      const preset=v.defaultTrains[key],entry=s.stockVariety.definition(preset);
      for(const variant of entry.spec.variants) variants.push(Object.assign({},preset,{graphicVariant:variant.id}));
    }
    host.replaceChildren();
    let rendered=0;
    for(const car of models.concat(variants)) {
      for(const flipped of [false,true]) {
        car.facing=flipped?-1:1;
        const drawing=s.drivingView.render({terrain:'plains',tile:{terrain:'plains',geoCoordinate:[115,30],elevation:100},grade:0,forward:true},[car],0);
        host.appendChild(drawing);rendered++;
        for(const prefix of ['railyard','driving']) {
          const name=s[prefix+'View'].getCarTemplateName(car,false);
          if(!SugarCube.Story.has(name)) throw Error('Missing image '+name);
        }
      }
    }
    const tracks=s.railyard.generateStationTracks(1,'variety');
    tracks[1].trains=[models.slice(0,6)];tracks[1].length=300;
    tracks[2].trains=[models.slice(6)];tracks[2].length=300;
    host.appendChild(s.railyardView.render(tracks,null));
    return {models:models.length,variants:variants.length,rendered};
  });
  assert.equal(result.models,12);assert.ok(result.variants>=14);assert.equal(result.rendered,2*(12+result.variants));
  await page.screenshot({path:'test-results/expanded-stock-gallery.png',fullPage:true});
  await page.evaluate(()=>{
    const s=SugarCube.setup,v=SugarCube.State.variables;
    v.currentTrain=[s.railyard.createLocomotiveCar('dieselMechanical'),s.railyard.cloneCar(v.defaultTrains.passengerCoach)];
    v.currentTrain[1].graphicVariant='clerestory';v.currentCarIndex=0;
    SugarCube.Engine.play('TrainInterior');
  });
  await passage(page,'TrainInterior');
  assert.match(await page.locator('#passages').innerText(), /DM2-DE/);
  assert.equal(await page.evaluate(()=>SugarCube.setup.saves.save(0)),true);
  await page.evaluate(()=>{SugarCube.State.variables.currentTrain[1].graphicVariant='stainless';SugarCube.Save.slots.load(0);});
  await page.waitForFunction(()=>SugarCube.State.variables.currentTrain[1].graphicVariant==='clerestory');
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.currentTrain[0].drivetrain),'diesel-mechanical');
});

test('regional scenery, industry landmarks and new rolling stock render in both views by day and night', async t => {
  const page = await openGame(t, { viewport: { width: 1280, height: 900 } });
  await beginTutorial(page);
  const result = await page.evaluate(() => {
    const s = SugarCube.setup, v = SugarCube.State.variables, host = document.querySelector('#passages');
    const samples = [
      ['Patagonia', [-70.9, -53.2]], ['Pampas', [-60, -34]], ['Highveld', [28, -26]],
      ['Siberia', [105, 58]], ['Gulf Coast', [-90, 30]], ['Amazon', [-60, -3]],
      ['Sahara', [15, 25]], ['Cape', [20, -34]], ['Arctic', [135, 69]], ['Europe', [10, 48]],
      ['China', [115,30]], ['Pacific Northwest',[-123,47]]
    ];
    const train = ['dieselOldRoad', 'hopper', 'refrigerated'].map(key => s.railyard.cloneCar(v.defaultTrains[key]));
    host.replaceChildren();
    const results = [];
    for (const [name, geoCoordinate] of samples) {
      const title = document.createElement('h3'); title.textContent = name; host.appendChild(title);
      const tile = { geoCoordinate, elevation: 100, terrain: 'plains' };
      for (const night of [false, true]) {
        const drawn = s.drivingView.render({ tile, terrain: s.locales.terrain(tile), grade: 0, forward: !night,
          light: s.daylight.getLight(night ? -20 : 40) }, train, 0);
        host.appendChild(drawn);
        const svg = drawn.querySelector('svg');
        results.push([svg.getAttribute('data-biome'), svg.getAttribute('data-light')]);
      }
    }
    const tile = { geoCoordinate: [85, 30], elevation: 4200, terrain: 'mountain' };
    for (const terrain of ['mountain', 'bridge', 'tunnel']) {
      host.appendChild(s.drivingView.render({ tile, terrain, grade: 3, forward: true }, train, 0));
    }
    return results;
  });
  assert.deepEqual(result.filter((_, i) => i % 2 === 0).map(row => row[0]),
    ['steppe', 'pampas', 'savanna', 'taiga', 'wetland', 'rainforest', 'desert', 'mediterranean', 'tundra', 'temperate', 'temperate', 'temperate']);
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/locale-driving-gallery.png', fullPage: true });
  const yard = await page.evaluate(() => {
    const s = SugarCube.setup, v = SugarCube.State.variables, host = document.querySelector('#passages');
    const stations = s.realWorldPilot.getCorridor().stations;
    const selected = ['taiga', 'wetland', 'savanna', 'rainforest'].map(biome =>
      stations.findIndex((_, index) => s.locales.forStation(index + 1).biome === biome) + 1);
    host.replaceChildren();
    const results = [];
    for (const id of selected) {
      v.currentStation = id;
      const tracks = s.railyard.generateStationTracks(id, v.randomSeed);
      tracks[1].trains = [['dieselOldRoad', 'hopper', 'refrigerated'].map(key => s.railyard.cloneCar(v.defaultTrains[key]))];
      const drawn = s.railyardView.render(tracks, null); host.appendChild(drawn);
      const svg = drawn.querySelector('svg');
      results.push({ biome: svg.getAttribute('data-biome'), industry: svg.getAttribute('data-industry'),
        plants: svg.querySelectorAll('use[data-template^="railyard-plant-"]').length,
        industryArt: svg.querySelectorAll('use[data-template^="railyard-industry-"]').length });
    }
    return results;
  });
  assert.ok(yard.every(row => row.plants > 0 && row.industryArt === 1), JSON.stringify(yard));
  await page.screenshot({ path: 'test-results/locale-yard-gallery.png', fullPage: true });
});

test('maps are first on desktop and mobile; wide view stays inside the viewport and closes with Escape', async t => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 768, height: 700 }, { width: 390, height: 844 }]) {
    const page = await openGame(t, { viewport });
    await begin(page);
    async function topMap(selector) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.y < 100, `map starts at ${box.y}`);
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, JSON.stringify(box));
    }
    await topMap('.railyard-view-wrapper');
    const passageWidth=await page.evaluate(()=>({passage:document.querySelector('#passages').getBoundingClientRect().width,
      story:document.querySelector('#story').getBoundingClientRect().width}));
    assert.ok(passageWidth.passage/passageWidth.story>=(viewport.width<=767?.99:.93),JSON.stringify(passageWidth));
    await page.getByRole('button', { name: 'Wide', exact: true }).click();
    await topMap('.railyard-view-wrapper');
    assert.equal(await page.getByRole('button', { name: 'Close wide view' }).getAttribute('aria-pressed'), 'true');
    const wide=await page.evaluate(()=>{
      const wrapper=document.querySelector('.railyard-view-wrapper'),scroll=wrapper.querySelector('.railyard-view-scroll');
      const sidebar=document.querySelector('#ui-bar'),actions=document.querySelector('#passages h2');
      const box=wrapper.getBoundingClientRect(),storyBox=document.querySelector('#story').getBoundingClientRect();
      return {position:getComputedStyle(wrapper).position,height:scroll.getBoundingClientRect().height,
        left:box.left,right:box.right,storyLeft:storyBox.left,storyRight:storyBox.right,
        sidebarVisible:getComputedStyle(sidebar).display!=='none',actionsBelow:actions.getBoundingClientRect().top>=wrapper.getBoundingClientRect().bottom};
    });
    assert.equal(wide.position,'relative');
    assert.ok(wide.height<=viewport.height*.53,JSON.stringify(wide));
    assert.equal(wide.sidebarVisible,true);
    assert.equal(wide.actionsBelow,true);
    if(viewport.width>700) {assert.ok(Math.abs(wide.left-wide.storyLeft)<2,JSON.stringify(wide));assert.ok(Math.abs(wide.right-wide.storyRight)<2,JSON.stringify(wide));}
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Wide', exact: true }).getAttribute('aria-pressed'), 'false');
    await board(page);
    await topMap('.consist-view-wrapper');
    await choose(page, 'Start driving', 'DrivingMode');
    await topMap('.railyard-view-wrapper');
    await page.locator('#passages').getByText(/^Depart \S+ toward /).first().click();
    await passage(page, 'OnTheLine');
    await topMap('.driving-view-wrapper');
    await choose(page, 'Enter the train', 'TrainInterior');
    await topMap('.consist-view-wrapper');
    await page.closeChecked();
  }
});

test('portable food, kitchen preparation and SVG inventory work through ordinary controls', async t => {
  const page=await openGame(t); await begin(page); await board(page);
  await page.evaluate(()=>{
    const v=SugarCube.State.variables,s=SugarCube.setup;
    const box=s.railyard.cloneCar(v.defaultTrains.boxcar);box.cargo=[{type:'food',amount:30,grade:70}];
    v.currentTrain.push(box,s.railyard.cloneCar(v.defaultTrains.kitchenCar));v.player.hunger=10;
    SugarCube.Engine.play('TrainInterior');
  });
  await openSection(page,'food');
  await choose(page,'Pack raw food (0.5 kg) (0:01)','TrainInterior');
  await choose(page,'Eat raw food (0:05)','TrainInterior');
  assert.ok(await page.evaluate(()=>SugarCube.State.variables.player.hunger>10));
  await choose(page,'Prepare 3 rations in a kitchen (1.5 kg food) (0:15)','TrainInterior');
  assert.equal(await page.evaluate(()=>SugarCube.setup.food.count('rations')),3);
  await page.getByText('Inventory',{exact:true}).click();
  const dialog=await page.locator('#ui-dialog').boundingBox();
  assert.ok(Math.abs(dialog.width/await page.evaluate(()=>innerWidth)-.6)<.02,JSON.stringify(dialog));
  assert.equal(await page.locator('#ui-dialog-body svg.pack-grid').count(),1);
  assert.match(await page.locator('#ui-dialog-body').innerText(),/Rations/);
});

test('optional cab sections remember ongoing work and expose fuel recovery when stranded',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const pack=page.locator('[data-ui-section="inventory"]');
  const supplies=page.locator('[data-ui-section="supplies"]');
  assert.equal(await pack.evaluate(el=>el.open),false);
  assert.equal(await supplies.evaluate(el=>el.open),false);
  assert.equal(await page.getByText('Eat a ration (0:10)',{exact:true}).isVisible(),true);
  await pack.locator(':scope > summary').focus();await page.keyboard.press('Enter');
  await choose(page,'Take the axe and bow saw','TrainInterior');
  assert.equal(await pack.evaluate(el=>el.open),true,'inventory stays open after a transfer');
  await choose(page,'Start driving','DrivingMode');
  await page.evaluate(()=>{SugarCube.State.variables.currentTrain[0].cargo=[];});
  await choose(page,'Stop driving','TrainInterior');
  assert.equal(await supplies.evaluate(el=>el.open),true,'stranded players immediately see supply actions');
  const collect=supplies.locator('a').filter({hasText:/Collect from.*diesel/}).first();
  await collect.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>SugarCube.setup.railyard.getCargoAmount(SugarCube.State.variables.currentTrain[0],'diesel')>0);
  assert.equal(await supplies.evaluate(el=>el.open),true,'supply actions remain open after collection');
});

test('empty locomotive menus expose on-foot recovery and return carried fuel to the engine',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  await page.evaluate(()=>{
    const v=SugarCube.State.variables;v.journey={legIndex:2,tileIndex:1,forward:true};
    v.currentTrain[0].cargo=[];SugarCube.Engine.play('OnTheLine');
  });
  assert.equal(await page.locator('#passages').getByText(/Climb down from the train/).count(),0,'driving mode only offers the train interior');
  await choose(page,'Enter the train','TrainInterior');
  await openSection(page,'inventory');
  await choose(page,'Take the 20 l jerrycan','TrainInterior');
  await choose(page,'Climb down from the train (0:02)','OnFoot');
  assert.equal(await page.locator('.recovery-controls a').filter({hasText:/diesel/}).count(),0,'a distant depot is not an automated action');
  const toStation=await page.evaluate(()=>(()=>{const w=SugarCube.setup.onfoot.getWalk(-1);return 'Walk '+SugarCube.setup.units.kilometres(w.distanceKm)+' '+w.heading+' ('+Math.floor(w.minutes/60)+':'+String(w.minutes%60).padStart(2,'0')+')';})());
  await choose(page,toStation,'OnFoot');
  await page.locator('.recovery-controls a').filter({hasText:/diesel/}).first().click();
  await passage(page,'OnFoot');
  assert.ok(await page.evaluate(()=>SugarCube.setup.items.getPlayerCargo().some(s=>s.type==='diesel'&&s.amount>0&&s.amount<=20)));
  const toTrain=await page.evaluate(()=>(()=>{const w=SugarCube.setup.onfoot.getWalk(1);return 'Walk '+SugarCube.setup.units.kilometres(w.distanceKm)+' '+w.heading+' ('+Math.floor(w.minutes/60)+':'+String(w.minutes%60).padStart(2,'0')+')';})());
  await choose(page,toTrain,'OnFoot');
  await page.getByText('Load carried diesel into the locomotive',{exact:true}).click();
  await passage(page,'OnFoot');
  await choose(page,'Climb back aboard (0:02)','OnTheLine');
  assert.ok(await page.evaluate(()=>SugarCube.setup.railyard.isTrainDriveCapable(SugarCube.State.variables.currentTrain)));
});

test('actual v0.1.0 exports migrate every passage and preserve stock, cargo and placement',async t=>{
  function stock(v,title) {
    const train=cars=>(cars||[]).map(car=>({type:car.type,cargo:car.cargo}));
    return {station:v.currentStation,track:v.drivingTrackIndex,car:v.currentCarIndex,
      yards:Object.fromEntries(Object.entries(v.stationTracks).map(([id,tracks])=>[id,tracks.map(t=>({length:t.length,trains:t.trains.map(train)}))])),
      current:title==='Railyard'?null:train(v.currentTrain)};
  }
  for(const name of ['start','introduction','yard-first-entry','interior','driving','arrival','yard-pending-placement']) {
    const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/v010',name+'.json')));
    const page=await openGame(t);
    assert.equal(await page.evaluate(text=>SugarCube.setup.saves.importText(text),fixture.exported),true,name);
    const title=fixture.passage==='StoryInit'?'Introduction':fixture.passage;
    await passage(page,title);
    const migrated=await page.evaluate(()=>JSON.parse(JSON.stringify(SugarCube.State.variables)));
    assert.deepEqual(stock(migrated,title),stock(fixture.live,fixture.passage),name);
    assert.equal(migrated.player.health,100);assert.equal(migrated.player.hunger,100);assert.equal(migrated.player.thirst,100);
    assert.equal(migrated.trains.length,0);assert.equal(migrated.currentCar,undefined);
    assert.ok(await page.evaluate(()=>SugarCube.State.history.every(m=>m.variables.saveSchemaVersion===SugarCube.setup.saveMigrations.CURRENT)));
    // Old saves from the title or introduction still load, but nothing can be saved there.
    const inGame=await page.evaluate(()=>SugarCube.setup.isInGame());
    assert.equal(await page.evaluate(()=>SugarCube.setup.saves.save(1)),inGame,name);
    if(!inGame) { await page.closeChecked(); continue; }
    assert.equal(await page.evaluate(()=>SugarCube.setup.saves.load(1)),true);
    await passage(page,title);
    await page.closeChecked();
  }
});

test('v0.1.0 browser slots and restored sessions migrate without overwriting the original slot',async t=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/v010/interior.json')));
  const page=await openGame(t);
  const result=await page.evaluate(fixture=>{
    const {Save,storage,setup:s}=SugarCube;
    storage.set('saves',{autosave:fixture.save,slots:[fixture.save,...Array(7).fill(null)]});
    const before=JSON.stringify(Save.slots.get(0));
    const loaded=s.saves.load(0);
    return {loaded,unchanged:JSON.stringify(Save.slots.get(0))===before};
  },fixture);
  assert.deepEqual(result,{loaded:true,unchanged:true});await passage(page,'TrainInterior');
  await choose(page,'Start driving','DrivingMode');
  await page.locator('#passages a').filter({hasText:/^Depart Northbound/}).first().click();await passage(page,'OnTheLine');
  const turn=await page.evaluate(()=>SugarCube.State.turns);
  await page.locator('#passages a').filter({hasText:/^Drive [\d.]+ km/}).first().click();await passage(page,'OnTheLine');
  await page.waitForFunction(turn=>SugarCube.State.turns>turn&&SugarCube.Engine.isIdle(),turn);
  await page.evaluate(session=>SugarCube.session.set('state',session),fixture.session);
  await page.reload();await passage(page,'TrainInterior');
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.currentTrain[0].model),'diesel-shunter');
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.saveSchemaVersion),
    await page.evaluate(()=>SugarCube.setup.saveMigrations.CURRENT));
  await page.reload();await passage(page,'TrainInterior');
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.player.hunger),100,'session is not inverted twice');
  assert.equal(await page.evaluate(()=>SugarCube.setup.saves.load('auto')),true);
  await passage(page,'TrainInterior');
});

test('future save schemas fail safely and incompatible sessions offer the untouched recovery data',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const result=await page.evaluate(()=>{
    const {Save,State,setup:s}=SugarCube;s.saves.save(0);
    const save=Save.slots.get(0);save.version=999;
    const before=JSON.stringify(State.variables);
    return {loaded:s.saves.importText(JSON.stringify(save)),unchanged:JSON.stringify(State.variables)===before,message:s.saves.message};
  });
  assert.equal(result.loaded,false);assert.equal(result.unchanged,true);assert.match(result.message,/newer version/);
  const original=await page.evaluate(()=>{
    const {State,session}=SugarCube,state=State.marshalForSave();
    state.history[state.index].variables.saveSchemaVersion=999;
    state.delta=State.deltaEncode(state.history);delete state.history;
    session.set('state',state);return state;
  });
  await page.reload();await passage(page,'SaveRecovery');
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download original session'}).click();
  const download=await downloadPromise;
  const recovered=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.deepEqual(recovered.state,original);
  assert.equal(await page.evaluate(()=>SugarCube.Save.slots.save(1)),false,'recovery cannot overwrite saves');
});

test('walking the sourced line leads back to the parked train',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const run=await stationRunIn(page,2),[,to]=run.stations;
  await page.evaluate(legIndex=>{
    const {setup:s,State:{variables:v}}=SugarCube;
    // One tile short of the next station, so a single walk reaches its yard.
    v.journey={legIndex,tileIndex:s.realWorldPilot.getGridRoute().legs[legIndex].tiles.length-2,forward:true};
    s.onfoot.climbDown();SugarCube.Engine.play('OnFoot');
  },run.legs[0]);
  const leave=await page.evaluate(()=>(()=>{const w=SugarCube.setup.onfoot.getWalk(1);return 'Walk '+SugarCube.setup.units.kilometres(w.distanceKm)+' '+w.heading+' ('+Math.floor(w.minutes/60)+':'+String(w.minutes%60).padStart(2,'0')+')';})());
  await choose(page,leave,'OnFoot');
  assert.equal(await page.locator('#passages a').filter({hasText:/onto the branch/}).count(),0);
  const parked=await page.evaluate(()=>JSON.stringify(SugarCube.State.variables.journey));
  await choose(page,'Enter '+await stationName(page,to)+' railyard','Railyard');
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.currentStation),to);
  assert.equal(await page.evaluate(()=>JSON.stringify(SugarCube.State.variables.journey)),parked);
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.onFoot.inRailyard),true);
  assert.match(await page.locator('#passages').innerText(),/Your train remains parked out on the line/);
  // Boarding here is allowed: the train out on the line stays where it was left (setup.yards).
  assert.ok(await page.locator('#passages a').filter({hasText:/^Board Train/}).count()>0);
  assert.equal(await page.locator('.railyard-player-marker').count(),0,'the remote train is not drawn inside the yard');
  await choose(page,'Return to the station track','OnFoot');
  const returnToTrain=await page.evaluate(()=>(()=>{const w=SugarCube.setup.onfoot.getWalk(-1);return 'Walk '+SugarCube.setup.units.kilometres(w.distanceKm)+' '+w.heading+' ('+Math.floor(w.minutes/60)+':'+String(w.minutes%60).padStart(2,'0')+')';})());
  await choose(page,returnToTrain,'OnFoot');
  assert.equal(await page.evaluate(()=>SugarCube.setup.onfoot.isBesideTrain()),true);
  await choose(page,'Climb back aboard (0:02)','OnTheLine');
});

test('a siding on the line is a yard of its own, entered and left by choice',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const label=await page.evaluate(()=>{
    const {setup:s,State:{variables:v}}=SugarCube,route=s.realWorldPilot.getGridRoute();
    const tile=route.tiles.find(candidate=>s.yards.hasSiding(candidate)),place=route.place[tile.globalPosition];
    v.journey={legIndex:place.legIndex,tileIndex:place.tileIndex,forward:true};v.travellingForward=true;
    SugarCube.Engine.play('OnTheLine');
    return s.yards.enterLabel('siding:'+tile.x+','+tile.y);
  });
  await choose(page,label,'DrivingMode');
  assert.match(await page.evaluate(()=>String(SugarCube.State.variables.currentStation)),/^siding:-?\d+,-?\d+$/);
  assert.match(await page.locator('#passages').innerText(),/Siding near /);
  assert.equal(await page.locator('#passages svg.railyard-view, #passages .railyard-view svg').count()>0,true,'the siding is drawn as a yard');
  assert.ok(await page.locator('#passages a').filter({hasText:/^Depart /}).count()>0,'a siding can be left along its line');
});

test('boarding a yard train while the consist is out on the line leaves it standing there',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const run=await stationRunIn(page,2),[,to]=run.stations;
  await page.evaluate(legIndex=>{
    const {setup:s,State:{variables:v}}=SugarCube;
    v.journey={legIndex,tileIndex:s.realWorldPilot.getGridRoute().legs[legIndex].tiles.length-1,forward:true};
    s.onfoot.climbDown();SugarCube.Engine.play('OnFoot');
  },run.legs[0]);
  await choose(page,'Enter '+await stationName(page,to)+' railyard','Railyard');
  await page.locator('#passages a').filter({hasText:/^Board Train/}).first().click();
  await passage(page,'TrainInterior');
  const after=await page.evaluate(()=>{const v=SugarCube.State.variables;
    return {journey:v.journey,onFoot:v.onFoot,parked:Object.keys(v.lineTrains||{}).length,station:v.currentStation};});
  assert.deepEqual(after,{journey:null,onFoot:null,parked:1,station:to});
});

test('structurally corrupt imported saves leave the current run untouched',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  const results=await page.evaluate(()=>{
    const {setup:s,State,Save}=SugarCube;
    s.saves.save(0);
    const original=JSON.stringify(State.variables);
    return ['tracks','parked car','cargo','history'].map(kind=>{
      const data=JSON.parse(JSON.stringify(Save.slots.get(0)));
      const history=State.deltaDecode(data.state.delta),v=history[data.state.index].variables;
      if(kind==='tracks') v.stationTracks[v.currentStation]={};
      if(kind==='parked car') v.stationTracks[v.currentStation][1].trains=[[null]];
      if(kind==='cargo') v.currentTrain[0].cargo=[null];
      if(kind==='history') {history.unshift({title:'Railyard',variables:null});data.state.index++;}
      data.state.delta=State.deltaEncode(history);
      const loaded=s.saves.importText(JSON.stringify(data));
      return {kind,loaded,unchanged:JSON.stringify(State.variables)===original};
    });
  });
  for(const result of results) {
    assert.equal(result.loaded,false,result.kind);
    assert.equal(result.unchanged,true,result.kind);
  }
});

test('save validation accepts real multi-moment history and refuses corrupt browser slots before loading',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  await page.getByText('Options',{exact:true}).click();
  await page.getByLabel('Enable passage back and forward controls').check();
  await page.locator('#ui-dialog-close').click();
  assert.equal(await page.locator('#ui-bar-history').isVisible(),true);
  await choose(page,'Start driving','DrivingMode');
  await page.locator('#history-backward').click();await passage(page,'TrainInterior');
  await page.locator('#history-forward').click();await passage(page,'DrivingMode');
  const result=await page.evaluate(()=>{
    const {setup:s,State,Save}=SugarCube;
    s.saves.save(0);
    const saved=Save.slots.get(0),moments=State.deltaDecode(saved.state.delta).length;
    const original=JSON.stringify(State.variables),getSlot=s.saves.getSlot;
    const corrupt=JSON.parse(JSON.stringify(saved));corrupt.state.index=-1;
    let rejected,unchanged;
    try {
      s.saves.getSlot=()=>corrupt;
      rejected=!s.saves.load(0);unchanged=JSON.stringify(State.variables)===original;
    } finally {s.saves.getSlot=getSlot;}
    State.variables.enableHistoryControls=false;s.applyHistorySetting();
    return {moments,rejected,unchanged,loaded:s.saves.load(0)};
  });
  assert.ok(result.moments>1);
  assert.equal(result.rejected,true);assert.equal(result.unchanged,true);assert.equal(result.loaded,true);
  await passage(page,'DrivingMode');
  assert.equal(await page.locator('#ui-bar-history').isVisible(),true,'loading restores the saved preference');
  await page.reload();await passage(page,'DrivingMode');
  await page.locator('#ui-bar-history').waitFor({state:'visible'});
  await page.getByText('Options',{exact:true}).click();
  await page.getByLabel('Enable passage back and forward controls').uncheck();
  await page.locator('#ui-dialog-close').click();
  assert.equal(await page.locator('#ui-bar-history').isVisible(),false);
});

test('save confirmations, dedicated autosave, real export/import and invalid files preserve the run',async t=>{
  const page=await openGame(t);await begin(page);await board(page);
  await page.locator('#menu-item-saves a').click();
  const row=page.locator('.saves-slot[data-slot="0"]');
  await row.getByText('Save',{exact:true}).click();
  await row.getByText('Overwrite',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>{SugarCube.State.variables.player.hunger=37;SugarCube.setup.condition.autosaveAfterSleep();});
  assert.notEqual(await page.evaluate(()=>SugarCube.Save.slots.get(0).state.delta[0].variables.player.hunger),37);
  assert.equal(await page.evaluate(()=>SugarCube.Save.autosave.get().state.delta[0].variables.player.hunger),37);
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Save to disk',exact:true}).click();
  const download=await downloadPromise, exported=await download.path();
  assert.ok(fs.statSync(exported).size>0);
  await page.evaluate(()=>{SugarCube.State.variables.player.hunger=12;});
  await page.locator('.saves-file input').setInputFiles(exported);
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.waitForFunction(()=>SugarCube.State.variables.player.hunger===37);
  await page.locator('#menu-item-saves a').click();
  await page.locator('.saves-file input').setInputFiles({name:'invalid.save',mimeType:'text/plain',buffer:Buffer.from('not a save')});
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.getByText(/^Import failed\./).waitFor();
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.player.hunger),37);
  assert.ok(await page.evaluate(()=>!!SugarCube.Save.slots.get(0)));
  await row.getByText('Delete',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.ok(await page.evaluate(()=>!!SugarCube.Save.slots.get(0)));
});

test('finished help, deferred journal, separate debug tabs, and same-page scrolling respect the interface',async t=>{
  const page=await openGame(t,{viewport:{width:1000,height:650}});await enableDebug(page);await begin(page);await board(page);
  assert.equal(await page.locator('#passages .debug-container').count(),0);
  assert.deepEqual((await page.locator('#menu-story > li').allTextContents()).slice(-3),['Credits','Debug','Wiki']);
  assert.equal(await page.locator('#menu-story .developer-menu-item > a').first().evaluate(el=>getComputedStyle(el).color),'rgb(255, 102, 102)');
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  assert.equal(await page.locator('#developer-Wiki').isVisible(),true);
  assert.equal(await page.locator('#developer-Debug').isVisible(),false);
  await page.keyboard.press('Escape');
  await page.getByText('Help',{exact:true}).click();await passage(page,'Help');
  const help=await page.locator('#passages').innerText();
  assert.match(help,/The goal of this game is to drive a train around the earth/);
  assert.doesNotMatch(help,/TEMP HELP/);
  await page.locator('#passages details').nth(1).locator('summary').click();
  assert.match(await page.locator('#passages').innerText(),/Shunting is the process of moving railcars around in a railyard/);
  await choose(page,'Back','TrainInterior');
  assert.equal(await page.getByText('Journal',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.journal),undefined);
  const before=await page.evaluate(()=>{window.scrollTo(0,300);return scrollY;});
  await page.evaluate(()=>SugarCube.Engine.play('TrainInterior'));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>scrollY),before);
  await page.evaluate(()=>{SugarCube.State.variables.preserveScroll=false;SugarCube.Engine.play('TrainInterior');});
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>scrollY),0);
  await page.evaluate(()=>{SugarCube.State.variables.debugMode=false;SugarCube.Engine.play('TrainInterior');});
  assert.equal(await page.locator('#developer-tabs').count(),0);
  assert.equal(await page.locator('#menu-story .developer-menu-item').count(),0);
});

test('wiki links railcar graphics and lazily previews the shipped SVG catalogue',async t=>{
  const page=await openGame(t);await enableDebug(page);await beginTutorial(page);
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  const wiki=page.locator('#developer-Wiki');
  assert.equal(await wiki.locator('img').count(),0,'closed graphics do not load images');
  await wiki.locator('summary').filter({hasText:/^\+ Railcars$/}).click();
  await wiki.locator('.procedural-wiki summary').filter({hasText:/^\+ Locomotives$/}).click();
  const shunter=wiki.locator('tr').filter({hasText:/DE2-GB/}).first();
  await shunter.locator('summary').click();
  await shunter.locator('img').nth(3).waitFor();
  const captions=await shunter.locator('figcaption').allTextContents();
  for(const view of ['railyard','driving']) for(const facing of ['left','right']) {
    assert.ok(captions.some(text=>text.includes(`${view}-loco-diesel-shunter-${facing}.svg`)),captions.join('\n'));
  }
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('#developer-Wiki img')).every(img=>img.complete&&img.naturalWidth>0));
  await wiki.locator('#wiki-svg-browser > summary').click();
  const folder=key=>wiki.locator(`[data-wiki-folder="${key}"]`);
  assert.equal(await wiki.locator('#wiki-svg-browser img').count(),0);
  await folder('svg/Railyard').locator(':scope > summary').click();
  await folder('svg/Railyard/Vegetation and rocks').locator(':scope > summary').click();
  const select=wiki.getByLabel('SVG graphic: Railyard/Vegetation and rocks',{exact:true});
  await select.waitFor();
  const files=await select.locator('option').allTextContents();
  assert.ok(files.length>0 && files.every(file=>file.startsWith('railyard-plant-')));
  await select.selectOption({label:files.find(file=>file.includes('plant-'))});
  assert.equal(await wiki.locator('#wiki-svg-browser img').count(),1);
  assert.match(await wiki.locator('#wiki-svg-browser figcaption').innerText(),/plant-/);
  await page.getByRole('button',{name:'Close Wiki',exact:true}).click();
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  await wiki.locator('.procedural-wiki img').nth(3).waitFor({state:'attached'});
  assert.equal(await wiki.locator('.procedural-wiki img').count(),4,'refresh does not open every car graphics entry');
  assert.equal(await folder('svg/Railyard/Vegetation and rocks').getAttribute('open'),'');
  assert.equal(await folder('svg/Driving/Locomotives').getAttribute('open'),null,'same-named folders stay independent');
  for (const group of ['Railcars','Cargo and fuel','Inventory and survival','Stations']) {
    assert.equal(await folder('reference/'+group).count(),1);
  }
  // Every shipped asset appears in exactly one leaf folder; opening parents alone loads no images.
  await wiki.locator('#wiki-svg-browser details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
  await page.waitForFunction(()=>document.querySelectorAll('#wiki-svg-browser option').length===SugarCube.setup.svgWiki.catalogue().length);
  const allFiles=await wiki.locator('#wiki-svg-browser option').allTextContents();
  assert.equal(new Set(allFiles).size,allFiles.length);
});

test('wiki text browser safely searches source text, preserves filters and stays bounded on mobile',async t=>{
  const page=await openGame(t,{viewport:{width:390,height:844}});await enableDebug(page);await beginTutorial(page);
  if(await page.locator('#ui-bar').evaluate(el=>el.classList.contains('stowed'))) await page.locator('#ui-bar-toggle').click();
  const before=await page.evaluate(()=>JSON.stringify(SugarCube.State.variables));
  const previewCheck=await page.evaluate(()=>{
    const preview=SugarCube.setup.textPreview.render('<h3>Heading</h3><p>Read <strong>bold</strong> &amp; \'\'Twine bold\'\'.</p>'+
      '<<silently>>private code<<silently>>nested<</silently>>hidden<</silently>>'+
      '<<run State.variables.previewExecuted = true>><<print setup.dangerous()>>'+
      '<script>window.previewExecuted=true</script><img src="https://preview.invalid/image" onerror="window.previewExecuted=true">'+
      '<a href="javascript:alert(1)" onclick="window.previewExecuted=true">Read more</a>');
    document.body.appendChild(preview);
    const check={text:preview.textContent,headings:preview.querySelectorAll('h3').length,
      bold:preview.querySelectorAll('strong').length,unsafe:preview.querySelectorAll('script,img,[href],[onclick]').length};
    preview.remove();return check;
  });
  assert.equal(previewCheck.headings,1);assert.equal(previewCheck.bold,2);assert.equal(previewCheck.unsafe,0);
  assert.match(previewCheck.text,/Read bold & Twine bold/);
  assert.doesNotMatch(previewCheck.text,/private code|nested|hidden|setup\.|State\.|window\.|<<|<script/);
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  const text=page.locator('#wiki-text-browser');
  // The warning shows only while any text still carries a writing-pass tag.
  const pending=await page.evaluate(()=>SugarCube.setup.textWritingPendingCount||0);
  if(pending){
    assert.match(await page.locator('#developer-Wiki [data-writing-warning]').innerText(),/Writing review outstanding: \d+ marked text entries/);
    assert.equal(await page.locator('#developer-Wiki [data-writing-warning]').getAttribute('role'),'alert');
    assert.equal(await page.locator('#developer-Debug [data-writing-warning]').count(),1);
  } else assert.equal(await page.locator('#developer-Wiki [data-writing-warning]').count(),0);
  assert.equal(await page.evaluate(()=>{
    const s=SugarCube.setup,previous=s.textWritingPendingCount,host=document.createElement('div');
    try {s.textWritingPendingCount=0;s.textWiki.appendWarning(host);return host.childElementCount;}
    finally {s.textWritingPendingCount=previous;}
  }),0,'no warning when all writing tags have been cleared');
  assert.equal(await text.locator('input').count(),0,'catalogue controls stay lazy');
  assert.equal(await page.evaluate(()=>SugarCube.setup.textWiki.entries),null);
  await text.locator(':scope > summary').click();
  const query=text.getByLabel('Search',{exact:true});
  await query.waitFor();
  assert.ok(await text.locator('[data-text-results] > details').count()<=25);
  const status=text.locator('[role=status]'),jump=text.getByLabel('Page number',{exact:true});
  const pages=Number((await status.innerText()).match(/page 1 \/ (\d+)/)[1]);assert.ok(pages>3);
  await text.getByRole('button',{name:'Last',exact:true}).click();
  assert.match(await status.innerText(),new RegExp('page '+pages+' / '+pages));
  assert.equal(await text.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  await jump.fill('3');await jump.press('Enter');
  assert.match(await status.innerText(),/page 3 \//);
  await jump.fill(String(pages+100));await jump.press('Enter');
  assert.match(await status.innerText(),new RegExp('page '+pages+' /'),'a page past the end shows the last');
  await text.getByRole('button',{name:'First',exact:true}).click();
  assert.match(await status.innerText(),/page 1 \//);assert.equal(await jump.inputValue(),'1');
  const defaultMode=text.getByLabel('Preview default',{exact:true});
  assert.equal(await defaultMode.locator('option').count(),3);
  await defaultMode.selectOption('memory');
  await text.getByLabel('Category',{exact:true}).selectOption('passages');
  await query.fill('lone train engineer');
  const result=text.locator('[data-text-results] > details');
  await page.waitForFunction(()=>document.querySelectorAll('#wiki-text-browser [data-text-results] > details').length===1);
  await result.locator('summary').click();
  await result.locator('[data-text-preview]').waitFor();
  assert.match(await result.locator('[data-text-preview]').innerText(),/Begin your journey/);
  // Code may appear only in the source pointers Likea asked for, never in the rendered text itself.
  assert.doesNotMatch(await result.evaluate(el=>{const c=el.cloneNode(true);c.querySelectorAll('[data-definitions]').forEach(n=>n.remove());return c.innerText||c.textContent;}),/<<|startNewGame|<\/link>/);
  assert.match(await result.locator('[data-definitions]').first().innerText(),/<<startNewGame>> scripts\.js:\d+/);
  await result.locator('[data-text-preview] a').evaluate(el=>el.click());
  assert.equal(await page.evaluate(()=>JSON.stringify(SugarCube.State.variables)),before);
  await page.screenshot({path:'test-results/text-wiki-rendered.png'});
  // No passage prints a stat since the Sleep screen lost its Fatigue line; the debug condition picker's label does.
  // Searching by file:line finds it.
  const statLine=fs.readFileSync(path.join(__dirname,'..','source','scripts.js'),'utf8').split(/\r?\n/)
    .findIndex(line=>line.includes("stat.label + ' (' + setup.stats.getValue(stat.key)"))+1;
  assert.ok(statLine>0);
  await text.getByLabel('Category',{exact:true}).selectOption('');
  await query.fill('scripts.js:'+statLine);
  await page.waitForFunction(line=>{const rows=document.querySelectorAll('#wiki-text-browser [data-text-results] > details > summary');
    return rows.length===1&&rows[0].textContent.includes('source/scripts.js:'+line+' ');},statLine);
  await result.locator('summary').click();
  const stat=result.locator('[data-text-preview] select[aria-label*="STAT"]').first();
  await stat.waitFor();
  const displayed=()=>stat.evaluate(el=>el.selectedOptions[0].textContent);
  const currentFatigue=await displayed();
  await defaultMode.selectOption('zero');await stat.waitFor();assert.equal(await displayed(),'0');
  await defaultMode.selectOption('tokens');await stat.waitFor();assert.equal(await displayed(),'[STAT]');
  await stat.selectOption('custom');
  const manual=result.locator('[data-text-preview] input[aria-label*="Manual STAT"]').first();
  await manual.fill('12');assert.equal(await displayed(),'12');
  await defaultMode.selectOption('memory');await stat.waitFor();assert.equal(await displayed(),'12','manual override survives default change');
  await stat.selectOption('inherit');assert.equal(await displayed(),currentFatigue,'return to wiki default');
  await stat.selectOption('custom');await manual.fill('<img src=x onerror=alert(1)>');
  assert.equal(await result.locator('[data-text-preview] img').count(),0,'manual text never becomes HTML');
  await stat.selectOption('custom');await manual.fill('83');
  await page.getByRole('button',{name:'Close Wiki',exact:true}).click();
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  await query.waitFor();await result.locator('summary').click();await stat.waitFor();
  assert.equal(await displayed(),'83','override survives closing and reopening the wiki');
  assert.equal(await defaultMode.inputValue(),'memory');
  assert.equal(await page.evaluate(()=>JSON.stringify(SugarCube.State.variables)),before,'wiki edits never change game variables');
  await page.screenshot({path:'test-results/text-wiki-inline-values.png'});
  await text.getByLabel('Category',{exact:true}).selectOption('');
  await query.fill('Punta Arenas');
  await page.waitForTimeout(180);
  assert.ok(await result.count()>0);
  await text.getByLabel('Category',{exact:true}).selectOption('engine');
  await query.fill('');
  await page.waitForTimeout(180);
  assert.ok(await result.count()>0,'SugarCube UI strings are indexed too');
  await text.getByLabel('Category',{exact:true}).selectOption('scripts');
  await text.getByLabel('View pending unfinished writing passes',{exact:true}).check();
  await page.waitForTimeout(180);
  const marked=await page.evaluate(()=>SugarCube.setup.textWiki.find(SugarCube.setup.textWiki.selection).length);
  assert.equal(await result.count(),Math.min(25,marked));
  if(marked){
    await result.first().locator('summary').click();
    await result.first().locator('[data-text-preview]').waitFor();
    assert.match(await result.first().locator('[data-text-preview]').innerText(),/NEEDS WRITING PASS/);
  }
  const overflow=await text.evaluate(el=>el.scrollWidth>el.clientWidth+1);
  assert.equal(overflow,false,'source text wraps inside the mobile panel');
  await page.getByRole('button',{name:'Close Wiki',exact:true}).click();
  await page.getByRole('button',{name:'Wiki',exact:true}).click();
  await query.waitFor();
  assert.equal(await text.getByLabel('Category',{exact:true}).inputValue(),'scripts');
  assert.equal(await text.getByLabel('View pending unfinished writing passes',{exact:true}).isChecked(),true);
  await page.screenshot({path:'test-results/text-wiki-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'test-results/text-wiki-desktop.png',fullPage:true});
});

test('red developer sidebar menus work on mobile with keyboard and close controls',async t=>{
  const page=await openGame(t,{viewport:{width:390,height:844}});await enableDebug(page);await beginTutorial(page);
  if(await page.locator('#ui-bar').evaluate(el=>el.classList.contains('stowed'))) await page.locator('#ui-bar-toggle').click();
  const debug=page.locator('#menu-story').getByRole('button',{name:'Debug',exact:true});
  await debug.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#developer-Debug').isVisible(),true);
  const box=await page.locator('#developer-Debug').boundingBox();assert.ok(box.x>=0 && box.x+box.width<=391);assert.ok(box.width>=389,JSON.stringify(box));
  // The map is a globe the width of the panel, which has to fit the phone.
  await page.locator('#developer-Debug .globe-map').waitFor();
  const debugMapBox=await page.locator('#developer-Debug .globe-map').boundingBox();
  assert.ok(debugMapBox.width>=260&&debugMapBox.width<=391,JSON.stringify(debugMapBox));
  assert.equal(await page.locator('#developer-Debug .globe-map-controls button').count(),9);
  assert.ok(await page.locator('#developer-Debug select[aria-label$="Station to teleport to"] option').count()>1);
  const closeDebug=page.getByRole('button',{name:'Close Debug',exact:true});
  assert.equal(await closeDebug.evaluate(el=>getComputedStyle(el).textTransform),'uppercase');
  assert.ok(await closeDebug.evaluate(el=>el.offsetWidth/el.parentElement.clientWidth>.9));
  await closeDebug.click();
  assert.equal(await debug.getAttribute('aria-expanded'),'false');
  await page.locator('#menu-story').getByRole('button',{name:'Wiki',exact:true}).click();
  assert.equal(await page.locator('#developer-Wiki').isVisible(),true);
  await page.getByRole('button',{name:'Close Wiki',exact:true}).click();
  await page.getByText('Inventory',{exact:true}).click();
  const dialog=await page.locator('#ui-dialog').boundingBox();
  assert.ok(dialog.x>=0&&dialog.x+dialog.width<=390,JSON.stringify(dialog));
  assert.ok(Math.abs(dialog.width/390-.92)<.02,JSON.stringify(dialog));
});

test('the browser-console debug command enables debug mode during a run',async t=>{
  const page=await openGame(t);await begin(page);
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.debugMode),false);
  await page.evaluate('debug');
  await page.locator('#menu-story').getByRole('button',{name:'Debug',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>SugarCube.State.variables.debugMode),true);
  await page.evaluate(()=>{SugarCube.State.variables.debugMode=false;SugarCube.setup.sideTabs.refresh();});
  assert.equal(await page.locator('#menu-story .developer-menu-item').count(),0);
  assert.equal(await page.evaluate('debug()'),'Ashline debug mode enabled.');
  assert.equal(await page.locator('#menu-story .developer-menu-item').count(),2);
});

test('tutorial highlight is below stock, empty cabs and passenger cars are unlit, and map scroll is retained',async t=>{
  const page=await openGame(t);await beginTutorial(page);
  assert.match(await page.locator('.tutorial-hint').innerText(),/locomotive above/);
  assert.ok(await page.evaluate(()=>{
    const ground=document.querySelector('.tutorial-ground');
    const car=document.querySelector('use[data-template^="railyard-loco-"]');
    return ground.querySelector('.tutorial-next-target') && !!(ground.compareDocumentPosition(car)&Node.DOCUMENT_POSITION_FOLLOWING)
      && !document.querySelector('.railyard-hits .tutorial-next-target')
      && !document.querySelector('.railyard-view defs [fill="#dec38a"]');
  }));
  await board(page);
  await page.evaluate(()=>{
    const v=SugarCube.State.variables,s=SugarCube.setup;v.currentTrain.push(s.railyard.cloneCar(v.defaultTrains.kitchenCar));
    v.currentCarIndex=1;v.gameTimeTimestampMs=Date.UTC(2000,6,24,1);SugarCube.Engine.play('TrainInterior');
  });
  assert.equal(await page.locator('.consist-view-wrapper use[href$="-lit"]').count(),0);
  assert.equal(await page.locator('.consist-view-wrapper defs [fill="#dec38a"]').count(),0);
  await page.evaluate(()=>{SugarCube.State.variables.currentCarIndex=0;SugarCube.Engine.play('DrivingMode');});
  await page.getByTitle('Zoom in',{exact:true}).click();
  await page.getByTitle('Zoom in',{exact:true}).click();
  const position=await page.locator('.railyard-view-scroll').evaluate(e=>{e.scrollLeft=120;return e.scrollLeft;});
  assert.ok(position>0);
  await page.evaluate(()=>SugarCube.Engine.play('DrivingMode'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.railyard-view-scroll').evaluate(e=>e.scrollLeft),position);
});

test('onboard preview selects passenger cars with mouse or keyboard, shows contents, and uncouples a cold train', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables, copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const loco = v.stationTracks[1][1].trains[0][0]; loco.cargo = [];
    const coach = copy('passengerCoach'); coach.cargo = [{ type: 'food', amount: 100 }];
    v.stationTracks[1][1].trains[0].push(coach, copy('sleeperCoach'));
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  assert.equal(await page.getByText('Start driving', { exact: true }).count(), 0);
  const coach = page.locator('[data-car-index="1"]');
  await coach.hover();
  assert.match(await page.locator('.consist-details').innerText(), /food: 100 L/);
  await coach.click();
  await page.waitForFunction(() => SugarCube.State.variables.currentCarIndex === 1);
  await page.locator('[data-car-index="2"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => SugarCube.State.variables.currentCarIndex === 2);
  await page.locator('[data-car-index="0"]').click();
  await page.waitForFunction(() => SugarCube.State.variables.currentCarIndex === 0);
  await choose(page, 'Decouple the rear section (2 cars) (0:01)', 'TrainInterior');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentTrain.length), 1);
  assert.deepEqual(await page.evaluate(() => SugarCube.State.variables.stationTracks[1][1].trains.flat().map(car => car.type)), ['passenger coach', 'sleeper coach']);
});

test('push-detach-return is an ordinary validated yard action, including on a short stub', async t => {
  const page = await openGame(t);
  await begin(page); await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    v.currentTrain.unshift(JSON.parse(JSON.stringify(v.defaultTrains.flatcar))); v.currentCarIndex = 1;
    v.stationTracks[2] = [{ length: 80, trains: [] }, { length: 120, trains: [] },
      { length: 14, trains: [], connectsToExit: false }, { infinite: true, length: 999999, trains: [] }];
    v.currentStation = 2; v.drivingTrackIndex = 0; v.enteredTrainIndex = 0;
    SugarCube.Engine.play('DrivingMode');
  });
  await passage(page, 'DrivingMode');
  assert.equal(await page.locator('[data-yard-action="track:2"] a').count(), 0);
  await page.locator('[data-yard-action="setout:2:true"] a').click();
  await page.waitForFunction(() => SugarCube.State.variables.currentTrain.length === 1);
  assert.deepEqual(await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { track: v.drivingTrackIndex, car: v.currentCarIndex, parked: v.stationTracks[2][2].trains[0][0].type };
  }), { track: 0, car: 0, parked: 'flatcar' });
});

test('debug bug report exports seed, layout and recent actions with a selectable clipboard fallback', async t => {
  const page = await openGame(t);
  await enableDebug(page); await begin(page); await board(page);
  // An error the page did not catch is kept for the report (dispatched here, so the test itself does not fail on it),
  // and the same error again is counted rather than listed twice.
  // SugarCube's own handler, which would show its alert, is set aside while it is dispatched.
  await page.evaluate(() => {
    const failure = new Error('Something broke in the yard'), sugarCube = window.onerror;
    window.onerror = null;
    for (let i = 0; i < 3; i++) window.dispatchEvent(new ErrorEvent('error', { message: failure.message, error: failure, filename: 'file:///index.html', lineno: 12, colno: 3 }));
    window.onerror = sugarCube;
  });
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  await page.locator('.debug-container').getByRole('button', { name: 'Copy bug report', exact: true }).click();
  const reportText = page.getByRole('textbox', { name: 'Bug report' });
  const report = JSON.parse(await reportText.inputValue());
  assert.equal(report.seed, 'browser-regression');
  assert.equal(report.station, 1);
  assert.ok(report.tracks.length && report.consist.length && report.build);
  assert.ok(report.recentActions.length);
  assert.ok(report.recentActions.some(entry => entry.action.kind === 'passage' && entry.action.passage === 'TrainInterior'));
  const broke = report.errors.filter(error => error.message === 'Something broke in the yard');
  assert.equal(broke.length, 1, JSON.stringify(report.errors));
  assert.equal(broke[0].kind, 'uncaught');
  assert.equal(broke[0].count, 3);
  assert.equal(broke[0].where, 'index.html:12:3');
  assert.equal(broke[0].passage, 'TrainInterior');
  assert.match(broke[0].stack, /Something broke in the yard/);
  // Nothing unset appears as a revival expression.
  assert.ok(!(await reportText.inputValue()).includes('(revive:eval)'));
  await page.locator('#ui-dialog').getByRole('button', { name: 'Copy bug report', exact: true }).click();
  assert.equal(await reportText.getAttribute('readonly'), '');
});

async function passage(page, title) {
  await page.waitForFunction(expected => SugarCube.State.passage === expected && !SugarCube.Engine.isPlaying(), title);
}
async function choose(page, text, next) {
  const turn = await page.evaluate(() => SugarCube.State.turns);
  await page.locator('#passages').getByText(text, { exact: true }).click();
  if (next) {
    await page.waitForFunction(previous => SugarCube.State.turns > previous, turn);
    await passage(page, next);
  }
}
async function openSection(page, name) {
  const section=page.locator('details[data-ui-section="'+name+'"]');
  if(!await section.evaluate(el=>el.open)) await section.locator(':scope > summary').click();
}
// Runs a whole leg the way a player does: depart, then one move per tile until the yard at the far end. heading is a
// compass name, or null for any; toward, a place the departure names, or '' for any.
async function travelLeg(page, heading, toward = '') {
  await page.locator('#passages').getByText(new RegExp('^Depart ' + (heading || '\\S+') + ' toward ' + escapeRegExp(toward))).first().click();
  await passage(page, 'OnTheLine');
  for (let guard = 0; guard < 400; guard++) {
    // The line runs out outside the next station's yard, and the driver pulls in.
    const enter = await page.evaluate(() => {
      const s = SugarCube.setup, view = s.worldmap.getJourneyView();
      if (s.worldmap.getJourneyStep(1)) return '';
      const yard = s.yards.at(view.tile.x, view.tile.y).find(item => item.kind === 'station');
      return yard ? s.yards.enterLabel(yard.id) : '';
    });
    if (enter) { await page.locator('#passages').getByText(enter, { exact: true }).click(); break; }
    const turn = await page.evaluate(() => SugarCube.State.turns);
    await page.locator('#passages').getByText(/^Drive [\d.]+ km [a-z-]+ \(/).first().click();
    await page.waitForFunction(previous => SugarCube.State.turns > previous, turn);
    await page.waitForFunction(() => !SugarCube.Engine.isPlaying());
  }
  await passage(page, 'DrivingMode');
}
// Debug tools are folded away on the settings screen, so a test opens Advanced the way a player would.
async function enableDebug(page) {
  await page.locator('details.advanced-settings > summary').click();
  await page.locator('details.advanced-settings input[type=checkbox]').check();
}
async function begin(page) {
  await choose(page, 'Continue', 'Introduction');
  await choose(page, 'Begin your journey', 'Railyard');
  await plainYard(page);
}
// Station 1 is a shunting puzzle: the locomotive sits on a stub and a flatcar blocks the road out. Tests that are
// about something else flatten it to one plain yard track first, so they are not rewritten every time the puzzle
// changes. beginTutorial keeps the real layout.
async function beginTutorial(page) {
  await choose(page, 'Continue', 'Introduction');
  await choose(page, 'Begin your journey', 'Railyard');
}
async function plainYard(page) {
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const tracks = v.stationTracks[1];
    const exit = tracks[tracks.length - 1];
    exit.trains = []; // the puzzle's flatcar blocks the road out, and these tests are not about the puzzle
    v.stationTracks[1] = [tracks[0], { length: 120, trains: [tracks[1].trains[0]] }, exit];
    v.tutorialDone = true;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
}
async function board(page) {
  await choose(page, 'Board Train 1 (0:01)', 'TrainInterior');
}

test('the introduction always gives the authored journey objective', async t => {
  const page = await openGame(t);
  await choose(page, 'Continue', 'Introduction');
  const introduction = await page.locator('#passages').innerText();
  assert.match(introduction, /travel from Punta Arenas, Chile, to Cape Town, South Africa/);
});

test('new game: board, drive, travel both ways, leave, and board again', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  // A full tank: the first stop out of Punta Arenas is a long run, and this is about travelling both ways.
  await page.evaluate(() => { SugarCube.State.variables.currentTrain[0].cargo[0].amount = 1400; });
  await choose(page, 'Start driving', 'DrivingMode');
  const plan = await page.evaluate(() => ({
    fuel: SugarCube.State.variables.currentTrain[0].cargo[0].amount,
    time: SugarCube.State.variables.gameTimeTimestampMs
  }));
  await travelLeg(page, 'Northbound');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentStation), 2);
  // The way back is named for the way the line leaves this station, whichever way that is.
  await travelLeg(page, null, 'Punta Arenas');
  const after = await page.evaluate(() => ({
    station: SugarCube.State.variables.currentStation,
    fuel: SugarCube.State.variables.currentTrain[0].cargo[0].amount,
    time: SugarCube.State.variables.gameTimeTimestampMs
  }));
  const minutes = (after.time - plan.time) / 60000;
  assert.equal(after.station, 1);
  // Travel burns a litre of diesel a minute, tile by tile, in both directions.
  assert.ok(minutes >= 10, `both moves should cost real time, got ${minutes} minutes`);
  assert.equal(after.fuel, plan.fuel - minutes);
  await choose(page, 'Stop driving', 'TrainInterior');
  await choose(page, 'Leave the train (0:01)', 'Railyard');
  const parked = await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { active: v.currentTrain, count: v.stationTracks[1].flatMap(track => track.trains).length };
  });
  assert.deepEqual(parked, { active: null, count: 1 });
  await board(page);
  // Boarding again hands back the same train, with the fuel it had left when it was parked.
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentTrain[0].cargo[0].amount), after.fuel);
});

test('steam controls render, burn fuel once per minute, and survive save/load', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const loco = JSON.parse(JSON.stringify(v.defaultTrains.steamShunter));
    loco.cargo = [{ type: 'coal', amount: 100 }, { type: 'water', amount: 300 }];
    v.stationTracks[1][1].trains = [[loco]];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  await choose(page, 'Light the firebox', 'TrainInterior');
  await choose(page, 'Leave the train (0:01)', 'Railyard');
  let cargo = await page.evaluate(() => SugarCube.State.variables.stationTracks[1][1].trains[0][0].cargo);
  assert.deepEqual(cargo.map(c => c.amount), [98.75, 297]);
  await page.evaluate(() => { SugarCube.Save.slots.save(0); });
  await board(page);
  await page.evaluate(() => { SugarCube.Save.slots.load(0); });
  await passage(page, 'Railyard');
  cargo = await page.evaluate(() => SugarCube.State.variables.stationTracks[1][1].trains[0][0].cargo);
  assert.deepEqual(cargo.map(c => c.amount), [98.75, 297]);
  await page.getByText('Car details (1)',{exact:true}).first().click();
  assert.match(await page.locator('#passages').innerText(), /Coal: 98.75\./);
});

test('the first locomotive carries a kit, and pumps diesel from a coupled tanker for time and fatigue', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const tanker = JSON.parse(JSON.stringify(v.defaultTrains.tanker));
    tanker.cargo = [{ type: 'diesel', amount: 1000 }];
    v.stationTracks[1][1].trains[0].push(tanker);
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  await openSection(page,'inventory');
  const text = await page.locator('#passages').innerText();
  assert.match(text, /Kit \(6\/6 slots\): Toolkit · Axe and bow saw · Hand pump · Sleeping bag · Rations ×3 · 20 L jerrycan/);
  assert.match(text, /Diesel: 400.00 L/);
  const before = await page.evaluate(() => SugarCube.setup.time.getCurrentTimestampMs());
  await openSection(page,'refuelling');
  await choose(page, 'Pump diesel from the tanker, 400 L (0:20)', 'TrainInterior');
  const after = await page.evaluate(start => {
    const v = SugarCube.State.variables;
    return { train: v.currentTrain.map(car => car.cargo[0].amount), fatigue: v.player.fatigue,
      minutes: (SugarCube.setup.time.getCurrentTimestampMs() - start) / 60000 };
  }, before);
  // Three from the pumping itself, and one more from twenty minutes of simply being awake.
  assert.deepEqual(after, { train: [800, 600], fatigue: 4, minutes: 20 });
  const dieselText = await page.locator('#passages').innerText();
  assert.match(dieselText, /Diesel: 800.00 L/);
  assert.match(dieselText, /The diesel looks/);
  assert.doesNotMatch(dieselText, /grade \d+%/);
  assert.doesNotMatch(dieselText, /engine power\s+\d+%/i);
});

test('a Prairie is drawn as itself, shows its graded fuel, and cuts timber from a coupled flatcar into firewood', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const prairie = copy('steamPrairie');
    prairie.facing = 1;
    prairie.inventory = SugarCube.setup.items.createStartingKit();
    prairie.cargo = [{ type: 'coal', amount: 500, grade: 30 }, { type: 'water', amount: 2000 }];
    const flatcar = copy('flatcar');
    flatcar.cargo = [{ type: 'timber', amount: 1000, grade: 80 }];
    v.stationTracks[1][1].trains = [[prairie, flatcar]];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const drawn = await page.locator('.railyard-view use[data-template^="railyard-loco-"]').evaluateAll(uses => uses.map(use => use.dataset.template));
  assert.deepEqual(drawn, ['railyard-loco-steam-prairie-right']);
  await board(page);
  let text = await page.locator('#passages').innerText();
  const stats = await page.locator('.loco-panel .loco-stat').allTextContents();
  assert.ok(stats.some(row => /Model.*S262-PL/.test(row)), stats.join(' | '));
  assert.ok(stats.some(row => /Pull.*170 kN/.test(row)), stats.join(' | '));
  assert.ok(stats.some(row => /Top speed.*90 km\/h/.test(row)), stats.join(' | '));
  assert.match(text, /Coal: 500 L, grade 30% \(very poor\)/);
  assert.match(text, /This fuel runs too cold to fire the boiler/);
  await openSection(page,'refuelling');
  await choose(page, 'Cut timber into firewood, 150 kg (0:10)', 'TrainInterior');
  text = await page.locator('#passages').innerText();
  assert.match(text, /Coal: 500 L, grade 30% \(very poor\); Firewood: 375 L, grade 80% \(fair\)/);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.player.fatigue), 6);
});

test('the yard and the line are drawn by the light of the time of day', async t => {
  const page = await openGame(t);
  await enableDebug(page);
  await begin(page);
  // The debug clock jumps to any hour of the day.
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  const setHour = async hour => {
    await page.locator('#debugClockHour').selectOption(String(hour));
    const turn = await page.evaluate(() => SugarCube.State.turns);
    await page.getByRole('button', { name: 'Set Clock', exact: true }).click();
    await page.waitForFunction(() => !SugarCube.Engine.isPlaying());
    return turn;
  };
  const yard = () => page.evaluate(() => {
    const svg = document.querySelector('#passages svg.railyard-view');
    return { light: svg.dataset.light, ground: svg.querySelector('.railyard-ground').style.fill,
      windows: [...svg.querySelectorAll('defs [fill="#dec38a"]')].length,
      lit: [...svg.querySelectorAll('use')].filter(use => /-lit$/.test(use.getAttribute('href'))).length };
  });
  await setHour(13);
  let drawn = await yard();
  assert.equal(drawn.light, 'day');
  const dayGround = await page.evaluate(() => {
    const s = SugarCube.setup, profile = s.locales.forStation(SugarCube.State.variables.currentStation);
    const probe = document.createElement('span'); probe.style.fill = s.locales.BIOMES[profile.biome].ground;
    return probe.style.fill;
  });
  assert.equal(drawn.ground, dayGround);
  await setHour(1);
  drawn = await yard();
  assert.equal(drawn.light, 'night');
  assert.notEqual(drawn.ground, dayGround, 'the regional ground is graded at night');
  assert.equal(drawn.windows, 0, 'an empty cab is dark at night');
  assert.equal(drawn.lit, 0);
  assert.match(await page.locator('#developer-Debug').innerText(), /Light: night, sun -\d/);
  await page.getByRole('button', { name: 'Debug', exact: true }).click();

  // Once the player is aboard, the cab they are in is the one with a light on.
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  drawn = await yard();
  assert.ok(drawn.windows > 0, 'the occupied cab keeps its glow');
  assert.equal(drawn.lit, 1, 'exactly one car is drawn lit');
  await page.locator('#passages').getByText(/^Depart \S+ toward /).first().click();
  await passage(page, 'OnTheLine');
  const line = await page.evaluate(() => {
    const svg = document.querySelector('#passages svg.driving-view');
    return { light: svg.dataset.light, stars: svg.querySelectorAll('.driving-stars rect').length,
      headlamps: svg.querySelectorAll('.driving-headlamp').length,
      lit: [...svg.querySelectorAll('use')].filter(use => /-lit$/.test(use.getAttribute('href'))).length,
      windows: svg.querySelectorAll('defs [fill="#dec38a"]').length };
  });
  assert.equal(line.light, 'night');
  assert.ok(line.stars > 0);
  assert.equal(line.headlamps, 1);
  assert.equal(line.lit, 1, 'only the car the player is in is lit');
  assert.ok(line.windows > 0);
});

test('on a phone the yard fits the screen, opens readable, and keeps its controls clear of each other', async t => {
  // A Pixel 9a: 412 by 915 CSS pixels, touch, no hover.
  const page = await openGame(t, { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  const layout = await page.evaluate(() => {
    const box = el => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) }; };
    const svg = document.querySelector('#passages svg.railyard-view');
    const bands = [...svg.querySelectorAll('.railyard-hit')].map(b => box(b));
    return {
      pageWidth: document.scrollingElement.scrollWidth, viewport: document.documentElement.clientWidth,
      sidebarRight: Math.round(document.querySelector('#ui-bar').getBoundingClientRect().right),
      passageWidth: Math.round(document.querySelector('#passages').getBoundingClientRect().width),
      wrapper: box(document.querySelector('.railyard-view-wrapper')),
      zoom: box(document.querySelector('.railyard-view-zoom')),
      compass: box(document.querySelector('.railyard-compass')),
      message: box(document.querySelector('.railyard-view-message')),
      readout: document.querySelector('.railyard-view-zoom span').textContent,
      widestBand: Math.max(...bands.map(b => b.width))
    };
  });
  // The page itself never scrolls sideways, and the yard reaches into the passage margins without sliding under
  // the stowed sidebar.
  assert.equal(layout.pageWidth, layout.viewport, 'no horizontal page scroll');
  assert.ok(layout.wrapper.left >= layout.sidebarRight, `yard (${layout.wrapper.left}) clear of sidebar (${layout.sidebarRight})`);
  assert.ok(layout.wrapper.right <= layout.viewport, 'yard inside the screen');
  assert.ok(layout.wrapper.width > layout.passageWidth, 'the yard is wider than the passage column');
  // It opens at half zoom at least, which is the art at one pixel to one pixel, not shrunk to an unreadable fit.
  assert.equal(layout.readout, 'Fit', 'a yard wider than the screen opens fitted');
  // The controls do not sit on top of each other, and a track is a big enough target for a finger.
  assert.ok(layout.compass.bottom <= layout.message.top, 'compass clear of the message row');
  assert.ok(layout.zoom.bottom < layout.compass.top, 'zoom bar clear of the compass');
  assert.ok(layout.widestBand >= 44, `track targets are finger sized, got ${layout.widestBand}`);

  // Tapping a track the consist is not on offers the move with a confirm, and the buttons are big enough to hit.
  const other = await page.evaluate(() => {
    const svg = document.querySelector('#passages svg.railyard-view');
    const band = [...svg.querySelectorAll('.railyard-hit')].find(b => /^track:/.test(b.dataset.yardTarget)
      && b.dataset.yardTarget !== 'track:' + svg.dataset.playerTrack);
    return band ? band.dataset.yardTarget : null;
  });
  assert.ok(other, 'there is another track to tap');
  await page.locator(`.railyard-hit[data-yard-target="${other}"]`).first().tap();
  await page.waitForTimeout(100);
  const choices = await page.locator('.railyard-view-choice').evaluateAll(els => els.map(el => ({ text: el.textContent, height: Math.round(el.getBoundingClientRect().height) })));
  assert.ok(choices.length >= 2, JSON.stringify(choices));
  assert.ok(choices.every(choice => choice.height >= 30), JSON.stringify(choices));
  assert.equal(choices[choices.length - 1].text, 'Cancel');

  // The tapped target is outlined while the choice is up, because a tap leaves no hover behind to show it, and
  // cancelling clears it again.
  assert.equal(await page.evaluate(() => document.querySelectorAll('.railyard-hit-active').length), 1);
  await page.locator('.railyard-view-choice', { hasText: 'Cancel' }).tap();
  assert.equal(await page.evaluate(() => document.querySelectorAll('.railyard-hit-active').length), 0);

  // A parked train's target follows its own track, rather than being an upright box over the whole drawing.
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const car = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    v.stationTracks[1][2].trains = [[car('gondola'), car('boxcar'), car('gondola')]];
    SugarCube.Engine.play('DrivingMode');
  });
  await passage(page, 'DrivingMode');
  const train = await page.evaluate(() => {
    const area = document.querySelector('.railyard-hit-train');
    const band = document.querySelector('.railyard-hit:not(.railyard-hit-train):not(.railyard-hit-depart)');
    if (!area) return null;
    const box = area.getBBox();
    const trackBox = band.getBBox();
    return { shape: area.tagName, height: Math.round(box.height), width: Math.round(box.width),
      trackHeight: Math.round(trackBox.height), trackWidth: Math.round(trackBox.width) };
  });
  assert.equal(train.shape, 'polygon');
  // A band along the rails is about half as tall as it is wide; an upright box around the same cars is far taller.
  assert.ok(train.height < train.width, JSON.stringify(train));
  assert.ok(Math.abs(train.height / train.width - train.trackHeight / train.trackWidth) < 0.2, JSON.stringify(train));
});

test('the player eats, drinks and sleeps aboard, and collapses if they never do', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const tanker = JSON.parse(JSON.stringify(v.defaultTrains.tanker));
    tanker.cargo = [{ type: 'water', amount: 2000, grade: 80 }];
    v.stationTracks[1][1].trains[0].push(tanker);
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  await page.evaluate(() => {
    SugarCube.setup.stats.setValue('hunger', 30);
    SugarCube.setup.stats.setValue('thirst', 30);
    SugarCube.Engine.play('TrainInterior');
  });
  await passage(page, 'TrainInterior');
  assert.match(await page.locator('#passages').innerText(), /Rest and rations/);

  await choose(page, 'Eat a ration (0:10)', 'TrainInterior');
  await choose(page, 'Drink (0:02)', 'TrainInterior');
  const fed = await page.evaluate(() => ({ hunger: SugarCube.State.variables.player.hunger,
    thirst: SugarCube.State.variables.player.thirst,
    rations: SugarCube.setup.condition.countRations(SugarCube.State.variables.currentTrain),
    water: SugarCube.setup.railyard.getCargoAmount(SugarCube.State.variables.currentTrain[1], 'water') }));
  assert.equal(fed.rations, 2);
  assert.ok(fed.hunger > 60 && fed.thirst > 65, JSON.stringify(fed));
  assert.equal(fed.water, 1998);

  // Sleeping needs the bedroll, and the sleep screen offers the hours.
  await choose(page, 'Lie down to sleep', 'Sleep');
  await page.evaluate(() => { SugarCube.setup.stats.setValue('fatigue', 60); SugarCube.Engine.play('Sleep'); });
  await passage(page, 'Sleep');
  const hours = await page.locator('#passages a').allTextContents();
  assert.ok(hours.some(text => text.startsWith('Sleep 1 hour (1:00)')), hours.join(' | '));
  assert.ok(hours.some(text => text.startsWith('Sleep until rested')), hours.join(' | '));
  await choose(page, 'Sleep 4 hours (4:00)', 'TrainInterior');
  assert.ok(await page.evaluate(() => SugarCube.State.variables.player.fatigue) <= 15, 'four hours takes the edge off');

  // Working on and on without rest opens the dedicated blackout passage without moving the player.
  await page.evaluate(() => { SugarCube.setup.stats.setValue('fatigue', 100); });
  const clock = await page.evaluate(() => SugarCube.setup.time.getCurrentTimestampMs());
  const beforePlace=await page.evaluate(()=>({onFoot:SugarCube.State.variables.onFoot,car:SugarCube.State.variables.currentCarIndex}));
  await page.getByText('Drink (0:02)',{exact:true}).click();
  await passage(page,'Blackout');
  const after = await page.evaluate(() => ({ fatigue: SugarCube.State.variables.player.fatigue,
    onFoot:SugarCube.State.variables.onFoot,car:SugarCube.State.variables.currentCarIndex }));
  assert.ok(after.fatigue <= 75, `a collapse gives back a quarter of the bar, got ${after.fatigue}`);
  assert.deepEqual({onFoot:after.onFoot,car:after.car},beforePlace);
  const hoursLost = await page.evaluate(start => (SugarCube.setup.time.getCurrentTimestampMs() - start) / 3600000, clock);
  assert.ok(hoursLost >= 2 && hoursLost <= 6.1, `two to six hours pass, got ${hoursLost}`);
  const blackout=await page.locator('#passages').innerText();
  assert.match(blackout,/The exertion is too much\. You black out\./);
  assert.match(blackout,/You wake up on the ground, feeling groggy\. [0-9:]+ has passed\./);
  await choose(page,'Continue','TrainInterior');
});

test('the first station teaches shunting: off the stub, onto the flatcar, and away', async t => {
  const page = await openGame(t);
  await beginTutorial(page);
  const hint = () => page.evaluate(() => {
    const node = document.querySelector('#passages .tutorial-hint');
    return node ? node.dataset.hint : null;
  });

  // The yard is laid out so the way out is blocked: a stub with the locomotive, a flatcar on the road to the exit.
  const yard = await page.evaluate(() => SugarCube.State.variables.stationTracks[1].map(track => ({
    length: track.length, trains: track.trains.map(train => train.map(car => car.type)),
    closedToEntry: track.connectsToEntry === false, lead: !!track.infinite
  })));
  assert.equal(yard.length, 4);
  assert.deepEqual(yard[1].trains, [['diesel loco']]);
  assert.ok(!yard[0].lead, 'the Southbound run-around is a finite stub');
  assert.deepEqual(yard[3].trains, [['flatcar']], 'the flatcar blocks the road out');
  assert.equal(await hint(), 'board');

  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  assert.equal(await hint(), 'couple');

  // Nothing leaves this station until the flatcar is dealt with.
  const links = await page.locator('#passages a').allTextContents();
  assert.ok(!links.some(text => /^Depart /.test(text)), links.join(' | '));

  await choose(page, 'Couple to the front (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => SugarCube.State.variables.currentTrain.map(car => car.type)),
    ['flatcar', 'diesel loco']);
  assert.equal(await hint(), 'move-flatcar');
  await choose(page, 'Drive consist into Yard Track 2 (0:02)', 'DrivingMode');
  assert.equal(await hint(), 'decouple-flatcar');
  await choose(page, 'Decouple the front section (1 car) (0:01)', 'DrivingMode');
  assert.equal(await hint(), 'runaround-stub');
  await choose(page, 'Reverse consist to South Stub (0:01)', 'DrivingMode');
  assert.equal(await hint(), 'runaround-lead');
  await choose(page, 'Drive consist to Northbound Track (0:02)', 'DrivingMode');
  assert.equal(await hint(), 'couple-rear');
  await choose(page, 'Couple to the rear (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => SugarCube.State.variables.currentTrain.map(car => car.type)),
    ['diesel loco', 'flatcar']);
  assert.equal(await hint(), 'complete');

  // Leaving the station for the first time finishes the tutorial for good.
  await page.locator('#passages').getByText(/^Depart \S+ toward /).first().click();
  await passage(page, 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.tutorialDone), true);
  assert.equal(await hint(), null);
});

test('before the game starts, saves can be loaded but not made, and the debug tools stay away', async t => {
  const page = await openGame(t);
  // Make a save to load later: begin, save into slot 1, and return to the title.
  await begin(page);
  await page.locator('#menu-item-saves a').click();
  await page.locator('.saves-slot[data-slot="0"] .saves-button').first().click();
  await page.locator('.saves-slot[data-slot="0"] .saves-button', { hasText: 'Overwrite' }).waitFor();
  await page.evaluate(() => { SugarCube.Dialog.close(); SugarCube.Engine.play('Start'); });
  await passage(page, 'Start');
  for (const title of ['Start', 'Introduction']) {
    if (title === 'Introduction') {
      await page.evaluate(() => SugarCube.Engine.play('Introduction'));
      await passage(page, 'Introduction');
    }
    // The console command turns the flag on, but no debug tools appear here.
    const answer = await page.evaluate(() => window.debug && SugarCube.State.variables.debugMode);
    assert.equal(answer, true);
    assert.equal(await page.locator('#menu-story .developer-menu-item').count(), 0, title);
    assert.equal(await page.locator('#developer-tabs').count(), 0, title);
    assert.equal(await page.evaluate(() => SugarCube.setup.worldmap.debugTeleportToTile(0, 0, 0)), null, title);
    // The saves menu offers loading and deleting, not saving.
    await page.locator('#menu-item-saves a').click();
    await page.locator('.saves-menu').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.saves-menu .saves-button', { hasText: /^(Save|Overwrite|Save to disk)$/ }).count(), 0, title);
    assert.match(await page.locator('.saves-unavailable').innerText(), /Saving is available once the game has started/);
    assert.equal(await page.locator('.saves-slot[data-slot="0"] .saves-button', { hasText: 'Load' }).count(), 1, title);
    assert.equal(await page.evaluate(() => SugarCube.setup.saves.save(1)), false, title);
    assert.equal(await page.evaluate(() => SugarCube.setup.saves.getSlot(1)), null, 'nothing was saved into slot 2');
    await page.evaluate(() => SugarCube.Dialog.close());
  }
  // Loading from the introduction lands in the saved game, where saving and the debug tools are back.
  await page.locator('#menu-item-saves a').click();
  await page.locator('.saves-slot[data-slot="0"] .saves-button', { hasText: 'Load' }).click();
  await page.locator('#ui-dialog-body').getByRole('button', { name: 'Confirm', exact: true }).first().click();
  await page.waitForFunction(() => SugarCube.State.passage === 'Railyard');
  assert.equal(await page.evaluate(() => SugarCube.setup.saves.canSave()), true);
  // The save was made with debug off, and loading it restores that; the console command now brings the tools up.
  assert.equal(await page.evaluate(() => SugarCube.State.variables.debugMode), false);
  assert.equal(await page.evaluate(() => SugarCube.setup.enableDebugMode()), 'Ashline debug mode enabled.');
  assert.ok(await page.locator('#menu-story .developer-menu-item').count() > 0);
});

test('the saves menu shows what each slot holds, and asks for a backup when one is overdue', async t => {
  const page = await openGame(t);
  await begin(page);

  // The sidebar's Saves button opens our menu, with a row for every slot.
  await page.locator('#menu-item-saves a').click();
  await page.locator('.saves-menu').waitFor({ state: 'visible' });
  const slots = await page.locator('.saves-slot').count();
  assert.equal(slots, 9);
  assert.match(await page.locator('.saves-backup').innerText(), /No backup has been saved to disk/);

  // Saving into a slot records where the train is and when.
  await page.locator('.saves-slot[data-slot="0"] .saves-button').first().click();
  await page.locator('.saves-slot[data-slot="0"] .saves-button', { hasText: 'Overwrite' }).waitFor();
  const row = await page.locator('.saves-slot[data-slot="0"]').innerText();
  assert.match(row, /Punta Arenas/);
  assert.match(row, /July 24, 2000/);
  assert.match(row, /Overwrite/);
  assert.match(row, /Load/);
  assert.match(row, /Delete/);

  // No reminder yet: one save is not a habit. After a few, the banner asks for a backup.
  await page.evaluate(() => { SugarCube.Dialog.close(); });
  assert.equal(await page.locator('.save-reminder').count(), 0);
  await page.evaluate(() => {
    localStorage.setItem('ashline.saves.sinceExport', '9');
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const reminder = page.locator('.save-reminder');
  await reminder.waitFor({ state: 'visible' });
  assert.match(await reminder.innerText(), /9 saves since your last backup|never downloaded a copy/);

  // Dismissing it keeps it away for the rest of the session.
  await reminder.getByText('Later', { exact: true }).click();
  await page.evaluate(() => { SugarCube.Engine.play('Railyard'); });
  await passage(page, 'Railyard');
  assert.equal(await page.locator('.save-reminder').count(), 0);

  // Deleting a save empties its slot again.
  await page.locator('#menu-item-saves a').click();
  await page.locator('.saves-menu').waitFor({ state: 'visible' });
  await page.locator('.saves-slot[data-slot="0"] .saves-danger').click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  assert.match(await page.locator('.saves-slot[data-slot="0"]').innerText(), /Empty/);
});

test('the options screen changes how the game reads, without changing the game', async t => {
  const page = await openGame(t);
  await begin(page);
  const sidebar = () => page.locator('#story-caption').innerText();
  assert.match(await sidebar(), /July 24, 2000, 9:0\d AM/);
  assert.match(await sidebar(), /\d+(\.\d)?°C outside/);

  await page.getByText('Options', { exact: true }).click();
  const dialog = page.locator('#ui-dialog-body');
  await dialog.waitFor({ state: 'visible' });
  const labels = await dialog.locator('label').allTextContents();
  assert.ok(labels.some(text => /24-hour/.test(text)), labels.join(' | '));
  assert.ok(labels.some(text => /dd\/mm\/yyyy/.test(text)), labels.join(' | '));
  assert.ok(labels.some(text => /imperial/.test(text)), labels.join(' | '));
  assert.ok(labels.some(text => /Show clickable areas on railyard/.test(text)), labels.join(' | '));
  assert.ok(labels.some(text => /Autosave when you sleep/.test(text)), labels.join(' | '));

  // Imperial and a different date format change the writing, not the clock underneath.
  const clockBefore = await page.evaluate(() => SugarCube.setup.time.getCurrentTimestampMs());
  await dialog.getByText('imperial', { exact: false }).click();
  await dialog.getByText('yyyy/mm/dd', { exact: true }).click();
  await page.evaluate(() => { SugarCube.Dialog.close(); SugarCube.Engine.play('Railyard'); });
  await passage(page, 'Railyard');
  assert.match(await sidebar(), /2000\/07\/24/);
  assert.match(await sidebar(), /°F outside/);
  assert.equal(await page.evaluate(() => SugarCube.setup.time.getCurrentTimestampMs()), clockBefore);

  // The clickable areas can be shown all the time.
  assert.equal(await page.locator('.railyard-hits-shown').count(), 0);
  await page.getByText('Options', { exact: true }).click();
  await dialog.getByText('Show clickable areas on railyard', { exact: false }).click();
  await page.evaluate(() => { SugarCube.Dialog.close(); SugarCube.Engine.play('Railyard'); });
  await passage(page, 'Railyard');
  assert.equal(await page.locator('.railyard-hits-shown').count(), 1);
});

test('sleeping saves the game, unless the player would rather it did not', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Lie down to sleep', 'Sleep');
  await choose(page, 'Sleep 2 hours (2:00)', 'TrainInterior');
  const auto = await page.evaluate(() => {
    const save = SugarCube.Save.autosave.get();
    return save ? { title: save.title, automatic: save.metadata.automatic, place: save.metadata.place } : null;
  });
  assert.equal(auto.automatic, true);
  assert.match(auto.title, /^Autosave: Punta Arenas/);

  // Turned off, sleeping leaves the slot alone.
  await page.evaluate(() => {
    SugarCube.Save.autosave.delete();
    SugarCube.State.variables.autosaveOnSleep = false;
  });
  await choose(page, 'Lie down to sleep', 'Sleep');
  await choose(page, 'Sleep 2 hours (2:00)', 'TrainInterior');
  assert.equal(await page.evaluate(() => !!SugarCube.Save.autosave.get()), false);
});

test('the player can get down from the train out on the line and walk the track', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  await page.locator('#passages').getByText(/^Depart \S+ toward /).first().click();
  await passage(page, 'OnTheLine');

  assert.equal(await page.locator('#passages').getByText(/Climb down from the train/).count(),0);
  await choose(page,'Enter the train','TrainInterior');
  await choose(page, 'Climb down from the train (0:02)', 'OnFoot');
  let text = await page.locator('#passages').innerText();
  assert.match(text, /on the ballast beside your train/);
  assert.match(text, /Carrying: nothing/);
  assert.doesNotMatch(text,/Load what you are carrying into the train/);

  // Walking is an hour for every 5 km of track and hard work, against five minutes riding.
  const before = await page.evaluate(() => ({
    clock: SugarCube.setup.time.getCurrentTimestampMs(), fatigue: SugarCube.State.variables.player.fatigue }));
  // The passage replays itself, so wait for the turn rather than for the name to change.
  const walkAway = (await page.locator('#passages a').allTextContents()).find(text => /^Walk [\d.]+ km/.test(text));
  await choose(page, walkAway, 'OnFoot');
  const after = await page.evaluate(start => ({
    minutes: (SugarCube.setup.time.getCurrentTimestampMs() - start.clock) / 60000,
    fatigue: SugarCube.State.variables.player.fatigue - start.fatigue,
    beside: SugarCube.setup.onfoot.isBesideTrain()
  }), before);
  const [, km, hours, minutes] = /^Walk ([\d.]+) km .*\((\d+):(\d\d)\)$/.exec(walkAway);
  assert.equal(after.minutes, Number(hours) * 60 + Number(minutes), walkAway);
  assert.ok(Math.abs(after.minutes - Number(km) * 12) <= 1, walkAway);
  assert.ok(after.fatigue >= 4, `walking should tell on you, got ${after.fatigue}`);
  assert.equal(after.beside, false);
  text = await page.locator('#passages').innerText();
  assert.match(text, /The train is further down the line/);
  assert.equal(await page.locator('#passages a').filter({ hasText: 'Climb back aboard' }).count(), 0);

  // Walking back reaches the train again, and climbing aboard returns the player to the cab.
  const walkBack = (await page.locator('#passages a').allTextContents()).filter(text => /^Walk [\d.]+ km/.test(text)).pop();
  await choose(page, walkBack, 'OnFoot');
  assert.equal(await page.evaluate(() => SugarCube.setup.onfoot.isBesideTrain()), true);
  await choose(page, 'Climb back aboard (0:02)', 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.onFoot), null);

  // The pack is in the cab, and the axe can be moved between it and the locomotive's kit.
  await choose(page, 'Enter the train', 'TrainInterior');
  await openSection(page,'inventory');
  assert.match(await page.locator('.player-pack').innerText(), /You are carrying \(0\/16 squares, 0 kg\/50 kg\): nothing/);
  await choose(page, 'Take the axe and bow saw', 'TrainInterior');
  assert.match(await page.locator('.player-pack').innerText(), /Axe and bow saw/);
  assert.equal(await page.evaluate(() => SugarCube.setup.items.countItem(SugarCube.State.variables.currentTrain[0], 'axe')), 0);
});

test('debug cargo editor targets the initially selected train', async t => {
  const page = await openGame(t);
  await enableDebug(page);
  await begin(page);
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  await page.locator('#debugCarSelect').selectOption('0');
  await passage(page, 'Railyard');
  const quantity = page.locator('#debugCargoAmount');
  await quantity.fill('10');
  await page.getByRole('button', { name: 'Add Cargo', exact: true }).click();
  await passage(page, 'Railyard');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.stationTracks[1][1].trains[0][0].cargo[0].amount), 410);
});

test('new games spawn in and drive the sourced network', async t => {
  const page = await openGame(t, { viewport: { width: 1000, height: 700 } });
  await begin(page);
  assert.match(await page.locator('#passages').innerText(), /Punta Arenas/);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    v.currentStation = 2;
    v.stationTracks[2] = SugarCube.setup.railyard.generateStationTracks(2, v.randomSeed);
    v.drivingTrackIndex = v.stationTracks[2].length - 1;
    v.enteredTrainIndex = v.stationTracks[2][v.drivingTrackIndex].trains.length;
    SugarCube.Engine.play('DrivingMode');
  });
  await passage(page, 'DrivingMode');
  const before = await page.evaluate(() => ({
    train: JSON.stringify(SugarCube.State.variables.currentTrain),
    time: SugarCube.setup.time.getCurrentTimestampMs(),
    fuel: SugarCube.setup.railyard.getCargoAmount(SugarCube.State.variables.currentTrain[0], 'diesel')
  }));
  const [secondName, secondExit] = [await stationName(page, 2), await exitName(page, 2)];
  await page.locator('#passages').getByText(await departTo(page, 2)).click();
  await passage(page, 'OnTheLine');
  const map = await page.locator('#passages .driving-view-wrapper').boundingBox();
  assert.ok(map && map.y < 100, JSON.stringify(map));
  assert.match(await page.locator('#passages').innerText(), new RegExp(escapeRegExp(secondName + ' to ' + secondExit) + '.*Tile 1 of \\d+', 's'));
  await page.locator('#passages a').filter({ hasText: /^Drive [\d.]+ km/ }).first().click();
  await passage(page, 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey.tileIndex), 1);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey.realWorldCorridorId), undefined);
  const terrain = await page.evaluate(() => SugarCube.setup.worldmap.getJourneyView().tile);
  assert.ok(Number.isFinite(terrain.elevation) && Number.isFinite(terrain.elevationStdDevM));
  assert.ok(await page.evaluate(time => SugarCube.setup.time.getCurrentTimestampMs() > time, before.time));
  assert.ok(await page.evaluate(fuel => SugarCube.setup.railyard.getCargoAmount(SugarCube.State.variables.currentTrain[0], 'diesel') < fuel, before.fuel));
  assert.equal(await page.evaluate(() => SugarCube.setup.saves.save(0)), true);
  await page.evaluate(() => { SugarCube.State.variables.journey.tileIndex = 4; });
  assert.equal(await page.evaluate(() => SugarCube.setup.saves.load(0)), true);
  await passage(page, 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey.tileIndex), 1);
  assert.equal(await page.evaluate(train => {
    const current = JSON.parse(JSON.stringify(SugarCube.State.variables.currentTrain));
    const original = JSON.parse(train);
    current[0].cargo = original[0].cargo;
    return JSON.stringify(current) === JSON.stringify(original);
  }, before.train), true, 'the same consist and car order enter the sourced grid');
  await page.locator('#passages a').filter({ hasText: /^Reverse [\d.]+ km/ }).first().click();
  // Back on the station's square the train stands on the line; pulling into the yard is a choice.
  await passage(page, 'OnTheLine');
  await choose(page, 'Enter ' + await stationName(page, 2) + ' railyard', 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey), null);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentStation), 2);
});

test('seed text remains literal when revisiting settings', async t => {
  const page = await openGame(t);
  const seed = 'seed " quote <<set $seedInjected = true>>';
  await page.locator('details.advanced-settings > summary').click();
  await page.locator('input[type=text]').fill(seed);
  await choose(page, 'Continue', 'Introduction');
  await page.evaluate(() => { SugarCube.Engine.play('Start'); });
  await passage(page, 'Start');
  await page.locator('details.advanced-settings > summary').click();
  assert.equal(await page.locator('input[type=text]').inputValue(), seed);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.seedInjected), undefined);
});

test('coupling and front decoupling preserve the occupied car and all parked cars', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const car = JSON.parse(JSON.stringify(v.defaultTrains.boxcar));
    car.reviewId = 'coupled';
    v.stationTracks[1][1].trains = [[car]];
  });
  await choose(page, 'Start driving', 'DrivingMode');
  await choose(page, 'Couple to the front (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => ({
    types: SugarCube.State.variables.currentTrain.map(car => car.type),
    carIndex: SugarCube.State.variables.currentCarIndex
  })), { types: ['boxcar', 'diesel loco'], carIndex: 1 });
  await choose(page, 'Decouple the front section (1 car) (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { active: v.currentTrain.map(car => car.type), index: v.currentCarIndex,
      parked: v.stationTracks[1][1].trains.flat().map(car => car.reviewId), gap: v.enteredTrainIndex };
  }), { active: ['diesel loco'], index: 0, parked: ['coupled'], gap: 0 });
  await choose(page, 'Stop driving', 'TrainInterior');
  await choose(page, 'Leave the train (0:01)', 'Railyard');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.stationTracks[1][1].trains.flat().length), 2);
});

test('full-track shove uses a boundary track and keeps the driver in the locomotive', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const car = JSON.parse(JSON.stringify(v.defaultTrains.boxcar));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    v.stationTracks[2] = [lead(), { length: 12, trains: [[car]] }, lead()];
    v.currentStation = 2;
    v.drivingTrackIndex = 0;
    v.enteredTrainIndex = 0;
  });
  await choose(page, 'Start driving', 'DrivingMode');
  await choose(page, 'Couple to entire track and shove to Northbound Track (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { track: v.drivingTrackIndex, index: v.currentCarIndex,
      driverCar: v.currentTrain[v.currentCarIndex].type, cars: v.currentTrain.length,
      parked: v.stationTracks[2][1].trains.length };
  }), { track: 2, index: 1, driverCar: 'diesel loco', cars: 2, parked: 0 });
});

test('insufficient fuel explains the failure and leaves the entire move unchanged', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => { SugarCube.State.variables.currentTrain[0].cargo[0].amount = 2; });
  await choose(page, 'Start driving', 'DrivingMode');
  await page.locator('#passages').getByText(/^Depart \S+ toward /).first().click();
  await passage(page, 'OnTheLine');
  const before = await page.evaluate(() => JSON.stringify(SugarCube.State.variables));
  await page.locator('#passages').getByText(/^Drive [\d.]+ km [a-z-]+ \(/).first().click();
  assert.match(await page.locator('#ui-dialog').innerText(), /Not enough fuel or steam/);
  const after = await page.evaluate(() => {
    const v = { ...SugarCube.State.variables };
    v.timedActionFailure = '';
    return JSON.stringify(v);
  });
  assert.equal(after, before);
});

test('browser refresh and save restoration preserve current-car edits and discovery', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  await choose(page, 'Drive consist to Northbound Track (0:01)', 'DrivingMode');
  await page.evaluate(() => { SugarCube.Save.slots.save(0); });
  await page.reload();
  await passage(page, 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 2);
  await choose(page, 'Stop driving', 'TrainInterior');
  await choose(page, 'Leave the train (0:01)', 'Railyard');
  await page.evaluate(() => { SugarCube.Save.slots.load(0); });
  await passage(page, 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentTrain[0].cargo[0].amount), 399);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.stationTracks[1].flatMap(track => track.trains).length), 0);
});

test('legacy intro saves load as an introduction without resetting gameplay state', async t => {
  const page = await openGame(t);
  await choose(page, 'Continue', 'Introduction');
  await page.evaluate(() => {
    SugarCube.Save.onSave.add(function(save) {
      for (const moment of save.state.history) {
        if (moment.title === 'Introduction') {
          moment.title = 'StoryInit';
          moment.variables.player.immunity = 73;
        }
      }
    });
    // Saving is closed on the introduction now, so lift the gate just long enough to write the old-style save.
    const allowed = SugarCube.Config.saves.isAllowed;
    SugarCube.Config.saves.isAllowed = null;
    SugarCube.Save.slots.save(0);
    SugarCube.Config.saves.isAllowed = allowed;
    SugarCube.Save.slots.load(0);
  });
  await passage(page, 'Introduction');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.player.immunity), 73);
  assert.equal(await page.locator('#passages').getByText('Begin your journey', { exact: true }).count(), 1);
});

test('time-display option updates the sidebar immediately', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.getByText('Options', { exact: true }).click();
  await page.locator('#ui-dialog-body #checkbox-use24hourtime').check();
  assert.match(await page.locator('#story-caption').innerText(), /9:00/);
  assert.doesNotMatch(await page.locator('#story-caption').innerText(), /AM|PM/);
});

test('reverse full-track shove and rear decoupling preserve the occupied car', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const car = JSON.parse(JSON.stringify(v.defaultTrains.boxcar));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    v.stationTracks[2] = [lead(), { length: 12, trains: [[car]] }, lead()];
    v.currentStation = 2;
    v.drivingTrackIndex = 2;
    v.enteredTrainIndex = 0;
  });
  await choose(page, 'Start driving', 'DrivingMode');
  await choose(page, 'Couple to entire track and shove to Southbound Track (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { track: v.drivingTrackIndex, index: v.currentCarIndex, cars: v.currentTrain.map(car => car.type) };
  }), { track: 0, index: 0, cars: ['diesel loco', 'boxcar'] });
  await choose(page, 'Decouple the rear section (1 car) (0:01)', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => {
    const v = SugarCube.State.variables;
    return { gap: v.enteredTrainIndex, active: v.currentTrain.length, parked: v.stationTracks[2][0].trains.flat().length };
  }), { gap: 1, active: 1, parked: 1 });
});

test('cross-track coupling cannot overflow the current finite track', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    v.stationTracks[1][1].length = 18;
    v.stationTracks[1][2].trains = [[JSON.parse(JSON.stringify(v.defaultTrains.boxcar))]];
  });
  await choose(page, 'Start driving', 'DrivingMode');
  // An option that cannot be taken is not printed; the drawing keeps the reason for when the player asks.
  assert.equal(await page.locator('#passages a').filter({ hasText: /^Couple to the front/ }).count(), 0);
  assert.match(await page.locator('#passages .yard-reason').allTextContents().then(all => all.join(' ')),
    /combined consist will not fit/);
  assert.equal(await page.locator('#passages a').filter({ hasText: /^Couple to the (front|rear)/ }).count(), 0);
});

test('rail yard view draws the station layout and the player\'s consist', async t => {
  const page = await openGame(t);
  await begin(page);
  const readView = () => page.evaluate(() => {
    const view = document.querySelector('#passages svg.railyard-view');
    const templates = [...view.querySelectorAll('use')].map(image => image.dataset.template);
    return {
      cars: templates.filter(name => /^railyard-(car|loco)-/.test(name)),
      tiles: templates.filter(name => name === 'railyard-track-tile').length,
      selectedTiles: templates.filter(name => name === 'railyard-track-tile-selected').length,
      unbundled: [...view.querySelectorAll('use')].filter(use => {
        const target = view.querySelector(use.getAttribute('href'));
        return !target || !target.querySelector('polygon, path, circle, ellipse, rect');
      }).length,
      labels: [...view.querySelectorAll('text')].map(text => text.textContent),
      markers: view.querySelectorAll('.railyard-player-marker').length
    };
  });

  const yard = await readView();
  assert.deepEqual(yard.cars, ['railyard-loco-diesel-shunter-right']);
  assert.deepEqual(yard.labels, ['SOUTH STUB \u00b7 80 m free of 80 m', '01 \u00b7 111 m free of 120 m', 'NORTHBOUND TRACK']);
  assert.ok(yard.tiles > 0);
  assert.equal(yard.selectedTiles, 0);
  assert.equal(yard.unbundled, 0);
  assert.equal(yard.markers, 0);

  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  const driving = await readView();
  assert.deepEqual(driving.cars, ['railyard-loco-diesel-shunter-right']);
  assert.ok(driving.selectedTiles > 0);
  assert.equal(driving.markers, 1);
	assert.match(await page.locator('#passages svg.railyard-view use[data-template*="loco"] title').textContent(), /Contents: diesel 400/);
});

test('rail yard view joins the yard tracks to the entry and exit leads with Y switches', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = trains => ({ length: 999999, infinite: true, trains });
    // Leads at opposite corners: the geometry gives every track the same length.
    const lengths = SugarCube.setup.railyard.getYardTrackLengths(3, 1, 3, 120);
    v.stationTracks[1] = [
      lead([]),
      { length: lengths[0], trains: [] },
      { length: lengths[1], trains: [[copy('dieselShunter'), copy('boxcar')]] },
      { length: lengths[2], trains: [] },
      lead([[copy('flatcar')]])
    ];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const drawn = await page.evaluate(() => {
    const templates = [...document.querySelectorAll('#passages svg.railyard-view use')].map(image => image.dataset.template);
    const count = name => templates.filter(template => template === name).length;
    return {
      splits: count('railyard-track-y-split'),
      yySplits: count('railyard-track-yy-split'),
      merges: count('railyard-track-y-merge'),
      yyMerges: count('railyard-track-yy-merge'),
      fadeIns: count('railyard-track-fade-in'),
      fadeOuts: count('railyard-track-fade-out'),
      cars: templates.filter(template => /^railyard-(car|loco)-/.test(template)),
      labels: [...document.querySelectorAll('#passages svg.railyard-view text')].map(text => text.textContent)
    };
  });
  assert.deepEqual(drawn, {
    splits: 1,
    yySplits: 1,
    merges: 1,
    yyMerges: 1,
    fadeIns: 1,
    fadeOuts: 1,
    cars: ['railyard-car-boxcar', 'railyard-loco-diesel-shunter-right', 'railyard-car-flatcar'],
    labels: ['SOUTHBOUND TRACK', '01 \u00b7 120 m free of 120 m', '02 \u00b7 99 m free of 120 m', '03 \u00b7 120 m free of 120 m', 'NORTHBOUND TRACK']
  });
});

test('rail yard view draws dead ends where tracks do not connect to the entry or exit', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    v.stationTracks[1] = [
      lead(),
      { length: 100, trains: [], connectsToExit: false },
      { length: 100, trains: [], connectsToEntry: false },
      { length: 100, trains: [] },
      { length: 100, trains: [], connectsToEntry: false },
      lead()
    ];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const counts = await page.evaluate(() => {
    const templates = [...document.querySelectorAll('#passages svg.railyard-view use')].map(image => image.dataset.template);
    const count = name => templates.filter(template => template === 'railyard-track-' + name).length;
    return {
      splits: count('y-split'), yySplits: count('yy-split'), merges: count('y-merge'), yyMerges: count('yy-merge'),
      diagonals: count('diagonal'),
      startStops: count('buffer-stop-start'), endStops: count('buffer-stop')
    };
  });
  // Entry ladder reaches track 3: Y split at 1, diagonal past 2. Exit ladder starts at track 2: YY merge at 3, Y merge into 4.
  assert.deepEqual(counts, { splits: 1, yySplits: 0, merges: 1, yyMerges: 1, diagonals: 1, startStops: 2, endStops: 1 });
  const trackInfo=await page.locator('#passages h3 + p.small-description').allTextContents();
  assert.ok(trackInfo.includes('100m long, 100m free, no link to the Northbound Track.'),trackInfo.join(' | '));
  assert.ok(trackInfo.includes('100m long, 100m free, no link to the Southbound Track.'),trackInfo.join(' | '));
  // A track may not be closed at both ends, or its trains could never leave.
  const rule = await page.evaluate(() => {
    const railyard = SugarCube.setup.railyard;
    railyard.setDebugTrackConnections(1, 3, false, false);
    const track = SugarCube.State.variables.stationTracks[1][3];
    return {
      unchanged: track.connectsToEntry === undefined && track.connectsToExit === undefined,
      closedBoth: railyard.getTrackConnections({ connectsToEntry: false, connectsToExit: false })
    };
  });
  assert.deepEqual(rule, { unchanged: true, closedBoth: { entry: false, exit: false } });
});

test('rail yard view places the entry and exit leads on any yard track', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const lead = track => ({ length: 999999, infinite: true, trains: [], leadTrack: track });
    // Entry lead on track 3 and exit on track 2, with the lengths that shape implies.
    const yard = SugarCube.setup.railyard.getYardTrackLengths(5, 3, 2, 200).map(length => ({ length, trains: [] }));
    v.stationTracks[1] = [lead(3)].concat(yard, [lead(2)]);
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const drawing = await page.evaluate(() => {
    const out = {};
    [...document.querySelectorAll('#passages svg.railyard-view use[data-template]')]
      .map(use => use.dataset.template.replace('railyard-track-', ''))
      .filter(name => /split|merge|diagonal/.test(name))
      .forEach(name => { out[name] = (out[name] || 0) + 1; });
    const template = SugarCube.setup.railyardView.templateDocuments['railyard-track-yy-merge-up'];
    const ballast = template.querySelector('#diagonal-up-ballast polygon').getAttribute('points').trim().split(/\s+/)
      .map(point => point.split(',').map(Number));
    return { counts: out, ballastYValues: new Set(ballast.map(point => point[1])).size,
      slantedEnds: ballast[0][0] !== ballast[3][0] && ballast[1][0] !== ballast[2][0] };
  });
  // Entry on track 3: ladders branch both ways. Exit on track 2: track 1 joins from above, tracks 3-5 from below.
  assert.deepEqual(drawing.counts, { 'y-split-both': 1, 'yy-split': 1, 'yy-split-up': 1, 'y-merge-both': 1, 'yy-merge-up': 2 });
  assert.equal(drawing.ballastYValues, 2, 'straight up-ladder bent in projection');
  assert.equal(drawing.slantedEnds, true, 'up-ladder reverted to square, misaligned joints');
  const leads = await page.evaluate(() => {
    const railyard = SugarCube.setup.railyard;
    const tracks = railyard.generateStationTracks(7, 'lead-test');
    return { entry: railyard.getLeadTrack(tracks, 'entry'), exit: railyard.getLeadTrack(tracks, 'exit'), stored: tracks[0].leadTrack, yard: tracks.length - 2 };
  });
  assert.ok(leads.stored >= 1 && leads.entry <= leads.yard && leads.exit >= 1 && leads.exit <= leads.yard, JSON.stringify(leads));
});

test('stations without an entry or exit track still leave the player a way out', async t => {
  const page = await openGame(t);
  await begin(page);
  const first = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('#passages svg.railyard-view text')].map(text => text.textContent),
    fadeIns: [...document.querySelectorAll('#passages svg.railyard-view use')]
      .filter(use => use.dataset.template === 'railyard-track-fade-in').length,
    headers: [...document.querySelectorAll('#passages h3')].map(header => header.textContent),
    refusal: SugarCube.setup.railyard.setDebugLeads(1, true, true)
  }));
  // Nothing lies behind station 1, so it has no entry track to draw, list, or travel through.
  assert.deepEqual(first.labels, ['SOUTH STUB \u00b7 80 m free of 80 m', '01 \u00b7 111 m free of 120 m', 'NORTHBOUND TRACK']);
  assert.equal(first.fadeIns, 0);
  assert.ok(!first.headers.some(header => header.startsWith('Southbound Track')), first.headers.join(' | '));
  assert.match(first.refusal, /station 1/);

  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
    v.stationTracks[2] = [lead({ direction: 'south' }), { length: 120, trains: [] },
      lead({ hasLead: false, direction: 'north' })];
    // A full tank for the long run there and back.
    v.currentTrain[0].cargo[0].amount = 1400;
  });
  await choose(page, 'Start driving', 'DrivingMode');
  assert.equal(await page.locator('#passages').getByText('Reverse consist to Northbound Track').count(), 0);
  await travelLeg(page, 'Northbound');
  const second = await page.evaluate(() => ({
    station: SugarCube.State.variables.currentStation,
    labels: [...document.querySelectorAll('#passages svg.railyard-view text')].map(text => text.textContent)
  }));
  const drivingText = await page.locator('#passages').innerText();
  // Station 2 has no exit track: the yard track ends in a buffer stop and only the way back is offered.
  assert.equal(second.station, 2);
  assert.deepEqual(second.labels, ['SOUTHBOUND TRACK', '01 \u00b7 120 m free of 120 m']);
  assert.equal(await page.locator('#passages a').filter({ hasText: /^Depart Northbound/ }).count(), 0);
  assert.match(await page.locator('#passages .yard-reason').allTextContents().then(all => all.join(' ')),
    new RegExp('Depart Northbound toward ' + escapeRegExp(await exitName(page, 2)) + ' unavailable: This station has no Northbound Track'));
  assert.doesNotMatch(drivingText, /Drive consist to Northbound Track/);
  await travelLeg(page, 'Southbound');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentStation), 1);
});

test('lead tracks are named for the compass direction a train leaves by', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
    // The route turns east at station 2: the player arrives from the south and leaves eastbound.
    v.stationTracks[2] = [lead({ direction: 'south' }), { length: 120, trains: [] }, lead({ direction: 'east' })];
  });
  await choose(page, 'Start driving', 'DrivingMode');
  await travelLeg(page, 'Northbound');
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('#passages svg.railyard-view text')].map(text => text.textContent));
  const drivingText = await page.locator('#passages').innerText();
  // The drawing keeps its shape; only the names follow the compass.
  assert.deepEqual(labels, ['SOUTHBOUND TRACK', '01 \u00b7 120 m free of 120 m', 'EASTBOUND TRACK']);
  assert.match(drivingText, /Drive consist to Eastbound Track/);
  assert.match(drivingText, new RegExp('Depart Eastbound toward ' + escapeRegExp(await exitName(page, 2))));
  assert.match(drivingText, /Depart Southbound toward Punta Arenas/);
  await choose(page, 'Stop driving', 'TrainInterior');
  await choose(page, 'Leave the train (0:01)', 'Railyard');
  const headers = await page.locator('#passages h3').allTextContents();
  assert.ok(headers.some(header => header.startsWith('Eastbound Track')), headers.join(' | '));
  assert.ok(headers.some(header => header.startsWith('Southbound Track')), headers.join(' | '));
});

test('debug mode draws the whole world network on the globe, and names the square under the pointer', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    SugarCube.State.variables.debugMode = true;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  // The network is only drawn once the panel is open.
  assert.equal(await page.locator('#developer-Debug .globe-map').count(), 0);
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  const globe = page.locator('#developer-Debug .globe-map');
  await globe.waitFor();
  await page.waitForFunction(() => document.querySelector('#developer-Debug .globe-map-canvas').width > 200);
  // Everything revealed: every square, every station, no fog; opened on the player.
  const map = await page.evaluate(() => {
    const holder = document.querySelector('#developer-Debug .globe-map'), known = holder.globeKnown;
    const route = SugarCube.setup.realWorldPilot.getGridRoute();
    const here = SugarCube.setup.wayfinding.getHereTile().geoCoordinate, view = holder.globeView;
    return { revealAll: known.revealAll, squares: Object.keys(known.tiles).length, allSquares: route.tiles.length,
      stations: known.stations.length, allStations: route.corridor.stations.length, segments: known.segments.length,
      newLines: known.segments.filter(segment => segment.kind === 'new').length,
      view: [view.lon * 180 / Math.PI, view.lat * 180 / Math.PI], here,
      heading: holder.closest('details').querySelector('.debug-map-heading').textContent };
  });
  assert.equal(map.revealAll, true);
  assert.equal(map.squares, map.allSquares);
  assert.equal(map.stations, map.allStations);
  assert.ok(map.segments > 100000 && map.newLines > 1000, JSON.stringify(map));
  assert.ok(Math.abs(map.view[0] - map.here[0]) < 0.01 && Math.abs(map.view[1] - map.here[1]) < 0.01, JSON.stringify(map));
  assert.match(map.heading, /^[A-Z][A-Za-z ]* railway network: \d+ grid squares, \d+ legs, \d+ stations; \d+ km of mapped railway joined by \d+ new lines/);
  // One line under the map names the square under the pointer: over the player, a square on the track.
  const at = await page.evaluate(() => {
    const holder = document.querySelector('#developer-Debug .globe-map'), here = SugarCube.setup.wayfinding.getHereTile().geoCoordinate;
    holder.centreOn(here[0], here[1], 1);
    const p = holder.screenOf(here[0], here[1]), box = holder.querySelector('.globe-map-overlay').getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  });
  await page.mouse.move(at.x + 1, at.y + 1);
  assert.match(await page.locator('#developer-Debug .debug-map-hover').innerText(), /^(.+ \| )?grid -?\d+,-?\d+/);
  // The debug map can outline its grid squares, close in; dragging draws the quick way and settles without error.
  const gridToggle = page.locator('#developer-Debug .debug-map-grid-toggle');
  assert.equal(await gridToggle.count(), 1);
  await gridToggle.check();
  await page.mouse.move(at.x + 1, at.y + 1);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await gridToggle.uncheck();
  const prototype = page.locator('details.debug-section').filter({
		has: page.getByText('Global rail data', { exact: true })
  });
  if (!await prototype.evaluate(element => element.open)) await prototype.locator(':scope > summary').click();
  // The section summarises the playable network; the old planning corridors are no longer drawn.
  assert.match(await prototype.innerText(), /is the active gameplay world: \d+ grid squares, \d+ legs and \d+ stations/);
  assert.equal(await prototype.locator('svg.world-graph-debug').count(), 0);
  const reference = page.locator('details.debug-section').filter({ has: page.getByText('Reference data', { exact: true }) });
  await page.getByRole('button', { name: 'Wiki', exact: true }).click();
  await reference.getByText('Railcars', { exact: true }).click();
  await reference.getByText('Locomotives', { exact: true }).click();
  await reference.getByText('Cargo and fuel', { exact: true }).click();
  await reference.getByText('Fuel', { exact: true }).click();
  await reference.getByText('Inventory and survival', { exact: true }).click();
  await reference.getByText('Pack items', { exact: true }).click();
  const referenceText = await reference.innerText();
  assert.match(referenceText, /DE2-GB/);
  assert.match(referenceText, /Diesel minimum usable grade/);
  assert.match(referenceText, /Hand pump/);
});

test('debug map teleport carries an onboard consist into a station clicked on the globe', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    SugarCube.State.variables.debugMode = true;
    SugarCube.Engine.play('TrainInterior');
  });
  await passage(page, 'TrainInterior');
  const consistBefore = await page.evaluate(() => JSON.stringify(SugarCube.State.variables.currentTrain));
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  const mapSection = page.locator('details.debug-section').filter({
    has: page.getByText('World rail grid', { exact: true })
  });
  if (!await mapSection.evaluate(element => element.open)) await mapSection.locator(':scope > summary').click();
  assert.ok(await mapSection.locator('select[aria-label$="Station to teleport to"] option').count() > 1);
  await page.waitForFunction(() => document.querySelector('#developer-Debug .globe-map-canvas').width > 200);
  // Station 3, brought to the middle of the view close in, and clicked.
  const at = await page.evaluate(() => {
    const holder = document.querySelector('#developer-Debug .globe-map');
    const place = SugarCube.setup.realWorldPilot.getStationTile(3).geoCoordinate;
    holder.centreOn(place[0], place[1], 1.2);
    const p = holder.screenOf(place[0], place[1]), box = holder.querySelector('.globe-map-overlay').getBoundingClientRect();
    return { x: box.left + p[0], y: box.top + p[1] };
  });
  await page.mouse.click(at.x, at.y);
  await passage(page, 'TrainInterior');
  const moved = await page.evaluate(() => ({
    consist: JSON.stringify(SugarCube.State.variables.currentTrain),
    journey: JSON.parse(JSON.stringify(SugarCube.State.variables.journey)),
    onFoot: SugarCube.State.variables.onFoot,
    station: SugarCube.State.variables.currentStation
  }));
  assert.equal(moved.consist, consistBefore);
  assert.equal(moved.station, 3);
  assert.equal(moved.journey, null);
  assert.equal(moved.onFoot, null);
  assert.match(await page.locator('.debug-teleport-notice').innerText(),
    new RegExp('Teleported the complete consist to ' + escapeRegExp(await stationName(page, 3)) + ' station'));
});

test('the debug globe zooms with its buttons and the wheel, and a drag turns it without teleporting', async t => {
  const page = await openGame(t, { viewport: { width: 1300, height: 950 } });
  await begin(page);
  await board(page);
  await page.evaluate(() => { SugarCube.State.variables.debugMode = true; SugarCube.Engine.play('TrainInterior'); });
  await passage(page, 'TrainInterior');
  await page.getByRole('button', { name: 'Debug', exact: true }).click();
  const mapSection = page.locator('details.debug-section').filter({ has: page.getByText('World rail grid', { exact: true }) });
  if (!await mapSection.evaluate(element => element.open)) await mapSection.locator(':scope > summary').click();
  await page.waitForFunction(() => document.querySelector('#developer-Debug .globe-map-canvas').width > 200);
  const view = () => page.evaluate(() => {
    const v = document.querySelector('#developer-Debug .globe-map').globeView;
    return { lon: v.lon, lat: v.lat, pxPerKm: v.pxPerKm, rotation: v.rotation * 180 / Math.PI };
  });
  const opening = await view();
  await mapSection.getByRole('button', { name: 'Zoom out' }).click();
  assert.ok((await view()).pxPerKm < opening.pxPerKm * 0.7);
  await mapSection.getByRole('button', { name: 'Zoom in' }).click();
  await mapSection.getByRole('button', { name: 'Zoom in' }).click();
  assert.ok((await view()).pxPerKm > opening.pxPerKm * 1.3);
  // Zoomed all the way out, the whole globe fits the view.
  for (let step = 0; step < 12; step++) await mapSection.getByRole('button', { name: 'Zoom out' }).click();
  const fitted = await page.evaluate(() => {
    const holder = document.querySelector('#developer-Debug .globe-map'), canvas = holder.querySelector('.globe-map-canvas');
    return { diameter: 2 * 6371.0088 * holder.globeView.pxPerKm, width: canvas.clientWidth, height: canvas.clientHeight };
  });
  assert.ok(fitted.diameter <= Math.min(fitted.width, fitted.height), JSON.stringify(fitted));
  // The wheel zooms too.
  const overlay = mapSection.locator('.globe-map-overlay');
  const box = await overlay.boundingBox();
  const beforeWheel = await view();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  assert.ok((await view()).pxPerKm > beforeWheel.pxPerKm);
  // The pad turns the map by 15 degrees a press, pans by compass direction however it is turned, and its pan arrows
  // turn to point their way; the compass needle turns it back to north up.
  await mapSection.getByRole('button', { name: 'Turn the map 15 degrees clockwise' }).click();
  await mapSection.getByRole('button', { name: 'Turn the map 15 degrees clockwise' }).click();
  assert.ok(Math.abs((await view()).rotation - 30) < 0.01, JSON.stringify(await view()));
  const beforeNorth = await view();
  await mapSection.getByRole('button', { name: 'Pan north' }).click();
  const afterNorth = await view();
  assert.ok(afterNorth.lat > beforeNorth.lat, JSON.stringify({ beforeNorth, afterNorth }));
  await mapSection.getByRole('button', { name: 'Pan east' }).click();
  assert.ok((await view()).lon > afterNorth.lon);
  assert.equal(await mapSection.getByRole('button', { name: 'Pan north' }).locator('span').evaluate(span => span.style.transform), 'rotate(-30deg)');
  await mapSection.getByRole('button', { name: 'Turn the map 15 degrees anticlockwise' }).click();
  assert.ok(Math.abs((await view()).rotation - 15) < 0.01);
  await page.mouse.click(box.x + 20, box.y + 22);
  assert.equal((await view()).rotation, 0);
  // A drag turns the globe and teleports nobody, even when it starts on the track.
  await mapSection.getByRole('button', { name: 'Centre on where you are' }).click();
  const before = await page.evaluate(() => JSON.stringify([SugarCube.State.passage, SugarCube.State.variables.currentStation, SugarCube.State.variables.journey]));
  const turned = await view();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 90, { steps: 6 });
  await page.mouse.up();
  const after = await view();
  assert.ok(after.lon !== turned.lon && after.lat !== turned.lat, JSON.stringify({ turned, after }));
  assert.equal(await page.evaluate(() => JSON.stringify([SugarCube.State.passage, SugarCube.State.variables.currentStation, SugarCube.State.variables.journey])), before);
});

test('station buildings stand behind the yard, and the HQ and a water store serve a diesel crew', async t => {
  const page = await openGame(t);
  await begin(page);
  // Punta Arenas has its Station HQ and a diesel tank, drawn behind the yard.
  const drawn = await page.evaluate(() => [...document.querySelectorAll('svg.railyard-view use[data-template^="railyard-building-"]')]
    .map(use => use.getAttribute('data-template')).sort());
  assert.deepEqual(drawn, ['railyard-building-diesel-tank', 'railyard-building-station-hq']);
  await board(page);
  const supplies = page.locator('details').filter({ has: page.getByText('Station supplies', { exact: true }) });
  if (!await supplies.evaluate(element => element.open)) await supplies.locator(':scope > summary').click();
  const text = await supplies.innerText();
  assert.match(text, /Here: Station HQ, Diesel tank\./);
  // A diesel takes no water, but the crew can still carry some away, at the yard's poor grade.
  assert.match(text, /Collect from Punta Arenas: [\d.,]+ (L|gal) water \(grade 40%\)/);
  const rations = () => page.evaluate(() => SugarCube.setup.items.getPlayerKit().filter(slot => slot.item === 'rations')
    .reduce((n, slot) => n + slot.count, 0));
  const before = await rations();
  await supplies.getByText(/^Take a ration from the station HQ/).click();
  await page.waitForFunction(count => SugarCube.setup.items.getPlayerKit().filter(slot => slot.item === 'rations')
    .reduce((n, slot) => n + slot.count, 0) > count, before);
  const again = page.locator('details').filter({ has: page.getByText('Station supplies', { exact: true }) });
  if (!await again.evaluate(element => element.open)) await again.locator(':scope > summary').click();
  await again.getByText(/^Fill up with [\d.,]+ (L|gal) of drinking water \(grade 95%\)/).click();
  await page.waitForFunction(() => SugarCube.setup.items.getPlayerCargo().some(stack => stack.type === 'water' && stack.grade === 95));
});

test('a station at the end of a line has a map of the railways around it', async t => {
  const page = await openGame(t);
  await begin(page);
  // Punta Arenas is the end of a line, so its map is the first one seen; with none seen, the Map tab says so.
  assert.deepEqual(await page.evaluate(() => SugarCube.setup.wayfinding.getSeenMaps()), [1]);
  await page.evaluate(() => { SugarCube.State.variables.seenMaps = []; });
  await page.locator('#menu-story').getByText('Map', { exact: true }).click();
  await page.locator('#ui-dialog').getByText(/You have not seen any maps yet/).waitFor();
  await page.evaluate(() => SugarCube.Dialog.close());
  const terminus = await page.evaluate(() => {
    const stations = SugarCube.setup.realWorldPilot.getGridRoute().corridor.stations;
    const id = stations.findIndex((station, index) => index > 0 && station.lines.length === 1) + 1;
    SugarCube.State.variables.currentStation = id;
    SugarCube.Engine.play('Railyard');
    return { id, name: stations[id - 1].name };
  });
  await passage(page, 'Railyard');
  const section = page.locator('details').filter({ has: page.getByText('Station map', { exact: true }) });
  if (!await section.evaluate(element => element.open)) await section.locator(':scope > summary').click();
  await section.locator('svg.station-map').waitFor();
  assert.match(await section.locator('svg.station-map .station-map-label').allTextContents().then(labels => labels.join('|')),
    new RegExp(terminus.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(you are here\\)'));
  const listed = await section.locator('.station-map-list li').allInnerTexts();
  assert.ok(listed.every(line => /: [\d.,]+ (km|mi)$/.test(line)), JSON.stringify(listed));
  // Having looked at it, the Map tab's globe opens on where the player is, marked in red at the middle, and names the
  // maps read.
  await page.locator('#menu-story').getByText('Map', { exact: true }).click();
  const dialog = page.locator('#ui-dialog');
  await dialog.locator('canvas.globe-map-canvas').waitFor();
  await page.waitForFunction(() => document.querySelector('canvas.globe-map-canvas').width > 200);
  const globe = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.globe-map-overlay'), view = document.querySelector('.globe-map').globeView;
    const middle = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    const here = SugarCube.setup.wayfinding.getHereTile().geoCoordinate;
    return { middle: Array.from(middle), view: [view.lon * 180 / Math.PI, view.lat * 180 / Math.PI], here };
  });
  assert.ok(Math.abs(globe.view[0] - globe.here[0]) < 0.01 && Math.abs(globe.view[1] - globe.here[1]) < 0.01, JSON.stringify(globe));
  assert.ok(globe.middle[0] > 180 && globe.middle[1] < 140, 'here is marked in red: ' + JSON.stringify(globe.middle));
  assert.equal(await dialog.locator('.debug-map-grid-toggle').count(), 0, 'the grid squares are the debug map\'s alone');
  // The legend says what the marks mean.
  assert.ok(await dialog.locator('.globe-map-legend li').count() >= 5);
  assert.match(await dialog.innerText(), new RegExp('Maps from ' + terminus.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.evaluate(() => SugarCube.Dialog.close());
  // A station on a through line has none.
  await page.evaluate(() => {
    const stations = SugarCube.setup.realWorldPilot.getGridRoute().corridor.stations;
    SugarCube.State.variables.currentStation = stations.findIndex(station => station.lines.length === 2) + 1;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  assert.equal(await page.getByText('Station map', { exact: true }).count(), 0);
});

test('at a junction out on the line the driver picks the way on', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  // Put the consist at the end of a leg that runs into a junction, then drive on from there.
  const setupJunction = await page.evaluate(() => {
    const route = SugarCube.setup.realWorldPilot.getGridRoute();
    const leg = Object.values(route.legs).find(candidate => candidate.fromNode.kind === 'station' && candidate.toNode.kind === 'junction'
      && SugarCube.setup.realWorldPilot.getJunctionChoices(candidate.index, candidate.tiles.length - 1).length >= 2);
    const v = SugarCube.State.variables;
    v.currentStation = leg.fromStationIndex;
    v.journey = { legIndex: leg.index, tileIndex: leg.tiles.length - 1, forward: true };
    v.currentTrain[0].cargo = [{ type: 'diesel', amount: 400 }];
    SugarCube.Engine.play('OnTheLine');
    return { legIndex: leg.index };
  });
  await passage(page, 'OnTheLine');
  await page.locator('#passages').getByText('The line divides here.').waitFor();
  // A signpost gives each way on and the towns down it.
  const signLines = await page.locator('#passages .junction-sign p').allInnerTexts();
  assert.ok(signLines.length >= 3 && signLines.every(line => /^(North|South|East|West)/.test(line)), JSON.stringify(signLines));
  assert.ok(signLines.some(line => /\d+(\.\d)? (km|mi)/.test(line)), JSON.stringify(signLines));
  const choices = await page.evaluate(() => SugarCube.setup.worldmap.getBranchChoices().filter(choice =>
    !SugarCube.setup.worldmap.getBranchStep(choice.id).blocked).map(choice => choice.legIndex));
  assert.ok(choices.length >= 1, JSON.stringify(choices));
  // Nothing drives straight on past the junction; each way on is its own link, named for its heading.
  assert.equal(await page.evaluate(() => SugarCube.setup.worldmap.getJourneyStep(1)), null);
  const links = page.locator('#passages a').filter({ hasText: /^Drive [\d.,]+ (km|mi) / });
  assert.ok(await links.count() >= choices.length);
  await links.first().click();
  await page.waitForFunction(legIndex => !SugarCube.State.variables.journey || SugarCube.State.variables.journey.legIndex !== legIndex,
    setupJunction.legIndex);
  const after = await page.evaluate(() => SugarCube.State.variables.journey && SugarCube.State.variables.journey.legIndex);
  assert.ok(after === null || choices.includes(after), String(after));
});

test('driving the line goes one tile at a time, and draws the consist on it', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => { SugarCube.State.variables.currentStation = 2; });
  await choose(page, 'Start driving', 'DrivingMode');
  await page.locator('#passages').getByText(await departTo(page, 2)).first().click();
  await passage(page, 'OnTheLine');

  const start = await page.evaluate(() => {
    const view = SugarCube.setup.worldmap.getJourneyView();
    const svg = document.querySelector('#passages svg.driving-view');
    return {
      tileIndex: view.tileIndex, tileCount: view.tileCount, terrain: view.terrain,
      cars: [...svg.querySelectorAll('use')].map(use => use.dataset.template).filter(name => /^driving-(car|loco)-/.test(name)),
      terrainTiles: [...svg.querySelectorAll('use')].filter(use => /^driving-terrain-/.test(use.dataset.template)).length,
      track: [...svg.querySelectorAll('use')].filter(use => use.dataset.template === 'driving-track').length,
      markers: svg.querySelectorAll('.driving-player-marker').length,
      status: document.querySelector('#passages h2').textContent,
      fuel: SugarCube.State.variables.currentTrain[0].cargo[0].amount,
      time: SugarCube.State.variables.gameTimeTimestampMs
    };
  });
  // The consist is drawn on the tile it stands on, forward to the right, with the terrain behind it.
  assert.deepEqual(start.cars, ['driving-loco-diesel-shunter-right']);
  assert.ok(start.terrainTiles > 0 && start.track > 0, JSON.stringify(start));
  assert.equal(start.markers, 1);
  assert.equal(start.tileIndex, 0);
  assert.equal(start.status, 'On the line');

  await page.locator('#passages').getByText(/^Drive [\d.]+ km [a-z-]+ \(/).first().click();
  await passage(page, 'OnTheLine');
  const moved = await page.evaluate(() => ({
    tileIndex: SugarCube.setup.worldmap.getJourneyView().tileIndex,
    fuel: SugarCube.State.variables.currentTrain[0].cargo[0].amount,
    time: SugarCube.State.variables.gameTimeTimestampMs
  }));
  // One tile costs its own time, and travelling burns a litre of diesel a minute.
  const minutes = (moved.time - start.time) / 60000;
  assert.equal(moved.tileIndex, 1);
  assert.ok(minutes >= 3 && minutes <= 20, `a tile should cost a few minutes, got ${minutes}`);
  assert.equal(moved.fuel, start.fuel - minutes);

  // The interior offers a way down even between stations; reversing still returns to the previous tile.
  await choose(page, 'Enter the train', 'TrainInterior');
  const interior = await page.locator('#passages').innerText();
  assert.match(interior, /Climb down from the train/);
  assert.doesNotMatch(interior, /Leave Train/);
  await choose(page, 'Start driving', 'OnTheLine');

  // Backing onto the station's own square stops on the line outside its yard; pulling in is a choice.
  await page.locator('#passages').getByText(/^Reverse [\d.]+ km [a-z-]+ \(/).first().click();
  await passage(page, 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.setup.worldmap.getJourneyView().tileIndex), 0);
  await choose(page, 'Enter ' + await stationName(page, 2) + ' railyard', 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => ({
    station: SugarCube.State.variables.currentStation,
    journey: SugarCube.State.variables.journey
  })), { station: 2, journey: null });

  // Departing again, the yard is still right there: backing in costs nothing, which is the way out for a
  // consist that sets off without the fuel to get anywhere.
  await page.locator('#passages').getByText(await departTo(page, 2)).first().click();
  await passage(page, 'OnTheLine');
  await choose(page, 'Enter ' + await stationName(page, 2) + ' railyard', 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey), null);
});

test('the sourced corridor exposes real adjacent stations without fictional side tracks', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    v.currentStation = 2;
    SugarCube.Engine.play('DrivingMode');
  });
  await passage(page, 'DrivingMode');
  const text = await page.locator('#passages').innerText();
  assert.match(text, /Depart \S+ toward Punta Arenas/);
  assert.match(text, await departTo(page, 2));
  assert.doesNotMatch(text, /side track|branch/i);
});

test('a yard has one line out of each end, and a line into a junction says so', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  // No station anywhere has two lines leaving the same end.
  assert.equal(await page.evaluate(() => SugarCube.setup.realWorldPilot.getGridRoute().corridor.stations
    .filter(station => station.lines.filter(line => line.side === 'exit').length > 1
      || station.lines.filter(line => line.side === 'entry').length > 1).length), 0);
  // The first station, counting out from Punta Arenas, whose exit line runs to a junction out on the line.
  const station = await page.evaluate(() => {
    const pilot = SugarCube.setup.realWorldPilot, count = pilot.getGridRoute().corridor.stations.length;
    for (let id = 1; id <= count; id++) {
      const line = pilot.getStationLines(id).find(candidate => candidate.side === 'exit' && !candidate.destination);
      if (!line || !/^the junction/.test(line.destinationName)) continue;
      const v = SugarCube.State.variables;
      v.currentStation = id;
      v.stationTracks[id] = SugarCube.setup.railyard.generateStationTracks(id, v.randomSeed);
      v.drivingTrackIndex = v.stationTracks[id].length - 1;
      v.enteredTrainIndex = 0;
      SugarCube.Engine.play('DrivingMode');
      return { id, legIndex: line.legIndex, name: line.destinationName };
    }
    return null;
  });
  assert.ok(station, 'some station leads to a junction');
  await passage(page, 'DrivingMode');
  const depart = page.locator('#passages').getByText(new RegExp('^Depart \\S+ toward ' + station.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')).first();
  await depart.click();
  await passage(page, 'OnTheLine');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.journey.legIndex), station.legIndex);
});

test('the credits dialog discloses how AI was used', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.locator('#menu-story').getByText('Credits', { exact: true }).click();
  const dialog = page.locator('#ui-dialog');
  // The dialog fades in, so wait for the link to lay out before reading any text out of it.
  const link = dialog.locator('a[href="https://likea.moe/ashlinegame/about/#ai-generation-disclosure"]');
  await link.waitFor({ state: 'visible' });
  const shown = await dialog.innerText();
  assert.match(shown, /AI Generated Content Disclosure:/);
  assert.match(shown, /AI was used to make code and \.svg art for this game\./);
  assert.match(shown, /Diffusion \(what people commonly refer to as AI Image Generation\) was not used for this game\./);
  // The link reads as words, with the address behind it rather than printed in the sentence.
  assert.equal(await link.count(), 1);
  assert.equal(await link.innerText(), "Ashline's Page on my Website");
  assert.doesNotMatch(shown, /https:\/\//);
  // The credits that were there before are untouched.
  assert.match(shown, /Created by: likea/);
  assert.match(shown, /Official Website/);
	assert.match(shown, /OpenStreetMap contributors/);
	assert.match(shown, /Geofabrik/);
	assert.match(shown, /ODbL 1\.0/);
	assert.match(shown, /World data: City names/);
	assert.match(shown, /Elevation data: Produced using Copernicus/);
	assert.doesNotMatch(shown, /<\/?(?:strong|p)>/);
  assert.doesNotMatch(shown, /Discord/);
});

test('the yard view zooms, and fitting never blows a small yard up', async t => {
  const page = await openGame(t);
  await begin(page);
  const zoom = page.locator('.railyard-view-zoom');
  const svg = page.locator('svg.railyard-view');
  const readout = zoom.locator('span');
  // The view opens fitted so the whole yard is visible without hunting for its far end.
  assert.equal(await readout.innerText(), 'Fit');
  const natural = await svg.evaluate(element => Number(element.getAttribute('width')));
  const initialWidth = await page.locator('.railyard-view-scroll').evaluate(box =>
    box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight));
  assert.ok(Math.abs((await svg.boundingBox()).width - initialWidth) <= 2, 'the opening yard should fit its frame');

  await zoom.getByRole('button', { name: '+' }).click();
  assert.equal(await readout.innerText(), '100%');
  const zoomed = (await svg.boundingBox()).width;
  assert.ok(Math.abs(zoomed - natural) <= 2, `${zoomed} should be the drawing's natural width`);

  // Fit fills the width of the window, whether that means shrinking the yard or enlarging it.
  await zoom.getByRole('button', { name: 'Fit' }).click();
  assert.equal(await readout.innerText(), 'Fit');
  const windowWidth = await page.locator('.railyard-view-scroll').evaluate(box =>
    box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight));
  const fitted = (await svg.boundingBox()).width;
  assert.ok(Math.abs(fitted - windowWidth) <= 2, `fitted ${fitted} should fill the ${windowWidth} wide window`);

  // Zoomed in and scrolled, the controls stay in the corner of the view instead of sliding away with the yard.
  await zoom.getByRole('button', { name: '+' }).click();
  await zoom.getByRole('button', { name: '+' }).click();
  const parked = await zoom.boundingBox();
  await page.locator('.railyard-view-scroll').evaluate(box => { box.scrollLeft = 220; box.scrollTop = 40; });
  const scrolled = await zoom.boundingBox();
  assert.deepEqual({ x: Math.round(scrolled.x), y: Math.round(scrolled.y) },
    { x: Math.round(parked.x), y: Math.round(parked.y) });
});

test('clicking the yard drawing runs the same shunting actions as the text links', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    const lengths = SugarCube.setup.railyard.getYardTrackLengths(3, 1, 3, 200);
    const loco = copy('dieselShunter');
    loco.cargo = [{ type: 'diesel', amount: 400 }];
    v.stationTracks[1] = [lead(),
      { length: lengths[0], trains: [[loco]] },
      { length: lengths[1], trains: [[copy('boxcar')]] },
      { length: lengths[2], trains: [] },
      lead()];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');

  // Clicking a track runs its move, with the same cost the text link would have charged. The way out to the
  // southbound lead is clear; the parked train on track 2 blocks the other direction, as the text list says.
  const before = await page.evaluate(() => SugarCube.State.variables.gameTimeTimestampMs);
  await page.locator('svg.railyard-view [data-yard-target="track:0"]').click();
  await passage(page, 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 0);
  assert.ok(await page.evaluate(() => SugarCube.State.variables.gameTimeTimestampMs) > before, 'the move costs time');

  await page.locator('svg.railyard-view [data-yard-target="track:3"]').click();
  await passage(page, 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 3);

  // Clicking the track you are already on explains itself instead of doing anything.
  await page.locator('svg.railyard-view [data-yard-target="track:3"]').click();
  assert.match(await page.locator('.railyard-view-message').innerText(), /already on this track/);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 3);

  // Clicking a parked train couples it, exactly as its text link does.
  assert.equal(await page.locator('#passages [data-yard-action="couple-rear:2:0"] a').count(), 1,
    'the text list should offer rear coupling for that train');
  await page.locator('svg.railyard-view [data-yard-target="train:2:0"]').click();
  // Both ends can now be reached via legal headshunt routes: select the rear coupling explicitly.
  await page.locator('.railyard-view-choice').filter({ hasText: /^Couple to the rear/ }).click();
  await passage(page, 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => ({
    cars: SugarCube.State.variables.currentTrain.map(car => car.type),
    parked: SugarCube.State.variables.stationTracks[1][2].trains.length
  })), { cars: ['diesel loco', 'boxcar'], parked: 0 });
});

test('a section that will not fit says so instead of scattering the cars', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    const loco = copy('dieselShunter');
    loco.cargo = [{ type: 'diesel', amount: 400 }];
    // A short track that already holds a parked train, so the rear section has nowhere to go.
    v.stationTracks[1] = [lead(),
      { length: 30, trains: [[copy('boxcar')], [loco, copy('boxcar'), copy('tanker')]] },
      lead()];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await choose(page, 'Board Train 2 (0:01)', 'TrainInterior');
  await choose(page, 'Start driving', 'DrivingMode');
  const shown = await page.locator('#passages').innerText();
  assert.doesNotMatch(shown, /Decouple the rear section \(2 cars\) \(/);
  assert.equal(await page.locator('#passages a').filter({ hasText: 'Decouple the rear section' }).count(), 0,
    'the refused move offers no link, only the reason');
  assert.deepEqual(await page.evaluate(() => ({
    consist: SugarCube.State.variables.currentTrain.map(car => car.type),
    onLead: SugarCube.State.variables.stationTracks[1][0].trains.length
  })), { consist: ['diesel loco', 'boxcar', 'tanker car'], onLead: 0 });
});

test('clicking a parked train offers coupling it or pulling up to it', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const loco = copy('dieselShunter');
    loco.cargo = [{ type: 'diesel', amount: 400 }];
    // The consist waits on the southbound lead, with one parked train on the yard track beyond it.
    v.stationTracks[1] = [
      { length: 999999, infinite: true, trains: [[loco]] },
      { length: 200, trains: [[copy('boxcar')]] },
      { length: 999999, infinite: true, trains: [] }
    ];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');

  // Both moves are possible here, so the click asks which one rather than picking for the player.
  await page.locator('svg.railyard-view [data-yard-target="train:1:0"]').click();
  const choices = page.locator('.railyard-view-choice');
  const labels = await choices.allTextContents();
  assert.equal(labels.length, 3, `two moves and a way out, got: ${labels.join(' | ')}`);
  assert.ok(labels.includes('Cancel'), labels.join(' | '));
  assert.ok(labels.some(text => /^Couple to the front/.test(text)), labels.join(' | '));
  assert.ok(labels.some(text => /^Drive consist into Yard Track 1/.test(text)), labels.join(' | '));
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 0, 'nothing happens yet');

  // Pulling up to it moves the consist onto the track and leaves the train where it stands.
  await choices.filter({ hasText: 'Drive consist into Yard Track 1' }).click();
  await passage(page, 'DrivingMode');
  assert.deepEqual(await page.evaluate(() => ({
    track: SugarCube.State.variables.drivingTrackIndex,
    consist: SugarCube.State.variables.currentTrain.map(car => car.type),
    parked: SugarCube.State.variables.stationTracks[1][1].trains.flat().map(car => car.type)
  })), { track: 1, consist: ['diesel loco'], parked: ['boxcar'] });
});

// Reads what the yard drawing is currently saying: its labels, its track numbers, and the compass.
async function readYard(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#passages svg.railyard-view');
    const labels = [...view.querySelectorAll('text')].map(text => text.textContent);
    const onward = document.querySelector('.railyard-compass .railyard-compass-label.railyard-compass-onward');
    return {
      labels,
      badges: labels.filter(text => /^\d\d /.test(text)).map(text => text.slice(0, 2)),
      compass: onward ? onward.textContent : null
    };
  });
}

test('the yard is drawn from the end the player arrived at, and the compass turns with it', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = extra => Object.assign({ length: 999999, infinite: true, trains: [] }, extra);
    const loco = copy('dieselShunter');
    loco.cargo = [{ type: 'diesel', amount: 400 }];
    const lengths = SugarCube.setup.railyard.getYardTrackLengths(3, 1, 3, 200);
    v.stationTracks[1] = [lead({ direction: 'southwest', trains: [[loco]] }),
      { length: lengths[0], trains: [] }, { length: lengths[1], trains: [] }, { length: lengths[2], trains: [] },
      lead({ direction: 'northeast' })];
    v.travellingForward = true;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');

  // Running northeast: the southwest lead is the one behind, at the top left, and northeast lies to the bottom right.
  const forward = await readYard(page);
  assert.equal(forward.labels[0], 'SOUTH-WESTBOUND TRACK');
  assert.equal(forward.labels[forward.labels.length - 1], 'NORTH-EASTBOUND TRACK');
  assert.equal(forward.compass, 'NE');
  assert.deepEqual(forward.badges, ['01', '02', '03']);

  // Coming back the other way turns the whole yard round: the lead just arrived on is at the top left again.
  await page.evaluate(() => {
    SugarCube.State.variables.travellingForward = false;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const backward = await readYard(page);
  assert.equal(backward.labels[0], 'NORTH-EASTBOUND TRACK');
  assert.equal(backward.labels[backward.labels.length - 1], 'SOUTH-WESTBOUND TRACK');
  assert.equal(backward.compass, 'SW');
  assert.deepEqual(backward.badges, ['03', '02', '01'], 'the rows mirror, and keep their own numbers');
});

test('cars keep the direction they face, whichever way the yard is drawn', async t => {
  const page = await openGame(t);
  await begin(page);
  const drawnLocos = () => page.evaluate(() =>
    [...document.querySelectorAll('#passages svg.railyard-view use')]
      .map(use => use.dataset.template).filter(name => /^railyard-loco-/.test(name)));
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    const facingOn = copy('dieselShunter');
    facingOn.facing = 1;
    const facingBack = copy('steamShunter');
    facingBack.facing = -1;
    // A locomotive at the rear of a train no longer flips just because of where it stands in the consist.
    v.stationTracks[1] = [lead(),
      { length: 200, trains: [[copy('boxcar'), facingOn]] },
      { length: 200, trains: [[facingBack, copy('boxcar')]] },
      lead()];
    v.travellingForward = true;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const forward = await drawnLocos();
  assert.ok(forward.includes('railyard-loco-diesel-shunter-right'), forward.join(' | '));
  assert.ok(forward.includes('railyard-loco-steam-shunter-left'), forward.join(' | '));

  // Seen from the other end of the yard, both face the other way on screen without having turned round.
  await page.evaluate(() => {
    SugarCube.State.variables.travellingForward = false;
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const backward = await drawnLocos();
  assert.ok(backward.includes('railyard-loco-diesel-shunter-left'), backward.join(' | '));
  assert.ok(backward.includes('railyard-loco-steam-shunter-right'), backward.join(' | '));
});

test('clicking the far end of a lead leaves the station', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  // The way out is a small target at the very end of the lead; the track itself is the easy one to hit.
  const departBox = await page.locator('svg.railyard-view [data-yard-target="depart:exit"]').boundingBox();
  const trackBox = await page.locator('svg.railyard-view [data-yard-target="track:2"]').boundingBox();
  assert.ok(trackBox.width > departBox.width * 1.5,
    `the track band (${Math.round(trackBox.width)}) should be the bigger target, not the way out (${Math.round(departBox.width)})`);

  await page.locator('svg.railyard-view [data-yard-target="depart:exit"]').click();
  await passage(page, 'OnTheLine');
  assert.deepEqual(await page.evaluate(() => {
    const journey = SugarCube.State.variables.journey;
    return { leg: journey.legIndex, forward: journey.forward, tile: journey.tileIndex };
  }), { leg: 1, forward: true, tile: 0 });
});

test('clicking a train on the station map boards it', async t => {
  const page = await openGame(t);
  await begin(page);
  await page.evaluate(() => {
    const v = SugarCube.State.variables;
    const copy = key => JSON.parse(JSON.stringify(v.defaultTrains[key]));
    const lead = () => ({ length: 999999, infinite: true, trains: [] });
    const loco = copy('dieselShunter');
    loco.cargo = [{ type: 'diesel', amount: 400 }];
    v.stationTracks[1] = [lead(),
      { length: 200, trains: [[copy('boxcar')]] },
      { length: 200, trains: [[loco, copy('tanker')]] },
      lead()];
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');

  // With no consist to move, the tracks are not targets: only the trains are, and clicking one boards it.
  assert.equal(await page.locator('svg.railyard-view [data-yard-target^="track:"]').count(), 0);
  await page.locator('svg.railyard-view [data-yard-target="train:2:0"]').click();
  await passage(page, 'TrainInterior');
  assert.deepEqual(await page.evaluate(() => ({
    consist: SugarCube.State.variables.currentTrain.map(car => car.type),
    leftOnTrack: SugarCube.State.variables.stationTracks[1][2].trains.length,
    boardedFrom: SugarCube.State.variables.enteredTrackIndex
  })), { consist: ['diesel loco', 'tanker car'], leftOnTrack: 0, boardedFrom: 2 });
});

test('a locomotive facing the other way is drawn with the mirrored texture', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  await page.locator('svg.railyard-view [data-yard-target="depart:exit"]').click();
  await passage(page, 'OnTheLine');
  const drawnLocos = () => page.evaluate(() =>
    [...document.querySelectorAll('#passages svg.driving-view use')]
      .map(use => use.dataset.template).filter(name => /loco/.test(name)));
  assert.deepEqual(await drawnLocos(), ['driving-loco-diesel-shunter-right']);

  // The same locomotive, pointing the other way, gets the mirrored texture.
  await page.evaluate(() => {
    SugarCube.State.variables.currentTrain[0].facing = -1;
    SugarCube.Engine.play('OnTheLine');
  });
  await passage(page, 'OnTheLine');
  assert.deepEqual(await drawnLocos(), ['driving-loco-diesel-shunter-left']);

  // Running the leg the other way mirrors it back: the locomotive has not turned round, the train has.
  await page.evaluate(() => {
    SugarCube.State.variables.journey.forward = false;
    SugarCube.Engine.play('OnTheLine');
  });
  await passage(page, 'OnTheLine');
  assert.deepEqual(await drawnLocos(), ['driving-loco-diesel-shunter-right']);
});

test('backing into the station you left turns neither the yard nor the train round', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await page.evaluate(() => { SugarCube.State.variables.currentStation = 2; });
  await choose(page, 'Start driving', 'DrivingMode');
  const yardView = () => page.evaluate(() => ({
    forward: SugarCube.State.variables.travellingForward !== false,
    loco: [...document.querySelectorAll('#passages svg.railyard-view use')]
      .map(use => use.dataset.template).find(name => /loco/.test(name)),
    topLeft: document.querySelector('#passages svg.railyard-view text').textContent
  }));
  const before = await yardView();

  // Out onto the line, one tile along, then straight back into the yard it left.
  await page.locator('#passages').getByText(await departTo(page, 2)).first().click();
  await passage(page, 'OnTheLine');
  await page.locator('#passages').getByText(/^Drive [\d.]+ km [a-z-]+ \(/).first().click();
  await passage(page, 'OnTheLine');
  await page.locator('#passages').getByText(/^Reverse [\d.]+ km [a-z-]+ \(/).first().click();
  await passage(page, 'OnTheLine');
  await choose(page, 'Enter ' + await stationName(page, 2) + ' railyard', 'DrivingMode');

  // Still facing the same way, with the same yard orientation and the locomotive not turned round.
  const after = await yardView();
  assert.equal(await page.evaluate(() => SugarCube.State.variables.currentStation), 2);
  assert.equal(after.forward, before.forward);
  assert.equal(after.loco, before.loco);
  assert.equal(after.topLeft, before.topLeft, 'the far lead has not swapped into the top left corner');
});

test('hovering the yard says what a click would do', async t => {
  const page = await openGame(t);
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.setup.railyardView.hasHover()), true);
  const message = page.locator('.railyard-view-message');

  await page.locator('svg.railyard-view [data-yard-target="track:2"]').hover();
  assert.match(await message.innerText(), /Drive consist to Northbound Track/);

  // Hovering somewhere nothing can happen explains that instead.
  await page.locator('svg.railyard-view [data-yard-target="track:1"]').hover();
  assert.match(await message.innerText(), /already on this track/);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 1, 'hovering changes nothing');
});

test('without a hover, a tap offers the move and a second tap takes it', async t => {
  const page = await openGame(t, { hasTouch: true, isMobile: true });
  await begin(page);
  await board(page);
  await choose(page, 'Start driving', 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.setup.railyardView.hasHover()), false,
    'a touch screen reports no hover');

  // The first tap offers the move rather than taking it.
  await page.locator('svg.railyard-view [data-yard-target="track:2"]').click();
  assert.match(await page.locator('.railyard-view-message').innerText(), /Confirm/);
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 1, 'nothing has happened yet');

  // The second takes it.
  await page.locator('.railyard-view-choice').first().click();
  await passage(page, 'DrivingMode');
  assert.equal(await page.evaluate(() => SugarCube.State.variables.drivingTrackIndex), 2);
});

test('the sidebar shows the player condition, and the screen explains what drives it', async t => {
  const page = await openGame(t);
  await begin(page);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#story-caption .stat-row')].map(row => ({
    stat: row.dataset.stat,
    label: row.querySelector('.stat-label').textContent,
    band: row.querySelector('.stat-band').textContent,
    width: row.querySelector('.stat-fill').style.width,
    severity: row.querySelector('.stat-fill').className.replace('stat-fill stat-', '')
  })));
  assert.deepEqual(rows.map(row => row.stat),
    ['fatigue', 'health', 'immunity', 'sanity', 'hunger', 'thirst']);
  // A fresh player: fatigue empty, every reserve full, and all of them reading as fine.
  assert.deepEqual(rows.map(row => row.label), ['Fatigue', 'Health', 'Immunity', 'Sanity', 'Hunger', 'Thirst']);
  assert.deepEqual(rows.map(row => row.band), ['Rested', 'Unhurt', 'Strong', 'Sound', 'Fed', 'Watered']);
  assert.deepEqual(rows.map(row => row.width), ['0%', '100%', '100%', '100%', '100%', '100%']);
  assert.deepEqual([...new Set(rows.map(row => row.severity))], ['fine']);

  // Turning a stat bad colours it and renames it, without touching the others.
  await page.evaluate(() => {
    SugarCube.setup.stats.setValue('thirst', 25);
    SugarCube.setup.stats.setValue('sanity', 30);
    SugarCube.Engine.play('Railyard');
  });
  await passage(page, 'Railyard');
  const changed = await page.evaluate(() => {
    const read = key => {
      const row = document.querySelector(`#story-caption .stat-row[data-stat="${key}"]`);
      return { band: row.querySelector('.stat-band').textContent, fill: row.querySelector('.stat-fill').className };
    };
    return { thirst: read('thirst'), mind: read('sanity'), fatigue: read('fatigue') };
  });
  assert.equal(changed.thirst.band, 'Parched');
  assert.match(changed.thirst.fill, /stat-severe/);
  assert.equal(changed.mind.band, 'Haunted');
  assert.match(changed.mind.fill, /stat-severe/);
  assert.equal(changed.fatigue.band, 'Rested');

  // The Condition screen lists every stat with what drives it.
  await page.locator('#menu-story').getByText('Condition', { exact: true }).click();
  const dialog = page.locator('#ui-dialog');
  await dialog.locator('.condition-stat').first().waitFor({ state: 'visible' });
  const shown = await dialog.innerText();
  assert.match(shown, /Thirst: Parched \(25\/100\)/);
  assert.match(shown, /Sanity: Haunted \(30\/100\)/);
  assert.match(shown, /Make sure to carry plenty of water/);
  assert.match(shown, /even a minor accident can be fatal/);
  // Plans and progress notes belong in the development notes, never in front of a player.
  assert.doesNotMatch(shown, /not built|not implemented|coming soon|yet\b/i);
});

test('inventory is available after the game begins, but gameplay submenus stay off the start screen', async t => {
  const page = await openGame(t);
  assert.equal(await page.locator('#menu-story').getByText('Condition', { exact: true }).count(), 0);
  assert.equal(await page.locator('#menu-story').getByText('Inventory', { exact: true }).count(), 0);

  await begin(page);
  await page.locator('#menu-story').getByText('Inventory', { exact: true }).click();
  const dialog = page.locator('#ui-dialog');
  await dialog.getByText('Inventory', { exact: true }).waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /On you/);
  assert.match(await dialog.innerText(), /Board a train to inspect/);
  await page.evaluate(() => SugarCube.Dialog.close());
  await board(page);
  await page.locator('#menu-story').getByText('Inventory', { exact: true }).click();
  await dialog.getByText('Inventory', { exact: true }).waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /Your train/);
  assert.match(await dialog.innerText(), /Pack \(4 × 4\)/);
  assert.match(await dialog.innerText(), /0\/16 pack squares, 0 kg\/50 kg carried/);
  assert.match(await dialog.innerText(), /Toolkit/);
});

test('the condition bars carry a marker where trouble starts, and can show their numbers', async t => {
  const page = await openGame(t);
  await begin(page);
  const pins = await page.evaluate(() => ({
    fatigue: document.querySelector('#story-caption .stat-row[data-stat="fatigue"] .stat-pin').style.left,
    immunity: document.querySelector('#story-caption .stat-row[data-stat="immunity"] .stat-pin').style.left,
    numbersShown: getComputedStyle(document.querySelector('#story-caption .stat-value')).display
  }));
  // A burden turns severe four fifths up; a reserve one fifth down.
  assert.equal(pins.fatigue, '60%');
  assert.equal(pins.immunity, '40%');
  assert.equal(pins.numbersShown, 'none', 'the words carry the meaning until the numbers are asked for');

  // Tapping the panel shows the numbers behind the words.
  await page.locator('#story-caption .stats-panel').click();
  const expanded = await page.evaluate(() => ({
    display: getComputedStyle(document.querySelector('#story-caption .stat-value')).display,
    text: document.querySelector('#story-caption .stat-row[data-stat="immunity"] .stat-value').textContent
  }));
  assert.notEqual(expanded.display, 'none');
  assert.equal(expanded.text, '100/100');
});
