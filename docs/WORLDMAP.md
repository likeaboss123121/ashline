# The world map

## v0.3 worldwide graph

The world is compiled offline from geographic sources. `world/` holds the normalized inputs, the authored places and
corridors, and the schema; `scripts/world/compile-world.cjs` compiles them into `world/dist/` and into
`source/world-data.js`, which the single-file game embeds. Static world data always lives in `setup`; saves keep only
a station number and a journey position. Run `npm run world:build` to regenerate the outputs and
`npm run world:check` to verify them. `npm run world:benchmark` reports their sizes and the game's build time.

There are two layers:

- **The playable network** (below): every mapped railway of the Americas, and of Europe, Asia and Africa, each on a
  grid of 5 km squares of its own, joined into one at Wales, Alaska, where the Bering Strait tunnel comes ashore. This
  is the world, from Punta Arenas to Cape Town. The runtime is `setup.realWorldPilot` (`source/world-pilot.js`) and
  the tiles are read through `setup.worldmap` (`source/worldmap.js`).
- **The planning corridors**: 35 GeoNames cities and three authored Punta Arenas–Panama corridors, 40 geodesic
  chords marked `navigable: false`. `scripts/world/route-planning-links.cjs` routes each over the continent's mapped
  rail (`npm run world:route:south-america`) into `world/proposals/south-america-routed-links.json`, repairing
  digitizing breaks under 50 m and proposing gap joins where the networks break. They are a pipeline product only,
  written to `world/dist`: the game ships just the network and the data credits (`source/world-data.js`), and they
  are never played.

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
   **Shortcuts.** Two places of 100,000 people or more, up to 400 km apart and each within 10 km of track, are joined
   when going round by track is at least four times as far and 500 km further: Medellín to Apartadó, 216 km apart
   and 1,250 km round. Accepted shortest first, each checked against those before it, so one shortcut serves a
   cluster of towns.
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
8. **Parallel lines.** A stretch of line between two junctions is taken up where another way between the same two
   junctions is no more than twice as long plus 40 km: two lines side by side, or a loop that saves little. The
   least used goes first (new lines, then abandoned, disused and working track, and fewer stations first), and the
   authored routes and the cities' squares stay. Around Buenos Aires, where the Pampas lines run side by side,
   this is most of the thinning.
