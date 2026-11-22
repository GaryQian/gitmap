// Territory shaders (PLAN.md §8.2, §17.5), after the territory pass of spikes/render/main.ts.
// 1. An offscreen top-down pass adds every sphere's footprint, and one wide faint disc per district,
//    into a low-resolution texture: rgb = Σ weight × tint, a = Σ weight. The tint is the district's
//    (its city's hue, nudged per district), so the texture is tagged with district and city.
// 2. The ground samples it: a tinted fill, a contour around each city's outline and a fainter one
//    around the dense cores. Pools of light in dark mode, tinted shade in light mode.
// 3. District borders are drawn as crisp lines from the Voronoi cells, masked by the same texture.
import { GLSL_POSITIONS } from '../core/glsl';

/** Clip position of a world ground point inside the footprint texture. uTB = min x, min z, width, depth. */
const GLSL_TOP_DOWN = /* glsl */ `
uniform vec4 uTB;
vec4 gmTopDown(vec2 ground) { return vec4((ground - uTB.xy) / uTB.zw * 2.0 - 1.0, 0.0, 1.0); }
`;

const FOOTPRINT_COMMON = GLSL_POSITIONS + GLSL_TOP_DOWN + /* glsl */ `
uniform highp sampler2D uDistrictTint;   // per district slot: tint rgb, city slot (−1: no such district)
varying vec2 vQ; varying vec3 vTint;
`;

/** One instance per unit slot: a soft disc a few radii wide. */
export const FOOTPRINT_VERT = FOOTPRINT_COMMON + /* glsl */ `
uniform vec2 uFootprint;   // radii, skirt (world units)
void main() {
  vec4 info; vec3 c = gmUnitCenter(gl_InstanceID, info);
  if (info.x <= 0.0 || info.y < 0.0 || info.z < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vTint = texelFetch(uDistrictTint, gmTexel(int(info.y + 0.5)), 0).rgb;
  vQ = position.xy;
  gl_Position = gmTopDown(c.xz + position.xy * (info.x * uFootprint.x + uFootprint.y));
}`;

export const FOOTPRINT_FRAG = /* glsl */ `
uniform float uWeight;
varying vec2 vQ; varying vec3 vTint;
void main() {
  float d = dot(vQ, vQ); if (d > 1.0) discard;
  float w = exp(-d * 4.0) * (1.0 - d) * uWeight;
  gl_FragColor = vec4(vTint * w, w);
}`;

/** One instance per district slot: a wide, faint disc that joins its files into one shape. */
export const DISTRICT_VERT = FOOTPRINT_COMMON + /* glsl */ `
uniform vec2 uDisc;        // scale of the territory radius, skirt (world units)
void main() {
  vec4 T = texelFetch(uDistrictTint, gmTexel(gl_InstanceID), 0);
  vec3 D = gmDistrict(gl_InstanceID);
  if (T.a < 0.0 || D.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vTint = T.rgb; vQ = position.xy;
  gl_Position = gmTopDown(gmCity(int(T.a + 0.5)).xy + D.xy + position.xy * (D.z * uDisc.x + uDisc.y));
}`;

export const DISTRICT_FRAG = /* glsl */ `
uniform float uWeight;
varying vec2 vQ; varying vec3 vTint;
void main() {
  float d = length(vQ); if (d > 1.0) discard;
  float w = (1.0 - smoothstep(0.45, 1.0, d)) * uWeight;
  gl_FragColor = vec4(vTint * w, w);
}`;

/** One instance per city slot: a faint disc of the city's own radius, the ground its districts stand on. */
export const CITY_VERT = GLSL_POSITIONS + GLSL_TOP_DOWN + /* glsl */ `
uniform highp sampler2D uCityTint;       // per city slot: tint rgb, 1 when the city exists
uniform vec2 uDisc;        // scale of the city radius, skirt (world units)
varying vec2 vQ; varying vec3 vTint;
void main() {
  vec4 T = texelFetch(uCityTint, gmTexel(gl_InstanceID), 0);
  vec3 C = gmCity(gl_InstanceID);
  if (T.a < 0.5 || C.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vTint = T.rgb; vQ = position.xy;
  gl_Position = gmTopDown(C.xy + position.xy * (C.z * uDisc.x + uDisc.y));
}`;

export const CITY_FRAG = /* glsl */ `
uniform float uWeight;
varying vec2 vQ; varying vec3 vTint;
void main() {
  float d = length(vQ); if (d > 1.0) discard;
  float w = (1.0 - smoothstep(0.78, 1.0, d)) * uWeight;
  gl_FragColor = vec4(vTint * w, w);
}`;

