#!/usr/bin/env python3
"""Generate Ashline driving-view pixel-art SVG templates: rolling stock, track, and terrain.

Run:  python3 scripts/draw-driving-templates.py

Writes:
  source/img/driving/*.svg        templates (Tweego bundles them as image passages)
  source/driving-templates.js     placement data, as setup.drivingTemplates
  docs/driving-templates.json     the same placement data, for reference
  docs/driving-preview.svg        a composed scene built only from the templates

The camera is yawed 90 degrees and pitched 45 degrees down, and the train's forward is to the
right. Yaw 90 means we look square at the train's side, so its ends are edge on and never seen;
pitch 45 tilts the camera down, so the top of every box shows as a band above its side, squashed
by cos 45. Track lines stay on whole pixels and a car moving along the rail is a whole-pixel
translation, exactly as in the rail yard view.

World axes (2 units = 1 metre, the same scale as the rail yard):
  u  along the train, increasing forward (to the right on screen)
  v  across the train, increasing toward the camera
  z  up; z = 0 is the railhead plane
Screen:  x = u,  y = (v - z) * cos 45

Each template's world origin (u = 0 at a car's rear, v = 0 on the centreline, z = 0 at the
railhead) sits at the pixel in data-anchor-x / data-anchor-y, so placing one at world (u, v) is
left = x(u, v) - anchorX, top = y(u, v) - anchorY.
"""
import json
import math
from pathlib import Path
from locale_art import driving_landscapes, rolling_stock
from fleet_art import extra_stock, locomotive_title
from stock_depth import StockDepth

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / 'source' / 'img' / 'driving'
DOCS_DIR = ROOT / 'docs'

UNITS_PER_METRE = 2
PITCH = math.cos(math.radians(45))  # how far a metre of depth or height falls on screen
TRACK_TILE_UNITS = 20   # one repeat of the track strip
TERRAIN_TILE_UNITS = 80  # one repeat of a terrain backdrop
HALF_WIDTH = 5          # half a car's width in units, so the near side sits at v = +5
WHEEL_V = 3.4           # wheels ride on the rail plane, not out on the car's side
GROUND_DEPTH = 26       # how far the ground reaches toward the camera from the track centre
SKY_HEIGHT = 34         # how far a backdrop reaches above the railhead

P = {
    'background': '#151719',
    'ballast': '#494c42', 'ballast_dark': '#3b3e37', 'tie': '#75654d',
    'rail_dark': '#222a2b', 'rail_top': '#b8b6a0',
    'coupler': '#bbb09a', 'coupler_side': '#7f786a',
    'truck_top': '#383c3b', 'truck_side': '#111416',
    'frame_top': '#454440', 'frame_side': '#232626',
    'wheel_rim': '#1b1f20', 'wheel_hub': '#8c3b2e',
    'box_top': '#a87555', 'box_side': '#724b3a', 'box_rib': '#bc8660',
    'box_door': '#66432f', 'box_door_edge': '#432c28',
    'flat_top': '#8d7859', 'flat_side': '#574633', 'flat_plank': '#7b684c', 'flat_stake': '#2e2822',
    'gon_top': '#7b7654', 'gon_side': '#4e4a36', 'gon_floor': '#2a2922', 'gon_rib': '#8a8560',
    'tank_top': '#6d7371', 'tank_side': '#3f4543', 'tank_dark': '#202424',
    'walkway_top': '#55584f', 'walkway_side': '#2d302c',
    'loco_top': '#7a8780', 'loco_side': '#495b58',
    'cab_top': '#9aa092', 'cab_side': '#3d5558',
    'window': '#dec38a', 'vent': '#273c3e', 'stripe': '#c6975d',
    'steam_top': '#4a5150', 'steam_side': '#2c3131', 'steam_dark': '#171a1a',
    'smokebox_top': '#383c3c', 'smokebox_side': '#1f2222',
    'steam_cab_top': '#7a4a3c', 'steam_cab_side': '#5b3a32',
    'brass': '#c9a15f', 'rod': '#9aa0a0', 'coal': '#1a1a19', 'coal_top': '#2c2b28',
    'prairie_top': '#4f6652', 'prairie_side': '#2f4133',
    'road_top': '#a0805a', 'road_side': '#6f5338', 'road_cab_top': '#b8a07c', 'road_vent': '#3f3024', 'road_fan': '#7d6245',
    'road_stripe': '#d9c9a0',
    # Terrain, kept flat and simple: a ground band, a horizon, and a little detail on top.
    'plains_ground': '#3f4a36', 'plains_near': '#4a5640', 'plains_far': '#333d2d', 'plains_tuft': '#5d6b4a',
    # Daylight uses these templates directly; night and dusk are graded over them.
    # Keep the base horizons visibly blue so a clear afternoon does not read as night.
    'plains_sky': '#78a9c4',
    'desert_ground': '#6b5a36', 'desert_near': '#7b6941', 'desert_far': '#584a2e', 'desert_tuft': '#8d7a4d',
    'desert_sky': '#83a9c2',
    'arctic_ground': '#5d6a72', 'arctic_near': '#6d7c85', 'arctic_far': '#4c5860', 'arctic_tuft': '#8fa0a8',
    'arctic_sky': '#91b7c7',
    'mountain_ground': '#4a4340', 'mountain_near': '#554d49', 'mountain_far': '#3a3431', 'mountain_rock': '#6b615b',
    'mountain_sky': '#6f9bb7', 'mountain_snow': '#a9b0b4',
    'forest_ground': '#2f3d2a', 'forest_near': '#384833', 'forest_far': '#1f2b1f', 'forest_sky': '#6b9aaa',
    'forest_trunk': '#3d2f24', 'forest_canopy': '#26402a', 'forest_canopy_light': '#355437',
    'bridge_ground': '#5a4a3a', 'bridge_girder': '#6a5a48', 'bridge_girder_dark': '#463a2e',
    'bridge_water': '#24384a', 'bridge_water_light': '#2e465c', 'bridge_sky': '#6f9fbc',
    'tunnel_rock': '#332f2c', 'tunnel_rock_light': '#453f3a', 'tunnel_dark': '#0d0f10', 'tunnel_lamp': '#c9a15f',
}


