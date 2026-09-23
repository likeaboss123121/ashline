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

## The continental network

The playable world is every mapped railway in South America, joined into one network on the shared grid. It is
built by `scripts/world/build-network.cjs` (`npm run world:network:south-america`) into
`world/network/south-america-network.json`, and replaced the Chilean main line as the world on 2026-09-23 at
Likea's request to keep spur lines and integrate the whole continent. The main line and the Padre Hurtado–Melipilla
pilot are still compiled but no longer played.

1. **Trace.** All 70,910 OSM railway ways in the 2026-09-21 South America extract, every lifecycle status, are
   traced across the grid squares they pass through. Two squares are joined where a line runs from one into the
   other, so junctions and branches are simply squares where lines meet, and a spur to a terminus is a line that
   ends. A move costs the track it covers, with a floor of most of the distance between the squares' middles.
2. **Join.** Separate pieces within 30 km of each other are joined by the shortest new line between them. The
   groups left are joined into one network by the shortest set of new lines (Borůvka's method), counting only
   groups with at least 15 km of track or an authored city; a city with no railway at all joins as a piece of its
   own. Lines over 10 km are laid over the terrain through towns, as in "Gap fills over the terrain" below.
3. **Keep one network.** Whatever is still apart from the network Punta Arenas stands on is left out (29 scraps,
   129 km). Unnamed dead ends shorter than 10 km (yard tracks, sidings, tracing stubs) are pruned.
4. **Stops.** One per square: an authored city, else a working station (larger EFE category first), a settlement on
   a new line, a working halt, a closed station. Every junction and every end of the line is a stop, named for its
   station or the nearest settlement, so the track between two stops is always one plain line: a leg. A section
   with no stop for more than 100 km gets halts, named for the nearest settlement within 15 km or for their distance
   from the section's first stop.
5. **Elevation.** Copernicus GLO-90 is resampled onto the grid projection itself in one pass (mean and root mean
   square per square, from which the relief follows), over the 741 tiles under the network.

The result: 21,043 squares, 6,755 stops and 7,186 legs; 128,169 km of mapped railway and 1,252 new lines totalling
19,534 km, the longest across the Darién to Panama City, through Patagonia, and through the Guianas and Amazonia. All
35 authored cities are stops, Puerto Montt at the end of its spur among them.

**In play.** `setup.realWorldPilot` builds the network's tiles, stations and legs when first asked (about 0.4 s in a
browser). Stations are numbered outward from Punta Arenas, a line at a time, so station 2 is the first stop up the
line and leg 2 runs on from it. Each station lists its lines (`getStationLines`): a leg, the station at its far end,
the heading, and which side of the yard it leaves from. The two lines that point most nearly opposite ways leave
from opposite ends of the yard and every other line from the end it runs closer to, so a station on a plain line
has one line each end however sharply it bends, and a junction offers a choice of lines from one end. A side with no
line has no lead, and a yard with one lead has every track run to it. Departing names each line by its heading and
destination; arriving uses the side the leg meets the station on.

The debug map draws the network only when its panel is open, as plain squares and one path of track, with a line
under the map naming the square under the pointer; the teleport list holds stations rather than squares.

## The Chilean main line

Likea approved all four Chile links, gap fills included, for play on 2026-09-22. The playable world is the
`cl-main-line` corridor in `world/authored/playable-corridors.json`, which lists the routed links it plays. Listing
a link there is the review decision; the proposal file itself never changes to `navigable: true`.
`scripts/world/build-routed-corridor.cjs` builds it at compile time:

- **One line.** The four links are joined end to end (the compiler refuses links that do not meet) into a single
  line from Punta Arenas to Arica: about 5,595 km as routed, of which 3,342 km is mapped rail.
- **Stops.** Each city the links join is a station. So is every named OSM station, working or closed, within 1 km
  of mapped track on the line (`world/imported/chile-stations.json`, 671 stations; metro and bus stations are left
  out), and every city, town or village within 3 km of a stretch of gap fill
  (`world/imported/south-america-places.json`, 52,661 settlements). Stops closer than 5 km are thinned: a city
  wins, then a working station (larger EFE category first), a settlement, a working halt, then a closed station.
- **Kilometre posts.** Where the line still runs more than 100 km with nowhere to stop, halts named `Km N` (distance
  from Punta Arenas along the routed line) are spaced evenly along it. Every yard keeps a reserve engine with fuel
  to reach the next stop, which a tank cannot promise over much longer stretches.
- **Tiles.** See "The geographic grid" below: 852 squares of the shared grid, each carrying its OSM ways, the
  routed slices it came from, rail and gap kilometres, and a `gapFill` flag the debug map shows on hover. A square
  is a bridge when it has at least 200 m of bridge and a tunnel when at least half of it is underground.
- **Spurs.** Where the line runs out to a terminus and back the same way, the out-and-back is left out of the
  moves: 247 km in all, at Puerto Montt, Santiago and Antofagasta. A stop that would then stand more than 20 km
  from where it really is, is dropped; a city dropped this way is recorded in `bypassedCities`. That is Puerto
  Montt: the line from Patagonia comes over the Andes and reaches the railway near Osorno, 60 km north of it.
