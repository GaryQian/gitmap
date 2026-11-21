// GLSL shared by scene modules. Materials are plain THREE.ShaderMaterial (WebGL2: texelFetch and
// integer ops are available); spread ctx.uniforms into the material so these uniforms are bound.
import { SLOT_TEX_SHIFT, SLOT_TEX_WIDTH } from './positions';

/**
 * Position composition. A unit's ground position is city + district + unit-local; its centre sits at
 * y = radius. Use gmGround() with slots carried per instance, or gmUnitCenter() to reach any unit by
 * slot through the uUnitInfo lookup (edge endpoints, particle hosts).
 */
export const GLSL_POSITIONS = /* glsl */ `
uniform highp sampler2D uPosUnit;
uniform highp sampler2D uPosDistrict;
uniform highp sampler2D uPosCity;
uniform highp sampler2D uUnitInfo;
uniform highp sampler2D uUnitColor;
ivec2 gmTexel(int slot) { return ivec2(slot & ${SLOT_TEX_WIDTH - 1}, slot >> ${SLOT_TEX_SHIFT}); }
/** [x, z, r] of a city (world) or a district (local to its city); zero for slot < 0. */
vec3 gmCity(int slot) { return slot < 0 ? vec3(0.0) : texelFetch(uPosCity, gmTexel(slot), 0).xyz; }
vec3 gmDistrict(int slot) { return slot < 0 ? vec3(0.0) : texelFetch(uPosDistrict, gmTexel(slot), 0).xyz; }
/** World ground position (x, z) of a unit given its (unit, district, city) slots. */
vec2 gmGround(vec3 slots) {
  int u = int(slots.x + 0.5);
  int d = slots.y < 0.0 ? -1 : int(slots.y + 0.5);
  int c = slots.z < 0.0 ? -1 : int(slots.z + 0.5);
  return gmCity(c).xy + gmDistrict(d).xy + texelFetch(uPosUnit, gmTexel(u), 0).xy;
}
/** World centre of a unit by slot; r = its radius (0 for an empty slot). info = [radius, district, city, glow]. */
vec3 gmUnitCenter(int slot, out vec4 info) {
  info = texelFetch(uUnitInfo, gmTexel(slot), 0);
  vec2 g = gmGround(vec3(float(slot), info.y, info.z));
  return vec3(g.x, info.x, g.y);
}
/** Language colour (sRGB) of a unit by slot; a = 1 when the slot is in use. */
vec4 gmUnitColor(int slot) { return texelFetch(uUnitColor, gmTexel(slot), 0); }
`;

export const GLSL_HASH = /* glsl */ `
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

export const GLSL_NOISE = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
`;
