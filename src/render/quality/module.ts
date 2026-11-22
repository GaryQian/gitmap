// Adaptive quality (PLAN.md §8.5) and the large-map path (§8.1): a scene module that
//   1. measures the frames drawn for motion and steps quality down before frame rate drops: edge
//      count first (ctx.quality.edgeScale, honoured by the edges), then pixel ratio
//      (ctx.quality.maxPixelRatio, applied by the core); and back up, slowly, when frames allow;
//   2. on a large map (QUALITY_LOCAL.large.units files or more) starts below full quality, and draws
//      each far-away district as one soft aggregate while its stars give way (gmAggregated in
//      core/glsl.ts, to be called by the star shaders). Small and medium maps never aggregate.
// Sphere colour and core light are never reduced; particles, glow and territory resolution are left alone.
//
// STATE (6A was stopped before any of this ran in a browser, and before its unit tests were written):
// both parts are switched off in ./tunables.ts (`adaptive: false`, `large.units: Infinity`), so this
// module currently publishes step 0 and draws nothing. The star shaders do not call gmAggregated yet.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { PatchBatch } from '../../model/types';
import { unitSlotOf } from '../core/anchor';
import { dominantColors } from '../core/dominant';
import { GLSL_AGGREGATE, GLSL_NOISE, GLSL_POSITIONS } from '../core/glsl';
import type { BatchInfo, FrameState, RevealInfo, SceneContext, SceneModule } from '../core/types';
import { aggregateAmount, aggregatesEnabled, districtSums, isCollapsed, starPixels, typicalRadius } from './aggregate';
import { QualityController, pixelRatioLadder } from './controller';
import { QUALITY_LOCAL as Q } from './tunables';

/** What other modules get from `ctx.service<QualityApi>('quality')`. */
export interface QualityApi {
  /** True when the star in this unit slot has given way to its district's aggregate: it is not drawn, so it cannot be picked. */
  collapsed(slot: number): boolean;
  /** The steps taken on each lever (0, 0 = full quality), and whether districts may aggregate on this map. */
  state(): { edgeStep: number; pixelRatioStep: number; pixelRatio: number; aggregates: boolean };
}

/** Floats per unit in ctx.units.info: [radius, district slot, city slot, glow]. */
const INFO = 4;
const A = Q.aggregate;

// One quad per district, flat on the ground, sized to the district's territory.
const AGGREGATE_VERT = GLSL_POSITIONS + GLSL_AGGREGATE + /* glsl */ `
uniform vec3 uDisc;   // radius as a share of the territory radius, height over the ground, reveal 0..1
attribute vec2 aSlots; attribute vec4 aLook; attribute float aGrain;
varying vec2 vQ; varying vec4 vLook; varying float vAmount; varying float vGrain;
void main() {
  vec3 district = gmDistrict(int(aSlots.x + 0.5));
  float amount = gmAggregate(vec3(0.0, aSlots.x, aSlots.y)) * uDisc.z;
  if (amount < 0.004 || district.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 g = gmCity(int(aSlots.y + 0.5)).xy + district.xy;
  float R = district.z * uDisc.x;
  vQ = position.xy; vLook = aLook; vAmount = amount; vGrain = aGrain;
  gl_Position = projectionMatrix * viewMatrix * vec4(g.x + position.x * R, uDisc.y, g.y + position.y * R, 1.0);
}`;

