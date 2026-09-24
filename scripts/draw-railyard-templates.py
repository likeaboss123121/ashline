#!/usr/bin/env python3
"""Generate Ashline rail yard pixel-art SVG templates: cars, locomotives, and track.

Run:  python3 scripts/draw-railyard-templates.py

Writes:
  source/img/railyard/*.svg        templates (Tweego bundles them as image passages)
  docs/railyard-templates.json     placement data for every template
  docs/railyard-preview.svg        a composed yard built only from the templates

Palette and style follow the rail-yard mockup. The projection is 2:1 pixel isometric,
so track lines fall on whole pixels, tiles repeat without seams, and moving a template
along a track is a whole-pixel translation.

World axes (2 units = 1 metre):
  u  along a track, increasing toward the lower right
  v  across tracks, increasing toward the lower left
  z  up; z = 0 is the railhead plane
Screen:  x = u - v,  y = (u + v) / 2 - z

Each template's world origin (u = 0 at the car's rear end or the tile's start, v = 0 on the
track centreline, z = 0) sits at the pixel recorded in data-anchor-x / data-anchor-y.
To place one at world (u, v): left = x(u, v) - anchorX, top = y(u, v) - anchorY.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / 'source' / 'img' / 'railyard'
DOCS_DIR = ROOT / 'docs'

UNITS_PER_METRE = 2
TRACK_SPACING_UNITS = 40
TRACK_TILE_METRES = 10
JUNCTION_METRES = TRACK_SPACING_UNITS // UNITS_PER_METRE  # a Y switch crosses one track spacing at 45 degrees
OVERLAP_UNITS = 0  # pieces meet exactly now that rails paint after every bed; any overlap must be even (2:1 slopes)
RAIL_PARTS = {'rails', 'diagonal-rails', 'diagonal-up-rails', 'branch-rails', 'selection'}  # drawn after every track bed; see railyard-view.js

P = {
    'background': '#151719', 'ground': '#393f38',
    'ballast': '#494c42', 'ballast_selected': '#59574a', 'tie': '#75654d',
    'rail_dark': '#222a2b', 'rail_top': '#b8b6a0', 'selected_edge': '#b9a063',
    'coupler': '#bbb09a', 'coupler_side': '#7f786a', 'coupler_end': '#5f5a50',
    'truck_top': '#383c3b', 'truck_side': '#111416', 'truck_end': '#1a1e20',
    'frame_top': '#454440', 'frame_side': '#232626', 'frame_end': '#1e2022',
    'box_top': '#a87555', 'box_side': '#724b3a', 'box_end': '#4b342d',
    'box_rib': '#bc8660', 'box_door': '#66432f', 'box_door_edge': '#432c28',
    'flat_top': '#8d7859', 'flat_side': '#574633', 'flat_end': '#40362e',
    'flat_plank': '#7b684c', 'flat_stake': '#2e2822',
    'gon_top': '#7b7654', 'gon_side': '#4e4a36', 'gon_end': '#3a3829',
    'gon_floor': '#2a2922', 'gon_rib': '#8a8560',
    'tank_top': '#6d7371', 'tank_side': '#3f4543', 'tank_end': '#2e3332', 'tank_dark': '#202424',
    'walkway_top': '#55584f', 'walkway_side': '#2d302c', 'walkway_end': '#242725',
    'loco_top': '#7a8780', 'loco_side': '#495b58', 'loco_end': '#303e3e',
    'cab_top': '#9aa092', 'cab_side': '#3d5558', 'cab_end': '#293b40',
    'window': '#dec38a', 'vent': '#273c3e', 'stripe': '#c6975d',
    'steam_top': '#4a5150', 'steam_side': '#2c3131', 'steam_end': '#1f2323', 'steam_dark': '#171a1a',
    'smokebox_top': '#383c3c', 'smokebox_side': '#1f2222', 'smokebox_end': '#141616',
    'steam_cab_top': '#7a4a3c', 'steam_cab_side': '#5b3a32', 'steam_cab_end': '#3f2923',
    'coal': '#1a1a19', 'coal_top': '#2c2b28', 'rod': '#9aa0a0',
    'prairie_top': '#4f6652', 'prairie_side': '#2f4133', 'prairie_end': '#223026',
    'road_top': '#a0805a', 'road_side': '#6f5338', 'road_end': '#4d3a29', 'road_cab_top': '#b8a07c',
    'road_vent': '#3f3024', 'road_stripe': '#d9c9a0',
    'brass': '#c9a15f', 'wheel_rim': '#1b1f20', 'wheel_hub': '#8c3b2e',
    'buffer_top': '#b5503d', 'buffer_side': '#7d3528', 'buffer_end': '#5a261e',
    'sleeper_top': '#6b5b44', 'sleeper_side': '#4a3e2f', 'sleeper_end': '#382f24',
    # Station buildings.
    'timber_top': '#7d6a4f', 'timber_side': '#5a4a36', 'timber_end': '#403426', 'timber_dark': '#2c241b',
    'hoop': '#2a2d2c', 'leg_top': '#4d4f4b', 'leg_side': '#2f3230', 'leg_end': '#232524',
    'concrete_top': '#9c998d', 'concrete_side': '#78766c', 'concrete_end': '#5a5952', 'concrete_dark': '#3e3d38',
    'chute_top': '#5f5448', 'chute_side': '#433a31', 'chute_end': '#2f2922',
    'oil_top': '#c9c7bb', 'oil_side': '#a3a196', 'oil_end': '#7f7d74', 'oil_dark': '#5a5952', 'oil_band': '#8c3b2e',
    'pump_top': '#6d7a6c', 'pump_side': '#4a5649', 'pump_end': '#343d34',
    'wall_top': '#b89f7a', 'wall_side': '#9a7f5c', 'wall_end': '#735d42',
    'roof_top': '#6e3b30', 'roof_side': '#5a3027', 'roof_end': '#42231d',
    'door': '#3b2a20', 'sign': '#d9c9a0', 'sign_side': '#8c7f64',
}


def px(n):
    return math.floor(n + 0.5)


def project(u, v, z=0.0):
    return (u - v, (u + v) / 2 - z)


def lerp_hex(a, b, t):
    t = max(0.0, min(1.0, t))
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{px(x + (y - x) * t):02x}' for x, y in zip(ca, cb))


def convex_hull(points):
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for pt in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], pt) <= 0:
            lower.pop()
        lower.append(pt)
    for pt in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], pt) <= 0:
            upper.pop()
        upper.append(pt)
    return lower[:-1] + upper[:-1]


class Sprite:
    """Flat-coloured screen polygons, in draw order, grouped into named parts."""

    def __init__(self, name, title, length_m=None):
        self.name = name
        self.title = title
        self.length_m = length_m
        self.parts = []
        self.points = {}

    def part(self, name):
        self.parts.append((name, []))

    def poly(self, points, fill, opacity=1):
        self.parts[-1][1].append(([(px(x), px(y)) for x, y in points], fill, opacity))

    def world_poly(self, points, fill, opacity=1):
        self.poly([project(*pt) for pt in points], fill, opacity)

    def silhouette(self, points3d, fill):
        """Underlay in a dark shade so rounded face edges never show the background."""
        screen = [(px(x), px(y)) for x, y in (project(*pt) for pt in points3d)]
        self.parts[-1][1].append((convex_hull(screen), fill, 1))

    def box(self, u, v, z, length, width, height, top, side, end):
        """Axis-aligned box. Visible faces: the +v side, the +u end, and the top."""
        corners = [(uu, vv, zz) for uu in (u, u + length) for vv in (v, v + width) for zz in (z, z + height)]
        self.silhouette(corners, end)
        self.world_poly([(u, v + width, z), (u + length, v + width, z),
                         (u + length, v + width, z + height), (u, v + width, z + height)], side)
        self.world_poly([(u + length, v, z), (u + length, v + width, z),
                         (u + length, v + width, z + height), (u + length, v, z + height)], end)
        self.world_poly([(u, v, z + height), (u + length, v, z + height),
                         (u + length, v + width, z + height), (u, v + width, z + height)], top)

    def cylinder_u(self, u0, u1, zc, radius, top, side, end, dark, sides=12):
        """Faceted cylinder lying along the track, centred on v = 0 (boilers, tanks)."""
        section = [(radius * math.cos(2 * math.pi * i / sides), zc + radius * math.sin(2 * math.pi * i / sides))
                   for i in range(sides)]
        self.silhouette([(uu, vv, zz) for uu in (u0, u1) for vv, zz in section], dark)
        for i in range(sides):
            (va, za), (vb, zb) = section[i], section[(i + 1) % sides]
            angle = math.atan2((za + zb) / 2 - zc, (va + vb) / 2)
            if math.cos(angle) + math.sin(angle) <= 0.05:
                continue  # faces away from the camera, which looks along -(1, 1, 1)
            if angle >= 0:
                fill = lerp_hex(side, top, angle / (math.pi / 2))
            else:
                fill = lerp_hex(side, dark, -angle / (math.pi / 4))
            self.world_poly([(u0, va, za), (u1, va, za), (u1, vb, zb), (u0, vb, zb)], fill)
        self.world_poly([(u1, vv, zz) for vv, zz in section], end)

    def cylinder_z(self, uc, vc, z0, z1, radius, top, side, end, dark, sides=14, band=False):
        """Faceted upright cylinder (tanks, towers). The faces toward +u and +v are the visible ones. A band (a hoop,
        a painted stripe) is only its visible faces, with no underlay or top to cover what it wraps."""
        ring = [(uc + radius * math.cos(2 * math.pi * i / sides), vc + radius * math.sin(2 * math.pi * i / sides))
                for i in range(sides)]
        if not band:
            self.silhouette([(uu, vv, zz) for uu, vv in ring for zz in (z0, z1)], dark)
        for i in range(sides):
            (ua, va), (ub, vb) = ring[i], ring[(i + 1) % sides]
            angle = math.atan2((va + vb) / 2 - vc, (ua + ub) / 2 - uc)
            if math.cos(angle) + math.sin(angle) <= 0.05:
                continue
            fill = lerp_hex(end, side, (math.sin(angle) + 1) / 2)
            self.world_poly([(ua, va, z0), (ub, vb, z0), (ub, vb, z1), (ua, va, z1)], fill)
        if not band:
            self.world_poly([(uu, vv, z1) for uu, vv in ring], top)

    def cone(self, uc, vc, z, radius, height, top, side, dark, sides=14):
        """A conical roof on an upright cylinder of the same radius."""
        ring = [(uc + radius * math.cos(2 * math.pi * i / sides), vc + radius * math.sin(2 * math.pi * i / sides))
                for i in range(sides)]
        apex = (uc, vc, z + height)
        self.silhouette([(uu, vv, z) for uu, vv in ring] + [apex], dark)
        for i in range(sides):
            (ua, va), (ub, vb) = ring[i], ring[(i + 1) % sides]
            angle = math.atan2((va + vb) / 2 - vc, (ua + ub) / 2 - uc)
            if math.cos(angle) + math.sin(angle) <= -0.4:
                continue
            fill = lerp_hex(side, top, (math.cos(angle) + math.sin(angle) + 1.5) / 3)
            self.world_poly([(ua, va, z), (ub, vb, z), apex], fill)

    def disc_side(self, uc, v, zc, radius, rim, hub, sides=10):
        """A wheel face on the +v side of the train."""
        for r, colour in ((radius, rim), (radius * 0.45, hub)):
            self.world_poly([(uc + r * math.cos(2 * math.pi * i / sides), v, zc + r * math.sin(2 * math.pi * i / sides))
                             for i in range(sides)], colour)

    def line_u(self, u0, u1, v, z, fill, thickness=1, opacity=1):
        """A line along the track, `thickness` whole pixels tall."""
        (x0, y0), (x1, y1) = project(u0, v, z), project(u1, v, z)
        x0, y0, x1, y1 = px(x0), px(y0), px(x1), px(y1)
        self.parts[-1][1].append(([(x0, y0), (x1, y1), (x1, y1 + thickness), (x0, y0 + thickness)], fill, opacity))

    def line_z(self, u, v, z0, z1, fill):
        """A vertical line one pixel wide."""
        (x, y_top), (_, y_bottom) = project(u, v, z1), project(u, v, z0)
        x, y_top, y_bottom = px(x), px(y_top), px(y_bottom)
        self.parts[-1][1].append(([(x, y_top), (x + 1, y_top), (x + 1, y_bottom), (x, y_bottom)], fill, 1))

    def mark(self, key, u, v, z):
        """Record a world point (label or shortcut spot) to publish in placement data."""
        self.points[key] = project(u, v, z)

    def bounds(self):
        xs = [x for _, polys in self.parts for pts, *_ in polys for x, _ in pts]
        ys = [y for _, polys in self.parts for pts, *_ in polys for _, y in pts]
        return min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1

    def render(self):
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
                 f'<title>Ashline rail yard template: {self.title}</title>']
        for name, polys in self.parts:
            lines.append(f'<g id="{name}">')
            for pts, fill, opacity in polys:
                extra = f' fill-opacity="{opacity}"' if opacity < 1 else ''
                lines.append('<polygon points="' + ' '.join(f'{x + ax},{y + ay}' for x, y in pts) + f'" fill="{fill}"{extra}/>')
            lines.append('</g>')
        lines.append('</svg>')
        return '\n'.join(lines) + '\n', info


# Rolling stock ---------------------------------------------------------------

def coupler(s, u):
    s.part('coupler')
    s.box(u - 1, -1, 3, 2, 2, 1, P['coupler'], P['coupler_side'], P['coupler_end'])


def running_gear(s, length):
    coupler(s, 0)
    s.part('trucks')
    for start in (3, length - 9):
        s.box(start, -6, 0, 6, 12, 3, P['truck_top'], P['truck_side'], P['truck_end'])
    s.part('underframe')
    s.box(0, -5, 3, length, 10, 2, P['frame_top'], P['frame_side'], P['frame_end'])


def finish_car(s, length, top_z):
    coupler(s, length)
    s.mark('rear', 0, 0, 4)
    s.mark('front', length, 0, 4)
    s.mark('top', length / 2, 0, top_z)


def boxcar(length_m=12):
    L = length_m * UNITS_PER_METRE
    s = Sprite('railyard-car-boxcar', 'Boxcar', length_m)
    running_gear(s, L)
    s.part('body')
    s.box(1, -5, 5, L - 2, 10, 10, P['box_top'], P['box_side'], P['box_end'])
    door0, door1 = L / 2 - 3, L / 2 + 3
    s.part('ribs')
    for u in range(3, L - 1, 4):
        if not door0 - 1 <= u <= door1 + 1:
            s.line_z(u, 5, 5, 15, P['box_rib'])
    s.part('door')
    s.world_poly([(door0, 5, 5), (door1, 5, 5), (door1, 5, 14), (door0, 5, 14)], P['box_door'])
    s.line_z(door0, 5, 5, 14, P['box_door_edge'])
    s.line_z(door1, 5, 5, 14, P['box_door_edge'])
    s.line_u(door0 - 3, door1 + 3, 5, 14, P['box_door_edge'])
    finish_car(s, L, 15)
    return s



def passenger_car(kind, length_m):
    L = length_m * UNITS_PER_METRE
    s = Sprite('railyard-car-' + kind, kind.replace('-', ' ').title(), length_m)
    running_gear(s, L)
    colours = {'passenger': '#495b58', 'sleeper': '#454d66', 'observation': '#626951',
               'kitchen': '#756c56', 'private': '#69483f'}
    s.part('body')
    s.box(1, -5, 5, L - 2, 10, 10, '#92968a', colours[kind], '#353d3a')
    s.part('windows')
    step = 7 if kind == 'sleeper' else 6
    for u in range(5, L - 5, step):
        width = 2 if kind == 'kitchen' else 4
        s.world_poly([(u, 5, 10), (u + width, 5, 10), (u + width, 5, 14), (u, 5, 14)], '#273c3e')
    s.part('doors')
    for u in (2, L - 4):
        s.line_z(u, 5, 5, 14, '#b8b6a0')
    s.line_u(2, L - 2, 5, 8, '#c6975d')
    if kind == 'observation':
        s.part('glass-roof')
        s.box(L / 3, -4, 15, L / 3, 8, 3, '#a3b9b7', '#647e80', '#465f65')
    if kind == 'kitchen':
        s.part('vents')
        for u in range(8, L - 8, 8):
            s.box(u, -2, 15, 3, 4, 2, '#7a8780', '#3d5558', '#273c3e')
    finish_car(s, L, 18 if kind == 'observation' else 17 if kind == 'kitchen' else 15)
    return s


def flatcar(length_m=14):
    L = length_m * UNITS_PER_METRE
    s = Sprite('railyard-car-flatcar', 'Flatcar', length_m)
    running_gear(s, L)
    s.part('deck')
    s.box(1, -5, 5, L - 2, 10, 2, P['flat_top'], P['flat_side'], P['flat_end'])
    s.line_u(2, L - 2, -2, 7, P['flat_plank'])
    s.line_u(2, L - 2, 2, 7, P['flat_plank'])
    s.part('stakes')
    for u in range(4, L - 2, 6):
        s.line_z(u, 5, 7, 10, P['flat_stake'])
    finish_car(s, L, 7)
    return s


def gondola(length_m=13):
    L = length_m * UNITS_PER_METRE
    s = Sprite('railyard-car-gondola', 'Gondola', length_m)
    running_gear(s, L)
    s.part('floor')
    s.world_poly([(1, -5, 5), (L - 1, -5, 5), (L - 1, 5, 5), (1, 5, 5)], P['gon_floor'])
    s.part('walls')
    s.box(1, -5, 5, L - 2, 1, 6, P['gon_top'], P['gon_side'], P['gon_end'])
    s.box(1, -4, 5, 1, 8, 6, P['gon_top'], P['gon_side'], P['gon_end'])
    s.box(1, 4, 5, L - 2, 1, 6, P['gon_top'], P['gon_side'], P['gon_end'])
    s.box(L - 2, -4, 5, 1, 8, 6, P['gon_top'], P['gon_side'], P['gon_end'])
    s.part('ribs')
    for u in range(3, L - 2, 4):
        s.line_z(u, 5, 5, 11, P['gon_rib'])
    finish_car(s, L, 11)
    return s


def tanker(length_m=14):
    L = length_m * UNITS_PER_METRE
    s = Sprite('railyard-car-tanker', 'Tanker car', length_m)
    running_gear(s, L)
    s.part('walkway')
    s.box(1, -5, 5, L - 2, 10, 1, P['walkway_top'], P['walkway_side'], P['walkway_end'])
    s.part('tank')
    s.cylinder_u(2, L - 2, 10.5, 4.5, P['tank_top'], P['tank_side'], P['tank_end'], P['tank_dark'])
    s.part('dome')
    s.box(L / 2 - 2, -2, 14, 4, 4, 2, P['tank_top'], P['tank_side'], P['tank_end'])
    finish_car(s, L, 16)
    return s


# Station buildings -------------------------------------------------------------
# Each stands beside the yard, behind the farthest track. Its origin is the corner nearest the tracks at its low-u
# end, on the ground: the building spans u from 0 along the track and v back from 0, away from it.

def water_tower():
    s = Sprite('railyard-building-water-tower', 'Water tower')
    uc, vc, r = 10, -10, 8
    s.part('legs')
    for du, dv in ((-5, -5), (5, -5), (-5, 5), (5, 5)):
        s.box(uc + du - 1, vc + dv - 1, 0, 2, 2, 16, P['leg_top'], P['leg_side'], P['leg_end'])
    for dv in (-5, 5):  # cross bracing between the legs
        s.box(uc - 5, vc + dv - 0.5, 8, 10, 1, 1, P['leg_top'], P['leg_side'], P['leg_end'])
    s.part('tank')
    s.cylinder_z(uc, vc, 16, 28, r, P['timber_top'], P['timber_side'], P['timber_end'], P['timber_dark'])
    for z in (18, 23):
        s.cylinder_z(uc, vc, z, z + 1, r + 0.4, P['hoop'], P['hoop'], P['hoop'], P['hoop'], band=True)
    s.part('roof')
    s.cone(uc, vc, 28, r + 1, 6, P['roof_top'], P['roof_side'], P['roof_end'])
    s.part('spout')
    s.box(uc - 1, vc + r - 1, 20, 2, 9, 2, P['leg_top'], P['leg_side'], P['leg_end'])
    s.box(uc - 1, vc + r + 7, 14, 2, 2, 7, P['leg_top'], P['leg_side'], P['leg_end'])
    s.mark('top', uc, vc, 34)
    return s


def coal_tower():
    s = Sprite('railyard-building-coal-tower', 'Coal tower')
    s.part('legs')
    for u0, v0 in ((0, -26), (16, -26), (0, -8), (16, -8)):
        s.box(u0, v0, 0, 4, 4, 14, P['concrete_top'], P['concrete_side'], P['concrete_end'])
    s.part('bin')
    s.box(0, -26, 14, 20, 22, 26, P['concrete_top'], P['concrete_side'], P['concrete_end'])
    s.world_poly([(2, -24, 40), (18, -24, 40), (18, -6, 40), (2, -6, 40)], P['coal_top'])  # coal heaped in the bin
    s.part('house')
    s.box(4, -20, 40, 12, 10, 8, P['concrete_top'], P['concrete_side'], P['concrete_end'])
    s.box(4, -20, 48, 12, 10, 1, P['roof_end'], P['roof_end'], P['roof_end'])
    s.part('chute')
    s.box(8, -4, 16, 4, 10, 3, P['chute_top'], P['chute_side'], P['chute_end'])
    s.world_poly([(8, 6, 16), (12, 6, 16), (12, 8, 13), (8, 8, 13)], P['chute_end'])
    s.mark('top', 10, -15, 49)
    return s


def diesel_tank():
    s = Sprite('railyard-building-diesel-tank', 'Diesel tank')
    uc, vc, r = 12, -14, 10
    s.part('bund')
    s.box(uc - 12, vc - 12, 0, 24, 24, 1, P['concrete_top'], P['concrete_side'], P['concrete_end'])
    s.part('tank')
    s.cylinder_z(uc, vc, 1, 17, r, P['oil_top'], P['oil_side'], P['oil_end'], P['oil_dark'])
    s.cylinder_z(uc, vc, 11, 13, r + 0.3, P['oil_band'], P['oil_band'], P['oil_band'], P['oil_band'], band=True)
    s.cylinder_z(uc, vc, 17, 18, r - 3, P['oil_top'], P['oil_side'], P['oil_end'], P['oil_dark'])
    s.part('pump')
    s.box(26, -8, 0, 6, 6, 6, P['pump_top'], P['pump_side'], P['pump_end'])
    s.box(22, -3, 2, 10, 2, 2, P['leg_top'], P['leg_side'], P['leg_end'])  # the pipe to the fuelling point
    s.box(30, -1, 0, 2, 3, 8, P['pump_top'], P['pump_side'], P['pump_end'])
    s.mark('top', uc, vc, 19)
    return s


def station_hq():
    s = Sprite('railyard-building-station-hq', 'Station HQ')
    L, back, front, wall = 32, -16, -2, 12
    ridge_v, ridge_z = (back + front) / 2, wall + 8
    s.part('walls')
    s.box(0, back, 0, L, front - back, wall, P['wall_top'], P['wall_side'], P['wall_end'])
    s.part('openings')
    s.world_poly([(14, front, 0), (18, front, 0), (18, front, 7), (14, front, 7)], P['door'])
    for u0 in (3, 8, 23, 27):
        for z0 in (3, 8):
            s.world_poly([(u0, front, z0), (u0 + 2, front, z0), (u0 + 2, front, z0 + 2), (u0, front, z0 + 2)], P['window'])
    s.world_poly([(L, -12, 3), (L, -9, 3), (L, -9, 6), (L, -12, 6)], P['window'])
    s.part('roof')
    s.silhouette([(0, back - 1, wall), (L + 1, back - 1, wall), (0, front + 1, wall), (L + 1, front + 1, wall),
                  (0, ridge_v, ridge_z), (L + 1, ridge_v, ridge_z)], P['roof_end'])
    s.world_poly([(-1, front + 1, wall), (L + 1, front + 1, wall), (L + 1, ridge_v, ridge_z), (-1, ridge_v, ridge_z)], P['roof_top'])
    s.world_poly([(L, back, wall), (L, front, wall), (L, ridge_v, ridge_z)], P['wall_end'])
    s.part('chimney')
    s.box(6, ridge_v - 1, ridge_z - 3, 3, 3, 6, P['concrete_top'], P['concrete_side'], P['concrete_end'])
    s.part('sign')
    s.box(12, front, 8, 8, 1, 3, P['sign'], P['sign'], P['sign_side'])
    s.mark('top', L / 2, ridge_v, ridge_z + 2)
    return s


def mirror(length, facing):
    """Map a part's start and length to world u for a locomotive facing right or left."""
    if facing == 'right':
        return lambda u, size=0: u
    return lambda u, size=0: length - u - size


