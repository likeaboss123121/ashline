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
npm run world:network:south-america   # an hour the first time, for the elevation tiles and terrain; seconds to minutes after
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
export ASHLINE_DEM_CACHE=/somewhere/durable/copernicus
npm run world:network:americas
npm run world:build
```

The fetch downloads Geofabrik's regional extracts one at a time and keeps only railways, stations and places, so a
continent never has to fit on disk at once.

### Running a build safely, and again quickly

The extract, network and route scripts run through `scripts/world/run-limited.cjs`, which:

- caps the build's memory (on Linux with systemd, in its own scope with `MemoryMax` and no swap, so running out
  kills the build and never the machine or the SSH session; elsewhere, Node's heap). The cap is what the machine has
  free less a gigabyte, never more than all of it less two; set `ASHLINE_WORLD_MEMORY_MB` or pass `--memory` to
  choose it;
- runs at the lowest CPU and disk priority;
- keeps going when the terminal closes or SSH drops, logging to `$ASHLINE_DEM_CACHE/logs/` as well as the terminal;
- starts the build again if it is killed (out of memory, a signal), up to three times, from where it stopped.

To stop a build, press Ctrl+C in its terminal, or run `systemctl --user stop` with the unit named at the top of its
log.

`build-network.cjs` works in stages: **trace** (every railway onto the grid), **joins** (the authored routes and
the joins between pieces), **outskirts** (stub joins, facing ends, shortcuts and spurs) and **stops** (cities
simplified, parallel lines taken up, stops, yards, halts and points), then elevation. After each of the first three
it writes a checkpoint to `$ASHLINE_DEM_CACHE/checkpoints/`, keyed by the input files and by the source of the code
and constants that stage uses, found automatically. The next run starts from the last stage whose key still matches.
So a change to where stops or yards go reruns only the stops stage: seconds for South America. A change to spurs
reruns outskirts and stops. A crash loses only the stage it was in. Terrain routes (`terrain-routes-<scope>.json`)
and each square's elevation (`elevation-squares-*.tsv`) are kept as they are worked out, so even an interrupted
stage keeps most of its work. Every log line carries the time, the time since the start and the memory in use, and
the end of the log lists how long each stage took.

- `--fresh` ignores every checkpoint; `--from <stage>` reruns that stage and the ones after it.
- `--no-checkpoints` neither reads nor writes them.
- `--elevation-only` refills the elevation of a network already written. The Americas imports (`world/imported/americas-*.json`, the rail
alone 241 MB) are not committed: GitHub refuses files over 100 MB, and the fetch and extract rebuild them.

The raw `.osm.pbf` snapshot and the Copernicus tiles stay outside the repository; everything derived from them that
the build needs is committed here. Every lifecycle status (current, disused, abandoned, dismantled, razed,
proposed and the rest) is treated as track: the setting restores all mapped alignments. The rail extractor filters
railway ways before anything else, since the reverse order exhausts this server's memory on a continent.
