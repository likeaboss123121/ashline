"""Original low-resolution stock designs, shared by both SVG projections.

stock-designs.json owns the catalogue and dimensions. These are historical-style
game vehicles, not engineering replicas; cargo spaces and performance are balanced for play.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / 'scripts/stock-designs.json').read_text())


def write_catalogue():
    (ROOT / 'source/stock-catalogue.js').write_text(
        '// Generated from scripts/stock-designs.json by the art generators.\n'
        'setup.stockCatalogue = ' + json.dumps(DATA, indent='\t') + ';\n')


class Builder:
    def __init__(self, api, iso, sprite, length, facing='right'):
        self.api, self.iso, self.s, self.length = api, iso, sprite, length
        self.reverse = facing == 'left'

    def u(self, start, length=0):
        return self.length - start - length if self.reverse else start

    def box(self, u, v, z, length, width, height, top, side, end='#41483f'):
        self.s.box(self.u(u, length), v, z, length, width, height,
                   *((top, side, end) if self.iso else (top, side)))

    def poly(self, points, colour):
        self.s.world_poly([(self.u(u), v, z) for u, v, z in points], colour)

    def wheel(self, u, radius=2, z=None):
        z = radius if z is None else z
        if self.iso:
            self.s.disc_side(self.u(u), 5.2, z, radius, '#242b2b', '#95816a')
        else:
            self.s.disc_side(self.u(u), z, radius, '#242b2b', '#95816a', v=5.2)

    def rod(self, a, b, z=3):
        self.poly([(a, 5.5, z), (b, 5.5, z), (b, 5.5, z+1), (a, 5.5, z+1)], '#a0a395')

    def boiler(self, start, length, top, side):
        # Faceted cylinder, with the visible end drawn last in the isometric projection.
        self.s.part('boiler')
        for v0, z0, v1, z1, colour in [(-4, 12, -3, 16, top), (-3, 16, 2, 17, top),
                                      (2, 17, 4.5, 14, top), (4.5, 14, 4.5, 10, side),
                                      (4.5, 10, 2, 8, '#29302c')]:
            self.poly([(start,v0,z0),(start+length,v0,z0),(start+length,v1,z1),(start,v1,z1)], colour)
        end = start if self.reverse else start + length
        self.poly([(end, 4.5*math.cos(i*math.pi/4), 12.5+4.5*math.sin(i*math.pi/4))
                   for i in range(8)], '#2d3431')


def locomotive(api, iso, spec, facing):
    prefix = 'railyard' if iso else 'driving'
    L = spec['length']*2
    s = api['Sprite'](prefix+'-loco-'+spec['model']+'-'+facing,
                      spec['name'].capitalize()+', '+spec['origin']+' '+spec['era']+', facing '+facing, spec['length'])
    b = Builder(api, iso, s, L, facing)
    top, side, trim = spec['colours']
    style = spec['design']
    api['coupler'](s, 0)
    s.part('running-gear')
    if style == 'mechanical':
        wheels = [(3,2),(L-3,2)]
    elif style in ('hydraulic', 'cab-unit'):
        wheels = [(u,2) for u in (3,7,L-7,L-3)]
    elif style == 'garratt':
        wheels = [(u,2.2) for u in (7,11,15,19,L-19,L-15,L-11,L-7)]
        wheels += [(u,1.3) for u in (2,4,23,L-23,L-4,L-2)]
    else:
        wheels = [(u,1.5) for u in (3,7)]
        if style == 'american': wheels += [(16,3.2),(23,3.2),(L-5,1.5),(L-2,1.5)]
        elif style == 'streamliner': wheels += [(18,1.5),(24,3.2),(30,3.2),(36,3.2),(L-5,1.5),(L-2,1.5)]
        else: wheels += [(14,1.5),(19,2.6),(24,2.6),(29,2.6),(34,2.6),(L-2,1.5)]
    for u, radius in sorted(wheels, key=lambda wheel:b.u(wheel[0])):
        b.wheel(u, radius)
    s.part('frame')
    b.box(0,-4,4,L,8,1.5,'#747764','#343c35')
    cab_u = 3
    if style in ('mechanical','hydraulic','cab-unit'):
        s.part('diesel-body')
        if style == 'mechanical':
            cab_u = 2
            parts = [(2, 'cab'), (7, 'hood')]
        elif style == 'hydraulic':
            cab_u = L*.47
            parts = [(2, 'hood'), (cab_u, 'cab'), (L-6, 'short-hood')]
        else:
            cab_u = L-8
            parts = [(2, 'full-body'), (cab_u, 'nose')]
        for u, part in sorted(parts, key=lambda item:b.u(item[0])):
            s.part(part)
            if part == 'cab':
                b.box(u,-5,5,5,10,11,top,side)
                b.box(u-.5,-5.5,16,6,11,1,top,side)
                b.poly([(u+1,5,12),(u+4,5,12),(u+4,5,15),(u+1,5,15)], '#dec38a')
            elif part == 'nose':
                b.poly([(u,5,5),(L-1,5,5),(L-1,5,10),(L-4,5,17),(u,5,17)],side)
                b.poly([(u,-5,17),(L-4,-5,17),(L-1,-4,10),(L-1,5,10),(L-4,5,17),(u,5,17)],top)
                b.poly([(u+1,5,12),(u+4,5,12),(u+3,5,15),(u+1,5,15)],'#dec38a')
                b.box(L-2,-1,10,1,2,2,trim,trim)
            else:
                length = (L-10) if part == 'full-body' else ((L-3-u) if style == 'mechanical' else (cab_u-3 if part == 'hood' else 4))
                height = 11 if part == 'full-body' else 6
                b.box(u,-4,5,length,8,height,top,side)
                for vent in range(int(u+2),int(u+length-1),3):
                    b.box(vent,4,7,1,.3,height-3,'#303e3c','#303e3c')
                b.box(u+2,-1,5+height,2,2,2,'#515950','#333f37')
        s.part('stripe'); b.box(1,5,6,L-2,.3,1,trim,trim)
        if style == 'mechanical':
            s.part('chain-drive'); b.rod(3,L-3,2); b.wheel(L/2,1.3,3)
    else:
        s.part('coupling-rods')
        if style == 'garratt':
            b.rod(7,19); b.rod(L-19,L-7)
            cab_u=22
            segments=[(1,'rear-tank'),(22,'cab'),(28,'boiler'),(L-16,'front-tank')]
        else:
            b.rod(16 if style=='american' else 19,23 if style=='american' else L-7)
            cab_u=10 if style=='american' else 12
            segments=[(1,'tender'),(cab_u,'cab'),(cab_u+7,'boiler')]
        for u, part in sorted(segments,key=lambda item:b.u(item[0])):
            s.part(part)
            if part in ('tender','rear-tank','front-tank'):
                length = 14 if 'tank' in part else cab_u-2
                b.box(u,-5,5,length,10,8,top,side)
                if part != 'front-tank': b.box(u+2,-3,13,length-4,6,1,'#30352e','#1d241e')
                b.box(u+2,5,8,length-4,.2,1,trim,trim)
            elif part=='cab':
                b.box(u,-5,6,7,10,11,top,side)
                b.poly([(u+1,5,12),(u+5,5,12),(u+5,5,15),(u+1,5,15)],'#dec38a')
                b.box(u-.5,-5.5,17,8,11,1,top,side)
            else:
                end = L-17 if style=='garratt' else L-2
                if style=='streamliner':
                    s.part('streamlined-casing')
                    b.poly([(u,5,6),(end,5,6),(end+1,5,10),(end-3,5,16),(u,5,18)],side)
                    b.poly([(u,-5,18),(end-3,-4,16),(end+1,-3,10),(end+1,5,10),(end-3,5,16),(u,5,18)],top)
                    b.poly([(u,5.2,10),(end,5.2,8),(end,5.2,9),(u,5.2,11)],trim)
                else:
                    b.boiler(u,end-u,top,side)
                    b.box(u+4,-1.5,17,3,3,2,trim,side)
                    b.box(end-3,-1,16,2,2,5,'#484e45','#272f2b')
                    if style=='american':
                        s.part('spark-arrestor'); b.box(end-4,-2.5,20,4,5,3,trim,'#494f44')
                        s.part('cowcatcher'); b.poly([(L-4,-5,4),(L,-6,1),(L,6,1),(L-4,5,4)],trim)
                    if style=='mikado':
                        s.part('smoke-deflector'); b.box(end-7,5,9,5,.5,8,top,side)
    api['finish_car'](s,L,24)
    s.mark('cab',b.u(cab_u+2),0,18)
    return s


def car(api, iso, kind, spec, variant):
    prefix = 'railyard' if iso else 'driving'
    L=spec['length']*2
    s=api['Sprite'](prefix+'-car-'+kind+'-'+variant['id'],
                    variant['name'].capitalize()+', '+variant['origin']+' '+variant['era'],spec['length'])
    b=Builder(api,iso,s,L)
    top,side=variant['colours']; style=variant['style']
    api['running_gear'](s,L)
    s.part('body')
    if kind=='flatcar':
        b.box(0,-5,5,L,10,1,top,side)
        for u in range(2,int(L),5): b.box(u,5,5,1,1,6,'#797d6c','#4b594e')
    elif kind=='tanker':
        # Rounded eight-sided tank with retaining bands, not a recoloured rectangular van.
        for v0,z0,v1,z1 in [(-4,9,-3,13),(-3,13,2,14),(2,14,4,12),(4,12,4,8),(4,8,2,6)]:
            b.poly([(2,v0,z0),(L-2,v0,z0),(L-2,v1,z1),(2,v1,z1)],top if z1>12 else side)
        b.poly([(L-2,4,8),(L-2,4,12),(L-2,2,14),(L-2,-3,13),(L-2,-4,9),(L-2,-2,6),(L-2,2,6)],side)
        for u in (6,L-7): b.box(u,4,7,1,.4,6,'#454d43','#454d43')
        b.box(L/2,-2,14,3,4,2,top,side)
    elif kind=='gondola':
        b.box(1,-5,5,L-2,10,1,top,side)
        b.box(1,-5,6,L-2,1,7,top,side); b.box(1,4,6,L-2,1,7,top,side)
        for u in (1,L-2): b.box(u,-5,6,1,10,7,top,side)
        for u in range(3,int(L-2),4): b.box(u,5,6,1,.3,7,top,top)
    elif kind=='hopper':
        b.box(2,-4,7,L-4,8,7,top,side)
        for u in (4,12,20):
            b.poly([(u,4,7),(u+6,4,7),(u+4,3,3),(u+2,3,3)],side)
            b.box(u,-1,14,4,2,1,'#d5bd89',side)
        b.poly([(2,-4,14),(L-2,-4,14),(L-2,0,16),(2,0,16)],top)
        b.poly([(2,0,16),(L-2,0,16),(L-2,4,14),(2,4,14)],top)
    else:
        passenger = kind in ('passenger','sleeper','observation','kitchen','private')
        b.box(1,-5,5,L-2,10,10,top,side)
        if passenger:
            s.part('windows')
            step=5 if style=='compartment' else 6
            for u in range(4,int(L-4),step):
                if style=='diner' and u<L/2: continue
                b.poly([(u,5.1,9),(u+3,5.1,9),(u+3,5.1,13),(u,5.1,13)],'#293f40')
            s.part('roof'); b.box(0,-5.5,15,L,11,1,'#b0b2a3','#707c71')
            if style in ('clerestory','saloon'):
                b.box(4,-2,16,L-8,4,3,top,side)
                for u in range(5,int(L-5),4): b.box(u,2,17,2,.2,1,'#344946','#344946')
            if style=='dome':
                b.box(L/3,-4,16,L/3,8,4,'#96b1b1','#476368')
                for u in range(int(L/3),int(2*L/3),3): b.box(u,4,16,.6,.3,4,top,top)
            if style=='stainless':
                for z in (6,7,8): b.box(2,5.2,z,L-4,.2,.4,top,top)
            if style=='suburban':
                for u in (8,L-12): b.box(u,5.2,5,4,.2,9,'#c8bca0','#a39175')
            if style=='diner':
                for u in (7,12,17): b.box(u,-1,16,2,2,2,'#7c8478','#4a574e')
        else:
            s.part('door'); b.box(L/2-3,5,5,6,.5,9,top,'#655f4d')
            if style in ('wood','ice'):
                for z in range(6,15,2): b.box(2,5.2,z,L-4,.2,.3,'#544b3c','#544b3c')
            else:
                for u in range(3,int(L-2),4): b.box(u,5.2,5,.7,.2,9,top,top)
            if style=='ice':
                s.part('ice-hatches')
                for u in (3,L-7): b.box(u,-3,15,4,6,1,'#ced0b5',side)
    api['finish_car'](s,L,21 if style=='dome' else 19)
    return s


def extra_stock(api, iso):
    write_catalogue()
    return [locomotive(api,iso,spec,facing) for spec in DATA['locomotives'] if 'design' in spec
            for facing in ('right','left')] + [car(api,iso,kind,spec,variant)
            for kind,spec in DATA['cars'].items() for variant in spec['variants']]
