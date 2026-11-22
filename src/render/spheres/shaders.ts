// The star look, ported from spikes/render/main.ts (accepted 2026-11-21; PLAN.md §8.6). Each file is
// a small self-lit star: no light direction, no highlight, no silhouette. Three draws share one
// vertex prelude: bodies (opaque, depth), glows (no depth write) and flat ground-light quads.
// Tunables come from config.visual.star as uniforms; the remaining literals are the spike's.
import { GLSL_HASH, GLSL_NOISE, GLSL_POSITIONS } from '../core/glsl';
import { GLSL_OVERLAY_BODY, GLSL_OVERLAY_LIGHT, GLSL_OVERLAY_VERT } from '../overlay/glsl';

const STAR_VARYINGS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol; varying vec3 vOvCol; varying float vOvKnown; varying float vGlow; varying float vSuper;
varying float vScale; varying float vPhase; varying float vDim; varying float vBoost;
`;

/**
 * Shared by all three vertex shaders. Per instance:
 *   aSlot  = unit slot, district slot, city slot         (model, written by applyBatch)
 *   aShape = radius, glow 0..1, bytes on disk, alive     (model)
 *   aColor = language colour rgb, language index / 255   (model)
 *   aState = flags (1 selected, 2 highlighted, 4 hovered), birth time (s)   (view)
 *   aNudge = display-only offset in world units (jiggle)  (view)
 *   aOverlay = overlay ramp position before and after the last change   (view; ../overlay/glsl.ts)
 */
const STAR_PRELUDE = GLSL_POSITIONS + GLSL_HASH + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform float uGrow; uniform float uMinBytes; uniform float uSelScale; uniform float uBreathe; uniform float uSpikesFrom;
uniform float uOverlayMix; uniform float uMinPx;
uniform vec4 uEmphasis;   // breathe scale, hover scale, selected glow, highlight glow
uniform float uHoverGlow;
uniform sampler2D uLangDim;
attribute vec3 aSlot; attribute vec4 aShape; attribute vec4 aColor; attribute vec2 aState; attribute vec3 aNudge;
` + STAR_VARYINGS + GLSL_OVERLAY_VERT + /* glsl */ `
// Is this instance drawn, where is its centre, how large is it, how much light leaves it.
bool gmStar(out vec3 center, out float r) {
  float g = aShape.y;
  int flags = int(aState.x + 0.5);
  float sel = float(flags & 1), hi = float((flags >> 1) & 1), hov = float((flags >> 2) & 1);
  float age = (uTime - aState.y) / max(uGrow, 1e-3);
  if (aShape.w < 0.5 || age <= 0.0 || aSlot.y < 0.0 || aSlot.z < 0.0) return false;
  // the size slider: small files go, glowing and selected ones stay
  if (aShape.z < uMinBytes && g <= 0.0 && sel < 0.5) return false;
  float k = clamp(age, 0.0, 1.0);
  float grow = 1.0 - (1.0 - k) * (1.0 - k) * (1.0 - k);
  float breath = sel * (0.5 + 0.5 * sin(uTime * 6.2831853 / uBreathe));
  float dim = texelFetch(uLangDim, ivec2(int(aColor.a * 255.0 + 0.5), 0), 0).r * (1.0 - max(sel, hi));
  r = aShape.x * grow * mix(1.0, uSelScale, sel) * (1.0 + uEmphasis.x * breath) * mix(1.0, uEmphasis.y, hov);
  vec2 ground = gmGround(aSlot) + aNudge.xz;
  center = vec3(ground.x, r + aNudge.y, ground.y);
  // importance glow: about the top 10% of files; it fades while an overlay is active
  float shaped = g * g * (3.0 - 2.0 * g);
  float emphasis = max(sel * (uEmphasis.z + 0.15 * breath), max(hi * uEmphasis.w, hov * uHoverGlow));
  vGlow = max(shaped * (1.0 - uOverlayMix), emphasis) * (1.0 - dim);
  // the top few percent flare like a supernova
  vSuper = smoothstep(uSpikesFrom, 1.0, g) * (1.0 - uOverlayMix) * (1.0 - dim);
  vCol = aColor.rgb;
  gmOverlay();
  vPhase = hash11(aSlot.x) * 6.2831;
  vDim = dim;
  vBoost = (1.0 - k) * 1.5 + breath * 0.6;   // a flash as it ignites; the core breathes when selected
  return true;
}
`;