def in_depth_order(items):
    """Draw (centre u, draw) pairs far end first. Faces toward +u are the visible ends, so a part further along u
    paints over its neighbour, whichever way the locomotive faces."""
    for _, draw in sorted(items, key=lambda item: item[0]):
        draw()


def side_window(s, u, length, v, z0, z1):
    s.world_poly([(u, v, z0), (u + length, v, z0), (u + length, v, z1), (u, v, z1)], P['window'])


def coupling_rod(s, U, u0, u1, z):
    a, b = sorted((U(u0), U(u1)))
    s.line_u(a, b, 5.4, z, P['rod'])


def diesel_shunter(facing, length_m=9):
    """A two axle diesel shunter: axles in a rigid frame, a cab at the rear and the engine hood ahead of it."""
    L = length_m * UNITS_PER_METRE
    U = mirror(L, facing)
    s = Sprite(f'railyard-loco-diesel-shunter-{facing}', f'Two axle diesel shunter, facing {facing}', length_m)
    coupler(s, 0)
    s.part('frame')
    s.box(0, -5, 3, L, 10, 2, P['frame_top'], P['frame_side'], P['frame_end'])
    s.line_u(0, L, 5, 4, P['stripe'])
    s.part('wheels')
    for uc in sorted((4.5, 13.5), key=U):
        s.box(U(uc - 1.5, 3), 4, 3.2, 3, 1.5, 1.6, P['truck_top'], P['truck_side'], P['truck_end'])
        s.disc_side(U(uc), 5.5, 2.2, 2.2, P['wheel_rim'], P['wheel_hub'])
    coupling_rod(s, U, 4.5, 13.5, 2.2)

    def cab():
        s.part('cab')
        s.box(U(1, 7), -5, 5, 7, 10, 12, P['cab_top'], P['cab_side'], P['cab_end'])
        side_window(s, U(2.5, 4), 4, 5, 11, 14.5)
        end = U(1, 7) + 7
        s.world_poly([(end, -3, 11), (end, 3, 11), (end, 3, 14.5), (end, -3, 14.5)], P['window'])
        s.box(U(0.5, 8), -5.5, 17, 8, 11, 1, P['cab_top'], P['cab_side'], P['cab_end'])

    def hood():
        s.part('hood')
        s.box(U(8, 9), -3.5, 5, 9, 7, 7, P['loco_top'], P['loco_side'], P['loco_end'])
        for u in (10, 12, 14):
            s.line_z(U(u), 3.5, 6, 10, P['vent'])
        s.box(U(11.5, 2), -1, 12, 2, 2, 2, P['truck_top'], P['vent'], P['vent'])
        s.box(U(16, 1), -1, 9, 1, 2, 1, P['window'], P['brass'], P['brass'])

    in_depth_order([(U(4.5), cab), (U(12.5), hood)])
    finish_car(s, L, 18)
    s.mark('cab', U(4.5), 0, 18)
    return s


