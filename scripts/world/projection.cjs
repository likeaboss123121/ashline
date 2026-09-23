// The one map projection every playable corridor is gridded on, so lines laid out separately still meet where the
// real railways meet.
//
// Lambert azimuthal equal-area, centred on South America: every grid square covers the same area of ground, and
// across the continent shapes bend by no more than about a tenth. The result is shifted so the first station of the
// game, Punta Arenas, stands on square (0, 0). The browser repeats these formulas in setup.worldmap.projectGrid for
// its debug map, taking the parameters from the compiled data rather than from this file.
const EARTH_RADIUS_KM = 6371.0088;
const GRID = {
  projection: 'lambert-azimuthal-equal-area',
  centre: [-60, -20],
  // Punta Arenas as the routed main line starts there: the anchor of the Chile routing.
  origin: [-70.90114, -53.16472],
  cellKm: 5
};

const radians = degrees => degrees * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;

function project(point, grid = GRID) {
  const lambda = radians(point[0]), phi = radians(point[1]);
  const lambda0 = radians(grid.centre[0]), phi0 = radians(grid.centre[1]);
  const k = Math.sqrt(2 / (1 + Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0)));
  return [EARTH_RADIUS_KM * k * Math.cos(phi) * Math.sin(lambda - lambda0),
    EARTH_RADIUS_KM * k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lambda - lambda0))];
}

function unproject(xy, grid = GRID) {
  const lambda0 = radians(grid.centre[0]), phi0 = radians(grid.centre[1]);
  const rho = Math.hypot(xy[0], xy[1]);
  if (rho === 0) return grid.centre.slice();
  const c = 2 * Math.asin(rho / (2 * EARTH_RADIUS_KM));
  const phi = Math.asin(Math.cos(c) * Math.sin(phi0) + xy[1] * Math.sin(c) * Math.cos(phi0) / rho);
  const lambda = lambda0 + Math.atan2(xy[0] * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - xy[1] * Math.sin(phi0) * Math.sin(c));
  return [degrees(lambda), degrees(phi)];
}

// The grid square a point falls in, counted from the square the origin stands on.
function cellOf(point, grid = GRID) {
  const here = project(point, grid), origin = project(grid.origin, grid);
  return [Math.round((here[0] - origin[0]) / grid.cellKm), Math.round((here[1] - origin[1]) / grid.cellKm)];
}

// The middle of a grid square, as a longitude and latitude.
function centreOf(cell, grid = GRID) {
  const origin = project(grid.origin, grid);
  const centre = unproject([origin[0] + cell[0] * grid.cellKm, origin[1] + cell[1] * grid.cellKm], grid);
  return [Math.round(centre[0] * 1e7) / 1e7, Math.round(centre[1] * 1e7) / 1e7];
}

module.exports = { GRID, EARTH_RADIUS_KM, project, cellOf, centreOf };
