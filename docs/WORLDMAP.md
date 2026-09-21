# The world map

## v0.3 worldwide graph prototype

The v0.3 sourced grid replaces the playable v0.2 generator. `world/` holds
the normalized source inputs and schema, `scripts/world/compile-world.cjs` deterministically partitions them into
geographic chunks, and `source/world-data.js` embeds those exact chunks in the single-file game. The browser API
is `setup.worldGraph` in `source/world-graph.js`.

The initial South America spike has 35 GeoNames-derived city waypoints and three authored Punta Arenas–Panama
corridors. Its 40 links are geodesic planning chords, not railway claims: each is marked `navigable: false` and
`reviewRequired: true`. A debug-only overview makes those proposals inspectable, while gameplay uses only
reviewed sourced geometry. The next pipeline stage replaces more chords with normalized present/historical rail geometry and
reviewed gap-fill proposals, then samples accepted edges into approximately 5 km gameplay slices.

The first real-geometry pilot uses the dated 2026-09-20 Geofabrik Chile extract. A central-Chile box around
Santiago and Valparaíso normalizes 1,581 OSM railway ways, 21,391 coordinates and about 1,160 km of current,
proposed, construction, disused, abandoned and razed track. Every source way retains provenance and operational
tags. Lifecycle status does not restrict gameplay routing: the setting restores all mapped railway alignments.
The authored Padre Hurtado–Malloco–Talagante–El Monte–Melipilla gameplay corridor routes over that connected graph
and retains eleven station-bounded provenance slices. Gameplay reslices the complete 41.96 km corridor
into eight fixed 5 km gameplay moves. The short final GIS remainder stays in provenance and is folded into the
last cell rather than becoming a 1.96 km player action. That derived corridor alone is navigable.

Static graph data always lives in `setup`; saves keep only numeric station and journey positions.
New games spawn at Padre Hurtado in the sourced grid and run through
`OnTheLine`, its normal driving view, walking, save, time and fuel systems. The active `currentTrain` remains the
same consist. Run
`npm run world:build` to regenerate outputs and `npm run world:check` to verify them.

The world between stations is a grid of fixed 5 km gameplay cells, each carrying one piece of sourced track. It lives in
[`source/worldmap.js`](../source/worldmap.js) as `setup.worldmap`.

For sourced tiles, Copernicus GLO-90 samples are aggregated over the full 5 km geographic square. The arithmetic
mean is the tile elevation and grade is the difference between adjacent means divided by their route distance.
Population standard deviation measures within-tile relief; `120 m` currently separates plains from mountain.
Absolute altitude is not a terrain classifier, so a high, flat plateau remains plains. Bridges and tunnels from
OSM override the relief classification. Raw DEM rasters stay outside the repository; the small aggregate is
compiled into static world data.

## Static world data is never saved

Compiled rail cells and station records live in `setup`, not `State.variables`. Saves contain only stable route
positions and mutable state such as the active consist, parked trains and looted supplies. This keeps save size
independent of map size and lets a world-data migration translate old position identifiers explicitly.

## Coordinates and legs

Tiles use whole-number display coordinates, `x` east and `y` north. A **leg** is the sourced run between two real
stations. `getLeg(seed, legIndex)`, `getStationTile(seed, stationId)` and railyard headings all delegate to the
compiled corridor, so the debug grid, travel controls and yard leads describe the same topology. Leg lengths are
determined by station placement: the current corridor has one-, two-, one- and four-move legs.

## Tiles

Each tile records its source coordinates, grid coordinates, track ends and shape, terrain, average elevation,
within-cell elevation standard deviation, and the grade of the step leaving it.

| Shape | Meaning |
| --- | --- |
| `straight-ns`, `straight-ew`, `straight-nwse`, `straight-nesw` | The four straights, on the axis named. |
| `turn-45`, `turn-90` | A 45 degree bend and a right angle. |
| `t-junction`, `y-junction` | Three ends: a branch at a right angle to the line, or 45 degrees off it. |
| `cross` | Four ends, two lines crossing. |
| `dead-end` | One end: where an abandoned branch stops. |

Shapes are derived from connected ends. The current corridor has no invented side branches: only compiled,
reviewed rail connections enter gameplay.

## Terrain and its rules

Terrain comes from sourced elevation aggregates and OSM structure tags. High relief, rather than absolute
altitude, distinguishes mountains from high plains. A mapped bridge or tunnel overrides that classification.

| Terrain | What it carries |
| --- | --- |
| `plains`, `forest`, `desert`, `arctic` | Ordinary traversable land; forests allow timber recovery (see REFUELLING.md). |
| `mountain` | No `t-junction`, `y-junction` or `cross`: there is no room for them. |
| `bridge` | One straight track. A water tile the line crosses becomes a bridge, so the line cannot turn on one. |
| `tunnel` | One straight track, under a mountain above 1450 m. |
| `water` | No track at all. The line bridges it or goes around. |

## Grades

Grade is the difference between adjacent cell-average elevations divided by the route distance. Forward and
reverse travel use equal and opposite grades. The final 1.96 km source remainder is retained in provenance but
does not create a short gameplay action; it is folded into the last fixed 5 km cell.

## Driving a leg

`getLegTravel(seed, legIndex, train, reverse)` costs a leg tile by tile: five minutes for a flat 5 km at
60 km/h, scaled by the top speed of the locomotive being driven (`getTopSpeedKmh`; other locomotives are hauled in neutral
and only add weight), more for a climb, a little
less downhill, and more again for a heavy consist. Fuel follows from the clock, because the
time system burns fuel by the minute while travelling, so a steep leg costs more diesel as well as more time.

`getClimbLimitPercent(train)` is the steepest grade a consist can pull: its tractive effort (what the locomotives
can pull now, so a diesel on degraded fuel counts for less, see `setup.fuel.getEffectiveTractiveKN`) has to lift the
train up the grade and beat rolling resistance, so loading cargo flattens the limit. When a leg is steeper than
that, `getClimbBlockReason` explains it and the departure is refused, which is where the design's diegetic
weight limits come from.

## The debug map

`appendDebugMap(parent, stationId)` draws the complete playable corridor: terrain as coloured cells, track as
lines through them, all real stations as markers, and source data on hover. Every track cell is a mouse
and keyboard teleport target; an exact-tile selector provides the same operation when a route is too narrow or
dense to click comfortably. Narrow maps are visually enlarged without changing their tile coordinates.
Teleporting while aboard moves `journey`, so the complete active consist moves;
teleporting on foot changes only `onFoot`, leaving the train's journey position alone. A trainless teleport creates
only the route context walking needs and never invents a boardable train. The map is deliberately plain, and is
there to inspect compiled data rather than to be a player-facing map.

## Not done yet

- Only the Padre Hurtado–Melipilla corridor is currently playable.
- The larger South America graph remains non-navigable planning data pending reviewed rail geometry.
- Climate, rivers, obstacles, track condition and weather are not yet sourced into gameplay.

## Legacy generator

The old seeded fictional generator is no longer reachable through normal gameplay. Its internal helpers remain
temporarily in `source/worldmap.js` to reduce risk while old-save compatibility is audited; they are not a second
world mode and must not be used for new routes.