def diesel_road(facing, length_m=20):
    """A six axle road diesel: two three axle trucks, a long hood, the cab, and a short nose."""
    L = length_m * UNITS_PER_METRE
    U = mirror(L, facing)
    s = Sprite(f'railyard-loco-diesel-road-{facing}', f'Six axle road diesel, facing {facing}', length_m)
    coupler(s, 0)
    s.part('trucks')
    for start in sorted((3, 26), key=lambda u: U(u, 11)):
        s.box(U(start, 11), -6, 0, 11, 12, 3, P['truck_top'], P['truck_side'], P['truck_end'])
        for offset in sorted((2, 5.5, 9), key=lambda o: U(start + o)):
            s.disc_side(U(start + offset), 6, 1.6, 1.5, P['wheel_rim'], P['wheel_hub'])
    s.part('fuel-tank')
    s.box(U(15, 10), -4, 1, 10, 8, 2, P['truck_top'], P['frame_side'], P['frame_end'])
    s.part('frame')
    s.box(0, -5, 3, L, 10, 2, P['frame_top'], P['frame_side'], P['frame_end'])
    s.line_u(0, L, 5, 4, P['road_stripe'])

    def long_hood():
        s.part('long-hood')
        s.box(U(2, 25), -3.5, 5, 25, 7, 8, P['road_top'], P['road_side'], P['road_end'])
        for u in (5, 8, 11, 14, 17, 20, 23):
            s.line_z(U(u), 3.5, 6, 11, P['road_vent'])
        for u in sorted((4, 9), key=lambda u: U(u, 3)):
            s.box(U(u, 3), -2, 13, 3, 4, 1, P['road_vent'], P['road_vent'], P['road_vent'])
        s.box(U(17, 2), -1, 13, 2, 2, 2, P['truck_top'], P['vent'], P['vent'])

    def cab():
        s.part('cab')
        s.box(U(27, 8), -5, 5, 8, 10, 12, P['road_cab_top'], P['road_side'], P['road_end'])
        side_window(s, U(29, 4), 4, 5, 12, 15)
        front = U(27, 8) + 8
        s.world_poly([(front, -3, 12), (front, 3, 12), (front, 3, 15), (front, -3, 15)], P['window'])
        s.box(U(26.5, 9), -5.5, 17, 9, 11, 1, P['road_cab_top'], P['road_side'], P['road_end'])

    def nose():
        s.part('short-hood')
        s.box(U(35, 4), -3.5, 5, 4, 7, 6, P['road_top'], P['road_side'], P['road_end'])
        s.box(U(37, 1), -1, 11, 1, 2, 1, P['window'], P['brass'], P['brass'])

    in_depth_order([(U(14.5), long_hood), (U(31), cab), (U(37), nose)])
    finish_car(s, L, 18)
    s.mark('cab', U(31), 0, 18)
    return s


