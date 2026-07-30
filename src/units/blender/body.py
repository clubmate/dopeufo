# DOPE UFO — soldier body construction.
# Two silhouette families:
#   team 0  "VANGUARD"  — regular special forces. Rounded composite helmet with a
#                         full visor + NVG shroud, tall framed rucksack, whip
#                         antenna, soft rounded pauldrons. Tall and vertical.
#   team 1  "SCAVENGER" — irregular raiders. Flat angular welded helmet with a
#                         slit face plate, hooded shoulder cloth, wide angular
#                         pauldrons, chest bandolier, low satchel + bedroll.
#                         Squat, wide, top-heavy.
import math
from mathutils import Vector
from lib import (box, taper, cyl, sphere, dome, capsule, between, merge, xform,
                 dupe, mirror_x, P_CLOTH, P_KEVLAR, P_HELMET, P_RUBBER, P_METAL,
                 P_WEB, P_SKIN, P_ACCENT, P_POLY, P_BOOT, P_OPTIC, P_BRASS,
                 P_CAMO, P_GLOVE, P_DARK, P_LENS)
import rig as R

V = Vector

# arm frame: AD runs down the A-posed arm, AOUT is the outward-facing normal,
# ARMROT orients a Z-long primitive along the arm.
AD = R.ARM_DIR                                   # (0.5, 0, -0.866) for the right
AOUT = V((-AD.z, 0.0, AD.x))                     # (0.866, 0, 0.5)
ARM_DEG = 150.0                                  # rotY that maps +Z onto AD


def _s(side):
    return 1.0 if side == 'R' else -1.0


def arm_frame(side):
    s = _s(side)
    return (V((AD.x * s, AD.y, AD.z)), V((AOUT.x * s, AOUT.y, AOUT.z)),
            (0.0, s * ARM_DEG, 0.0))


def build_body(P, team=0, cls='Ranger'):
    heavy = (cls == 'Grenadier')
    light = (cls == 'Ranger')
    legs(P, team, cls)
    torso(P, team, cls, heavy)
    carrier(P, team, cls, heavy)
    arms(P, team, cls, heavy)
    head(P, team, cls)
    back(P, team, cls)
    class_gear(P, team, cls)


