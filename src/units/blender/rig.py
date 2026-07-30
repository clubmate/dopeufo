# DOPE UFO — armature + a deterministic pose solver.
# Poses are authored as ARMATURE-SPACE matrices; the solver back-solves each
# bone's matrix_basis analytically so nothing depends on depsgraph evaluation
# order (which makes batch keyframing both fast and reproducible).
import bpy, math
from mathutils import Vector, Matrix, Euler, Quaternion

D = math.radians

# --- skeleton metrics (metres) ------------------------------------------------
Z_ANKLE = 0.095
Z_KNEE = 0.475
Z_HIP = 0.945
Z_SP1 = 1.020
Z_SP2 = 1.140
Z_CHEST = 1.270
Z_NECK = 1.440
Z_HEAD = 1.545
Z_TOP = 1.795
X_HIP = 0.098
X_SHLD = 0.175
Z_SHLD = 1.435

L_UPPERARM = 0.300
L_FOREARM = 0.270
L_HAND = 0.095
ARM_DROP = D(60.0)              # A-pose: degrees below horizontal
ARM_DIR = Vector((math.cos(ARM_DROP), 0.0, -math.sin(ARM_DROP)))

SHLD_R = Vector((X_SHLD, 0.0, Z_SHLD))
ELBOW_R = SHLD_R + ARM_DIR * L_UPPERARM
WRIST_R = ELBOW_R + ARM_DIR * L_FOREARM
HANDTIP_R = WRIST_R + ARM_DIR * L_HAND

HIP_R = Vector((X_HIP, 0.0, Z_HIP))
KNEE_R = Vector((X_HIP + 0.006, 0.010, Z_KNEE))
ANKLE_R = Vector((X_HIP + 0.010, 0.006, Z_ANKLE))
TOE_R = Vector((X_HIP + 0.010, 0.135, 0.035))
TOETIP_R = Vector((X_HIP + 0.010, 0.205, 0.030))

L_THIGH = (KNEE_R - HIP_R).length
L_CALF = (ANKLE_R - KNEE_R).length


def _m(v):
    return Vector((-v.x, v.y, v.z))


BONES = [
    # name, head, tail, parent
    ('root',       Vector((0, 0, 0)),            Vector((0, 0.20, 0)),          None),
    ('pelvis',     Vector((0, 0, Z_HIP)),        Vector((0, 0, Z_SP1)),         'root'),
    ('spine_01',   Vector((0, 0, Z_SP1)),        Vector((0, 0, Z_SP2)),         'pelvis'),
    ('spine_02',   Vector((0, 0, Z_SP2)),        Vector((0, 0, Z_CHEST)),       'spine_01'),
    ('chest',      Vector((0, 0, Z_CHEST)),      Vector((0, 0, Z_NECK)),        'spine_02'),
    ('neck',       Vector((0, 0, Z_NECK)),       Vector((0, 0, Z_HEAD)),        'chest'),
    ('head',       Vector((0, 0, Z_HEAD)),       Vector((0, 0, Z_TOP)),         'neck'),
    ('clavicle_R', Vector((0.030, 0, 1.395)),    SHLD_R,                        'chest'),
    ('upperarm_R', SHLD_R,                       ELBOW_R,                       'clavicle_R'),
    ('lowerarm_R', ELBOW_R,                      WRIST_R,                       'upperarm_R'),
    ('hand_R',     WRIST_R,                      HANDTIP_R,                     'lowerarm_R'),
    ('clavicle_L', Vector((-0.030, 0, 1.395)),   _m(SHLD_R),                    'chest'),
    ('upperarm_L', _m(SHLD_R),                   _m(ELBOW_R),                   'clavicle_L'),
    ('lowerarm_L', _m(ELBOW_R),                  _m(WRIST_R),                   'upperarm_L'),
    ('hand_L',     _m(WRIST_R),                  _m(HANDTIP_R),                 'lowerarm_L'),
    ('thigh_R',    HIP_R,                        KNEE_R,                        'pelvis'),
    ('calf_R',     KNEE_R,                       ANKLE_R,                       'thigh_R'),
    ('foot_R',     ANKLE_R,                      TOE_R,                         'calf_R'),
    ('toe_R',      TOE_R,                        TOETIP_R,                      'foot_R'),
    ('thigh_L',    _m(HIP_R),                    _m(KNEE_R),                    'pelvis'),
    ('calf_L',     _m(KNEE_R),                   _m(ANKLE_R),                   'thigh_L'),
    ('foot_L',     _m(ANKLE_R),                  _m(TOE_R),                     'calf_L'),
    ('toe_L',      _m(TOE_R),                    _m(TOETIP_R),                  'foot_L'),
    # weapon socket: sits in the right palm, muzzle running along the hand axis
    ('weapon',     WRIST_R + ARM_DIR * 0.045,    WRIST_R + ARM_DIR * 0.045 + Vector((0, 0.16, 0)), 'hand_R'),
    ('muzzle',     WRIST_R + ARM_DIR * 0.045 + Vector((0, 0.16, 0)),
                   WRIST_R + ARM_DIR * 0.045 + Vector((0, 0.24, 0)), 'weapon'),
]

