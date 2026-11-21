// Spheres: one instance per unit slot, three draws over the same instances (PLAN.md §8.1, §8.6).
// Model-derived buffers (aSlot, aShape, aColor) are written only by applyBatch, through
// projectUnits. View state (selection, hover, birth time, overlay value, jiggle offset) lives in
// separate buffers and refers to the model by permanent id.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { OverlayView } from '../../contracts/render';
import type { NodeRef, PatchBatch } from '../../model/types';
import { hexToRgb } from '../../shared';
import { unitSlotOf } from '../core/anchor';
import { RENDER_LOCAL } from '../core/tunables';
import type { BatchInfo, FrameState, RevealInfo, SceneContext, SceneModule } from '../core/types';
import {
  COLOR_ITEMS, LangTable, SHAPE_ITEMS, SLOT_ITEMS, createInstanceBuffers, projectUnits, visibleCounts,
  type InstanceBuffers,
} from './instances';
import { OVERLAY_UNKNOWN, RAMP_WIDTH, buildRamp, overlayT } from './overlay';
import { BODY_FRAG, GLOW_FRAG, POOL_FRAG, POOL_VERT, STAR_VERT } from './shaders';

/** What other modules get from `ctx.service<SpheresApi>('spheres')`. */
export interface SpheresApi {
  /** Units not hidden by the size slider, per city ref. */
  visibleCounts(): Map<NodeRef, { visible: number; total: number }>;
  /** Mark one unit slot as hovered (slightly larger, glowing); −1 clears it. */
  setHover(slot: number): void;
  /** Display-only offset of a sphere in world units (jiggle, PLAN.md §7.4). Layout is untouched. */
  setNudge(slot: number, x: number, y: number, z: number): void;
  /** True when the unit in this slot is currently drawn (alive, revealed, not hidden by the slider). */
  isShown(slot: number): boolean;
}

const STATE_ITEMS = 3; // flags, birth time, overlay t
const NUDGE_ITEMS = 3;
const FLAG_SELECTED = 1, FLAG_HIGHLIGHTED = 2, FLAG_HOVERED = 4;
/** Birth times that mean "not shown yet" and "shown since long ago". */
const HIDDEN = 1e9, SHOWN = -1e6;
const S = RENDER_LOCAL.spheres;

/** An instanced attribute that uploads only the span of slots written since the last frame. */
class Tracked {
  private min = Infinity;
  private max = -1;
  constructor(readonly attr: THREE.InstancedBufferAttribute) { attr.setUsage(THREE.DynamicDrawUsage); }
  touch(slot: number): void { if (slot < this.min) this.min = slot; if (slot > this.max) this.max = slot; }
  touchAll(): void { this.min = 0; this.max = this.attr.count - 1; }
  flush(): void {
    if (this.max < 0) return;
    const n = this.attr.itemSize;
    this.attr.clearUpdateRanges();
    this.attr.addUpdateRange(this.min * n, (this.max - this.min + 1) * n);
    this.attr.needsUpdate = true;
    this.min = Infinity; this.max = -1;
  }
}

function slotHash(slot: number): number {
  return (Math.imul(slot + 1, 0x9e3779b1) >>> 0) / 4294967296;
}