# =============================================================== LEGS =========
def legs(P, team, cls):
    for side in ('R', 'L'):
        s = _s(side)
        thigh_b = [f'thigh_{side}', 'pelvis']
        calf_b = [f'calf_{side}', f'thigh_{side}']
        foot_b = [f'foot_{side}']

        hip = V((s * R.X_HIP, 0.005, R.Z_HIP + 0.02))
        knee = V((s * (R.X_HIP + 0.008), 0.012, R.Z_KNEE))
        ankle = V((s * (R.X_HIP + 0.012), 0.006, R.Z_ANKLE + 0.03))

        # trousers: thigh + shin, slightly baggy at the knee
        P.add(capsule(hip, knee + V((0, 0, -0.02)), 0.098, 0.070, 14),
              P_CLOTH, thigh_b, 'thigh')
        P.add(capsule(knee + V((0, 0, 0.03)), ankle, 0.076, 0.054, 14),
              P_CLOTH, calf_b, 'shin')
        # cargo pocket on the outer thigh
        P.add(box(0.048, 0.105, 0.135, (s * 0.130, 0.010, 0.735), (0, 0, 0), 0.018, 2),
              P_CAMO, thigh_b, 'cargo')
        P.add(box(0.050, 0.104, 0.018, (s * 0.132, 0.010, 0.800), (0, 0, 0), 0.007, 1),
              P_CLOTH, thigh_b, 'cargoflap')
        # knee pad — chunky, reads at distance
        P.add(taper(0.126, 0.130, 0.104, 0.112, 0.140, (s * (R.X_HIP + 0.010), 0.030, 0.496),
                    (-5, 0, 0), 0.034, 2),
              P_RUBBER, calf_b, 'kneepad')
        P.add(box(0.112, 0.024, 0.030, (s * (R.X_HIP + 0.012), 0.070, 0.552),
                  (-10, 0, 0), 0.010, 1),
              P_WEB, calf_b, 'kneestrap')
        # gaiter above the boot
        P.add(cyl(0.082, 0.076, 0.055, 14, (s * (R.X_HIP + 0.012), 0.008, 0.215),
                  (0, 0, 0), 0.008, 1),
              P_WEB, calf_b + foot_b, 'gaiter')

        # ---- boot -----------------------------------------------------------
        bx = s * (R.X_HIP + 0.014)
        P.add(taper(0.114, 0.140, 0.104, 0.122, 0.120, (bx, 0.014, 0.140), (0, 0, 0), 0.020, 2),
              P_BOOT, [f'foot_{side}', f'calf_{side}'], 'bootcuff')
        P.add(taper(0.112, 0.240, 0.114, 0.226, 0.080, (bx, 0.048, 0.078), (0, 0, 0), 0.020, 2),
              P_BOOT, foot_b, 'bootbody')
        P.add(taper(0.118, 0.256, 0.108, 0.244, 0.034, (bx, 0.050, 0.030), (0, 0, 0), 0.010, 2),
              P_RUBBER, foot_b, 'sole')
        P.add(box(0.104, 0.062, 0.050, (bx, 0.146, 0.056), (0, 0, 0), 0.022, 2),
              P_RUBBER, foot_b, 'toecap')
        P.add(box(0.100, 0.060, 0.044, (bx, -0.050, 0.056), (0, 0, 0), 0.018, 2),
              P_RUBBER, foot_b, 'heel')
        for i in range(3):  # laces
            P.add(box(0.086, 0.012, 0.010, (bx, 0.086, 0.108 + i * 0.026), (0, 0, 0), 0.004, 1),
                  P_WEB, foot_b, 'lace')

    # thigh holster (right) + dump pouch (left)
    P.add(box(0.058, 0.098, 0.155, (0.166, 0.020, 0.700), (0, 6, 0), 0.024, 2),
          P_KEVLAR, ['thigh_R'], 'holster')
    P.add(box(0.034, 0.052, 0.082, (0.163, -0.018, 0.792), (14, 6, 0), 0.014, 2),
          P_POLY, ['thigh_R'], 'pistolgrip')
    for z in (0.660, 0.760):
        P.add(cyl(0.098, 0.098, 0.018, 14, (0.104, 0.008, z), (0, 0, 0), 0.005, 1),
              P_WEB, ['thigh_R'], 'holsterstrap')
    P.add(box(0.070, 0.070, 0.105, (-0.158, 0.012, 0.720), (0, -5, 0), 0.024, 2),
          P_CAMO, ['thigh_L'], 'dumppouch')
    P.add(cyl(0.096, 0.096, 0.016, 14, (-0.104, 0.008, 0.700), (0, 0, 0), 0.005, 1),
          P_WEB, ['thigh_L'], 'legstrap')


# =============================================================== TORSO ========
def torso(P, team, cls, heavy):
    w = 1.09 if heavy else 1.0
    # pelvis -> chest: narrow waist, wide ribs. Sharper bevels than the first
    # pass so the shapes read as armour panels instead of inflated cushions.
    P.add(taper(0.286 * w, 0.196, 0.296 * w, 0.200, 0.150, (0, 0, 1.010), (0, 0, 0), 0.020, 2),
          P_CLOTH, ['pelvis', 'spine_01'], 'hips')
    P.add(taper(0.296 * w, 0.200, 0.330 * w, 0.216, 0.150, (0, 0, 1.152), (0, 0, 0), 0.020, 2),
          P_CLOTH, ['spine_01', 'spine_02'], 'abdomen')
    P.add(taper(0.330 * w, 0.216, 0.372 * w, 0.234, 0.180, (0, 0.004, 1.318), (0, 0, 0), 0.022, 2),
          P_CLOTH, ['spine_02', 'chest'], 'ribs')
    P.add(taper(0.372 * w, 0.234, 0.262 * w, 0.176, 0.072, (0, 0.002, 1.442), (0, 0, 0), 0.022, 2),
          P_CLOTH, ['chest'], 'traps')
    # belt
    P.add(taper(0.310 * w, 0.216, 0.310 * w, 0.216, 0.050, (0, 0, 1.058), (0, 0, 0), 0.010, 2),
          P_WEB, ['pelvis', 'spine_01'], 'belt')
    P.add(box(0.058, 0.026, 0.042, (0, 0.114, 1.058), (0, 0, 0), 0.008, 1),
          P_BRASS, ['pelvis'], 'buckle')
    # neck column — deliberately left exposed between collar and jaw
    P.add(cyl(0.070, 0.064, 0.140, 14, (0, 0.004, 1.492), (0, 0, 0), 0.008, 1),
          P_DARK, ['neck', 'chest'], 'neck')