def steam_shunter(facing, length_m=10):
    """An 0-6-0 tank engine: three coupled axles, side tanks along the boiler, and a coal bunker behind the cab."""
    L = length_m * UNITS_PER_METRE
    U = mirror(L, facing)
    s = Sprite(f'railyard-loco-steam-shunter-{facing}', f'0-6-0 steam shunter, facing {facing}', length_m)
    coupler(s, 0)
    s.part('frame')
    s.box(0, -4, 3, L, 8, 2, P['frame_top'], P['frame_side'], P['frame_end'])
    s.part('wheels')
    for uc in sorted((5.5, 10.5, 15.5), key=U):
        s.disc_side(U(uc), 5, 2.4, 2.4, P['wheel_rim'], P['wheel_hub'])
    coupling_rod(s, U, 5.5, 15.5, 2.4)
    s.part('running-board')
    s.box(1, -5, 5, L - 2, 10, 1, P['walkway_top'], P['walkway_side'], P['walkway_end'])

    def bunker():
        s.part('bunker')
        s.box(U(0.5, 3), -5, 6, 3, 10, 7, P['steam_cab_top'], P['steam_cab_side'], P['steam_cab_end'])
        s.box(U(0.5, 3), -4, 13, 3, 8, 1, P['coal_top'], P['coal'], P['coal'])

    def cab():
        s.part('cab')
        s.box(U(3.5, 6), -5, 6, 6, 10, 11, P['steam_cab_top'], P['steam_cab_side'], P['steam_cab_end'])
        side_window(s, U(4.5, 3), 3, 5, 12, 15)
        s.box(U(3, 7), -5.5, 17, 7, 11, 1, P['steam_cab_top'], P['steam_cab_side'], P['steam_cab_end'])

    def boiler():
        s.part('boiler')
        s.box(U(9.5, 7), -5, 6, 7, 3.5, 6, P['steam_top'], P['steam_side'], P['steam_end'])
        s.cylinder_u(U(9.5, 7), U(9.5, 7) + 7, 11, 4, P['steam_top'], P['steam_side'], P['steam_end'], P['steam_dark'])
        s.box(U(12, 2), -1.5, 14.5, 2, 3, 2, P['brass'], P['steam_side'], P['steam_end'])
        s.box(U(9.5, 7), 1.5, 6, 7, 3.5, 6, P['steam_top'], P['steam_side'], P['steam_end'])
        s.line_u(U(9.5, 7), U(9.5, 7) + 7, 5, 9, P['brass'])

    def smokebox():
        s.part('smokebox')
        s.cylinder_u(U(16.5, 3), U(16.5, 3) + 3, 11, 4.3, P['smokebox_top'], P['smokebox_side'], P['smokebox_end'], P['steam_dark'])
        s.box(U(17, 2), -1, 15, 2, 2, 4, P['smokebox_top'], P['smokebox_side'], P['smokebox_end'])

    in_depth_order([(U(2), bunker), (U(6.5), cab), (U(13), boiler), (U(18), smokebox)])
    finish_car(s, L, 19)
    s.mark('cab', U(6.5), 0, 17)
    return s


