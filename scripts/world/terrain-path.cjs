// A proposed railway where none was ever mapped, laid over the land the way a surveyor would: along valleys and
// across plains, around lakes and ice fields, and through the towns on the way, rather than straight over whatever
// lies between two ends of track.
//
// The area around the gap is resampled from Copernicus GLO-90 into cells of about 2 km, keeping each cell's mean
// elevation and its roughness (the spread of heights inside it). The cheapest path across those cells is the line:
//
//   - every kilometre costs 1, and more on a grade: a climb of GRADE_SOFT percent costs twice as much as level
//     ground, and it rises with the square of the grade from there, so long gentle climbs beat short steep ones;
//   - rough ground costs extra, so a line keeps to valley floors rather than broken hillsides;
//   - ground high enough to carry snow for much of the year costs extra;
//   - water costs WATER_COST times as much: open sea, and lakes, which the elevation model draws as flat as glass;
//   - ground within TOWN_KM of a town, city or village costs TOWN_FACTOR as much.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { threadId } = require('node:worker_threads');
const { defaultCache, tilesForBox, fetchTiles, tilesInFrame } = require('./dem.cjs');

const CELL_DEGREES = 0.02;
const PADDING_SHARE = 0.3; // of the gap's length, added around it for the line to find a way through
const MIN_PADDING_KM = 40;
const GRADE_SOFT = 2;
const ROUGHNESS_M = 150; // within-cell spread that doubles the cost of a kilometre
const SNOW_LINE_M = 2500;
const WATER_COST = 30;
const LAKE_FLATNESS_M = 0.3; // a cell flatter than this, all the way across, is water
const TOWN_KM = 3;
const TOWN_FACTOR = 0.85; // on the ground right around a town, so the line runs into it rather than past it
// How much cheaper a hop is when it ends at a settlement, as a share of the hop. A share rather than a fixed bonus, so a
// string of villages close together is never cheaper than the ground between them: a settlement can pull the line a
// little way towards it but can never pay for a long detour. Villages count too: across inland Patagonia they are the
// only settlements for hundreds of kilometres.
const STOP_DISCOUNT = { city: 0.25, town: 0.15, village: 0.08 };
const MAX_HOP_KM = 250; // the furthest the line is planned between two stops
const SIMPLIFY_DEGREES = 0.004;
const NODATA = -32768;
const PARAMETERS = { cellDegrees: CELL_DEGREES, paddingShare: PADDING_SHARE, minPaddingKm: MIN_PADDING_KM,
  gradeSoft: GRADE_SOFT, roughnessM: ROUGHNESS_M, snowLineM: SNOW_LINE_M, waterCost: WATER_COST,
  lakeFlatnessM: LAKE_FLATNESS_M, townKm: TOWN_KM, townFactor: TOWN_FACTOR, stopDiscount: STOP_DISCOUNT,
  maxHopKm: MAX_HOP_KM, simplifyDegrees: SIMPLIFY_DEGREES };

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' exited with status ' + result.status + ': ' + result.stderr);
  return result.stdout;
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const h = Math.sin(radians(b[1] - a[1]) / 2) ** 2 +
    Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(radians(b[0] - a[0]) / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// A scope's terrain grids in the cache (terrain-grid.cjs), read once per process: the cells of a whole scope,
// resampled once, which a box inside one is read from rather than resampled on its own.
const grids = new Map();
function gridsIn(cache) {
  if (!grids.has(cache)) {
    const found = [];
    const suffix = '-' + CELL_DEGREES + '.json';
    (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter(file => file.startsWith('terrain-grid-') && file.endsWith(suffix)).forEach(file => {
      const meta = JSON.parse(fs.readFileSync(path.join(cache, file), 'utf8')), base = path.join(cache, file.slice(0, -5));
      if (fs.existsSync(base + '-average.f32') && fs.existsSync(base + '-rms.f32')) {
        found.push({ meta, tiles: new Set(meta.tiles), files: { average: base + '-average.f32', rms: base + '-rms.f32' } });
      }
    });
    grids.set(cache, found);
  }
  return grids.get(cache);
}

// Fills mean and rms for a box from a terrain grid that covers it and was made from every land tile under it (a tile
// fetched since would be missing from it); false when there is none, and the box is resampled on its own.
function readFromGrid(box, names, cache, width, height, mean, rms) {
  const grid = gridsIn(cache).find(candidate => {
    const [west, south, east, north] = candidate.meta.extent, slack = CELL_DEGREES / 100;
    return box[0] >= west - slack && box[1] >= south - slack && box[2] <= east + slack && box[3] <= north + slack
      && names.every(name => candidate.tiles.has(name) || fs.existsSync(path.join(cache, name + '.tif.missing')));
  });
  if (!grid) return false;
  const column = Math.round((box[0] - grid.meta.extent[0]) / CELL_DEGREES), row = Math.round((grid.meta.extent[3] - box[3]) / CELL_DEGREES);
  [['average', mean], ['rms', rms]].forEach(([method, target]) => {
    const descriptor = fs.openSync(grid.files[method], 'r');
    try {
      for (let line = 0; line < height; line++) {
        const into = Buffer.from(target.buffer, target.byteOffset + line * width * 4, width * 4);
        fs.readSync(descriptor, into, 0, width * 4, ((row + line) * grid.meta.width + column) * 4);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  });
  return true;
}

// The elevation model resampled over a box: mean and root-mean-square per cell, from which the spread follows.
// Resampling a few hundred tiles takes a second or more, so each result is kept beside the tiles, named for its box
// and cell size; the router asks for the same boxes every time it runs. Where a scope's terrain grid covers the box,
// its cells are read from that instead.
function sampleBox(box, cache = defaultCache()) {
  const names = tilesForBox(box);
  let files = fetchTiles(names, cache);
  const width = Math.round((box[2] - box[0]) / CELL_DEGREES), height = Math.round((box[3] - box[1]) / CELL_DEGREES);
  const mean = new Float32Array(width * height).fill(NODATA);
  const rms = new Float32Array(width * height).fill(NODATA);
  if (!files.length) return { width, height, mean, rms };
  const name = 'terrain-' + box.map(value => value.toFixed(2)).join('_') + '-' + CELL_DEGREES;
  const cached = method => path.join(cache, name + '-' + method + '.f32');
  if (!fs.existsSync(cached('average')) && readFromGrid(box, names, cache, width, height, mean, rms)) return { width, height, mean, rms };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ashline-terrain-'));
  try {
    let vrt = null;
    [['average', mean], ['rms', rms]].forEach(([method, target]) => {
      const file = cached(method);
      if (!fs.existsSync(file)) {
        if (!vrt) {
          vrt = path.join(temporary, 'dem.vrt');
          // A box across the 180th meridian takes the tiles beyond it moved into its own frame.
          if (box[0] < -180 || box[2] > 180) files = tilesInFrame(files, box, temporary);
          run('gdalbuildvrt', ['-q', '-vrtnodata', String(NODATA), vrt].concat(files));
        }
        if (process.env.ASHLINE_WORLD_QUIET !== '1') console.error('Resampling ' + files.length + ' elevation tiles (' + method + ')');
        const output = path.join(temporary, method + '.bin');
        run('gdalwarp', ['-q', '-overwrite', '-multi', '-wm', '128', '-te', ...box.map(String), '-ts', String(width), String(height),
          '-r', method, '-srcnodata', String(NODATA), '-dstnodata', String(NODATA), '-ot', 'Float32', '-of', 'ENVI',
          vrt, output]);
        // Under a name of this thread's own until complete: the terrain pool's workers may resample one box together.
        const part = file + '.' + process.pid + '-' + threadId + '.part';
        fs.copyFileSync(output, part);
        fs.renameSync(part, file);
      }
      const bytes = fs.readFileSync(file);
      target.set(new Float32Array(bytes.buffer, bytes.byteOffset, width * height));
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { width, height, mean, rms };
}

class Heap {
  constructor() { this.keys = []; this.values = []; }
  push(key, value) {
    const keys = this.keys, values = this.values;
    let index = keys.length;
    keys.push(key); values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[index] = keys[parent]; values[index] = values[parent];
      index = parent;
    }
    keys[index] = key; values[index] = value;
  }
  pop() {
    const keys = this.keys, values = this.values, top = values[0];
    const lastKey = keys.pop(), lastValue = values.pop();
    if (keys.length) {
      let index = 0;
      for (;;) {
        let child = index * 2 + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[index] = keys[child]; values[index] = values[child];
        index = child;
      }
      keys[index] = lastKey; values[index] = lastValue;
    }
    return top;
  }
  get size() { return this.keys.length; }
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const [a, b] = [points[0], points.at(-1)];
  let worst = -1, worstIndex = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const p = points[index], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    const distance = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
    if (distance > worst) { worst = distance; worstIndex = index; }
  }
  if (worst <= tolerance) return [a, b];
  return simplify(points.slice(0, worstIndex + 1), tolerance).slice(0, -1).concat(simplify(points.slice(worstIndex), tolerance));
}

// At most MAX_STOP_CANDIDATES settlements are weighed as stops for one line: choosing the chain compares every pair,
// and a line across the Ganges plain or Java would otherwise weigh tens of thousands of villages. Where there are
// more, the box is cut into that many cells and each keeps its biggest place (cities, then towns, then villages, by
// population), so the line can still run anywhere, through a town wherever there is one. Kept out of PARAMETERS so
// the terrain routes already cached for the Americas stay usable: where it binds it changes only which of a crowd of
// villages a line passes through.
const MAX_STOP_CANDIDATES = 800;
const KIND_RANK = { city: 3, town: 2, village: 1 };
function thinCandidates(records, box) {
  if (records.length <= MAX_STOP_CANDIDATES) return records;
  const side = Math.sqrt((box[2] - box[0]) * (box[3] - box[1]) / MAX_STOP_CANDIDATES);
  const best = new Map();
  records.forEach(record => {
    const key = Math.floor((record.coordinates[0] - box[0]) / side) + ',' + Math.floor((record.coordinates[1] - box[1]) / side);
    const current = best.get(key);
    if (!current || KIND_RANK[record.kind] > KIND_RANK[current.kind] || (KIND_RANK[record.kind] === KIND_RANK[current.kind]
      && ((record.population || 0) > (current.population || 0)
        || ((record.population || 0) === (current.population || 0) && String(record.id || record.name) < String(current.id || current.name))))) {
      best.set(key, record);
    }
  });
  return Array.from(best.values());
}

// The line between two points of mapped track, [longitude, latitude] each. settlements are { name, kind,
// coordinates } records (cities, towns and villages from OpenStreetMap); cache is the elevation tile cache.
//
// A line is planned the way a railway would be: first which towns it serves, then how it gets between them. Every
// city, town and village in the area is a candidate stop. The cost of a hop between two of them is estimated from the
// ground under the straight line between them, a hop into a settlement is STOP_DISCOUNT cheaper, and no hop may be
// longer than MAX_HOP_KM, so the cheapest chain is one a surveyor would plausibly choose. The terrain search then lays
// track from each stop to the next.
function terrainPath(from, to, settlements = [], cache) {
  const straightKm = haversineKm(from, to);
  const padKm = Math.max(MIN_PADDING_KM, straightKm * PADDING_SHARE);
  const middleLatitude = (from[1] + to[1]) / 2;
  const padLatitude = padKm / 110.57, padLongitude = padKm / (111.32 * Math.cos(middleLatitude * Math.PI / 180));
  const snap = value => Math.round(value / CELL_DEGREES) * CELL_DEGREES;
  const box = [snap(Math.min(from[0], to[0]) - padLongitude), snap(Math.min(from[1], to[1]) - padLatitude),
    snap(Math.max(from[0], to[0]) + padLongitude), snap(Math.max(from[1], to[1]) + padLatitude)];
  const inBox = point => point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];
  const { width, height, mean, rms } = sampleBox(box, cache);
  const cellAt = point => {
    const column = Math.max(0, Math.min(width - 1, Math.floor((point[0] - box[0]) / CELL_DEGREES)));
    const row = Math.max(0, Math.min(height - 1, Math.floor((box[3] - point[1]) / CELL_DEGREES)));
    return row * width + column;
  };
  const centre = index => [box[0] + (index % width + 0.5) * CELL_DEGREES, box[3] - (Math.floor(index / width) + 0.5) * CELL_DEGREES];
  // Per-cell terrain: water, and the multiplier the ground puts on a kilometre crossed into it.
  const water = new Uint8Array(width * height), ground = new Float32Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const average = mean[index], square = rms[index];
    const spread = Math.sqrt(Math.max(0, square * square - average * average));
    water[index] = average === NODATA || average <= 0.5 || spread < LAKE_FLATNESS_M ? 1 : 0;
    ground[index] = water[index] ? WATER_COST
      : 1 + spread / ROUGHNESS_M + Math.max(0, average - SNOW_LINE_M) / 500;
  }
  const records = settlements.map(settlement => Array.isArray(settlement)
    ? { name: '', kind: 'village', coordinates: settlement } : settlement).filter(settlement => inBox(settlement.coordinates));
  const town = new Uint8Array(width * height);
  records.forEach(record => {
    const point = record.coordinates;
    const reachLatitude = TOWN_KM / 110.57, reachLongitude = TOWN_KM / (111.32 * Math.cos(point[1] * Math.PI / 180));
    for (let lat = point[1] - reachLatitude; lat <= point[1] + reachLatitude; lat += CELL_DEGREES / 2) {
      for (let lon = point[0] - reachLongitude; lon <= point[0] + reachLongitude; lon += CELL_DEGREES / 2) {
        if (haversineKm(point, [lon, lat]) <= TOWN_KM) town[cellAt([lon, lat])] = 1;
      }
    }
  });
  const start = cellAt(from), goal = cellAt(to);
  water[start] = 0; water[goal] = 0; ground[start] = 1; ground[goal] = 1;
  const kmPerRow = CELL_DEGREES * 110.57;
  const stepCost = (current, next, km) => {
    if (water[next] || water[current]) return km * WATER_COST;
    const grade = Math.abs(mean[next] - mean[current]) / (km * 1000) * 100;
    const step = km * (ground[next] + (grade / GRADE_SOFT) ** 2);
    return town[next] ? step * TOWN_FACTOR : step;
  };
  let expanded = 0;
  // The cheapest path of cells between two cells.
  const search = (origin, target) => {
    const targetPoint = centre(target);
    const cost = new Float64Array(width * height).fill(Infinity), came = new Int32Array(width * height).fill(-1);
    const heap = new Heap();
    cost[origin] = 0;
    heap.push(haversineKm(centre(origin), targetPoint) * TOWN_FACTOR, origin);
    const offsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    while (heap.size) {
      const current = heap.pop();
      if (current === target) break;
      expanded++;
      const column = current % width, row = Math.floor(current / width);
      const kmPerColumn = CELL_DEGREES * 111.32 * Math.cos((box[3] - (row + 0.5) * CELL_DEGREES) * Math.PI / 180);
      for (const [dx, dy] of offsets) {
        const nextColumn = column + dx, nextRow = row + dy;
        if (nextColumn < 0 || nextColumn >= width || nextRow < 0 || nextRow >= height) continue;
        const next = nextRow * width + nextColumn;
        const total = cost[current] + stepCost(current, next, Math.hypot(dx * kmPerColumn, dy * kmPerRow));
        if (total < cost[next]) {
          cost[next] = total;
          came[next] = current;
          heap.push(total + haversineKm(centre(next), targetPoint) * TOWN_FACTOR, next);
        }
      }
    }
    if (came[target] < 0 && target !== origin) return null;
    const cells = [];
    for (let cursor = target; cursor >= 0; cursor = came[cursor]) {
      cells.push(cursor);
      if (cursor === origin) break;
    }
    return cells.reverse();
  };
  // What the ground under a straight line would cost, sampled every couple of kilometres: an estimate of a hop.
  const estimate = (a, b) => {
    const km = haversineKm(a, b);
    if (km > MAX_HOP_KM) return Infinity;
    const samples = Math.max(1, Math.ceil(km / 2));
    let total = 0, previous = cellAt(a);
    for (let sample = 1; sample <= samples; sample++) {
      const t = sample / samples, next = cellAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      total += next === previous ? km / samples * ground[next] : stepCost(previous, next, km / samples);
      previous = next;
    }
    return total;
  };
  // Choose the stops: the cheapest chain from one end to the other, no hop longer than MAX_HOP_KM.
  const stops = [{ name: '', coordinates: from }]
    .concat(thinCandidates(records.filter(record => STOP_DISCOUNT[record.kind]
      && haversineKm(record.coordinates, from) > TOWN_KM * 2 && haversineKm(record.coordinates, to) > TOWN_KM * 2
      && !water[cellAt(record.coordinates)]), box))
    .concat([{ name: '', coordinates: to }]);
  const last = stops.length - 1, best = new Float64Array(stops.length).fill(Infinity), previousStop = new Int32Array(stops.length).fill(-1);
  const settled = new Uint8Array(stops.length);
  best[0] = 0;
  for (;;) {
    let current = -1;
    for (let index = 0; index < stops.length; index++) {
      if (!settled[index] && best[index] < Infinity && (current < 0 || best[index] < best[current])) current = index;
    }
    if (current < 0 || current === last) break;
    settled[current] = 1;
    for (let next = 1; next < stops.length; next++) {
      if (settled[next]) continue;
      const hop = estimate(stops[current].coordinates, stops[next].coordinates);
      if (hop === Infinity) continue;
      const weight = hop * (1 - (next === last ? 0 : STOP_DISCOUNT[stops[next].kind]));
      if (best[current] + weight < best[next]) { best[next] = best[current] + weight; previousStop[next] = current; }
    }
  }
  let chain = [0, last];
  if (best[last] < Infinity) {
    chain = [];
    for (let cursor = last; cursor >= 0; cursor = previousStop[cursor]) chain.push(cursor);
    chain.reverse();
  }
  let cells = [start];
  for (let index = 1; index < chain.length; index++) {
    const leg = search(cells.at(-1), cellAt(stops[chain[index]].coordinates));
    if (!leg) return null;
    cells = cells.concat(leg.slice(1));
  }
  // A town visited on the way to another can leave the line doubling back through the same cells; cut those loops.
  const seen = new Map(), clean = [];
  cells.forEach(cell => {
    if (seen.has(cell)) { while (clean.length - 1 > seen.get(cell)) seen.delete(clean.pop()); return; }
    seen.set(cell, clean.length);
    clean.push(cell);
  });
  const raw = [from].concat(clean.slice(1, -1).map(centre), [to]);
  const coordinates = simplify(raw, SIMPLIFY_DEGREES).map(point => [Math.round(point[0] * 1e5) / 1e5, Math.round(point[1] * 1e5) / 1e5]);
  coordinates[0] = from; coordinates[coordinates.length - 1] = to;
  let km = 0;
  for (let index = 1; index < coordinates.length; index++) km += haversineKm(coordinates[index - 1], coordinates[index]);
  const crossed = clean.filter(index => water[index]).length * CELL_DEGREES * 110.57;
  const via = chain.slice(1, -1).map(index => stops[index].name).filter(Boolean);
  return { coordinates, km, straightKm, waterKm: crossed, via, expanded };
}

module.exports = { terrainPath, PARAMETERS, haversineKm, Heap };

// Try one: node scripts/world/terrain-path.cjs lon,lat lon,lat
if (require.main === module) {
  const [from, to] = process.argv.slice(2, 4).map(value => value.split(',').map(Number));
  const placesFile = path.resolve(__dirname, '../../world/imported/south-america-places.json');
  const towns = fs.existsSync(placesFile) ? JSON.parse(fs.readFileSync(placesFile, 'utf8')).places : [];
  console.time('terrain path');
  const result = terrainPath(from, to, towns);
  console.timeEnd('terrain path');
  console.log(JSON.stringify({ ...result, coordinates: result.coordinates.length + ' points' }));
  console.log(JSON.stringify(result.coordinates));
}