9. **Stops and railyards.** Candidates are one per square: an authored city, else a working station (larger EFE
   category first), a settlement on a new line, a working halt and a closed station. **Every dead end leads to a
   station** (Likea, September 2026): a line whose end has no station is taken up back to the last station on it, or
   to the junction it leaves, and again once the yards are chosen, so there are no buffers and no stops invented at
   bare line ends. **A railyard has two ends and one line at each, and is straight** (Likea, September 2026: the yard
   is drawn straight and the interface does not handle curves), so a stop stands only where the line runs straight
   through a square, its two lines leaving in exactly opposite directions, or where a line ends. A station on a
   junction or a bend moves along the line to the nearest straight square within 4 squares (12 in a hard region),
   nearest the station itself, or has no yard. Every stop gets a
   region. **Urban** is where 500,000 people live within 20 km; **industrial** is where, without those people,
   60 km of mapped track lies within 10 km (mines, ports, works); **rural** is the rest. Then which stops get a
   railyard: the authored cities always, then the busiest place first, each only if the place it serves is big
   enough for its region (100,000 people in a city), no yard already kept is too close along the track (40 km in a
   city, 20 km in an industrial area, and in the country 15 km where under 150,000 people live within 50 km, 25 km up
   to a million, 35 km beyond; none in a hard region, where every real town keeps its yard), and **no yard stands in
   a square touching another**, the busier place keeping it. Likea wanted the world's 33,000 stops brought down to
   about 20,000 (September 2026); these spacings and the parallel-line rule do most of that. A section with no stop
   for more than 100 km gets halts on straight squares, named for the nearest settlement within 15 km or for their
   distance from the section's first stop, never beside a yard. The compiler refuses a network where a stop has more
   than two lines or stands on a bend, a line ends with no station, or two stops touch.

   **Fewer stations and railways** (Likea, September 2026: about 5,000 stations and a like cut in the railways,
   keeping the key corridors and plenty of alternative routes). Two rules in the stops stage:
   - *Population against rail density.* A station keeps its yard only if the place it serves has 80 people for every
     kilometre of track within 50 km (`STATION_PEOPLE_PER_TRACK_KM`, `trackDensity`): a sizeable town where the rails
     are dense, a village where they are sparse. Cities, authored route ends and every real town in a hard region
     stay.
   - *Only the track that joins the stations up* (`thinTrack`). From each station, the shortest ways by track to its
     two nearest stations are kept; pieces left apart are joined to the start's by their shortest way; the authored
     routes and cities stay. Then real alternatives go back in: a way over the track not kept, between two kept
     squares, where going round by the kept track would be more than twice as far plus 100 km
     (`ALTERNATIVE_FACTOR`, `ALTERNATIVE_EXTRA_KM`) — a loop through other country or a cut-off, not a line beside
     another. Everything else is taken up, and dead ends to no station after it.
   Halts come every 200 km of line with no stop (`MAX_SECTION_KM`), and only at a real place: a town or village
   within 15 km of the line, or where there is none a named hamlet, farm or estancia (the outposts beside the track,
   generic names such as a bare "Estancia" left out). Likea did not want invented stops such as "Km 123 from ...", so
   a stretch with no named place near it has no stop at all; the longest are in the hard regions and the Chinese
   deserts. Result: 4,473 stops worldwide (20,597 before),
   111,798 squares (196,217 before) and 673 independent loops, each a real alternative route; the page is 8.7 MiB.

   The game sizes yards by region (`setup.railyard.YARD_SIZE_BY_REGION`): two or three short tracks in the country,
   three to five in industrial areas, four or five long ones in the cities.
10. **Elevation.** Copernicus GLO-90 is resampled onto the grid projection itself in one pass (mean and root mean
   square per square, from which the relief follows), over the 742 tiles under the network.

Every new line longer than 10 km, from any of the joins, is laid over the terrain through towns (below). **No new line
duplicates track already there**: wherever a planned line comes within a square of existing track for 8 km or more,
it joins that track and leaves it again further on, rather than running beside it, provided the existing track gets
between the two points in no more than 1.5 times the distance plus 10 km. The bridge records keep what was planned
and the parts laid (`segments`, `onExistingTrackKm`).

The result: 20,845 squares, 3,496 stops (3,351 rural, 82 industrial, 63 urban), 1,105 junctions and 119 buffers
out on the line; 114,413 km of mapped railway kept (401 parallel stretches, 12,539 km, taken up) and 1,708 new lines
totalling 32,177 km: 1,207 short joins (7,213 km), 45 long ones (11,576 km, the longest across the Darién to Panama
City, through Patagonia, and through the Guianas and Amazonia), 303 stub joins (2,875 km), 11 facing-end joins
(2,384 km), 8 shortcuts (1,789 km), 131 spurs (2,567 km) and 3 authored routes (3,773 km); 2,485 km of planned new
line was laid onto existing track instead. All 35 authored cities are stops, Puerto Montt at the end of its spur
among them. Within 500 km of Buenos Aires there are 742 stops (1,561 before), and 5 within 60 km.
A full rebuild takes about five minutes once the elevation tiles are cached, and seconds when only where stops go
has changed: the build keeps a checkpoint after each slow stage (see world/README.md, Running a build safely). The
Americas take about 15 minutes from scratch once terrain routes and elevation are cached (the first elevation pass
adds 10), and a minute and a half to redo the stops.

