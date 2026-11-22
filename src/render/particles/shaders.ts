// Particle shaders (PLAN.md §8.4, §8.6), after the GPU particle pool of spikes/render/main.ts.
// Everything is a stateless function of time: a particle's position is its host's position (through
// the position textures) plus f(seed, time). Nothing is simulated or uploaded per frame.
import { GLSL_HASH, GLSL_POSITIONS } from '../core/glsl';
import { PARTICLE_LOCAL } from './tunables';

/** Saturated version of a type colour, for light mode where added light cannot be seen. */
const GLSL_SATURATE = /* glsl */ `
vec3 gmSaturate(vec3 c) { vec3 h = c / max(max(c.r, c.g), max(c.b, 1e-3)); return pow(h, vec3(1.5)) * 0.9; }
`;

// ---- ambient: stellar wind and void dust ----
// aHost = unit slot of the host sphere, −1 for a mote of void dust, −2 for a mote with no host. aSeed = 0..1.
export const AMBIENT_VERT = GLSL_POSITIONS + GLSL_HASH + /* glsl */ `
uniform float uTime; uniform float uPixelWorld; uniform float uDark; uniform vec3 uText;
uniform vec4 uBounds;     // min x, min z, width, depth of the map
uniform float uAmbient;   // overall strength (fade-in)
attribute float aHost; attribute float aSeed;
varying float vA; varying vec3 vCol;
void main() {
  vec3 p; float size;
  if (aHost >= 0.0) {
    // stellar wind: leaves the surface, drifts outward and upward a few radii, and fades
    int host = int(aHost + 0.5);
    vec4 info; vec3 c = gmUnitCenter(host, info); float r = info.x;
    if (r <= 0.0 || info.y < 0.0 || info.z < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
    float life = fract(uTime * (0.12 + 0.1 * aSeed) + aSeed * 17.0);
    float th = hash11(aSeed * 911.0) * 6.2831, ph = hash11(aSeed * 373.0) * 1.3;
    vec3 dir = vec3(cos(th) * cos(ph), sin(ph), sin(th) * cos(ph));
    p = c + dir * r * (1.0 + 2.5 * life) + vec3(0.0, life * 2.5 * r, 0.0);
    size = 0.12 * r + 0.3; vA = sin(3.14159 * life) * 0.8; vCol = gmUnitColor(host).rgb * 0.85;
  } else if (aHost < -1.5) {
    // no host to shed from
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return;
  } else {
    // void dust: sparse, faint and slow, through the whole volume, for parallax
    vec3 h = vec3(hash11(aSeed * 101.0), hash11(aSeed * 557.0), hash11(aSeed * 997.0));
    p = vec3(uBounds.x + h.x * uBounds.z, 10.0 + h.y * 0.25 * uBounds.z, uBounds.y + h.z * uBounds.w);
    p += vec3(sin(uTime * 0.05 + aSeed * 40.0), sin(uTime * 0.07 + aSeed * 13.0), cos(uTime * 0.04 + aSeed * 29.0)) * 15.0;
    size = 0.8; vA = 0.25; vCol = uDark > 0.5 ? vec3(0.45, 0.5, 0.6) : mix(uText, vec3(0.45, 0.5, 0.6), 0.5);
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(size / (uPixelWorld * -mv.z), 1.0, 12.0);
  // fade with distance, so the visible density stays even as the camera zooms
  vA *= clamp(1.0 - (-mv.z) / (uBounds.z * 2.5), 0.2, 1.0) * uAmbient;
  gl_Position = projectionMatrix * mv;
}`;

export const POINT_FRAG = GLSL_SATURATE + /* glsl */ `
uniform float uDark;
varying float vA; varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0; float d = dot(q, q); if (d > 1.0) discard;
  float a = vA * (1.0 - d);
  if (uDark > 0.5) gl_FragColor = vec4(vCol, a);
  else gl_FragColor = vec4(gmSaturate(vCol), min(1.0, a * 1.25));
}`;

