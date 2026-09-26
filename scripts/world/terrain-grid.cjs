// The terrain router's elevation cells for a whole scope, resampled once from the elevation tiles, so that planning a
// new line reads the cells under it from a file rather than resampling tiles for every line (terrain-path.cjs,
// sampleBox): a second or two a line becomes a few milliseconds. The cells are the router's own, CELL_DEGREES across
// and aligned to whole multiples of it, mean and root-mean-square as sampleBox makes them.
//
// A line whose box reaches past the grid, or over a tile the grid was made without (fetched since), is resampled on
// its own as before, so the grid only ever speeds a build up. Rebuild it after fetching more tiles for the scope.
//
// Usage: npm run world:terrain-grid:afro-eurasia (the scope's terrainExtent, in its frame; see scopes.cjs)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultCache, tilesInFrame } = require('./dem.cjs');
const { PARAMETERS } = require('./terrain-path.cjs');

const NODATA = -32768;

// The grid's files in the cache: meta (the extent, size and tiles it was made from), and the two rasters.
function gridFiles(cache, prefix) {
  const base = path.join(cache, 'terrain-grid-' + prefix + '-' + PARAMETERS.cellDegrees);
  return { meta: base + '.json', average: base + '-average.f32', rms: base + '-rms.f32' };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status);
  return result.stdout;
}

// The south-west corner of a tile from its name, as [longitude, latitude].
function cornerOf(name) {
  const match = name.match(/_([NS])(\d{2})_00_([EW])(\d{3})_00_DEM/);
  return [(match[3] === 'W' ? -1 : 1) * Number(match[4]), (match[1] === 'S' ? -1 : 1) * Number(match[2])];
}

function main() {
  const AREA = require('./scopes.cjs').scopeFromArguments();
  const extent = AREA.terrainExtent;
  if (!extent) throw new Error('Scope ' + AREA.name + ' has no terrainExtent in scopes.cjs');
  const cache = defaultCache(), cell = PARAMETERS.cellDegrees, files = gridFiles(cache, AREA.prefix);
  // Every tile in the cache under the extent, taken round the 180th meridian into its frame where need be.
  const inFrame = longitude => ((longitude - (extent[0] - 1)) % 360 + 360) % 360 + (extent[0] - 1);
  const names = fs.readdirSync(cache).filter(file => /^Copernicus_.*_DEM\.tif$/.test(file)).map(file => file.slice(0, -4))
    .filter(name => {
      const [west, south] = cornerOf(name), east = inFrame(west);
      return east + 1 > extent[0] && east < extent[2] && south + 1 > extent[1] && south < extent[3];
    }).sort();
  console.error(names.length + ' elevation tiles under ' + extent.join(', '));
  const width = Math.round((extent[2] - extent[0]) / cell), height = Math.round((extent[3] - extent[1]) / cell);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-terrain-grid-'));
  try {
    const tiles = tilesInFrame(names.map(name => path.join(cache, name + '.tif')), extent, temporary);
    const list = path.join(temporary, 'tiles.txt');
    fs.writeFileSync(list, tiles.join('\n') + '\n');
    const vrt = path.join(temporary, 'dem.vrt');
    run('gdalbuildvrt', ['-q', '-vrtnodata', String(NODATA), '-input_file_list', list, vrt]);
    ['average', 'rms'].forEach(method => {
      console.error('resampling ' + width + ' by ' + height + ' cells (' + method + ')');
      const output = path.join(temporary, method + '.bin');
      run('gdalwarp', ['-q', '-overwrite', '-multi', '-wo', 'NUM_THREADS=ALL_CPUS', '-wm', '2048', '-te', ...extent.map(String),
        '-ts', String(width), String(height), '-r', method, '-srcnodata', String(NODATA), '-dstnodata', String(NODATA),
        '-ot', 'Float32', '-of', 'ENVI', vrt, output]);
      fs.copyFileSync(output, files[method] + '.part');
      fs.renameSync(files[method] + '.part', files[method]);
    });
    fs.writeFileSync(files.meta, JSON.stringify({ extent, cellDegrees: cell, width, height, tiles: names, built: new Date().toISOString() }));
    console.log('Wrote the terrain grid of ' + AREA.label + ': ' + width + ' by ' + height + ' cells from ' + names.length + ' tiles');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { gridFiles };
