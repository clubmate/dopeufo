# DOPE UFO — animation authoring.
# Everything is built from a small stance vocabulary: pelvis placement + spine FK
# + foot IK targets + a weapon transform that both hands are solved onto. That
# keeps the hands welded to the gun in every pose, which is what sells a tactical
# shooter — no floating rifles, no sliding statues.
import bpy, math
from mathutils import Vector, Matrix, Euler
import rig as R

D = math.radians
FPS = 30


def ease(t):
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def vlerp(a, b, t):
    return Vector(a).lerp(Vector(b), t)


def gunM(pos, yaw=0.0, pitch=0.0, roll=0.0):
    """Weapon transform: +Y muzzle, +Z top rail. yaw about Z, pitch about X."""
    return (Matrix.Translation(Vector(pos))
            @ Matrix.Rotation(D(yaw), 4, 'Z')
            @ Matrix.Rotation(D(pitch), 4, 'X')
            @ Matrix.Rotation(D(roll), 4, 'Y'))


class Stance:
    def __init__(self, p):
        self.p = p
        self.rel = None  # hand_R -> weapon rest offset

    def _rel(self):
        if self.rel is None:
            self.rel = self.p.rest['hand_R'].inverted() @ self.p.rest['weapon']
        return self.rel

    # -- torso ---------------------------------------------------------------
    def body(self, hip=(0, 0, R.Z_HIP), hip_rot=(0, 0, 0), sp1=(0, 0, 0),
             sp2=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0)):
        p = self.p
        p.reset()
        Rm = p.rest['pelvis']
        h = Rm.translation
        p.W['root'] = p.rest['root'].copy()
        p.W['pelvis'] = (Matrix.Translation(Vector(hip))
                         @ Euler((D(hip_rot[0]), D(hip_rot[1]), D(hip_rot[2])), 'XYZ').to_matrix().to_4x4()
                         @ Matrix.Translation(-h) @ Rm)
        p.fk('spine_01', *sp1)
        p.fk('spine_02', *sp2)
        p.fk('chest', *chest)
        p.fk('neck', *neck)
        p.fk('head', *head)
        p.fk('clavicle_R')
        p.fk('clavicle_L')

    # -- legs ----------------------------------------------------------------
    def foot(self, side, ankle, dir=(0, 1, -0.22), toe=0.0, knee_out=0.06):
        s = 1.0 if side == 'R' else -1.0
        hip = self.p.rest_pt('pelvis', self.p.rest[f'thigh_{side}'].translation)
        pole = hip + Vector((s * knee_out, 0.62, -0.10))
        self.p.leg_ik(side, Vector(ankle), pole, dir, toe)

    def stand_feet(self, spread=0.118, y=0.012, splay=9.0, z=None):
        z = R.Z_ANKLE if z is None else z
        for side, s in (('R', 1.0), ('L', -1.0)):
            self.foot(side, (s * spread, y, z),
                      dir=(s * math.sin(D(splay)), math.cos(D(splay)), -0.22))

    # -- arms / weapon -------------------------------------------------------
    def weapon(self, M, left=(-0.100, 0.270, -0.055), left_grip=(0.0, 0.360, 0.030),
               right_pole=(0.42, -0.12, 0.78), left_pole=(-0.44, 0.10, 0.86)):
        p = self.p
        Wh = M @ self._rel().inverted()
        wrist = Wh.translation
        hy = Vector((Wh[0][1], Wh[1][1], Wh[2][1]))
        hz = Vector((Wh[0][2], Wh[1][2], Wh[2][2]))
        p.arm_ik('R', wrist, Vector(right_pole), hy, hz)
        if left is not None:
            lw = (M @ Vector(left))
            lg = (M @ Vector(left_grip))
            ly = (lg - lw).normalized()
            up = Vector((M[0][2], M[1][2], M[2][2]))
            p.arm_ik('L', lw, Vector(left_pole), ly, up)
        p.follow('weapon')
        p.follow('muzzle')

    def hand(self, side, wrist, ydir, up=(0, 0, 1), pole=None):
        s = 1.0 if side == 'R' else -1.0
        pole = pole or (s * 0.44, -0.10, 0.80)
        self.p.arm_ik(side, Vector(wrist), Vector(pole), Vector(ydir), Vector(up))
        if side == 'R':
            self.p.follow('weapon')
            self.p.follow('muzzle')