def steam_prairie(facing, length_m=23):
    """A 2-6-2 with its tender, drawn and handled as one vehicle: the tender at the rear, then the cab, a trailing
    axle, three drivers, a leading axle under the smokebox."""
    L = length_m * UNITS_PER_METRE
    U = mirror(L, facing)
    s = Sprite(f'railyard-loco-steam-prairie-{facing}', f'2-6-2 steam engine with tender, facing {facing}', length_m)
    coupler(s, 0)
    s.part('tender-trucks')
    for start in sorted((1.5, 8.5), key=lambda u: U(u, 5)):
        s.box(U(start, 5), -6, 0, 5, 12, 3, P['truck_top'], P['truck_side'], P['truck_end'])
    s.part('frame')
    s.box(0, -4, 3, L, 8, 2, P['frame_top'], P['frame_side'], P['frame_end'])
    s.part('wheels')
    for uc, r in sorted(((20.5, 2), (26.5, 3.2), (32.5, 3.2), (38.5, 3.2), (43.5, 2)), key=lambda w: U(w[0])):
        s.disc_side(U(uc), 5, r, r, P['wheel_rim'], P['wheel_hub'])
    coupling_rod(s, U, 26.5, 38.5, 3.2)

    def tender():
        s.part('tender')
        s.box(U(0.5, 14), -5, 5, 14, 10, 8, P['prairie_top'], P['prairie_side'], P['prairie_end'])
        s.box(U(8, 6.5), -4, 13, 6.5, 8, 1.5, P['coal_top'], P['coal'], P['coal'])
        s.box(U(2.5, 2), -1, 13, 2, 2, 0.5, P['frame_top'], P['frame_side'], P['frame_end'])

    def cab():
        s.part('cab')
        s.box(U(17, 7), -5, 6, 7, 10, 12, P['prairie_top'], P['prairie_side'], P['prairie_end'])
        side_window(s, U(18.5, 3.5), 3.5, 5, 12, 15.5)
        s.box(U(16.5, 8), -5.5, 18, 8, 11, 1, P['prairie_top'], P['prairie_side'], P['prairie_end'])

    def boiler():
        s.part('boiler')
        s.box(U(24, 21.5), -5, 6, 21.5, 10, 1, P['walkway_top'], P['walkway_side'], P['walkway_end'])
        s.cylinder_u(U(24, 17), U(24, 17) + 17, 12, 4.5, P['prairie_top'], P['prairie_side'], P['prairie_end'], P['steam_dark'])
        s.line_u(U(25, 15), U(25, 15) + 15, 4.5, 12, P['brass'])
        for u, colour in sorted(((30, P['brass']), (35, P['prairie_top'])), key=lambda d: U(d[0], 2.5)):
            s.box(U(u, 2.5), -1.5, 16, 2.5, 3, 2, colour, P['prairie_side'], P['prairie_end'])

    def front():
        s.part('smokebox')
        s.box(U(39.5, 4.5), 3, 3, 4.5, 3, 4, P['steam_top'], P['steam_side'], P['steam_end'])
        s.cylinder_u(U(41, 5), U(41, 5) + 5, 12, 4.8, P['smokebox_top'], P['smokebox_side'], P['smokebox_end'], P['steam_dark'])
        s.box(U(42.5, 2.5), -1.25, 16.5, 2.5, 2.5, 5, P['smokebox_top'], P['smokebox_side'], P['smokebox_end'])
        s.box(U(45, 1), -1, 11, 1, 2, 1.5, P['window'], P['brass'], P['brass'])

    in_depth_order([(U(7.5), tender), (U(20.5), cab), (U(32.5), boiler), (U(43.5), front)])
    finish_car(s, L, 22)
    s.mark('cab', U(20.5), 0, 18)
    return s