def px(n):
    return math.floor(n + 0.5)


def project(u, v, z=0.0):
    """Yaw 90, pitch 45: along the train is screen x, depth and height share the vertical axis."""
    return (u, (v - z) * PITCH)


class Sprite(StockDepth):
    """Flat-coloured screen polygons, in draw order, grouped into named parts."""

    def __init__(self, name, title, length_m=None):
        self.name = name
        self.title = title
        self.length_m = length_m
        self.parts = []
        self.points = {}
        self.init_depth(project, False)

    def part(self, name):
        self.parts.append((name, []))

    def poly(self, points, fill, opacity=1):
        self.parts[-1][1].append(([(px(x), px(y)) for x, y in points], fill, opacity))

    def world_poly(self, points, fill, opacity=1):
        self.poly([project(*pt) for pt in points], fill, opacity)
        self.record_face(points)

    def box(self, u, v, z, length, width, height, top, side):
        """Axis-aligned box. At yaw 90 only the near side and the top are ever visible."""
        self.world_poly([(u, v + width, z), (u + length, v + width, z),
                         (u + length, v + width, z + height), (u, v + width, z + height)], side)
        self.world_poly([(u, v, z + height), (u + length, v, z + height),
                         (u + length, v + width, z + height), (u, v + width, z + height)], top)

    def slab(self, u0, u1, z0, z1, fill, v=HALF_WIDTH):
        """A flat rectangle on the near face, between two heights."""
        self.world_poly([(u0, v, z0), (u1, v, z0), (u1, v, z1), (u0, v, z1)], fill)

    def line_u(self, u0, u1, v, z, fill, thickness=1):
        (x0, y0), (x1, y1) = project(u0, v, z), project(u1, v, z)
        x0, y0, x1, y1 = px(x0), px(y0), px(x1), px(y1)
        self.parts[-1][1].append(([(x0, y0), (x1, y1), (x1, y1 + thickness), (x0, y0 + thickness)], fill, 1))
        self.record_side_line(v)

    def line_z(self, u, v, z0, z1, fill, thickness=1):
        (x, y_top), (_, y_bottom) = project(u, v, z1), project(u, v, z0)
        x, y_top, y_bottom = px(x), px(y_top), px(y_bottom)
        self.parts[-1][1].append(([(x, y_top), (x + thickness, y_top), (x + thickness, y_bottom), (x, y_bottom)], fill, 1))
        self.record_side_line(v)

    def disc_side(self, uc, zc, radius, rim, hub, sides=10, v=WHEEL_V):
        """A wheel, drawn on the near rail so the train sits on the track rather than above it. Wheels in a truck
        frame are drawn on the frame's face instead, so the frame does not hide them."""
        for r, colour in ((radius, rim), (radius * 0.45, hub)):
            self.world_poly([(uc + r * math.cos(2 * math.pi * i / sides), v,
                              zc + r * math.sin(2 * math.pi * i / sides) / PITCH) for i in range(sides)], colour)

    def mark(self, key, u, v, z):
        self.points[key] = project(u, v, z)

    def bounds(self):
        if hasattr(self, 'depth_bounds'):
            return self.depth_bounds
        xs = [x for _, polys in self.parts for pts, *_ in polys for x, _ in pts]
        ys = [y for _, polys in self.parts for pts, *_ in polys for _, y in pts]
        return min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1

    def render(self):
        self.resolve_depth()
        self.title = locomotive_title(self.name, self.title)
        minx, miny, maxx, maxy = self.bounds()
        width, height = maxx - minx, maxy - miny
        ax, ay = -minx, -miny
        info = {'file': f'{self.name}.svg', 'passage': self.name, 'title': self.title,
                'width': width, 'height': height, 'anchorX': ax, 'anchorY': ay}
        if self.length_m is not None:
            info['lengthMetres'] = self.length_m
        for key, (x, y) in self.points.items():
            info[key] = [px(x) + ax, px(y) + ay]
        attrs = ' '.join([f'data-template="{self.name}"', f'data-anchor-x="{ax}"', f'data-anchor-y="{ay}"']
                         + ([f'data-length-m="{self.length_m}"'] if self.length_m is not None else []))
        lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
                 f'viewBox="0 0 {width} {height}" shape-rendering="crispEdges" {attrs}>',
                 f'<title>Ashline driving template: {self.title}</title>']
        for name, polys in self.parts:
            lines.append(f'<g id="{name}">')
            if self.depth_enabled:
                lines.extend(self.stock_svg_part(name, polys, ax, ay))
                lines.append('</g>')
                continue
            for pts, fill, opacity in polys:
                extra = f' fill-opacity="{opacity}"' if opacity < 1 else ''
                lines.append('<polygon points="' + ' '.join(f'{x + ax},{y + ay}' for x, y in pts) + f'" fill="{fill}"{extra}/>')
            lines.append('</g>')
        lines.append('</svg>')
        return '\n'.join(lines) + '\n', info