const AGGREGATE_FRAG = /* glsl */ `
uniform float uDark; uniform vec4 uAlpha; uniform vec2 uShape;   // alpha: dark lo, dark hi, light lo, light hi; shape: falloff, grain
varying vec2 vQ; varying vec4 vLook; varying float vAmount; varying float vGrain;
` + GLSL_NOISE + /* glsl */ `
void main() {
  float d2 = dot(vQ, vQ); if (d2 > 1.0) discard;
  // a soft pool, brightest in the middle, gone at the territory's edge
  float body = exp(-d2 * uShape.x) * (1.0 - d2 * d2);
  // fine grain in the district's own frame, so the pool reads as a crowd of stars; it fades out
  // before its cells get smaller than a couple of pixels (no shimmer from afar)
  vec2 q = vQ * vGrain; vec2 cell = floor(q);
  vec2 at = fract(q) - 0.5 - (vec2(h21(cell + 17.0), h21(cell + 31.0)) - 0.5) * 0.6;
  float cellPx = 1.0 / max(length(fwidth(q)), 1e-4);
  float grain = (1.0 - smoothstep(0.0, 0.3, length(at))) * step(0.5, h21(cell)) * smoothstep(2.0, 5.0, cellPx);
  vec2 alpha = uDark > 0.5 ? uAlpha.xy : uAlpha.zw;
  float a = vAmount * body * mix(alpha.x, alpha.y, vLook.a) * (1.0 + uShape.y * grain);
  if (a < 0.003) discard;
  vec3 col = mix(vLook.rgb, vec3(1.0), 0.4 * grain * uDark);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

export function createQuality(): SceneModule {
  let ctx!: SceneContext;
  let controller!: QualityController;
  /** Pixel ratios available on this display, best first. */
  let ladder: number[] = [1];
  let displayRatio = 0;
  /** A test hook: `window.__starmapPinQuality = n` holds quality at full (the controller does not run). */
  const pinned = (globalThis as { __starmapPinQuality?: unknown }).__starmapPinQuality !== undefined;
  let largeStarted = false;

  // ---- aggregates ----
  let mesh: THREE.Mesh | null = null;
  let geometry: THREE.InstancedBufferGeometry | null = null;
  let material: THREE.ShaderMaterial | null = null;
  /** The map is large enough to aggregate at all. */
  let large = false;
  /** Radius of the typical star, world units. */
  let typical = 0;
  /** Eased 0..1: aggregation is suspended while an overlay, the type filter or the size slider is in use. */
  let strength = 0;
  let modelDirty = true;
  let revealAt = Infinity, revealSeconds = 0;
  /** Selected, highlighted and hovered units are always drawn. */
  const kept = new Set<number>();
  let hovered = -1;
  const unsubscribe: (() => void)[] = [];
  const own = {
    uDisc: { value: new THREE.Vector3(A.radius, A.lift, 0) },
    uAlpha: { value: new THREE.Vector4(A.alpha[0], A.alpha[1], A.lightAlpha[0], A.lightAlpha[1]) },
    uShape: { value: new THREE.Vector2(A.falloff, A.grain) },
  };

  const blendingFor = (mode: ThemeMode) => (mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending);

  // ---- adaptive quality ----
  function measureDisplay(): void {
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    if (ratio === displayRatio) return;
    displayRatio = ratio;
    ladder = pixelRatioLadder(ratio, ctx.config.render.maxDpr, Q.pixelRatioShares, ctx.config.render.adaptiveDpr);
    controller.setLadder({ edgeSteps: Q.edgeSteps, pixelRatioSteps: ladder.length - 1 });
    publish();
  }

  /** Tell the core, the edges and RenderApi.stats() where quality stands. */
  function publish(): void {
    ctx.counters.quality = controller.step;
    ctx.quality.edgeScale = Math.pow(Q.edgeStepScale, controller.edgeStep);
    ctx.quality.maxPixelRatio = controller.pixelRatioStep > 0 ? ladder[Math.min(controller.pixelRatioStep, ladder.length - 1)] : Infinity;
    ctx.invalidate();
  }

  // ---- aggregates ----
  function syncKept(): void {
    kept.clear();
    for (const ref of ctx.state.selection) { const s = unitSlotOf(ref, ctx.replica); if (s >= 0) kept.add(s); }
    for (const ref of ctx.state.highlights) { const s = unitSlotOf(ref, ctx.replica); if (s >= 0) kept.add(s); }
  }

  /** One instance per district: where it is (by slot), its colour and brightness, and its grain. */
  function rebuildAggregates(): void {
    modelDirty = false;
    const units = ctx.replica.table('unit'), districts = ctx.replica.table('district');
    large = aggregatesEnabled(units.count, Q.large.units);
    syncKept();
    if (!large) { if (geometry) geometry.instanceCount = 0; return; }
    const info = ctx.units.info, U = Math.min(units.capacity, ctx.units.capacity), D = districts.capacity;
    typical = typicalRadius(info, U, INFO);
    const group = new Int32Array(U);
    for (let u = 0; u < U; u++) group[u] = info[INFO * u] > 0 ? info[INFO * u + 1] : -1;
    const colors = dominantColors(group, D, ctx.units.color);
    const sums = districtSums(D, U, info, units.cols.importancePct, INFO);
    const slots: number[] = [], look: number[] = [], grain: number[] = [];
    for (let d = 0; d < D; d++) {
      if (districts.ids[d] == null || !sums.units[d]) continue;
      slots.push(d, districts.refSlots.city[d] ?? -1);
      look.push(colors[3 * d], colors[3 * d + 1], colors[3 * d + 2], sums.brightness[d]);
      grain.push(0.5 * A.grainPerRootUnit * Math.sqrt(sums.units[d]));
    }
    const old = geometry;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aSlots', new THREE.InstancedBufferAttribute(new Float32Array(slots), 2));
    g.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(look), 4));
    g.setAttribute('aGrain', new THREE.InstancedBufferAttribute(new Float32Array(grain), 1));
    g.instanceCount = grain.length;
    geometry = g;
    if (mesh) mesh.geometry = g;
    old?.dispose();
  }

  function collapsed(slot: number): boolean {
    if (strength <= 0 || slot < 0 || kept.has(slot) || slot === hovered) return false;
    const info = ctx.units.info;
    const d = info[INFO * slot + 1], c = info[INFO * slot + 2];
    const pos = ctx.positions.buffers;
    if (!(d >= 0) || !(c >= 0) || 3 * d + 1 >= pos.district.length || 3 * c + 1 >= pos.city.length) return false;
    const cam = ctx.camera.position;
    const distance = Math.hypot(cam.x - pos.city[3 * c] - pos.district[3 * d], cam.y, cam.z - pos.city[3 * c + 1] - pos.district[3 * d + 1]);
    const amount = aggregateAmount(starPixels(typical, ctx.uniforms.uPixelWorld.value, distance), A.starPx) * strength;
    return isCollapsed(amount, slot, info[INFO * slot + 3] * A.keepGlow);
  }

  // ---- module hooks ----
  function init(context: SceneContext): void {
    ctx = context;
    controller = new QualityController(Q, { edgeSteps: Q.edgeSteps, pixelRatioSteps: 0 }, ctx.config.scheduler.parkWhenFrameMsOver);
    measureDisplay();

    material = new THREE.ShaderMaterial({
      uniforms: { ...ctx.uniforms, ...own }, vertexShader: AGGREGATE_VERT, fragmentShader: AGGREGATE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: blendingFor(ctx.theme),
    });
    mesh = new THREE.Mesh(undefined, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 0.5; // over the stars' ground light, under their glows
    mesh.visible = false;
    ctx.scene.add(mesh);
    ctx.uniforms.uAggregateKeep.value = A.keepGlow;

    unsubscribe.push(
      ctx.bus.on('selection', syncKept),
      ctx.bus.on('highlights', syncKept),
      ctx.bus.on('hover', (h) => { hovered = h.slot; }),
    );
    const api: QualityApi = {
      collapsed,
      state: () => ({
        edgeStep: controller.edgeStep, pixelRatioStep: controller.pixelRatioStep,
        pixelRatio: ctx.uniforms.uPixelRatio.value, aggregates: large,
      }),
    };
    ctx.provide('quality', api);
    if (ctx.state.revealed) revealAt = -1e6;
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    // a large map starts below full quality, so its first frames are usable (it steps up when frames allow)
    if (Q.adaptive && !largeStarted && !pinned && ctx.replica.table('unit').count >= Q.large.units) {
      largeStarted = true;
      controller.startAt(Q.large.startEdgeStep, Q.large.startPixelRatioStep);
      publish();
    }
    if (info.rebuild) { modelDirty = true; return; }
    for (const op of batch.ops) {
      if (op.op === 'assign' || ((op.op === 'add' || op.op === 'update' || op.op === 'remove') && (op.kind === 'unit' || op.kind === 'district'))) {
        modelDirty = true;
        return;
      }
    }
  }

  function reveal(info: RevealInfo): void {
    revealAt = info.instant ? -1e6 : info.at;
    revealSeconds = info.durationMs / 1000;
  }

  function resize(): void {
    // a resize (ours, when the pixel ratio steps, or the window's) upsets frame pacing for a moment
    controller.disturb(performance.now());
  }

  function frame(f: FrameState): void {
    measureDisplay();
    if (Q.adaptive && !pinned && controller.frame(f)) publish();

    if (modelDirty) rebuildAggregates();
    // aggregates stand in for stars in their own colours only: with an overlay, the type filter or the
    // size slider in use, every star is drawn as on a smaller map
    const plain = !ctx.state.overlay && !ctx.state.typeFilter.length && !(ctx.state.minBytes > 0);
    const target = large && plain ? 1 : 0;
    if (strength !== target) {
      const step = ctx.reducedMotion ? 1 : f.dt / 0.3;
      strength = target > strength ? Math.min(target, strength + step) : Math.max(target, strength - step);
      ctx.invalidate();
    }
    const u = ctx.uniforms.uAggregate.value;
    if (strength > 0 && typical > 0) u.set(strength, typical / Math.max(ctx.uniforms.uPixelWorld.value, 1e-12), A.starPx[0], A.starPx[1]);
    else u.set(0, 0, 0, 0);

    const shown = ctx.state.revealed && f.time >= revealAt && strength > 0;
    const grown = revealSeconds > 0 ? Math.min(1, Math.max(0, (f.time - revealAt) / revealSeconds)) : 1;
    if (own.uDisc.value.z !== grown) { own.uDisc.value.z = grown; ctx.invalidate(); }
    if (mesh) mesh.visible = shown && !!geometry && geometry.instanceCount > 0;
  }

  function setTheme(mode: ThemeMode): void {
    if (material) material.blending = blendingFor(mode);
  }

  function dispose(): void {
    for (const off of unsubscribe) off();
    unsubscribe.length = 0;
    if (mesh) ctx.scene.remove(mesh);
    geometry?.dispose();
    material?.dispose();
    mesh = null; geometry = null; material = null;
    kept.clear();
    ctx.uniforms.uAggregate.value.set(0, 0, 0, 0);
    ctx.counters.quality = 0;
    ctx.quality.edgeScale = 1;
    ctx.quality.maxPixelRatio = Infinity;
  }

  // before the spheres (10) and the edges (20), so a step taken this frame is drawn this frame
  return { name: 'quality', order: 5, init, applyBatch, reveal, resize, frame, setTheme, dispose };
}

export default createQuality;
