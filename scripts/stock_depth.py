"""Offline hidden-surface removal for the existing flat-colour stock SVGs.

Retain authored polygons, colours and pixel-snapped outlines. Clip only portions
hidden by a nearer face; sorting whole components cannot handle intersecting
cab/hood/boiler surfaces. Nothing here runs in the player's browser.
"""
import math

EPS = 1e-7


def area(points):
    return sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(points, points[1:]+points[:1])) / 2


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def clip(points, plane):
    """Convex polygon on the non-negative side of ax + by + c."""
    result = []
    if not points:
        return result
    a, b, c = plane
    previous = points[-1]
    dp = a*previous[0]+b*previous[1]+c
    for current in points:
        dc = a*current[0]+b*current[1]+c
        if (dp >= 0) != (dc >= 0):
            t = dp/(dp-dc)
            result.append((previous[0]+t*(current[0]-previous[0]),
                           previous[1]+t*(current[1]-previous[1])))
        if dc >= 0:
            result.append(current)
        previous, dp = current, dc
    return result if len(result) >= 3 and abs(area(result)) > EPS else []


def subtract(points, cover):
    """Disjoint convex fragments outside a convex, counterclockwise cover."""
    planes = [(a[1]-b[1], b[0]-a[0], a[0]*b[1]-b[0]*a[1])
              for a, b in zip(cover, cover[1:]+cover[:1])]
    intersection = points
    for plane in planes:
        intersection = clip(intersection, plane)
        if not intersection:
            return [points]
    result = []
    for plane in planes:
        outside = clip(points, tuple(-n for n in plane))
        if outside:
            result.append(outside)
        points = clip(points, plane)
        if not points:
            break
    return result


def triangles(points):
    """Ear clipping, preserving vertex indices for depth interpolation."""
    indices = list(range(len(points)))
    if area(points) < 0:
        indices.reverse()
    while len(indices) > 3:
        for j, mid in enumerate(indices):
            prev, after = indices[j-1], indices[(j+1) % len(indices)]
            a, b, c = points[prev], points[mid], points[after]
            if cross(a, b, c) <= EPS:
                continue
            if any(all(cross(p, q, points[k]) >= -EPS for p, q in ((a,b),(b,c),(c,a)))
                   for k in indices if k not in (prev, mid, after)):
                continue
            yield (prev, mid, after)
            indices.pop(j)
            break
        else:
            # Rounded geometry can collapse adjacent vertices/edges.
            for j, mid in enumerate(indices):
                if abs(cross(points[indices[j-1]], points[mid], points[indices[(j+1) % len(indices)]])) < EPS:
                    indices.pop(j)
                    break
            else:
                raise ValueError('Non-simple stock polygon')
    if len(indices) == 3 and abs(area([points[i] for i in indices])) > EPS:
        yield tuple(indices)


def depth_plane(projected, depths):
    """Affine screen-space depth, using unsnapped geometry (decals stay coplanar)."""
    a, b, c = projected
    det = cross(a, b, c)
    if abs(det) < EPS:
        return None
    db, dc = depths[1]-depths[0], depths[2]-depths[0]
    dx = (db*(c[1]-a[1])-dc*(b[1]-a[1]))/det
    dy = ((b[0]-a[0])*dc-(c[0]-a[0])*db)/det
    return dx, dy, depths[0]-dx*a[0]-dy*a[1]


def bounds(points):
    return min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)


def overlap(a, b):
    return a[0] < b[2]-EPS and b[0] < a[2]-EPS and a[1] < b[3]-EPS and b[1] < a[3]-EPS


