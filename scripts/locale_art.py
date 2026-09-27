"""Shared world-space designs for both projections. Called by the two template generators."""

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
    leaf = colour or {'pine': '#4d7060', 'broadleaf': '#54754a', 'acacia': '#657347',
                     'cypress': '#5b7954', 'olive': '#778768', 'oak': '#647d4f',
                     'grass': '#a2a16a', 'scrub': '#92905c', 'moss': '#9c9a71', 'rock': '#a7aaa0'}[kind]
    def poly(points, fill):
        s.world_poly([(u + x, v, z + ground_z) for x, z in points], fill)
    s.part('vegetation-' + kind)
    if kind in ('grass', 'scrub', 'moss'):
        height = {'grass': 4, 'scrub': 5, 'moss': 2}[kind]
        for x in (-4, 0, 3):
            poly([(x - 2, 0), (x - 3, height - 1), (x, height / 2), (x + 1, height), (x + 2, 0)], leaf)
        return
    if kind == 'rock':
        poly([(-6, 0), (-4, 5), (2, 7), (6, 3), (6, 0)], '#747b78')
        poly([(-4, 5), (2, 7), (6, 3), (1, 4)], leaf)
        return
    height = {'pine': 26, 'broadleaf': 25, 'acacia': 17, 'cypress': 28, 'olive': 14, 'oak': 21}[kind] + variant % 3
    poly([(-1, 0), (-1, height - 5), (1, height - 5), (2, 0)], '#665b42')
    if kind in ('pine', 'cypress'):
        width = 7 if kind == 'pine' else 4
        for base in (5, 11, 16):
            poly([(-width, base), (0, height - (16 - base) / 2), (width, base)], leaf)
            width -= 1
        poly([(0, height), (3, height - 8), (0, height - 6)], '#759078')
    elif kind == 'acacia':
        poly([(0, 6), (-6, 13), (-5, 14), (1, 9), (6, 14), (7, 13), (1, 6)], '#665b42')
        poly([(-11, 12), (-9, 16), (-4, height), (7, height), (11, 14), (7, 12)], leaf)
        poly([(-9, 16), (-4, height), (7, height), (9, 16)], '#8b9563')
    else:
        wide = 10 if kind == 'broadleaf' else 8
        poly([(-wide, height - 9), (-wide, height - 4), (-5, height), (4, height + 1),
              (wide, height - 3), (wide, height - 9), (3, height - 11), (-5, height - 10)], leaf)
        poly([(-wide, height - 4), (-5, height), (4, height + 1), (5, height - 3), (-2, height - 4)], '#829464')
        if kind == 'broadleaf':
            poly([(5, height - 6), (6, 4), (7, 4), (7, height - 7)], '#638052')


def yard_plants(api):
    result = []
    for kind in dict.fromkeys(value[0] for value in BIOMES.values()):
        s = api['Sprite']('railyard-plant-' + kind, kind.title())
        plant(s, kind, ground_z=0)
        result.append(s)
    return result


def driving_landscapes(api):
    result = []
    for name, (kind, ground, near, far, sky, leaf) in BIOMES.items():
        for mountain in (False, True):
            s = api['terrain']('local-' + name + ('-mountain' if mountain else ''), name.title(),
                               ground, near, far, sky, leaf, snow=mountain)
            if mountain and name not in ('alpine', 'tundra'):
                snow = api['P']['mountain_snow']
                s.parts = [(part, [(points, far if fill == snow else fill, alpha)
                                  for points, fill, alpha in shapes]) for part, shapes in s.parts]
            if name == 'wetland':
                s.part('standing-water')
                for start in (0, 39):
                    s.world_poly([(start, -24, 2), (start + 30, -24, 2),
                                  (start + 22, -9, 2), (start + 3, -8, 2)], '#657e79')
            positions = (12, 38, 65) if kind in ('acacia', 'olive', 'oak', 'broadleaf') else (9, 25, 43, 59, 70)
            for i, u in enumerate(positions):
                # Keep each silhouette inside the repeat to avoid seams at x=0/80.
                plant(s, kind, u, -22 + i % 2 * 4, leaf, i)
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
            box(s, U(2, 21), -4.5, 5, 21, 9, 10, '#a1825d', '#775b46', '#594b3b')
            for start in (5, 8, 11, 14, 17):
                s.line_z(U(start), 4.5, 7, 13, '#443e35')
            for start in (6, 14):
                box(s, U(start, 4), -2, 15, 4, 4, 1, '#575b50', '#3f493e')
        def cab():
            s.part('cab')
            box(s, U(23, 7), -5, 5, 7, 10, 12, '#ab9270', '#8b6c4e', '#69543e')
            s.world_poly([(U(25), 5, 12), (U(28), 5, 12), (U(28), 5, 15), (U(25), 5, 15)], '#dec38a')
            box(s, U(22.5, 8), -5.5, 17, 8, 11, 1, '#b3a186', '#82715a')
        for _, draw in sorted(((U(12), body), (U(26), cab)), key=lambda entry: entry[0]):
            draw()
        finish(s, L, 18)
        s.mark('cab', U(26), 0, 18)
        result.append(s)
    return result