// ---- bursts: each one is a spawn time, an origin and a seed ----
const MAX = PARTICLE_LOCAL.maxBursts;
const GLSL_BURST = GLSL_POSITIONS + GLSL_HASH + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform vec4 uBurstA[${MAX}];   // origin (world), spawn time (s)
uniform vec4 uBurstB[${MAX}];   // kind (0 none, 1 select, 2 open), radius, particle count, seed
uniform vec4 uBurstC[${MAX}];   // colour, host unit slot (−1: use the origin)
uniform vec2 uLife;             // seconds a select burst and an open burst last
/** Origin, radius, colour, kind and age (0..1 across its life; outside that range it is over). */
float gmBurst(int i, out vec3 origin, out float r, out vec3 col, out float kind) {
  vec4 A = uBurstA[i], B = uBurstB[i], C = uBurstC[i];
  kind = B.x; r = B.y; col = C.rgb; origin = A.xyz;
  if (C.a >= 0.0) { vec4 info; vec3 c = gmUnitCenter(int(C.a + 0.5), info); if (info.x > 0.0) { origin = c; r = info.x; } }
  if (kind < 0.5) return -1.0;
  return (uTime - A.w) / (kind > 1.5 ? uLife.y : uLife.x);
}
float easeOut(float t) { float u = 1.0 - clamp(t, 0.0, 1.0); return 1.0 - u * u * u; }
`;

// aBurst = burst index, aSeed = 0..1, aIndex = particle number within its burst.
export const BURST_VERT = GLSL_BURST + /* glsl */ `
uniform float uSparks;    // 0 hides the particles (particles switched off)
attribute float aBurst; attribute float aSeed; attribute float aIndex;
varying float vA; varying vec3 vCol;
void main() {
  int i = int(aBurst + 0.5);
  vec3 o, col; float r, kind;
  float age = gmBurst(i, o, r, col, kind);
  float count = uBurstB[i].z, seed = uBurstB[i].w;
  if (age < 0.0 || age >= 1.0 || aIndex >= count || uSparks < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float h1 = hash11(aSeed * 311.0 + seed * 7.0), h2 = hash11(aSeed * 173.0 + seed * 13.0), h3 = hash11(aSeed * 59.0 + seed * 3.0);
  vec3 p; float size;
  if (kind < 1.5) {
    // select: a ring in the type colour expanding outward and settling
    float th = (aIndex + 0.35 * (h1 - 0.5)) / count * 6.2831853 + seed * 6.2831853;
    float reach = r * (1.15 + (2.6 + 1.6 * h2) * easeOut(age * 1.4));
    p = o + vec3(cos(th) * reach, (h3 - 0.5) * r * 0.5 * easeOut(age), sin(th) * reach);
    size = 0.16 * r + 0.35;
    vA = (1.0 - age) * (1.0 - age) * 0.95;
    vCol = mix(col * 1.2, vec3(1.0, 0.98, 0.92), 0.5 * (1.0 - age));
  } else {
    // open: a nova, thrown in every direction
    float th = h1 * 6.2831853, y = h2 * 1.6 - 0.6;
    float c = sqrt(max(0.0, 1.0 - min(1.0, y * y)));
    vec3 dir = normalize(vec3(cos(th) * c, y, sin(th) * c));
    float reach = r * (1.0 + (3.5 + 6.5 * h3) * easeOut(age * 1.2));
    p = o + dir * reach + vec3(0.0, r * 1.5 * age, 0.0);
    size = 0.2 * r + 0.4;
    vA = (1.0 - age) * (1.0 - age);
    vCol = mix(col * 1.2, vec3(1.0, 0.98, 0.92), 0.75 * (1.0 - age) * (1.0 - age));
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(size * (1.0 - 0.5 * age) / (uPixelWorld * -mv.z), 1.5, 14.0);
  gl_Position = projectionMatrix * mv;
}`;

// The burst's larger shapes, one instanced quad each. aBurst = burst index; aPart = 0 core flash
// (camera-facing), 1 shockwave ring (flat on the ground), 2 column of light (upright, turned to the camera).
export const SHAPE_VERT = GLSL_BURST + /* glsl */ `
uniform vec4 uShape;      // ring reach in radii, ring reach in world units, column height in radii, column width in radii
attribute float aBurst; attribute float aPart;
varying vec2 vQ; varying vec3 vCol; varying float vAge; varying float vPart; varying float vKind;
void main() {
  int i = int(aBurst + 0.5);
  vec3 o, col; float r, kind;
  float age = gmBurst(i, o, r, col, kind);
  if (age < 0.0 || age >= 1.0 || (aPart > 1.5 && kind < 1.5)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vQ = position.xy; vCol = col; vAge = age; vPart = aPart; vKind = kind;
  if (aPart < 0.5) {
    // core flash: a soft bloom over the sphere, gone in the first third of the burst
    vec4 mv = viewMatrix * vec4(o, 1.0);
    mv.xy += position.xy * r * (kind > 1.5 ? 5.0 : 3.2) * (0.6 + 0.8 * easeOut(age * 3.0));
    mv.z += r * 1.05;
    gl_Position = projectionMatrix * mv;
  } else if (aPart < 1.5) {
    // shockwave: a quad on the ground; the ring itself is drawn in the fragment shader
    float reach = (r * uShape.x + uShape.y) * (kind > 1.5 ? 1.5 : 1.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(o.x + position.x * reach, 0.12, o.z + position.y * reach, 1.0);
  } else {
    // column of light: rises from the sphere, always turned toward the camera
    vec3 toCam = cameraPosition - o; vec2 side = normalize(vec2(toCam.z, -toCam.x));
    float h = r * uShape.z * easeOut(age * 2.5), w = r * uShape.w;
    vec3 p = vec3(o.x + side.x * position.x * w, (position.y * 0.5 + 0.5) * h, o.z + side.y * position.x * w);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
}`;

export const SHAPE_FRAG = GLSL_SATURATE + /* glsl */ `
uniform float uDark; uniform vec3 uWarm;
varying vec2 vQ; varying vec3 vCol; varying float vAge; varying float vPart; varying float vKind;
void main() {
  float a; vec3 c = vCol;
  vec3 hot = vec3(1.0, 0.98, 0.92);
  if (vPart < 0.5) {
    float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
    float life = clamp(1.0 - vAge * 3.0, 0.0, 1.0);
    a = exp(-d2 * 4.5) * (1.0 - d2) * life * life * (vKind > 1.5 ? 1.0 : 0.8);
    c = mix(vCol * 1.2, hot, exp(-d2 * 9.0));
  } else if (vPart < 1.5) {
    float d = length(vQ); if (d > 1.0) discard;
    float t = min(1.0, vAge * 1.25);
    float rho = 1.0 - (1.0 - t) * (1.0 - t);                 // the ring runs out fast, then slows
    float wdt = 0.018 + 0.05 * rho;
    float ring = exp(-pow((d - rho * 0.96) / wdt, 2.0));
    float wake = smoothstep(rho - 0.35, rho, d) * step(d, rho) * 0.25;         // a faint wash behind the front
    a = (ring + wake) * (1.0 - t) * (1.0 - t) * 0.8;
    c = mix(vCol * 1.15, hot, 0.35 * ring);
  } else {
    float x = abs(vQ.x), y = vQ.y * 0.5 + 0.5;
    float life = (1.0 - vAge) * (1.0 - vAge) * smoothstep(0.0, 0.06, vAge);
    a = exp(-x * x * 7.0) * (1.0 - x * x) * (1.0 - y) * (1.0 - y * y) * life * 0.9;
    c = mix(vCol * 1.2, hot, exp(-x * x * 40.0) * 0.8);
  }
  if (a < 0.004) discard;
  if (uDark > 0.5) gl_FragColor = vec4(c * a, 1.0);
  else gl_FragColor = vec4(mix(gmSaturate(vCol), uWarm, vPart < 0.5 ? 0.5 : 0.15), min(1.0, a * 0.9));
}`;

// ---- the reveal: each sphere ignites with a small flash as it grows in ----
// One point per unit slot (gl_VertexID). The ignition time repeats the spheres module's reveal
// stagger: a per-city share from uCityStagger plus a per-slot jitter.
export const IGNITE_VERT = GLSL_POSITIONS + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform highp sampler2D uCityStagger;   // per city slot: share of the reveal at which the city starts
uniform vec4 uReveal;     // start (s), length (s), per-slot jitter (share of the length), a sphere's own growth (s)
uniform vec2 uIgnite;     // flash length (s), size in radii
varying float vA; varying vec3 vCol;
void main() {
  int slot = gl_VertexID;
  vec4 info; vec3 c = gmUnitCenter(slot, info);
  float jitter = float(uint(slot + 1) * 2654435761u) / 4294967296.0;
  float share = info.z < 0.0 ? 0.0 : texelFetch(uCityStagger, gmTexel(int(info.z + 0.5)), 0).r;
  float born = uReveal.x + (share + jitter * uReveal.z) * uReveal.y;
  float age = (uTime - born - uReveal.w * 0.35) / uIgnite.x;
  if (info.x <= 0.0 || info.y < 0.0 || age <= 0.0 || age >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.z += info.x * 1.05;
  gl_PointSize = clamp(info.x * uIgnite.y * (0.7 + 0.6 * age) / (uPixelWorld * -mv.z), 2.0, 56.0);
  vA = sin(3.14159265 * sqrt(age)) * 0.55;
  vCol = mix(gmUnitColor(slot).rgb * 1.2, vec3(1.0, 0.98, 0.92), 0.4);
  gl_Position = projectionMatrix * mv;
}`;

export const IGNITE_FRAG = GLSL_SATURATE + /* glsl */ `
uniform float uDark;
varying float vA; varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0; float d = dot(q, q); if (d > 1.0) discard;
  float a = vA * exp(-d * 3.5) * (1.0 - d);
  if (uDark > 0.5) gl_FragColor = vec4(vCol * a, 1.0);
  else gl_FragColor = vec4(gmSaturate(vCol), a * 0.8);
}`;
