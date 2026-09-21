# The world map

## v0.3 worldwide graph prototype

The v0.3 work begins alongside, rather than inside, the playable v0.2 generator described below. `world/` holds
the normalized source inputs and schema, `scripts/world/compile-world.cjs` deterministically partitions them into
geographic chunks, and `source/world-data.js` embeds those exact chunks in the single-file game. The browser API
is `setup.worldGraph` in `source/world-graph.js`.

The initial South America spike has 35 GeoNames-derived city waypoints and three authored Punta Arenas–Panama
corridors. Its 40 links are geodesic planning chords, not railway claims: each is marked `navigable: false` and
`reviewRequired: true`. A debug-only overview makes the data inspectable while gameplay continues to use the
seeded generator. The next pipeline stage replaces chords with normalized present/historical rail geometry and
reviewed gap-fill proposals, then samples accepted edges into approximately 5 km gameplay slices.

The first real-geometry pilot uses the dated 2026-09-20 Geofabrik Chile extract. A central-Chile box around
Santiago and Valparaíso normalizes 1,581 OSM railway ways, 21,391 coordinates and about 1,160 km of current,
proposed, construction, disused, abandoned and razed track. Every source way retains provenance and operational
tags. Lifecycle status does not restrict gameplay routing: the setting restores all mapped railway alignments.
The authored Padre Hurtado–Malloco–Talagante–El Monte–Melipilla debug corridor routes over that connected graph
and retains eleven station-bounded provenance slices. Gameplay reslices the complete 41.96 km corridor
continuously into eight 5 km steps and one final remainder, rather than creating short tiles at every station.
That derived corridor alone is navigable.

Static graph data always lives in `setup`; pilot saves keep only the stable corridor ID and numeric position.
The sourced corridor is adapted into the same integer grid tiles used by the generated world and runs through
`OnTheLine`, its normal driving view, walking, save, time and fuel systems. The active `currentTrain` remains the
same consist. Run
`npm run world:build` to regenerate outputs and `npm run world:check` to verify them.

The world between stations is a grid of 5 km by 5 km tiles, each carrying one piece of track. It lives in
[`source/worldmap.js`](../source/worldmap.js) as `setup.worldmap`.

For sourced tiles, Copernicus GLO-90 samples are aggregated over the full 5 km geographic square. The arithmetic
mean is the tile elevation and grade is the difference between adjacent means divided by their route distance.
Population standard deviation measures within-tile relief; `120 m` currently separates plains from mountain.
Absolute altitude is not a terrain classifier, so a high, flat plateau remains plains. Bridges and tunnels from
OSM override the relief classification. Raw DEM rasters stay outside the repository; the small aggregate is
compiled into static world data.

## It is never saved

Every tile is a pure function of the world seed. Nothing the generator produces is written into
`State.variables`, so the map costs nothing in a save and can never drift out of step with one: ask for the same
seed and the same world comes back. Results are memoised in `setup.worldmap.cache`, which SugarCube does not
persist, and `clearCache()` empties it.

Only what the player changes — where trains stand, what has been looted, what the consist carries — belongs in
save data. When adding to this system, check which side of that line a piece of state falls on.

## Coordinates and legs

Tiles are addressed by whole numbers, `x` east and `y` north, with station 1 at the origin. A **leg** is the run
of track from station N to station N + 1, and `getLeg(seed, legIndex)` builds it. Its heading comes from
`setup.railyard.getLegHeading`, the same function that names a station's lead tracks, so the map and the compass
directions the player reads are one route. `getStationTile(seed, stationId)` walks the legs back to the origin,
so a station stands wherever the leg that reaches it ended.

Legs are 8 to 20 tiles long, or 40 to 100 km. Generation is lazy: a leg is built the first time something asks
for it, which is when the player approaches the station at its end.

## Tiles

Each tile records the directions its track points (`ends`), the piece of track that joins them (`shape`), its
`terrain`, its `elevation` in metres, and the `grade` of the step leaving it.