**In play.** `setup.realWorldPilot` builds the network's tiles, stations and legs when first asked (about 0.4 s in a
browser). The nodes are stations, junctions and buffers; a leg is the plain line between two of them. Stations are
numbered outward from Punta Arenas, a line at a time, passing through junctions, so station 2 is the first station
up the line. Each station lists its lines (`getStationLines`), at most one out of each end of the yard: a leg, the
node at its far end, the heading, and the side. Departing names each line by its heading and where it leads, a
station or "the junction near" a place. Out on the line, a train that reaches a junction stops there and the
driver picks one of the other lines (`getJunctionChoices`, offered through `getBranchChoices`); taking one is a
step along it. A walker picks the same way. At a buffer the line simply ends. `getStationsNear` finds the nearest
stations by track through junctions, for supplies and recovery.

**Yards apart from squares** (`source/yards.js`, `setup.yards`; Likea, 2026-09-30). A square can hold any number of
railyards, and reaching one does not put the train in it: the train stops on the line on that square, and the
player chooses to enter a yard there (`setup.yards.at`, `enter`), drive on, or reverse. Facing into a station, the
ways on through it are the lines leaving the far end of its yard (`getJunctionChoices` treats a station like a
junction for this); a walker can go through either way. A station's yard keeps its number as its id, the key its
tracks are saved under. Out on the line, about one straight, plain square in ten (not bridges or tunnels) has a
siding, placed from the run's seed: an empty road beside the running line, whose two leads are the line itself
either way, with the id `siding:x,y`. A siding is a yard like any other: entered from the line, shunted in, and
left along its leg from where it stands (its lines carry the `tileIndex` a departure starts at). Tracks of every
kind of yard are kept in `$stationTracks` under the yard's id, and `$currentStation` holds the id of the yard the
player is in. More kinds of station will use the same registry.

**Trains left on the line.** A player who walks off and boards another train, in a yard or by climbing aboard one
left on the line, leaves their consist standing where it was: `$lineTrains`, keyed by its square `x,y`, with its leg,
position and which way it points (`frontAlongLeg`). It blocks the line. A train that drives, reverses or departs onto
its square couples to it with whichever end is leading, by the same rule as coupling in a yard, and a train that
meets it end-first turns it end for end with every car in it. A train put into a siding is in a yard and blocks
nothing. For now a train left on the line stays as it was left (its firebox burns on, as in a yard), and the globe
does not show it.

**Finding the way** (`source/wayfinding.js`, `setup.wayfinding`). A station at the end of a line, with one line out
of its yard, has a building with a map of the railways within 150 km and the nearest stations by track: a reason to
go down a branch. Its art is still to come; for now the railyard has a "Station map" section with a plain drawing.
At a junction out on the line a signpost gives, for each way out, the next two stations that way (halts left out)
and the first city beyond them, with the distance to each by track, driving or on foot. Both are worked out from the
compiled network when shown. The list of stations whose maps have been seen (`$seenMaps`) is the one thing saved, by
each station's stable id (its OSM node, authored place or halt square) rather than its number, which changes when
the network is rebuilt. Punta Arenas is the end of a line, so its map is the first one seen.

Both maps are drawn from where things really are, not from the build grids, which are stretched up to about 1.6 to 1
far from their centres and, in Europe, Asia and Africa, turned: north is always up. The **station map** is flat (an
azimuthal equidistant projection about the station), with land and water, the track, the stations named where the
names fit without overlapping (cities first), a scale bar, a north arrow, and fog beyond its 150 km.

The **Map** tab in the sidebar is a globe (`source/globe.js`, `setup.globe`) the player can turn by dragging and zoom
with the wheel, a pinch or its buttons; it opens on the player. Where the player is must always be clear (Likea): a red
mark that pulses, named, and when it is off the view or round the back of the globe, an arrow at the edge pointing the
way to it (a click on the arrow centres the map on it). Stations the player has been to are solid, those they only
know of from a map hollow; a known line that runs on into the fog is drawn a few squares further, dashed and fading,
so the player can see where the lines lead; a legend under the globe says what each mark means. The globe is drawn
on one canvas and the marks on another over it, so the pulse redraws only the marks. The land is drawn everywhere, shaded by its relief, from
a 2048 by 1024 texture baked from Natural Earth's shaded relief (`scripts/world/globe-texture.cjs`, committed as
`world/external/globe-texture.png`), with coastlines from a finer land and water layer (about 5 km) so they stay
sharp close in. The track, stations and names are drawn only where the player knows them, under fog of war elsewhere:
150 km round every station map read, and 50 km round every station visited (the journal) and where they are now. The
globe stops zooming in at about 1.2 pixels a kilometre; closer detail is the station maps' job.

