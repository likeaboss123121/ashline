// Land and water under the network, for the debug map: which blocks of the joined grid are land, from Natural Earth's
// 1:50m land polygons (world/external/natural-earth-50m-land.geojson, public domain).
//
// The network is drawn on the grid it was built on, and a grid far from its centre is turned and stretched: north is
// seldom up. Coastlines drawn underneath show where the lines really are. The mask covers the network's squares and
// MARGIN squares round them, a block of BLOCK by BLOCK squares at a time. Each block is placed on the grid of the
// network part nearest it (the world is two grids joined at Wales, Alaska; see joinNetworks in compile-world.cjs),
// turned back into a longitude and latitude, and looked up in the land polygons, which are first filled into a raster
// of RASTER_DEGREES cells.
//
// The result is { block, x0, y0, width, height, runs }. Rows run from the top (the highest y) down, as the map is
// drawn: the block in column c and row r covers squares x0 + c * block to x0 + (c + 1) * block - 1 across, and
// y0 - r * block down to y0 - (r + 1) * block + 1. runs is the mask row by row as alternating run lengths, water
// first, in base 36, joined by commas; charts, on a world of several grids, says which grid each block is on, as runs
// of "chart:length".
const projection = require('./projection.cjs');

const BLOCK = 2;
const MARGIN = 64;
const RASTER_DEGREES = 0.05;

// The land polygons filled into a raster of RASTER_DEGREES cells, row 0 at 90 degrees north, column 0 at 180 west:
// even-odd scanline fill of every ring, so lakes and islands within land come out right.
function rasterizeLand(geojson) {
  const columns = Math.round(360 / RASTER_DEGREES), rows = Math.round(180 / RASTER_DEGREES);
  const raster = new Uint8Array(columns * rows);
  const rings = [];
  geojson.features.forEach(feature => {
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    polygons.forEach(polygon => polygon.forEach(ring => rings.push(ring)));
  });
  // Each edge listed under the rows whose middles it crosses.
  const byRow = Array.from({ length: rows }, () => []);
  rings.forEach(ring => {
    for (let index = 0; index < ring.length - 1; index++) {
      const [ax, ay] = ring[index], [bx, by] = ring[index + 1];
      if (ay === by) continue;
      const top = Math.max(ay, by), bottom = Math.min(ay, by);
      // A row either side as well: where a vertex lies exactly on a row's middle, rounding could otherwise leave the edge
      // out of a row whose crossing test counts it, and that row would come out with land and water swapped. The test
      // below decides.
      const first = Math.max(0, Math.ceil((90 - top) / RASTER_DEGREES - 0.5) - 1), last = Math.min(rows - 1, Math.floor((90 - bottom) / RASTER_DEGREES - 0.5) + 1);
      for (let row = first; row <= last; row++) byRow[row].push([ax, ay, bx, by]);
    }
  });
  byRow.forEach((edges, row) => {
    const latitude = 90 - (row + 0.5) * RASTER_DEGREES;
    const crossings = [];
    edges.forEach(([ax, ay, bx, by]) => {
      if ((ay <= latitude) === (by <= latitude)) return;
      crossings.push(ax + (latitude - ay) / (by - ay) * (bx - ax));
    });
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = Math.max(0, Math.ceil((crossings[index] + 180) / RASTER_DEGREES - 0.5));
      const to = Math.min(columns - 1, Math.floor((crossings[index + 1] + 180) / RASTER_DEGREES - 0.5));
      for (let column = from; column <= to; column++) raster[row * columns + column] = 1;
    }
  });
  return { raster, columns, rows };
}

function isLand(land, point) {
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  const longitude = ((point[0] + 180) % 360 + 360) % 360 - 180;
  const column = Math.min(land.columns - 1, Math.floor((longitude + 180) / RASTER_DEGREES));
  const row = Math.min(land.rows - 1, Math.max(0, Math.floor((90 - point[1]) / RASTER_DEGREES)));
  return land.raster[row * land.columns + column] === 1;
}

