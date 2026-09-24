# The world map

## v0.3 worldwide graph

The world is compiled offline from geographic sources. `world/` holds the normalized inputs, the authored places and
corridors, and the schema; `scripts/world/compile-world.cjs` compiles them into `world/dist/` and into
`source/world-data.js`, which the single-file game embeds. Static world data always lives in `setup`; saves keep only
a station number and a journey position. Run `npm run world:build` to regenerate the outputs and
`npm run world:check` to verify them. `npm run world:benchmark` reports their sizes and the game's build time.

There are two layers:

- **The playable network** (below): every mapped railway in South America on a shared grid of 5 km squares, joined
  into one. This is the world. The runtime is `setup.realWorldPilot` (`source/world-pilot.js`) and the tiles are read
  through `setup.worldmap` (`source/worldmap.js`).
- **The planning corridors**: 35 GeoNames cities and three authored Punta Arenas–Panama corridors, 40 geodesic
  chords marked `navigable: false`. `scripts/world/route-planning-links.cjs` routes each over the continent's mapped
  rail (`npm run world:route:south-america`) into `world/proposals/south-america-routed-links.json`, repairing
  digitizing breaks under 50 m and proposing gap joins where the networks break. The debug overview draws the chords
  with their routes over them, mapped rail solid and gap fills dashed, for comparison with the network. They are
  never played.

For elevation, Copernicus GLO-90 is aggregated over each 5 km square: the mean is the square's elevation, and the
population standard deviation within it is its relief; 120 m of relief separates plains from mountain, so a high,
flat plateau stays plains. Bridges and tunnels from OSM override that: a square is a bridge with at least 200 m of
bridge in it, a tunnel when at least half its track is underground. Raw rasters stay outside the repository; only the
aggregates are compiled.

## The network

The playable world is every mapped railway in South America, joined into one network. It is built by
`scripts/world/build-network.cjs` (`npm run world:network:south-america`) into
`world/network/south-america-network.json`. It became the world on 2026-09-23, at Likea's request to keep spur lines
and integrate the whole continent, replacing a single Chilean main line.

1. **Trace.** All 70,910 OSM railway ways in the 2026-09-21 South America extract, every lifecycle status, are
   traced across the grid squares they pass through. Two squares are joined where a line runs from one into the
   other, so junctions and branches are simply squares where lines meet, and a spur to a terminus is a line that
   ends. A move costs the track it covers, with a floor of most of the distance between the squares' middles.
2. **Join separate pieces.** Pieces within 30 km of each other are joined by the shortest new line between them. The
   groups left are joined into one network by the shortest set of new lines (Borůvka's method), counting only
   groups with at least 15 km of track or an authored city; a city with no railway at all joins as a piece of its
   own. Whatever is still apart from the network Punta Arenas stands on is left out (29 scraps, 129 km).
Then new lines are added by rules, each standing for a reason a person would give for a line, so the same situation
is handled wherever it comes up on the map rather than by hand each time. Likea's hand-made changes to the South
American network were turned into these rules (September 2026); a route is only authored where no rule catches it.

3. **Authored routes.** `world/authored/network-joins.json` lists lines to lay by hand. Each is a list of stops, the
   first and last within 10 km of the network, and new track is laid over the terrain from each stop to the next.
   A stop is a place name (case and accents do not matter), `[longitude, latitude]`, or
   `{ "name": ..., "near": [longitude, latitude] }` when several places share a name; a bare name takes the largest
   place of that name, and the build stops and lists them when two of the same size are far apart. Listing the towns
   along a river or a highway steers a line along it. Three routes are laid: Bariloche over the Cardenal Samoré pass
   to the Chilean main line at Osorno; Porto Velho down the Madeira to Manaus; and Manaus up the Amazon to Leticia,
   then by Puerto Leguízamo and Florencia to Neiva, a direct way through the middle of the continent.
4. **Stub joins.** A line that ends within 25 km of other track it can only reach the long way round (at least four
   times as far along the track, and more than 60 km) is joined to it. That catches mapping breaks, lifted junctions
   and branches stopping just short of a main line or a new line, and never loops a branch back onto the line it has
   just left. Joins are accepted shortest first, each checked against the network with the ones before it, so two
   line ends that reach for each other, or a pair of joins that would close a small loop, make one join.
5. **Facing ends.** Two line ends more than 25 km and up to 600 km apart are joined when going round by track is at least eight times as
   far and 800 km further. Two lines that both stop short of each other are a railway never finished or since
   lifted: across the Andes, over a border, along a coast. Ends only, so no long new line runs into the side of a
   line that already serves the area. A join is not made if the line found over the terrain crosses more than 3 km of
   open water (an estuary or a strait rather than a river), and joins are accepted shortest first, each end once and
   each checked against those before it. This is what joins Lonquimay to Los Catutos (another way into Chile early
   in the game), Jazpampa to Arica (cutting a detour of well over 500 km) and Trujillo to El Cisne (the Pacific
   corridor unbroken to Panama).
6. **Spurs.** A rural line with no junction, line end or other spur for 100 km along it sends a spur out to the
   biggest place 8–40 km off it: a town, a village, or one of OSM's hamlets, farms and isolated dwellings (the
   estancias, mine camps and small ports, extracted with `npm run world:extract:south-america:outposts`). A long
   empty line gives a player nowhere to explore; real ones had branches like these. A name shared by more than 20
   places ("Estancia", "Puesto") is skipped, and so is a spur over open water. This is what puts extra spurs along
   the tutorial stretch from Punta Arenas to General Nicolás H. Palacios.
