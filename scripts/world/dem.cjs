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

// Copernicus names each 1-degree tile by its south-west corner.
function copernicusTileName(longitude, latitude) {
  const south = Math.floor(latitude), west = Math.floor(longitude);
  return 'Copernicus_DSM_COG_30_' + (south < 0 ? 'S' : 'N') + String(Math.abs(south)).padStart(2, '0') + '_00_' +
    (west < 0 ? 'W' : 'E') + String(Math.abs(west)).padStart(3, '0') + '_00_DEM';
}

// The tiles under squares of squareKm centred on each coordinate.
function tilesFor(coordinates, squareKm = 5) {
  const names = new Set();
  coordinates.forEach(coordinate => {
    const halfLatitude = (squareKm / 2) / 111.32;
    const halfLongitude = (squareKm / 2) / (111.32 * Math.cos(coordinate[1] * Math.PI / 180));
    [-1, 1].forEach(dx => [-1, 1].forEach(dy => {
      names.add(copernicusTileName(coordinate[0] + dx * halfLongitude, coordinate[1] + dy * halfLatitude));
    }));
  });
  return Array.from(names).sort();
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
// upstream; they are remembered as missing so they are not asked for again.
function fetchTiles(names, cache = defaultCache()) {
  fs.mkdirSync(cache, { recursive: true });
  const files = [];
  names.forEach((name, index) => {
    const file = path.join(cache, name + '.tif');
    const missing = file + '.missing';
    if (!fs.existsSync(file) && !fs.existsSync(missing)) {
      if (process.env.ASHLINE_WORLD_QUIET !== '1') console.error('Fetching ' + name + ' (' + (index + 1) + '/' + names.length + ')');
      const result = spawnSync('curl', ['-sS', '-f', '-o', file + '.part', COPERNICUS_URL + name + '/' + name + '.tif'],
        { encoding: 'utf8' });
      if (result.status === 0) fs.renameSync(file + '.part', file);
      else if (/\b(403|404)\b/.test(result.stderr)) { fs.rmSync(file + '.part', { force: true }); fs.writeFileSync(missing, ''); }
      else throw new Error('Could not fetch ' + name + ': ' + result.stderr);
    }
    if (fs.existsSync(file)) files.push(file);
  });
  return files;
}

module.exports = { COPERNICUS_URL, defaultCache, copernicusTileName, tilesFor, tilesForBox, fetchTiles };
