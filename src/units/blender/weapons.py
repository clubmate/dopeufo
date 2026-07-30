# DOPE UFO — weapons. Authored in grip space:
#   origin = centre of the right palm on the pistol grip
#   +Y = muzzle direction, +Z = top rail, +X = ejection side
import math
from mathutils import Vector
from lib import (box, taper, cyl, sphere, capsule, P_POLY, P_METAL, P_RUBBER,
                 P_OPTIC, P_LENS, P_BRASS, P_ACCENT, P_KEVLAR, P_WEB)

NB = []


def _grip(P, back=-0.014, tilt=14, w=0.038, h=0.120):
    P.add(taper(w, 0.062, w * 0.92, 0.050, h, (0, back, -h / 2 + 0.006), (tilt, 0, 0), 0.016, 2),
          P_POLY, NB, 'grip')
    for i in range(3):
        P.add(box(w + 0.006, 0.010, 0.010, (0, back + 0.020, -0.024 - i * 0.026), (tilt, 0, 0), 0.003, 1),
              P_RUBBER, NB, 'gripline')
    # trigger guard + trigger
    P.add(taper(0.030, 0.086, 0.030, 0.086, 0.012, (0, 0.038, -0.052), (0, 0, 0), 0.006, 2),
          P_METAL, NB, 'guardlo')
    P.add(box(0.030, 0.012, 0.050, (0, 0.080, -0.030), (0, 0, 0), 0.006, 2), P_METAL, NB, 'guardfr')
    P.add(box(0.010, 0.012, 0.030, (0, 0.046, -0.026), (8, 0, 0), 0.003, 1), P_BRASS, NB, 'trigger')


def _rail(P, y0, y1, z, x=0.0, w=0.026, n=10, pal=P_METAL):
    P.add(box(w, y1 - y0, 0.012, (x, (y0 + y1) / 2, z), (0, 0, 0), 0.003, 1), pal, NB, 'rail')
    for i in range(n):
        t = (i + 0.5) / n
        P.add(box(w + 0.004, (y1 - y0) / n * 0.45, 0.009, (x, y0 + (y1 - y0) * t, z + 0.008),
                  (0, 0, 0), 0.002, 1), pal, NB, 'railtooth')


def _optic(P, y, z, length=0.110, r=0.026, tube=True):
    P.add(box(0.034, 0.058, 0.030, (0, y, z - 0.030), (0, 0, 0), 0.008, 2), P_OPTIC, NB, 'mount')
    P.add(box(0.040, 0.020, 0.024, (0, y - 0.030, z - 0.030), (0, 0, 0), 0.005, 1), P_METAL, NB, 'mountclamp')
    if tube:
        P.add(cyl(r, r, length, 16, (0, y, z), (90, 0, 0), 0.006, 1), P_OPTIC, NB, 'scope')
        P.add(cyl(r * 1.24, r * 1.24, 0.028, 16, (0, y + length / 2 - 0.010, z), (90, 0, 0), 0.005, 1),
              P_OPTIC, NB, 'scopebell')
        P.add(cyl(r * 1.30, r * 1.30, 0.024, 16, (0, y - length / 2 + 0.006, z), (90, 0, 0), 0.005, 1),
              P_OPTIC, NB, 'scopeeye')
        P.add(cyl(r * 1.10, r * 1.10, 0.006, 16, (0, y + length / 2 + 0.006, z), (90, 0, 0), 0.002, 1),
              P_LENS, NB, 'lens', glass=True)
        P.add(cyl(r * 0.86, r * 0.86, 0.018, 12, (0, y, z + r * 0.9), (0, 0, 0), 0.004, 1),
              P_METAL, NB, 'turret')
    else:  # red dot
        P.add(taper(0.042, 0.040, 0.036, 0.036, 0.048, (0, y, z + 0.012), (0, 0, 0), 0.008, 2),
              P_OPTIC, NB, 'reddot')
        P.add(box(0.030, 0.006, 0.034, (0, y + 0.018, z + 0.014), (0, 0, 0), 0.003, 1),
              P_LENS, NB, 'dotglass', glass=True)


