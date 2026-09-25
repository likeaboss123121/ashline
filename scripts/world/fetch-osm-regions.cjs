// Fetches OpenStreetMap extracts region by region and keeps only what the world pipeline reads: railway ways,
// railway stations and halts, and named places down to farms. Each download is filtered and deleted before the
// next, so a continent never has to fit on disk at once; the filtered regions are then merged into one file for the
// extractors (extract-osm-rail, extract-osm-stations, extract-osm-places).
//
// Usage: node scripts/world/fetch-osm-regions.cjs --dir /path/to/sources --output americas-filtered.osm.pbf
//        [--local /path/to/existing.osm.pbf ...] <geofabrik path> ...
// e.g.   ... north-america/canada central-america --local /data/south-america-260921.osm.pbf
// A Geofabrik path is relative to https://download.geofabrik.de/, without -latest.osm.pbf. Already filtered
// regions are kept and not fetched again.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRACK = 'rail,narrow_gauge,light_rail';
const FILTER = [
  'w/railway=rail,narrow_gauge,light_rail,disused,abandoned,dismantled,razed,demolished,removed,preserved,construction,proposed,planned,historic',
  ...['disused', 'abandoned', 'dismantled', 'razed', 'demolished', 'removed', 'construction', 'proposed', 'planned', 'historic']
    .map(lifecycle => 'w/' + lifecycle + ':railway=' + TRACK),
  'nwr/railway=station,halt', 'nwr/disused:railway=station,halt', 'nwr/abandoned:railway=station,halt',
  'nwr/historic:railway=station,halt', 'nwr/historic=railway_station',
  'n/place=city,town,village,hamlet,isolated_dwelling,farm'
];

function run(command, args) {
  console.log('> ' + command + ' ' + args.join(' ').slice(0, 160));
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
}

function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf('--' + name); return index >= 0 ? args.splice(index, 2)[1] : null; };
  const dir = option('dir'), output = option('output') || 'filtered.osm.pbf';
  const locals = [];
  for (let local; (local = option('local'));) locals.push(local);
  if (!dir) throw new Error('Usage: fetch-osm-regions.cjs --dir <sources> [--output file] [--local file ...] <region> ...');
  fs.mkdirSync(dir, { recursive: true });
  const filtered = [];
  const filter = (input, name) => {
    const target = path.join(dir, name + '.filtered.osm.pbf');
    if (!fs.existsSync(target)) run('osmium', ['tags-filter', '--overwrite', '-o', target + '.part', '-f', 'pbf', input, ...FILTER]);
    if (fs.existsSync(target + '.part')) fs.renameSync(target + '.part', target);
    filtered.push(target);
  };
  locals.forEach(file => filter(file, path.basename(file).replace(/\.osm\.pbf$/, '')));
  args.forEach(region => {
    const name = region.replace(/\//g, '-');
    if (fs.existsSync(path.join(dir, name + '.filtered.osm.pbf'))) { filtered.push(path.join(dir, name + '.filtered.osm.pbf')); return; }
    const download = path.join(dir, name + '-latest.osm.pbf');
    run('curl', ['-sS', '-L', '--fail', '--retry', '3', '-o', download, 'https://download.geofabrik.de/' + region + '-latest.osm.pbf']);
    filter(download, name);
    fs.rmSync(download, { force: true });
  });
  run('osmium', ['merge', '--overwrite', '-o', path.join(dir, output), ...filtered]);
  console.log('Wrote ' + path.join(dir, output));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
