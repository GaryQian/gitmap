// Points of interest: one beam of warm light per `poi` annotation, standing on its parent
// (PLAN.md §8.4, §11.3). Model-derived rows (aBeam) are written only by applyBatch, from the
// replica; when each beam rose (aBirth) is view state, kept by the point of interest's id.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { PatchBatch } from '../../model/types';
import type { BatchInfo, RevealInfo, SceneContext, SceneModule } from '../core/types';
import { BEAM_ITEMS, resolveBeams, touchesBeams, writeBeams, type Beam } from './beams';
import { BEAM_FRAG, BEAM_VERT } from './shaders';
import { POI_LOCAL as P } from './tunables';

/** Birth times that mean "not risen yet" and "standing since long ago". */
const HIDDEN = 1e9, SHOWN = -1e6;

export function createPoiBeams(): SceneModule {
  let ctx!: SceneContext;
  let geometry: THREE.InstancedBufferGeometry | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let mesh: THREE.Mesh | null = null;
  let beamAttr!: THREE.InstancedBufferAttribute;
  let birthAttr!: THREE.InstancedBufferAttribute;
  let capacity = 0;
  let beams: Beam[] = [];
  /** When each beam started to rise, by point-of-interest id, so a re-projection never restarts one. */
  let births = new Map<string, number>();

  const blendingFor = (mode: ThemeMode) => (mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending);

  function allocate(count: number): void {
    capacity = Math.max(P.initialCapacity, capacity);
    while (capacity < count) capacity *= 2;
    const old = geometry;
    const g = new THREE.InstancedBufferGeometry();
    // x: −1..1 across, y: 0..1 up the column
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    beamAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * BEAM_ITEMS), BEAM_ITEMS);
    birthAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(HIDDEN), 1);
    beamAttr.setUsage(THREE.DynamicDrawUsage);
    birthAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aBeam', beamAttr);
    g.setAttribute('aBirth', birthAttr);
    g.instanceCount = 0;
    geometry = g;
    if (mesh) mesh.geometry = g;
    old?.dispose();
  }

  /** Upload the current beams and their birth times. */
  function upload(): void {
    writeBeams(beams, beamAttr.array as Float32Array);
    const birth = birthAttr.array as Float32Array;
    beams.forEach((b, i) => { birth[i] = births.get(b.id) ?? HIDDEN; });
    beamAttr.needsUpdate = birthAttr.needsUpdate = true;
    geometry!.instanceCount = beams.length;
    ctx.invalidate();
  }

  /** Re-derive the beams from the replica. A beam that was already standing keeps its birth time. */
  function project(): void {
    beams = resolveBeams(ctx.replica);
    if (beams.length > capacity) allocate(beams.length);
    const now = ctx.now();
    const next = new Map<string, number>();
    let rising = false;
    for (const b of beams) {
      let birth = births.get(b.id);
      if (birth === undefined) {
        // before the reveal nothing stands; after it a new beam rises (at once under reduced motion)
        birth = !ctx.state.revealed ? HIDDEN : ctx.reducedMotion ? SHOWN : now;
        rising ||= birth === now;
      }
      next.set(b.id, birth);
    }
    births = next;
    upload();
    if (rising) ctx.animate(P.riseSeconds * 1000 + 100);
  }

  function init(context: SceneContext): void {
    ctx = context;
    const own = {
      uRise: { value: P.riseSeconds },
      uBeamHeight: { value: new THREE.Vector4(P.height.perDepth, P.height.min, P.height.max, P.height.minRadii) },
      uBeamWidth: { value: new THREE.Vector4(P.halfWidth.perRadius, P.halfWidth.minWorld, P.halfWidth.minPx, P.halfWidth.maxPx) },
      uFarFloor: { value: P.farFloor },
      uShimmer: { value: ctx.reducedMotion ? 0 : P.shimmerSpeed },
      uGain: { value: new THREE.Vector2(P.gainDark, P.gainLight) },
    };
    material = new THREE.ShaderMaterial({
      uniforms: { ...ctx.uniforms, ...own }, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: blendingFor(ctx.theme),
    });
    mesh = new THREE.Mesh(undefined, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = P.renderOrder;
    mesh.visible = ctx.state.revealed;
    allocate(0);
    ctx.scene.add(mesh);
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    if (info.rebuild || touchesBeams(batch)) project();
  }

  function reveal(info: RevealInfo): void {
    if (mesh) mesh.visible = true;
    // the beams rise as the map finishes growing in, a moment apart
    for (const b of beams) {
      births.set(b.id, info.instant ? SHOWN : info.at + (info.durationMs / 1000) * P.revealAfter + b.seed * P.revealSpread);
    }
    upload();
    if (!info.instant) ctx.animate(info.durationMs * P.revealAfter + (P.revealSpread + P.riseSeconds) * 1000 + 100);
  }

  function setTheme(mode: ThemeMode): void {
    // the same shader in both modes; emitted light is additive only on the dark background
    if (material) material.blending = blendingFor(mode);
  }

  function dispose(): void {
    if (mesh) ctx.scene.remove(mesh);
    geometry?.dispose();
    material?.dispose();
    mesh = null; geometry = null; material = null;
    beams = [];
    births.clear();
  }

  return { name: 'poi', order: 20, init, applyBatch, reveal, setTheme, dispose };
}

export default createPoiBeams;