export function createSpheres(): SceneModule {
  let ctx!: SceneContext;
  let buffers!: InstanceBuffers;
  /** View state per slot. */
  let stateData!: Float32Array;
  let nudgeData!: Float32Array;
  /** 1 while the slot held a unit after the last projection: tells an add from an update. */
  let live!: Uint8Array;
  let geometry: THREE.InstancedBufferGeometry | null = null;
  let tracked: { slot: Tracked; shape: Tracked; color: Tracked; state: Tracked; nudge: Tracked } | null = null;
  let langs!: LangTable;
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.ShaderMaterial[] = [];
  const textures: THREE.DataTexture[] = [];
  const unsubscribe: (() => void)[] = [];
  /** Slots waiting for physics to apply the revision that added them. `grow`: animate in when shown. */
  const pending = new Map<number, { rev: number; grow: boolean }>();
  const flagged = new Set<number>();
  let hovered = -1;
  let overlayTarget = 0;
  let langDimData!: Uint8Array;
  let rampData!: Uint8Array;
  let langDimTex!: THREE.DataTexture;
  let rampTex!: THREE.DataTexture;
  let knownLangs = 0;
  let counts: { rev: number; minLines: number; map: Map<NodeRef, { visible: number; total: number }> } | null = null;

  const own = {
    uGrow: { value: 1 }, uMinLines: { value: 0 }, uSelScale: { value: 1 }, uBreathe: { value: 1.5 }, uSpikesFrom: { value: 0.75 },
    uOverlayMix: { value: 0 }, uUnknown: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uMinPx: { value: S.minPixelRadius },
    uEmphasis: { value: new THREE.Vector4(S.breatheScale, S.hoverScale, S.selectedGlow, S.highlightGlow) }, uHoverGlow: { value: S.hoverGlow },
    uLangDim: { value: null as THREE.DataTexture | null }, uRamp: { value: null as THREE.DataTexture | null },
    uCoreGain: { value: new THREE.Vector2() }, uCoreTight: { value: new THREE.Vector2() }, uLimb: { value: 0.62 }, uFlicker: { value: 0.07 },
    uGlowFalloff: { value: new THREE.Vector2() },
  };

  // ---- geometry ----
  function buildGeometry(): void {
    const old = geometry;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    tracked = {
      slot: new Tracked(new THREE.InstancedBufferAttribute(buffers.slot, SLOT_ITEMS)),
      shape: new Tracked(new THREE.InstancedBufferAttribute(buffers.shape, SHAPE_ITEMS)),
      color: new Tracked(new THREE.InstancedBufferAttribute(buffers.color, COLOR_ITEMS, true)),
      state: new Tracked(new THREE.InstancedBufferAttribute(stateData, STATE_ITEMS)),
      nudge: new Tracked(new THREE.InstancedBufferAttribute(nudgeData, NUDGE_ITEMS)),
    };
    g.setAttribute('aSlot', tracked.slot.attr);
    g.setAttribute('aShape', tracked.shape.attr);
    g.setAttribute('aColor', tracked.color.attr);
    g.setAttribute('aState', tracked.state.attr);
    g.setAttribute('aNudge', tracked.nudge.attr);
    g.instanceCount = 0;
    geometry = g;
    for (const m of meshes) m.geometry = g;
    old?.dispose();
  }

  function allocateViewState(capacity: number): void {
    const state = new Float32Array(capacity * STATE_ITEMS), nudge = new Float32Array(capacity * NUDGE_ITEMS), alive = new Uint8Array(capacity);
    for (let s = 0; s < capacity; s++) { state[s * STATE_ITEMS + 1] = HIDDEN; state[s * STATE_ITEMS + 2] = OVERLAY_UNKNOWN; }
    if (stateData) { state.set(stateData); nudge.set(nudgeData); alive.set(live); }
    stateData = state; nudgeData = nudge; live = alive;
  }

  // ---- view state ----
  const setBirth = (slot: number, t: number) => { stateData[slot * STATE_ITEMS + 1] = t; tracked!.state.touch(slot); };

  /** Re-derive the selection, highlight and hover flags from refs (slots may have changed). */
  function syncFlags(): void {
    for (const s of flagged) if (s < buffers.capacity) { stateData[s * STATE_ITEMS] = 0; tracked!.state.touch(s); }
    flagged.clear();
    const mark = (slot: number, flag: number) => {
      if (slot < 0 || slot >= buffers.capacity || !live[slot]) return;
      stateData[slot * STATE_ITEMS] |= flag;
      flagged.add(slot);
      tracked!.state.touch(slot);
    };
    for (const ref of ctx.state.selection) mark(unitSlotOf(ref, ctx.replica), FLAG_SELECTED);
    for (const ref of ctx.state.highlights) mark(unitSlotOf(ref, ctx.replica), FLAG_HIGHLIGHTED);
    mark(hovered, FLAG_HOVERED);
    ctx.invalidate();
  }

  function syncLangDim(): void {
    const filter = ctx.state.typeFilter;
    langDimData.fill(0);
    if (filter.length) {
      const show = new Set(filter);
      langs.langs.forEach((lang, i) => { if (!show.has(lang)) langDimData[4 * i] = 255; });
    }
    knownLangs = langs.langs.length;
    langDimTex.needsUpdate = true;
    ctx.invalidate();
  }

  function writeOverlay(view: OverlayView | null, slots: number[] | null): void {
    const write = (s: number) => {
      stateData[s * STATE_ITEMS + 2] = view && live[s] ? overlayT(s < view.values.length ? view.values[s] : undefined, view.domain) : OVERLAY_UNKNOWN;
      tracked!.state.touch(s);
    };
    if (slots) for (const s of slots) write(s);
    else for (let s = 0; s < buffers.capacity; s++) write(s);
  }

  function setOverlay(view: OverlayView | null): void {
    overlayTarget = view ? 1 : 0;
    if (view) {
      // values and ramp are replaced; on `null` the old ones stay while the overlay fades out
      rampData.set(buildRamp(view.stops, view.discrete, RAMP_WIDTH));
      rampTex.needsUpdate = true;
      own.uUnknown.value.set(...hexToRgb(view.unknown));
      writeOverlay(view, null);
    }
    if (ctx.reducedMotion) own.uOverlayMix.value = overlayTarget;
    ctx.animate(S.overlayFadeMs + 100);
  }

  /** Show slots whose revision physics has now applied (PLAN.md §5.1: positions are not patches). */
  function resolvePending(): void {
    if (!pending.size) return;
    const physRev = ctx.positions.rev();
    const now = ctx.now();
    let shown = false;
    for (const [slot, p] of pending) {
      if (p.rev > physRev) continue;
      pending.delete(slot);
      if (ctx.state.revealed && live[slot]) { setBirth(slot, p.grow && !ctx.reducedMotion ? now : SHOWN); shown = true; }
    }
    if (shown) ctx.animate(own.uGrow.value * 1000 + 100);
  }

  // ---- module hooks ----
  function init(context: SceneContext): void {
    ctx = context;
    const { config } = ctx;
    const star = config.visual.star;
    langs = new LangTable(config.visual);
    buffers = createInstanceBuffers(Math.max(S.initialCapacity, ctx.replica.table('unit').capacity));
    allocateViewState(buffers.capacity);

    own.uGrow.value = Math.max(0.001, (config.reveal.growMs * RENDER_LOCAL.reveal.grow) / 1000);
    own.uMinLines.value = ctx.state.minLines;
    own.uSelScale.value = config.visual.selectedScale;
    own.uBreathe.value = Math.max(0.05, star.breatheMs / 1000);
    // spikes start at an importance percentile; the instance carries glow (0 at glowFromPct, 1 at the top)
    own.uSpikesFrom.value = Math.min(0.999, Math.max(0, (star.spikesFromPct - config.visual.glowFromPct) / Math.max(1e-6, 1 - config.visual.glowFromPct)));
    own.uCoreGain.value.set(star.coreGain[0], star.coreGain[1]);
    own.uCoreTight.value.set(star.coreTightness[0], star.coreTightness[1]);
    own.uLimb.value = star.limbDarkening;
    own.uFlicker.value = ctx.reducedMotion ? 0 : star.flicker;
    own.uGlowFalloff.value.set(star.glowFalloff[0], star.glowFalloff[1]);

    const lookup = (data: Uint8Array) => {
      const t = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      textures.push(t);
      return t;
    };
    langDimData = new Uint8Array(RAMP_WIDTH * 4);
    rampData = new Uint8Array(RAMP_WIDTH * 4);
    own.uLangDim.value = langDimTex = lookup(langDimData);
    own.uRamp.value = rampTex = lookup(rampData);

    const uniforms = { ...ctx.uniforms, ...own };
    const dark = ctx.theme === 'dark';
    const body = new THREE.ShaderMaterial({ uniforms, vertexShader: STAR_VERT, fragmentShader: BODY_FRAG, transparent: false, depthWrite: true, depthTest: true });
    const glow = new THREE.ShaderMaterial({
      uniforms, defines: { CORONA: 1 }, vertexShader: STAR_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const pool = new THREE.ShaderMaterial({
      uniforms, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    materials.push(body, glow, pool);
    // draw order: ground light, bodies, glows (three.js draws opaque objects before transparent ones)
    for (const [material, order] of [[pool, 0], [body, 1], [glow, 1.5]] as const) {
      const mesh = new THREE.Mesh(undefined, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      mesh.visible = ctx.state.revealed;
      meshes.push(mesh);
      ctx.scene.add(mesh);
    }
    buildGeometry();

    unsubscribe.push(
      ctx.bus.on('selection', syncFlags),
      ctx.bus.on('highlights', syncFlags),
      ctx.bus.on('typeFilter', syncLangDim),
      ctx.bus.on('minLines', (n) => { own.uMinLines.value = n; }),
      ctx.bus.on('overlay', setOverlay),
    );

    const api: SpheresApi = {
      visibleCounts() {
        const rev = ctx.replica.rev, minLines = ctx.state.minLines;
        if (!counts || counts.rev !== rev || counts.minLines !== minLines) counts = { rev, minLines, map: visibleCounts(ctx.replica, minLines, config.visual) };
        return counts.map;
      },
      setHover(slot) {
        if (slot === hovered) return;
        hovered = slot;
        syncFlags();
      },
      setNudge(slot, x, y, z) {
        if (slot < 0 || slot >= buffers.capacity) return;
        const i = slot * NUDGE_ITEMS;
        nudgeData[i] = x; nudgeData[i + 1] = y; nudgeData[i + 2] = z;
        tracked!.nudge.touch(slot);
        ctx.invalidate();
      },
      isShown(slot) {
        if (slot < 0 || slot >= buffers.capacity || !live[slot] || !ctx.state.revealed) return false;
        if (stateData[slot * STATE_ITEMS + 1] > ctx.now()) return false;
        const h = slot * SHAPE_ITEMS;
        const selected = (stateData[slot * STATE_ITEMS] & FLAG_SELECTED) !== 0;
        return selected || !(buffers.shape[h + 2] < ctx.state.minLines && buffers.shape[h + 1] <= 0);
      },
    };
    ctx.provide('spheres', api);
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    const result = projectUnits(buffers, batch, info.rebuild, ctx.replica, ctx.config.visual, langs);
    if (result.buffers !== buffers) {
      buffers = result.buffers;
      allocateViewState(buffers.capacity);
      buildGeometry();
    }
    const t = tracked!;
    const physRev = ctx.positions.rev();
    const settled = physRev >= batch.rev;
    const overlay = ctx.state.overlay;

    if (result.touched === null) {
      // everything was rebuilt: no grow-in, the map simply is what the model says
      pending.clear();
      for (let s = 0; s < buffers.capacity; s++) {
        const alive = buffers.shape[s * SHAPE_ITEMS + 3] > 0;
        live[s] = alive ? 1 : 0;
        stateData[s * STATE_ITEMS] = 0;
        stateData[s * STATE_ITEMS + 1] = alive && settled && ctx.state.revealed ? SHOWN : HIDDEN;
        if (alive && !settled) pending.set(s, { rev: batch.rev, grow: false });
        if (!alive) nudgeData.fill(0, s * NUDGE_ITEMS, (s + 1) * NUDGE_ITEMS);
      }
      writeOverlay(overlay, null);
      t.slot.touchAll(); t.shape.touchAll(); t.color.touchAll(); t.state.touchAll(); t.nudge.touchAll();
    } else {
      const now = ctx.now();
      for (const s of result.touched) {
        const alive = buffers.shape[s * SHAPE_ITEMS + 3] > 0;
        t.slot.touch(s); t.shape.touch(s); t.color.touch(s);
        if (alive && !live[s]) {
          // a unit added after the reveal stays hidden until physics has placed it
          live[s] = 1;
          if (!settled) pending.set(s, { rev: batch.rev, grow: true });
          setBirth(s, settled && ctx.state.revealed ? (ctx.reducedMotion ? SHOWN : now) : HIDDEN);
          writeOverlay(overlay, [s]);
        } else if (!alive && live[s]) {
          live[s] = 0;
          pending.delete(s);
          stateData[s * STATE_ITEMS] = 0;
          stateData[s * STATE_ITEMS + 2] = OVERLAY_UNKNOWN;
          setBirth(s, HIDDEN);
          nudgeData.fill(0, s * NUDGE_ITEMS, (s + 1) * NUDGE_ITEMS);
          t.nudge.touch(s);
        }
      }
      if (result.touched.length) ctx.animate(own.uGrow.value * 1000 + 100);
    }
    geometry!.instanceCount = Math.min(buffers.capacity, ctx.replica.table('unit').capacity);
    counts = null;
    syncFlags();
    if (langs.langs.length !== knownLangs) syncLangDim();
  }

  function reveal(info: RevealInfo): void {
    for (const m of meshes) m.visible = true;
    resolvePending();
    const stagger = new Map<number, number>();
    if (!info.instant) {
      // city by city, from the middle of the map outward
      const cities = ctx.replica.table('city').slots();
      const pos = ctx.positions.buffers.city, b = ctx.rig.bounds;
      const far = (c: number) => (3 * c + 1 < pos.length ? Math.hypot(pos[3 * c] - b.x, pos[3 * c + 1] - b.z) : 0);
      cities.sort((a, c) => far(a) - far(c) || a - c);
      cities.forEach((c, i) => stagger.set(c, (i / Math.max(1, cities.length - 1)) * RENDER_LOCAL.reveal.cityStagger));
    }
    for (let s = 0; s < buffers.capacity; s++) {
      if (!live[s] || pending.has(s)) continue;
      if (info.instant) { setBirth(s, SHOWN); continue; }
      const share = (stagger.get(buffers.slot[s * SLOT_ITEMS + 2]) ?? 0) + slotHash(s) * RENDER_LOCAL.reveal.unitJitter;
      setBirth(s, info.at + (share * info.durationMs) / 1000);
    }
  }

  function frame(f: FrameState): void {
    resolvePending();
    const mix = own.uOverlayMix.value;
    if (mix !== overlayTarget) {
      const step = ctx.reducedMotion ? 1 : (f.dt * 1000) / S.overlayFadeMs;
      own.uOverlayMix.value = overlayTarget > mix ? Math.min(overlayTarget, mix + step) : Math.max(overlayTarget, mix - step);
      ctx.invalidate();
    }
    const t = tracked!;
    t.slot.flush(); t.shape.flush(); t.color.flush(); t.state.flush(); t.nudge.flush();
  }

  function setTheme(mode: ThemeMode): void {
    // the same shaders in both modes; emitted light is additive only on the dark background
    const blending = mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending;
    materials[1].blending = blending;
    materials[2].blending = blending;
  }

  function dispose(): void {
    for (const off of unsubscribe) off();
    for (const m of meshes) ctx.scene.remove(m);
    geometry?.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    meshes.length = materials.length = textures.length = 0;
    geometry = null;
    tracked = null;
    pending.clear();
    flagged.clear();
  }

  return { name: 'spheres', order: 10, init, applyBatch, onPositions: resolvePending, reveal, frame, setTheme, dispose };
}

export default createSpheres;
