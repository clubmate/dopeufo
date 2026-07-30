// Ground shockwave ring — a flat disc whose radius is driven entirely by uTime.
uniform float uRadius;
varying vec2 vP;

void main() {
  vP = position.xy;                       // plane is authored in XY, rotated flat by the mesh
  vec3 p = vec3(position.xy * uRadius, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
