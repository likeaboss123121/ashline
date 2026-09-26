// The areas the world pipeline can be run over. Each extractor and the network builder take --scope (South America
// by default); a scope names its files world/imported/<prefix>-*.json and world/network/<prefix>-network.json.
const SCOPES = {
  'south-america': {
    prefix: 'south-america', label: 'South America', sourceId: 'openstreetmap-geofabrik-south-america-2026-09-21',
    gridCentre: [-60, -20]
  },
  // South America, Central America and North America, merged from Geofabrik's regional extracts by
  // fetch-osm-regions.cjs. Yard, siding and crossover tracks are left out of the rail import: North America maps
  // them in their hundreds of thousands, they all fall inside the squares of the lines they serve, and keeping them
  // would not fit this server's memory.
  americas: {
    prefix: 'americas', label: 'the Americas', sourceId: 'openstreetmap-geofabrik-americas-2026-09-24',
    dropServiceTracks: ['yard', 'siding', 'crossover'],
    // Lines are simplified to within this many degrees (about 30 m) at extraction: the network traces them onto 5 km
    // squares, and the full detail of two continents would not fit in this server's memory.
    simplifyDegrees: 0.0003,
    // The centre that keeps the grid's worst stretch lowest over the whole of both continents' railways, about 1.5
    // to 1 at Punta Arenas, Recife and Wales, Alaska (scripts/world/projection.cjs).
    gridCentre: [-102.5, 10]
  },
  // Europe, Asia and Africa, merged from Geofabrik's europe, asia, russia and africa extracts. A grid of its own:
  // one projection cannot hold the Americas and Africa both, since squares stretch without limit towards the far side
  // of the world from its centre. The compiler joins it to the Americas' grid where both meet, at Wales, Alaska, the
  // end of the Bering Strait tunnel (world/imports.json).
  'afro-eurasia': {
    prefix: 'afro-eurasia', label: 'Europe, Asia and Africa', sourceId: 'openstreetmap-geofabrik-afro-eurasia-2026-09-25',
    dropServiceTracks: ['yard', 'siding', 'crossover'],
    simplifyDegrees: 0.0003,
    // The centre that keeps the worst stretch lowest over the railways from Lisbon to Chukotka and Cape Town, about
    // 1.6 to 1 at Wales, Cape Town and Kagoshima: no worse than the Americas' grid.
    gridCentre: [40, 37.5],
    // Wales, Alaska stands on square (0, 0), so the square it stands on in the Americas' grid is the whole offset.
    gridOrigin: [-168.09035, 65.60829],
    // [west, south, east, north] in the grid's frame: the terrain router's elevation cells are resampled over this
    // once (terrain-grid.cjs), from Senegal to Wales and from Cape Town to the Yamal railway, with room for the boxes
    // new lines are planned in.
    terrainExtent: [-30, -40, 196, 82],
    // The authored cities of this build, the first the one whose network is kept: Cape Town, the end of the journey.
    places: 'world/authored/afro-eurasia-places.csv',
    startPlace: 'za-cape-town'
  }
};

// Every scope but afro-eurasia keeps the South American cities, and starts from Punta Arenas.
Object.values(SCOPES).forEach(scope => {
  scope.places = scope.places || 'world/authored/places.csv';
  scope.startPlace = scope.startPlace || 'cl-punta-arenas';
});

function scopeFromArguments(argv = process.argv) {
  const index = argv.indexOf('--scope'), name = index >= 0 ? argv[index + 1] : 'south-america';
  const scope = SCOPES[name];
  if (!scope) throw new Error('Unknown scope "' + name + '"; one of ' + Object.keys(SCOPES).join(', '));
  return Object.assign({ name }, scope);
}

// Whether an authored entry (a route, a region) belongs to a scope's build: one with no "scope" belongs to every
// build, one with a scope or a list of them only to those.
function inScope(entry, name) {
  if (!entry.scope) return true;
  return (Array.isArray(entry.scope) ? entry.scope : [entry.scope]).includes(name);
}

module.exports = { SCOPES, scopeFromArguments, inScope };
