// Real refraction: the frame rendered so far is copied into uScene by an
// onBeforeRender hook the instant this mesh is drawn, then resampled with a
// turbulent offset. Costs one texture copy — no extra scene pass.
uniform sampler2D uScene;
uniform vec2  uResolution;
uniform float uTime;
uniform float uStrength;   // in pixels
uniform float uT;          // 0..1 life
uniform float uSeed;

varying vec2 vUvq;

float n2(vec2 p) {
  return sin(p.x * 3.1 + p.y * 1.7) * 0.5
       + sin(p.x * 7.3 - p.y * 5.1) * 0.28
       + sin(p.x * 13.7 + p.y * 11.3) * 0.14;
}

void main() {
  vec2 c = vUvq * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;

  // annulus: strongest just inside the fireball edge where the density
  // gradient is steepest, nothing dead centre (that's opaque flame anyway)
  float mask = smoothstep(1.0, 0.82, r) * smoothstep(0.05, 0.45, r);
  mask *= (1.0 - uT);

  vec2 dir = (r > 1e-4) ? c / r : vec2(0.0, 1.0);
  float t = uTime * 2.4 + uSeed;
  float w = n2(c * 6.0 + vec2(0.0, -t * 1.6)) + 0.6 * n2(c * 14.0 - vec2(t * 0.9, t * 2.1));

  vec2 off = (dir * w * 1.15 + vec2(w * 0.5, n2(c * 9.0 + t) * 0.8))
           * uStrength * mask / uResolution;

  vec2 suv = clamp(gl_FragCoord.xy / uResolution + off, vec2(0.0015), vec2(0.9985));
  vec3 col = texture2D(uScene, suv).rgb;

  // no tonemapping / colour-space conversion: uScene already holds whatever
  // encoding the current render target uses, so this is a pure pass-through.
  gl_FragColor = vec4(col, mask);
}