/** Bodies and glows. Define CORONA for the glow pass. */
export const STAR_VERT = STAR_PRELUDE + /* glsl */ `
void main() {
  vec3 c; float r;
  if (!gmStar(c, r)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  #ifdef CORONA
    vScale = 1.35 + 1.7 * vGlow + 2.4 * vSuper;
  #else
    vScale = 1.0;
  #endif
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float rr = max(r, uMinPx * uPixelWorld * -mv.z);   // far-away stars stay visible points
  vUv = position.xy * vScale;
  mv.xy += position.xy * rr * vScale;
  #ifdef CORONA
    mv.z += rr * 0.02; // sit just in front of its own disc; nearer stars still occlude it
  #endif
  gl_Position = projectionMatrix * mv;
}`;

export const BODY_FRAG = /* glsl */ `
uniform float uTime; uniform float uDark; uniform float uOverlayMix; uniform vec3 uDustCool; uniform vec3 uVoid;
uniform vec2 uCoreGain; uniform vec2 uCoreTight; uniform float uLimb; uniform float uFlicker;
` + STAR_VARYINGS + GLSL_NOISE + GLSL_OVERLAY_BODY + /* glsl */ `
void main() {
  float d2 = dot(vUv, vUv); if (d2 > 1.0) discard;
  float d = sqrt(d2);
  float px = 1.0 / max(fwidth(d), 1e-4);                 // radius in pixels
  float detail = smoothstep(5.0, 16.0, px);              // surface detail only when large on screen
  float t = uTime;
  float flick = 1.0 + uFlicker * (sin(t * 1.1 + vPhase) * 0.65 + sin(t * 2.7 + vPhase * 1.9) * 0.35);

  // plasma: slow turbulent brightness across the surface
  float n = 0.5;
  if (detail > 0.0) { vec2 q = vUv * 2.6 + vec2(vPhase, vPhase * 1.7);
    n = vnoise(q + t * 0.12) * 0.6 + vnoise(q * 2.3 - t * 0.19) * 0.4; }

  // The disc is opaque and cut slightly inside its nominal radius; the glow pass blooms over the
  // cut, so there is never a crisp silhouette (a crisp edge is what makes a ball read as a marble).
  if (d > 0.93) discard;

  // Emission, then exposure. Brightness is highest at the centre and falls smoothly to the limb.
  // Passing it through an exposure curve lets the centre burn out toward white the way a bright
  // light source does on a sensor. Nothing is drawn: no core shape, no rays, no highlight.
  vec3 hue = vCol / max(max(vCol.r, vCol.g), max(vCol.b, 1e-3));
  hue = pow(hue, vec3(1.6));                               // keep the file-type colour saturated
  float limbDark = mix(1.0, uLimb, d2);
  float surface = 1.0 + detail * 0.28 * (n - 0.5);
  float core = exp(-d2 * mix(uCoreTight.x, uCoreTight.y, vGlow)) * (mix(uCoreGain.x, uCoreGain.y, vGlow) + vBoost) * flick * (1.0 - vDim);
  float I = (1.30 + core) * limbDark * surface;
  vec3 col = 1.0 - exp(-hue * I);
  vec3 hot = uDark > 0.5 ? vec3(1.0, 0.97, 0.90) : vec3(1.0, 0.95, 0.82);
  float burn = 1.0 - exp(-core * 0.30);
  col = mix(col, hot, burn);

  // Under an overlay the body takes the overlay colour and the core stays neutral white; a star
  // whose value is not yet known is drawn unlit (../overlay/glsl.ts).
  col = mix(col, gmOverlayBody(vOvCol, vOvKnown, d2, limbDark * surface, burn, uVoid), uOverlayMix);

  // A sphere dimmed by the legend loses its core light and drops to a pale grey body.
  col = mix(col, uDustCool * mix(1.12, 0.82, d2), vDim);
  gl_FragColor = vec4(col, 1.0);
}`;