def _mag(P, y, z, curve=8, n=3, w=0.030, d=0.056, seg=0.062):
    for i in range(n):
        a = -curve * i
        P.add(taper(w, d, w, d * 0.96, seg,
                    (0, y + i * 0.012 * curve / 8.0, z - i * seg * 0.94),
                    (a, 0, 0), 0.008, 2), P_POLY, NB, 'mag')
    P.add(box(w + 0.004, d * 0.8, 0.012, (0, y + n * 0.012 * curve / 8.0, z - n * seg * 0.94 + 0.020),
              (-curve * n, 0, 0), 0.004, 1), P_METAL, NB, 'magbase')


def _stock(P, y0, length=0.180, z=0.080, folding=False):
    P.add(cyl(0.021, 0.021, length * 0.9, 12, (0, y0 - length * 0.45, z), (90, 0, 0), 0.005, 1),
          P_METAL, NB, 'buffer')
    P.add(taper(0.052, 0.070, 0.046, 0.052, 0.086, (0, y0 - length * 0.55, z + 0.006), (0, 0, 0), 0.016, 2),
          P_POLY, NB, 'stockbody')
    P.add(box(0.048, 0.028, 0.106, (0, y0 - length, z - 0.006), (0, 0, 0), 0.014, 2),
          P_RUBBER, NB, 'buttpad')
    P.add(box(0.030, 0.100, 0.020, (0, y0 - length * 0.5, z + 0.048), (0, 0, 0), 0.008, 2),
          P_POLY, NB, 'cheek')


def _sling(P, y, z, x=0.024):
    P.add(cyl(0.012, 0.010, 0.010, 10, (x, y, z), (0, 90, 0), 0.003, 1), P_METAL, NB, 'slingloop')


# ------------------------------------------------------------------ RIFLE ----
def rifle(P):
    _grip(P)
    P.add(box(0.050, 0.250, 0.088, (0, 0.100, 0.078), (0, 0, 0), 0.012, 2), P_POLY, NB, 'receiver')
    P.add(box(0.054, 0.070, 0.062, (0, 0.070, 0.076), (0, 0, 0), 0.010, 2), P_METAL, NB, 'mainwell')
    P.add(box(0.014, 0.070, 0.036, (0.028, 0.140, 0.090), (0, 0, 0), 0.006, 2), P_METAL, NB, 'ejport')
    P.add(box(0.020, 0.030, 0.018, (0.030, 0.196, 0.104), (0, 0, 0), 0.004, 1), P_METAL, NB, 'charge')
    _rail(P, 0.010, 0.360, 0.126, n=14)
    # hex handguard
    P.add(cyl(0.032, 0.030, 0.230, 8, (0, 0.340, 0.080), (90, 0, 0), 0.005, 1), P_POLY, NB, 'handguard')
    for a in (0, 90, 180, 270):
        P.add(box(0.010, 0.190, 0.010,
                  (math.sin(math.radians(a)) * 0.031, 0.340, 0.080 + math.cos(math.radians(a)) * 0.031),
                  (0, 0, 0), 0.003, 1), P_METAL, NB, 'hgslot')
    P.add(cyl(0.012, 0.011, 0.150, 12, (0, 0.520, 0.080), (90, 0, 0), 0.003, 1), P_METAL, NB, 'barrel')
    P.add(cyl(0.021, 0.019, 0.060, 12, (0, 0.618, 0.080), (90, 0, 0), 0.005, 1), P_METAL, NB, 'brake')
    for i in range(3):
        P.add(box(0.046, 0.008, 0.014, (0, 0.602 + i * 0.018, 0.080), (0, 0, 0), 0.002, 1),
              P_METAL, NB, 'brakeslot')
    _mag(P, 0.062, 0.020)
    _stock(P, -0.030, 0.190, 0.078)
    _optic(P, 0.180, 0.166, 0.100, 0.024, tube=False)
    # angled foregrip
    P.add(taper(0.030, 0.040, 0.026, 0.034, 0.090, (0, 0.400, 0.026), (28, 0, 0), 0.010, 2),
          P_POLY, NB, 'foregrip')
    _sling(P, 0.250, 0.040)
    P.add(box(0.024, 0.056, 0.026, (0, 0.430, 0.126), (0, 0, 0), 0.006, 1), P_METAL, NB, 'frontsight')


