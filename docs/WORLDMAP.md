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
last cell rather than becoming a 1.96 km player action. It is still compiled, but is no longer the default world:
the Chilean main line below replaced it.

Static graph data always lives in `setup`; saves keep only numeric station and journey positions.
New games spawn at Punta Arenas on the Chilean main line and run through
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

## Routing planning links over real rail

`scripts/world/route-planning-links.cjs` (`npm run world:route:chile`) is pipeline stage 4. It reads the whole
Chilean network (`world/imported/chile-rail.json`, produced by `npm run world:extract:chile:national` and gitignored
at 11.7 MB), and routes every planning link whose two cities lie in Chile:

- **Anchors.** A city is reached at a named station within 8 km, otherwise its nearest mainline track within 20 km,
  otherwise the city itself.
- **Repairs.** Loose ends within 50 m of other track are snapped: digitizing breaks, not missing railway.
- **Gap fills.** Loose ends of separate networks within 30 km are offered as joins that cost four times their
  length, so mapped rail always wins where it exists. If two cities' networks never meet at all, the single
  shortest join between them is proposed as a long gap.
- **Slices.** Routes are cut into slices of at most 5 km carrying their source OSM ways, lifecycle statuses,
  bridge/tunnel flags, rail and gap kilometres, and named stations passed within 300 m.

Output is `world/proposals/chile-routed-links.json` and a human review report beside it. Every route and slice is
`navigable: false`: routing a link over real rail does not make it playable, and every gap fill is new track that
needs Likea's review before an authored corridor may adopt it. The compiler validates these flags, records on each
covered planning link which route replaced it (`routedBy`), and embeds only a simplified drawing for the debug
overview, where mapped rail is solid and gap fills are dashed.

Current result: Puerto Montt–Santiago runs entirely on mapped rail; Santiago–Antofagasta almost entirely; Antofagasta–Arica
needs a 121 km join where no railway ever linked Iquique and Arica; and Punta Arenas–Puerto Montt is a 1,306 km
proposal, because Patagonia has never had a connecting railway.

Routing also records how many kilometres of each slice run on bridges and in tunnels, so a playable corridor can
tell a river crossing from a culvert.

## The Chilean main line

Likea approved all four Chile links, gap fills included, for play on 2026-09-22. The playable world is now the
`cl-main-line` corridor in `world/authored/playable-corridors.json`, which lists the routed links it plays. Listing
a link there is the review decision; the proposal file itself never changes to `navigable: true`.
`scripts/world/build-routed-corridor.cjs` builds it at compile time:

- **One line.** The four links are joined end to end (the compiler refuses links that do not meet) into a single
  4,785 km line from Punta Arenas to Arica: about 3,342 km on mapped rail and 1,443 km of gap fill.
- **Stops.** Each city the links join is a station. So is every named OSM station, working or closed, that stands
  within 1 km of mapped track on the line. These come from `world/imported/chile-stations.json`
  (`npm run world:extract:chile:stations -- --input chile-260920.osm.pbf`, 671 stations), because the railway
  extract only keeps nodes on the track and misses most stations. Metro and bus stations are left out.
  Stops closer than 5 km are thinned: a city wins, then a working station (larger EFE category first), then a
  working halt, then a closed station.
- **Kilometre posts.** Where the line runs more than 100 km with nowhere to stop, halts named `Km N` (distance
  from Punta Arenas) are spaced evenly along it. Only the Patagonian gap fill and one stretch near Arica need them.
  The limit exists because every yard keeps a reserve engine with fuel to reach the next stop, which a tank cannot
  promise over 1,300 km.
- **Tiles.** The whole line is re-cut into 958 slices of 5 km, each carrying its OSM ways, the routed slices it came
  from, rail and gap kilometres, and a `gapFill` flag (more gap than rail) that the debug map shows on hover.
  A tile is a bridge when it has at least 200 m of bridge and a tunnel when at least half of it is underground.
- **Elevation.** `npm run world:elevation:chile:main` fetches the Copernicus GLO-90 tiles the line crosses (about 50,
  cached outside the repository) and samples every position, as for the pilot. The compiler rejects stale samples
  by build ID; the ID covers only what decides where slices fall, so changing stops or bridge rules does not need a
  resample.

The result: 286 stops, a median of 10.8 km apart and never more than 94 km; the costliest leg is about 200 minutes
of diesel. The browser bundle carries only each slice's ends and flags; full slices and legs are in
`world/dist/topology/chile-routed-links.json`.

Known quirks: the grid is a walk of 5 km moves, not a projection, so it crosses itself in 11 places (the first tile
to claim a square keeps it for terrain lookups and teleporting); and the route runs into Santiago's Alameda
terminus and back out, as the mapped track does.

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
lines through them, all stations as markers with the cities named, and source data on hover. Routed links the
corridor does not play are drawn around it on a geographic grid as context; links it plays are not drawn twice. Every track cell is a mouse
and keyboard teleport target; an exact-tile selector provides the same operation when a route is too narrow or
dense to click comfortably. Narrow maps are visually enlarged without changing their tile coordinates.
Teleporting while aboard moves `journey`, so the complete active consist moves;
teleporting on foot changes only `onFoot`, leaving the train's journey position alone. A trainless teleport creates
only the route context walking needs and never invents a boardable train. Station cells enter the actual railyard:
an on-foot player may inspect the yard and use its supplies, then return to the station track without moving the
remote consist. Boarding another train is disabled until the player returns, because only one off-yard consist can
currently be represented safely. The map is deliberately plain, and is
there to inspect compiled data rather than to be a player-facing map.

## Not done yet

- Only the Chilean main line is playable; Argentine, Peruvian and further links are not yet routed.
- Stations are not yet differentiated by size or status in gameplay: a closed halt generates the same kind of yard as
  a city.
- The larger South America graph remains non-navigable planning data pending reviewed rail geometry.
- Climate, rivers, obstacles, track condition and weather are not yet sourced into gameplay.

## Legacy generator

The old seeded fictional generator is no longer reachable through normal gameplay. Its internal helpers remain
temporarily in `source/worldmap.js` to reduce risk while old-save compatibility is audited; they are not a second
world mode and must not be used for new routes.
