"""Small geometry regressions; no world build, game boot or network access."""
import importlib.util
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from stock_depth import area, clip
from fleet_art import Builder, DATA, blend, locomotive


def generator(view):
    spec = importlib.util.spec_from_file_location(view, ROOT / 'scripts' / ('draw-'+view+'-templates.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULES = [generator(view) for view in ('railyard', 'driving')]


def world(x, y, depth, iso):
    if iso:
        uv = (depth+y)/1.5
        return (uv+x)/2, (uv-x)/2, uv/2-y
    return x, (depth+y/math.cos(math.pi/4))/2, (depth-y/math.cos(math.pi/4))/2


def face(sprite, colour, depth, x0=0, x1=10):
    sprite.part(colour)
    sprite.world_poly([world(x, y, depth(x, y), sprite.depth_iso)
                       for x, y in ((x0,0),(x1,0),(x1,10),(x0,10))], colour)


def coverage(sprite, colour):
    return sum(abs(area(points)) for _, polys in sprite.parts for points, fill, _ in polys if fill == colour)


class StockDepthTests(unittest.TestCase):
    def sprites(self):
        for module in MODULES:
            yield module.Sprite('test-loco-depth', 'Depth fixture', 10)

    def test_near_face_wins_even_when_far_face_is_drawn_last(self):
        for sprite in self.sprites():
            face(sprite, 'red', lambda x,y: 20)
            face(sprite, 'blue', lambda x,y: 10)
            sprite.resolve_depth()
            self.assertAlmostEqual(coverage(sprite, 'red'), 100)
            self.assertAlmostEqual(coverage(sprite, 'blue'), 0)

    def test_intersecting_faces_are_split_not_sorted_by_their_centres(self):
        for sprite in self.sprites():
            face(sprite, 'red', lambda x,y: 10)
            face(sprite, 'blue', lambda x,y: 2*x)
            sprite.resolve_depth()
            self.assertAlmostEqual(coverage(sprite, 'red'), 50, places=4)
            self.assertAlmostEqual(coverage(sprite, 'blue'), 50, places=4)

    def test_coplanar_window_stays_on_body_but_behind_nearer_hood(self):
        for sprite in self.sprites():
            face(sprite, 'body', lambda x,y: 10)
            face(sprite, 'window', lambda x,y: 10, 2, 8)
            face(sprite, 'hood', lambda x,y: 20, 5, 10)
            sprite.resolve_depth()
            self.assertAlmostEqual(coverage(sprite, 'body'), 20, places=4)
            self.assertAlmostEqual(coverage(sprite, 'window'), 30, places=4)
            self.assertAlmostEqual(coverage(sprite, 'hood'), 50, places=4)

    def test_reversing_non_coplanar_face_order_does_not_change_visibility(self):
        for module in MODULES:
            areas = []
            for order in ((0,1,2), (2,1,0)):
                sprite = module.Sprite('test-car-depth', 'Depth fixture', 10)
                for i in order:
                    face(sprite, str(i), lambda x,y,i=i: (10, 2*x, 3*y)[i])
                sprite.resolve_depth()
                areas.append([coverage(sprite, str(i)) for i in range(3)])
            for a, b in zip(*areas):
                self.assertAlmostEqual(a, b, places=3)

    def test_driving_mirror_preserves_resolved_faces_and_anchors(self):
        module = MODULES[1]
        for make, _, _ in module.LOCOMOTIVES:
            right = make()
            left = module.mirrored(right, right.name.replace('right', 'left'), 'Mirror fixture')
            original = right.render()
            self.assertTrue(right.depth_resolved and left.depth_resolved)
            self.assertEqual(right.render(), original, 'rendering is idempotent')
            self.assertEqual(len(right.parts), len(left.parts))
            for (_, a), (_, b) in zip(right.parts, left.parts):
                self.assertEqual(len(a), len(b))
                for (ap, af, ao), (bp, bf, bo) in zip(a, b):
                    self.assertEqual((af, ao), (bf, bo))
                    for (x,y), (mx,my) in zip(ap, bp):
                        self.assertAlmostEqual(x+mx, right.length_m*2)
                        self.assertEqual(y, my)

    def test_non_stock_templates_keep_their_authored_painter_order(self):
        for module in MODULES:
            sprite = module.Sprite('test-terrain-example', 'Not rolling stock')
            sprite.part('scenery')
            sprite.world_poly([(0,0,0),(1,0,0),(1,1,0),(0,1,0)], '#123456')
            original = repr(sprite.parts)
            sprite.resolve_depth()
            self.assertEqual(repr(sprite.parts), original)

    def test_driving_wagon_wheels_are_not_buried_inside_the_truck(self):
        module = MODULES[1]
        sprite = module.boxcar()
        sprite.resolve_depth()
        self.assertGreater(coverage(sprite, module.P['wheel_hub']), 1)

    def test_every_wagon_variant_has_four_round_wheels_in_both_views(self):
        for module in MODULES:
            with patch('fleet_art.write_catalogue'):
                cars = [s for s in module.build_all() if '-car-' in s.name]
            self.assertEqual(len(cars), 26)
            for sprite in cars:
                with self.subTest(sprite=sprite.name):
                    wheels = [pts for name, polygons in sprite.parts if name == 'wheels'
                              for pts, _, _ in polygons]
                    self.assertEqual(len(wheels), 8, 'four rims and four hubs, not truck boxes')
                    for pts in wheels[::2]:
                        self.assertGreaterEqual(len(set(pts)), 8, 'round perimeter survives pixel snapping')
                    sprite.resolve_depth()
                    self.assertGreater(coverage(sprite, module.P['wheel_hub']), 2)

    def test_three_steam_boilers_have_ordered_face_shades_and_closed_end_sections(self):
        for spec in DATA['locomotives']:
            if spec.get('design') not in ('american', 'mikado', 'garratt'):
                continue
            top, side, _ = spec['colours']
            for module in MODULES:
                for facing in ('left', 'right'):
                    sprite = module.Sprite('test-loco-boiler', 'Boiler fixture', 20)
                    iso = module is MODULES[0]
                    b = Builder(vars(module), iso, sprite, 40, facing)
                    b.boiler(10, 20, top, side)
                    colours = [fill for _, polys in sprite.parts for _, fill, _ in polys]
                    self.assertEqual(colours[:4], [top, blend(top,side,.5), side, blend(side,'#000000',.3)])
                    faces = list(sprite.depth_faces.values())
                    self.assertEqual(min(p[2] for face in faces for p in face), 5.5, 'boiler meets chassis top')
                    self.assertEqual(max(p[2] for face in faces for p in face), 14.5)
                    if iso:
                        end = set(faces[-1])
                        for face in faces[:4]:
                            self.assertEqual(sum(p in end for p in face), 2, 'cap and side share their seam')
                    sprite.resolve_depth()
                    for colour in colours[:3]:
                        self.assertGreater(coverage(sprite, colour), 0, 'face shade remains visible')
                    actual = locomotive(vars(module), iso, spec, facing)
                    for name, polys in actual.parts:
                        if name in ('cab','tender','rear-tank','front-tank','smoke-deflector'):
                            self.assertNotIn('#41483f', [fill for _,fill,_ in polys], 'no unrelated default green end')

    def test_mikado_and_garratt_wheels_do_not_intersect_and_rods_meet_axles(self):
        for spec in DATA['locomotives']:
            if spec.get('design') not in ('mikado', 'garratt'):
                continue
            for module in MODULES:
                for facing in ('left','right'):
                    sprite = locomotive(vars(module), module is MODULES[0], spec, facing)
                    rims = [world for (part,index),world in sprite.depth_faces.items()
                            if sprite.parts[part][0] == 'running-gear' and index % 2 == 0]
                    spans = sorted((min(p[0] for p in face),max(p[0] for p in face)) for face in rims)
                    for left, right in zip(spans,spans[1:]):
                        self.assertLessEqual(left[1],right[0], 'adjacent wheels must not intersect')
                    centres = [(sum(p[0] for p in face)/len(face),sum(p[2] for p in face)/len(face)) for face in rims]
                    rods = [world for (part,_),world in sprite.depth_faces.items()
                            if sprite.parts[part][0] == 'coupling-rods']
                    for rod in rods:
                        z = (min(p[2] for p in rod)+max(p[2] for p in rod))/2
                        for u in (min(p[0] for p in rod),max(p[0] for p in rod)):
                            self.assertTrue(any(abs(u-x)<1e-6 and abs(z-y)<1e-6 for x,y in centres))

    def test_shunter_driving_wheels_remain_individually_visible_in_both_facings(self):
        module = MODULES[1]
        for make, axles, radius in ((module.diesel_shunter, (4.5,13.5), 2.2),
                                   (module.steam_shunter, (5.5,10.5,15.5), 2.4)):
            right = make()
            left = module.mirrored(right, right.name.replace('right','left'), 'Left')
            for sprite in (right,left):
                sprite.resolve_depth()
                for axle in axles:
                    centre = axle if sprite is right else sprite.length_m*2-axle
                    rims = [points for name,polys in sprite.parts if name == 'wheels'
                            for points,fill,_ in polys if fill == module.P['truck_top']]
                    visible = sum(abs(area(clip(clip(points, (1,0,radius-centre)),
                                                     (-1,0,centre+radius)))) for points in rims)
                    self.assertGreater(visible,3, f'{sprite.name}: axle {axle} buried in frame')
                self.assertGreater(coverage(sprite,module.P['wheel_hub']),1)

    def test_steam_bogies_physically_join_wheel_hubs_to_chassis(self):
        def bounds(faces):
            points = [p for face in faces for p in face]
            return tuple((min(p[i] for p in points),max(p[i] for p in points)) for i in range(3))

        def touches(a, b):
            return all(lo <= other_hi+1e-6 and other_lo <= hi+1e-6
                       for (lo,hi),(other_lo,other_hi) in zip(a,b))

        counts = {'american':2, 'streamliner':3, 'mikado':4, 'garratt':6}
        for spec in DATA['locomotives']:
            if spec.get('design') not in counts:
                continue
            for module in MODULES:
                for facing in ('left','right'):
                    sprite = locomotive(vars(module), module is MODULES[0], spec, facing)
                    with self.subTest(sprite=sprite.name):
                        faces = [face for (part,_),face in sprite.depth_faces.items()
                                 if sprite.parts[part][0] == 'wheel-carriers']
                        per_box = 3 if module is MODULES[0] else 2
                        boxes = [bounds(faces[i:i+per_box]) for i in range(0,len(faces),per_box)]
                        self.assertEqual(len(boxes), counts[spec['design']]*2)
                        frame = bounds([face for (part,_),face in sprite.depth_faces.items()
                                        if sprite.parts[part][0] == 'frame'])
                        for beam,mount in zip(boxes[::2],boxes[1::2]):
                            self.assertTrue(touches(beam,mount), 'bogie must meet its mounting block')
                            self.assertTrue(touches(mount,frame), 'mount must reach inside chassis')
                        wheels = [face for (part,index),face in sprite.depth_faces.items()
                                  if sprite.parts[part][0] == 'running-gear' and index % 2 == 0]
                        for wheel in wheels:
                            hub = tuple(sum(p[i] for p in wheel)/len(wheel) for i in range(3))
                            if hub[2] <= 2.2+1e-6:
                                self.assertTrue(any(all(lo-1e-6 <= coord <= hi+1e-6
                                                    for coord,(lo,hi) in zip(hub,beam))
                                                    for beam in boxes[::2]), 'small axle lacks a carrier')
                        sprite.resolve_depth()
                        visible = sum(abs(area(points)) for name,polys in sprite.parts
                                      if name == 'wheel-carriers' for points,_,_ in polys)
                        self.assertGreater(visible,1, 'supports must survive occlusion')

    def test_cowcatcher_is_a_joined_wedge_with_a_visible_side_in_both_views(self):
        for module in MODULES:
            for facing in ('left','right'):
                sprite = module.Sprite('test-loco-pilot','Pilot',17)
                Builder(vars(module),module is MODULES[0],sprite,34,facing).pilot('#bb9760')
                faces = list(sprite.depth_faces.values())
                self.assertEqual(len(faces),4)
                self.assertEqual(min(p[2] for face in faces for p in face),1)
                self.assertEqual(max(p[2] for face in faces for p in face),4)
                for face in faces:
                    self.assertTrue(all(0 <= p[0] <= 34 for p in face))
                sprite.resolve_depth()
                self.assertGreater(coverage(sprite,'#bb9760'),0)
                self.assertGreater(coverage(sprite,blend('#bb9760','#000000',.3)),0)


if __name__ == '__main__':
    unittest.main()