/** Bicubic (B-spline) sampling in four bilinear taps: contours stay round when the camera is close. */
const GLSL_TERRITORY = /* glsl */ `
uniform sampler2D uTerr; uniform vec4 uTB; uniform float uTerrRes; uniform float uWScale;
vec4 gmTerritory(vec2 ground) {
  vec2 uv = (ground - uTB.xy) / uTB.zw;
  vec2 st = uv * uTerrRes - 0.5; vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / uTerrRes, h1 = (i + 1.5 + w3 / g1) / uTerrRes;
  vec4 t = (texture2D(uTerr, vec2(h0.x, h0.y)) * g0.x + texture2D(uTerr, vec2(h1.x, h0.y)) * g1.x) * g0.y
         + (texture2D(uTerr, vec2(h0.x, h1.y)) * g0.x + texture2D(uTerr, vec2(h1.x, h1.y)) * g1.x) * g1.y;
  return t * uWScale;
}
`;

export const GROUND_VERT = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

export const GROUND_FRAG = GLSL_TERRITORY + /* glsl */ `
uniform float uDark; uniform float uFade; uniform vec3 uText;
uniform vec2 uFill;        // density where the fill starts, and where it is full
uniform vec2 uContour;     // density of the outer contour (city boundary) and the inner one (district boundary)
uniform vec3 uStrength;    // fill, outer contour, inner contour
varying vec3 vW;
void main() {
  vec4 t = gmTerritory(vW.xz);
  float dens = t.a;
  if (dens < 0.003) discard;
  vec3 tint = t.rgb / max(dens, 1e-4);
  float fill = smoothstep(uFill.x, uFill.y, dens);
  float fw = max(fwidth(dens), 1e-5) * 1.5;
  float outer = 1.0 - smoothstep(0.0, fw, abs(dens - uContour.x));
  float inner = 1.0 - smoothstep(0.0, fw, abs(dens - uContour.y));
  // far away the contours would shimmer: let them go as a texel shrinks below a pixel
  float calm = 1.0 - smoothstep(0.25, 0.9, fw / max(uContour.x, 1e-4));
  outer *= calm; inner *= calm;
  if (uDark > 0.5) {
    // pools of light with luminous contours
    vec3 add = tint * (fill * uStrength.x + outer * uStrength.y + inner * uStrength.z);
    gl_FragColor = vec4(add * uFade, 1.0);
  } else {
    // soft tinted shade with contour lines over the pale void
    float a1 = fill * uStrength.x, a2 = outer * uStrength.y, a3 = inner * uStrength.z;
    vec3 shade = mix(tint, uText, 0.18 * smoothstep(uContour.x, uContour.y, dens));
    vec3 c = shade * a1; float al = a1;
    c = c * (1.0 - a2) + tint * 0.72 * a2; al = al * (1.0 - a2) + a2;
    c = c * (1.0 - a3) + tint * 0.72 * a3; al = al * (1.0 - a3) + a3;
    gl_FragColor = vec4(c / max(al, 1e-4), al * uFade);
  }
}`;

/** One instance per Voronoi border: a ground-plane quad along the segment. aSeg = x0, z0, x1, z1 (local to the city). */
export const BORDER_VERT = GLSL_POSITIONS + /* glsl */ `
uniform float uPixelWorld; uniform vec2 uBorder;   // device pixels, least world width
attribute vec4 aSeg; attribute float aCity;
varying vec3 vW; varying float vSide;
void main() {
  vec2 c = gmCity(int(aCity + 0.5)).xy;
  vec2 a = c + aSeg.xy, b = c + aSeg.zw;
  vec2 along = b - a; float len = max(length(along), 1e-5);
  vec2 across = vec2(-along.y, along.x) / len;
  vec2 g = mix(a, b, position.x);
  float depth = distance(cameraPosition, vec3(g.x, 0.0, g.y));
  // three times the line's width, for a soft edge
  float w = max(uBorder.y, uBorder.x * uPixelWorld * depth) * 1.5;
  g += across * position.y * w;
  vW = vec3(g.x, 0.08, g.y); vSide = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

export const BORDER_FRAG = GLSL_TERRITORY + /* glsl */ `
uniform float uDark; uniform float uFade; uniform float uBorderStrength; uniform vec2 uContour;
varying vec3 vW; varying float vSide;
void main() {
  vec4 t = gmTerritory(vW.xz);
  // the border runs out to the drawn outline of the districts and stops on it
  float fw = max(fwidth(t.a), 1e-5) * 1.5;
  float inside = smoothstep(uContour.x - fw, uContour.x, t.a);
  float a = exp(-vSide * vSide * 6.0) * inside * uBorderStrength * uFade;
  if (a < 0.004) discard;
  vec3 tint = t.rgb / max(t.a, 1e-4);
  if (uDark > 0.5) gl_FragColor = vec4(mix(tint, vec3(1.0), 0.25) * a, 1.0);
  else gl_FragColor = vec4(tint * 0.6, a);
}`;
