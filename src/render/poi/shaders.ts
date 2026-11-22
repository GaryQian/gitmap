// The beam of a point of interest (PLAN.md §8.4): a soft column of warm light rising from its parent
// star. One instanced quad per beam, upright in the world and turned about its own axis to face the
// camera. Everything is a function of time and the instance row; nothing is animated on the CPU.
import { GLSL_NOISE, GLSL_POSITIONS } from '../core/glsl';

const BEAM_VARYINGS = /* glsl */ `
varying vec2 vUv;       // x: −1..1 across the column, y: 0 at the foot, 1 at the top
varying float vSeed;
varying float vFade;    // brightness kept after the distance fade and the rise
varying float vSlender; // height over half-width, so the shimmer keeps its grain at every zoom
`;

/**
 * Per instance:
 *   aBeam  = unit slot of the parent star, seed 0..1                     (model)
 *   aBirth = scene time (s) at which the beam starts to rise           (view)
 */
export const BEAM_VERT = GLSL_POSITIONS + /* glsl */ `
uniform float uTime; uniform float uPixelWorld;
uniform float uRise;
uniform vec4 uBeamHeight;   // share of the view depth, min world, max world, min star radii
uniform vec4 uBeamWidth;    // half-width per star radius, min world, min device px, max device px
uniform float uFarFloor;
attribute vec2 aBeam; attribute float aBirth;
` + BEAM_VARYINGS + /* glsl */ `
void main() {
  float age = (uTime - aBirth) / max(uRise, 1e-3);
  // the star's centre through the unit lookup, so the beam follows it wherever physics puts it
  vec4 info;
  vec3 base = gmUnitCenter(int(aBeam.x + 0.5), info);
  float r = info.x;
  // nothing for an empty slot, or a unit that has no district (no place on the map) yet
  bool ok = age > 0.0 && aBeam.x >= 0.0 && r > 0.0 && info.y >= 0.0 && info.z >= 0.0;
  if (!ok) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float k = clamp(age, 0.0, 1.0);
  float rise = 1.0 - (1.0 - k) * (1.0 - k) * (1.0 - k);

  float depth = max(-(viewMatrix * vec4(base, 1.0)).z, 1e-3);
  float px = uPixelWorld * depth;                       // world units per device pixel at the foot
  float want = max(uBeamWidth.y, r * uBeamWidth.x);
  float half_ = clamp(want, uBeamWidth.z * px, uBeamWidth.w * px);
  // A far beam keeps a line's width and gives up brightness instead: thin, never a wall.
  vFade = mix(uFarFloor, 1.0, clamp(want / half_, 0.0, 1.0)) * k;
  float height = max(clamp(depth * uBeamHeight.x, uBeamHeight.y, uBeamHeight.z), r * uBeamHeight.w);

  vec2 toCam = cameraPosition.xz - base.xz;
  float len = length(toCam);
  vec2 side = len > 1e-4 ? vec2(toCam.y, -toCam.x) / len : vec2(1.0, 0.0);
  vec3 world = base + vec3(side.x, 0.0, side.y) * (position.x * half_) + vec3(0.0, position.y * height * rise, 0.0);

  vec4 mv = viewMatrix * vec4(world, 1.0);
  // Slide back along the view ray by the star's radius: the same pixel, a little deeper, so the
  // star's own disc covers the foot and the column rises from behind it.
  mv.xyz *= 1.0 + (r * 1.1) / max(length(mv.xyz), 1e-3);
  gl_Position = projectionMatrix * mv;

  vUv = position.xy;
  vSeed = aBeam.y;
  vSlender = height / max(half_, 1e-3);
}`;

export const BEAM_FRAG = /* glsl */ `
uniform float uTime; uniform float uDark; uniform vec3 uWarm;
uniform float uShimmer; uniform vec2 uGain;   // dark, light
` + BEAM_VARYINGS + GLSL_NOISE + /* glsl */ `
void main() {
  float x2 = vUv.x * vUv.x, v = vUv.y;
  // across: a thin hot filament inside a wide soft sleeve that reaches zero at the quad's edge
  float edge = (1.0 - x2) * (1.0 - x2);
  float core = exp(-x2 * 16.0);
  float sleeve = exp(-x2 * 4.0) * edge;
  // along: brightest at the foot, a long fade upward, nothing left at the top
  float top = 1.0 - v;
  float along = (0.42 + 0.58 * exp(-v * 2.6)) * top * sqrt(sqrt(top));

  // Shimmer: slow soft packets of brightness climbing the column, over a finer grain that drifts
  // up with them. uShimmer is 0 under reduced motion, which leaves a still column.
  float t = uTime * uShimmer;
  float phase = vSeed * 6.2831853;
  float packets = 0.5 + 0.5 * sin(6.2831853 * (v * 1.6 - t) + phase);
  packets *= packets;
  float grain = vnoise(vec2(vUv.x * 1.3 + vSeed * 31.0, (v - t * 1.7) * vSlender * 0.22));
  float shimmer = 0.74 + 0.34 * packets + 0.26 * (grain - 0.5);

  float light = (core * edge + sleeve * 0.50) * along * shimmer * vFade;
  if (light < 0.003) discard;

  if (uDark > 0.5) {
    // emitted light: additive, and the filament burns out toward white where it is hottest
    float burn = 1.0 - exp(-core * along * 1.6);
    vec3 col = mix(uWarm, vec3(1.0, 0.97, 0.90), burn * 0.55);
    gl_FragColor = vec4(col, clamp(light * uGain.x, 0.0, 1.0));
  } else {
    // Additive light is invisible on a pale background: a saturated tint, alpha blended, that
    // deepens toward the filament instead of brightening.
    vec3 deep = uWarm * vec3(0.96, 0.80, 0.52);
    vec3 col = mix(uWarm, deep, clamp(core * along * 1.4, 0.0, 1.0));
    gl_FragColor = vec4(col, clamp(light * uGain.y, 0.0, 0.92));
  }
}`;