# Rolling stock ---------------------------------------------------------------

def coupler(s, u):
    s.part('coupler')
    s.box(u - 1, -1, 3, 2, 2, 1, P['coupler'], P['coupler_side'])


def running_gear(s, length, wheel_starts=None):
    coupler(s, 0)
    for start in (wheel_starts or (3, length - 9)):
        s.part('trucks')
        s.box(start, -3, 2.5, 6, 6, 1, P['truck_top'], P['truck_side'])
        s.part('wheels')
        for offset in (1, 5):
            s.disc_side(start + offset, 2, 2, P['truck_top'], P['wheel_hub'], sides=12, v=5.5)
    s.part('underframe')
    s.box(0, -5, 3, length, 10, 2, P['frame_top'], P['frame_side'])


def finish_car(s, length, top_z):
    coupler(s, length)
    s.mark('rear', 0, 0, 4)
    s.mark('front', length, 0, 4)
    s.mark('top', length / 2, 0, top_z)


def boxcar(length_m=12):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-car-boxcar', 'Boxcar', length_m)
    running_gear(s, L)
    s.part('body')
    s.box(1, -5, 5, L - 2, 10, 10, P['box_top'], P['box_side'])
    door0, door1 = L / 2 - 3, L / 2 + 3
    s.part('ribs')
    for u in range(3, L - 1, 4):
        if not door0 - 1 <= u <= door1 + 1:
            s.line_z(u, HALF_WIDTH, 5, 15, P['box_rib'])
    s.part('door')
    s.slab(door0, door1, 5, 14, P['box_door'])
    s.line_z(door0, HALF_WIDTH, 5, 14, P['box_door_edge'])
    s.line_z(door1, HALF_WIDTH, 5, 14, P['box_door_edge'])
    s.line_u(door0 - 3, door1 + 3, HALF_WIDTH, 14, P['box_door_edge'])
    finish_car(s, L, 15)
    return s



def passenger_car(kind, length_m):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-car-' + kind, kind.replace('-', ' ').title(), length_m)
    running_gear(s, L)
    colours = {'passenger': '#495b58', 'sleeper': '#454d66', 'observation': '#626951',
               'kitchen': '#756c56', 'private': '#69483f'}
    s.part('body')
    s.box(1, -5, 5, L - 2, 10, 10, '#92968a', colours[kind])
    s.part('windows')
    step = 7 if kind == 'sleeper' else 6
    for u in range(5, L - 5, step):
        width = 2 if kind == 'kitchen' else 4
        s.slab(u, u + width, 10, 14, '#273c3e')
    s.part('doors')
    for u in (2, L - 4):
        s.line_z(u, 5, 5, 14, '#b8b6a0')
    s.line_u(2, L - 2, 5, 8, '#c6975d')
    if kind == 'observation':
        s.part('glass-roof')
        s.box(L / 3, -4, 15, L / 3, 8, 3, '#a3b9b7', '#647e80')
    if kind == 'kitchen':
        s.part('vents')
        for u in range(8, L - 8, 8):
            s.box(u, -2, 15, 3, 4, 2, '#7a8780', '#3d5558')
    finish_car(s, L, 18 if kind == 'observation' else 17 if kind == 'kitchen' else 15)
    return s


def flatcar(length_m=14):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-car-flatcar', 'Flatcar', length_m)
    running_gear(s, L)
    s.part('deck')
    s.box(1, -5, 5, L - 2, 10, 2, P['flat_top'], P['flat_side'])
    s.part('planks')
    s.world_poly([(2,0,7),(L-2,0,7),(L-2,1,7),(2,1,7)], P['flat_plank'])
    s.part('stakes')
    for u in range(4, L - 2, 6):
        s.line_z(u, HALF_WIDTH, 7, 10, P['flat_stake'])
    finish_car(s, L, 7)
    return s


def gondola(length_m=13):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-car-gondola', 'Gondola', length_m)
    running_gear(s, L)
    s.part('floor')
    s.box(1, -5, 5, L - 2, 10, 1, P['gon_floor'], P['gon_floor'])
    s.part('walls')
    s.box(1, -5, 5, L - 2, 10, 6, P['gon_top'], P['gon_side'])
    s.part('ribs')
    for u in range(3, L - 2, 4):
        s.line_z(u, HALF_WIDTH, 5, 11, P['gon_rib'])
    finish_car(s, L, 11)
    return s


