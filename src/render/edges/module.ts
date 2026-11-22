// Edges (PLAN.md §8.3, §8.6): dependencies as arcs carrying pulses from the dependent file to the
// file it depends on. Four instanced buffers, one per level of detail plus the focus set:
//   city      far: one ribbon per city pair
//   district  mid: district↔district ribbons for cities in view
//   file      near: a small ambient set of file↔file edges for districts in view, strongest first
//   focus     always: every edge of hovered and selected spheres, at full strength
// Endpoints are resolved on the GPU from the position textures, so moving a city uploads nothing.
// Levels cross-fade by camera distance; the total drawn stays within config.render.edgeBudget.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { PatchBatch } from '../../model/types';
import { unitSlotOf } from '../core/anchor';
import type { BatchInfo, FrameState, RevealInfo, SceneContext, SceneModule } from '../core/types';
import { allocateBudget, forwardShare, strength01, strongestFirst, type Ribbon } from './aggregate';
import { EdgeBuffer } from './buffer';
import { inView, lodMix, viewChanged, viewCircle, type LodMix, type LodScale } from './lod';
import { buildEdgeModel, edgesOfDistrict, edgesOfUnit, type EdgeModel } from './model';
import { EDGE_FRAG, EDGE_VERT, FLASH_FRAG, FLASH_VERT } from './shaders';
import { EDGE_LOCAL } from './tunables';

/** What other modules get from `ctx.service<EdgesApi>('edges')`. */
export interface EdgesApi {
  /** Draw every edge of this unit slot at full strength while it is hovered; −1 clears it. */
  setHover(slot: number): void;
  /** Instances currently drawn per buffer. */
  counts(): { city: number; district: number; file: number; focus: number };
}

type LevelName = 'city' | 'district' | 'file' | 'focus';
interface Level {
  name: LevelName;
  buffer: EdgeBuffer;
  mesh: THREE.Mesh;
  uniforms: { uAlpha: { value: number } };
  /** Current and wanted share of the level-of-detail mix. */
  alpha: number;
  target: number;
  /** True once the buffer holds the set for the current view. */
  filled: boolean;
  /** When each instance joined (by edge slot or pair key), so only newcomers fade in. */
  births: Map<number, number>;
}

const LONG_AGO = -1e6;
const NEVER_HIDDEN = 1e9;
const median = (values: number[]) => {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
};
const phaseOf = (n: number) => (Math.imul(n + 1, 0x9e3779b1) >>> 0) / 4294967296;

