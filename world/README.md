# Ashline world graph

This directory is the source side of the v0.3.0 worldwide railway map. Raw GIS products are not shipped to the
browser. Offline tools normalize them into a versioned sparse graph whose nodes are stations, cities, junctions
and termini and whose edges are divided into approximately 5 km gameplay slices.

Each chunk owns its local nodes and carries explicit portal copies for any foreign endpoints its links use, so a
chunk can be validated and inspected without loading the whole dataset. The worldwide spike deliberately contains
**planning links**, not playable railway geometry. They join authored city
waypoints by geodesic chords so the format, stable identifiers, regional partitioning, debug view and size can be
tested before OpenStreetMap rail geometry and raster sampling are introduced. Every planning link is marked
`navigable: false` and `reviewRequired: true`. A separate, explicitly authored central-Chile pilot is playable in
debug mode; ordinary gameplay continues to use the procedural world.

## Inputs

- `authored/places.csv` contains the small GeoNames-derived city catalogue used by the South America spike.
- `authored/corridors.csv` defines three ordered Punta Arenas–Panama planning corridors.
- `authored/playable-corridors.json` names the OSM station sequence approved for debug navigation.
- `imports.json` lists normalized geometry sets included by the compiler.
- `imported/chile-central-rail.json` is the first real-geometry pilot, derived from the dated Chile OSM extract.
- `sources.json` records data versions, licences, attribution and whether each source is actually ingested yet.
- `schema/world-graph.schema.json` documents the compiled bundle contract.

Run `npm run world:build` to produce `world/dist/` and the embedded `source/world-data.js`. The compiler is
deterministic: `npm run world:check` fails if committed output differs from the inputs. The embedded bundle uses
the exact same region chunks as the standalone files, keeping the current single-HTML build while leaving a path
to network-loaded chunks later.

World data belongs in `setup`, never `State.variables`. The pilot save state contains only a stable corridor ID
and position. No raw map, compiled chunk, cache or generated topology belongs in a SugarCube save.

`scripts/world/import-osm-geojson.cjs` normalizes an Osmium GeoJSON export. Raw `.osm.pbf` and intermediate
GeoJSON files remain outside the repository. The central Chile pilot was produced from the 2026-09-20 Geofabrik
extract by filtering railway ways first, then taking a complete-way bounding box around Santiago and Valparaíso.
Every imported way retains its OSM ID and useful operational tags and remains `reviewRequired: true` and
`navigable: false`. `build-rail-topology.cjs` connects current-track coordinates, routes between authored station
nodes, and emits sourced slices no longer than 5 km. Only the resulting authored debug corridor is navigable;
importing a way never makes it playable by itself.

With `osmium-tool` installed and the dated Chile extract downloaded, reproduce it with:

```sh
npm run world:extract:chile -- --input /path/to/chile-260920.osm.pbf
npm run world:build
npm run world:benchmark
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
runtime loading/querying, the planning-corridor debug view, and a routed Padre Hurtado–Melipilla pilot. The pilot
uses eleven sourced slices across five real stations and consumes the active consist's time and fuel. It does not
yet include elevation/climate sampling, destination yards, or reviewed gap fills, and it does not claim that the
worldwide waypoint chords are rail.