DEFORM = {n for n, *_ in BONES} - {'root', 'weapon', 'muzzle'}


def build_armature(coll, name='soldier_rig'):
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    coll.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    made = {}
    for nm, head, tail, parent in BONES:
        b = eb.new(nm)
        b.head = head
        b.tail = tail
        b.use_connect = False
        b.use_deform = nm in DEFORM
        if parent:
            b.parent = eb[parent]
        made[nm] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


# ---------------------------------------------------------------- poser ------
class Poser:
    """Author armature-space matrices, then bake them into matrix_basis."""

    def __init__(self, arm):
        self.arm = arm
        self.rest = {}
        self.parent = {}
        self.order = []
        for b in arm.data.bones:
            self.rest[b.name] = b.matrix_local.copy()
            self.parent[b.name] = b.parent.name if b.parent else None
        seen = set()

        def visit(n):
            if n in seen:
                return
            p = self.parent[n]
            if p:
                visit(p)
            seen.add(n)
            self.order.append(n)
        for b in arm.data.bones:
            visit(b.name)
        self.W = {}
        self.reset()

    # -- authoring ------------------------------------------------------------
    def reset(self):
        self.W = {n: self.rest[n].copy() for n in self.order}

    def head(self, name):
        return self.W[name].translation.copy()

    def tail(self, name):
        L = (self.rest[name].inverted() @ Matrix()).to_translation()  # unused
        b = self.arm.data.bones[name]
        return (self.W[name] @ Matrix.Translation((0, b.length, 0))).translation

    def rest_pt(self, name, p_world_rest):
        """Where a rest-space world point ends up once `name` is posed."""
        return (self.W[name] @ self.rest[name].inverted() @ Vector(p_world_rest))

    def place(self, name, origin, ydir, up_hint=(0, 0, 1)):
        y = Vector(ydir).normalized()
        u = Vector(up_hint)
        z = u - y * u.dot(y)
        if z.length < 1e-5:
            u = Vector((0, 0, 1)) if abs(y.z) < 0.9 else Vector((0, 1, 0))
            z = u - y * u.dot(y)
        z.normalize()
        x = y.cross(z)
        self.W[name] = Matrix((
            (x.x, y.x, z.x, origin[0]),
            (x.y, y.y, z.y, origin[1]),
            (x.z, y.z, z.z, origin[2]),
            (0.0, 0.0, 0.0, 1.0)))
        return self.W[name]

    def fk(self, name, rx=0.0, ry=0.0, rz=0.0):
        """Rotate about the bone head in rest-world axes, following the parent."""
        R = self.rest[name]
        head = R.translation
        rot = Euler((D(rx), D(ry), D(rz)), 'XYZ').to_matrix().to_4x4()
        local = Matrix.Translation(head) @ rot @ Matrix.Translation(-head) @ R
        p = self.parent[name]
        if p:
            self.W[name] = self.W[p] @ self.rest[p].inverted() @ local
        else:
            self.W[name] = local
        return self.W[name]

    def translate(self, name, dx=0.0, dy=0.0, dz=0.0):
        self.W[name] = Matrix.Translation((dx, dy, dz)) @ self.W[name]

    def follow(self, name):
        """Recompute this bone from its parent's pose keeping its rest offset."""
        p = self.parent[name]
        if p:
            self.W[name] = self.W[p] @ self.rest[p].inverted() @ self.rest[name]
        else:
            self.W[name] = self.rest[name].copy()
        return self.W[name]

    def follow_all(self, names):
        for n in names:
            self.follow(n)

    # -- limb solvers ---------------------------------------------------------
    def arm_ik(self, side, wrist, pole, hand_y, hand_up):
        c, u, lo, hd = (f'clavicle_{side}', f'upperarm_{side}',
                        f'lowerarm_{side}', f'hand_{side}')
        shoulder = self.tail(c)
        elbow, d1, d2 = _ik(shoulder, Vector(wrist), Vector(pole), L_UPPERARM, L_FOREARM)
        upn = (Vector(pole) - shoulder)
        self.place(u, shoulder, d1, upn)
        self.place(lo, elbow, d2, upn)
        self.place(hd, elbow + d2 * L_FOREARM, hand_y, hand_up)
        self.follow('weapon' if side == 'R' else 'hand_L')
        if side == 'R':
            self.follow('weapon')
            self.follow('muzzle')
        return elbow

    def leg_ik(self, side, ankle, pole, foot_dir=(0, 1, -0.25), toe_lift=0.0):
        t, c, f, tt = (f'thigh_{side}', f'calf_{side}', f'foot_{side}', f'toe_{side}')
        hip_rest = self.rest[t].translation
        hip = self.rest_pt('pelvis', hip_rest)
        knee, d1, d2 = _ik(hip, Vector(ankle), Vector(pole), L_THIGH, L_CALF)
        pn = Vector(pole) - hip
        self.place(t, hip, d1, pn)
        self.place(c, knee, d2, pn)
        fd = Vector(foot_dir).normalized()
        self.place(f, knee + d2 * L_CALF, fd, (0, 0, 1))
        td = Vector(foot_dir).normalized()
        if toe_lift:
            td = Euler((D(-toe_lift), 0, 0), 'XYZ').to_matrix() @ td
        self.place(tt, self.tail(f), td.normalized(), (0, 0, 1))
        return knee

    # -- baking ---------------------------------------------------------------
    def bases(self):
        out = {}
        for n in self.order:
            p = self.parent[n]
            R = self.rest[n]
            if p:
                rel = self.rest[p].inverted() @ R
                out[n] = rel.inverted() @ self.W[p].inverted() @ self.W[n]
            else:
                out[n] = R.inverted() @ self.W[n]
        return out

    def apply(self):
        for n, B in self.bases().items():
            pb = self.arm.pose.bones[n]
            loc, quat, _ = B.decompose()
            pb.location = loc
            pb.rotation_quaternion = quat

    def key(self, frame, bones=None):
        self.apply()
        names = bones or self.order
        for n in names:
            pb = self.arm.pose.bones[n]
            pb.keyframe_insert('location', frame=frame)
            pb.keyframe_insert('rotation_quaternion', frame=frame)


def _ik(root, target, pole, l1, l2):
    d = target - root
    dist = d.length
    lo, hi = abs(l1 - l2) + 1e-3, l1 + l2 - 2e-3
    if dist < 1e-6:
        d = Vector((0, 0, -lo)); dist = lo
    elif dist < lo:
        d = d.normalized() * lo; dist = lo
    elif dist > hi:
        d = d.normalized() * hi; dist = hi
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