def tanker(length_m=14):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-car-tanker', 'Tanker car', length_m)
    running_gear(s, L)
    s.part('walkway')
    s.box(1, -5, 5, L - 2, 10, 1, P['walkway_top'], P['walkway_side'])
    s.part('tank')
    # The tank reads as bands: a dark underside, the barrel, and a lit top where the camera looks down on it.
    s.slab(2, L - 2, 6, 8, P['tank_dark'])
    s.slab(2, L - 2, 8, 14, P['tank_side'])
    s.box(2, -5, 14, L - 4, 10, 1, P['tank_top'], P['tank_top'])
    s.part('dome')
    s.box(L / 2 - 2, -2, 15, 4, 4, 2, P['tank_top'], P['tank_side'])
    finish_car(s, L, 17)
    return s


def mirrored(sprite, name, title):
    """The same locomotive facing the other way.

    At yaw 90 the projection has no shear (screen x is just u), so flipping horizontally about the car's own
    length is an exact mirror: the near side stays the near side and the top stays the top. Marked points come
    with it, so the cab is still the cab.
    """
    span = sprite.length_m * UNITS_PER_METRE
    sprite.resolve_depth()
    flipped = Sprite(name, title, sprite.length_m)
    flipped.depth_resolved = True
    minx, miny, maxx, maxy = sprite.bounds()
    flipped.depth_bounds = (span-maxx, miny, span-minx, maxy)
    for part_name, polys in sprite.parts:
        flipped.part(part_name)
        for pts, fill, opacity in polys:
            flipped.parts[-1][1].append(([(span - x, y) for x, y in pts], fill, opacity))
    for key, (x, y) in sprite.points.items():
        flipped.points[key] = (span - x, y)
    return flipped


def rod(s, u0, u1, z, v=WHEEL_V + 0.1):
    s.part('rods')
    s.line_u(u0, u1, v, z, P['rod'])


def diesel_shunter(length_m=9):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-loco-diesel-shunter-right', 'Two axle diesel shunter, facing right', length_m)
    coupler(s, 0)
    s.part('frame')
    s.box(0, -5, 3, L, 10, 2, P['frame_top'], P['frame_side'])
    s.line_u(0, L, HALF_WIDTH, 4, P['stripe'])
    s.part('wheels')
    for uc in (4.5, 13.5):
        s.disc_side(uc, 2.2, 2.2, P['truck_top'], P['wheel_hub'], sides=12, v=5.5)
    rod(s, 4.5, 13.5, 2.2, v=5.6)
    s.part('cab')
    s.box(1, -5, 5, 7, 10, 12, P['cab_top'], P['cab_side'])
    s.slab(2.5, 6.5, 11, 14.5, P['window'])
    s.box(0.5, -5.5, 17, 8, 11, 1, P['cab_top'], P['cab_side'])
    s.part('hood')
    s.box(8, -3.5, 5, 9, 7, 7, P['loco_top'], P['loco_side'])
    for u in (10, 12, 14):
        s.line_z(u, 3.5, 6, 10, P['vent'])
    s.box(11.5, -1, 12, 2, 2, 2, P['truck_top'], P['vent'])
    s.slab(16, 17, 9, 10, P['window'], v=3.5)
    finish_car(s, L, 18)
    s.mark('cab', 4.5, 0, 18)
    return s


def diesel_road(length_m=20):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-loco-diesel-road-right', 'Six axle road diesel, facing right', length_m)
    coupler(s, 0)
    s.part('trucks')
    for start in (3, 26):
        s.box(start, -6, 0, 11, 12, 3, P['truck_top'], P['truck_side'])
        for offset in (2, 5.5, 9):
            s.disc_side(start + offset, 1.6, 1.5, P['wheel_rim'], P['wheel_hub'], v=6)
    s.part('fuel-tank')
    s.box(15, -4, 1, 10, 8, 2, P['truck_top'], P['frame_side'])
    s.part('frame')
    s.box(0, -5, 3, L, 10, 2, P['frame_top'], P['frame_side'])
    s.line_u(0, L, HALF_WIDTH, 4, P['road_stripe'])
    s.part('long-hood')
    s.box(2, -3.5, 5, 25, 7, 8, P['road_top'], P['road_side'])
    for u in (5, 8, 11, 14, 17, 20, 23):
        s.line_z(u, 3.5, 6, 11, P['road_vent'])
    for u in (4, 9):
        s.box(u, -2, 13, 3, 4, 0.5, P['road_fan'], P['road_fan'])
    s.box(17, -1, 13, 2, 2, 2, P['truck_top'], P['vent'])
    s.part('cab')
    s.box(27, -5, 5, 8, 10, 12, P['road_cab_top'], P['road_side'])
    s.slab(29, 33, 12, 15, P['window'])
    s.box(26.5, -5.5, 17, 9, 11, 1, P['road_cab_top'], P['road_side'])
    s.part('short-hood')
    s.box(35, -3.5, 5, 4, 7, 6, P['road_top'], P['road_side'])
    s.slab(37, 38, 11, 12, P['window'], v=3.5)
    finish_car(s, L, 18)
    s.mark('cab', 31, 0, 18)
    return s