def surfaces(points, projected, depths):
    indices = list(range(len(points)))
    if area(points) < 0:
        indices.reverse()
    if all(cross(points[indices[i-2]], points[indices[i-1]], points[indices[i]]) >= -EPS
           for i in range(len(indices))):
        for tri in triangles(points):
            plane = depth_plane([projected[i] for i in tri], [depths[i] for i in tri])
            if plane is not None:
                if all(abs(plane[0]*p[0]+plane[1]*p[1]+plane[2]-d) < EPS
                       for p, d in zip(projected, depths)):
                    yield [points[i] for i in indices], plane
                    return
                break
    for tri in triangles(points):
        plane = depth_plane([projected[i] for i in tri], [depths[i] for i in tri])
        if plane is not None:
            yield [points[i] for i in tri], plane


class StockDepth:
    """Mixin: record world geometry alongside the generators' screen polygons."""

    def init_depth(self, project, iso):
        self.depth_enabled = '-loco-' in self.name or '-car-' in self.name
        self.depth_project, self.depth_iso = project, iso
        self.depth_faces = {}
        self.depth_resolved = False

    def record_face(self, world):
        if self.depth_enabled:
            self.depth_faces[(len(self.parts)-1, len(self.parts[-1][1])-1)] = list(world)

    def record_side_line(self, v):
        """Screen-width strokes still belong to their side's world-space plane."""
        pts = self.parts[-1][1][-1][0]
        self.record_face([(x+v, v, x/2+v-y) if self.depth_iso else
                          (x, v, v-y/math.cos(math.pi/4)) for x, y in pts])

    def stock_svg_part(self, name, polygons, ax, ay):
        """One path per part/colour, not a DOM node per clipped fragment."""
        def number(n):
            return f'{n:.5f}'.rstrip('0').rstrip('.') if n else '0'

        paths = {}
        output = []
        for pts, fill, opacity in polygons:
            data = 'M'+' '.join(number(x+ax)+','+number(y+ay) for x, y in pts)+'Z'
            if name == 'silhouette-underlays':
                output.append(f'<path d="{data}" fill="{fill}"/>')
            else:
                paths.setdefault((fill, opacity), []).append(data)
        for (fill, opacity), fragments in paths.items():
            output.append(f'<path d="{"".join(fragments)}" fill="{fill}"/>')
        return output

    def resolve_depth(self):
        if not self.depth_enabled or self.depth_resolved:
            return
        faces, underlays = [], []
        self.depth_bounds = self.bounds()
        for part, (name, polys) in enumerate(self.parts):
            for index, (pts, fill, opacity) in enumerate(polys):
                world = self.depth_faces.get((part, index))
                if world is None:
                    underlays.append((pts, fill, opacity))
                    continue
                if opacity != 1:
                    raise ValueError('Stock depth faces must be opaque')
                projected = [self.depth_project(*p) for p in world]
                depths = [sum(p) if self.depth_iso else p[1]+p[2] for p in world]
                for polygon, plane in surfaces(pts, projected, depths):
                    faces.append((polygon, plane, bounds(polygon), part, fill, opacity))
        visible = [(name, []) for name, _ in self.parts]
        for i, (polygon, plane, box, part, fill, opacity) in enumerate(faces):
            fragments = [polygon]
            for j, (other, other_plane, other_box, *_) in enumerate(faces):
                if i == j or not overlap(box, other_box):
                    continue
                delta = tuple(b-a for a, b in zip(plane, other_plane))
                if all(abs(n) < EPS for n in delta):
                    if j < i:
                        continue  # later coplanar paint wins, never paint through a nearer face
                    cover = other
                else:
                    cover = clip(other, (delta[0], delta[1], delta[2]-EPS))
                if not cover or not overlap(box, bounds(cover)):
                    continue
                fragments = [piece for fragment in fragments for piece in subtract(fragment, cover)]
                if not fragments:
                    break
            for fragment in fragments:
                # Stable, compact SVG coordinates; retain the original outline rather
                # than snapping each new clipping edge and opening seams.
                pts = [(round(x, 5), round(y, 5)) for x, y in fragment]
                if abs(area(pts)) > EPS:
                    visible[part][1].append((pts, fill, opacity))
        self.parts = [('silhouette-underlays', underlays)] + visible
        self.depth_resolved = True