| Shape | Meaning |
| --- | --- |
| `straight-ns`, `straight-ew`, `straight-nwse`, `straight-nesw` | The four straights, on the axis named. |
| `turn-45`, `turn-90` | A 45 degree bend and a right angle. |
| `t-junction`, `y-junction` | Three ends: a branch at a right angle to the line, or 45 degrees off it. |
| `cross` | Four ends, two lines crossing. |
| `dead-end` | One end: where an abandoned branch stops. |

Shapes are derived from the ends, not stored separately: two opposite ends are a straight, ends three apart are
a 45 degree bend and two apart a right angle, three ends are a T or a Y, four are a crossing.

## Terrain and its rules

Terrain comes from smoothly interpolated value noise, so a mountain is a range rather than a scatter of peaks,
and from the tile's distance north of Punta Arenas: the far south is subpolar, and a dry belt sits well up the
continent. Water and high ground are decided before any track is laid; `bridge` and `tunnel` are what the line
does about them.

| Terrain | What it carries |
| --- | --- |
| `plains`, `forest`, `desert`, `arctic` | Any shape. A forest is where trees can be felled for timber (see REFUELLING.md). Forests grow where the `forest` noise passes `FOREST_THRESHOLD` on land that is not already water, mountain, arctic or desert, about a sixth of the map. |
| `mountain` | No `t-junction`, `y-junction` or `cross`: there is no room for them. |
| `bridge` | One straight track. A water tile the line crosses becomes a bridge, so the line cannot turn on one. |
| `tunnel` | One straight track, under a mountain above 1450 m. |
| `water` | No track at all. The line bridges it or goes around. |

`canPlace(terrain, shape)` is the single rule check, and the generator consults it for every tile it lays,
including the junction it would create for a branch.

## Grades

Elevation is a noise field in metres; a tile's grade is the rise to the next tile over the 5 km run (7.07 km
diagonally), as a percentage, quantised to the half percent and capped at ±5%. Because it is derived from the
two elevations, a climb one way is exactly the descent the other way, and travelling a leg backwards is the same
list of grades negated.

## Branches

About one main-line tile in eight sprouts an abandoned branch: a junction on the line and two to five tiles of
track that stop at a dead end. A branch leaves at 45 degrees, making a `y-junction`, or at a right angle, making
a `t-junction`, and now and then a second branch leaves the far side of the same tile, making a `cross`. They go
nowhere yet, and are there to become real routes and sidings later. A branch is abandoned if the junction it
needs is not allowed by the terrain, or if it would run into the line the leg has already laid.

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

## Branches

A branch leaves the main line at a junction the player can take: the controls offer it as a direction to drive, not
as a kind of track. About a fifth of branches curve back and meet the main line further along, which makes them an
alternative route. The rest run to a terminus of their own: a station with one way in and out, id `L3B1` for the
first branch off leg 3, whose small yard is generated by `setup.railyard.generateBranchTerminus`. Leaving one puts
the train back on the branch at its far end, facing the junction.

## The debug map

`appendDebugMap(parent, stationId)` draws the leg ahead in the debug panel: terrain as coloured cells, track as
lines through them, stations as markers, and everything else on hover. In debug mode every track cell is a mouse
and keyboard teleport target; an exact-tile selector provides the same operation when a route is too narrow or
dense to click comfortably. Narrow maps are visually enlarged without changing their tile coordinates.
Teleporting while aboard moves `journey`, so the complete active consist moves;
teleporting on foot changes only `onFoot`, leaving the train's journey position alone. A trainless teleport creates
only the route context walking needs and never invents a boardable train. The map is deliberately plain, and is
there to check what the generator produced rather than to be a player-facing map. It will be replaced.

## Not done yet

- Driving is tile by tile in the `OnTheLine` passage: departing a yard is free, and each 5 km move costs that
  tile's own time and fuel. See [DRIVING_ART.md](DRIVING_ART.md) for the view of the train out there.
- Junctions lead nowhere: branches always dead-end, because there is nowhere else to go yet.
- The route is seeded, not real geography. When imported maps land, they can replace `getLegHeading` and the
  terrain fields without changing anything else here.
- Obstacles, track condition and weather do not exist, so terrain only affects the shape of the line so far.
