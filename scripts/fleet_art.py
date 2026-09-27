"""Original low-resolution stock designs, shared by both SVG projections.

stock-designs.json owns the catalogue and dimensions. These are historical-style
game vehicles, not engineering replicas; cargo spaces and performance are balanced for play.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / 'scripts/stock-designs.json').read_text())


def tint(colour, amount):
    return '#' + ''.join(f'{min(255, round(int(colour[i:i+2],16)*amount)):02x}' for i in (1,3,5))


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

    def boiler(self, start, length, top, side, radius=4.5):
        # Separate crown, shoulder and underside shades make the cylinder read as round.
        self.s.part('boiler')
        ring = [(-1,0),(-.7,.7),(0,1),(.7,.7),(1,0),(.7,-.7),(0,-1)]
        colours = [side,top,tint(top,1.13),tint(top,.85),side,tint(side,.65)]
        for (v0,z0),(v1,z1),colour in zip(ring,ring[1:],colours):
            for a,c,paint in ((start,start+length-3,colour),(start+length-3,start+length,tint(colour,.67))):
                self.poly([(a,v0*radius,12.5+z0*radius),(c,v0*radius,12.5+z0*radius),
                           (c,v1*radius,12.5+z1*radius),(a,v1*radius,12.5+z1*radius)],paint)
        self.s.part('boiler-bands')
        for u in (start+2,start+length-4):
            for (v0,z0),(v1,z1) in zip(ring,ring[1:]):
                self.poly([(u,v0*radius,12.5+z0*radius),(u+.65,v0*radius,12.5+z0*radius),
                           (u+.65,v1*radius,12.5+z1*radius),(u,v1*radius,12.5+z1*radius)],tint(top,1.18))
        end = start if self.reverse else start + length
        if self.iso:
            self.s.part('smokebox-door')
            for r, colour in ((radius,'#28312e'),(radius*.73,'#46514a')):
                self.poly([(end,r*math.cos(i*math.pi/4),12.5+r*math.sin(i*math.pi/4))
                           for i in range(8)],colour)
            self.poly([(end,-1,12),(end,1,12),(end,1,13),(end,-1,13)],'#9c9e89')

    def chimney(self, u, bottom, spark_arrestor=False):
        self.s.part('spark-arrestor' if spark_arrestor else 'chimney')
        self.box(u-1,-1,bottom,2,2,3,'#777b68','#343d35','#252f29')
        if spark_arrestor:
            self.poly([(u-1,1,bottom+2),(u-2.5,2,bottom+4),(u+2.5,2,bottom+4),(u+1,1,bottom+2)],'#6d6550')
            self.box(u-2.5,-2,bottom+4,5,4,1,'#b39d6b','#786d51','#514c3a')
        else:
            self.box(u-1.5,-1.5,bottom+2.5,3,3,.8,'#737a68','#303b33','#252f29')


def cab_diesel_body(b, top, side, trim):
    """Continuous cab-unit shell: no overlapping box end hiding the reversed nose."""
    s, L = b.s, b.length
    # u, half-width, roof shoulder, crown. The cab rolls down into a rounded nose.
    rings = [(1,4.6,15,17),(L-11,4.6,15,17),(L-8,4.6,16,18),
             (L-6,4.2,13,15),(L-3,3.6,11,13),(L-1,2.5,8,10)]
    faces = [('far-side',-1,0,-1,1,side),('far-shoulder',-1,1,-.45,2,top),
             ('roof',-.45,2,.45,2,'#c6c7b4'),('near-shoulder',.45,2,1,1,'#9aa89e'),
             ('near-side',1,1,1,0,side)]
    for name,va,za,vb,zb,colour in faces:
        s.part('cab-unit-'+name)
        for (u,w,shoulder,crown),(end,w2,shoulder2,crown2) in zip(rings,rings[1:]):
            heights, heights2 = (5,shoulder,crown), (5,shoulder2,crown2)
            b.poly([(u,va*w,heights[za]),(end,va*w2,heights2[za]),
                    (end,vb*w2,heights2[zb]),(u,vb*w,heights[zb])],colour)
    if b.iso:
        s.part('cab-unit-end')
        u,w,shoulder,crown = rings[0 if b.reverse else -1]
        b.poly([(u,-w,5),(u,-w,shoulder),(u,-w*.45,crown),
                (u,w*.45,crown),(u,w,shoulder),(u,w,5)],'#5e716c')
        if b.reverse:
            s.part('rear-door')
            b.poly([(u, -1.5,6),(u,1.5,6),(u,1.5,13),(u,-1.5,13)],'#475b58')
    s.part('cab-unit-stripe')
    for (u,w,_,_),(end,w2,_,_) in zip(rings,rings[1:]):
        b.poly([(u,w+.1,7),(end,w2+.1,7),(end,w2+.1,8),(u,w+.1,8)],trim)
    if b.iso and not b.reverse:
        b.poly([(L-1,-2.5,7),(L-1,2.5,7),(L-1,2.5,8),(L-1,-2.5,8)],trim)
    s.part('cab-unit-grilles')
    b.poly([(3,4.7,11),(L-13,4.7,11),(L-13,4.7,14),(3,4.7,14)],'#455955')
    for u in range(4,int(L-13),2):
        b.poly([(u,4.8,11),(u+1,4.8,11),(u+1,4.8,14),(u,4.8,14)],'#87998e')
    s.part('cab-unit-portholes')
    for u in (9,17):
        b.poly([(u+1.1*math.cos(i*math.pi/4),4.8,9.5+1.1*math.sin(i*math.pi/4))
                for i in range(8)],'#334b4c')
    s.part('cab-unit-roof-fans')
    for u in sorted((6,13,20),key=b.u):
        for radius,colour in ((1.7,'#73847c'),(1.1,'#394c49')):
            b.poly([(u+radius*math.cos(i*math.pi/4),radius*math.sin(i*math.pi/4),17.1)
                    for i in range(8)],colour)
    s.part('cab-unit-windows')
    b.poly([(L-12,4.7,12),(L-9,4.7,12),(L-9,4.7,15.5),(L-12,4.7,15)],'#dec38a')
    # Split windscreens sit on the sloping shell, not above it like a detached visor.
    def screen_point(u, v):
        fraction = (u-(L-8))/2
        width, crown = 4.6-.4*fraction, 18-3*fraction
        height = crown - 2*max(0,(abs(v)/width-.45)/.55)
        return (u,v,height+.05)
    for v0,v1 in ((-3.3,-.5),(.5,3.3)):
        b.poly([screen_point(L-7.7,v0),screen_point(L-7.7,v1),
                screen_point(L-6.3,v1*.91),screen_point(L-6.3,v0*.91)],'#dec38a')
    s.part('cab-unit-headlight')
    b.poly([(L-2,-.7,11.2),(L-2,.7,11.2),(L-1.2,.7,10.4),(L-1.2,-.7,10.4)],'#d8cfaf')


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
        wheels = [(u,2.4) for u in (5,9,13,17,L-17,L-13,L-9,L-5)]
        wheels += [(u,1.3) for u in (2,20,L-20,L-2)]
    else:
        wheels = [(u,1.5) for u in (3,7)]
        if style == 'american': wheels += [(16,3.2),(23,3.2),(L-5,1.5),(L-2,1.5)]
        elif style == 'streamliner': wheels += [(18,1.5),(24,3.2),(30,3.2),(36,3.2),(L-5,1.5),(L-2,1.5)]
        else: wheels += [(14,1.5),(19,2.6),(24,2.6),(29,2.6),(34,2.6),(L-2,1.5)]
    for u, radius in sorted(wheels, key=lambda wheel:b.u(wheel[0])):
        b.wheel(u, radius)
        if style in ('american','mikado','garratt') and radius>2:
            s.part('driver-spokes')
            rz = radius if iso else radius/api['PITCH']
            for angle in (0,math.pi/3,2*math.pi/3):
                du,dz=math.cos(angle)*radius*.55,math.sin(angle)*rz*.55
                b.poly([(u-du,5.3,radius-dz),(u+du,5.3,radius+dz),
                        (u+du+.3,5.3,radius+dz+.3),(u-du+.3,5.3,radius-dz+.3)],'#737b6b')
    s.part('frame')
    b.box(0,-4,4,L,8,1.5,'#515b50' if style in ('american','mikado','garratt') else '#747764','#343c35')
    cab_u = 3
    if style == 'cab-unit':
        cab_u = L-12
        cab_diesel_body(b,top,side,trim)
    elif style in ('mechanical','hydraulic'):
        s.part('diesel-body')
        if style == 'mechanical':
            cab_u = 2
            parts = [(2, 'cab'), (7, 'hood')]
        elif style == 'hydraulic':
            cab_u = L*.47
            parts = [(2, 'hood'), (cab_u, 'cab'), (L-6, 'short-hood')]
        for u, part in sorted(parts, key=lambda item:b.u(item[0])):
            s.part(part)
            if part == 'cab':
                b.box(u,-5,5,5,10,11,top,side)
                b.box(u-.5,-5.5,16,6,11,1,top,side)
                b.poly([(u+1,5,12),(u+4,5,12),(u+4,5,15),(u+1,5,15)], '#dec38a')
            else:
                length = (L-3-u) if style == 'mechanical' else (cab_u-3 if part == 'hood' else 4)
                height = 6
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
            b.rod(5,17); b.rod(L-17,L-5)
            cab_u=15
            segments=[(1,'rear-tank'),(15,'cab'),(22,'boiler'),(L-14,'front-tank')]
        else:
            b.rod(16 if style=='american' else 19,23 if style=='american' else L-7)
            cab_u=10 if style=='american' else 12
            segments=[(1,'tender'),(cab_u,'cab'),(cab_u+7,'boiler')]
        for u, part in sorted(segments,key=lambda item:b.u(item[0])):
            s.part(part)
            if part in ('tender','rear-tank','front-tank'):
                length = (12 if part=='rear-tank' else 13) if 'tank' in part else cab_u-2
                if style=='streamliner':
                    b.box(u,-5,5,length,10,8,top,side)
                    b.box(u+2,-3,13,length-4,6,1,'#30352e','#1d241e')
                else:
                    b.box(u,-5,5,length,10,7,top,side,tint(side,.75))
                    if part != 'front-tank':
                        s.part('coal-load')
                        b.box(u+1,-4,12,length-2,8,.5,'#252c29','#1c2421')
                        for offset in range(2,int(length-1),2):
                            b.box(u+offset,-2+(offset%3),12.5,.9,1,.8,'#545a4e','#2f3930')
                    else:
                        s.part('water-tank-roof')
                        b.poly([(u,-5,12),(u,-3,13),(u+length,-3,13),(u+length,-5,12)],tint(top,1.1))
                        b.poly([(u,-3,13),(u,3,13),(u+length,3,13),(u+length,-3,13)],top)
                        b.poly([(u,3,13),(u,5,12),(u+length,5,12),(u+length,3,13)],tint(top,.8))
                        b.box(u+length/2,-1,13,2,2,.7,'#989c85',side)
                b.box(u+2,5,8,length-4,.2,1,trim,trim)
            elif part=='cab':
                if style == 'streamliner':
                    b.box(u,-5,6,7,10,11,top,side)
                    b.poly([(u+1,5,12),(u+5,5,12),(u+5,5,15),(u+1,5,15)],'#dec38a')
                    b.poly([(u,-5,17),(u,0,19),(u+7,0,19),(u+7,-5,17)],top)
                    b.poly([(u,0,19),(u,5,17),(u+7,5,17),(u+7,0,19)],'#547f92')
                    b.box(u,5,8,7,.2,1,trim,trim)
                else:
                    b.box(u,-5,6,7,10,9,top,side,tint(side,.75))
                    b.poly([(u+1,5.1,11),(u+5,5.1,11),(u+5,5.1,14),(u+1,5.1,14)],'#dec38a')
                    s.part('arched-cab-roof')
                    for v0,z0,v1,z1,paint in [(-5.5,15.5,-2,17,top),(-2,17,2,17,tint(top,1.15)),
                                              (2,17,5.5,15.5,tint(top,.8))]:
                        b.poly([(u-.5,v0,z0),(u+7.5,v0,z0),(u+7.5,v1,z1),(u-.5,v1,z1)],paint)
                    s.part('cab-trim'); b.box(u,5.2,8,6,.2,.6,trim,trim)
                    if style=='american': b.box(u+3,5.2,11,.6,.2,3,trim,trim)
            else:
                end = L-15 if style=='garratt' else L-4 if style=='american' else L-2
                if style=='streamliner':
                    s.part('streamlined-casing')
                    # A rounded crown and several tapered nose facets, not one flat wedge.
                    # Longitudinal rings share vertices, including at the narrow nose.
                    rings = [(u,5,19),(end-7,5,19),(end-3,4.5,17),(end,3.5,13),(end+1,3,9)]
                    faces = [(-1,0,-1,1,side),(-1,1,-.45,2,top),
                             (-.45,2,.35,2,'#89aab3'),(.35,2,1,1,'#547f92'),
                             (1,1,1,0,side)]
                    # Levels: skirt, shoulder, crown.
                    for va,da,vb,db,colour in faces:
                        for (a,w,h),(c,w2,h2) in zip(rings,rings[1:]):
                            za, zb = (6,h-2,h)[da], (6,h-2,h)[db]
                            zc, zd = (6,h2-2,h2)[da], (6,h2-2,h2)[db]
                            b.poly([(a,va*w,za),(c,va*w2,zc),(c,vb*w2,zd),(a,vb*w,zb)],colour)
                    if not b.reverse:
                        b.poly([(end+1,-3,6),(end+1,-3,7),(end+1,-1.35,9),
                                (end+1,1.05,9),(end+1,3,7),(end+1,3,6)],'#284b60')
                    s.part('casing-details')
                    b.poly([(u,5.1,8),(end-5,5.1,8),(end+1,3.1,6),
                            (end+1,3.1,7),(end-5,5.1,9),(u,5.1,9)],trim)
                    for panel in (u+3,u+9,u+15):
                        b.poly([(panel,5.1,10),(panel+.5,5.1,10),(panel+.5,5.1,15),(panel,5.1,15)],'#466d80')
                    s.part('recessed-chimney')
                    b.box(end-8,-1.3,19,3,2.6,1,'#303d43','#213038')
                else:
                    radius=3.6 if style=='american' else 4.5
                    b.boiler(u,end-u,top,side,radius)
                    s.part('steam-dome')
                    b.box(u+4,-1.5,12.5+radius,2.5,3,1.5,trim,side,tint(side,.8))
                    b.chimney(end-2,12+radius,style=='american')
                    s.part('boiler-handrail')
                    b.poly([(u+1,radius+.3,13),(end-1,radius+.3,13),
                            (end-1,radius+.3,13.6),(u+1,radius+.3,13.6)],'#b4b6a0')
                    if style=='american':
                        s.part('slatted-pilot')
                        b.poly([(L-4,-4,5),(L,0,1),(L-4,4,5)],'#584b39')
                        for v in (-4,-2,0,2,4):
                            b.poly([(L-4,v,5),(L,0,1),(L-.4,.5,1),(L-4,v+.5,5)],trim)
                    if style=='mikado':
                        s.part('smoke-deflector')
                        b.poly([(end-6,5,8),(end-1,5,8),(end-1,5,14),(end-3,5,16),(end-6,5,16)],'#414c44')
                        b.poly([(end-6,5.2,15),(end-3,5.2,15),(end-3,5.2,16),(end-6,5.2,16)],'#788170')
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
        for name,v0,z0,v1,z1,colour in [('far',-4,9,-3,13,side),('crown',-3,13,2,14,top),
                ('near-shoulder',2,14,4,12,'#a7956c'),('near-side',4,12,4,8,side),
                ('underside',4,8,2,6,'#62573f')]:
            s.part('tank-'+name)
            b.poly([(2,v0,z0),(L-2,v0,z0),(L-2,v1,z1),(2,v1,z1)],colour)
        s.part('tank-end')
        b.poly([(L-2,4,8),(L-2,4,12),(L-2,2,14),(L-2,-3,13),(L-2,-4,9),(L-2,-2,6),(L-2,2,6)],side)
        for u in (6,L-7): b.box(u,4,7,1,.4,6,'#454d43','#454d43')
        b.box(L/2,-2,14,3,4,2,top,side)
    elif kind=='gondola':
        b.box(1,-5,5,L-2,10,1,top,side)
        s.part('far-wall'); b.box(1,-5,6,L-2,1,7,top,side)
        s.part('rear-wall'); b.box(1,-5,6,1,10,7,top,side)
        s.part('near-wall'); b.box(1,4,6,L-2,1,7,top,side)
        s.part('front-wall'); b.box(L-2,-5,6,1,10,7,top,side)
        s.part('wall-ribs')
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
