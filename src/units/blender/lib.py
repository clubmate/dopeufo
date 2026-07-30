# DOPE UFO — soldier build library (Blender 5.x, pure bmesh, no UI deps)
# Coordinate convention while modelling:  +Z up, +Y = soldier FORWARD, +X = soldier's RIGHT.
# glTF export (+Y up) turns blender +Y into three -Z, so the JS wrapper spins the
# model 180deg and facing 0 == +Z as the architecture contract demands.
import bpy, bmesh, math, random
from mathutils import Vector, Matrix, Euler, Quaternion

D = math.radians
TAU = math.pi * 2.0

# ---------------------------------------------------------------- palette ----
# 4x4 atlas. Cell i -> column i%4, row i//4. The JS side paints the same layout.
PAL_N = 4
P_CLOTH   = 0   # uniform fabric, team primary
P_KEVLAR  = 1   # plate carrier / cordura, dark neutral
P_HELMET  = 2   # painted composite helmet, team primary (darker)
P_RUBBER  = 3   # pads, soles, grips — near black, matte
P_METAL   = 4   # scuffed gunmetal
P_WEB     = 5   # nylon webbing / leather, tan
P_SKIN    = 6
P_ACCENT  = 7   # team accent — patches, stripes, glow strips
P_POLY    = 8   # weapon polymer
P_BOOT    = 9   # boot leather
P_OPTIC   = 10  # optic housing, high metalness
P_BRASS   = 11  # brass / buckles
P_CAMO    = 12  # secondary camo panel
P_GLOVE   = 13  # glove fabric
P_DARK    = 14  # balaclava / dark cloth
P_LENS    = 15  # glass (uses the GLASS material slot)


