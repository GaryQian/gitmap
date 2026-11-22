// Territories (PLAN.md §8.2, §17.5): cities and districts as shapes on the plane, with no enclosing
// 3D object. An offscreen top-down pass draws every sphere's footprint as a soft disc into a
// low-resolution texture, tinted per district and city; the ground samples it for a soft fill
// (pools of light in dark mode, tinted shade in light mode) and contour lines, and the Voronoi cells
// of each city's districts give crisp borders on top. The pass runs again only when positions or the
// model changed, never while everything is asleep.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import { GEN_DISTRICT0 } from '../../contracts/physics';
import type { PatchBatch } from '../../model/types';
import { makeSlotTexture, slotTexHeight, SLOT_TEX_WIDTH } from '../core/positions';
import type { BatchInfo, FrameState, RevealInfo, SceneContext, SceneModule } from '../core/types';
import type { TerritoryShape } from '../../shared/cells';
import { districtBorders } from './borders';
import { BORDER_FRAG, BORDER_VERT, CITY_FRAG, CITY_VERT, DISTRICT_FRAG, DISTRICT_VERT, FOOTPRINT_FRAG, FOOTPRINT_VERT, GROUND_FRAG, GROUND_VERT } from './shaders';
import { cityTint, districtTint } from './tint';
import { TERRITORY_LOCAL as T } from './tunables';

const QUAD = () => new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