export const GLOW_FRAG = /* glsl */ `
uniform float uTime; uniform float uDark; uniform float uOverlayMix; uniform vec3 uDustCool; uniform vec2 uGlowFalloff;
` + STAR_VARYINGS + GLSL_OVERLAY_LIGHT + /* glsl */ `
void main() {
  float d = length(vUv);
  // The glow overlaps the body's cut edge so no gap can open between the two draws. The overlap
  // fades in over at least a pixel: a hard-edged overlap thinner than a pixel aliases into a
  // dotted rim on small spheres.
  float inner = 0.93 - max(0.015, fwidth(d));
  if (d < inner || d > vScale) discard;
  float t = uTime;
  // Glow: starts at the disc's cut edge at about the limb's own brightness, so the edge has no
  // outline, then falls away in a long soft tail. Smooth everywhere: no drawn rays, no rings.
  float s = mix(uGlowFalloff.x, uGlowFalloff.y, vGlow);
  float g = 1.0 / (1.0 + pow(max(d - 0.93, 0.0) * s, 2.0));
  float a = g * (0.50 + 0.25 * vGlow) * (1.0 + 0.05 * sin(t * 0.9 + vPhase));
  if (vSuper > 0.0) {
    // thin, faint diffraction spikes on the very brightest only, as a telescope would show them
    float cs = cos(0.35), sn = sin(0.35); vec2 u = vec2(cs * vUv.x - sn * vUv.y, sn * vUv.x + cs * vUv.y);
    float sx = exp(-abs(u.y) * 26.0) / (1.0 + u.x * u.x * 0.9);
    float sy = exp(-abs(u.x) * 26.0) / (1.0 + u.y * u.y * 0.9);
    a += (sx + sy) * 0.45 * vSuper;
  }
  a *= 1.0 - smoothstep(vScale * 0.75, vScale, d);
  a *= smoothstep(inner, 0.93, d);
  a *= 1.0 - 0.6 * vDim;
  a *= gmOverlayLight(vOvKnown, uOverlayMix, vOvCol);
  if (a < 0.004) discard;
  vec3 col = mix(mix(vCol, vOvCol, uOverlayMix), uDustCool, vDim);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * (uDark > 0.5 ? 1.0 : 0.6));
}`;

/** Ground light: each star lights the plane beneath it. */
export const POOL_VERT = STAR_PRELUDE + /* glsl */ `
varying vec2 vQ;
void main() {
  vec3 c; float r;
  if (!gmStar(c, r)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float R = r * (2.0 + 3.0 * vGlow + 3.0 * vSuper);
  vQ = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(c.x + position.x * R, 0.05, c.z + position.y * R, 1.0);
}`;

export const POOL_FRAG = /* glsl */ `
uniform float uDark; uniform float uOverlayMix;
` + STAR_VARYINGS + GLSL_OVERLAY_LIGHT + /* glsl */ `
varying vec2 vQ;
void main() {
  float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
  float w = exp(-d2 * 4.0) * (1.0 - d2) * (1.0 - vDim) * (1.0 - 0.7 * uOverlayMix) * gmOverlayLight(vOvKnown, uOverlayMix, vOvCol);
  vec3 col = mix(vCol, vOvCol, uOverlayMix);
  if (uDark > 0.5) gl_FragColor = vec4(col, w * (0.16 + 0.55 * vGlow));
  else gl_FragColor = vec4(mix(vec3(0.25, 0.27, 0.32), col, 0.35 + 0.65 * vGlow), w * (0.22 + 0.35 * vGlow));
}`;
