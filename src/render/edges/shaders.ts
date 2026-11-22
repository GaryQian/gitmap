// Edge shaders, ported from the edge shader of spikes/render/main.ts (PLAN.md §8.3, §8.6). An edge is
// an arc tessellated and lifted in the vertex shader; its endpoints are looked up from the position
// textures, so nothing is uploaded when a city or district moves. The strip is three times the line's
// width: a thin trace down the middle and room for the glow around a passing pulse. A pulse is a
// white-hot bead with a short fading tail that fires, crosses at a constant world speed and rests;
// one time uniform drives every edge.
//
// Per instance:
//   aEnds = file edge: src unit slot, dst unit slot, –, –
//           ribbon:    district a (−1: the city itself), district b, city a, city b
//   aW    = strength 0..1 (width, brightness, how often it fires), brightness (confidence, dimming),
//           phase 0..1, share of the traffic that runs a → b (1 for a file edge)
//   aFx   = time it joined the buffer (s), line count at which it is hidden, nova direction
//           (+1: outward from a, −1: outward from b, 0: none), –
//   aCa, aCb = ribbon colours at a and b (file edges take their units' colours from uUnitColor)
// Defines: RIBBON (district or city ribbon: two lanes), FOCUS (hovered and selected edges).
import { GLSL_POSITIONS } from '../core/glsl';

const VARYINGS = /* glsl */ `
varying float vT; varying float vSide; varying float vLen; varying vec4 vW; varying vec3 vCa; varying vec3 vCb;
varying float vVis; varying float vNova;
`;

/** When the pulse fires and where its head is. Shared by the strip and the arrival flash. */
const GLSL_PULSE = /* glsl */ `
uniform vec4 uPulse;      // speed (world units / s), tail length (world units), shortest rest (s), longest rest (s)
/** Head position along the arc: 0..1 while crossing, above 1 while the line rests. */
float gmPulseHead(float len, float w01, float ph, out float travel) {
  travel = len / uPulse.x;
  // heavier connections rest for less time, so they fire more often
  float rest = mix(uPulse.w, uPulse.z, w01) * (0.6 + 0.8 * fract(sin(ph * 91.7) * 43758.5));
  float period = travel + rest;
  return fract(uTime / period + ph) * period / travel;
}
`;

