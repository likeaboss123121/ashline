"""Shared world-space designs for both projections. Called by the two template generators."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VEGETATION = json.loads((ROOT / 'scripts/vegetation-designs.json').read_text())

# biome: plant, ground, foreground, distant hills, sky, foliage
BIOMES = {
    'steppe': ('scrub', '#69674c', '#797557', '#77795e', '#a2b4ba', '#92905c'),
    'pampas': ('grass', '#65734c', '#738153', '#7b8861', '#93b9c6', '#a2a16a'),
    'savanna': ('acacia', '#81744c', '#938151', '#938a60', '#bcc2a5', '#657347'),
    'rainforest': ('broadleaf', '#384e37', '#435a39', '#456553', '#8eafa3', '#54754a'),
    'wetland': ('cypress', '#485b49', '#506754', '#56736a', '#a2beb8', '#5b7954'),
    'desert': ('scrub', '#897b59', '#a18c60', '#a69a7b', '#c4c5af', '#a69a66'),
    'mediterranean': ('olive', '#72704e', '#88825a', '#8d906b', '#a7bcc1', '#778768'),
    'temperate': ('oak', '#4e6045', '#5c6c49', '#657f68', '#94b4c3', '#647d4f'),
    'taiga': ('pine', '#485747', '#52614d', '#577268', '#a6babc', '#4d7060'),
    'tundra': ('moss', '#777d70', '#898b79', '#8a9790', '#b3c2c6', '#9c9a71'),
    'alpine': ('rock', '#73766c', '#838378', '#88938f', '#afc3cd', '#a7aaa0'),
}


def plant(s, kind, u=0, v=0, colour=None, variant=0, ground_z=2):
    """Small upright silhouettes, wholly behind the railway; all coordinates snap in the Sprite."""
    colours = {'pine': '#4d7060', 'broadleaf': '#54754a', 'acacia': '#657347',
                     'cypress': '#5b7954', 'olive': '#778768', 'oak': '#647d4f',
                     'grass': '#a2a16a', 'scrub': '#92905c', 'moss': '#9c9a71', 'rock': '#a7aaa0',
                     'bamboo':'#79935c', 'birch':'#96a270', 'cedar':'#3f6c57', 'larch':'#9aab6d',
                     'baobab':'#81864d', 'fern':'#53845b', 'maple':'#809053', 'cactus':'#76836a'}
    leaf = colour or colours.get(kind, '#6d8659')
    def poly(points, fill):
        s.world_poly([(u + x, v, z + ground_z) for x, z in points], fill)
    s.part('vegetation-' + kind)
    if kind in ('fern','pampas-grass','feather-grass','reed','wormwood','sage','flowering-shrub','thorn','dwarf-willow'):
        height = {'fern':5,'pampas-grass':9,'feather-grass':6,'reed':10,'dwarf-willow':3}.get(kind,5)
        for i,x in enumerate((-4,-2,0,2,4)):
            tip = height - abs(x)/2
            poly([(0,0),(x-1,tip-1),(x,tip),(x+1,tip-1),(1,0)],leaf)
            if kind in ('pampas-grass','feather-grass','reed'):
                poly([(x-1,tip),(x-1,tip+3),(x+1,tip+4),(x+1,tip)],'#c1b388')
            if kind=='fern':
                for h in (2,3): poly([(0,h),(x*1.5,h+1),(x,h-1)],leaf)
            if kind=='flowering-shrub': poly([(x-1,tip),(x,tip+1),(x+1,tip)],'#c5ae8b')
        return
    if kind=='cactus':
        poly([(-1,0),(-1,15),(1,16),(2,0)],leaf)
        poly([(-1,7),(-5,7),(-5,12),(-3,12),(-3,9),(-1,9)],leaf)
        poly([(1,5),(5,5),(5,10),(3,10),(3,7),(1,7)],leaf)
        return
    if kind=='bamboo':
        for x,h in ((-4,19),(0,26),(4,22)):
            poly([(x,0),(x,h),(x+1,h),(x+1,0)],'#839367')
            for z in range(5,h,5):
                poly([(x,z),(x-5,z+3),(x-2,z+4),(x+1,z+1),(x+5,z+4),(x+3,z)],leaf)
        return
    if kind in ('palm','oil-palm'):
        height=22 if kind=='palm' else 17
        poly([(-1,0),(1,height),(3,height),(1,0)],'#907452')
        for x,z in ((-10,height-4),(-8,height+1),(-4,height+5),(5,height+4),(10,height),(9,height-5)):
            poly([(2,height),(x,z),(x/2,z+2),(3,height+1)],leaf)
        return
    if kind in ('grass', 'scrub', 'moss'):
        height = {'grass': 4, 'scrub': 5, 'moss': 2}[kind]
        for x in (-4, 0, 3):
            poly([(x - 2, 0), (x - 3, height - 1), (x, height / 2), (x + 1, height), (x + 2, 0)], leaf)
        return
    if kind == 'rock':
        poly([(-6, 0), (-4, 5), (2, 7), (6, 3), (6, 0)], '#747b78')
        poly([(-4, 5), (2, 7), (6, 3), (1, 4)], leaf)
        return
    height = {'pine':26,'broadleaf':25,'acacia':17,'cypress':28,'olive':14,'oak':21,
              'spruce':28,'fir':27,'larch':25,'douglas-fir':32,'cedar':29,'araucaria':26,
              'ceiba':30,'iroko':29,'dipterocarp':31,'baobab':19,'birch':22}.get(kind,23) + variant % 3
    trunk = '#b9b5a0' if kind=='birch' else '#665b42'
    width = 4 if kind=='baobab' else 1
    poly([(-width,0),(-width,height-5),(width,height-5),(width+1,0)],trunk)
    if kind in ('pine','cypress','spruce','fir','larch','douglas-fir','cedar','araucaria'):
        width = {'pine':7,'cypress':4,'spruce':6,'fir':8,'larch':7,'douglas-fir':9,'cedar':10,'araucaria':9}[kind]
        for base in (5, 11, 16):
            peak=height-(16-base)/2
            if kind=='araucaria':
                poly([(-width,base+4),(-width+1,base),(0,base+1),(width-1,base),(width,base+4),(0,base+3)],leaf)
            elif kind=='cedar':
                poly([(-width,base-1),(-width/2,base+7),(0,peak),(width/2,base+5),(width,base),(1,base+3)],leaf)
            else:
                poly([(-width,base),(0,peak),(width,base)],leaf)
            if kind=='larch': poly([(-width,base),(width,base),(width,base+1),(-width,base+1)],'#b4b480')
            width -= 1
        poly([(0, height), (3, height - 8), (0, height - 6)], '#759078')
    elif kind in ('acacia','baobab','mopane'):
        poly([(0, 6), (-6, 13), (-5, 14), (1, 9), (6, 14), (7, 13), (1, 6)], '#665b42')
        poly([(-11, 12), (-9, 16), (-4, height), (7, height), (11, 14), (7, 12)], leaf)
        poly([(-9, 16), (-4, height), (7, height), (9, 16)], '#8b9563')
    else:
        wide = 10 if kind in ('broadleaf','ceiba','iroko','dipterocarp') else 8
        poly([(-wide, height - 9), (-wide, height - 4), (-5, height), (4, height + 1),
              (wide, height - 3), (wide, height - 9), (3, height - 11), (-5, height - 10)], leaf)
        poly([(-wide, height - 4), (-5, height), (4, height + 1), (5, height - 3), (-2, height - 4)], '#829464')
        if kind == 'broadleaf':
            poly([(5, height - 6), (6, 4), (7, 4), (7, height - 7)], '#638052')
        if kind in ('ceiba','dipterocarp'):
            poly([(-4,0),(-1,8),(0,8),(4,0)],'#807255')
        if kind in ('beech','southern-beech','chestnut','maple'):
            poly([(-7,height-5),(-4,height+3),(0,height+1),(4,height+4),(8,height-5)],leaf)
        if kind=='birch':
            for z in (3,6,9): poly([(-1,z),(1,z),(1,z+1),(-1,z+1)],'#595e51')


def yard_plants(api):
    result = []
    for kind in dict.fromkeys([value[0] for value in BIOMES.values()] + [p for spec in VEGETATION.values() for p in spec['plants']]):
        s = api['Sprite']('railyard-plant-' + kind, kind.title())
        plant(s, kind, ground_z=0)
        result.append(s)
    return result


def driving_landscapes(api):
    (ROOT / 'source/vegetation-data.js').write_text('// Generated from scripts/vegetation-designs.json.\n'
        'setup.vegetation = '+json.dumps(VEGETATION,indent='\t')+';\n')
    result = []
    for name, spec in VEGETATION.items():
        biome=spec['biome']
        kind,ground,near,far,sky,leaf=BIOMES[biome]
        for mountain in (False, True):
            s = api['terrain']('local-' + name + ('-mountain' if mountain else ''), name.title(),
                               ground, near, far, sky, leaf, snow=mountain)
            if mountain and biome not in ('alpine', 'tundra'):
                snow = api['P']['mountain_snow']
                s.parts = [(part, [(points, far if fill == snow else fill, alpha)
                                  for points, fill, alpha in shapes]) for part, shapes in s.parts]
            if biome == 'wetland':
                s.part('standing-water')
                for start in (0, 39):
                    s.world_poly([(start, -24, 2), (start + 30, -24, 2),
                                  (start + 22, -9, 2), (start + 3, -8, 2)], '#657e79')
            positions = (11,30,49,68)
            for i, u in enumerate(positions):
                # Keep each silhouette inside the repeat to avoid seams at x=0/80.
                plant(s, spec['plants'][i % len(spec['plants'])], u, -22 + i % 2 * 4, variant=i)
            result.append(s)
    return result


def yard_industries(api):
    result = []
    for kind in ('farming', 'forestry', 'mining', 'oil', 'manufacturing'):
        s = api['Sprite']('railyard-industry-' + kind, 'Abandoned ' + kind + ' loading site')
        s.part('loading-apron')
        s.box(0, -20, 0, 36, 20, 1, '#626457', '#4c5147', '#41493f')
        s.part('industry')
        if kind == 'farming':
            for u in (3, 15):
                s.box(u, -17, 1, 9, 11, 20, '#b1b09a', '#8b917f', '#727b6b')
                s.box(u + 2, -15, 21, 5, 7, 2, '#969d87', '#737e6b', '#5e6959')
            s.box(4, -7, 11, 25, 3, 2, '#8b937e', '#515e4d', '#43543f')
        elif kind == 'forestry':
            for row in range(3):
                for u in (2, 20):
                    s.box(u, -17 + row * 5, 1, 14, 4, 4 + row % 2 * 3, '#a18c62', '#6e573a', '#c1a675')
        elif kind == 'mining':
            for u, height in ((3, 9), (17, 12)):
                s.box(u, -15, 1, 12, 12, height / 2, '#5f625a', '#444c46', '#353e39')
                s.box(u + 2, -13, height / 2 + 1, 8, 8, height / 2, '#78786a', '#535b51', '#414b42')
        elif kind == 'oil':
            for u in (3, 15, 27):
                s.box(u, -16, 1, 7, 10, 9, '#999b84', '#767e6b', '#586956')
                s.box(u, -16, 5, 7, 10, 2, '#aba681', '#8b8762', '#6e7356')
        else:
            s.box(1, -19, 1, 28, 17, 11, '#8b8f80', '#776c58', '#64583f')
            s.box(20, -18, 12, 4, 4, 12, '#9d9885', '#6e6351', '#504d3e')
            for u in (4, 10, 16):
                s.world_poly([(u, -2, 5), (u + 4, -2, 5), (u + 4, -2, 9), (u, -2, 9)], '#34494a')
        result.append(s)
    return result


def rolling_stock(api, iso):
    """One shared construction, projected by the owning generator. No scaled stand-in sprites."""
    prefix = 'railyard' if iso else 'driving'
    Sprite, gear, finish = api['Sprite'], api['running_gear'], api['finish_car']
    def box(s, u, v, z, length, width, height, top, side, end='#484b42'):
        colours = (top, side, end) if iso else (top, side)
        s.box(u, v, z, length, width, height, *colours)
    result = []
    s = Sprite(prefix + '-car-hopper', 'Covered hopper', 14)
    gear(s, 28)
    s.part('discharge-bays')
    for start in (5, 15):
        box(s, start, -3, 2, 5, 6, 4, '#6d7063', '#444b45')
    s.part('body')
    box(s, 2, -5, 6, 24, 10, 8, '#979b88', '#727d6a', '#525f52')
    for start in (5, 11, 17, 23):
        s.line_z(start, 5, 6, 14, '#a1a592')
    s.part('roof-hatches')
    for start in (5, 12, 19):
        box(s, start, -2, 14, 4, 4, 1, '#b1b3a1', '#757e6b')
    finish(s, 28, 15)
    result.append(s)
    s = Sprite(prefix + '-car-refrigerated', 'Refrigerated boxcar', 15)
    gear(s, 30)
    s.part('insulated-body')
    box(s, 1, -5, 5, 28, 10, 10, '#b7b6a3', '#969c8d', '#717d72')
    s.line_u(2, 28, 5, 8, '#537881')
    s.part('sealed-door')
    box(s, 12, 5, 5, 7, 0.5, 9, '#bec0ab', '#808b80')
    for start in (12, 18):
        s.line_z(start, 5.5, 6, 13, '#c0bd9e')
    s.part('cooling-unit')
    box(s, 2, -3, 15, 5, 6, 3, '#7e8981', '#465b57')
    for start in (3, 5):
        s.line_z(start, 3, 15, 18, '#293c3c')
    finish(s, 30, 18)
    result.append(s)
    for facing in ('right', 'left'):
        L = 32
        U = (lambda u, length=0: u) if facing == 'right' else (lambda u, length=0: L - u - length)
        s = Sprite(prefix + '-loco-diesel-old-road-' + facing, 'Four axle old road diesel, facing ' + facing, 16)
        api['coupler'](s, 0)
        s.part('trucks')
        for start in sorted((3, 22), key=lambda u: U(u, 7)):
            box(s, U(start, 7), -5, 0, 7, 10, 3, '#747a6d', '#3e4640')
            for offset in (1.5, 5.5):
                if iso:
                    s.disc_side(U(start + offset), 5.5, 1.8, 1.7, '#666d62', '#303a35')
                else:
                    s.disc_side(U(start + offset), 1.8, 1.7, '#666d62', '#303a35', v=5.5)
        s.part('frame')
        box(s, 0, -5, 3, L, 10, 2, '#858571', '#4e544a')
        s.line_u(0, L, 5, 4, '#c0a477')
        # A high, full-width rounded-era body and end cab, distinct from the modern road engine's narrow hood.
        def body():
            s.part('engine-body')
            box(s, U(2, 21), -4.5, 5, 21, 9, 10, '#739698', '#45676f', '#344c57')
            for start in (5, 8, 11, 14, 17):
                s.line_z(U(start), 4.5, 7, 13, '#2f454d')
            for start in (6, 14):
                box(s, U(start, 4), -2, 15, 4, 4, 1, '#575b50', '#3f493e')
        def cab():
            s.part('cab')
            box(s, U(23, 7), -5, 5, 7, 10, 12, '#86a5a3', '#537982', '#395661')
            s.world_poly([(U(25), 5, 12), (U(28), 5, 12), (U(28), 5, 15), (U(25), 5, 15)], '#dec38a')
            box(s, U(22.5, 8), -5.5, 17, 8, 11, 1, '#a6b8b0', '#69858b')
        for _, draw in sorted(((U(12), body), (U(26), cab)), key=lambda entry: entry[0]):
            draw()
        finish(s, L, 18)
        s.mark('cab', U(26), 0, 18)
        result.append(s)
    return result
