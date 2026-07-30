// Ground shockwave: a hard-edged compression ring chasing an inner dust wall.
// The leading edge is deliberately razor thin — that's what sells the speed.
#include <common>

uniform float uT;        // 0..1 normalised life
uniform vec3  uColor;    // dust tint
uniform vec3  uHot;      // inner scorch/heat tint
uniform float uSeed;
varying vec2 vP;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// 1D periodic value noise around the ring so the edge is never a perfect circle
float ringNoise(float a, float freq, float seed) {
  float x = a * freq;
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float p = freq;
  float a0 = hash(mod(i, p) + seed);
  float a1 = hash(mod(i + 1.0, p) + seed);
  return mix(a0, a1, f) * 2.0 - 1.0;
}

void main() {
  float r = length(vP);
  if (r > 1.0) discard;

  float ang = atan(vP.y, vP.x);
  float wob = ringNoise(ang, 9.0, uSeed) * 0.030 + ringNoise(ang, 23.0, uSeed + 7.0) * 0.014;

  float edge = 1.0 + wob;                       // outer edge of the wave
  float thick = mix(0.16, 0.42, uT);            // the wall thickens as it slows

  // leading compression ring: sharp outside, soft inside
  float lead = smoothstep(edge, edge - 0.045, r) * smoothstep(edge - thick, edge - thick * 0.45, r);

  // trailing dust skirt filling the interior, dying from the middle out
  float skirt = smoothstep(edge, edge - thick * 2.4, r) * (1.0 - smoothstep(0.0, 0.55, r * (0.4 + uT)));

  // radial streaking so the wave has grain rather than reading as a gradient
  float streak = 0.62 + 0.38 * (ringNoise(ang, 41.0, uSeed + 3.0) * 0.5 + 0.5);

  float a = (lead * 0.95 + skirt * 0.40) * streak;
  a *= (1.0 - uT) * (1.0 - uT);
  a *= smoothstep(0.0, 0.06, uT);               // one frame of ramp-in

  vec3 col = mix(uColor, uHot, clamp(lead * 1.6 * (1.0 - uT * 1.6), 0.0, 1.0));

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
