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
- `authored/network-joins.json` lists routes to lay into the network by hand, as stops named by town or coordinates,
  for connections the rules miss. Its `about` field explains the format.
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

### The Americas

The playable world is now the Americas, from Punta Arenas to Wales, Alaska (`world/network/americas-network.json`,
listed in `imports.json`). South America is still a scope of its own for comparison and its tests.

```sh
npm run world:fetch:americas -- --dir /path/to/sources --local /path/to/south-america-260921.osm.pbf
npm run world:extract:americas -- --input /path/to/sources/americas-filtered.osm.pbf
npm run world:extract:americas:stations -- --input /path/to/sources/americas-filtered.osm.pbf
npm run world:extract:americas:places -- --input /path/to/sources/americas-filtered.osm.pbf
npm run world:extract:americas:outposts -- --input /path/to/sources/americas-filtered.osm.pbf
# The build needs about 2.5 GB; on this 6 GB server, cage it so it can never take the machine down with it:
systemd-run --user --scope --unit=ashline-build -p MemoryMax=3200M -p MemorySwapMax=0 nice -n 19 \
  env GDAL_CACHEMAX=64 ASHLINE_DEM_CACHE=/somewhere/durable/copernicus \
  node --max-old-space-size=2600 scripts/world/build-network.cjs --scope americas
npm run world:build
```

The fetch downloads Geofabrik's regional extracts one at a time and keeps only railways, stations and places, so a
continent never has to fit on disk at once. The Americas build takes about 2.5 hours on this server (the first run
also downloads the elevation tiles, and terrain routes are kept in `terrain-routes-americas.json` in the elevation
cache for the next). It writes the network before filling in elevation; if that step fails, `build-network.cjs
--scope americas --elevation-only` redoes just it. The Americas imports (`world/imported/americas-*.json`, the rail
alone 241 MB) are not committed: GitHub refuses files over 100 MB, and the fetch and extract rebuild them.

The raw `.osm.pbf` snapshot and the Copernicus tiles stay outside the repository; everything derived from them that
the build needs is committed here. Every lifecycle status (current, disused, abandoned, dismantled, razed,
proposed and the rest) is treated as track: the setting restores all mapped alignments. The rail extractor filters
railway ways before anything else, since the reverse order exhausts this server's memory on a continent.
