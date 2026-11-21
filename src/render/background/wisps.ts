// The procedural dust-wisp background (PLAN.md §17.4), ported from spikes/render/main.ts:
// domain-warped noise in two layers, cool dust and a sparser warm layer, at low contrast, with a
// sparse field of fixed star points in dark mode. One shader for the scene and for the standalone
// canvas on the landing page and waiting screen. Neutral gray with cool and warm dust: no violet.
import * as THREE from 'three';
import type { Config, ThemeMode } from '../../config';
import { hexToRgb } from '../../shared';
import { GLSL_NOISE } from '../core/glsl';
import { RENDER_LOCAL } from '../core/tunables';

const GLSL_STARS = /* glsl */ `
// A hash that stays random on integer cells (h21 repeats every 50 cells there, which shows as a lattice).
float starHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// sparse fixed points on a grid of cells a few pixels wide, each softened to a round dot
float wispStars(vec2 frag, float cell) {
  vec2 q = frag / cell; vec2 g = floor(q);
  float on = step(0.9985, starHash(g)) * (0.4 + 0.6 * starHash(g + 5.0));
  return on * smoothstep(0.75, 0.2, length(fract(q) - 0.5));
}
float wispVignette(vec2 uv, float dark) { vec2 c = uv - 0.5; return 1.0 - dot(c, c) * (dark > 0.5 ? 0.40 : 0.12); }
`;

export const FULLSCREEN_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const WISP_FRAG = /* glsl */ `
uniform float uDrift; uniform float uDark; uniform vec2 uRes; uniform vec2 uPar;
uniform vec3 uVoid; uniform vec3 uDustCool; uniform vec3 uDustWarm;
uniform float uContrast; uniform float uStarAmount; uniform float uStarCell;
` + GLSL_NOISE + GLSL_STARS + /* glsl */ `
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  vec2 p = uv * 1.6 + uPar + vec2(uDrift, 0.0);
  vec2 w = vec2(fbm(p + 3.1), fbm(p + vec2(7.7, 1.3)));
  float cool = smoothstep(0.35, 0.80, fbm(p + 1.8 * w));
  float warm = smoothstep(0.50, 0.85, fbm(p * 0.7 + 2.2 * w.yx + 11.0));
  vec3 col = mix(uVoid, uDustCool, min(1.0, cool * 1.52 * uContrast));
  col = mix(col, uDustWarm, min(1.0, warm * 0.88 * uContrast));
  col += vec3(0.75) * wispStars(gl_FragCoord.xy, uStarCell) * uStarAmount;
  col *= wispVignette(gl_FragCoord.xy / uRes, uDark);
  col += (starHash(gl_FragCoord.xy) - 0.5) / 255.0;   // dither: no banding in the dark gradient
  gl_FragColor = vec4(col, 1.0);
}`;

/** Upscales the low-resolution wisp pass and adds full-resolution star points. */
export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uWisps; uniform vec2 uViewport; uniform float uDark; uniform float uStarAmount; uniform float uStarCell;
` + GLSL_NOISE + GLSL_STARS + /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uViewport;
  vec3 col = texture2D(uWisps, uv).rgb;
  col += vec3(0.75) * wispStars(gl_FragCoord.xy, uStarCell) * uStarAmount * wispVignette(uv, uDark);
  col += (starHash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export interface WispUniforms {
  [name: string]: THREE.IUniform;
  uDrift: { value: number };
  uDark: { value: number };
  uRes: { value: THREE.Vector2 };
  uPar: { value: THREE.Vector2 };
  uVoid: { value: THREE.Vector3 };
  uDustCool: { value: THREE.Vector3 };
  uDustWarm: { value: THREE.Vector3 };
  uContrast: { value: number };
  uStarAmount: { value: number };
  uStarCell: { value: number };
}

/** Uniforms for WISP_FRAG. Pass shared theme uniforms to reuse them; otherwise call setWispTheme. */
export function createWispUniforms(wisps: Config['theme']['wisps'], shared?: Pick<WispUniforms, 'uDark' | 'uVoid' | 'uDustCool' | 'uDustWarm'>): WispUniforms {
  return {
    uDrift: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uPar: { value: new THREE.Vector2() },
    uDark: shared?.uDark ?? { value: 1 }, uVoid: shared?.uVoid ?? { value: new THREE.Vector3() },
    uDustCool: shared?.uDustCool ?? { value: new THREE.Vector3() }, uDustWarm: shared?.uDustWarm ?? { value: new THREE.Vector3() },
    uContrast: { value: wisps.contrast }, uStarAmount: { value: 0 }, uStarCell: { value: 3 },
  };
}

export function setWispTheme(u: WispUniforms, theme: Config['theme'], mode: ThemeMode): void {
  const t = theme[mode];
  u.uDark.value = mode === 'dark' ? 1 : 0;
  u.uVoid.value.set(...hexToRgb(t.void));
  u.uDustCool.value.set(...hexToRgb(t.dustCool));
  u.uDustWarm.value.set(...hexToRgb(t.dustWarm));
}

/** Wisp contrast for an emphasis of 0..1 (landing-page drag-over feedback). */
export function wispContrast(wisps: Config['theme']['wisps'], emphasis: number): number {
  return wisps.contrast * (1 + RENDER_LOCAL.background.emphasisGain * Math.min(1, Math.max(0, emphasis)));
}

/** How far the wisps have drifted after `seconds` (the spike drifted 0.004 units/s at driftSpeed 0.02). */
export function wispDrift(wisps: Config['theme']['wisps'], seconds: number): number {
  return seconds * wisps.driftSpeed * 0.2;
}

/** One triangle that covers the viewport. */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}