export function createEdges(): SceneModule {
  let ctx!: SceneContext;
  const levels = {} as Record<LevelName, Level>;
  const materials: THREE.ShaderMaterial[] = [];
  const meshes: THREE.Mesh[] = [];
  const unsubscribe: (() => void)[] = [];
  let flashMesh!: THREE.Mesh;

  let model: EdgeModel | null = null;
  /** The model changed: rebuild the derived data once batches go quiet. */
  let modelDirty = false, dirtySince = 0, lastBatch = 0;
  let selectDirty = true, focusDirty = true, positionsMoved = false;
  let lastView: { x: number; z: number; distance: number } | null = null;
  let lastSelect = 0, lastQuality = 0;
  let scale: LodScale = { city: 100, district: 30 };
  let hovered = -1;
  let novaSlot = -1, novaUntil = 0;
  let revealAt = Infinity, revealMix = 0;
  let focusDim = 1;
  /** What the focus set holds: a selection dims the ambient levels more than a hover. */
  let focusKind: 'none' | 'hovered' | 'selected' = 'none';
  let stamp = new Uint32Array(0), stampGen = 0;
  /** Files per district slot. */
  let districtUnits = new Int32Array(0);
  let districtColor: Float32Array = new Float32Array(0), cityColor: Float32Array = new Float32Array(0);

  const shared = {
    uMinBytes: { value: 0 }, uPulse: { value: new THREE.Vector4(120, 30, 0.5, 2.4) }, uFlicker: { value: 62.8 }, uTrace: { value: 0.16 },
    uMotion: { value: 1 }, uNova: { value: LONG_AGO }, uNovaSpeed: { value: EDGE_LOCAL.novaSpeed },
    uFlash: { value: new THREE.Vector2(EDGE_LOCAL.flashSeconds, EDGE_LOCAL.flashRadii) },
    uRibbon: { value: new THREE.Vector3(EDGE_LOCAL.ribbon.body, EDGE_LOCAL.ribbon.lane, EDGE_LOCAL.ribbon.pulse) },
  };

  const blendingFor = (mode: ThemeMode) => (mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending);

  function makeLevel(name: LevelName, order: number): Level {
    const ribbon = name === 'city' || name === 'district', focus = name === 'focus';
    const width = EDGE_LOCAL.width[name], lift = EDGE_LOCAL.lift[name === 'city' || name === 'district' ? name : 'file'];
    const own = {
      uAlpha: { value: 0 }, uFadeIn: { value: focus ? EDGE_LOCAL.fadeIn * 0.4 : EDGE_LOCAL.fadeIn }, uGain: { value: focus ? 1.7 : 1 },
      uWidth: { value: new THREE.Vector4(width.world[0], width.world[1], width.px[0], width.px[1]) },
      uLift: { value: new THREE.Vector2(lift[0], lift[1]) },
      // a selected sphere is drawn larger, so its edges start farther out
      uTrim: { value: focus ? ctx.config.visual.selectedScale : 1 },
      uRestScale: { value: focus ? 1 : EDGE_LOCAL.ambientRestScale },
      uRR: { value: new THREE.Vector2(EDGE_LOCAL.hubPulses.max, EDGE_LOCAL.hubPulses.seconds) },
    };
    const defines: Record<string, number> = {};
    if (ribbon) defines.RIBBON = 1;
    if (focus) defines.FOCUS = 1;
    const uniforms = { ...ctx.uniforms, ...shared, ...own };
    const material = new THREE.ShaderMaterial({
      uniforms, defines, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: blendingFor(ctx.theme),
    });
    const buffer = new EdgeBuffer(ribbon ? EDGE_LOCAL.ribbonSegments : EDGE_LOCAL.segments, ribbon, focus);
    const mesh = new THREE.Mesh(undefined, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    buffer.attach(mesh, 'strip');
    ctx.scene.add(mesh);
    materials.push(material);
    meshes.push(mesh);
    if (focus) {
      const flashMaterial = new THREE.ShaderMaterial({
        uniforms, vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending: blendingFor(ctx.theme),
      });
      flashMesh = new THREE.Mesh(undefined, flashMaterial);
      flashMesh.frustumCulled = false;
      flashMesh.renderOrder = order + 0.05;
      flashMesh.visible = false;
      buffer.attach(flashMesh, 'flash');
      ctx.scene.add(flashMesh);
      materials.push(flashMaterial);
      meshes.push(flashMesh);
    }
    return { name, buffer, mesh, uniforms: own, alpha: 0, target: 0, filled: false, births: new Map() };
  }

  // ---- hover: published on the bus by the interaction module ----
  function setHover(slot: number): void {
    if (slot === hovered) return;
    hovered = slot;
    focusDirty = true;
    ctx.invalidate();
  }

  // ---- budget ----
  const qualityFactor = () => Math.pow(EDGE_LOCAL.qualityStep, Math.max(0, ctx.counters.quality));
  const edgeBudget = () => Math.max(0, Math.floor(ctx.config.render.edgeBudget * qualityFactor()));

  // ---- model ----
  /** A ribbon end takes the colour of the commonest file type of its district or city. */
  function dominantColors(group: Int32Array, groups: number): Float32Array {
    const tally: Map<number, number>[] = Array.from({ length: groups }, () => new Map());
    const color = ctx.units.color;
    for (let u = 0; u < group.length; u++) {
      const g = group[u];
      if (g < 0 || g >= groups || 4 * u + 3 >= color.length || !color[4 * u + 3]) continue;
      const key = (color[4 * u] << 16) | (color[4 * u + 1] << 8) | color[4 * u + 2];
      tally[g].set(key, (tally[g].get(key) ?? 0) + 1);
    }
    const out = new Float32Array(groups * 3).fill(0.6);
    tally.forEach((counts, g) => {
      let best = -1, most = 0;
      for (const [key, n] of counts) if (n > most || (n === most && key < best)) { best = key; most = n; }
      if (best >= 0) { out[3 * g] = ((best >> 16) & 255) / 255; out[3 * g + 1] = ((best >> 8) & 255) / 255; out[3 * g + 2] = (best & 255) / 255; }
    });
    return out;
  }
  const colorOf = (colors: Float32Array, g: number): number[] => [colors[3 * g] ?? 0.6, colors[3 * g + 1] ?? 0.6, colors[3 * g + 2] ?? 0.6];

  function rebuildModel(): void {
    model = buildEdgeModel(ctx.replica, ctx.config.visual, ctx.state.minBytes, ctx.state.typeFilter);
    districtColor = dominantColors(model.unitDistrict, model.districtCity.length);
    const districtCity = model.districtCity;
    districtUnits = new Int32Array(districtCity.length);
    for (const d of model.unitDistrict) if (d >= 0) districtUnits[d]++;
    // slots may have been reassigned by a rebuild: ask the interaction module what is hovered now
    hovered = ctx.service<{ hoveredSlot(): number }>('interaction')?.hoveredSlot() ?? hovered;
    const unitCity = model.unitDistrict.map((d) => (d < 0 ? -1 : districtCity[d]));
    cityColor = dominantColors(unitCity, ctx.replica.table('city').capacity);
    if (stamp.length < model.capacity) stamp = new Uint32Array(Math.max(model.capacity, stamp.length * 2));
    modelDirty = false;
    selectDirty = focusDirty = true;
  }

  function markModelDirty(): void {
    const now = performance.now();
    if (!modelDirty) dirtySince = now;
    modelDirty = true;
    lastBatch = now;
    ctx.animate(EDGE_LOCAL.rebuildQuietMs + 100);
  }

  /** Typical territory radii, for the level-of-detail thresholds. */
  function measureScale(): void {
    const pos = ctx.positions.buffers;
    const cities = ctx.replica.table('city'), districts = ctx.replica.table('district');
    const cr: number[] = [], dr: number[] = [];
    for (let c = 0; c < cities.capacity; c++) if (cities.ids[c] != null && 3 * c + 2 < pos.city.length && pos.city[3 * c + 2] > 0) cr.push(pos.city[3 * c + 2]);
    for (let d = 0; d < districts.capacity; d++) if (districts.ids[d] != null && 3 * d + 2 < pos.district.length && pos.district[3 * d + 2] > 0) dr.push(pos.district[3 * d + 2]);
    const city = median(cr) || ctx.rig.bounds.r || 100;
    scale = { city, district: median(dr) || city * 0.3 };
  }

  const currentMix = (distance: number): LodMix =>
    lodMix(distance, scale, { city: !!model && model.cityRibbons.length > 0, district: !!model && model.districtRibbons.length > 0 });

  /** Birth time of an instance: kept while it stays in the buffer, so only newcomers fade in. */
  function birthOf(level: Level, next: Map<number, number>, key: number, time: number): number {
    const birth = level.births.get(key) ?? (level.alpha < 0.02 ? LONG_AGO : time);
    next.set(key, birth);
    return birth;
  }

  function fillRibbons(level: Level, ribbons: Ribbon[], time: number, isCity: boolean): void {
    const m = model!;
    const top = ribbons.length ? ribbons[0].weight : 1;
    const next = new Map<number, number>();
    level.buffer.ensure(ribbons.length);
    ribbons.forEach((r, i) => {
      const ca = isCity ? r.a : m.districtCity[r.a], cb = isCity ? r.b : m.districtCity[r.b];
      const key = r.a * 65536 + r.b;
      level.buffer.set(i, {
        e0: isCity ? -1 : r.a, e1: isCity ? -1 : r.b, e2: ca, e3: cb,
        strength: Math.sqrt(r.weight / top), brightness: 1 - (1 - EDGE_LOCAL.dimmed) * r.dim, phase: phaseOf(key), share: forwardShare(r),
        birth: birthOf(level, next, key, time), hideAt: NEVER_HIDDEN, nova: 0,
      });
      level.buffer.setColors(i, colorOf(isCity ? cityColor : districtColor, r.a), colorOf(isCity ? cityColor : districtColor, r.b));
    });
    level.births = next;
    level.buffer.commit(ribbons.length);
    level.filled = true;
  }

  function fillFiles(level: Level, chosen: number[], time: number, focusUnits: Set<number> | null): void {
    const m = model!;
    const next = new Map<number, number>();
    level.buffer.ensure(chosen.length);
    // connections per sphere in this set: a busy sphere takes its connections in turn (see hubPulses)
    const degree = new Map<number, number>();
    const bump = (u: number) => degree.set(u, (degree.get(u) ?? 0) + 1);
    for (const e of chosen) { bump(m.src[e]); bump(m.dst[e]); }
    const turn = new Map<number, number>();
    chosen.forEach((e, i) => {
      const s = m.src[e], t = m.dst[e];
      // the hub is a focused end, else the busier end
      const ds = degree.get(s)!, dt = degree.get(t)!;
      const sHub = focusUnits && focusUnits.has(s) !== focusUnits.has(t) ? focusUnits.has(s) : ds >= dt;
      const hub = sHub ? s : t, n = sHub ? ds : dt;
      let rrTurn = 0, rrSize = 0;
      if (n > EDGE_LOCAL.hubPulses.max) {
        const k = turn.get(hub) ?? 0;
        turn.set(hub, k + 1);
        // each hub starts its round at its own point in time, so busy spheres do not fire in step
        rrTurn = k + phaseOf(hub) * n; rrSize = n;
      }
      let hideAt = m.hideAt[e], nova = 0;
      if (focusUnits) {
        // a selected sphere is exempt from the size slider, so only the other end can hide the edge
        hideAt = Math.min(focusUnits.has(s) ? NEVER_HIDDEN : m.unitHideAt[s], focusUnits.has(t) ? NEVER_HIDDEN : m.unitHideAt[t]);
        nova = s === novaSlot ? 1 : t === novaSlot ? -1 : 0;
      }
      level.buffer.set(i, {
        e0: s, e1: t, e2: rrTurn, e3: rrSize,
        strength: strength01(m.eff[e], m.typical), brightness: m.bright[e], phase: phaseOf(e), share: 1,
        birth: birthOf(level, next, e, time), hideAt, nova,
      });
    });
    level.births = next;
    level.buffer.commit(chosen.length);
    level.filled = true;
  }

  /** Choose what each level of detail draws for this view, within the budget. */
  function select(view: { x: number; z: number; distance: number }, time: number): void {
    const m = model!;
    measureScale();
    const mix = currentMix(view.distance);
    const circle = viewCircle(view, view.distance);
    const pos = ctx.positions.buffers;
    const q = qualityFactor();

    const cityIn = (c: number) => c >= 0 && 3 * c + 2 < pos.city.length && inView(circle, pos.city[3 * c], pos.city[3 * c + 1], pos.city[3 * c + 2]);
    const districtIn = (d: number) => {
      const c = m.districtCity[d];
      if (c < 0 || 3 * c + 2 >= pos.city.length || 3 * d + 2 >= pos.district.length) return false;
      return inView(circle, pos.city[3 * c] + pos.district[3 * d], pos.city[3 * c + 1] + pos.district[3 * d + 1], pos.district[3 * d + 2]);
    };

    // far: every city pair (there are few)
    const cityWanted = mix.city > 0 ? m.cityRibbons : [];
    // mid: district ribbons between districts of the cities in view, strongest first
    const districtWanted: Ribbon[] = [];
    if (mix.district > 0) {
      const cap = Math.max(1, Math.floor(EDGE_LOCAL.districtRibbons * q));
      const seen = new Map<number, boolean>();
      const visible = (c: number) => { let v = seen.get(c); if (v === undefined) seen.set(c, (v = cityIn(c))); return v; };
      for (const r of m.districtRibbons) {
        if (districtWanted.length >= cap) break;
        if (visible(m.districtCity[r.a]) && visible(m.districtCity[r.b])) districtWanted.push(r);
      }
    }
    // near: file edges touching a district in view, strongest first
    let fileWanted: number[] = [];
    if (mix.file > 0) {
      const inViewDistricts: number[] = [];
      let unitsInView = 0;
      for (let d = 0; d < m.districtCity.length; d++) if (m.districtCity[d] >= 0 && districtIn(d)) { inViewDistricts.push(d); unitsInView += districtUnits[d] ?? 0; }
      // a small ambient set: capped overall, and thinned to a few per file when only a few districts are in view
      const cap = Math.max(0, Math.floor(Math.min(ctx.config.render.ambientEdges, Math.ceil(unitsInView * EDGE_LOCAL.ambientPerUnit)) * q));
      // each district offers its strongest few; with many in view, no single one may flood the set
      const perDistrict = Math.max(16, Math.ceil((cap * 3) / Math.max(1, inViewDistricts.length)));
      const candidates: number[] = [];
      if (++stampGen >= 0xffffffff) { stamp.fill(0); stampGen = 1; }
      for (const d of inViewDistricts) {
        const list = edgesOfDistrict(m, d);
        const take = Math.min(list.length, perDistrict);
        for (let i = 0; i < take; i++) {
          const e = list[i];
          if (stamp[e] === stampGen) continue;
          stamp[e] = stampGen;
          candidates.push(e);
        }
      }
      fileWanted = strongestFirst(m.rank, cap, candidates);
    }

    const [, cityN, districtN, fileN] = allocateBudget(edgeBudget(), [levels.focus.buffer.count, cityWanted.length, districtWanted.length, fileWanted.length]);
    fillRibbons(levels.city, cityWanted.slice(0, cityN), time, true);
    fillRibbons(levels.district, districtWanted.slice(0, districtN), time, false);
    if (fileWanted.length > fileN) fileWanted.length = fileN;
    fillFiles(levels.file, fileWanted, time, null);
    // a level that is not part of the mix was left empty: fill it when it comes back
    levels.city.filled = mix.city > 0; levels.district.filled = mix.district > 0; levels.file.filled = mix.file > 0;

    lastView = { ...view };
    lastSelect = performance.now();
    lastQuality = ctx.counters.quality;
    selectDirty = positionsMoved = false;
  }

  /** Every edge of the hovered and selected spheres. */
  function fillFocus(time: number): void {
    const m = model!;
    const focus = levels.focus;
    const unitsInFocus = new Set<number>();
    for (const ref of ctx.state.selection) { const s = unitSlotOf(ref, ctx.replica); if (s >= 0) unitsInFocus.add(s); }
    const selected = unitsInFocus.size > 0;
    if (hovered >= 0) unitsInFocus.add(hovered);
    if (novaSlot >= 0) unitsInFocus.add(novaSlot);
    focusKind = selected ? 'selected' : unitsInFocus.size > 0 ? 'hovered' : 'none';
    const candidates: number[] = [];
    if (unitsInFocus.size) {
      if (++stampGen >= 0xffffffff) { stamp.fill(0); stampGen = 1; }
      for (const u of unitsInFocus) {
        for (const e of edgesOfUnit(m, u)) {
          if (stamp[e] === stampGen) continue;
          stamp[e] = stampGen;
          candidates.push(e);
        }
      }
    }
    const before = focus.buffer.count;
    fillFiles(focus, strongestFirst(m.eff, edgeBudget(), candidates), time, unitsInFocus);
    focusDirty = false;
    // the focus set comes first in the budget: if it grew, the ambient levels may have to give way
    const total = focus.buffer.count + levels.city.buffer.count + levels.district.buffer.count + levels.file.buffer.count;
    if (focus.buffer.count > before && total > edgeBudget()) selectDirty = true;
  }

  // ---- module hooks ----
  function init(context: SceneContext): void {
    ctx = context;
    const pulse = ctx.config.visual.edgePulse;
    shared.uPulse.value.set(pulse.speed, pulse.tailLength, pulse.restSeconds[0], pulse.restSeconds[1]);
    shared.uFlicker.value = pulse.flickerHz * 2 * Math.PI;
    shared.uTrace.value = pulse.traceOpacity;
    shared.uMotion.value = ctx.reducedMotion ? 0 : 1;
    shared.uMinBytes.value = ctx.state.minBytes;

    levels.city = makeLevel('city', 1.9);
    levels.district = makeLevel('district', 1.95);
    levels.file = makeLevel('file', 2);
    levels.focus = makeLevel('focus', 2.1);

    unsubscribe.push(
      ctx.bus.on('selection', () => { focusDirty = true; }),
      ctx.bus.on('hover', (h) => setHover(h.slot)),
      ctx.bus.on('typeFilter', markModelDirty),
      ctx.bus.on('minBytes', (n) => { shared.uMinBytes.value = n; markModelDirty(); }),
      ctx.bus.on('burst', ({ ref, kind }) => {
        if (kind !== 'open' || ctx.reducedMotion) return;
        const slot = unitSlotOf(ref, ctx.replica);
        if (slot < 0) return;
        // one synchronised pulse leaves the opened file along every connection (PLAN.md §8.6)
        novaSlot = slot;
        novaUntil = performance.now() + EDGE_LOCAL.novaHoldMs;
        shared.uNova.value = ctx.now();
        focusDirty = true;
        ctx.animate(EDGE_LOCAL.novaHoldMs + 100);
      }),
    );
    const api: EdgesApi = {
      setHover,
      counts: () => ({ city: levels.city.buffer.count, district: levels.district.buffer.count, file: levels.file.buffer.count, focus: levels.focus.buffer.count }),
    };
    ctx.provide('edges', api);
    if (ctx.state.revealed) { revealAt = LONG_AGO; revealMix = 1; }
    modelDirty = true;
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    if (info.rebuild) { markModelDirty(); return; }
    for (const op of batch.ops) {
      // edges, and anything that moves a unit to another district or a district to another city
      if (op.op === 'assign' || ((op.op === 'add' || op.op === 'update' || op.op === 'remove') && (op.kind === 'edge' || op.kind === 'unit' || op.kind === 'district'))) {
        markModelDirty();
        return;
      }
    }
  }

  function onPositions(): void {
    positionsMoved = true;
  }

  function reveal(info: RevealInfo): void {
    // the lines arrive once most of the stars have ignited
    revealAt = info.instant ? LONG_AGO : info.at + (info.durationMs / 1000) * 0.6;
    if (info.instant) revealMix = 1;
    ctx.animate(info.durationMs + EDGE_LOCAL.fadeIn * 2000);
  }

  function frame(f: FrameState): void {
    const all = [levels.city, levels.district, levels.file, levels.focus];
    if (!ctx.state.revealed || f.time < revealAt) {
      for (const m of meshes) m.visible = false;
      ctx.counters.edgesDrawn = 0;
      return;
    }
    const step = ctx.reducedMotion ? 1 : f.dt / EDGE_LOCAL.fadeIn;
    if (revealMix < 1) { revealMix = Math.min(1, revealMix + step * 0.5); ctx.invalidate(); }

    if (modelDirty && (!model || f.nowMs - lastBatch >= EDGE_LOCAL.rebuildQuietMs || f.nowMs - dirtySince >= EDGE_LOCAL.rebuildMaxMs)) rebuildModel();
    if (!model) return;

    if (novaSlot >= 0 && f.nowMs > novaUntil) { novaSlot = -1; focusDirty = true; }
    if (focusDirty) fillFocus(f.time);

    const view = { x: f.target.x, z: f.target.z, distance: f.cameraDistance };
    let mix = currentMix(view.distance);
    const unfilled = (mix.city > 0 && !levels.city.filled) || (mix.district > 0 && !levels.district.filled) || (mix.file > 0 && !levels.file.filled);
    const moved = positionsMoved && f.nowMs - lastSelect >= EDGE_LOCAL.hotReselectMs;
    if (selectDirty || unfilled || moved || ctx.counters.quality !== lastQuality || viewChanged(lastView, view)) {
      select(view, f.time);
      mix = currentMix(view.distance);
    }

    // cross-fade: each level eases toward its share of the mix; ambient levels step back under a focus
    const hasFocus = levels.focus.buffer.count > 0;
    // a selection hides the ambient levels outright, even when the selected sphere has no edges
    const dimTarget = focusKind === 'selected' ? EDGE_LOCAL.focusDim.selected : hasFocus && focusKind === 'hovered' ? EDGE_LOCAL.focusDim.hovered : 1;
    if (focusDim !== dimTarget) { focusDim = dimTarget > focusDim ? Math.min(dimTarget, focusDim + step) : Math.max(dimTarget, focusDim - step); ctx.invalidate(); }
    levels.city.target = mix.city; levels.district.target = mix.district; levels.file.target = mix.file; levels.focus.target = 1;
    let drawn = 0;
    for (const level of all) {
      if (level.alpha !== level.target) {
        level.alpha = level.target > level.alpha ? Math.min(level.target, level.alpha + step) : Math.max(level.target, level.alpha - step);
        ctx.invalidate();
      }
      const ambient = level.name !== 'focus';
      level.uniforms.uAlpha.value = level.alpha * revealMix * (ambient ? focusDim : 1);
      level.mesh.visible = level.buffer.count > 0 && level.uniforms.uAlpha.value > 0.003;
      if (level.mesh.visible) drawn += level.buffer.count;
    }
    flashMesh.visible = levels.focus.mesh.visible && !ctx.reducedMotion;
    ctx.counters.edgesDrawn = drawn;
  }

  function setTheme(mode: ThemeMode): void {
    for (const m of materials) m.blending = blendingFor(mode);
  }

  function dispose(): void {
    for (const off of unsubscribe) off();
    for (const m of meshes) ctx.scene.remove(m);
    for (const level of Object.values(levels)) level.buffer.dispose();
    for (const m of materials) m.dispose();
    meshes.length = materials.length = unsubscribe.length = 0;
    model = null;
    ctx.counters.edgesDrawn = 0;
  }

  return { name: 'edges', order: 20, init, applyBatch, onPositions, reveal, frame, setTheme, dispose };
}

export default createEdges;
