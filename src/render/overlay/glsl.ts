// Shader side of the overlay (PLAN.md §8.6): under an overlay the body takes the overlay colour, the
// core stays neutral white, and glow and ground light fade. A star whose value is not yet known is
// drawn unlit: no core, a hollow centre sunk toward the void, a thin rim in the "unknown" colour.
// The spheres' shaders include these chunks; the state behind the uniforms is OverlayFade (fade.ts).

/**
 * Vertex stage. Needs `varying vec3 vOvCol; varying float vOvKnown;` declared by the includer.
 *   aOverlay       ramp position before and after the last change (−1 = not yet known)
 *   uRamp          two rows: the ramp for aOverlay.x, the ramp for aOverlay.y
 *   uOverlayBlend  0 = the state before the last change, 1 = the current one
 */
export const GLSL_OVERLAY_VERT = /* glsl */ `
uniform float uOverlayBlend; uniform vec3 uUnknown; uniform vec3 uUnknownFrom; uniform sampler2D uRamp;
attribute vec2 aOverlay;
vec3 gmRamp(float t, int row, vec3 unknown) {
  return t < 0.0 ? unknown : texelFetch(uRamp, ivec2(int(clamp(t, 0.0, 1.0) * 255.0 + 0.5), row), 0).rgb;
}
// How strong an overlay colour is, 0..1: 0 for the grey faded end of a ramp, 1 for a saturated colour.
float gmOverlayHeat(vec3 ovCol) {
  float chroma = max(ovCol.r, max(ovCol.g, ovCol.b)) - min(ovCol.r, min(ovCol.g, ovCol.b));
  return smoothstep(0.10, 0.60, chroma);
}
// Sets vOvCol (overlay colour) and vOvKnown (0 = not yet known, 1 = known), cross-faded.
void gmOverlay() {
  vOvCol = mix(gmRamp(aOverlay.x, 0, uUnknownFrom), gmRamp(aOverlay.y, 1, uUnknown), uOverlayBlend);
  vOvKnown = mix(step(0.0, aOverlay.x), step(0.0, aOverlay.y), uOverlayBlend);
}
`;

/**
 * Fragment stage, bodies. `d2` is the squared distance from the disc centre (0..1), `shade` the
 * body's own limb darkening and surface detail, `burn` its core light (0..1).
 */
export const GLSL_OVERLAY_BODY = /* glsl */ `
vec3 gmOverlayBody(vec3 ovCol, float known, float d2, float shade, float burn, float glow, vec3 voidCol) {
  // known: the overlay colour as it is (its lightness carries meaning, so no exposure curve),
  // with the neutral white core on top. glow (0..1, the bright end of the ramp) lifts the body
  // further, so the brightest stars stand well clear of the faded bulk.
  vec3 lit = mix(ovCol * shade * (1.08 + 0.45 * glow), vec3(1.0), burn * 0.55);
  // not yet known: unlit, hollow
  vec3 unlit = mix(mix(ovCol, voidCol, 0.5), ovCol, smoothstep(0.30, 0.80, d2));
  return mix(unlit, lit, known);
}
`;

/**
 * How much of its glow and ground light a star keeps under an overlay. Unknown stars emit almost none;
 * known ones glow by how saturated their overlay colour is, so the grey faded end barely glows and a
 * strong colour (high ownership, a fresh change) glows hard.
 */
export const GLSL_OVERLAY_LIGHT = /* glsl */ `
float gmOverlayLight(float known, float overlayMix, vec3 ovCol) {
  float chroma = max(ovCol.r, max(ovCol.g, ovCol.b)) - min(ovCol.r, min(ovCol.g, ovCol.b));
  float lit = mix(0.35, 1.8, smoothstep(0.08, 0.6, chroma));
  return mix(1.0, mix(0.3, lit, known), overlayMix);
}
`;