def pal_uv(i):
    return ((i % PAL_N + 0.5) / PAL_N, (i // PAL_N + 0.5) / PAL_N)


# ------------------------------------------------------------- bmesh utils ---
def _sharpen(bm, angle=36.0):
    a = D(angle)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            try:
                e.smooth = e.calc_face_angle(0.0) < a
            except Exception:
                e.smooth = True


def _bevel(bm, offset, segments=2):
    if offset <= 0:
        return
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    bmesh.ops.bevel(bm, geom=geom, offset=offset, offset_type='OFFSET',
                    segments=segments, profile=0.6, affect='EDGES',
                    clamp_overlap=True, miter_outer='ARC', loop_slide=True)


def xform(bm, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    M = (Matrix.Translation(Vector(loc))
         @ Euler((D(rot[0]), D(rot[1]), D(rot[2])), 'XYZ').to_matrix().to_4x4()
         @ Matrix.Diagonal(Vector(scale).to_4d()))
    bmesh.ops.transform(bm, matrix=M, verts=list(bm.verts))
    return bm


def box(sx, sy, sz, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.010, seg=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx; v.co.y *= sy; v.co.z *= sz
    _bevel(bm, bevel, seg)
    xform(bm, loc, rot)
    return bm


def taper(w0, d0, w1, d1, h, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.014, seg=2,
          shear=0.0):
    """Box whose top face has different dimensions than the bottom. `shear`
    slides the top face along +Y (lets a chest lean forward without rotating)."""
    bm = bmesh.new()
    z0, z1 = -h * 0.5, h * 0.5
    pts = [(-w0 / 2, -d0 / 2, z0), (w0 / 2, -d0 / 2, z0), (w0 / 2, d0 / 2, z0), (-w0 / 2, d0 / 2, z0),
           (-w1 / 2, -d1 / 2 + shear, z1), (w1 / 2, -d1 / 2 + shear, z1),
           (w1 / 2, d1 / 2 + shear, z1), (-w1 / 2, d1 / 2 + shear, z1)]
    vs = [bm.verts.new(p) for p in pts]
    bm.verts.ensure_lookup_table()
    for f in ((0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    _bevel(bm, bevel, seg)
    xform(bm, loc, rot)
    return bm


def cyl(r0, r1, depth, segments=14, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.004,
        seg=1, caps=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segments,
                          radius1=r0, radius2=r1, depth=depth)
    _bevel(bm, bevel, seg)
    xform(bm, loc, rot)
    return bm


def sphere(r, u=16, v=9, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    xform(bm, loc, rot, scale)
    return bm


def dome(r, u=16, v=8, loc=(0, 0, 0), scale=(1, 1, 1), cut=0.0):
    """Upper hemisphere-ish shell; `cut` is the local z below which verts are
    clamped flat (keeps the rim closed without an ngon fan)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    for vt in bm.verts:
        if vt.co.z < cut:
            vt.co.z = cut
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-5)
    xform(bm, loc, (0, 0, 0), scale)
    return bm


def capsule(p0, p1, r0, r1=None, segments=12, endcaps=True):
    """Tapered limb segment between two world points, with rounded ends."""
    p0, p1 = Vector(p0), Vector(p1)
    r1 = r0 if r1 is None else r1
    d = p1 - p0
    L = d.length
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=not endcaps, cap_tris=False,
                          segments=segments, radius1=r0, radius2=r1, depth=L)
    if endcaps:
        for (rr, zz, sgn) in ((r0, -L / 2, -1), (r1, L / 2, 1)):
            cap = bmesh.new()
            bmesh.ops.create_uvsphere(cap, u_segments=segments, v_segments=6, radius=rr)
            xform(cap, (0, 0, zz), (0, 0, 0), (1, 1, 0.7))
            _merge(bm, cap)
    # orient local +Z onto the segment direction
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    M = Matrix.Translation((p0 + p1) * 0.5) @ q.to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=M, verts=list(bm.verts))
    return bm


def between(bm, p0, p1, roll=0.0):
    """Take a bmesh authored along local +Z centred on origin and place it so
    that local -Z/2..+Z/2 spans p0..p1."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    M = (Matrix.Translation((p0 + p1) * 0.5) @ q.to_matrix().to_4x4()
         @ Matrix.Rotation(roll, 4, 'Z'))
    bmesh.ops.transform(bm, matrix=M, verts=list(bm.verts))
    return bm


def _merge(dst, src):
    """Append src geometry into dst and free src."""
    vmap = {}
    for v in src.verts:
        vmap[v] = dst.verts.new(v.co)
    dst.verts.ensure_lookup_table()
    for f in src.faces:
        try:
            nf = dst.faces.new([vmap[v] for v in f.verts])
            nf.smooth = f.smooth
        except ValueError:
            pass
    src.free()
    return dst


def merge(*bms):
    out = bms[0]
    for b in bms[1:]:
        _merge(out, b)
    return out


def mirror_x(bm):
    """Return a mirrored copy across x=0 (flips winding back)."""
    me = bpy.data.meshes.new('_tmpmir')
    bm.to_mesh(me)
    nb = bmesh.new()
    nb.from_mesh(me)
    bpy.data.meshes.remove(me)
    for v in nb.verts:
        v.co.x = -v.co.x
    bmesh.ops.recalc_face_normals(nb, faces=list(nb.faces))
    return nb


def dupe(bm):
    me = bpy.data.meshes.new('_tmpdup')
    bm.to_mesh(me)
    nb = bmesh.new()
    nb.from_mesh(me)
    bpy.data.meshes.remove(me)
    return nb


def ring(count, radius, fn, y=0.0, z=0.0, start=0.0, span=TAU):
    """Scatter `count` sub-bmeshes around a circle in the XY plane."""
    out = bmesh.new()
    for i in range(count):
        a = start + span * (i / count)
        sub = fn(i, a)
        xform(sub, (math.sin(a) * radius, math.cos(a) * radius + y, z), (0, 0, -math.degrees(a)))
        _merge(out, sub)
    return out


# ------------------------------------------------------------ part emitter ---
class Parts:
    """Collects finished sub-meshes as real Blender objects so the joiner can
    merge them and the skinner can weight them per body region."""

    def __init__(self, mats, coll):
        self.mats = mats
        self.coll = coll
        self.objs = []
        self._n = 0

    def add(self, bm, pal, bones, name='part', glass=False, smooth=36.0):
        self._n += 1
        nm = f'{name}_{self._n:03d}'
        _sharpen(bm, smooth)
        me = bpy.data.meshes.new(nm)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(nm, me)
        self.coll.objects.link(ob)

        uv = me.uv_layers.new(name='UVMap')
        u, v = pal_uv(pal)
        for lp in uv.data:
            lp.uv = (u, v)

        for m in self.mats:
            me.materials.append(m)
        mi = 1 if glass else 0
        for p in me.polygons:
            p.material_index = mi
            p.use_smooth = True

        ob['bones'] = ','.join(bones) if isinstance(bones, (list, tuple)) else bones
        self.objs.append(ob)
        return ob

    def tris(self):
        t = 0
        for o in self.objs:
            for p in o.data.polygons:
                t += len(p.vertices) - 2
        return t


# ------------------------------------------------------------------ skinning -
def bone_segments(arm_obj):
    segs = {}
    for b in arm_obj.data.bones:
        segs[b.name] = (b.head_local.copy(), b.tail_local.copy())
    return segs


def _dist_to_seg(p, a, b):
    ab = b - a
    L2 = ab.length_squared
    if L2 < 1e-9:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (p - (a + ab * t)).length


def skin_objects(parts, arm_obj, power=5.0, maxb=3):
    """Distance-falloff weights restricted to the bone whitelist each part
    declared. Rigid gear ends up 100% on one bone, soft parts blend."""
    segs = bone_segments(arm_obj)
    for ob in parts.objs:
        names = [n for n in str(ob.get('bones', '')).split(',') if n and n in segs]
        if not names:
            names = ['spine_02']
        groups = {n: ob.vertex_groups.new(name=n) for n in names}
        if len(names) == 1:
            g = groups[names[0]]
            g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
            continue
        for vi, v in enumerate(ob.data.vertices):
            p = v.co
            ds = sorted(((_dist_to_seg(p, *segs[n]), n) for n in names))[:maxb]
            ws = [(1.0 / (d + 0.012) ** power, n) for d, n in ds]
            tot = sum(w for w, _ in ws) or 1.0
            for w, n in ws:
                groups[n].add([vi], w / tot, 'REPLACE')


# ------------------------------------------------------ vertex colour grime --
def bake_vertex_colours(ob, seed=0, boot_grime=1.0):
    """Crevice dirt + convex edge wear + a boot-upward grime gradient, written to
    a CORNER byte-colour attribute so the GLB carries it as COLOR_0."""
    me = ob.data
    rng = random.Random(seed)
    n = len(me.vertices)

    # curvature: negative => convex (paint highlight), positive => concave (dirt)
    curv = [0.0] * n
    cnt = [0] * n
    for e in me.edges:
        a, b = e.vertices
        va, vb = me.vertices[a], me.vertices[b]
        d = vb.co - va.co
        L = d.length
        if L < 1e-6:
            continue
        d = d / L
        curv[a] += va.normal.dot(d); cnt[a] += 1
        curv[b] += vb.normal.dot(-d); cnt[b] += 1
    for i in range(n):
        if cnt[i]:
            curv[i] /= cnt[i]

    # one smoothing pass so the wear reads as a band, not per-vertex confetti
    sm = list(curv)
    acc = [0.0] * n
    cc = [0] * n
    for e in me.edges:
        a, b = e.vertices
        acc[a] += curv[b]; cc[a] += 1
        acc[b] += curv[a]; cc[b] += 1
    for i in range(n):
        if cc[i]:
            sm[i] = curv[i] * 0.45 + (acc[i] / cc[i]) * 0.55

    cols = []
    for i, v in enumerate(me.vertices):
        c = sm[i]
        ao = 1.0 - max(0.0, min(1.0, c * 3.4)) * 0.62          # crevice darkening
        wear = max(0.0, min(1.0, -c * 3.0)) * 0.30              # convex edge wear
        z = v.co.z
        grime = 1.0 - boot_grime * 0.34 * max(0.0, min(1.0, (0.42 - z) / 0.42))
        nse = 1.0 + (rng.random() - 0.5) * 0.085
        val = max(0.0, min(1.6, ao * grime * nse + wear))
        # wear also desaturates toward bare metal grey
        cols.append((val, val * (1.0 - wear * 0.10), val * (1.0 - wear * 0.18)))

    attr = me.color_attributes.get('Col')
    if attr is None:
        attr = me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
    me.color_attributes.active_color = attr
    data = attr.data
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            r, g, b = cols[vi]
            data[li].color = (r, g, b, 1.0)
    return attr


# ------------------------------------------------------------------ join -----
def join_parts(parts, name, arm_obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    objs = parts.objs
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name + '_mesh'
    return ob


def smart_uv(ob, angle=66.0, margin=0.008):
    me = ob.data
    if 'detail' not in me.uv_layers:
        me.uv_layers.new(name='detail')
    me.uv_layers.active = me.uv_layers['detail']
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=D(angle), island_margin=margin,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active = me.uv_layers['UVMap']
    # UVMap must stay first so it exports as TEXCOORD_0
    return ob


# ------------------------------------------------------------------ IK -------
def look_matrix(origin, ydir, up_hint):
    """Bone-shaped basis: local +Y along the bone, +Z biased to up_hint."""
    y = Vector(ydir).normalized()
    u = Vector(up_hint)
    z = (u - y * u.dot(y))
    if z.length < 1e-5:
        u = Vector((0, 0, 1)) if abs(y.z) < 0.9 else Vector((0, 1, 0))
        z = (u - y * u.dot(y))
    z.normalize()
    x = y.cross(z)
    M = Matrix((
        (x.x, y.x, z.x, origin.x),
        (x.y, y.y, z.y, origin.y),
        (x.z, y.z, z.z, origin.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
    return M


def two_bone_ik(root, target, pole, l1, l2):
    """Return (elbow/knee position, dir1, dir2)."""
    root, target, pole = Vector(root), Vector(target), Vector(pole)
    d = target - root
    dist = d.length
    lo, hi = abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3
    if dist < lo:
        d = d.normalized() * lo if dist > 1e-6 else Vector((0, 0, -lo))
        dist = lo
    elif dist > hi:
        d = d.normalized() * hi
        dist = hi
    n = d / dist
    cosA = max(-1.0, min(1.0, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)))
    sinA = math.sqrt(max(0.0, 1.0 - cosA * cosA))
    pv = pole - root
    u = pv - n * pv.dot(n)
    if u.length < 1e-5:
        u = Vector((0, 0, 1)) - n * n.z
        if u.length < 1e-5:
            u = Vector((1, 0, 0))
    u.normalize()
    joint = root + (n * cosA + u * sinA) * l1
    return joint, (joint - root).normalized(), (root + d - joint).normalized()