- **Elevation.** `npm run world:elevation:chile:main` fetches the Copernicus GLO-90 tiles the line crosses and
  samples each square. The compiler rejects stale samples by build ID; the ID covers only what decides where the
  squares fall, so changing stops or bridge rules does not need a resample.

The result: 282 stops, 5,348 km of moves, and no stretch between stops longer than about 100 km; the costliest leg
is about 160 minutes of diesel. The browser bundle carries only each square's position, move length and flags;
full slices and legs are in `world/dist/topology/chile-routed-links.json`.

## The geographic grid

Routed corridors are laid on one shared grid of 5 km squares (`scripts/world/projection.cjs`): a Lambert
azimuthal equal-area projection centred on South America (60°W, 20°S), shifted so Punta Arenas is square (0, 0).
Every square covers the same area of ground, shapes bend by no more than about a tenth across the continent, and
because every corridor uses the same grid, separately built lines meet where the real railways meet.

A corridor's tiles are the squares its line passes through, in order. The line is followed in steps of an eighth
of a square; a loop back into a square already crossed is folded into that square when it is short (a switchback
or spiral, up to 15 km) and cut when it is long (a spur, above); a square that only clips the corner between two
diagonal neighbours is folded into them, so diagonal track runs straight rather than in stair steps. Each square
touches the next, none repeats, and no drift builds up along the line: a tile's grid position is where it really is.

A move costs the track it covers: half the track in each of the two squares. That is 5 km on a straight run,
about 7 km diagonally, and more where the line winds; driving time, fuel and walking time scale with it
(`setup.worldmap.getStepKm`). Grade is the difference between the two squares' mean elevations over that distance.

This replaced the earlier layout, in which every 5 km slice of track was one step in one of eight directions. That
kept moves at exactly 5 km but drifted from real geography wherever the line wound: by Arica the line stood about
500 km north of the city. The Padre Hurtado–Melipilla pilot still uses that layout.

## Gap fills over the terrain

A gap fill longer than 10 km is not a straight line. `scripts/world/terrain-path.cjs` plans it the way a railway
would be planned: first which settlements it serves, then how it gets between them.

1. The area around the gap is resampled from Copernicus GLO-90 into cells of about 2 km, keeping each cell's mean
   elevation and roughness (the spread of heights within it). Open sea, and lakes (which the elevation model draws
   perfectly flat), are water.
2. Every city, town and village in the area is a candidate stop. A hop between two is estimated from the ground
   under the straight line between them; a hop into a settlement is 25% (city), 15% (town) or 8% (village) cheaper;
   no hop may exceed 250 km. The cheapest chain from one end of the gap to the other is chosen. The discount is a
   share, not a fixed bonus, so a string of villages is never cheaper than the ground between them.
3. Between consecutive stops, the cheapest path over the cells is the line: a kilometre costs 1, a 2% grade doubles
   that and steeper grades cost with the square of the grade, rough ground and ground above 2,500 m cost more, and
   water costs thirty times as much.

Resampled areas are cached beside the elevation tiles, so rerouting takes seconds. Set `ASHLINE_DEM_CACHE` to keep
the tile cache somewhere durable; the default is the system temporary directory.

The Patagonian gap is now 2,071 km through 23 settlements instead of 1,306 km in a straight line over the ice
fields: up the Atlantic side through Puerto Santa Cruz, Puerto San Julián and Pico Truncado, inland by Las Heras,
Río Mayo and Gobernador Costa to Bariloche, over the Andes by Villa La Angostura, and down to the Chilean railway
near Osorno. The Iquique–Arica gap runs 166 km instead of 121. The Chile routing only knows Chilean track, so near
Bariloche the new line runs beside Argentina's existing railway rather than on it; routing the main line over the
continental network would fix that. The continental proposals do not yet follow the terrain.

## Static world data is never saved

Compiled rail cells and station records live in `setup`, not `State.variables`. Saves contain only stable route
positions and mutable state such as the active consist, parked trains and looted supplies. This keeps save size
independent of map size and lets a world-data migration translate old position identifiers explicitly.

## Coordinates and legs

Tiles use whole-number display coordinates, `x` east and `y` north. A **leg** is the sourced run between two real
stations. `getLeg(seed, legIndex)`, `getStationTile(seed, stationId)` and railyard headings all delegate to the
compiled corridor, so the debug grid, travel controls and yard leads describe the same topology. Leg lengths are
determined by station placement.

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

- A yard has two throats, so a three-way junction puts two lines on one side: a train coming off one of them and
  leaving by the other backs through the yard.
- Stations are not yet differentiated by size or status in gameplay: a closed halt, a junction and a city generate the
  same kind of yard.
- Halt and junction names are generated (`Km 74 from El Turbio`, or the nearest settlement) and are for Likea to
  review.
- Panama and Central America are outside the extract: Panama City is reached by a new line across the Darién.
- Climate, rivers, obstacles, track condition and weather are not yet sourced into gameplay.

## Legacy generator

The old seeded fictional generator is no longer reachable through normal gameplay. Its internal helpers remain
temporarily in `source/worldmap.js` to reduce risk while old-save compatibility is audited; they are not a second
world mode and must not be used for new routes.