# ----------------------------------------------------------------- SNIPER ----
def sniper(P):
    _grip(P, tilt=10, h=0.128)
    P.add(box(0.048, 0.320, 0.092, (0, 0.130, 0.080), (0, 0, 0), 0.012, 2), P_METAL, NB, 'receiver')
    P.add(box(0.058, 0.120, 0.070, (0, 0.080, 0.076), (0, 0, 0), 0.012, 2), P_METAL, NB, 'action')
    # bolt handle
    P.add(cyl(0.011, 0.011, 0.070, 10, (0.044, 0.150, 0.098), (0, 90, 0), 0.003, 1), P_METAL, NB, 'bolt')
    P.add(sphere(0.017, 10, 6, (0.078, 0.150, 0.098)), P_METAL, NB, 'boltknob')
    _rail(P, 0.030, 0.290, 0.130, n=12, w=0.028)
    P.add(taper(0.052, 0.400, 0.044, 0.400, 0.052, (0, 0.470, 0.066), (0, 0, 0), 0.014, 2),
          P_POLY, NB, 'chassis')
    P.add(cyl(0.015, 0.013, 0.400, 12, (0, 0.480, 0.082), (90, 0, 0), 0.004, 1), P_METAL, NB, 'barrel')
    for i in range(6):
        P.add(cyl(0.019, 0.019, 0.006, 12, (0, 0.330 + i * 0.048, 0.082), (90, 0, 0), 0.002, 1),
              P_METAL, NB, 'fluteband')
    P.add(cyl(0.026, 0.024, 0.110, 12, (0, 0.720, 0.082), (90, 0, 0), 0.005, 1), P_METAL, NB, 'suppressor')
    _mag(P, 0.068, 0.020, curve=4, n=2, w=0.032, d=0.070, seg=0.058)
    _stock(P, -0.040, 0.240, 0.082)
    P.add(box(0.044, 0.070, 0.040, (0, -0.230, 0.108), (0, 0, 0), 0.010, 2), P_POLY, NB, 'cheekriser')
    P.add(cyl(0.014, 0.012, 0.090, 10, (0, -0.290, 0.020), (14, 0, 0), 0.004, 1), P_METAL, NB, 'monopod')
    _optic(P, 0.240, 0.184, 0.300, 0.034, tube=True)
    # bipod
    for s in (1, -1):
        P.add(capsule(Vector((0, 0.600, 0.050)), Vector((s * 0.090, 0.640, -0.090)), 0.010, 0.007, 8),
              P_METAL, NB, 'bipod')
        P.add(box(0.026, 0.048, 0.012, (s * 0.092, 0.642, -0.096), (0, 0, 0), 0.004, 1),
              P_RUBBER, NB, 'bipodfoot')


# --------------------------------------------------------------- LAUNCHER ----
def launcher(P):
    _grip(P, tilt=16, w=0.042, h=0.126)
    P.add(box(0.070, 0.200, 0.100, (0, 0.090, 0.086), (0, 0, 0), 0.018, 2), P_POLY, NB, 'receiver')
    P.add(cyl(0.046, 0.044, 0.320, 16, (0, 0.290, 0.096), (90, 0, 0), 0.008, 2), P_METAL, NB, 'tube')
    P.add(cyl(0.052, 0.050, 0.036, 16, (0, 0.442, 0.096), (90, 0, 0), 0.006, 1), P_METAL, NB, 'muzzlering')
    for i in range(3):
        P.add(cyl(0.050, 0.050, 0.010, 16, (0, 0.190 + i * 0.070, 0.096), (90, 0, 0), 0.003, 1),
              P_METAL, NB, 'tubeband')
    # revolver drum of six 40mm rounds
    P.add(cyl(0.088, 0.086, 0.130, 16, (0, 0.100, 0.030), (90, 0, 0), 0.014, 2), P_METAL, NB, 'drum')
    for i in range(6):
        a = math.radians(i * 60)
        P.add(cyl(0.024, 0.024, 0.136, 10,
                  (math.sin(a) * 0.052, 0.100, 0.030 + math.cos(a) * 0.052), (90, 0, 0), 0.003, 1),
              P_BRASS, NB, 'chamber')
    # ladder sight
    P.add(box(0.014, 0.020, 0.130, (0.032, 0.150, 0.168), (0, 0, 0), 0.005, 2), P_METAL, NB, 'ladder')
    for i in range(4):
        P.add(box(0.030, 0.012, 0.008, (0.032, 0.150, 0.126 + i * 0.028), (0, 0, 0), 0.002, 1),
              P_METAL, NB, 'ladderrung')
    _rail(P, 0.020, 0.170, 0.142, n=7, w=0.028)
    _optic(P, 0.110, 0.180, 0.060, 0.022, tube=False)
    P.add(taper(0.034, 0.046, 0.030, 0.040, 0.100, (0, 0.230, 0.026), (26, 0, 0), 0.012, 2),
          P_POLY, NB, 'foregrip')
    _stock(P, -0.020, 0.170, 0.086)
    _sling(P, 0.180, 0.036)