def carrier(P, team, cls, heavy):
    """Plate carrier, webbing and pouches — the read-at-distance gear layer."""
    kv = P_KEVLAR
    d = 0.052 if not heavy else 0.062

    # Front + rear armour, built as three angled panels so the carrier wraps the
    # ribcage instead of hanging off it like a sandwich board.
    ang = 27.0
    for sgn, tag in ((1, 'front'), (-1, 'back')):
        y = sgn * (0.122 + (0.012 if heavy else 0))
        b2 = ['spine_02', 'chest']
        b1 = ['spine_01', 'spine_02']
        P.add(taper(0.196, d, 0.184, d, 0.210, (0, y, 1.286), (0, 0, 0), 0.016, 2),
              kv, b2, f'plate_{tag}')
        P.add(taper(0.196, d, 0.150, d, 0.100, (0, y, 1.130), (0, 0, 0), 0.016, 2),
              kv, b1, f'plate_{tag}_lo')
        for s in (1, -1):
            ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
            cx = s * (0.098 + 0.052 * ca)
            cy = y - sgn * (0.052 * sa)
            rz = -s * sgn * ang
            P.add(taper(0.110, d, 0.104, d, 0.196, (cx, cy, 1.284), (0, 0, rz), 0.016, 2),
                  kv, b2, f'wing_{tag}')
            P.add(taper(0.110, d, 0.086, d, 0.096, (cx * 0.94, cy, 1.132), (0, 0, rz), 0.016, 2),
                  kv, b1, f'wing_{tag}_lo')
        # MOLLE ladder on the centre panel
        rows = 4 if sgn > 0 else 3
        for i in range(rows):
            z = 1.348 - i * 0.066
            P.add(box(0.166, 0.014, 0.016, (0, y + sgn * (d / 2 + 0.006), z), (0, 0, 0), 0.005, 1),
                  P_WEB, b2, 'molle')
        for i in range(3):
            x = -0.058 + i * 0.058
            P.add(box(0.012, 0.012, 0.210, (x, y + sgn * (d / 2 + 0.004), 1.286), (0, 0, 0), 0.004, 1),
                  P_WEB, b2, 'mollev')

    # cummerbund wrapping the ribs
    P.add(taper(0.348, 0.244, 0.360, 0.250, 0.135, (0, 0, 1.175), (0, 0, 0), 0.024, 2),
          kv, ['spine_01', 'spine_02'], 'cummerbund')

    # carrier shoulder straps arcing over the traps
    for side in ('R', 'L'):
        s = _s(side)
        a = V((s * 0.094, 0.128, 1.372))
        b = V((s * 0.104, 0.0, 1.460))
        c = V((s * 0.094, -0.128, 1.362))
        P.add(capsule(a, b, 0.036, 0.038, 8, endcaps=False), kv, ['chest'], 'strap')
        P.add(capsule(b, c, 0.038, 0.036, 8, endcaps=False), kv, ['chest'], 'strap')
        P.add(box(0.052, 0.030, 0.026, (s * 0.100, 0.126, 1.352), (0, 0, 0), 0.008, 1),
              P_BRASS, ['chest'], 'buckle')

    # magazine pouches across the belly
    for i, x in enumerate((-0.086, 0.0, 0.086)):
        P.add(box(0.076, 0.066, 0.120, (x, 0.176, 1.150), (0, 0, 0), 0.020, 2),
              P_CAMO, ['spine_01', 'spine_02'], 'magpouch')
        P.add(box(0.080, 0.070, 0.020, (x, 0.176, 1.216), (-8, 0, 0), 0.008, 1),
              P_KEVLAR, ['spine_01', 'spine_02'], 'magflap')
        P.add(box(0.018, 0.014, 0.012, (x, 0.212, 1.208), (0, 0, 0), 0.004, 1),
              P_BRASS, ['spine_01'], 'magbuckle')

    # admin pouch + radio + grenades
    P.add(box(0.104, 0.048, 0.082, (-0.082, 0.166, 1.330), (0, 0, 0), 0.018, 2),
          P_CAMO, ['chest'], 'adminpouch')
    P.add(box(0.062, 0.052, 0.128, (0.128, -0.158, 1.320), (0, 0, 0), 0.018, 2),
          P_KEVLAR, ['chest'], 'radio')
    P.add(capsule(V((0.132, -0.166, 1.384)), V((0.150, -0.150, 1.560)), 0.008, 0.004, 7),
          P_METAL, ['chest'], 'radioant')
    for i, x in enumerate((0.104, -0.140)):
        P.add(cyl(0.030, 0.028, 0.078, 12, (x, 0.166, 1.298), (0, 0, 0), 0.010, 1),
              P_METAL, ['spine_02', 'chest'], 'grenade')
        P.add(cyl(0.014, 0.012, 0.018, 10, (x, 0.166, 1.346), (0, 0, 0), 0.004, 1),
              P_BRASS, ['chest'], 'grenadetop')

    # low collar — sits below the jaw so the neck stays readable
    P.add(taper(0.196, 0.180, 0.212, 0.194, 0.070, (0, 0, 1.458), (0, 0, 0), 0.020, 2),
          kv, ['chest', 'neck'], 'collar')

    # ---- pauldrons: the single biggest team-silhouette cue -------------------
    for side in ('R', 'L'):
        s = _s(side)
        bones = [f'upperarm_{side}', f'clavicle_{side}']
        if team == 0:
            # flat, wide, forward-swept soft pad
            sh = dome(0.116, 18, 8, (s * 0.176, 0.006, 1.392), (1.00, 1.36, 0.66), cut=-0.030)
            P.add(sh, P_KEVLAR, bones, 'pauldron')
            P.add(box(0.026, 0.196, 0.038, (s * 0.234, 0.006, 1.378), (0, s * -26, 0), 0.008, 2),
                  P_ACCENT, bones, 'pauldronrib')
            P.add(box(0.148, 0.030, 0.026, (s * 0.176, 0.112, 1.402), (0, 0, 0), 0.008, 1),
                  P_WEB, bones, 'pauldronstrap')
        else:
            # stacked angular lames flaring outward and down — heavy, spiky read
            for i in range(3):
                P.add(taper(0.126 - i * 0.010, 0.190 - i * 0.016,
                            0.126 - i * 0.010, 0.190 - i * 0.016, 0.030,
                            (s * (0.176 + i * 0.028), 0.006, 1.428 - i * 0.052),
                            (0, s * (16 + i * 12), 0), 0.010, 2),
                      P_METAL if i == 0 else P_KEVLAR, bones, 'lame')
            P.add(box(0.024, 0.170, 0.024, (s * 0.256, 0.006, 1.372), (0, s * 34, 0), 0.008, 2),
                  P_METAL, bones, 'spaulderspike')

    if team == 1:
        # hood / shoulder cloth: unmistakable irregular read
        P.add(taper(0.360, 0.300, 0.250, 0.220, 0.120, (0, -0.010, 1.442), (0, 0, 0), 0.045, 2),
              P_CLOTH, ['chest'], 'hoodcloth')
        P.add(taper(0.250, 0.220, 0.150, 0.150, 0.110, (0, -0.052, 1.545), (14, 0, 0), 0.045, 2),
              P_CLOTH, ['neck', 'chest'], 'hoodback')
        # bandolier across the chest
        for i in range(7):
            t = i / 6.0
            p0 = V((-0.150 + t * 0.290, 0.150 - abs(t - 0.5) * 0.04, 1.386 - t * 0.220))
            P.add(cyl(0.017, 0.015, 0.058, 9, tuple(p0), (0, 0, 0), 0.004, 1),
                  P_BRASS, ['spine_02', 'chest'], 'shell')
        P.add(box(0.330, 0.028, 0.034, (0, 0.150, 1.276), (0, 37, 0), 0.010, 2),
              P_WEB, ['spine_02', 'chest'], 'bandolier')