7. **Cities.** A big city's railways, mapped in full, are a maze: on 5 km squares its suburban lines cross every few
   squares, every crossing is a junction, and every junction is a stop and a railyard. Each connected area of urban
   track (see Regions, below) is reduced to a hub, the authored city there or else its most crowded square, and the
   shortest way to it from every point where a line enters the area; the rest of the track inside is taken up.
   Every line into a city still reaches every other through the hub. Likea chose this over junctions without yards
   (September 2026) to keep the cities simple.
8. **Prune and stop.** Unnamed dead ends shorter than 10 km (yard tracks, sidings, tracing stubs) are pruned. Stops
   are one per square: an authored city, else a working station (larger EFE category first), a settlement on a new
   line, a working halt, a closed station. Every junction and every end of the line is a stop, named for its station
   or the nearest settlement, so the track between two stops is always one plain line: a leg. A section with no stop
   for more than 100 km gets halts, named for the nearest settlement within 15 km or for their distance from the
   section's first stop.
9. **Regions and railyards.** Every stop is given a region. **Urban** is where 500,000 people live within 20 km;
   **industrial** is where, without those people, 60 km of mapped track lies within 10 km (mines, ports, works);
   **rural** is the rest. Every stop is a railyard in the game, and in a city OSM maps a station every kilometre or
   two, which made Buenos Aires over 70 km of yards end to end. So, besides junctions, line ends and the authored
   cities (always stops), an urban station only gets a yard if the place it serves has 100,000 people and no other
   yard is within 40 km along the track; an industrial one needs 20 km from the next; a rural one is kept as before.
   The game sizes yards by region (`setup.railyard.YARD_SIZE_BY_REGION`): two or three short tracks in the country,
   three to five in industrial areas, four or five long ones in the cities. The art tops out at five tracks, so a
   city yard is as large as a yard can currently be drawn.
10. **Elevation.** Copernicus GLO-90 is resampled onto the grid projection itself in one pass (mean and root mean
   square per square, from which the relief follows), over the 742 tiles under the network.

Every new line longer than 10 km, from any of the joins, is laid over the terrain through towns (below).

The result: 22,600 squares and 6,528 stops (6,072 rural, 296 industrial, 160 urban; 478 stations in cities and works
districts left without a yard, and 380 squares of city track taken up across 123 urban areas); 126,278 km of mapped
railway and 1,706 new lines totalling 32,533 km: 1,207 short joins (7,367 km), 45 long ones (12,178 km, the longest
across the Darién to Panama City, through Patagonia, and through the Guianas and Amazonia), 304 stub joins
(3,606 km), 11 facing-end joins (2,518 km), 136 spurs (3,030 km) and 3 authored routes (3,833 km). All 35 authored
cities are stops, Puerto Montt at the end of its spur among them. Within 60 km of Buenos Aires there are 29 stops,
down from 136 before regions and hubs.
A full rebuild takes about eight minutes once the elevation tiles are cached.

**In play.** `setup.realWorldPilot` builds the network's tiles, stations and legs when first asked (about 0.4 s in a
browser). Stations are numbered outward from Punta Arenas, a line at a time, so station 2 is the first stop up the
line and leg 2 runs on from it. Each station lists its lines (`getStationLines`): a leg, the station at its far end,
the heading, and which side of the yard it leaves from. The two lines that point most nearly opposite ways leave
from opposite ends of the yard and every other line from the end it runs closer to, so a station on a plain line
has one line each end however sharply it bends, and a junction offers a choice of lines from one end. A side with no
line has no lead, and a yard with one lead has every track run to it. Departing names each line by its heading and
destination; arriving uses the side the leg meets the station on.