# -------------------------------------------------------------------- SMG ----
def smg(P):
    _grip(P, tilt=12, w=0.036, h=0.110)
    P.add(box(0.046, 0.190, 0.082, (0, 0.086, 0.074), (0, 0, 0), 0.012, 2), P_POLY, NB, 'receiver')
    P.add(box(0.050, 0.060, 0.058, (0, 0.062, 0.070), (0, 0, 0), 0.010, 2), P_METAL, NB, 'well')
    _rail(P, 0.006, 0.270, 0.118, n=11, w=0.024)
    P.add(cyl(0.028, 0.026, 0.150, 8, (0, 0.250, 0.074), (90, 0, 0), 0.004, 1), P_POLY, NB, 'handguard')
    P.add(cyl(0.024, 0.023, 0.120, 12, (0, 0.390, 0.074), (90, 0, 0), 0.004, 1), P_METAL, NB, 'suppressor')
    for i in range(5):
        P.add(cyl(0.027, 0.027, 0.006, 12, (0, 0.345 + i * 0.024, 0.074), (90, 0, 0), 0.002, 1),
              P_METAL, NB, 'supband')
    _mag(P, 0.056, 0.014, curve=6, n=3, w=0.026, d=0.046, seg=0.056)
    # folding side stock
    P.add(cyl(0.014, 0.014, 0.170, 10, (0.038, -0.050, 0.086), (90, 0, 0), 0.004, 1), P_METAL, NB, 'foldbar')
    P.add(box(0.038, 0.024, 0.076, (0.038, -0.132, 0.086), (0, 0, 0), 0.010, 2), P_RUBBER, NB, 'foldpad')
    P.add(taper(0.028, 0.036, 0.024, 0.032, 0.078, (0, 0.290, 0.026), (24, 0, 0), 0.010, 2),
          P_POLY, NB, 'foregrip')
    _optic(P, 0.130, 0.156, 0.050, 0.022, tube=False)
    P.add(cyl(0.016, 0.014, 0.070, 10, (0.034, 0.300, 0.052), (90, 0, 0), 0.004, 1), P_OPTIC, NB, 'laser')
    _sling(P, 0.150, 0.034)


# ----------------------------------------------------------------- GADGET ----
def gadget(P):
    """Specialist's handheld hacking deck — held in the left hand."""
    P.add(box(0.090, 0.130, 0.028, (0, 0.020, 0.0), (0, 0, 0), 0.012, 2), P_OPTIC, NB, 'deck')
    P.add(box(0.070, 0.098, 0.008, (0, 0.026, 0.017), (0, 0, 0), 0.004, 1), P_ACCENT, NB, 'screen')
    P.add(box(0.098, 0.024, 0.038, (0, -0.048, 0.004), (0, 0, 0), 0.010, 2), P_RUBBER, NB, 'deckgrip')
    P.add(capsule(Vector((0.034, 0.080, 0.010)), Vector((0.048, 0.150, 0.070)), 0.006, 0.003, 7),
          P_METAL, NB, 'deckant')
    for i in range(3):
        P.add(box(0.014, 0.014, 0.008, (-0.030 + i * 0.030, -0.030, 0.017), (0, 0, 0), 0.003, 1),
              P_BRASS, NB, 'key')


ALL = {
    'rifle': rifle,
    'sniper': sniper,
    'launcher': launcher,
    'smg': smg,
    'gadget': gadget,
}
