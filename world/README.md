# Ashline world graph

This directory is the source side of Ashline's world map. Raw GIS products are not shipped to the browser: offline
tools normalize them here, and `scripts/world/compile-world.cjs` compiles the result into `world/dist/` and into
`source/world-data.js`, which the single-file game embeds. See [docs/WORLDMAP.md](../docs/WORLDMAP.md) for how the
world is built and played.

There are two layers. The **network** is the playable world: every mapped railway in South America on a shared grid
of 5 km squares, joined into one. The **planning corridors** are three authored Punta Arenas–Panama routes through 35
cities, kept as geodesic chords and as routes over the mapped rail for comparison in the debug overview; they are
marked `navigable: false` and are never played.

## Inputs

- `sources.json` records data versions, licences, attribution and whether each source is ingested.
- `authored/places.csv` holds the 35 GeoNames cities; `authored/corridors.csv` the three planning corridors.
- `authored/network-joins.json` lists lines to lay into the network by hand, for connections the rules miss.
- `imported/south-america-rail.json`: every railway way in the 2026-09-21 Geofabrik South America extract, with its
  OSM ID, lifecycle status and useful tags.
- `imported/south-america-stations.json`: named railway stations and halts, working and closed.
- `imported/south-america-places.json`: named cities, towns and villages, for new lines to run through.
- `network/south-america-network.json`: the built network, compiled into the game.
- `proposals/south-america-routed-links.json`: the planning corridors routed over the mapped rail, with a report.
- `imports.json` lists the network and the proposals the compiler includes; `schema/world-graph.schema.json`
  documents the compiled bundle.

World data belongs in `setup`, never `State.variables`: a save holds only a station number and a journey position.

## Rebuilding

With `osmium-tool` and GDAL installed and the dated extract downloaded:

```sh
npm run world:extract:south-america -- --input /path/to/south-america-260921.osm.pbf
npm run world:extract:south-america:stations -- --input /path/to/south-america-260921.osm.pbf
npm run world:extract:south-america:places -- --input /path/to/south-america-260921.osm.pbf
export ASHLINE_DEM_CACHE=/somewhere/durable/copernicus   # elevation tiles; defaults to the system temp directory
npm run world:network:south-america   # an hour the first time, for the elevation tiles and terrain; minutes after
npm run world:route:south-america     # the planning corridors, for the debug overview
npm run world:build
npm run world:benchmark
```

The raw `.osm.pbf` snapshot and the Copernicus tiles stay outside the repository; everything derived from them that
the build needs is committed here. Every lifecycle status (current, disused, abandoned, dismantled, razed,
proposed and the rest) is treated as track: the setting restores all mapped alignments. The rail extractor filters
railway ways before anything else, since the reverse order exhausts this server's memory on a continent.
