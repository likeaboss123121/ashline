// Copernicus GLO-90 elevation tiles: which ones an area needs, and fetching them into a local cache.
//
// The tiles are raw inputs, like the OSM snapshots, and never ship: only the aggregates the build derives from them
// do. The cache lives outside the repository. Set ASHLINE_DEM_CACHE to keep it somewhere durable; the default is the
// system temporary directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const COPERNICUS_URL = 'https://copernicus-dem-90m.s3.amazonaws.com/';

function defaultCache() {
  return path.resolve(process.env.ASHLINE_DEM_CACHE || path.join(os.tmpdir(), 'ashline-copernicus'));
}

// Copernicus names each 1-degree tile by its south-west corner. A longitude beyond the 180th meridian, as a grid
// centred in Asia gives Chukotka (190 rather than -170), names the tile it wraps round to.
function copernicusTileName(longitude, latitude) {
  const south = Math.floor(latitude), west = Math.floor(((longitude + 180) % 360 + 360) % 360 - 180);
  return 'Copernicus_DSM_COG_30_' + (south < 0 ? 'S' : 'N') + String(Math.abs(south)).padStart(2, '0') + '_00_' +
    (west < 0 ? 'W' : 'E') + String(Math.abs(west)).padStart(3, '0') + '_00_DEM';
}

// The tiles under a box [west, south, east, north].
function tilesForBox(box) {
  const names = [];
  for (let longitude = Math.floor(box[0]); longitude <= Math.floor(box[2]); longitude++) {
    for (let latitude = Math.floor(box[1]); latitude <= Math.floor(box[3]); latitude++) {
      names.push(copernicusTileName(longitude + 0.5, latitude + 0.5));
    }
  }
  return names.sort();
}

// Downloads the tiles into the cache and returns the paths of those that exist. Tiles that are all sea do not exist
// upstream; they are remembered as missing so they are not asked for again. Eight downloads run at once, in batches,
// since a continent needs several hundred tiles.
function fetchTiles(names, cache = defaultCache()) {
  fs.mkdirSync(cache, { recursive: true });
  const wanted = names.filter(name => !fs.existsSync(path.join(cache, name + '.tif')) &&
    !fs.existsSync(path.join(cache, name + '.tif.missing')));
  for (let start = 0; start < wanted.length; start += 40) {
    const batch = wanted.slice(start, start + 40);
    if (process.env.ASHLINE_WORLD_QUIET !== '1') {
      console.error('Fetching elevation tiles ' + (start + 1) + '-' + (start + batch.length) + ' of ' + wanted.length);
    }
    const args = ['-sS', '-Z', '--parallel-max', '8', '--retry', '3', '-w', '%{http_code} %{filename_effective}\\n'];
    batch.forEach(name => args.push('-o', path.join(cache, name + '.tif.part'), COPERNICUS_URL + name + '/' + name + '.tif'));
    const result = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const codes = new Map(result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [code, file] = line.split(' ');
      return [file, code];
    }));
    batch.forEach(name => {
      const part = path.join(cache, name + '.tif.part'), code = codes.get(part);
      if (code === '200') fs.renameSync(part, path.join(cache, name + '.tif'));
      else if (code === '403' || code === '404') { fs.rmSync(part, { force: true }); fs.writeFileSync(path.join(cache, name + '.tif.missing'), ''); }
      else { fs.rmSync(part, { force: true }); throw new Error('Could not fetch ' + name + ' (HTTP ' + code + '): ' + result.stderr); }
    });
  }
  return names.map(name => path.join(cache, name + '.tif')).filter(file => fs.existsSync(file));
}

// Tiles to resample over a box in degrees whose longitudes run past the 180th meridian ([175, 60, 195, 68] across
// Chukotka): each tile the box takes from the far side of the meridian is given as a small VRT that moves it 360
// degrees, into the box's frame. Tiles already in the frame are returned as they are. dir is a temporary directory.
function tilesInFrame(files, box, dir) {
  return files.map(file => {
    const match = path.basename(file).match(/_([EW])(\d{3})_00_DEM/);
    if (!match) return file;
    const west = (match[1] === 'W' ? -1 : 1) * Number(match[2]);
    const shift = west + 1 <= box[0] ? 360 : west >= box[2] ? -360 : 0;
    if (!shift) return file;
    const info = JSON.parse(run('gdalinfo', ['-json', file]));
    const [originX, pixelWidth, , originY, , pixelHeight] = info.geoTransform;
    const [width, height] = info.size;
    const vrt = path.join(dir, path.basename(file, '.tif') + (shift > 0 ? '-east' : '-west') + '.vrt');
    run('gdal_translate', ['-q', '-of', 'VRT', '-a_ullr', String(originX + shift), String(originY),
      String(originX + shift + width * pixelWidth), String(originY + height * pixelHeight), file, vrt]);
    return vrt;
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status + ': ' + result.stderr);
  return result.stdout;
}

module.exports = { defaultCache, copernicusTileName, tilesForBox, fetchTiles, tilesInFrame };