# ================================================================ ARMS ========
def arms(P, team, cls, heavy):
    for side in ('R', 'L'):
        s = _s(side)
        dd, out, arot = arm_frame(side)
        sh = V((s * R.X_SHLD, 0.0, R.Z_SHLD))
        el = sh + dd * R.L_UPPERARM
        wr = el + dd * R.L_FOREARM
        ub = [f'upperarm_{side}', f'clavicle_{side}']
        lb = [f'lowerarm_{side}', f'upperarm_{side}']
        hb = [f'hand_{side}']

        P.add(sphere(0.066, 14, 8, tuple(sh + dd * 0.010)), P_CLOTH, ub, 'shoulderball')
        P.add(capsule(sh, el, 0.068, 0.053, 14), P_CLOTH, ub, 'upperarm')
        # rolled sleeve cuff + team brassard, both aligned to the limb
        P.add(cyl(0.060, 0.060, 0.026, 14, tuple(sh + dd * 0.190), arot, 0.005, 1),
              P_CAMO, ub, 'sleeveseam')
        P.add(box(0.058, 0.016, 0.066, tuple(sh + dd * 0.110 + out * 0.052), arot, 0.006, 1),
              P_ACCENT, ub, 'patch')
        # elbow
        P.add(sphere(0.059, 14, 7, tuple(el + out * 0.008)), P_RUBBER, lb, 'elbowpad')
        P.add(capsule(el, wr, 0.056, 0.043, 14), P_CLOTH, lb, 'forearm')
        # forearm guard plate wrapping the outside of the limb
        P.add(box(0.074, 0.030, 0.155, tuple(el + dd * 0.135 + out * 0.038), arot, 0.012, 2),
              P_KEVLAR, lb, 'forearmguard')
        for i in range(2):
            P.add(box(0.084, 0.014, 0.016, tuple(el + dd * (0.078 + i * 0.115) + out * 0.036),
                      arot, 0.004, 1), P_WEB, lb, 'guardstrap')
        if side == 'L':
            P.add(box(0.052, 0.026, 0.062, tuple(el + dd * 0.180 - out * 0.036), arot, 0.008, 2),
                  P_OPTIC, lb, 'wristpad')
            P.add(box(0.040, 0.010, 0.048, tuple(el + dd * 0.180 - out * 0.048), arot, 0.003, 1),
                  P_ACCENT, lb, 'wristscreen')

        # glove: palm block + thumb + knuckle plate, all along the arm axis
        pal = wr + dd * 0.050
        P.add(box(0.060, 0.090, 0.092, tuple(pal), arot, 0.022, 2), P_GLOVE, hb, 'palm')
        P.add(box(0.064, 0.094, 0.020, tuple(pal + dd * 0.040), arot, 0.008, 2),
              P_RUBBER, hb, 'knuckles')
        # fingers as one tapered mitten — separate digits vanish at gameplay zoom
        P.add(taper(0.058, 0.092, 0.044, 0.074, 0.072, tuple(pal + dd * 0.076), arot, 0.020, 2),
              P_GLOVE, hb, 'fingers')
        P.add(capsule(pal + V((0, 0.036, 0)) - dd * 0.014,
                      pal + V((0, 0.064, 0)) + dd * 0.044, 0.021, 0.015, 9),
              P_GLOVE, hb, 'thumb')