def steam_shunter(length_m=10):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-loco-steam-shunter-right', '0-6-0 steam shunter, facing right', length_m)
    coupler(s, 0)
    s.part('frame')
    s.box(0, -4, 3, L, 8, 2, P['frame_top'], P['frame_side'])
    s.part('wheels')
    for uc in (5.5, 10.5, 15.5):
        s.disc_side(uc, 2.4, 2.4, P['wheel_rim'], P['wheel_hub'])
    rod(s, 5.5, 15.5, 2.4)
    s.part('running-board')
    s.box(1, -5, 5, L - 2, 10, 1, P['walkway_top'], P['walkway_side'])
    s.part('bunker')
    s.box(0.5, -5, 6, 3, 10, 7, P['steam_cab_top'], P['steam_cab_side'])
    s.box(0.5, -4, 13, 3, 8, 1, P['coal_top'], P['coal'])
    s.part('cab')
    s.box(3.5, -5, 6, 6, 10, 11, P['steam_cab_top'], P['steam_cab_side'])
    s.slab(4.5, 7.5, 12, 15, P['window'])
    s.box(3, -5.5, 17, 7, 11, 1, P['steam_cab_top'], P['steam_cab_side'])
    s.part('side-tank')
    s.box(9.5, -5, 6, 7, 10, 6, P['steam_top'], P['steam_side'])
    s.line_u(9.5, 16.5, HALF_WIDTH, 9, P['brass'])
    s.part('boiler')
    s.box(9.5, -3.5, 12, 7, 7, 3, P['steam_top'], P['steam_dark'])
    s.box(12, -1.5, 15, 2, 3, 2, P['brass'], P['steam_side'])
    s.part('smokebox')
    s.slab(16.5, 19.5, 6.5, 15, P['smokebox_side'])
    s.box(16.5, -4.3, 15, 3, 8.6, 0.5, P['smokebox_top'], P['smokebox_top'])
    s.box(17, -1, 15, 2, 2, 4, P['smokebox_top'], P['smokebox_side'])
    finish_car(s, L, 19)
    s.mark('cab', 6.5, 0, 17)
    return s


def steam_prairie(length_m=23):
    L = length_m * UNITS_PER_METRE
    s = Sprite('driving-loco-steam-prairie-right', '2-6-2 steam engine with tender, facing right', length_m)
    coupler(s, 0)
    s.part('tender-trucks')
    for start in (1.5, 8.5):
        s.box(start, -3, 2.5, 5, 6, 1, P['truck_top'], P['truck_side'])
        for offset in (1, 4):
            s.disc_side(start + offset, 1.6, 1.6, P['truck_top'], P['wheel_hub'], sides=12, v=5.5)
    s.part('frame')
    s.box(0, -4, 3, L, 8, 2, P['frame_top'], P['frame_side'])
    s.part('wheels')
    for uc, r in ((20.5, 2), (26.5, 3.2), (32.5, 3.2), (38.5, 3.2), (43.5, 2)):
        s.disc_side(uc, r, r, P['wheel_rim'], P['wheel_hub'])
    rod(s, 26.5, 38.5, 3.2)
    s.part('tender')
    s.box(0.5, -5, 5, 14, 10, 8, P['prairie_top'], P['prairie_side'])
    s.box(8, -4, 13, 6.5, 8, 1.5, P['coal_top'], P['coal'])
    s.part('cab')
    s.box(17, -5, 6, 7, 10, 12, P['prairie_top'], P['prairie_side'])
    s.slab(18.5, 22, 12, 15.5, P['window'])
    s.box(16.5, -5.5, 18, 8, 11, 1, P['prairie_top'], P['prairie_side'])
    s.part('boiler')
    s.box(24, -5, 6, 21.5, 10, 1, P['walkway_top'], P['walkway_side'])
    s.slab(24, 41, 7.5, 9.5, P['steam_dark'])
    s.slab(24, 41, 9.5, 15.5, P['prairie_side'])
    s.box(24, -4.5, 15.5, 17, 9, 1, P['prairie_top'], P['prairie_top'])
    s.line_u(25, 40, HALF_WIDTH, 12, P['brass'])
    s.box(30, -1.5, 16, 2.5, 3, 2, P['brass'], P['prairie_side'])
    s.box(35, -1.5, 16, 2.5, 3, 2, P['prairie_top'], P['prairie_side'])
    s.part('smokebox')
    s.box(39.5, 3, 3, 4.5, 3, 4, P['steam_top'], P['steam_side'])
    s.slab(41, 46, 7, 16.5, P['smokebox_side'])
    s.box(41, -4.8, 16.5, 5, 9.6, 0.5, P['smokebox_top'], P['smokebox_top'])
    s.box(42.5, -1.25, 16.5, 2.5, 2.5, 5, P['smokebox_top'], P['smokebox_side'])
    s.slab(45, 46, 11, 12.5, P['window'])
    finish_car(s, L, 22)
    s.mark('cab', 20.5, 0, 18)
    return s


LOCOMOTIVES = [
    (diesel_shunter, 'diesel-shunter', 'Two axle diesel shunter'),
    (diesel_road, 'diesel-road', 'Six axle road diesel'),
    (steam_shunter, 'steam-shunter', '0-6-0 steam shunter'),
    (steam_prairie, 'steam-prairie', '2-6-2 steam engine with tender'),
]


# Track and terrain -----------------------------------------------------------