// A square of the joined grid back to a longitude and latitude on a chart's own grid: the offset taken away, the
// quarter turns undone (as setup.worldmap.unprojectGrid does in the game).
function placeOf(x, y, chart) {
  const grid = chart.grid;
  if (chart.offset) { x -= chart.offset[0]; y -= chart.offset[1]; }
  for (let turn = 0; turn < (((chart.turn || 0) % 4) + 4) % 4; turn++) { const back = x; x = y; y = -back; }
  const origin = projection.project(grid.origin, grid);
  const xy = [origin[0] + x * grid.cellKm, origin[1] + y * grid.cellKm];
  // Past the far side of the projection there is no place at all.
  if (Math.hypot(xy[0], xy[1]) >= 2 * projection.EARTH_RADIUS_KM) return null;
  const lambda0 = grid.centre[0] * Math.PI / 180, phi0 = grid.centre[1] * Math.PI / 180, R = projection.EARTH_RADIUS_KM;
  const rho = Math.hypot(xy[0], xy[1]);
  if (rho === 0) return grid.centre.slice();
  const c = 2 * Math.asin(rho / (2 * R));
  const phi = Math.asin(Math.cos(c) * Math.sin(phi0) + xy[1] * Math.sin(c) * Math.cos(phi0) / rho);
  const lambda = lambda0 + Math.atan2(xy[0] * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - xy[1] * Math.sin(phi0) * Math.sin(c));
  return [lambda * 180 / Math.PI, phi * 180 / Math.PI];
}

// The mask for a network: squares as { x, y } in the order the charts count them, charts as [{ grid, offset, turn,
// count }] (one chart of the network's own grid when it has no others).
function landMask(squares, charts, land) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  squares.forEach(square => {
    x0 = Math.min(x0, square.x); x1 = Math.max(x1, square.x); y0 = Math.min(y0, square.y); y1 = Math.max(y1, square.y);
  });
  x0 -= MARGIN; x1 += MARGIN; y0 -= MARGIN; y1 += MARGIN;
  const width = Math.ceil((x1 - x0 + 1) / BLOCK), height = Math.ceil((y1 - y0 + 1) / BLOCK);
  const left = x0, top = y0 + height * BLOCK - 1;
  // Which chart each block is on: the chart of the squares in it, then spread outward block by block to the rest.
  const chartOf = new Int16Array(width * height).fill(-1);
  let first = 0, queue = [];
  charts.forEach((chart, index) => {
    for (let at = first; at < first + chart.count; at++) {
      const square = squares[at];
      const cell = Math.floor((top - square.y) / BLOCK) * width + Math.floor((square.x - left) / BLOCK);
      if (chartOf[cell] < 0) { chartOf[cell] = index; queue.push(cell); }
    }
    first += chart.count;
  });
  while (queue.length) {
    const next = [];
    queue.forEach(cell => {
      const column = cell % width, row = (cell - column) / width;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const c = column + dx, r = row + dy;
        if (c < 0 || r < 0 || c >= width || r >= height) return;
        const other = r * width + c;
        if (chartOf[other] < 0) { chartOf[other] = chartOf[cell]; next.push(other); }
      });
    });
    queue = next;
  }
  const values = [], chartValues = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const chartIndex = Math.max(0, chartOf[row * width + column]), chart = charts[chartIndex];
      chartValues.push(chartIndex);
      const x = left + (column + 0.5) * BLOCK - 0.5, y = top - (row + 0.5) * BLOCK + 0.5;
      values.push(isLand(land, placeOf(x, y, chart)) ? 1 : 0);
    }
  }
  const runs = [];
  let current = 0, length = 0;
  values.forEach(value => {
    if (value === current) { length++; return; }
    runs.push(length);
    current = value;
    length = 1;
  });
  runs.push(length);
  // Which chart each block is on, the same way: runs of "chart:length", the length in base 36.
  const chartRuns = [];
  chartValues.forEach(value => {
    const last = chartRuns[chartRuns.length - 1];
    if (last && last[0] === value) last[1]++;
    else chartRuns.push([value, 1]);
  });
  return { block: BLOCK, x0: left, y0: top, width, height, runs: runs.map(run => run.toString(36)).join(','),
    ...(charts.length > 1 ? { charts: chartRuns.map(([chart, count]) => chart + ':' + count.toString(36)).join(',') } : {}) };
}

module.exports = { rasterizeLand, isLand, placeOf, landMask, BLOCK, MARGIN };