# ---------------------------------------------------------------- presets ----
# gun transforms for the standard carries
CARRY_LOW = dict(pos=(0.120, 0.185, 1.115), yaw=-9, pitch=-34, roll=-4)
CARRY_READY = dict(pos=(0.105, 0.195, 1.230), yaw=-7, pitch=-16, roll=-5)
CARRY_AIM = dict(pos=(0.086, 0.190, 1.352), yaw=-3, pitch=0, roll=-7)
CARRY_UP = dict(pos=(0.096, 0.170, 1.330), yaw=-6, pitch=8, roll=-6)
CARRY_TUCK = dict(pos=(0.150, 0.115, 1.140), yaw=-26, pitch=-40, roll=-10)


def carry(st, c, dpos=(0, 0, 0), dyaw=0, dpitch=0, droll=0, left=True):
    pos = Vector(c['pos']) + Vector(dpos)
    M = gunM(pos, c['yaw'] + dyaw, c['pitch'] + dpitch, c['roll'] + droll)
    st.weapon(M, left=(-0.100, 0.270, -0.055) if left else None)
    return M


# ------------------------------------------------------------- action bake ---
def make_action(arm, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = act
    try:
        if hasattr(ad, 'action_slot'):
            slot = None
            for s in act.slots:
                slot = s
                break
            if slot is None and hasattr(act, 'slots'):
                try:
                    slot = act.slots.new(id_type='OBJECT', name=arm.name)
                except TypeError:
                    slot = act.slots.new()
            if slot is not None:
                ad.action_slot = slot
    except Exception as e:
        print('slot', e)
    return act


def bake(arm, poser, name, nframes, fn, loop=True):
    st = Stance(poser)
    act = make_action(arm, name)
    n = nframes
    for i in range(n + 1 if loop else n):
        t = (i / n) if loop else (i / max(1, n - 1))
        fn(st, t, i)
        poser.key(i + 1)
    act.use_frame_range = True
    act.frame_start = 1
    act.frame_end = (n + 1) if loop else n
    return act


# ================================================================ ACTIONS =====
# Sign convention (verified in Blender): rotating a spine bone about world +X by
# a POSITIVE angle tips the torso BACKWARD; negative pitches it forward. rz>0
# yaws toward the soldier's left. Everything below obeys that.

def a_idle(st, t, i):
    br = math.sin(t * math.tau)
    br2 = math.sin(t * math.tau * 2)
    sway = math.sin(t * math.tau + 0.8)
    st.body(hip=(0.004 * sway, 0.002, R.Z_HIP + 0.006 * br),
            hip_rot=(-1.0, 0, 1.2 * sway),
            sp1=(-1.2 - 0.6 * br, 0, -0.6 * sway),
            sp2=(-1.4 - 0.7 * br, 0, -0.8 * sway),
            chest=(-1.0 + 0.9 * br, 0, 1.5 * sway),
            neck=(1.6 + 0.5 * br, 0, 0),
            head=(-1.0 - 0.5 * br2, 0, -2.0 * sway))
    st.stand_feet(spread=0.120, y=0.010, splay=11)
    carry(st, CARRY_READY, dpos=(0.004 * sway, 0.004 * br, 0.008 * br),
          dyaw=1.6 * sway, dpitch=1.4 * br2)


def a_idle_cover(st, t, i):
    br = math.sin(t * math.tau)
    st.body(hip=(0.030, -0.030, R.Z_HIP - 0.055 + 0.005 * br),
            hip_rot=(-5, 0, -16),
            sp1=(-3 - 0.7 * br, 0, 8),
            sp2=(-4, 0, 10),
            chest=(-3 + 0.8 * br, 0, 12),
            neck=(5, 0, -6),
            head=(2, 0, -20 + 2 * math.sin(t * math.tau * 0.5)))
    st.foot('R', (0.150, -0.020, R.Z_ANKLE), dir=(0.34, 0.94, -0.20))
    st.foot('L', (-0.075, 0.150, R.Z_ANKLE), dir=(-0.10, 0.99, -0.20))
    carry(st, CARRY_UP, dpos=(0.010, -0.030, -0.010 + 0.004 * br), dyaw=14, dpitch=22)


def _walk_leg(st, side, ph, stride, lift, ground=0.0):
    s = 1.0 if side == 'R' else -1.0
    ph = ph % 1.0
    duty = 0.62
    if ph < duty:            # stance: foot drags backward under the body
        u = ph / duty
        y = lerp(stride * 0.5, -stride * 0.5, u)
        z = 0.0
        pitch = lerp(-0.42, 0.34, ease(min(1.0, u * 1.3)))
        toe = max(0.0, (u - 0.72) / 0.28) * 34.0
    else:                    # swing
        u = (ph - duty) / (1 - duty)
        y = lerp(-stride * 0.5, stride * 0.5, ease(u))
        z = math.sin(u * math.pi) * lift
        pitch = lerp(0.34, -0.42, ease(u))
        toe = max(0.0, 1.0 - u * 2.2) * 26.0
    st.foot(side, (s * 0.098, y + 0.012, R.Z_ANKLE + z + ground),
            dir=(s * 0.14, 1.0, pitch), toe=toe, knee_out=0.05)


def _walk(st, t, stride=0.68, lift=0.115, speedmix=0.0):
    ph = t
    bob = -abs(math.cos(ph * math.tau)) * 0.022 + 0.011
    sway = math.sin(ph * math.tau)
    tw = math.sin(ph * math.tau)
    lean = 5.0 + speedmix * 11.0            # positive = degrees of forward lean
    st.body(hip=(0.020 * sway, 0.004, R.Z_HIP + bob - speedmix * 0.020),
            hip_rot=(-lean * 0.30, -3.0 * sway, 7.0 * tw),
            sp1=(-lean * 0.25, 1.2 * sway, -3.0 * tw),
            sp2=(-lean * 0.25, 1.4 * sway, -3.5 * tw),
            chest=(-lean * 0.20, -1.0 * sway, -4.0 * tw),
            neck=(lean * 0.55, 0, 0),
            head=(lean * 0.30, 0, 2.0 * tw))
    _walk_leg(st, 'R', ph, stride, lift)
    _walk_leg(st, 'L', ph + 0.5, stride, lift)
    b = math.sin(ph * math.tau * 2)
    carry(st, CARRY_READY,
          dpos=(0.008 * sway, -0.010 * speedmix, -0.012 * speedmix + 0.008 * b),
          dyaw=3.0 * sway, dpitch=-6.0 * speedmix + 2.5 * b, droll=-3.0 * speedmix)


def a_walk(st, t, i):
    _walk(st, t, stride=0.68, lift=0.115, speedmix=0.0)


def a_run(st, t, i):
    _walk(st, t, stride=1.02, lift=0.205, speedmix=1.0)


def _crouch_body(st, t, extra_bob=0.0, yawoff=0.0):
    br = math.sin(t * math.tau)
    st.body(hip=(0.0, -0.030, 0.680 + extra_bob + 0.006 * br),
            hip_rot=(-18, 0, yawoff),
            sp1=(4, 0, 0), sp2=(3 - 0.6 * br, 0, 0),
            chest=(2, 0, 3), neck=(2, 0, 0), head=(-2 - 0.5 * br, 0, 0))


def a_crouch_idle(st, t, i):
    _crouch_body(st, t)
    st.foot('R', (0.142, 0.150, R.Z_ANKLE), dir=(0.24, 0.96, -0.10), knee_out=0.18)
    st.foot('L', (-0.142, 0.096, R.Z_ANKLE), dir=(-0.24, 0.96, -0.10), knee_out=0.18)
    br = math.sin(t * math.tau)
    carry(st, CARRY_READY, dpos=(0.004, 0.010, -0.245 + 0.006 * br), dpitch=6 + 1.5 * br)


def a_crouch_move(st, t, i):
    ph = t
    _crouch_body(st, t, extra_bob=-abs(math.cos(ph * math.tau)) * 0.018)
    for side, off in (('R', 0.0), ('L', 0.5)):
        s = 1.0 if side == 'R' else -1.0
        p = (ph + off) % 1.0
        if p < 0.6:
            u = p / 0.6
            y = lerp(0.24, -0.14, u); z = 0.0
        else:
            u = (p - 0.6) / 0.4
            y = lerp(-0.14, 0.24, ease(u)); z = math.sin(u * math.pi) * 0.075
        st.foot(side, (s * 0.138, y, R.Z_ANKLE + z), dir=(s * 0.22, 0.96, -0.10), knee_out=0.18)
    carry(st, CARRY_READY, dpos=(0.004, 0.010, -0.245), dpitch=6)


def _aim_body(st, br=0.0, yaw=0.0, dz=0.0):
    st.body(hip=(0.010, 0.010, R.Z_HIP - 0.014 + dz),
            hip_rot=(-4, 0, -12 + yaw * 0.35),
            sp1=(-3, 0, 5 + yaw * 0.2), sp2=(-4 + 0.4 * br, 0, 6 + yaw * 0.2),
            chest=(-5, 0, 7 + yaw * 0.25), neck=(4, 0, -3),
            head=(-7, 0, -4 + yaw * 0.2))
    st.foot('R', (0.142, -0.120, R.Z_ANKLE), dir=(0.34, 0.94, -0.18))
    st.foot('L', (-0.092, 0.170, R.Z_ANKLE), dir=(-0.06, 1.0, -0.18))


def a_aim(st, t, i):
    br = math.sin(t * math.tau) * 0.5
    _aim_body(st, br, dz=0.004 * br)
    carry(st, CARRY_AIM, dpos=(0, 0.002 * br, 0.003 * br), dpitch=0.6 * br)


def a_overwatch(st, t, i):
    scan = math.sin(t * math.tau)
    br = math.sin(t * math.tau * 3.0) * 0.5
    _aim_body(st, br, yaw=scan * 26.0, dz=-0.006)
    carry(st, CARRY_AIM, dpos=(0, 0, 0.004 * br), dyaw=scan * 9, dpitch=3 + 0.6 * br)


def a_fire(st, t, i):
    # sharp recoil impulse that decays back into the aim pose
    k = math.exp(-t * 7.0) * math.sin(t * 26.0) if t > 0 else 0.0
    p = math.exp(-t * 6.0) * (1 - math.exp(-t * 40.0))
    st.body(hip=(0.010, 0.010 - p * 0.014, R.Z_HIP - 0.014),
            hip_rot=(-4 + p * 3, 0, -12 + p * 2),
            sp1=(-3 + p * 4, 0, 5), sp2=(-4 + p * 5, 0, 6),
            chest=(-5 + p * 9, 0, 7 + p * 3), neck=(4, 0, -3),
            head=(-7 + p * 5, 0, -4))
    st.foot('R', (0.142, -0.120, R.Z_ANKLE), dir=(0.34, 0.94, -0.18))
    st.foot('L', (-0.092, 0.170, R.Z_ANKLE), dir=(-0.06, 1.0, -0.18))
    carry(st, CARRY_AIM, dpos=(0.004 * k, -0.032 * p, 0.008 * p),
          dpitch=8.0 * p + 2.0 * k, dyaw=1.6 * k)


def a_reload(st, t, i):
    """drop mag -> reach to the chest rig -> insert -> slap -> back to ready."""
    look = -14 if 0.15 < t < 0.75 else -4
    st.body(hip=(0.008, 0.004, R.Z_HIP - 0.012), hip_rot=(-4, 0, -8),
            sp1=(-4, 0, 4), sp2=(-5, 0, 5), chest=(-6, 0, 6), neck=(4, 0, 0),
            head=(look, 0, -6))
    st.stand_feet(spread=0.125, y=0.010, splay=10)
    gm = gunM((0.118, 0.230, 1.250), -14, -22, -8)
    st.weapon(gm, left=None)
    P0 = Vector((-0.010, 0.300, 1.246))     # on the handguard
    P1 = Vector((-0.070, 0.235, 1.120))     # mag pouch on the rig
    P2 = Vector((0.058, 0.245, 1.150))      # magwell
    P3 = Vector((0.132, 0.225, 1.296))      # charging handle
    if t < 0.22:
        u = ease(t / 0.22); pt = P0.lerp(P1, u)
    elif t < 0.40:
        u = ease((t - 0.22) / 0.18); pt = P1.lerp(P1 + Vector((0, 0.03, 0.10)), u)
    elif t < 0.60:
        u = ease((t - 0.40) / 0.20); pt = (P1 + Vector((0, 0.03, 0.10))).lerp(P2, u)
    elif t < 0.74:
        u = ease((t - 0.60) / 0.14); pt = P2.lerp(P2 + Vector((0, 0.01, 0.03)), u)
    elif t < 0.88:
        u = ease((t - 0.74) / 0.14); pt = (P2 + Vector((0, 0.01, 0.03))).lerp(P3, u)
    else:
        u = ease((t - 0.88) / 0.12); pt = P3.lerp(P0, u)
    tgt = Vector((0.030, 0.330, 1.256))
    dirv = (tgt - pt)
    st.hand('L', pt, dirv.normalized() if dirv.length > 1e-3 else Vector((0, 1, 0)),
            up=(0, 0, 1), pole=(-0.46, 0.12, 0.86))


def a_throw(st, t, i):
    """overhand grenade throw: wind up (lean back), release, follow through."""
    if t < 0.30:
        u = ease(t / 0.30); wind = u; rel = 0.0
    elif t < 0.46:
        u = ease((t - 0.30) / 0.16); wind = 1.0 - u * 1.35; rel = u
    else:
        u = ease((t - 0.46) / 0.54); wind = -0.35 + 0.35 * u; rel = 1.0
    fwd = max(0.0, -wind) + rel * 0.9
    st.body(hip=(0.006, -0.030 * max(0.0, wind) + 0.040 * fwd,
                 R.Z_HIP - 0.020 * abs(wind)),
            hip_rot=(6 * wind - 8 * fwd, 0, 18 * wind - 14 * fwd),
            sp1=(8 * wind - 9 * fwd, 0, 10 * wind - 8 * fwd),
            sp2=(9 * wind - 10 * fwd, 0, 12 * wind - 10 * fwd),
            chest=(11 * wind - 13 * fwd, 0, 16 * wind - 14 * fwd),
            neck=(-3, 0, -4 * wind), head=(-5 * wind - 3 * fwd, 0, -8 * wind + 4 * fwd))
    st.foot('R', (0.135, -0.140 - 0.06 * max(0.0, wind), R.Z_ANKLE), dir=(0.30, 0.95, -0.18))
    st.foot('L', (-0.095, 0.180 + 0.05 * rel, R.Z_ANKLE), dir=(-0.06, 1.0, -0.18))
    st.weapon(gunM((-0.150, 0.130, 1.090), 26, -52, -14), left=None)
    A = Vector((0.235, -0.190, 1.575))   # cocked behind the head
    B = Vector((0.150, 0.250, 1.770))    # release, high and forward
    C = Vector((0.060, 0.340, 1.190))    # follow-through low
    if rel <= 0.0:
        pt = Vector((0.190, 0.070, 1.340)).lerp(A, max(0.0, wind))
    elif rel < 1.0:
        pt = A.lerp(B, ease(rel))
    else:
        u = ease((t - 0.46) / 0.54)
        pt = B.lerp(C, u)
    st.hand('R', pt, (0.10, 0.55, 0.83), up=(0, 0, 1), pole=(0.50, -0.30, 1.10))


def a_hit(st, t, i):
    """impact snaps the upper body backward, then a recovery step."""
    k = math.exp(-t * 5.0) * (1 - math.exp(-t * 30.0)) * 1.6
    w = math.sin(t * 18.0) * math.exp(-t * 4.5)
    st.body(hip=(0.020 * k, -0.045 * k, R.Z_HIP - 0.045 * k),
            hip_rot=(14 * k, 6 * w, 10 * k),
            sp1=(12 * k, 4 * w, 6 * k), sp2=(14 * k, 5 * w, 7 * k),
            chest=(18 * k, 6 * w, 9 * k), neck=(-8 * k, 0, -6 * k),
            head=(14 * k, 4 * w, -8 * k))
    st.foot('R', (0.135, -0.120 - 0.10 * k, R.Z_ANKLE + 0.02 * max(0.0, k - 0.5)),
            dir=(0.30, 0.95, -0.18))
    st.foot('L', (-0.100, 0.150, R.Z_ANKLE), dir=(-0.06, 1.0, -0.18))
    carry(st, CARRY_READY, dpos=(0.02 * k, -0.05 * k, -0.06 * k), dpitch=-26 * k, dyaw=16 * k)


def a_death_a(st, t, i):
    """blown onto the back."""
    u = ease(min(1.0, t / 0.62))
    settle = max(0.0, (t - 0.62) / 0.38)
    jerk = math.exp(-t * 9.0) * math.sin(t * 30.0) * (1 - u) * 8.0
    hz = lerp(R.Z_HIP, 0.185, u) - settle * 0.015
    st.body(hip=(0.0, lerp(0.0, -0.340, u), hz),
            hip_rot=(lerp(0, 80, u) + jerk * 0.3, 0, lerp(0, 12, u)),
            sp1=(lerp(6 * (1 - u), -6, u), 0, 0),
            sp2=(lerp(8 * (1 - u), -8, u), 0, lerp(0, -6, u)),
            chest=(lerp(12 * (1 - u), -10, u) + jerk, 0, lerp(0, -8, u)),
            neck=(lerp(-4, 4, u), 0, 0),
            head=(lerp(14 * (1 - u), -20, u) + jerk, 0, lerp(0, 16, u)))
    st.foot('R', (0.150, lerp(-0.10, 0.480, u), lerp(R.Z_ANKLE, 0.075, u)),
            dir=(0.34, 0.86, lerp(-0.18, 0.50, u)), knee_out=0.22)
    st.foot('L', (-0.175, lerp(0.16, 0.360, u), lerp(R.Z_ANKLE, 0.080, u)),
            dir=(-0.30, 0.88, lerp(-0.18, 0.34, u)), knee_out=0.22)
    st.weapon(gunM((lerp(0.12, 0.430, u), lerp(0.20, 0.020, u), lerp(1.20, 0.085, u)),
                   lerp(-8, -70, u), lerp(-16, -84, u), lerp(-5, 40, u)), left=None)
    st.hand('L', (lerp(-0.10, -0.320, u), lerp(0.27, -0.150, u), lerp(1.24, 0.115, u)),
            (lerp(0.6, -0.5, u), lerp(0.7, 0.2, u), lerp(-0.3, -0.8, u)),
            up=(0, 0, 1), pole=(-0.55, 0.10, 0.90))


def a_death_b(st, t, i):
    """dropped to the knees, then face first into the dirt."""
    k = ease(min(1.0, t / 0.42))                       # to the knees
    f = ease(max(0.0, min(1.0, (t - 0.38) / 0.50)))    # onto the face
    tw = math.sin(t * 5.0) * (1 - f) * 4.0
    hz = lerp(lerp(R.Z_HIP, 0.500, k), 0.230, f)
    st.body(hip=(lerp(0, 0.06, f), lerp(0.0, -0.12, k) + f * 0.24, hz),
            hip_rot=(lerp(lerp(0, -12, k), -74, f), tw, lerp(lerp(0, -8, k), -18, f)),
            sp1=(lerp(lerp(4, 12, k), -10, f), 0, 0),
            sp2=(lerp(lerp(4, 14, k), -12, f), tw * 0.5, lerp(0, 8, f)),
            chest=(lerp(lerp(6, 18, k), -14, f), 0, lerp(0, 10, f)),
            neck=(lerp(-4, 10, f), 0, 0),
            head=(lerp(lerp(6, -14, k), 18, f), 0, lerp(0, -14, f)))
    st.foot('R', (0.135, lerp(lerp(-0.10, -0.300, k), -0.380, f),
                  lerp(lerp(R.Z_ANKLE, 0.080, k), 0.075, f)),
            dir=(0.24, lerp(0.95, -0.40, k), lerp(-0.18, -0.88, k)), knee_out=0.16)
    st.foot('L', (-0.145, lerp(lerp(0.14, -0.280, k), -0.350, f),
                  lerp(lerp(R.Z_ANKLE, 0.080, k), 0.075, f)),
            dir=(-0.24, lerp(0.95, -0.40, k), lerp(-0.18, -0.88, k)), knee_out=0.16)
    st.weapon(gunM((lerp(0.13, 0.400, f), lerp(0.20, 0.360, f), lerp(1.22, 0.090, f)),
                   lerp(-8, 40, f), lerp(-16, -80, f), lerp(-5, -30, f)), left=None)
    st.hand('L', (lerp(-0.10, -0.230, f), lerp(0.27, 0.380, f), lerp(1.24, 0.130, f)),
            (lerp(0.6, 0.2, f), lerp(0.7, 0.9, f), lerp(-0.3, -0.35, f)),
            up=(0, 0, 1), pole=(-0.50, 0.30, 0.80))


def a_hunker(st, t, i):
    br = math.sin(t * math.tau) * 0.5
    st.body(hip=(0.0, -0.050, 0.545 + 0.004 * br),
            hip_rot=(-22, 0, -6),
            sp1=(-11, 0, 4), sp2=(-12 - 0.5 * br, 0, 5),
            chest=(-13, 0, 6), neck=(-6, 0, 0), head=(-10 - 0.4 * br, 0, -4))
    st.foot('R', (0.142, 0.180, R.Z_ANKLE), dir=(0.24, 0.96, -0.05), knee_out=0.20)
    st.foot('L', (-0.142, 0.146, R.Z_ANKLE), dir=(-0.24, 0.96, -0.05), knee_out=0.20)
    st.weapon(gunM((0.120, 0.150, 0.800 + 0.004 * br), -22, 58, -12),
              left=(-0.095, 0.255, -0.050))


ACTIONS = [
    ('idle',        96, a_idle,        True),
    ('idle_cover',  96, a_idle_cover,  True),
    ('walk',        30, a_walk,        True),
    ('run',         22, a_run,         True),
    ('crouch_idle', 96, a_crouch_idle, True),
    ('crouch_move', 34, a_crouch_move, True),
    ('aim',         72, a_aim,         True),
    ('overwatch',  120, a_overwatch,   True),
    ('fire',        18, a_fire,        False),
    ('reload',      66, a_reload,      False),
    ('throw',       44, a_throw,       False),
    ('hit',         26, a_hit,         False),
    ('death_a',     52, a_death_a,     False),
    ('death_b',     60, a_death_b,     False),
    ('hunker',      96, a_hunker,      True),
]


def build_all(arm):
    bpy.context.scene.render.fps = FPS
    poser = R.Poser(arm)
    for name, n, fn, loop in ACTIONS:
        bake(arm, poser, name, n, fn, loop)
    arm.animation_data.action = None
    return len(ACTIONS)
