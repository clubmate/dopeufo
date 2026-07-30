// Camera-facing quad for the framebuffer-grab heat refraction.
uniform float uRadius;
varying vec2 vUvq;

void main() {
  vUvq = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uRadius;
  gl_Position = projectionMatrix * mv;
}
