// Edge shaders, ported from the edge shader of spikes/render/main.ts (PLAN.md §8.3, §8.6). An edge is
// an arc tessellated and lifted in the vertex shader; its endpoints are looked up from the position
// textures, so nothing is uploaded when a city or district moves. The strip is three times the line's
// width: a thin trace down the middle and room for the glow around a passing pulse. A pulse is a
// white-hot bead with a short fading tail that fires, crosses at a constant world speed and rests;
// one time uniform drives every edge.
//
// Per instance:
//   aEnds = file edge: src unit slot, dst unit slot, round-robin turn, round-robin group size (0: free)
//           ribbon:    district a (−1: the city itself), district b, city a, city b
//   aW    = strength 0..1 (width, brightness, how often it fires), brightness (confidence, dimming),
//           phase 0..1, share of the traffic that runs a → b (1 for a file edge)
//   aFx   = time it joined the buffer (s), line count at which it is hidden, nova direction
//           (+1: outward from a, −1: outward from b, 0: none), –
//   aCa, aCb = ribbon colours at a and b (file edges take their units' colours from uUnitColor)
// Defines: RIBBON (district or city ribbon: two lanes), FOCUS (hovered and selected edges).
import { GLSL_POSITIONS } from '../core/glsl';

const VARYINGS = /* glsl */ `
varying float vT; varying float vSide;
// The same for every vertex of an instance. Flat, because interpolating equal values is not exact
// and the pulse timing hashes its phase: any wobble there shows as speckle along the pulse.
flat varying float vLen; flat varying vec4 vW; flat varying vec3 vCa; flat varying vec3 vCb;
flat varying float vVis; flat varying float vNova;
flat varying vec3 vArc;  // ground length, rise from a to b, lift
flat varying vec2 vEndR; // radius of the sphere at each end (0 for a ribbon)
flat varying vec2 vRR;   // round-robin turn and group size around a busy sphere (size 0: free running)
`;

/** When the pulse fires and where its head is. Shared by the strip and the arrival flash. */
const GLSL_PULSE = /* glsl */ `
uniform vec4 uPulse;      // speed (world units / s), tail length (world units), shortest rest (s), longest rest (s)
uniform float uRestScale; // ambient levels rest longer between pulses than focus edges
uniform vec2 uRR;         // round robin around a busy sphere: most pulses in flight at once, seconds per pulse
/** Head position along the arc: 0..1 while crossing, above 1 while the line rests. */
float gmPulseHead(float len, float w01, float ph, vec2 rr, out float travel) {
  travel = len / uPulse.x;
  if (rr.y > 0.5) {
    // A busy sphere launches one pulse every spacing seconds and takes its connections in turn, so
    // only about uRR.x pulses are in flight around it however many connections it has.
    float spacing = uRR.y * uRestScale / uRR.x;
    float rrPeriod = max(rr.y * spacing, travel + uPulse.z * uRestScale);
    return mod(uTime - rr.x * spacing, rrPeriod) / travel;
  }
  // heavier connections rest for less time, so they fire more often
  float rest = mix(uPulse.w, uPulse.z, w01) * uRestScale * (0.6 + 0.8 * fract(sin(ph * 91.7) * 43758.5));
  float period = travel + rest;
  return fract(uTime / period + ph) * period / travel;
}
`;