The debug map draws the network only when its panel is open, as plain squares and one path of track, with a line
under the map naming the square under the pointer; the teleport list holds stations rather than squares. Zoom and
pan buttons sit above it, the pan arrows in a diamond.

## The geographic grid

The network lies on one grid of 5 km squares (`scripts/world/projection.cjs`): a Lambert azimuthal equal-area
projection centred on South America (60°W, 20°S), shifted so Punta Arenas is square (0, 0). Every square covers the
same area of ground and shapes bend by no more than about a tenth across the continent, so a tile's grid position is
where it really is. The browser repeats the inverse formulas (`setup.worldmap.unprojectGrid`) to place each square.

A line is followed across the grid in steps of an eighth of a square. A square that only clips the corner between
two diagonal neighbours is folded into them, so diagonal track runs straight rather than in stair steps. A move
costs the track it covers: about 5 km on a straight run, 7 diagonally, more where the line winds; driving time,
fuel and walking time scale with it (`setup.worldmap.getStepKm`). Grade is the difference between the two squares'
mean elevations over that distance.

This replaced a layout in which every 5 km slice of track was one step in one of eight directions. That kept moves at
exactly 5 km but drifted from real geography wherever the line wound: by Arica, about 500 km north of the city.

## New lines over the terrain

A new line longer than 10 km is not a straight line. `scripts/world/terrain-path.cjs` plans it the way a railway
would be planned: first which settlements it serves, then how it gets between them.

1. The area around it is resampled from Copernicus GLO-90 into cells of about 2 km, keeping each cell's mean
   elevation and roughness. Open sea, and lakes (which the elevation model draws perfectly flat), are water.
2. Every city, town and village in the area (`world/imported/south-america-places.json`, 52,661 settlements from
   OSM) is a candidate stop. A hop between two is estimated from the ground under the straight line between them; a
   hop into a settlement is 25% (city), 15% (town) or 8% (village) cheaper; no hop may exceed 250 km. The cheapest
   chain from one end to the other is chosen. The discount is a share, not a fixed bonus, so a string of villages is
   never cheaper than the ground between them.
3. Between consecutive stops, the cheapest path over the cells is the line: a kilometre costs 1, a 2% grade doubles
   that and steeper grades cost with the square of the grade, rough ground and ground above 2,500 m cost more, and
   water costs thirty times as much.

Resampled areas are cached beside the elevation tiles, so rebuilding takes minutes rather than the hour the first
build takes. Set `ASHLINE_DEM_CACHE` to keep the tile cache somewhere durable; the default is the system temporary
directory.

## Static world data is never saved

Compiled rail cells and station records live in `setup`, not `State.variables`. Saves contain only stable route
positions and mutable state such as the active consist, parked trains and looted supplies. This keeps save size
independent of map size and lets a world-data migration translate old position identifiers explicitly.

## Coordinates and legs

Tiles use whole-number grid coordinates, `x` east and `y` north. A **leg** is the plain run of track between two
stops. `getLeg(seed, legIndex)`, `getStationTile(seed, stationId)` and railyard headings all delegate to the
network, so the debug map, travel controls and yard leads describe the same topology.

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

Shapes are derived from connected ends, so a junction square draws as a junction from whichever leg it is met on.

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

`appendDebugMap(parent, stationId)` draws the network once its panel is open: terrain as coloured cells, mapped
track and new lines as two paths, every station as a marker with the cities named, and a readout of the square under
the pointer. 300 km of empty ground surrounds the network so no line sits at the edge. Only what is in view, and a
screen's worth around it, is drawn, and it is redrawn as the map scrolls and zooms; zoomed out below 3 px a square,
the cells and station markers are left out and the two track paths are the map. Every track cell is a teleport target by mouse; the station list is the keyboard way to teleport.
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
- The balance between time on the line and time in yards is not settled; Likea expects to revisit it after 0.3.0.
- Yards differ by region in size only: a closed halt and a working station in the same region generate the same kind
  of yard.
- Halt and junction names are generated (`Km 74 from El Turbio`, or the nearest settlement) and are for Likea to
  review.
- Panama and Central America are outside the extract: Panama City is reached by a new line across the Darién.
- Climate, rivers, obstacles, track condition and weather are not yet sourced into gameplay.

## Legacy generator

The old seeded fictional generator is no longer reachable through normal gameplay. Its internal helpers remain
temporarily in `source/worldmap.js` to reduce risk while old-save compatibility is audited; they are not a second
world mode and must not be used for new routes.
