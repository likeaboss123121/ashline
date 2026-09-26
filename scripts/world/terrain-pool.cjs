// Plans many new lines over the terrain at once, one worker thread per core: the network builder's pre-pass before it
// lays a batch of lines (build-network.cjs, prefetchRoutes). Each line is planned exactly as the builder would plan it
// (terrain-path.cjs); the builder then finds them all in its route memo and lays them in its own order, one at a time.
//
// Usage (by the builder): node terrain-pool.cjs <tasks.json> <results.ndjson>
// tasks.json is { settlements: <file of the places>, centre: <grid centre>, cache, tasks: [[key, start, end], ...] };
// results.ndjson gets one [key, route or null] per line, as each is found.
const fs = require('node:fs');
const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  const [tasksFile, resultsFile] = process.argv.slice(2);
  const job = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const threads = Math.max(1, Math.min(job.tasks.length, Number(process.env.ASHLINE_WORLD_THREADS) || os.cpus().length - 1));
  const out = fs.openSync(resultsFile, 'w');
  let next = 0, done = 0, failed = null;
  const started = Date.now();
  for (let thread = 0; thread < threads; thread++) {
    const worker = new Worker(__filename, { workerData: { settlements: job.settlements, centre: job.centre, cache: job.cache } });
    const give = () => { if (next < job.tasks.length) worker.postMessage(job.tasks[next++]); else worker.postMessage(null); };
    worker.on('message', message => {
      if (message === 'ready') { give(); return; }
      fs.writeSync(out, JSON.stringify(message) + '\n');
      if (++done % 200 === 0) console.error('terrain pool: ' + done + ' of ' + job.tasks.length + ' lines planned in ' + Math.round((Date.now() - started) / 1000) + ' s');
      give();
    });
    worker.on('error', error => { failed = failed || error; });
    worker.on('exit', code => { if (code !== 0) failed = failed || new Error('terrain worker exited with ' + code); });
  }
  process.on('exit', () => {
    fs.closeSync(out);
    if (failed) { console.error(failed.stack || failed.message); process.exitCode = 1; }
  });
} else {
  const { readRecords } = require('./records.cjs');
  const projection = require('./projection.cjs');
  const terrain = require('./terrain-path.cjs');
  // The same settlements as the builder's, in the same frame (build-network.cjs, main).
  const grid = { ...projection.GRID, centre: workerData.centre };
  const settlements = readRecords(workerData.settlements).places;
  settlements.forEach(place => { place.coordinates[0] = projection.inFrame(place.coordinates[0], grid); });
  parentPort.on('message', task => {
    if (!task) { process.exit(0); return; }
    const [key, start, end] = task;
    const route = terrain.terrainPath(start, end, settlements, workerData.cache);
    parentPort.postMessage([key, route ? { coordinates: route.coordinates, km: route.km, straightKm: route.straightKm,
      waterKm: route.waterKm, via: route.via } : null]);
  });
  parentPort.postMessage('ready');
}