# ================================================================ HEAD ========
def head(P, team, cls):
    hb = ['head']
    # skull + face
    P.add(sphere(0.094, 16, 9, (0, 0.004, 1.646), (0, 0, 0), (1.0, 1.08, 1.14)),
          P_SKIN, hb, 'skull')
    P.add(box(0.128, 0.098, 0.112, (0, 0.052, 1.612), (0, 0, 0), 0.036, 2),
          P_DARK, hb, 'facemask')

    if team == 0:
        # -- rounded composite helmet + full visor + NVG shroud ---------------
        P.add(dome(0.127, 20, 10, (0, 0.002, 1.650), (1.08, 1.17, 1.00), cut=-0.068),
              P_HELMET, hb, 'helmetshell')
        P.add(taper(0.272, 0.300, 0.280, 0.306, 0.032, (0, -0.004, 1.588), (0, 0, 0), 0.012, 2),
              P_HELMET, hb, 'helmetrim')
        # occipital flare
        P.add(taper(0.214, 0.082, 0.170, 0.068, 0.096, (0, -0.128, 1.622), (12, 0, 0), 0.026, 2),
              P_HELMET, hb, 'helmetrear')
        # NVG shroud + stub arm
        P.add(box(0.076, 0.036, 0.040, (0, 0.132, 1.726), (-22, 0, 0), 0.010, 2),
              P_METAL, hb, 'nvgshroud')
        P.add(box(0.036, 0.066, 0.026, (0, 0.164, 1.748), (-14, 0, 0), 0.008, 2),
              P_OPTIC, hb, 'nvgarm')
        P.add(cyl(0.024, 0.022, 0.032, 10, (0, 0.192, 1.756), (90, 0, 0), 0.005, 1),
              P_OPTIC, hb, 'nvgpod')
        # side rails
        for s in (1, -1):
            P.add(box(0.014, 0.146, 0.024, (s * 0.140, 0.008, 1.664), (0, 0, 0), 0.005, 1),
                  P_METAL, hb, 'rail')
            for i in range(4):
                P.add(box(0.020, 0.012, 0.020, (s * 0.144, -0.044 + i * 0.034, 1.664),
                          (0, 0, 0), 0.003, 1), P_METAL, hb, 'railnotch')
        # full visor
        P.add(box(0.246, 0.066, 0.076, (0, 0.092, 1.664), (0, 0, 0), 0.030, 2),
              P_RUBBER, hb, 'visorframe')
        P.add(box(0.216, 0.040, 0.056, (0, 0.118, 1.664), (0, 0, 0), 0.020, 2),
              P_LENS, hb, 'visorglass', glass=True)
        # IR strobe on the back
        P.add(box(0.036, 0.018, 0.022, (0, -0.146, 1.716), (0, 0, 0), 0.006, 1),
              P_ACCENT, hb, 'irstrobe')
    else:
        # -- flat welded steel helmet with a slit face plate -------------------
        P.add(taper(0.246, 0.250, 0.214, 0.216, 0.086, (0, -0.002, 1.716), (0, 0, 0), 0.024, 2),
              P_HELMET, hb, 'potshell')
        P.add(taper(0.214, 0.216, 0.120, 0.128, 0.038, (0, -0.002, 1.776), (0, 0, 0), 0.020, 2),
              P_HELMET, hb, 'pottop')
        P.add(taper(0.262, 0.268, 0.250, 0.256, 0.024, (0, -0.002, 1.664), (0, 0, 0), 0.010, 2),
              P_METAL, hb, 'potbrim')
        # welded crest rib front-to-back
        P.add(box(0.032, 0.250, 0.036, (0, -0.002, 1.790), (0, 0, 0), 0.012, 2),
              P_METAL, hb, 'crest')
        # bolted face plate with a vision slit
        P.add(taper(0.200, 0.050, 0.176, 0.046, 0.140, (0, 0.106, 1.660), (-8, 0, 0), 0.018, 2),
              P_METAL, hb, 'faceplate')
        P.add(box(0.164, 0.030, 0.026, (0, 0.130, 1.690), (-8, 0, 0), 0.008, 2),
              P_LENS, hb, 'slitglass', glass=True)
        for s in (1, -1):
            for i in range(3):
                P.add(cyl(0.010, 0.009, 0.014, 8, (s * 0.086, 0.116, 1.616 + i * 0.042),
                          (90, 0, 0), 0.003, 1), P_BRASS, hb, 'bolt')
        # neck curtain of chain/cloth at the back
        P.add(taper(0.210, 0.140, 0.200, 0.130, 0.090, (0, -0.078, 1.598), (10, 0, 0), 0.022, 2),
              P_WEB, hb, 'neckcurtain')
        P.add(box(0.044, 0.020, 0.028, (0.088, -0.108, 1.734), (0, 0, 0), 0.008, 1),
              P_ACCENT, hb, 'marker')

    # comms: ear cups + boom mic (both teams)
    for s in (1, -1):
        P.add(cyl(0.046, 0.044, 0.034, 12, (s * 0.128, 0.008, 1.620), (0, 90, 0), 0.008, 1),
              P_RUBBER, hb, 'earcup')
    P.add(capsule(V((-0.116, 0.024, 1.622)), V((-0.048, 0.098, 1.594)), 0.007, 0.005, 7),
          P_METAL, hb, 'micboom')
    P.add(box(0.020, 0.024, 0.018, (-0.044, 0.104, 1.592), (0, 0, 0), 0.006, 1),
          P_RUBBER, hb, 'mic')
    # chin strap
    for s in (1, -1):
        P.add(box(0.014, 0.020, 0.100, (s * 0.100, 0.038, 1.578), (0, 0, s * 8), 0.005, 1),
              P_WEB, hb, 'chinstrap')
    P.add(box(0.096, 0.026, 0.022, (0, 0.076, 1.548), (0, 0, 0), 0.008, 1),
          P_WEB, hb, 'chincup')