# Track -----------------------------------------------------------------------

def track_tile(selected):
    T = TRACK_TILE_METRES * UNITS_PER_METRE
    name = 'railyard-track-tile-selected' if selected else 'railyard-track-tile'
    s = Sprite(name, 'Track tile, selected' if selected else 'Track tile', TRACK_TILE_METRES)
    s.part('ballast')
    # Pieces meet exactly (OVERLAP_UNITS is 0). With rails painted after every bed, abutting tiles render like one
    # continuous track, and an overlap would leave rail stubs where a line turns into a switch or stops.
    s.world_poly([(0, -8, 0), (T + OVERLAP_UNITS, -8, 0), (T + OVERLAP_UNITS, 8, 0), (0, 8, 0)],
                 P['ballast_selected'] if selected else P['ballast'])
    s.part('ties')
    for u in range(1, T, 5):
        s.world_poly([(u, -5, 0), (u + 2, -5, 0), (u + 2, 5, 0), (u, 5, 0)], P['tie'])
    s.part('rails')
    for v in (-3, 3):
        s.line_u(0, T + OVERLAP_UNITS, v, 1, P['rail_dark'], thickness=2)
        s.line_u(0, T + OVERLAP_UNITS, v, 1, P['rail_top'])
    if selected:
        s.part('selection')
        for v in (-9, 9):
            s.line_u(0, T + OVERLAP_UNITS, v, 0, P['selected_edge'])
    return s


def buffer_stop():
    s = Sprite('railyard-track-buffer-stop', 'Buffer stop (place at a track end)')
    s.part('sleepers')
    s.box(-5, -5, 0, 5, 10, 3, P['sleeper_top'], P['sleeper_side'], P['sleeper_end'])
    s.part('beam')
    s.box(-2, -6, 3, 2, 12, 2, P['buffer_top'], P['buffer_side'], P['buffer_end'])
    s.mark('top', -1, 0, 5)
    return s


def straight_track(s, v, length):
    """Straight track along u at a fixed v, for use inside junction templates."""
    s.part('ballast')
    s.world_poly([(0, v - 8, 0), (length + OVERLAP_UNITS, v - 8, 0), (length + OVERLAP_UNITS, v + 8, 0), (0, v + 8, 0)], P['ballast'])
    s.part('ties')
    for u in range(1, length, 5):
        s.world_poly([(u, v - 5, 0), (u + 2, v - 5, 0), (u + 2, v + 5, 0), (u, v + 5, 0)], P['tie'])
    s.part('rails')
    for offset in (-3, 3):
        s.line_u(0, length + OVERLAP_UNITS, v + offset, 1, P['rail_dark'], thickness=2)
        s.line_u(0, length + OVERLAP_UNITS, v + offset, 1, P['rail_top'])


def ladder_diagonal(s, up=False, u0=0, v0=0):
    """Track crossing to a neighbouring track within one track spacing, starting at world (u0, v0).

    Down diagonals go to the next track over (+v). A 45-degree diagonal in the world is then a vertical
    line on screen, with pixel-column rails and horizontal-bar ties.

    Up diagonals go to the previous track (-v) while still moving forward along u, so this straight track projects
    as a horizontal line. Its perpendicular runs along (1, 1), so sleepers project vertically. Rotate the
    ordinary track's widths into that perpendicular before projecting, and miter the ends against the adjoining
    track. Rails retain the ordinary track's one-unit elevation above the sleepers.

    Both rails run the full length, so where a diagonal meets a track, one rail joins that track's near rail
    and the other crosses it to join the far rail.
    """
    S = TRACK_SPACING_UNITS
    name = 'diagonal-up' if up else 'diagonal'
    if up:
        x0, y0 = project(u0, v0)
        span = 2 * S

        def edge(distance, z=0):
            # Intersect the horizontal edge with the adjoining 2:1 line after pixel snapping. Using the
            # same rounding as line_u keeps the railhead continuous at split, merge and plain-tile joints.
            y = px(distance / math.sqrt(2) - z)
            x = px(-distance) + 2 * (y - px(distance / 2 - z))
            return [(x0 + x, y0 + y), (x0 + span + x, y0 + y)]

        s.part(f'{name}-ballast')
        s.poly(edge(-8) + list(reversed(edge(8))), P['ballast'])
        # Fill the wedges between the miter and the adjoining tile's cross-section as well. Otherwise
        # the rails can join above a triangular hole in the gravel at the outside of the corner.
        for distance in (-8, 8):
            for i, endpoint in enumerate(edge(distance)):
                centre = (x0 + i * span, y0)
                tile_edge = (centre[0] + px(-distance), centre[1] + px(distance / 2))
                s.poly([centre, endpoint, tile_edge], P['ballast'])
        s.part(f'{name}-ties')
        # Eight-pixel pitch divides the piece evenly, including across chained ladder pieces.
        # A two-unit sleeper thickness projects to roughly three pixels along this direction.
        for x in range(4, span, 8):
            s.poly([(x0 + x - 1, y0 - 4), (x0 + x + 2, y0 - 4),
                    (x0 + x + 2, y0 + 4), (x0 + x - 1, y0 + 4)], P['tie'])
        s.part(f'{name}-rails')
        for v in (-3, 3):
            rail = edge(v, z=1)
            # The snapped miter may lie a pixel beyond a straight tile's endpoint. Carry the railhead
            # all the way to that actual endpoint, including its thickness, rather than leaving a gap
            # between two mathematically intersecting lines that are clipped to separate templates.
            joints = [(x0 + px(-v), y0 + px(v / 2 - 1)),
                      (x0 + span + px(-v), y0 + px(v / 2 - 1))]
            for thickness, colour in ((2, P['rail_dark']), (1, P['rail_top'])):
                s.poly(rail + list(reversed([(x, y + thickness) for x, y in rail])), colour)
                for end, joint in zip(rail, joints):
                    s.poly([end, joint, (joint[0], joint[1] + thickness),
                            (end[0], end[1] + thickness)], colour)
        return

    s.part(f'{name}-ballast')
    s.world_poly([(u0, v0 - 8, 0), (u0 + S, v0 + S - 8, 0), (u0 + S, v0 + S + 8, 0), (u0, v0 + 8, 0)], P['ballast'])
    s.part(f'{name}-ties')
    # Ties stay 5 units from both ends: a neighbouring piece's bed starts along a line that would clip them.
    for t in range(5, S - 4, 5):
        s.world_poly([(u0 + t + a + b, v0 + t + a - b, 0) for a, b in ((-1, -3), (1, -3), (1, 3), (-1, 3))], P['tie'])
    s.part(f'{name}-rails')
    for offset in (-3, 3):
        (x0, y0), (_, y1) = project(u0, v0 + offset, 1), project(u0 + S, v0 + S + offset, 1)
        s.poly([(x0 - 1, y0), (x0 + 1, y0), (x0 + 1, y1 + 1), (x0 - 1, y1 + 1)], P['rail_dark'])
        s.poly([(x0 - 1, y0), (x0, y0), (x0, y1), (x0 - 1, y1)], P['rail_top'])


