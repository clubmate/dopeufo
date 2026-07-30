// ---------------------------------------------------------------------------
// GPU particle vertex shader.
//
// One instanced quad per particle. The ENTIRE trajectory is integrated
// analytically on the GPU from the spawn-time attribute set, so the CPU never
// touches a live particle again:
//
//   p(t) = p0 + v0 * E(t) + g * G(t)          E,G = closed form linear-drag integrals
//
// Dead particles are collapsed outside the clip volume and cost one vertex
// shader invocation with an early return.
// ---------------------------------------------------------------------------

attribute vec4 aOrigin;   // xyz spawn position (world), w spawn time
attribute vec4 aVel;      // xyz initial velocity,       w linear drag coefficient
attribute vec4 aLife;     // x lifetime, y size@birth, z size@death, w size curve exponent
attribute vec4 aRot;      // x roll, y roll speed, z flipbook frame offset, w frames/sec
attribute vec4 aCol0;     // rgb + alpha at birth (rgb may exceed 1.0 — HDR for bloom)
attribute vec4 aCol1;     // rgb + alpha at death
attribute vec4 aMisc;     // x gravity, y turbulence amp, z fade-in fraction, w velocity stretch

uniform float uTime;
uniform vec2  uTiles;      // flipbook columns / rows
uniform float uSizeScale;  // global quality scalar
uniform vec4  uFog;        // rgb colour, a = mode (0 off, 1 linear, 2 exp2)
uniform vec2  uFogRange;   // linear: near/far. exp2: density in .x

varying vec2  vUv0;
varying vec2  vUv1;
varying float vBlend;
varying vec4  vColor;
varying float vT;
varying float vSeed;
varying float vFog;
varying vec3  vViewPos;

// Cheap divergence-free-ish flow field. Three sine octaves is plenty at the
// scale a particle actually travels, and it costs nothing next to a texture read.
vec3 turbulence(vec3 p, float t) {
  vec3 a = vec3(
    sin(p.z * 1.70 + t * 1.10),
    sin(p.x * 1.30 - t * 0.90),
    sin(p.y * 1.90 + t * 1.30));
  vec3 b = vec3(
    sin(p.y * 3.10 - t * 2.30),
    sin(p.z * 2.70 + t * 1.90),
    sin(p.x * 3.30 - t * 2.10));
  return a + 0.45 * b;
}

void main() {
  float age  = uTime - aOrigin.w;
  float life = max(aLife.x, 1e-4);
  float t    = age / life;

  if (age < 0.0 || t >= 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // outside clip space -> zero fragments
    return;
  }

  // --- analytic motion under linear drag + gravity --------------------------
  float d   = aVel.w;
  float dec = exp(-d * age);
  float E   = (d > 1e-3) ? (1.0 - dec) / d : age;                 // integral of exp(-d t)
  float G   = (d > 1e-3) ? (age - E) / d   : 0.5 * age * age;     // double integral

  vec3 pos = aOrigin.xyz + aVel.xyz * E + vec3(0.0, aMisc.x, 0.0) * G;

  float seed = fract(aOrigin.w * 13.137 + aRot.x * 0.159);
  if (aMisc.y > 0.0) {
    // Turbulence grows with age so a puff wobbles more as it loses momentum.
    pos += turbulence(aOrigin.xyz * 0.30 + vec3(seed * 31.0), uTime * 0.45 + seed * 6.28)
         * aMisc.y * (0.15 + t * 1.1);
  }

  // --- size / colour --------------------------------------------------------
  float sizeT = pow(t, aLife.w);
  float sz    = mix(aLife.y, aLife.z, sizeT) * uSizeScale;

  vColor     = mix(aCol0, aCol1, t);
  vColor.a  *= smoothstep(0.0, max(aMisc.z, 1e-4), t);
  vT         = t;
  vSeed      = seed;

  // --- billboard ------------------------------------------------------------
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec2 corner = position.xy;

  if (aMisc.w > 0.0005) {
    // Velocity-stretched billboard: the quad's local +Y is pinned to the
    // screen-space motion vector, so tracers and sparks read as streaks.
    vec3 vNow = aVel.xyz * dec + vec3(0.0, aMisc.x, 0.0) * E;
    vec3 vv   = (modelViewMatrix * vec4(vNow, 0.0)).xyz;
    float l   = length(vv.xy);
    vec2 ax   = (l > 1e-5) ? vv.xy / l : vec2(0.0, 1.0);
    float len = sz + aMisc.w * length(vNow);
    mv.xy += ax * (corner.y * len) + vec2(-ax.y, ax.x) * (corner.x * sz);
  } else {
    float ang = aRot.x + aRot.y * age;
    float c = cos(ang), s = sin(ang);
    mv.xy += vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c) * sz;
  }

  vViewPos = mv.xyz;

  // --- flipbook -------------------------------------------------------------
  float frames = uTiles.x * uTiles.y;
  float f  = aRot.z + aRot.w * age;
  float f0 = floor(mod(f, frames));
  float f1 = mod(f0 + 1.0, frames);
  vBlend = fract(f);
  vec2 inv = 1.0 / uTiles;
  vUv0 = (uv + vec2(mod(f0, uTiles.x), floor(f0 * inv.x))) * inv;
  vUv1 = (uv + vec2(mod(f1, uTiles.x), floor(f1 * inv.x))) * inv;

  // --- fog ------------------------------------------------------------------
  vFog = 0.0;
  if (uFog.a > 0.5) {
    float dist = length(mv.xyz);
    vFog = (uFog.a < 1.5)
      ? smoothstep(uFogRange.x, uFogRange.y, dist)
      : 1.0 - exp(-uFogRange.x * uFogRange.x * dist * dist);
    vFog = clamp(vFog, 0.0, 1.0);
  }

  gl_Position = projectionMatrix * mv;
}