The debug map draws the network only when its panel is open, as plain squares and one path of track, with a line
under the map naming the square under the pointer; the teleport list holds stations rather than squares. Zoom and
pan buttons sit above it, the pan arrows in a diamond.

## The Americas

The world was extended from South America to the Americas in September 2026, as a first look at how the game
works across continents, and to reach Wales, Alaska, where the Bering Strait crossing to Asia will start.

- **Data.** Geofabrik's regional extracts, fetched and filtered one at a time (`scripts/world/fetch-osm-regions.cjs`)
  and merged. Yard, siding and crossover tracks are left out of the rail import and lines are simplified to about
  30 m: North America maps its yards in their hundreds of thousands, and they fall inside the squares of the lines
  they serve. Each script takes `--scope south-america` or `--scope americas` (`scripts/world/scopes.cjs`).
- **Grid.** One Lambert equal-area grid centred at 102.5°W, 10°N, the centre that keeps the worst stretch lowest
  over both continents' railways: about 1.5 to 1 at Punta Arenas, Recife and Wales. Punta Arenas is still square
  (0, 0). Far from the centre grid north is not true north (tens of degrees off in Alaska), so directions are named
  from the true bearing of a step (`setup.worldmap.describeDirection(index, tile)`).
- **Rules added for two continents.** A join whose line would cross more than 3 km of open water is not laid, and
  the joins are tried again in passes without it: islands with railways (Cuba, Vancouver Island, Newfoundland's
  remnants) are left out. A long join is only worth laying to a piece in proportion to its built track (at most five
  times its length, never under 300 km, judged by the smaller piece; proposed and planned lines do not count), so a
  scrap of track in the Arctic is not joined by a thousand kilometres of new line, unless it serves an authored
  city. Authored routes are laid before the automatic joins, since each is a join chosen by hand. Halts are placed
  so that no square outside a hard region is more than 50 km from a stop by track, junctions or not.
- **Hard regions** (`world/authored/regions.json`). Alaska and the Yukon are Ashline's first really hard section
  (Likea): the builder invents no stops there, no halts, no spurs, no stops at bare line ends, and on new lines only
  towns and cities. The only way from the continental network to Wales is through Alaska: Fairbanks down the
  Alaska Railroad to Palmer, 993 km with no stop to the Haines Highway, the White Pass line, then British Columbia;
  and from Fairbanks the authored route to Wales, 1,256 km from Healy to Nome with no stop, then Nome to Wales.
  No locomotive does that on one tank: the player has to carry fuel.
- **Result** (after the September 2026 thinning below: stations on straight track, dead ends taken up, fewer parallel
  lines and wider yard spacing): 65,069 squares and 5,442 stops (1,352 halts), 3,195 junctions and no buffers.
- **Result before the thinning.** 89,583 squares and 8,736 stops (1,653 halts), 7,747 junctions and 420 buffers; 622,773 km of mapped
  railway kept and 135,390 km of new line; Punta Arenas to Wales is 25,468 km by track. The game's world data is
  4.2 MB, the page 5.6 MB, and the network is built in the browser in about 1.7 s on this server.

## Europe, Asia and Africa

The rest of the world was built in September 2026: every mapped railway in Europe, Asia and Africa, joined to the
Americas by a tunnel under the Bering Strait, so one railway runs from Punta Arenas to Cape Town. Likea's decisions
(recorded in DESIGN.md): the strait is crossed by a tunnel by the Diomedes; the hard section runs on from Wales across
Chukotka and Yakutia to the first real railway at Nizhny Bestyakh; Sakhalin gets a branch from Komsomolsk-on-Amur and
Japan a tunnel from Sakhalin to Hokkaido; other islands stay unconnected unless Likea asks; and the whole world stays
embedded in the single-file game.

