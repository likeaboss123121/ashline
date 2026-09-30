// Regenerate the v0.2.0 compatibility fixtures from the unmodified GitHub release HTML.
// Usage: ASHLINE_BROWSER=chromium node scripts/capture-v020-saves.cjs /path/to/ashlinegame.html
// (gh release download v0.2.0 --repo likeaboss123121/ashline --pattern ashlinegame.html)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const RELEASE_SHA256 = '1ed1b8ec23446d3ecbd34330390d3f5a02a970a0fcea6c841539c3c83436a474';

(async () => {
  const release = path.resolve(process.argv[2] || '');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(release)).digest('hex');
  if (digest !== RELEASE_SHA256) throw new Error('Expected the original v0.2.0 release asset, not a rebuilt or modified game.');
  const directory = path.resolve('tests/fixtures/v020');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(pathToFileURL(release).href);
    await page.waitForFunction(() => window.SugarCube && SugarCube.State.passage === 'Start');
    await page.evaluate(() => { SugarCube.State.variables.randomSeed = 'migration-v020'; });
    const idle = title => page.waitForFunction(title => SugarCube.State.passage === title && SugarCube.Engine.isIdle(), title);
    async function capture(name, title) {
      await idle(title);
      const fixture = await page.evaluate(() => {
        const { Save, State, setup } = SugarCube;
        Save.slots.save(0);
        return {
          release: setup.releaseVersion,
          save: Save.slots.get(0),
          exported: Save.serialize(),
          session: SugarCube.session.get('state'),
          live: JSON.parse(JSON.stringify(State.variables)),
          passage: State.passage
        };
      });
      fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(fixture) + '\n');
      console.log('Captured ' + name);
    }
    const click = async (text, title) => {
      await page.locator('#passages a').filter({ hasText: text }).first().click();
      if (title) await idle(title);
    };
    await page.getByText('Continue', { exact: true }).click();
    await click(/^Begin your journey$/, 'Railyard');
    await capture('yard-first-entry', 'Railyard');
    // The tutorial's puzzle stands between the first yard and the line; like the release's own tests, clear it.
    await page.evaluate(() => {
      const v = SugarCube.State.variables, tracks = v.stationTracks[1], exit = tracks[tracks.length - 1];
      exit.trains = [];
      v.stationTracks[1] = [tracks[0], { length: 120, trains: [tracks[1].trains[0]] }, exit];
      v.tutorialDone = true;
      SugarCube.Engine.play('Railyard');
    });
    await click(/^Board Train 1/, 'TrainInterior');
    await capture('interior', 'TrainInterior');
    await click(/^Start driving$/, 'DrivingMode');
    await capture('driving', 'DrivingMode');
    await click(/^Depart \S+ toward Station/, 'OnTheLine');
    await click(/^Drive 5 km/, 'OnTheLine');
    await click(/^Drive 5 km/, 'OnTheLine');
    await capture('line', 'OnTheLine');
    await click(/^Enter the train$/, 'TrainInterior');
    await click(/^Climb down from the train/, 'OnFoot');
    await capture('on-foot', 'OnFoot');
    await click(/^Walk 5 km/, 'OnFoot');
    await capture('on-foot-away', 'OnFoot');
    await page.evaluate(() => { SugarCube.setup.onfoot.walk(-1); SugarCube.Engine.play('OnFoot'); });
    await click(/^Climb back aboard/, 'OnTheLine');
    for (let guard = 0; guard < 40 && await page.evaluate(() => !!SugarCube.State.variables.journey); guard++) {
      const turn = await page.evaluate(() => SugarCube.State.turns);
      await page.locator('#passages a').filter({ hasText: /^Drive 5 km/ }).first().click();
      await page.waitForFunction(previous => SugarCube.State.turns > previous && SugarCube.Engine.isIdle(), turn);
    }
    await capture('arrival', 'DrivingMode');
    await click(/^Stop driving$/, 'TrainInterior');
    await click(/^Leave the train/, 'Railyard');
    await capture('yard-left-train', 'Railyard');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