def track_strip():
    """One repeat of track: ballast, sleepers, and the two rails seen from the near side."""
    s = Sprite('driving-track', 'Track')
    T = TRACK_TILE_UNITS
    s.part('ballast')
    s.world_poly([(0, -9, 0), (T, -9, 0), (T, 9, -1), (0, 9, -1)], P['ballast'])
    s.part('ties')
    for u in range(1, T, 5):
        s.world_poly([(u, -8, 0.2), (u + 2, -8, 0.2), (u + 2, 8, 0.2), (u, 8, 0.2)], P['tie'])
    s.part('rails')
    for v in (-3, 3):
        s.line_u(0, T, v, 1, P['rail_dark'], thickness=2)
        s.line_u(0, T, v, 1.4, P['rail_top'])
    return s


def terrain(name, title, ground, near, far, sky, detail, snow=False):
    """One repeat of a terrain backdrop: sky, a far band, the ground, and a little detail."""
    s = Sprite('driving-terrain-' + name, title)
    T = TERRAIN_TILE_UNITS
    s.part('sky')
    s.world_poly([(0, -GROUND_DEPTH, SKY_HEIGHT), (T, -GROUND_DEPTH, SKY_HEIGHT),
                  (T, -GROUND_DEPTH, 2), (0, -GROUND_DEPTH, 2)], sky)
    s.part('far')
    # A ragged skyline, higher and rockier for mountains, low and soft everywhere else.
    steps = 8
    peak = 22 if snow else 9
    for i in range(steps):
        u0, u1 = T * i / steps, T * (i + 1) / steps
        height = 2 + peak * (0.35 + 0.65 * abs(math.sin(i * 1.7)))
        s.world_poly([(u0, -GROUND_DEPTH, height), (u1, -GROUND_DEPTH, height),
                      (u1, -GROUND_DEPTH, 2), (u0, -GROUND_DEPTH, 2)], far)
        if snow and height > 14:
            s.world_poly([(u0, -GROUND_DEPTH, height), (u1, -GROUND_DEPTH, height),
                          (u1, -GROUND_DEPTH, height - 3), (u0, -GROUND_DEPTH, height - 3)], P['mountain_snow'])
    s.part('ground')
    s.world_poly([(0, -GROUND_DEPTH, 2), (T, -GROUND_DEPTH, 2), (T, GROUND_DEPTH, 2), (0, GROUND_DEPTH, 2)], ground)
    s.part('near')
    s.world_poly([(0, GROUND_DEPTH - 8, 2), (T, GROUND_DEPTH - 8, 2), (T, GROUND_DEPTH, 2), (0, GROUND_DEPTH, 2)], near)
    s.part('detail')
    for i in range(6):
        u = 4 + i * (T - 8) / 6
        v = -18 + ((i * 7) % 5) * 7
        if snow:  # loose rock rather than scrub
            s.world_poly([(u, v, 2), (u + 3, v, 2), (u + 3, v, 4), (u, v, 4)], detail)
        else:
            s.line_z(u, v, 2, 4 + (i % 3), detail)
            s.line_z(u + 1, v, 2, 3 + (i % 2), detail)
    return s


def forest():
    """Forest: a dark treeline on the horizon and conifers standing back from the line. The backdrop is drawn
    behind the train, so every tree stands on the far side of the track."""
    s = Sprite('driving-terrain-forest', 'Forest')
    T = TERRAIN_TILE_UNITS
    s.part('sky')
    s.world_poly([(0, -GROUND_DEPTH, SKY_HEIGHT), (T, -GROUND_DEPTH, SKY_HEIGHT),
                  (T, -GROUND_DEPTH, 2), (0, -GROUND_DEPTH, 2)], P['forest_sky'])
    s.part('treeline')
    for i in range(10):
        u = i * T / 10
        top = 14 + 6 * abs(math.sin(i * 2.3))
        s.world_poly([(u - 1, -GROUND_DEPTH, 2), (u + 4, -GROUND_DEPTH, top), (u + 9, -GROUND_DEPTH, 2)], P['forest_far'])
    s.part('ground')
    s.world_poly([(0, -GROUND_DEPTH, 2), (T, -GROUND_DEPTH, 2), (T, GROUND_DEPTH, 2), (0, GROUND_DEPTH, 2)], P['forest_ground'])
    s.part('near')
    s.world_poly([(0, GROUND_DEPTH - 8, 2), (T, GROUND_DEPTH - 8, 2), (T, GROUND_DEPTH, 2), (0, GROUND_DEPTH, 2)], P['forest_near'])
    s.part('trees')
    for i in range(7):
        u = 3 + i * (T - 6) / 7
        v = -20 + ((i * 5) % 3) * 4
        height = 16 + (i * 7) % 6
        s.line_z(u + 3, v, 2, 6, P['forest_trunk'], thickness=2)
        s.world_poly([(u, v, 5), (u + 4, v, height), (u + 8, v, 5)], P['forest_canopy'])
        s.world_poly([(u + 1.5, v, height - 5), (u + 4, v, height), (u + 6.5, v, height - 5)], P['forest_canopy_light'])
    return s