- **Data.** Geofabrik's `europe`, `asia`, `russia` and `africa` extracts (`npm run world:fetch:afro-eurasia`), filtered
  and merged as for the Americas, then extracted with `--scope afro-eurasia`. Names are given in the Latin alphabet
  (`scripts/world/names.cjs`): the local name where it is already Latin (München, Warszawa, as the Americas are named),
  else `name:en`, `int_name` or an official romanisation (pinyin, Japanese and Korean romaji), else a transliteration
  by `any-ascii`, which reads well for Cyrillic and Greek and less well for scripts that leave vowels unwritten. The
  extractors count where the names came from (`stats.nameSources` in each import). The authored cities are 47 from
  GeoNames (`world/authored/afro-eurasia-places.csv`), Cape Town first: the network kept is the one it stands on.
  Yakutsk is not among them: its railway ends across the Lena at Nizhny Bestyakh.
- **A grid of its own.** One projection cannot hold the whole world: squares stretch without limit towards the far
  side of the globe from its centre. Europe, Asia and Africa have their own Lambert equal-area grid, centred at 40°E,
  37.5°N, the centre that keeps the worst stretch lowest over their railways, about 1.6 to 1 at Wales, Cape Town and
  Kagoshima: no worse than the Americas'. Its origin is Wales, Alaska, square (0, 0).
- **The join.** `world/imports.json` lists both networks; the second has `joinAt`, a point where both have a stop
  (Wales), and `turn`. The compiler (`joinNetworks`) turns the second grid by that many quarter turns about Wales and
  moves it so its Wales lands on the Americas' Wales, and that square becomes one station with a line each way. Seen
  from Wales both continents lie to the south on their own grids, so without the half turn they would lie on each
  other; turned, Asia lies north of the Americas' squares and they touch only at Wales. Every move is still to a
  neighbouring square, so the game walks the join like any other track. The compiled network carries `charts`: which
  run of squares is on which grid, with its offset and turn, so `setup.worldmap.gridFor(tile)` and `unprojectGrid`
  find any square's place. Grid north on the turned grid points roughly south in Europe and Africa: directions are named
  from true bearings, as in Alaska, and the player's maps are drawn from latitude and longitude, north up. The debug
  map draws the grid as it is.
- **The 180th meridian.** Chukotka lies across it. Every longitude is kept in its grid's frame, within 180 degrees of
  the grid's centre (`projection.inFrame`), so on Asia's grid Uelen is at 190°E rather than 170°W and a line from
  Anadyr to Egvekinot is not drawn the long way round the world. Elevation tiles beyond the meridian are moved into the
  frame when a box crosses it (`dem.tilesInFrame`). Hard regions are drawn in their builds' frames too.
- **Authored routes** (`world/authored/network-joins.json`). A stop can be a named point (`{ "name", "coordinates" }`)
  and can be reached through a tunnel (`"tunnel": true`): straight from the stop before, under the sea if need be, the
  squares on the way marked as tunnels, which the rule against lines over open water would otherwise refuse.
  - Nizhny Bestyakh by Khandyga, Ust-Nera, Zyryanka, Bilibino, Anadyr, Egvekinot and Lavrentiya to Uelen, then under the
    strait by Big and Little Diomede to Wales.
  - Komsomolsk-on-Amur by Selikhin to Cape Lazarev, under the Nevelskoy Strait to Pogibi, and across Sakhalin to Nysh.
  - Gornozavodsk at the south end of the Sakhalin railway to Cape Crillon, under La Pérouse Strait to Cape Sōya, and
    on to Wakkanai.
  - Gabès along the Libyan coast by Tripoli, Misrata and Sirte, round the Gulf of Sidra by Ajdabiya to Benghazi, and
    by Bayda and Darnah to the old line at Ain al-Ghazala that runs on to Egypt. Libya has no working railway, and the
    automatic joins try the shortest way, straight over the gulf, and refuse it for crossing open water; the terrain
    router only searches near the straight line, so it never goes round. Without this the Maghreb, Algiers and
    Casablanca among it, was left out. A rule that tried a refused join again in a wider box would catch cases like it.
