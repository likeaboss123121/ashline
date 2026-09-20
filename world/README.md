# Ashline world graph

This directory is the source side of the v0.3.0 worldwide railway map. Raw GIS products are not shipped to the
browser. Offline tools normalize them into a versioned sparse graph whose nodes are stations, cities, junctions
and termini and whose edges will be divided into approximately 5 km gameplay slices.

Each chunk owns its local nodes and carries explicit portal copies for any foreign endpoints its links use, so a
chunk can be validated and inspected without loading the whole dataset. The first spike deliberately contains
**planning links**, not playable railway geometry. They join authored city
waypoints by geodesic chords so the format, stable identifiers, regional partitioning, debug view and size can be
tested before OpenStreetMap rail geometry and raster sampling are introduced. Every planning link is marked
`navigable: false` and `reviewRequired: true`; gameplay continues to use the v0.2 procedural world.

## Inputs

- `authored/places.csv` contains the small GeoNames-derived city catalogue used by the South America spike.
- `authored/corridors.csv` defines three ordered Punta Arenas–Panama planning corridors.
- `sources.json` records data versions, licences, attribution and whether each source is actually ingested yet.
- `schema/world-graph.schema.json` documents the compiled bundle contract.

Run `npm run world:build` to produce `world/dist/` and the embedded `source/world-data.js`. The compiler is
deterministic: `npm run world:check` fails if committed output differs from the inputs. The embedded bundle uses
the exact same region chunks as the standalone files, keeping the current single-HTML build while leaving a path
to network-loaded chunks later.

World data belongs in `setup`, never `State.variables`. Saves will eventually refer only to a world dataset
version, stable edge ID and slice position. No raw map, compiled chunk, cache or generated topology belongs in a
SugarCube save.

## Pipeline stages

1. Fetch immutable source snapshots outside the game build.
2. Normalize rail vectors, place records and raster samples into stable IDs.
3. Snap and repair rail topology; retain source status and confidence.
4. Apply authored corridor waypoints and propose missing least-cost connections for review.
5. Sample accepted edges into approximately 5 km slices with elevation profile, grade, climate and crossings.
6. Partition the graph into fixed geographic regions and compile the web/offline artifacts.

The repository currently implements the input contract, deterministic compilation, regional partitioning,
runtime loading/querying and the planning-corridor debug view. It does not yet claim that waypoint chords are rail.