def bridge_span():
    """Level water backdrop; the selected structure is placed with the graded track."""
    s = Sprite('driving-terrain-bridge', 'Bridge water backdrop')
    T = TERRAIN_TILE_UNITS
    s.part('sky')
    s.world_poly([(0, -GROUND_DEPTH, SKY_HEIGHT), (T, -GROUND_DEPTH, SKY_HEIGHT),
                  (T, -GROUND_DEPTH, -22), (0, -GROUND_DEPTH, -22)], P['bridge_sky'])
    s.part('water')
    s.world_poly([(0, -GROUND_DEPTH, -22), (T, -GROUND_DEPTH, -22),
                  (T, GROUND_DEPTH, -22), (0, GROUND_DEPTH, -22)], '#344f59')
    for i in range(18):
        u, v = (i*17)%68+2, (i*11)%48-24
        s.line_u(u,u+4+i%7,v,-22,'#4e6970' if i%3 else '#293f49')
    return s


BRIDGES = [('masonry','Old short masonry arches',20), ('riveted','Old medium riveted girders',40),
           ('lattice','Old long steel deck truss',80), ('concrete','Newer short concrete beams',20),
           ('plate','Newer medium welded girders',40), ('box','Newer long concrete box girder',80)]


def bridge_structure(kind, title, span):
    """Repeatable structural bays; all bearing surfaces share the railhead origin."""
    s = Sprite('driving-bridge-'+kind, title)
    T = TERRAIN_TILE_UNITS
    old = kind in ('masonry','riveted','lattice')
    pale, face, dark = ('#a49b83','#756c59','#4f5049') if old else ('#afb5a7','#808e86','#52665f')
    s.part('piers')
    for u in range(0,T,span):
        s.box(u,-7,-23,4,14,20,pale,face)
        s.box(u,-8,-6,5,16,3,pale,dark)
        s.line_z(u+1,7,-21,-8,dark)
    s.part('structure')
    if kind == 'masonry':
        # Closed spandrel above each open, polygonal arch (no water-coloured cutouts).
        for u in range(0,T,span):
            inner=[(u+4,7,-19),(u+6,7,-11),(u+9,7,-8),(u+13,7,-8),(u+17,7,-11),(u+20,7,-19)]
            s.world_poly([(u,7,-3),(u+span,7,-3)]+list(reversed(inner))+[(u,7,-19)],face)
            for a,b in zip(inner,inner[1:]):
                s.world_poly([a,b,(b[0],b[1],b[2]+2),(a[0],a[1],a[2]+2)],pale)
            for z in (-5,-8):
                s.line_u(u,u+span,7,z,dark)
            for x in range(u+2,u+span,5): s.line_z(x,7,-7,-4,pale)
    elif kind == 'lattice':
        s.slab(0,T,-17,-15,dark,v=7)
        for u in range(0,T,10):
            s.world_poly([(u,7,-4),(u+10,7,-15),(u+10,7,-17),(u,7,-6)],face)
            s.world_poly([(u,7,-17),(u+10,7,-6),(u+10,7,-4),(u,7,-15)],pale)
            s.line_z(u,7,-16,-4,dark)
    else:
        depth = 8 if kind in ('riveted','plate','box') else 5
        s.slab(0,T,-depth,-3,face,v=7)
        s.line_u(0,T,7,-depth,dark,2)
        s.line_u(0,T,7,-3,pale)
        if kind in ('riveted','plate'):
            for u in range(3,T,6):
                s.line_z(u,7,-depth,-3,pale)
                if kind=='riveted':
                    for z in (-4,-6): s.slab(u+2,u+3,z,z+1,dark,v=7)
        elif kind=='box':
            for u in range(4,T,8): s.line_z(u,7,-7,-4,'#929e94')
    s.part('deck')
    s.box(0,-7,-3,T,14,1,pale,dark)
    # Far railing cannot obscure car windows; near kerb stays below the wheels.
    s.part('far-railing')
    s.line_u(0,T,-7,3,pale)
    for u in range(0,T,8): s.line_z(u,-7,-2,3,face)
    s.part('near-kerb'); s.line_u(0,T,7,-2,pale)
    return s


def tunnel_bore():
    """A tunnel: rock all round, the bore dark, and a lamp every so often."""
    s = Sprite('driving-terrain-tunnel', 'Tunnel')
    T = TERRAIN_TILE_UNITS
    s.part('rock')
    s.world_poly([(0, -GROUND_DEPTH, SKY_HEIGHT), (T, -GROUND_DEPTH, SKY_HEIGHT),
                  (T, -GROUND_DEPTH, 2), (0, -GROUND_DEPTH, 2)], P['tunnel_rock'])
    s.part('bore')
    s.world_poly([(0, -GROUND_DEPTH, 26), (T, -GROUND_DEPTH, 26), (T, -GROUND_DEPTH, 2), (0, -GROUND_DEPTH, 2)], P['tunnel_dark'])
    s.part('ground')
    s.world_poly([(0, -GROUND_DEPTH, 2), (T, -GROUND_DEPTH, 2), (T, GROUND_DEPTH, 2), (0, GROUND_DEPTH, 2)], P['tunnel_rock'])
    s.part('detail')
    for i in range(4):
        u = 6 + i * (T - 12) / 4
        s.world_poly([(u, -GROUND_DEPTH, 24), (u + 10, -GROUND_DEPTH, 24), (u + 10, -GROUND_DEPTH, 22), (u, -GROUND_DEPTH, 22)],
                     P['tunnel_rock_light'])
        s.world_poly([(u + 4, -GROUND_DEPTH, 22), (u + 6, -GROUND_DEPTH, 22), (u + 6, -GROUND_DEPTH, 21), (u + 4, -GROUND_DEPTH, 21)],
                     P['tunnel_lamp'])
    return s