- **Hard region.** `yakutia-chukotka`: north of 58° and east of 130.05°E, to the tunnel. No halts, spurs or stops at
  bare line ends there. Its stops are the mapped stations and the towns (Likea: real towns stay), so every town and
  city within 10 km of the line is a stop (`HARD_TOWN_KM`), whatever track passes it: a line laid through a town can
  run in the square beside it, or meet mapped track there. Uelen and Egvekinot are villages and have none; Diomede, on
  Little Diomede in the middle of the tunnel, is mapped as a town and has one.
- **Scale.** The builder weighs at most 800 settlements as stops for one new line (the Ganges plain holds tens of
  thousands in a box), finds nearby places and track in a small spatial index, and reads and writes its inputs a record
  to a line, since a continent's railways or hamlets are more than one string can hold.
- **Islands.** Great Britain (the Channel Tunnel), Japan (by the Sakhalin tunnels and its own tunnels and bridges),
  Zealand, Sri Lanka (over the shoals of Adam's Bridge, with under 3 km of open water) and Sicily and the Isle of Wight
  (joins of 10 km or less are drawn straight and never checked for water, as in the Americas) are on the network.
  Left off, with railways mapped: Ireland and Northern Ireland, Sardinia, Corsica, Mallorca, Taiwan, Java, Sumatra,
  Sulawesi, Sabah, Luzon, Hainan, Madagascar, Gotland, Cyprus, Crete, Mauritius and Réunion.
- **Result** (after the September 2026 thinning): 131,149 squares and 15,156 stops (391 halts), 7,837 junctions and no
  buffers. Joined to the Americas: 196,217 squares and 20,597 stops. The game's world data is 8.0 MiB and the page
  9.3 MiB.
- **Result before the thinning.** 163,773 squares and 24,922 stops (489 halts), 16,033 junctions and 5,209 buffers; 1,407,534 km of mapped
  railway kept (7,772 parallel stretches, 141,920 km, taken up) and 262,946 km of new line: 5,880 stub joins, 39
  facing-end joins (7,862 km), 23 shortcuts, 281 spurs and the four authored routes; 153 pieces (40,324 km) left out,
  the islands above among them; every authored city reached. Joined to the Americas: 253,355 squares and 33,657
  stops. By the shortest way, Punta Arenas to Wales is 25,488 km, to Nizhny Bestyakh 30,323 km, to Moscow 38,011 km
  and to Cape Town 52,161 km. The game's world data is 10.8 MiB (2.3 MiB gzipped), the page 12.1 MiB (2.7 MiB), and
  the network is built in the game in about 3.5 s (Node, on the Windows machine the build was run on).
- **Building it.** From the downloads: filtering and merging about 10 minutes, extracting 8, the terrain grid 17, and
  the network about 1 h 40 min from scratch with the terrain pool (most of it the facing-ends rule; see Not done yet),
  minutes when only the stops change. The elevation tiles for the whole scope are about 5,600 files beside the cache.

## The geographic grid

The network lies on two grids of 5 km squares (`scripts/world/projection.cjs`), each a Lambert azimuthal equal-area
projection: the Americas', centred at 102.5°W, 10°N and shifted so Punta Arenas is square (0, 0), and Europe, Asia
and Africa's, centred at 40°E, 37.5°N, turned and moved to meet it at Wales (above). Every square covers the same
area of ground, so a tile's grid position is where it really is. The browser repeats the inverse formulas
(`setup.worldmap.unprojectGrid`, with the grid from `setup.worldmap.gridFor`) to place each square.

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

Compiled rail cells and station records live in `setup`, not `State.variables`. A save records deterministic
version-5 station UUIDs derived from stop source IDs, tile grid coordinates, geographic fallback coordinates and
the world revision alongside the runtime numeric indexes. On a rebuilt network, loading resolves UUIDs to the new
indexes; a removed player station or tile sends the player and active consist to the geographically nearest
surviving station. Removed visited yards remain in `orphanedStationYards` in the save so their cars and depleted
stores are not silently treated as a different yard. A siding is identified by its square; one no longer there sends
the player to the nearest station, and a train left on the line whose square has gone is kept in the same way, under
`line:x,y`. New games do not carry a copy of the whole world in saves.
Public v0.2.0 saves have no map; their explicit Punta Arenas placement is a separate future conversion task.

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

The debug panel's map is the Map tab's globe (`setup.globe.build({ revealAll: true, ... })`, Likea, September 2026)
with everything revealed and no fog: every square, new lines in red, every station. Far out, the track is drawn into
the globe's pixels from a raster of the texture's size; from 0.12 pixels a kilometre in, as lines and markers, only for
the buckets (2 degrees square) in view. `appendDebugMap(parent, stationId)` builds it once its panel is open, with the
network's figures above it and a readout under it of the square nearest the pointer (or the latitude and longitude of
open ground). A click on the track (not a drag) teleports there; the station list is the keyboard way to teleport.
Teleporting while aboard moves `journey`, so the complete active consist moves; teleporting on foot changes only
`onFoot`, leaving the train's journey position alone. A trainless teleport creates only the route context walking needs
and never invents a boardable train. Station squares enter the actual railyard: an on-foot player may inspect the yard
and use its supplies, then return to the station track without moving the remote consist. Boarding another train is
disabled until the player returns, because only one off-yard consist can currently be represented safely.

