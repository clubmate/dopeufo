// ---------------------------------------------------------------------------
// GPU particle fragment shader.
//
//  SOFT        depth-buffer fade so smoke never slices through geometry
//  FRAMEBLEND  linear cross-fade between flipbook frames (kills the strobe)
//  DISSOLVE    noise-threshold erosion so smoke frays apart instead of
//              uniformly ghosting out — the single biggest realism win
//  ADDITIVE    fog attenuates towards black rather than towards the fog colour
// ---------------------------------------------------------------------------

#include <common>
#include <packing>

uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2  uResolution;
uniform vec2  uCamRange;    // near, far
uniform float uSoftDist;
uniform float uDissolve;
uniform vec4  uFog;

varying vec2  vUv0;
varying vec2  vUv1;
varying float vBlend;
varying vec4  vColor;
varying float vT;
varying float vSeed;
varying float vFog;
varying vec3  vViewPos;

void main() {
  #ifdef FRAMEBLEND
    vec4 tex = mix(texture2D(uMap, vUv0), texture2D(uMap, vUv1), vBlend);
  #else
    vec4 tex = texture2D(uMap, vUv0);
  #endif

  float a = tex.a * vColor.a;

  #ifdef DISSOLVE
    // The baked alpha is fractal, not a smooth falloff, so raising a threshold
    // across it frays the thin edges away first and then punches holes through
    // the body — smoke that erodes instead of uniformly ghosting out.
    // starts below zero so a young particle keeps its full soft falloff, then
    // climbs so the thin fringes are eaten first and holes open in the body
    float thr = mix(-0.28, uDissolve, vT);
    a = vColor.a * tex.a * smoothstep(thr, thr + 0.30, tex.a);
  #endif

  if (a < 0.003) discard;

  vec3 rgb = tex.rgb * vColor.rgb;

  #ifdef SOFT
    vec2 suv    = gl_FragCoord.xy / uResolution;
    float raw   = texture2D(uDepth, suv).x;
    float sceneZ = perspectiveDepthToViewZ(raw, uCamRange.x, uCamRange.y);
    float fragZ  = vViewPos.z;
    a *= clamp((fragZ - sceneZ) / uSoftDist, 0.0, 1.0);
    // and don't slap the lens
    a *= clamp((-fragZ - uCamRange.x * 2.0) * 0.7, 0.0, 1.0);
  #endif

  #ifdef ADDITIVE
    a *= (1.0 - vFog);
    gl_FragColor = vec4(rgb, a);
  #else
    rgb = mix(rgb, uFog.rgb, vFog);
    gl_FragColor = vec4(rgb, a);
  #endif

  // three sets TONE_MAPPING / the output-colour-space transfer per render
  // target, so these are correct both direct-to-canvas and inside a composer.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