def build_all():
    locomotives = []
    for draw, model, title in LOCOMOTIVES:
        right = draw()
        locomotives += [right, mirrored(right, f'driving-loco-{model}-left', f'{title}, facing left')]
    return [
        boxcar(), flatcar(), gondola(), tanker(),
        *[passenger_car(kind, length) for kind, length in
          [('passenger', 24), ('sleeper', 25), ('observation', 23), ('kitchen', 24), ('private', 22)]],
        *locomotives,
        *rolling_stock(globals(), False),
        *extra_stock(globals(), False),
        *driving_landscapes(globals()),
        track_strip(),
        terrain('yard', 'Rail yard', '#494c42', '#55584f', '#3b3e37', '#78a9c4', '#75654d'),
        terrain('plains', 'Plains', P['plains_ground'], P['plains_near'], P['plains_far'], P['plains_sky'], P['plains_tuft']),
        terrain('desert', 'Desert', P['desert_ground'], P['desert_near'], P['desert_far'], P['desert_sky'], P['desert_tuft']),
        terrain('arctic', 'Arctic', P['arctic_ground'], P['arctic_near'], P['arctic_far'], P['arctic_sky'], P['arctic_tuft']),
        terrain('mountain', 'Mountain', P['mountain_ground'], P['mountain_near'], P['mountain_far'], P['mountain_sky'],
                P['mountain_rock'], snow=True),
        forest(), bridge_span(), *[bridge_structure(*entry) for entry in BRIDGES], tunnel_bore(),
    ]


def preview(sprites):
    """A composed scene: a train of several cars on track, over each terrain in turn."""
    by_name = {s.name: s for s in sprites}
    rows = []
    consist = ['driving-loco-diesel-road-right', 'driving-loco-diesel-shunter-left', 'driving-car-tanker',
               'driving-loco-steam-shunter-right', 'driving-loco-steam-prairie-left']
    for row, terrain_name in enumerate(['plains', 'forest', 'desert', 'arctic', 'mountain', 'bridge', 'tunnel']):
        placed = []
        width = 300
        for u in range(0, width, TERRAIN_TILE_UNITS):
            placed.append((by_name['driving-terrain-' + terrain_name], u, 0))
        if terrain_name == 'bridge':
            for u in range(0, width, TERRAIN_TILE_UNITS):
                placed.append((by_name['driving-bridge-lattice'], u, 0))
        for u in range(0, width, TRACK_TILE_UNITS):
            placed.append((by_name['driving-track'], u, 0))
        u = 20
        for name in consist:
            sprite = by_name[name]
            placed.append((sprite, u, 0))
            u += sprite.length_m * UNITS_PER_METRE + 1
        rows.append((row, placed))

    out = []
    row_height = 90
    total_height = row_height * len(rows)
    out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{300 * 3}" height="{total_height * 3}" '
               f'viewBox="0 0 300 {total_height}" shape-rendering="crispEdges">')
    out.append('<title>Ashline driving templates: composed preview</title>')
    out.append(f'<rect width="300" height="{total_height}" fill="{P["background"]}"/>')
    for row, placed in rows:
        base_y = row * row_height + 62
        for sprite, u, v in placed:
            minx, miny, _, _ = sprite.bounds()
            for _, polys in sprite.parts:
                for pts, fill, opacity in polys:
                    moved = [(x + u, y + base_y) for x, y in pts]
                    extra = f' fill-opacity="{opacity}"' if opacity < 1 else ''
                    out.append('<polygon points="' + ' '.join(f'{x},{y}' for x, y in moved) + f'" fill="{fill}"{extra}/>')
    out.append('</svg>')
    return '\n'.join(out) + '\n'


def main():
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    sprites = build_all()
    manifest = {
        'projection': 'screen x = u; screen y = (v - z) * cos 45',
        'unitsPerMetre': UNITS_PER_METRE,
        'pitch': round(PITCH, 6),
        'trackTileUnits': TRACK_TILE_UNITS,
        'terrainTileUnits': TERRAIN_TILE_UNITS,
        'templates': [],
    }
    for sprite in sprites:
        svg, info = sprite.render()
        (TEMPLATE_DIR / info['file']).write_text(svg, encoding='utf-8')
        manifest['templates'].append(info)
        print(f"{info['file']:<36} {info['width']:>3}x{info['height']:<3} anchor ({info['anchorX']}, {info['anchorY']})")
    (DOCS_DIR / 'driving-templates.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (ROOT / 'source' / 'driving-templates.js').write_text(
        '// Generated by scripts/draw-driving-templates.py. Do not edit by hand.\n'
        '// Placement data for the driving templates in source/img/driving/ (see docs/DRIVING_ART.md).\n'
        'setup.drivingTemplates = ' + json.dumps(manifest, indent='\t') + ';\n', encoding='utf-8')
    (DOCS_DIR / 'driving-preview.svg').write_text(preview(sprites), encoding='utf-8')
    print('Wrote docs/driving-templates.json and docs/driving-preview.svg')


if __name__ == '__main__':
    main()