The grid-space land mask (`scripts/world/land-mask.cjs`, `network.land`) is still compiled: it tells which grid any
square of the joined map lies on (`setup.worldmap.gridAt`).

## Not done yet

- The balance between time on the line and time in yards is not settled; Likea expects to revisit it after 0.3.0.
- Yards differ by region in size only: a closed halt and a working station in the same region generate the same kind
  of yard.
- Halt and junction names are generated (`Km 74 from El Turbio`, or the nearest settlement) and are for Likea to
  review.
- Panama and Central America are outside the extract: Panama City is reached by a new line across the Darién.
- Climate, rivers, obstacles, track condition and weather are not yet sourced into gameplay.
- Names in Europe, Asia and Africa that had no English or official Latin form are transliterated letter by letter
  (about a fifth of the stations, mostly in Russia, where it reads well; Arabic loses its vowels). They are counted in
  each import's `stats.nameSources`, for Likea to review with the halt and junction names.
- Islands left off the network that Likea may want joined by a tunnel or a bridge, each a real proposal: Ireland to
  Scotland across the North Channel (about 20 km at its narrowest; the whole Irish network), Hainan across the
  Qiongzhou Strait (about 20 km; it has a train ferry today), Java to Sumatra across the Sunda Strait (about 25 km)
  and Sumatra to Malaysia across the Strait of Malacca (about 50 km), which together bring in Indonesia's railways, and
  Taiwan (about 130 km). And Gibraltar, Morocco to Spain (about 14 km, under the strait), a second way between
  Europe and Africa beside the Sinai; DESIGN.md has it as an open question.
- The facing-ends rule plans every pair of line ends that face each other across a gap, and only then refuses those
  over open water. Since Japan joined the network by the Sakhalin tunnel, its line ends face Korea's and each other's
  across the sea: some 40,000 pairs, nearly all refused, each after a search along the track that takes most of an
  hour altogether (planning them is quick since the terrain grid). A check against the terrain grid's water cells
  along the straight line, before anything else, would refuse most of them at once.

## Legacy generator

The old seeded fictional generator is no longer reachable through normal gameplay. Its internal helpers remain
temporarily in `source/worldmap.js` to reduce risk while old-save compatibility is audited; they are not a second
world mode and must not be used for new routes.