export function createTerritory(): SceneModule {
  let ctx!: SceneContext;
  let territoryShape: TerritoryShape = { reach: 1.08, pad: 0, weight: 1 };
  let target: THREE.WebGLRenderTarget | null = null;
  const passScene = new THREE.Scene();
  const passCamera = new THREE.Camera();
  const disposables: { dispose(): void }[] = [];
  const materials: THREE.ShaderMaterial[] = [];
  let footprints!: THREE.InstancedBufferGeometry;
  let discs!: THREE.InstancedBufferGeometry;
  let cityDiscs!: THREE.InstancedBufferGeometry;
  let ground!: THREE.Mesh;
  let borders!: THREE.Mesh;
  let borderGeometry: THREE.InstancedBufferGeometry | null = null;

  /** Per district slot: tint rgb and city slot (−1 for an empty slot). */
  let tintData = new Float32Array(SLOT_TEX_WIDTH * 4);
  let tintTex: THREE.DataTexture | null = null;
  /** Per city slot: tint rgb and 1 when the city exists. */
  let cityTintData = new Float32Array(SLOT_TEX_WIDTH * 4);
  let cityTintTex: THREE.DataTexture | null = null;
  /** The footprint texture must be drawn again. */
  let dirty = true;
  /** The model changed: district tints and borders must be rebuilt. */
  let modelDirty = true;
  let bordersDirty = true;
  /** District generation counters and sites already turned into borders, per city. */
  let seenGen = new Int32Array(0);
  const cityBorders = new Map<number, { key: string; segments: number[] }>();
  let revealAt = Infinity;
  const clearColor = new THREE.Color();

  const own = {
    uTerr: { value: null as THREE.Texture | null }, uTB: { value: new THREE.Vector4(0, 0, 1, 1) }, uTerrRes: { value: T.resolution }, uWScale: { value: 1 },
    uDistrictTint: { value: null as THREE.DataTexture | null }, uCityTint: { value: null as THREE.DataTexture | null },
    uFade: { value: 0 }, uFill: { value: new THREE.Vector2(T.fill[0], T.fill[1]) }, uContour: { value: new THREE.Vector2(T.contourOuter, T.contourInner) },
    uStrength: { value: new THREE.Vector3() }, uBorderStrength: { value: 0 }, uBorder: { value: new THREE.Vector2(T.borderPx, T.borderWorld) },
  };

  const additive = (uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string) => {
    const m = new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    materials.push(m);
    return m;
  };

  function applyTheme(mode: ThemeMode): void {
    const s = mode === 'dark' ? T.dark : T.light;
    own.uStrength.value.set(s.fill, s.outer, s.inner);
    own.uBorderStrength.value = s.border;
    const blending = mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending;
    (ground.material as THREE.ShaderMaterial).blending = blending;
    (borders.material as THREE.ShaderMaterial).blending = blending;
  }

  function init(context: SceneContext): void {
    ctx = context;
    // the same cell shape physics contains files in (src/physics/cells.ts)
    const dc = ctx.config.physics.district as { pad: number; reach?: number; cellWeight?: number };
    territoryShape = { reach: dc.reach ?? 1.08, pad: dc.pad, weight: dc.cellWeight ?? 1 };
    const { renderer } = ctx;
    // additive accumulation needs a float target; without one, fall back to bytes with small weights
    const float = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    const weightScale = float ? 1 : 0.2;
    own.uWScale.value = 1 / weightScale;
    target = new THREE.WebGLRenderTarget(T.resolution, T.resolution, {
      type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    own.uTerr.value = target.texture;

    const shared = { ...ctx.uniforms, ...own };
    const instanced = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', QUAD());
      g.setIndex(QUAD_INDEX);
      g.instanceCount = 0;
      disposables.push(g);
      return g;
    };
    cityDiscs = instanced();
    discs = instanced();
    footprints = instanced();
    const cityMat = additive({ ...shared, uDisc: { value: new THREE.Vector2(T.cityDisc, T.citySkirt) }, uWeight: { value: T.cityWeight * weightScale } }, CITY_VERT, CITY_FRAG);
    const discMat = additive({ ...shared, uDisc: { value: new THREE.Vector2(T.districtDisc, T.districtSkirt) }, uWeight: { value: T.districtWeight * weightScale } }, DISTRICT_VERT, DISTRICT_FRAG);
    const footMat = additive({ ...shared, uFootprint: { value: new THREE.Vector2(T.footprintRadii, T.footprintSkirt) }, uWeight: { value: weightScale } }, FOOTPRINT_VERT, FOOTPRINT_FRAG);
    for (const [g, m] of [[cityDiscs, cityMat], [discs, discMat], [footprints, footMat]] as const) {
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      passScene.add(mesh);
    }

    const dark = ctx.theme === 'dark';
    const groundMat = new THREE.ShaderMaterial({
      uniforms: shared, vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, transparent: true, depthWrite: false, depthTest: true,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    ground = new THREE.Mesh(plane, groundMat);
    ground.frustumCulled = false;
    ground.renderOrder = -0.5; // over the grid (−1), under the stars' ground light (0)
    ground.visible = false;
    ctx.scene.add(ground);

    const borderMat = new THREE.ShaderMaterial({
      uniforms: shared, vertexShader: BORDER_VERT, fragmentShader: BORDER_FRAG, transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    borders = new THREE.Mesh(undefined, borderMat);
    borders.frustumCulled = false;
    borders.renderOrder = -0.4;
    borders.visible = false;
    ctx.scene.add(borders);
    materials.push(groundMat, borderMat);
    disposables.push(plane);
    applyTheme(ctx.theme);
  }

  /** District tints and the slots the pass draws. */
  function rebuildModel(): void {
    const districts = ctx.replica.table('district');
    const need = SLOT_TEX_WIDTH * slotTexHeight(districts.capacity) * 4;
    if (!tintTex || tintData.length !== need) {
      tintTex?.dispose();
      tintData = new Float32Array(need);
      tintTex = makeSlotTexture(tintData, need / (SLOT_TEX_WIDTH * 4), THREE.RGBAFormat);
      own.uDistrictTint.value = tintTex;
    }
    for (let d = 0; d < need / 4; d++) {
      const c = d < districts.capacity && districts.ids[d] != null ? (districts.refSlots.city[d] ?? -1) : -1;
      const tint = c >= 0 ? districtTint(d, c) : [0, 0, 0];
      tintData[4 * d] = tint[0]; tintData[4 * d + 1] = tint[1]; tintData[4 * d + 2] = tint[2]; tintData[4 * d + 3] = c;
    }
    tintTex.needsUpdate = true;
    const cities = ctx.replica.table('city');
    const cityNeed = SLOT_TEX_WIDTH * slotTexHeight(cities.capacity) * 4;
    if (!cityTintTex || cityTintData.length !== cityNeed) {
      cityTintTex?.dispose();
      cityTintData = new Float32Array(cityNeed);
      cityTintTex = makeSlotTexture(cityTintData, cityNeed / (SLOT_TEX_WIDTH * 4), THREE.RGBAFormat);
      own.uCityTint.value = cityTintTex;
    }
    cityTintData.fill(0);
    for (let c = 0; c < cities.capacity; c++) {
      if (cities.ids[c] == null) continue;
      const tint = cityTint(c);
      cityTintData[4 * c] = tint[0]; cityTintData[4 * c + 1] = tint[1]; cityTintData[4 * c + 2] = tint[2]; cityTintData[4 * c + 3] = 1;
    }
    cityTintTex.needsUpdate = true;
    cityDiscs.instanceCount = cities.capacity;
    discs.instanceCount = districts.capacity;
    footprints.instanceCount = ctx.replica.table('unit').capacity;
    cityBorders.clear();
    modelDirty = false;
    bordersDirty = dirty = true;
  }

  /** Recompute the Voronoi borders of every city whose districts moved. */
  function rebuildBorders(): void {
    bordersDirty = false;
    const pos = ctx.positions.buffers;
    const districts = ctx.replica.table('district'), cities = ctx.replica.table('city');
    const byCity = new Map<number, number[]>();
    for (let d = 0; d < districts.capacity; d++) {
      if (districts.ids[d] == null || 3 * d + 2 >= pos.district.length) continue;
      const c = districts.refSlots.city[d] ?? -1;
      if (c < 0 || cities.ids[c] == null || 3 * c + 2 >= pos.city.length) continue;
      let list = byCity.get(c);
      if (!list) byCity.set(c, (list = []));
      list.push(d);
    }
    let changed = cityBorders.size !== byCity.size;
    for (const c of [...cityBorders.keys()]) if (!byCity.has(c)) cityBorders.delete(c);
    for (const [c, list] of byCity) {
      const r = pos.city[3 * c + 2];
      // a city's borders depend only on its districts' local positions and its radius
      let key = `${r.toFixed(2)}`;
      for (const d of list) key += `|${pos.district[3 * d].toFixed(2)},${pos.district[3 * d + 1].toFixed(2)},${pos.district[3 * d + 2].toFixed(2)}`;
      const had = cityBorders.get(c);
      if (had && had.key === key) continue;
      const sites = list.map((d) => ({ x: pos.district[3 * d], z: pos.district[3 * d + 1], bound: pos.district[3 * d + 2] }));
      cityBorders.set(c, { key, segments: districtBorders(sites, territoryShape) });
      changed = true;
    }
    if (!changed && borderGeometry) return;

    let n = 0;
    for (const b of cityBorders.values()) n += b.segments.length / 4;
    const seg = new Float32Array(Math.max(1, n) * 4), city = new Float32Array(Math.max(1, n));
    let i = 0;
    for (const [c, b] of cityBorders) {
      for (let k = 0; k < b.segments.length; k += 4, i++) {
        seg.set(b.segments.slice(k, k + 4), 4 * i);
        city[i] = c;
      }
    }
    borderGeometry?.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    g.setIndex(QUAD_INDEX);
    g.setAttribute('aSeg', new THREE.InstancedBufferAttribute(seg, 4));
    g.setAttribute('aCity', new THREE.InstancedBufferAttribute(city, 1));
    g.instanceCount = n;
    borderGeometry = g;
    borders.geometry = g;
  }

  /** True when a district's own row or its files moved since the borders were last built. */
  function districtsMoved(): boolean {
    const gen = ctx.positions.buffers.gen;
    const n = Math.max(0, gen.length - GEN_DISTRICT0);
    if (seenGen.length !== n) { seenGen = new Int32Array(n).fill(-1); }
    let moved = false;
    for (let d = 0; d < n; d++) {
      const g = Atomics.load(gen, GEN_DISTRICT0 + d);
      if (g !== seenGen[d]) { seenGen[d] = g; moved = true; }
    }
    return moved;
  }

  function drawFootprints(): void {
    if (!target) return;
    const b = ctx.rig.bounds;
    const half = b.r * (1 + T.margin) + T.marginWorld;
    own.uTB.value.set(b.x - half, b.z - half, 2 * half, 2 * half);
    ground.position.set(b.x, 0, b.z);
    ground.scale.set(2 * half, 1, 2 * half);
    const { renderer } = ctx;
    const previous = renderer.getRenderTarget();
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(passScene, passCamera);
    renderer.setRenderTarget(previous);
    renderer.setClearColor(clearColor, alpha);
    dirty = false;
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    if (info.rebuild) { modelDirty = true; return; }
    for (const op of batch.ops) {
      if (op.op === 'assign' || ((op.op === 'add' || op.op === 'update' || op.op === 'remove') && (op.kind === 'unit' || op.kind === 'district' || op.kind === 'city'))) {
        modelDirty = true;
        return;
      }
    }
  }

  function onPositions(): void {
    dirty = true;
    if (districtsMoved()) bordersDirty = true;
  }

  function reveal(info: RevealInfo): void {
    revealAt = info.instant ? -1e6 : info.at;
    dirty = true;
    ctx.animate(info.durationMs + T.fadeIn * 1000);
  }

  function frame(f: FrameState): void {
    const shown = ctx.state.revealed && f.time >= revealAt;
    ground.visible = shown;
    borders.visible = shown;
    if (!shown) return;
    const fade = ctx.reducedMotion ? 1 : Math.min(1, (f.time - revealAt) / T.fadeIn);
    if (fade !== own.uFade.value) { own.uFade.value = fade; ctx.invalidate(); }
    if (modelDirty) rebuildModel();
    if (bordersDirty) rebuildBorders();
    borders.visible = !!borderGeometry && borderGeometry.instanceCount > 0;
    if (dirty) drawFootprints();
  }

  function dispose(): void {
    ctx.scene.remove(ground, borders);
    passScene.clear();
    target?.dispose();
    target = null;
    tintTex?.dispose();
    tintTex = null;
    cityTintTex?.dispose();
    cityTintTex = null;
    borderGeometry?.dispose();
    borderGeometry = null;
    for (const d of disposables) d.dispose();
    for (const m of materials) m.dispose();
    disposables.length = materials.length = 0;
    cityBorders.clear();
  }

  // after the background (−10), so the ground sits on its grid; before the spheres
  return { name: 'territory', order: -5, init, applyBatch, onPositions, reveal, frame, setTheme: applyTheme, dispose };
}

export default createTerritory;
