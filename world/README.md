# Ashline world graph

This directory is the source side of the v0.3.0 worldwide railway map. Raw GIS products are not shipped to the
browser. Offline tools normalize them into a versioned sparse graph whose nodes are stations, cities, junctions
and termini and whose edges are divided into approximately 5 km gameplay slices.

Each chunk owns its local nodes and carries explicit portal copies for any foreign endpoints its links use, so a
chunk can be validated and inspected without loading the whole dataset. The worldwide spike deliberately contains
**planning links**, not playable railway geometry. They join authored city
waypoints by geodesic chords so the format, stable identifiers, regional partitioning, debug view and size can be
tested before OpenStreetMap rail geometry and raster sampling are introduced. Every planning link is marked
`navigable: false` and `reviewRequired: true`. The explicitly authored Chilean main line, Punta Arenas to Arica,
is the current playable world; the planning chords remain debug data and never become track merely by being imported.

## Inputs

- `authored/places.csv` contains the small GeoNames-derived city catalogue used by the South America spike.
- `authored/corridors.csv` defines three ordered Punta Arenas–Panama planning corridors.
- `authored/playable-corridors.json` names the corridors approved for gameplay: the central pilot by its OSM station
  sequence, and the main line by the routed links it plays.
- `imports.json` lists normalized geometry sets included by the compiler.
- `imported/chile-central-rail.json` is the first real-geometry pilot, derived from the dated Chile OSM extract.
- `imported/chile-central-elevation.json` contains mean elevation and elevation standard deviation for each pilot grid tile.
- `imported/chile-stations.json` lists 671 named Chilean railway stations, working and closed, used as stops.
- `imported/chile-routed-elevation.json` holds the same elevation aggregates for every main-line grid square.
- `imported/south-america-places.json` lists 52,661 named cities, towns and villages, for gap fills to run through.
- `sources.json` records data versions, licences, attribution and whether each source is actually ingested yet.
- `schema/world-graph.schema.json` documents the compiled bundle contract.

Run `npm run world:build` to produce `world/dist/` and the embedded `source/world-data.js`. The compiler is
deterministic: `npm run world:check` fails if committed output differs from the inputs. The embedded bundle uses
the exact same region chunks as the standalone files, keeping the current single-HTML build while leaving a path
to network-loaded chunks later.

World data belongs in `setup`, never `State.variables`. Save state contains only numeric station and journey
positions. No raw map, compiled chunk, cache or generated topology belongs in a SugarCube save.

`scripts/world/import-osm-geojson.cjs` normalizes an Osmium GeoJSON export. Raw `.osm.pbf` and intermediate
GeoJSON files remain outside the repository. The central Chile pilot was produced from the 2026-09-20 Geofabrik
extract by filtering railway ways first, then taking a complete-way bounding box around Santiago and Valparaíso.
Every imported way retains its OSM ID, lifecycle status and useful operational tags and remains `reviewRequired: true` and
`navigable: false`. Ashline deliberately treats current, proposed, construction, disused, abandoned, dismantled
and razed alignments identically when building the gameplay graph. `build-rail-topology.cjs` connects their coordinates, routes between authored station
nodes, and emits sourced provenance slices no longer than 5 km. Only the resulting authored gameplay corridor is navigable;
importing a way never makes it playable by itself.

With `osmium-tool` installed and the dated Chile extract downloaded, reproduce it with:

```sh
npm run world:extract:chile -- --input /path/to/chile-260920.osm.pbf
npm run world:elevation:chile -- --dem /path/to/S34_W072.tif,/path/to/S34_W071.tif --output world/imported/chile-central-elevation.json
npm run world:build
npm run world:benchmark
```

The national network and the routed planning-link proposals come from the same extract:

```sh
npm run world:extract:chile:national -- --input /path/to/chile-260920.osm.pbf
npm run world:route:chile
npm run world:build
```

`world/imported/chile-rail.json` is gitignored because of its size; `world/proposals/` holds the committed routed
proposals and their review report. Routed proposals are never navigable: they are candidates for a reviewed
corridor, not track the player can use.

The playable world is the continental network (`network/south-america-network.json`), built from the same
extract plus its stations and settlements:

```sh
npm run world:extract:south-america -- --input /path/to/south-america-260921.osm.pbf
npm run world:extract:south-america:stations -- --input /path/to/south-america-260921.osm.pbf
npm run world:extract:south-america:places -- --input /path/to/south-america-260921.osm.pbf
export ASHLINE_DEM_CACHE=/somewhere/durable/copernicus
npm run world:network:south-america   # an hour the first time, for the elevation tiles and terrain; minutes after
npm run world:build
```

The Chilean main line, which played approved routed links before the network, is still compiled. Its stations and
elevation come from:

```sh
npm run world:extract:chile:stations -- --input /path/to/chile-260920.osm.pbf
npm run world:extract:south-america:places -- --input /path/to/south-america-260921.osm.pbf
export ASHLINE_DEM_CACHE=/somewhere/durable/copernicus   # elevation tiles; defaults to the system temp directory
npm run world:route:chile            # lays long gap fills over the terrain, through towns
npm run world:elevation:chile:main   # samples each grid square the main line crosses
npm run world:build
```

The extractor deliberately filters railway ways before the bounding-box pass. Reversing those operations made
the complete-way extractor exceed this server's memory on the 59-million-node country file.

## Pipeline stages

1. Fetch immutable source snapshots outside the game build.
2. Normalize rail vectors, place records and raster samples into stable IDs.
3. Snap and repair rail topology; retain source status and confidence.
4. Apply authored corridor waypoints and propose missing least-cost connections for review.
5. Sample accepted edges into approximately 5 km slices with elevation profile, grade, climate and crossings.
6. Partition the graph into fixed geographic regions and compile the web/offline artifacts.

The repository currently implements the input contract, deterministic compilation, regional partitioning,
runtime loading/querying, the planning-corridor debug view, and the Chilean main line built from approved routed
links. Gameplay uses 851 moves between squares of a shared geographic grid, across 282 stops, inside the ordinary `OnTheLine` passage, driving view,
walking, save, time and fuel systems. Copernicus GLO-90 samples provide each tile's mean elevation for grade and
within-tile elevation standard deviation for ruggedness: high flat land stays plains, while locally varied land
becomes mountain. It does not yet include climate sampling or destination yards, and it does not claim that the
worldwide waypoint chords are rail. The final short GIS remainder is retained as provenance but merged into the
last gameplay cell, so the player is never offered an odd partial-distance move.