def y_switch(merge, up=False):
    """Y intersection where a lead runs straight through and a ladder branches off it.

    split: the through track stays on v = 0 and a diagonal branches off to the neighbouring track.
    merge: a diagonal leaves v = 0 and joins the through track on the neighbouring track.
    up: the neighbouring track is the previous one (-v) instead of the next one (+v).
    """
    S = TRACK_SPACING_UNITS
    kind = 'merge' if merge else 'split'
    s = Sprite(f'railyard-track-y-{kind}' + ('-up' if up else ''), f'Y switch, {kind}' + (', up' if up else ''), JUNCTION_METRES)
    ladder_diagonal(s, up=up)
    straight_track(s, (-S if up else S) if merge else 0, S)
    return s


def yy_switch(merge, up=False):
    """YY intersection: a ladder that continues past this track, with the track branching off it.

    Where Y switches stack on a ladder, the ladder is the through route: its diagonal runs unbroken from the
    track before to the track after. Both of this track's rails run to the ladder's rails and are painted
    before them, so the ladder rails cover the joints; its ties stop at the ladder's bed. The merge is the
    split turned 180 degrees, for the exit ladder, and up versions serve ladders climbing to farther tracks.
    """
    S = TRACK_SPACING_UNITS
    bed = 8
    kind = 'merge' if merge else 'split'
    s = Sprite(f'railyard-track-yy-{kind}' + ('-up' if up else ''), f'YY switch, {kind}' + (', up' if up else ''), JUNCTION_METRES)
    v = (-S if up else S) if merge else 0
    s.part('ballast')
    s.world_poly([(0, v - bed, 0), (S, v - bed, 0), (S, v + bed, 0), (0, v + bed, 0)], P['ballast'])
    s.part('ties')
    for u in range(1, S, 5):
        if up:  # keep branch ties clear of the horizontal ladder bed at the joint
            clear_of_ladder = u + 2 + 5 < S - 2 * bed if merge else u - 5 > 2 * bed
        else:
            clear_of_ladder = u + 2 < S - bed - 5 if merge else u > bed + 5
        if clear_of_ladder:
            s.world_poly([(u, v - 5, 0), (u + 2, v - 5, 0), (u + 2, v + 5, 0), (u, v + 5, 0)], P['tie'])
    s.part('branch-rails')
    for offset in (-3, 3):
        # Full length: at the ladder, one rail joins the ladder's near rail and the other crosses it to join
        # the far rail, as in a real switch.
        s.line_u(0, S, v + offset, 1, P['rail_dark'], thickness=2)
        s.line_u(0, S, v + offset, 1, P['rail_top'])
    ladder_diagonal(s, up=up)  # drawn after the branch, so the ladder reads as continuous
    return s


def diagonal_track(up=False):
    """A ladder diagonal on its own, for passing a track that does not connect at this end."""
    s = Sprite('railyard-track-diagonal' + ('-up' if up else ''), 'Ladder diagonal passing a track that does not connect', JUNCTION_METRES)
    ladder_diagonal(s, up=up)
    return s


def y_split_both():
    """Entry lead in the middle of the yard: it runs straight through, with ladders branching both ways."""
    S = TRACK_SPACING_UNITS
    s = Sprite('railyard-track-y-split-both', 'Y switch branching to both neighbouring tracks', JUNCTION_METRES)
    ladder_diagonal(s)
    ladder_diagonal(s, up=True)
    straight_track(s, 0, S)
    return s


def y_merge_both():
    """Exit lead in the middle of the yard: ladders from both sides join the through track.

    Placed on the exit lead's track one junction before the exit. Its diagonals arrive from the previous
    track (a down diagonal) and from the next track (an up diagonal).
    """
    S = TRACK_SPACING_UNITS
    s = Sprite('railyard-track-y-merge-both', 'Y switch joining from both neighbouring tracks', JUNCTION_METRES)
    ladder_diagonal(s, up=False, u0=0, v0=-S)
    ladder_diagonal(s, up=True, u0=0, v0=S)
    straight_track(s, 0, S)
    return s


def buffer_stop_start():
    """Buffer stop for the start of a dead-end track (its beam faces -u)."""
    s = Sprite('railyard-track-buffer-stop-start', 'Buffer stop (place at a track start)')
    s.part('sleepers')
    s.box(0, -5, 0, 5, 10, 3, P['sleeper_top'], P['sleeper_side'], P['sleeper_end'])
    s.part('beam')
    s.box(0, -6, 3, 2, 12, 2, P['buffer_top'], P['buffer_side'], P['buffer_end'])
    s.mark('top', 1, 0, 5)
    return s


def track_fade(fade_in):
    """A track tile that fades to transparent, for lead tracks that continue off the map."""
    T = TRACK_TILE_METRES * UNITS_PER_METRE
    if fade_in:
        s = Sprite('railyard-track-fade-in', 'Track fading in from off the map (outer end of the entry lead)', TRACK_TILE_METRES)
    else:
        s = Sprite('railyard-track-fade-out', 'Track fading out off the map (outer end of the exit lead)', TRACK_TILE_METRES)
    steps = 5  # 4-unit slices keep every rail segment on the 2:1 pixel grid

    def alpha(u):
        t = min(max(u / T, 0.0), 1.0)
        return round(t if fade_in else 1 - t, 3)

    s.part('ballast')
    for i in range(steps):
        u0, u1 = T * i / steps, T * (i + 1) / steps
        s.world_poly([(u0, -8, 0), (u1, -8, 0), (u1, 8, 0), (u0, 8, 0)], P['ballast'], alpha((u0 + u1) / 2))
    s.part('ties')
    for u in range(1, T, 5):
        s.world_poly([(u, -5, 0), (u + 2, -5, 0), (u + 2, 5, 0), (u, 5, 0)], P['tie'], alpha(u + 1))
    s.part('rails')
    for i in range(steps):
        u0, u1 = T * i / steps, T * (i + 1) / steps
        a = alpha((u0 + u1) / 2)
        for v in (-3, 3):
            s.line_u(u0, u1, v, 1, P['rail_dark'], thickness=2, opacity=a)
            s.line_u(u0, u1, v, 1, P['rail_top'], opacity=a)
    return s