const GLSL_ENDS = GLSL_POSITIONS + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform float uAlpha; uniform float uMinLines; uniform float uFadeIn;
attribute vec4 aEnds; attribute vec4 aW; attribute vec4 aFx;
#ifdef RIBBON
attribute vec3 aCa; attribute vec3 aCb;
#endif
int gmSlot(float f) { return f < 0.0 ? -1 : int(f + 0.5); }
/** How visible this instance is (0: skip it), and its two ends. rb = radius of the target unit. */
float gmEdge(out vec3 a, out vec3 b, out float rb, out vec3 ca, out vec3 cb) {
  float fade = clamp((uTime - aFx.x) / max(uFadeIn, 1e-3), 0.0, 1.0);
  float vis = uAlpha * fade * step(uMinLines, aFx.y);
  #ifdef RIBBON
    vec2 ga = gmCity(gmSlot(aEnds.z)).xy + gmDistrict(gmSlot(aEnds.x)).xy;
    vec2 gb = gmCity(gmSlot(aEnds.w)).xy + gmDistrict(gmSlot(aEnds.y)).xy;
    a = vec3(ga.x, 0.5, ga.y); b = vec3(gb.x, 0.5, gb.y); rb = 0.0;
    ca = aCa; cb = aCb;
  #else
    vec4 ia, ib; int sa = gmSlot(aEnds.x), sb = gmSlot(aEnds.y);
    a = gmUnitCenter(sa, ia); b = gmUnitCenter(sb, ib); rb = ib.x;
    ca = gmUnitColor(sa).rgb; cb = gmUnitColor(sb).rgb;
    // an endpoint that is gone or has no district yet draws nothing
    if (ia.x <= 0.0 || ib.x <= 0.0 || ia.y < 0.0 || ib.y < 0.0 || ia.z < 0.0 || ib.z < 0.0) vis = 0.0;
  #endif
  return vis;
}
`;

export const EDGE_VERT = GLSL_ENDS + VARYINGS + /* glsl */ `
uniform vec4 uWidth;      // world base, world gain per strength, min device pixels, max device pixels
uniform vec2 uLift;       // slope against ground length, base (world units)
void main() {
  vec3 a, b, ca, cb; float rb;
  float vis = gmEdge(a, b, rb, ca, cb);
  if (vis < 0.003) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = position.x; float len = distance(a.xz, b.xz) + 1.0;
  float lift = uLift.x * len + uLift.y;
  vec3 p = mix(a, b, t); p.y += sin(3.14159265 * t) * lift;
  vec3 tg = (b - a) + vec3(0.0, 3.14159265 * cos(3.14159265 * t) * lift, 0.0);
  vec3 toCam = cameraPosition - p;
  vec3 side = normalize(cross(tg, toCam));
  // The strip is three times the line's width: the fragment shader draws a thin trace down the
  // middle and uses the extra room for the glow around a passing pulse.
  float px = uPixelWorld * length(toCam);
  float w = clamp(uWidth.x + uWidth.y * aW.x, px * uWidth.z, px * uWidth.w) * 3.0;
  p += side * position.y * w;
  vT = t; vSide = position.y; vLen = len; vW = aW; vCa = ca; vCb = cb; vVis = vis; vNova = aFx.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

export const EDGE_FRAG = /* glsl */ `
uniform float uTime; uniform float uDark; uniform vec3 uText;
uniform float uFlicker;   // radians per second
uniform float uTrace; uniform float uGain; uniform float uMotion;
uniform float uNova; uniform float uNovaSpeed;
uniform vec3 uRibbon;    // ribbons: body strength, lane trace strength, pulse strength
` + VARYINGS + GLSL_PULSE + /* glsl */ `
// One pulse: x = tail strength, y = bead strength, at a point tt along its direction of travel.
vec2 gmPulse(float tt, float len, float w01, float ph) {
  float travel; float head = gmPulseHead(len, w01, ph, travel);
  float x = head - tt;                                               // how far this point is behind the head
  float tailLen = clamp(uPulse.y / len, 0.04, 0.40);
  float tail = (x > 0.0 && x < tailLen) ? pow(1.0 - x / tailLen, 3.0) : 0.0;
  float bead = exp(-pow(x / (tailLen * 0.10), 2.0)) * step(head, 1.0 + tailLen);  // the bright head
  return vec2(tail, bead);
}
void main() {
  vec3 col = mix(vCa, vCb, vT);
  float w01 = clamp(vW.x, 0.0, 1.0);
  float crackle = 0.72 + 0.28 * sin(uTime * uFlicker + vW.z * 300.0 + vT * 45.0);   // fast flicker
  #ifdef RIBBON
    // Two lanes: the +side half carries a → b, the other half b → a, each in proportion to its share.
    float fwd = step(0.0, vSide);
    float share = mix(1.0 - vW.w, vW.w, fwd);
    float tt = mix(1.0 - vT, vT, fwd);
    float s = abs(vSide) * 2.0 - 1.0;                                // −1..1 across this lane
    float line = exp(-s * s * 10.0);                                 // the lane's trace
    float glow = exp(-s * s * 5.0) * (1.0 - s * s);                  // light around a pulse, inside its lane
    float band = exp(-vSide * vSide * 3.0) * (1.0 - vSide * vSide);  // the ribbon's soft body
    float ends = smoothstep(0.0, 0.05, vT) * smoothstep(0.0, 0.05, 1.0 - vT);
    float heavy = 0.22 + 0.78 * w01;                                 // weak ribbons stay faint
    float trace = uTrace * heavy * (uRibbon.x * band + uRibbon.y * (0.4 + 0.6 * share) * line) * ends;
    // heavier ribbons carry more pulses at once, and each lane fires in proportion to its share
    float rate = share * (0.3 + 0.7 * w01);
    vec2 pk = gmPulse(tt, vLen, rate, vW.z + fwd * 0.17);
    pk = max(pk, gmPulse(tt, vLen, rate, vW.z + 0.3713 + fwd * 0.17) * step(0.35, w01));
    pk = max(pk, gmPulse(tt, vLen, rate, vW.z + 0.7426 + fwd * 0.17) * step(0.7, w01));
    pk *= step(0.02, share) * ends;
    crackle = 0.8 + 0.2 * sin(uTime * uFlicker + vW.z * 300.0);
    float p = (pk.x * 0.8 + pk.y * 1.1) * crackle * (0.35 + 0.65 * share) * (0.3 + 0.7 * w01) * uRibbon.z * uMotion;
  #else
    float s2 = vSide * vSide;
    float line = exp(-s2 * 22.0);                 // the thin, always-visible trace
    float glow = exp(-s2 * 3.5);                  // the wider light around a pulse
    float trace = (uTrace + 0.20 * w01) * line;
    vec2 pk = gmPulse(vT, vLen, w01, vW.z);
    float p = (pk.x * 0.9 + pk.y * 1.4) * crackle * (0.65 + 0.55 * w01) * uMotion;
  #endif
  #ifdef FOCUS
    if (vNova != 0.0) {
      // an 'open' burst: one synchronised pulse leaves the opened file along every connection at once
      float nt = vNova > 0.0 ? vT : 1.0 - vT;
      float head = (uTime - uNova) * uPulse.x * uNovaSpeed / vLen;
      float x = head - nt;
      float tailLen = clamp(uPulse.y * 2.0 / vLen, 0.08, 0.6);
      float tail = (x > 0.0 && x < tailLen) ? pow(1.0 - x / tailLen, 2.0) : 0.0;
      float bead = exp(-pow(x / (tailLen * 0.10), 2.0)) * step(head, 1.0 + tailLen) * step(0.0, head);
      pk = max(pk, vec2(tail, bead));
      p += (tail * 0.9 + bead * 1.6) * uMotion;
    }
  #endif
  float vis = vVis * vW.y * uGain;
  if (uDark > 0.5) {
    // emitted light: white-hot at the head, cooling to the connection's colour along the tail
    vec3 pc = mix(col * 1.35, vec3(1.0, 0.98, 0.92), clamp(pk.y + pk.x * pk.x * 0.5, 0.0, 1.0));
    gl_FragColor = vec4((col * trace + pc * p * (glow * 0.85 + line * 0.6)) * vis, 1.0);
  } else {
    // light mode: additive light is invisible, so a faint ink trace carries saturated packets
    vec3 sat = col / max(max(col.r, col.g), max(col.b, 1e-3));
    sat = pow(sat, vec3(1.5)) * 0.92;
    float ap = clamp(p * (glow * 0.8 + line * 0.6), 0.0, 1.0);
    vec3 ink = mix(uText, col * 0.7, 0.55);
    float a = clamp(trace * 1.5 + ap, 0.0, 1.0) * min(vis, 1.0);
    gl_FragColor = vec4(mix(ink, sat, clamp(ap * 2.5, 0.0, 1.0)), a);
  }
}`;

/** The small flash on the target sphere as a focus pulse arrives: one camera-facing quad per edge. */
export const FLASH_VERT = GLSL_ENDS + GLSL_PULSE + /* glsl */ `
uniform vec2 uFlash;      // seconds, size in target radii
uniform float uMotion;
varying vec2 vQ; varying vec3 vCol; varying float vI;
void main() {
  vec3 a, b, ca, cb; float rb;
  float vis = gmEdge(a, b, rb, ca, cb) * uMotion;
  float len = distance(a.xz, b.xz) + 1.0;
  float travel; float head = gmPulseHead(len, clamp(aW.x, 0.0, 1.0), aW.z, travel);
  float since = (head - 1.0) * travel;                // seconds since the pulse arrived
  float I = (since >= 0.0 && since < uFlash.x) ? pow(1.0 - since / uFlash.x, 2.0) : 0.0;
  I *= vis * aW.y;
  if (I < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 mv = viewMatrix * vec4(b, 1.0);
  mv.xy += position.xy * rb * uFlash.y;
  mv.z += rb * 1.05;                                  // in front of the target's own disc
  vQ = position.xy; vCol = cb; vI = I;
  gl_Position = projectionMatrix * mv;
}`;

export const FLASH_FRAG = /* glsl */ `
uniform float uDark; uniform vec3 uWarm;
varying vec2 vQ; varying vec3 vCol; varying float vI;
void main() {
  float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
  float g = exp(-d2 * 5.0) * (1.0 - d2);
  if (uDark > 0.5) {
    vec3 c = mix(vCol * 1.2, vec3(1.0, 0.98, 0.92), exp(-d2 * 14.0));
    gl_FragColor = vec4(c * g * vI * 0.9, 1.0);
  } else {
    vec3 sat = vCol / max(max(vCol.r, vCol.g), max(vCol.b, 1e-3));
    gl_FragColor = vec4(mix(pow(sat, vec3(1.5)), uWarm, exp(-d2 * 10.0) * 0.6), g * vI * 0.75);
  }
}`;
