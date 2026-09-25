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
  }
};

function scopeFromArguments(argv = process.argv) {
  const index = argv.indexOf('--scope'), name = index >= 0 ? argv[index + 1] : 'south-america';
  const scope = SCOPES[name];
  if (!scope) throw new Error('Unknown scope "' + name + '"; one of ' + Object.keys(SCOPES).join(', '));
  return Object.assign({ name }, scope);
}

module.exports = { SCOPES, scopeFromArguments };