# Output ----------------------------------------------------------------------

def build_all():
    return [
        diesel_shunter('right'), diesel_shunter('left'), diesel_road('right'), diesel_road('left'),
        steam_shunter('right'), steam_shunter('left'), steam_prairie('right'), steam_prairie('left'),
        boxcar(), flatcar(), gondola(), tanker(),
        *[passenger_car(kind, length) for kind, length in
          [('passenger', 24), ('sleeper', 25), ('observation', 23), ('kitchen', 24), ('private', 22)]],
        track_tile(False), track_tile(True), buffer_stop(),
        y_switch(False), y_switch(True), yy_switch(False), yy_switch(True), diagonal_track(),
        y_switch(False, up=True), y_switch(True, up=True), yy_switch(False, up=True), yy_switch(True, up=True),
        diagonal_track(up=True), y_split_both(), y_merge_both(),
        buffer_stop_start(), track_fade(True), track_fade(False),
        water_tower(), coal_tower(), diesel_tank(), station_hq(),
    ]


def preview(sprites):
    """Compose a small yard from the templates, laid out the way the game draws yards."""
    by_name = {s.name: s for s in sprites}
    S, J, T = TRACK_SPACING_UNITS, JUNCTION_METRES, TRACK_TILE_METRES
    section, lead = 60, 40
    yard = [
        [('railyard-car-boxcar', 12), ('railyard-loco-diesel-shunter-right', 9), ('railyard-loco-diesel-road-left', 20)],
        [('railyard-car-gondola', 13), ('railyard-loco-steam-shunter-right', 10), ('railyard-car-tanker', 14)],
        [('railyard-loco-steam-prairie-left', 23), ('railyard-car-flatcar', 14)],
    ]
    n = len(yard)
    last_v = (n - 1) * S
    exit_start = (n + 1) * J + section
    flat = [('railyard-track-fade-in', -lead, 0)]
    flat += [('railyard-track-tile', m, 0) for m in range(-lead + T, 0, T)]
    objects = [('railyard-car-boxcar', -4 - 12, 0), ('railyard-car-flatcar', exit_start + 4, last_v)]
    for i in range(1, n + 1):
        v = (i - 1) * S
        if i < n:
            flat.append(('railyard-track-y-split', (i - 1) * J, v))
        else:
            flat += [('railyard-track-tile', m, v) for m in range((i - 1) * J, i * J, T)]
        flat += [('railyard-track-tile', m, v) for m in range(i * J, i * J + section, T)]
        if i == 1:
            flat += [('railyard-track-tile', m, v) for m in range(i * J + section, (i + 1) * J + section, T)]
        if i < n:
            flat.append(('railyard-track-y-merge', (i + 1) * J + section, v))
        cursor = i * J
        for name, length in yard[i - 1]:
            objects.append((name, cursor, v))
            cursor += length
    flat += [('railyard-track-tile', m, last_v) for m in range(exit_start, exit_start + lead - T, T)]
    flat.append(('railyard-track-fade-out', exit_start + lead - T, last_v))

    ground = Sprite('ground', 'Ground')
    ground.part('ground')
    # One parallelogram: top and bottom follow the tracks, sides follow the vertical ladders.
    half, bottom = 24, last_v + 24
    x_left, x_right = -16, (2 * J + section) * UNITS_PER_METRE + 16
    ground.poly([(x_left, (x_left - 2 * half) / 2), (x_right, (x_right - 2 * half) / 2),
                 (x_right, (x_right + 2 * bottom) / 2), (x_left, (x_left + 2 * bottom) / 2)], P['ground'])
    placed = [(ground, 0, 0)]
    ordered = sorted(flat, key=lambda item: (item[2], item[1])) + sorted(objects, key=lambda item: (item[2], item[1]))
    for name, metres, v in ordered:
        x, y = project(metres * UNITS_PER_METRE, v)
        placed.append((by_name[name], px(x), px(y)))

    # Paint in layers, as the game does: every track bed, then every rail, then everything else.
    # A piece's bed painted after the previous piece's rails would clip those rails at each join.
    xs, ys = [], []
    ground_layer, beds, branch, ladder, rails, rest = [], [], [], [], [], []
    for sprite, dx, dy in placed:
        is_track = any(part_name in RAIL_PARTS for part_name, _ in sprite.parts)
        for part_name, part_polys in sprite.parts:
            if sprite.name == 'ground':
                target = ground_layer
            elif is_track:
                target = (branch if part_name == 'branch-rails' else ladder if part_name in ('diagonal-rails', 'diagonal-up-rails')
                          else rails if part_name in RAIL_PARTS else beds)
            else:
                target = rest
            for pts, fill, opacity in part_polys:
                moved = [(x + dx, y + dy) for x, y in pts]
                target.append((moved, fill, opacity))
                xs += [x for x, _ in moved]
                ys += [y for _, y in moved]
    polys = ground_layer + beds + branch + ladder + rails + rest  # same layer order as the game
    minx, miny, maxx, maxy = min(xs) - 8, min(ys) - 8, max(xs) + 8, max(ys) + 8
    w, h = maxx - minx, maxy - miny
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * 3}" height="{h * 3}" viewBox="0 0 {w} {h}" '
           f'shape-rendering="crispEdges">',
           '<title>Ashline rail yard templates: composed preview</title>',
           f'<rect width="{w}" height="{h}" fill="{P["background"]}"/>']
    for pts, fill, opacity in polys:
        extra = f' fill-opacity="{opacity}"' if opacity < 1 else ''
        out.append('<polygon points="' + ' '.join(f'{x - minx},{y - miny}' for x, y in pts) + f'" fill="{fill}"{extra}/>')
    out.append('</svg>')
    return '\n'.join(out) + '\n'


def main():
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    sprites = build_all()
    manifest = {
        'projection': 'screen x = u - v; screen y = (u + v) / 2 - z',
        'unitsPerMetre': UNITS_PER_METRE,
        'trackSpacingUnits': TRACK_SPACING_UNITS,
        'trackTileMetres': TRACK_TILE_METRES,
        'junctionMetres': JUNCTION_METRES,
        'templates': [],
    }
    for sprite in sprites:
        svg, info = sprite.render()
        (TEMPLATE_DIR / info['file']).write_text(svg, encoding='utf-8')
        manifest['templates'].append(info)
        print(f"{info['file']:<42} {info['width']:>3}x{info['height']:<3} anchor ({info['anchorX']}, {info['anchorY']})")
    (DOCS_DIR / 'railyard-templates.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (ROOT / 'source' / 'railyard-templates.js').write_text(
        '// Generated by scripts/draw-railyard-templates.py. Do not edit by hand.\n'
        '// Placement data for the rail yard templates in source/img/railyard/ (see docs/RAILYARD_ART.md).\n'
        'setup.railyardTemplates = ' + json.dumps(manifest, indent='\t') + ';\n', encoding='utf-8')
    (DOCS_DIR / 'railyard-preview.svg').write_text(preview(sprites), encoding='utf-8')
    print('Wrote docs/railyard-templates.json and docs/railyard-preview.svg')


if __name__ == '__main__':
    main()