# ============================================================= BACKPACK =======
def back(P, team, cls):
    bones = ['chest', 'spine_02']
    if team == 0:
        h = 0.34 if cls != 'Ranger' else 0.26
        zc = 1.270 if cls != 'Ranger' else 1.230
        P.add(taper(0.276, 0.170, 0.300, 0.206, h, (0, -0.216, zc), (0, 0, 0), 0.022, 2),
              P_KEVLAR, bones, 'pack')
        P.add(taper(0.300, 0.206, 0.250, 0.166, 0.060, (0, -0.216, zc + h / 2 + 0.028),
                    (0, 0, 0), 0.016, 2), P_CAMO, bones, 'packflap')
        for i in range(2):
            P.add(box(0.310, 0.014, 0.020, (0, -0.312, zc - 0.06 + i * 0.130), (0, 0, 0), 0.006, 1),
                  P_WEB, bones, 'packstrap')
        for s in (1, -1):
            P.add(box(0.048, 0.100, 0.150, (s * 0.164, -0.212, zc - 0.02), (0, 0, 0), 0.014, 2),
                  P_CAMO, bones, 'sidepouch')
        # bedroll across the top
        P.add(cyl(0.052, 0.052, 0.300, 12, (0, -0.226, zc + h / 2 + 0.084), (0, 90, 0), 0.010, 1),
              P_CAMO, bones, 'bedroll')
        # whip antenna — strong vertical silhouette accent
        P.add(capsule(V((0.126, -0.300, zc + h / 2)), V((0.168, -0.256, 1.930)), 0.009, 0.003, 7),
              P_METAL, bones, 'antenna')
        P.add(box(0.030, 0.030, 0.040, (0.126, -0.300, zc + h / 2 - 0.016), (0, 0, 0), 0.008, 1),
              P_OPTIC, bones, 'antennabase')
    else:
        # low satchel + bedroll slung on the lower back
        P.add(taper(0.300, 0.140, 0.280, 0.130, 0.170, (0, -0.180, 1.140), (0, 0, 0), 0.024, 2),
              P_WEB, ['spine_01', 'spine_02'], 'satchel')
        P.add(taper(0.280, 0.130, 0.240, 0.110, 0.044, (0, -0.180, 1.244), (0, 0, 0), 0.020, 2),
              P_CLOTH, ['spine_02'], 'satchelflap')
        P.add(cyl(0.062, 0.062, 0.320, 12, (0, -0.212, 1.312), (0, 90, 0), 0.012, 1),
              P_CLOTH, bones, 'bedroll')
        for i in range(3):
            P.add(box(0.016, 0.140, 0.016, (-0.11 + i * 0.11, -0.212, 1.312), (0, 0, 0), 0.005, 1),
                  P_WEB, bones, 'bedrolltie')
        # jerrycan strapped high on the back
        P.add(box(0.150, 0.086, 0.200, (0.060, -0.196, 1.360), (0, 0, 0), 0.020, 2),
              P_METAL, bones, 'jerrycan')
        P.add(box(0.150, 0.020, 0.020, (0.060, -0.196, 1.466), (0, 0, 0), 0.007, 1),
              P_METAL, bones, 'jerryhandle')


