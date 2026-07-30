# DOPE UFO — orchestrator. Run from Blender:
#   import sys; sys.path.insert(0,'<dir>'); exec(open('<dir>/build.py').read())
import bpy, sys, os, math, importlib, time
from mathutils import Vector, Matrix

DIR = os.path.dirname(os.path.abspath(__file__)) if '__file__' in dir() else BLDIR
if DIR not in sys.path:
    sys.path.insert(0, DIR)

import lib, rig, body, weapons, anims
for m in (lib, rig, body, weapons, anims):
    importlib.reload(m)
from lib import Parts, skin_objects, join_parts, smart_uv, bake_vertex_colours

OUT = os.path.abspath(os.path.join(DIR, '..', '..', '..', 'public', 'models'))
os.makedirs(OUT, exist_ok=True)

TEAMS = (0, 1)
CLASSES = ('Ranger', 'Sharpshooter', 'Grenadier', 'Specialist')


# ------------------------------------------------------------------ scene ----
def wipe():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for blk in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials,
                bpy.data.actions, bpy.data.images, bpy.data.objects):
        for d in list(blk):
            if d.users == 0:
                try:
                    blk.remove(d)
                except Exception:
                    pass


def mats():
    out = []
    for nm, col, rough, metal in (('BODY', (0.5, 0.5, 0.5, 1), 0.75, 0.0),
                                  ('GLASS', (0.05, 0.09, 0.12, 1), 0.10, 0.0)):
        m = bpy.data.materials.get(nm)
        if m is None:
            m = bpy.data.materials.new(nm)
            m.use_nodes = True
            b = m.node_tree.nodes.get('Principled BSDF')
            if b:
                b.inputs['Base Color'].default_value = col
                b.inputs['Roughness'].default_value = rough
                b.inputs['Metallic'].default_value = metal
        out.append(m)
    return out


def export(objs, path, animations=False):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=False, export_yup=True, export_skins=True,
        export_texcoords=True, export_normals=True,
        export_vertex_color='ACTIVE', export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True,
        export_materials='EXPORT', export_animations=animations,
        export_animation_mode='ACTIONS' if animations else 'ACTIONS',
        export_bake_animation=False, export_force_sampling=True,
        export_optimize_animation_size=False,
        export_nla_strips=False, export_anim_single_armature=True,
        export_extras=False, export_cameras=False, export_lights=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop('export_extras', None)
        bpy.ops.export_scene.gltf(**kw)
    return os.path.getsize(path)


# -------------------------------------------------------------- character ----
def build_character(team, cls, export_glb=True, with_anims=False):
    t0 = time.time()
    wipe()
    coll = bpy.context.collection
    M = mats()
    arm = rig.build_armature(coll, 'soldier_rig')
    P = Parts(M, coll)
    body.build_body(P, team, cls)
    skin_objects(P, arm)
    ob = join_parts(P, f'soldier_t{team}_{cls.lower()}', arm)

    # bind
    ob.parent = arm
    md = ob.modifiers.new('Armature', 'ARMATURE')
    md.object = arm
    md.use_vertex_groups = True

    smart_uv(ob)
    bake_vertex_colours(ob, seed=team * 17 + len(cls))

    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    verts = len(ob.data.vertices)

    if with_anims:
        anims.build_all(arm)

    path = os.path.join(OUT, f'soldier_t{team}_{cls.lower()}.glb')
    size = export([arm, ob], path, animations=with_anims) if export_glb else 0
    return dict(team=team, cls=cls, tris=tris, verts=verts, kb=size // 1024,
                secs=round(time.time() - t0, 1))


def build_anim_only():
    """Armature + actions only — every character GLB reuses these clips."""
    wipe()
    coll = bpy.context.collection
    arm = rig.build_armature(coll, 'soldier_rig')
    n = anims.build_all(arm)
    path = os.path.join(OUT, 'soldier_anims.glb')
    size = export([arm], path, animations=True)
    return dict(actions=n, kb=size // 1024)


def build_weapons(only=None):
    out = []
    for name, fn in weapons.ALL.items():
        if only and name not in only:
            continue
        wipe()
        coll = bpy.context.collection
        P = Parts(mats(), coll)
        fn(P)
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in P.objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = P.objs[0]
        bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active
        ob.name = name
        smart_uv(ob)
        bake_vertex_colours(ob, seed=len(name), boot_grime=0.0)
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        path = os.path.join(OUT, f'wpn_{name}.glb')
        size = export([ob], path)
        out.append(dict(name=name, tris=tris, kb=size // 1024))
    return out


def build_all():
    rep = {'chars': [], 'weapons': [], 'anims': None}
    rep['anims'] = build_anim_only()
    rep['weapons'] = build_weapons()
    for t in TEAMS:
        for c in CLASSES:
            rep['chars'].append(build_character(t, c))
    return rep


# ------------------------------------------------------------- viewport ------
def look(dist=3.2, azim=35, elev=14, target=(0, 0, 0.95)):
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        r3d = area.spaces[0].region_3d
        r3d.view_perspective = 'PERSP'
        r3d.view_location = Vector(target)
        r3d.view_distance = dist
        q = (Matrix.Rotation(math.radians(azim), 4, 'Z')
             @ Matrix.Rotation(math.radians(90 - elev), 4, 'X')).to_quaternion()
        r3d.view_rotation = q
        area.spaces[0].shading.type = 'SOLID'
        area.spaces[0].shading.light = 'STUDIO'
        area.spaces[0].shading.color_type = 'MATERIAL'
        area.spaces[0].overlay.show_overlays = False
        area.tag_redraw()
