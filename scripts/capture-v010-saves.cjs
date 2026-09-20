// Regenerate compatibility fixtures using the unmodified GitHub release HTML.
// Usage: node scripts/capture-v010-saves.cjs /path/to/ashlinegame.html
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const release = path.resolve(process.argv[2] || '');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(release)).digest('hex');
  if (digest !== '970bdf371a9c8e6477bbcf23412ffdeb929458c0bdad01578ddd3217083a406c') {
    throw new Error('Expected the original MajorUpdate release asset, not a rebuilt or modified game.');
  }
  const directory = path.resolve('tests/fixtures/v010');
  fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.ASHLINE_BROWSER || 'chromium' });
  try {
    const page = await browser.newPage();
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(pathToFileURL(release).href);
    await page.waitForFunction(() => window.SugarCube && SugarCube.State.passage === 'Start');
    await page.evaluate(() => { SugarCube.State.variables.randomSeed = 'migration-v010'; });
    async function capture(name, title) {
      await page.waitForFunction(title => SugarCube.State.passage === title && SugarCube.Engine.isIdle(), title);
      const fixture = await page.evaluate(() => {
        const { Save, State, setup } = SugarCube;
        Save.slots.save(0);
        return {
          release: setup.releaseVersion,
          save: Save.slots.get(0),
          exported: Save.serialize(),
          session: SugarCube.session.get('state'),
          // Compare migrated stock against what the released game actually displayed.
          live: JSON.parse(JSON.stringify(State.variables)),
          passage: State.passage
        };
      });
      fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(fixture) + '\n');
      console.log('Captured ' + name);
    }
    await capture('start', 'Start');
    await page.getByText('Continue', { exact: true }).click();
    await capture('introduction', 'StoryInit');
    await page.getByText('Begin Your Journey', { exact: true }).click();
    await capture('yard-first-entry', 'Railyard');
    await page.getByText('Board Train 1', { exact: true }).click();
    await capture('interior', 'TrainInterior');
    await page.getByText('Start Driving', { exact: true }).click();
    await capture('driving', 'DrivingMode');
    await page.getByText('Travel to Next Station', { exact: true }).click();
    await page.waitForFunction(() => !!SugarCube.State.variables.stationTracks[2]);
    await capture('arrival', 'DrivingMode');
    await page.getByText('Stop Driving', { exact: true }).click();
    await page.getByText('Leave Train', { exact: true }).click();
    await capture('yard-pending-placement', 'Railyard');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