# =========================================================== CLASS GEAR =======
def class_gear(P, team, cls):
    ch = ['chest', 'spine_02']
    if cls == 'Ranger':
        # machete across the lower back + extra pistol mags
        P.add(taper(0.052, 0.028, 0.040, 0.024, 0.400, (-0.070, -0.216, 1.230), (0, 0, 34), 0.010, 2),
              P_METAL, ['spine_02', 'spine_01'], 'machete')
        P.add(box(0.040, 0.036, 0.110, (-0.182, -0.212, 1.070), (0, 0, 34), 0.012, 2),
              P_BOOT, ['spine_01'], 'macheteguard')
        for i in range(2):
            P.add(box(0.052, 0.038, 0.086, (-0.150 + i * 0.0, 0.130, 1.318 - i * 0.09),
                      (0, 0, 0), 0.014, 2), P_CAMO, ch, 'pistolmag')
        # low-profile crest fin on the helmet
        P.add(taper(0.024, 0.120, 0.020, 0.086, 0.046, (0, 0.020, 1.786), (0, 0, 0), 0.010, 2),
              P_ACCENT, ['head'], 'crestfin')

    elif cls == 'Sharpshooter':
        # long coat tails hanging off the belt — instantly readable class shape
        for s in (1, -1):
            P.add(taper(0.170, 0.150, 0.140, 0.120, 0.400, (s * 0.086, -0.056, 0.860),
                        (-4, 0, s * 3), 0.030, 2),
                  P_CLOTH, ['pelvis', f'thigh_{"R" if s > 0 else "L"}'], 'coattail')
        P.add(taper(0.340, 0.230, 0.330, 0.225, 0.070, (0, -0.020, 1.075), (0, 0, 0), 0.024, 2),
              P_CLOTH, ['pelvis', 'spine_01'], 'coatskirt')
        # spotting scope + folded bipod on the pack
        P.add(cyl(0.038, 0.034, 0.185, 12, (-0.150, -0.230, 1.400), (0, 0, 0), 0.010, 1),
              P_OPTIC, ch, 'spotscope')
        for s in (1, -1):
            P.add(capsule(V((0.150, -0.300, 1.180)), V((0.150 + s * 0.050, -0.360, 1.010)),
                          0.012, 0.008, 8), P_METAL, ['spine_01', 'spine_02'], 'bipodleg')
        # ghillie tufts on the pauldrons
        for s in (1, -1):
            for i in range(4):
                P.add(taper(0.026, 0.020, 0.014, 0.010, 0.110,
                            (s * (0.180 + i * 0.012), -0.050 + i * 0.036, 1.352),
                            (10, 0, s * 12), 0.006, 1),
                      P_CAMO, [f'upperarm_{"R" if s > 0 else "L"}'], 'ghillie')

    elif cls == 'Grenadier':
        # 40mm bandolier — six fat rounds across the chest
        for i in range(6):
            t = i / 5.0
            p = V((0.160 - t * 0.300, 0.164 - abs(t - 0.5) * 0.030, 1.372 - t * 0.190))
            P.add(cyl(0.026, 0.024, 0.078, 10, tuple(p), (0, 0, -34), 0.006, 1),
                  P_BRASS, ch, 'r40')
            P.add(cyl(0.023, 0.020, 0.026, 10, tuple(p + V((0.020, 0, 0.028))), (0, 0, -34), 0.005, 1),
                  P_ACCENT, ch, 'r40tip')
        P.add(box(0.330, 0.030, 0.040, (0, 0.156, 1.278), (0, 34, 0), 0.010, 2),
              P_WEB, ch, 'gbandolier')
        # ammo drum + thigh greaves
        P.add(cyl(0.110, 0.110, 0.160, 16, (0, -0.230, 1.180), (90, 0, 0), 0.024, 2),
              P_METAL, ['spine_02', 'spine_01'], 'drum')
        for s in (1, -1):
            side = 'R' if s > 0 else 'L'
            P.add(box(0.120, 0.062, 0.220, (s * 0.126, 0.072, 0.760), (0, 0, 0), 0.026, 2),
                  P_METAL, [f'thigh_{side}', 'pelvis'], 'greave')
            P.add(box(0.126, 0.024, 0.026, (s * 0.126, 0.096, 0.850), (0, 0, 0), 0.008, 1),
                  P_WEB, [f'thigh_{side}'], 'greavestrap')
        # neck/throat guard
        P.add(taper(0.160, 0.070, 0.150, 0.062, 0.090, (0, 0.108, 1.492), (-14, 0, 0), 0.022, 2),
              P_METAL, ['chest', 'neck'], 'throatguard')

    elif cls == 'Specialist':
        # drone puck docked on the backpack
        cx, cy, cz = 0.0, -0.286, 1.400
        P.add(cyl(0.086, 0.078, 0.052, 16, (cx, cy, cz), (90, 0, 0), 0.014, 2),
              P_OPTIC, ch, 'drone')
        P.add(cyl(0.036, 0.034, 0.060, 12, (cx, cy - 0.010, cz), (90, 0, 0), 0.010, 1),
              P_ACCENT, ch, 'droneeye')
        for i in range(4):
            a = math.radians(45 + i * 90)
            P.add(capsule(V((cx, cy, cz)),
                          V((cx + math.cos(a) * 0.120, cy - 0.012, cz + math.sin(a) * 0.120)),
                          0.011, 0.008, 8), P_METAL, ch, 'dronearm')
            P.add(cyl(0.038, 0.038, 0.010, 10,
                      (cx + math.cos(a) * 0.120, cy - 0.014, cz + math.sin(a) * 0.120),
                      (90, 0, 0), 0.003, 1), P_RUBBER, ch, 'rotor')
        # antenna array
        for i, (x, h) in enumerate(((-0.130, 0.28), (-0.100, 0.36), (-0.070, 0.22))):
            P.add(capsule(V((x, -0.286, 1.440)), V((x - 0.02, -0.300, 1.440 + h)), 0.008, 0.003, 7),
                  P_METAL, ch, 'ant')
        # forearm tablet + tool pouches
        P.add(box(0.070, 0.108, 0.020,
                  tuple(V((-R.X_SHLD, 0, R.Z_SHLD)) +
                        V((-R.ARM_DIR.x, R.ARM_DIR.y, R.ARM_DIR.z)) * 0.430 + V((0, -0.048, 0.020))),
                  (0, 0, 0), 0.008, 2), P_OPTIC, ['lowerarm_L'], 'tablet')
        P.add(box(0.060, 0.084, 0.012,
                  tuple(V((-R.X_SHLD, 0, R.Z_SHLD)) +
                        V((-R.ARM_DIR.x, R.ARM_DIR.y, R.ARM_DIR.z)) * 0.430 + V((0, -0.060, 0.020))),
                  (0, 0, 0), 0.004, 1), P_ACCENT, ['lowerarm_L'], 'tabletscreen')
        for i, x in enumerate((-0.150, 0.150)):
            P.add(box(0.058, 0.070, 0.098, (x, 0.058, 1.062), (0, 0, 0), 0.018, 2),
                  P_CAMO, ['pelvis', 'spine_01'], 'toolpouch')