const GLSL_ENDS = GLSL_POSITIONS + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform float uAlpha; uniform float uMinBytes; uniform float uFadeIn;
attribute vec4 aEnds; attribute vec4 aW; attribute vec4 aFx;
#ifdef RIBBON
attribute vec3 aCa; attribute vec3 aCb;
#endif
int gmSlot(float f) { return f < 0.0 ? -1 : int(f + 0.5); }
/** How visible this instance is (0: skip it), and its two ends. ra, rb = radii of the spheres at the ends. */
float gmEdge(out vec3 a, out vec3 b, out float ra, out float rb, out vec3 ca, out vec3 cb) {
  float fade = clamp((uTime - aFx.x) / max(uFadeIn, 1e-3), 0.0, 1.0);
  float vis = uAlpha * fade * step(uMinBytes, aFx.y);
  #ifdef RIBBON
    vec2 ga = gmCity(gmSlot(aEnds.z)).xy + gmDistrict(gmSlot(aEnds.x)).xy;
    vec2 gb = gmCity(gmSlot(aEnds.w)).xy + gmDistrict(gmSlot(aEnds.y)).xy;
    a = vec3(ga.x, 0.5, ga.y); b = vec3(gb.x, 0.5, gb.y); ra = 0.0; rb = 0.0;
    ca = aCa; cb = aCb;
  #else
    vec4 ia, ib; int sa = gmSlot(aEnds.x), sb = gmSlot(aEnds.y);
    a = gmUnitCenter(sa, ia); b = gmUnitCenter(sb, ib); ra = ia.x; rb = ib.x;
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
uniform float uTrim;      // the arc is hidden inside this many radii of the spheres at its ends
void main() {
  vec3 a, b, ca, cb; float ra, rb;
  float vis = gmEdge(a, b, ra, rb, ca, cb);
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
  #ifdef RIBBON
    vRR = vec2(0.0);
  #else
    vRR = aEnds.zw;
  #endif
  vArc = vec3(len, b.y - a.y, lift); vEndR = vec2(ra, rb) * uTrim;
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
vec2 gmPulse(float tt, float len, float w01, float ph, vec2 rr) {
  float travel; float head = gmPulseHead(len, w01, ph, rr, travel);
  float x = head - tt;                                               // how far this point is behind the head
  float tailLen = clamp(uPulse.y / len, 0.04, 0.40);
  float tail = (x > 0.0 && x < tailLen) ? pow(1.0 - x / tailLen, 3.0) : 0.0;
  float xb = x / (tailLen * 0.10);
  float bead = exp(-xb * xb) * step(head, 1.0 + tailLen);                 // the bright head
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
    vec2 pk = gmPulse(tt, vLen, rate, vW.z + fwd * 0.17, vec2(0.0));
    pk = max(pk, gmPulse(tt, vLen, rate, vW.z + 0.3713 + fwd * 0.17, vec2(0.0)) * step(0.7, w01));
    pk *= step(0.02, share) * ends;
    crackle = 0.8 + 0.2 * sin(uTime * uFlicker + vW.z * 300.0);
    float p = (pk.x * 0.8 + pk.y * 1.1) * crackle * (0.35 + 0.65 * share) * (0.3 + 0.7 * w01) * uRibbon.z * uMotion;
  #else
    float s2 = vSide * vSide;
    float line = exp(-s2 * 22.0);                 // the thin, always-visible trace
    float glow = exp(-s2 * 3.5);                  // the wider light around a pulse
    float trace = (uTrace + 0.20 * w01) * line;
    vec2 pk = gmPulse(vT, vLen, w01, vW.z, vRR);
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
      float xb = x / (tailLen * 0.10);
      float bead = exp(-xb * xb) * step(head, 1.0 + tailLen) * step(0.0, head);
      pk = max(pk, vec2(tail, bead));
      p += (tail * 0.9 + bead * 1.6) * uMotion;
    }
  #endif
  // The arc runs from centre to centre, but a sphere is drawn as a flat disc: without this the part
  // of the line inside a sphere would show over it whenever it runs toward the camera.
  float rise = sin(3.14159265 * vT) * vArc.z;
  float da = length(vec2(vT * vArc.x, vT * vArc.y + rise));
  float db = length(vec2((1.0 - vT) * vArc.x, (vT - 1.0) * vArc.y + rise));
  float outside = smoothstep(vEndR.x * 0.92, vEndR.x * 1.12 + 1e-4, da) * smoothstep(vEndR.y * 0.92, vEndR.y * 1.12 + 1e-4, db);
  float vis = vVis * vW.y * uGain * outside;
  if (uDark > 0.5) {
    // emitted light: white-hot at the head, cooling to the connection's colour along the tail
    vec3 pc = mix(col * 1.35, vec3(1.0, 0.98, 0.92), clamp(pk.y + pk.x * pk.x * 0.5, 0.0, 1.0));
    gl_FragColor = vec4((col * trace + pc * p * (glow * 0.85 + line * 0.6)) * vis, 1.0);
  } else {
    // light mode: additive light is invisible, so a faint ink trace carries saturated packets
    vec3 sat = col / max(max(col.r, col.g), max(col.b, 1e-3));
    sat = pow(sat, vec3(1.5)) * 0.92;
    float ap = clamp(p * (glow * 0.8 + line * 0.6), 0.0, 1.0);
    vec3 ink = mix(uText, col * 0.75, 0.65);
    #ifdef RIBBON
      ink = mix(uText, col * 0.8, 0.82);
      float at = trace * 0.7;
    #else
      float at = trace * 1.3;
    #endif
    float a = clamp(at + ap, 0.0, 1.0) * min(vis, 1.0);
    gl_FragColor = vec4(mix(ink, sat, clamp(ap * 2.5, 0.0, 1.0)), a);
  }
}`;

/** The small flash on the target sphere as a focus pulse arrives: one camera-facing quad per edge. */
export const FLASH_VERT = GLSL_ENDS + GLSL_PULSE + /* glsl */ `
uniform vec2 uFlash;      // seconds, size in target radii
uniform float uMotion;
varying vec2 vQ; flat varying vec3 vCol; flat varying float vI;
void main() {
  vec3 a, b, ca, cb; float ra, rb;
  float vis = gmEdge(a, b, ra, rb, ca, cb) * uMotion;
  float len = distance(a.xz, b.xz) + 1.0;
  float travel; float head = gmPulseHead(len, clamp(aW.x, 0.0, 1.0), aW.z, aEnds.zw, travel);
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
varying vec2 vQ; flat varying vec3 vCol; flat varying float vI;
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
