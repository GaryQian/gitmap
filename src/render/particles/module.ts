// Particles (PLAN.md §8.4, §8.6): two GPU point pools, both stateless functions of time.
//   ambient  stellar wind (motes bound to a host sphere chosen in proportion to importance) and
//            sparse void dust through the volume. Off when particles are disabled or motion is reduced.
//   bursts   each burst is a spawn time, an origin and a seed. 'select': a core flash, a ring of
//            particles in the type colour and a shockwave across the ground. 'open': a nova and a
//            brief column of light. Plus a small flash per sphere as it ignites at the reveal.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { NodeRef, PatchBatch } from '../../model/types';
import { glowAmount, hash32 } from '../../shared';
import { unitSlotOf } from '../core/anchor';
import { makeSlotTexture, slotTexHeight, SLOT_TEX_WIDTH } from '../core/positions';
import { RENDER_LOCAL } from '../core/tunables';
import type { BatchInfo, FrameState, RevealInfo, SceneContext, SceneModule } from '../core/types';
import { chooseHosts, windWeight } from './hosts';
import { AMBIENT_VERT, BURST_VERT, IGNITE_FRAG, IGNITE_VERT, POINT_FRAG, SHAPE_FRAG, SHAPE_VERT } from './shaders';
import { PARTICLE_LOCAL as P } from './tunables';

const LONG_AGO = -1e6;

export function createParticles(): SceneModule {
  let ctx!: SceneContext;
  const materials: THREE.ShaderMaterial[] = [];
  const disposables: { dispose(): void }[] = [];
  const objects: THREE.Object3D[] = [];
  const unsubscribe: (() => void)[] = [];
  let ambient!: THREE.Points;
  let hostAttr!: THREE.BufferAttribute;
  let sparks!: THREE.Points;
  let shapes!: THREE.Mesh;
  let ignite!: THREE.Points;
  let igniteGeometry: THREE.BufferGeometry | null = null;
  let staggerTex: THREE.DataTexture | null = null;

  let hostsDirty = true, hostsDirtyAt = 0;
  let revealAt = Infinity, igniteUntil = -Infinity;
  let nextBurst = 0, burstsUntil = -Infinity;

  const vec4s = () => Array.from({ length: P.maxBursts }, () => new THREE.Vector4(0, 0, 0, LONG_AGO));
  const own = {
    uBounds: { value: new THREE.Vector4(0, 0, 1, 1) }, uAmbient: { value: 0 },
    uBurstA: { value: vec4s() }, uBurstB: { value: vec4s() }, uBurstC: { value: vec4s() },
    uLife: { value: new THREE.Vector2(P.selectSeconds, P.openSeconds) }, uSparks: { value: 1 },
    uShape: { value: new THREE.Vector4(P.ringRadii, P.ringWorld, P.columnHeight, P.columnWidth) },
    uCityStagger: { value: null as THREE.DataTexture | null }, uReveal: { value: new THREE.Vector4(LONG_AGO, 1, 0, 0.1) },
    uIgnite: { value: new THREE.Vector2(P.igniteSeconds, P.igniteRadii) },
  };

  const blendingFor = (mode: ThemeMode) => (mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending);
  const material = (vertexShader: string, fragmentShader: string) => {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...ctx.uniforms, ...own }, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: blendingFor(ctx.theme),
    });
    materials.push(m);
    return m;
  };
  const add = <T extends THREE.Object3D>(object: T, order: number): T => {
    object.frustumCulled = false;
    object.renderOrder = order;
    object.visible = false;
    ctx.scene.add(object);
    objects.push(object);
    return object;
  };

  const ambientOn = () => ctx.state.particles && !ctx.reducedMotion;

  /** Bind each wind mote to a host, in proportion to importance, among the spheres that are drawn. */
  function chooseAmbientHosts(): void {
    hostsDirty = false;
    const units = ctx.replica.table('unit');
    const visual = ctx.config.visual, minBytes = ctx.state.minBytes;
    const shown = ctx.state.typeFilter.length ? new Set(ctx.state.typeFilter) : null;
    const weight = new Float32Array(units.capacity);
    for (let u = 0; u < units.capacity; u++) {
      if (units.ids[u] == null || (units.refSlots.district[u] ?? -1) < 0) continue;
      const pct = units.cols.importancePct[u];
      if (units.cols.bytes[u] < minBytes && glowAmount(pct, visual) <= 0) continue;   // hidden by the size slider
      if (shown && !shown.has(units.cols.lang[u])) continue;                        // dimmed by the type filter
      weight[u] = windWeight(pct);
    }
    const host = hostAttr.array as Float32Array;
    const dust = Math.round(host.length * Math.min(1, Math.max(0, visual.particles.voidDustShare)));
    const hosts = chooseHosts(weight, host.length - dust, ctx.config.clustering.seed);
    host.fill(-1, 0, dust);
    // a mote with no host is collapsed in the shader (slot −2 is nobody)
    for (let i = dust; i < host.length; i++) host[i] = hosts[i - dust] < 0 ? -2 : hosts[i - dust];
    hostAttr.needsUpdate = true;
  }

  function markHostsDirty(): void {
    hostsDirty = true;
    hostsDirtyAt = performance.now();
    ctx.animate(P.wind.rehostQuietMs + 100);
  }

  function burst(ref: NodeRef, kind: 'select' | 'open'): void {
    if (ctx.reducedMotion || !ctx.state.revealed) return;
    const anchor = ctx.anchor(ref);
    if (!anchor) return;
    const slot = unitSlotOf(ref, ctx.replica);
    const i = nextBurst;
    nextBurst = (nextBurst + 1) % P.maxBursts;
    const now = ctx.now();
    const particles = ctx.config.visual.particles;
    // a unit's burst follows it through the position textures; a district or city bursts from its ground centre
    let color = ctx.uniforms.uHalo.value, r = 6;
    if (slot >= 0 && slot < ctx.units.capacity) {
      const c = ctx.units.color;
      color = new THREE.Vector3(c[4 * slot] / 255, c[4 * slot + 1] / 255, c[4 * slot + 2] / 255);
      r = anchor.r;
    }
    own.uBurstA.value[i].set(anchor.x, anchor.y, anchor.z, now);
    own.uBurstB.value[i].set(kind === 'open' ? 2 : 1, r, kind === 'open' ? particles.openBurst : particles.selectBurst, (hash32(ref) % 1000) / 1000 + i * 0.137);
    own.uBurstC.value[i].set(color.x, color.y, color.z, slot);
    const life = kind === 'open' ? P.openSeconds : P.selectSeconds;
    burstsUntil = Math.max(burstsUntil, now + life);
    ctx.animate(life * 1000 + 100);
  }

  function ensureIgnite(): void {
    const capacity = ctx.replica.table('unit').capacity;
    if (igniteGeometry && igniteGeometry.getAttribute('position').count >= capacity) { igniteGeometry.setDrawRange(0, capacity); return; }
    igniteGeometry?.dispose();
    igniteGeometry = new THREE.BufferGeometry();
    igniteGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3));
    igniteGeometry.setDrawRange(0, capacity);
    ignite.geometry = igniteGeometry;
  }

  // ---- module hooks ----
  function init(context: SceneContext): void {
    ctx = context;
    const particles = ctx.config.visual.particles;

    // ambient pool: fixed size
    const n = Math.max(0, Math.floor(particles.ambient));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
    hostAttr = new THREE.BufferAttribute(new Float32Array(Math.max(1, n)).fill(-2), 1);
    const seed = new Float32Array(Math.max(1, n));
    for (let i = 0; i < seed.length; i++) seed[i] = (Math.imul(i + 1, 0x9e3779b1) >>> 0) / 4294967296;
    g.setAttribute('aHost', hostAttr);
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setDrawRange(0, n);
    ambient = add(new THREE.Points(g, material(AMBIENT_VERT, POINT_FRAG)), 3);

    // burst pool: `maxBursts` bursts of up to the larger burst size
    const per = Math.max(1, Math.floor(Math.max(particles.selectBurst, particles.openBurst)));
    const total = per * P.maxBursts;
    const bg = new THREE.BufferGeometry();
    const which = new Float32Array(total), index = new Float32Array(total), bseed = new Float32Array(total);
    for (let i = 0; i < total; i++) { which[i] = Math.floor(i / per); index[i] = i % per; bseed[i] = (Math.imul(i + 7, 0x85ebca6b) >>> 0) / 4294967296; }
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    bg.setAttribute('aBurst', new THREE.BufferAttribute(which, 1));
    bg.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    bg.setAttribute('aSeed', new THREE.BufferAttribute(bseed, 1));
    sparks = add(new THREE.Points(bg, material(BURST_VERT, POINT_FRAG)), 3.2);

    // the burst's larger shapes: flash, ground ring and column, one quad each per burst
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    sg.setIndex([0, 1, 2, 0, 2, 3]);
    const sBurst = new Float32Array(P.maxBursts * 3), sPart = new Float32Array(P.maxBursts * 3);
    for (let i = 0; i < P.maxBursts * 3; i++) { sBurst[i] = Math.floor(i / 3); sPart[i] = i % 3; }
    sg.setAttribute('aBurst', new THREE.InstancedBufferAttribute(sBurst, 1));
    sg.setAttribute('aPart', new THREE.InstancedBufferAttribute(sPart, 1));
    sg.instanceCount = P.maxBursts * 3;
    shapes = add(new THREE.Mesh(sg, material(SHAPE_VERT, SHAPE_FRAG)), 3.1);

    igniteGeometry = new THREE.BufferGeometry();
    igniteGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    igniteGeometry.setDrawRange(0, 0);
    ignite = add(new THREE.Points(igniteGeometry, material(IGNITE_VERT, IGNITE_FRAG)), 3.3);
    disposables.push(g, bg, sg);

    unsubscribe.push(
      ctx.bus.on('burst', (b) => burst(b.ref, b.kind)),
      ctx.bus.on('minBytes', markHostsDirty),
      ctx.bus.on('typeFilter', markHostsDirty),
      ctx.bus.on('particles', () => ctx.invalidate()),
    );
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    if (info.rebuild) { markHostsDirty(); return; }
    for (const op of batch.ops) {
      if (op.op === 'assign' || ((op.op === 'add' || op.op === 'update' || op.op === 'remove') && op.kind === 'unit')) { markHostsDirty(); return; }
    }
  }

  function reveal(info: RevealInfo): void {
    revealAt = info.instant ? LONG_AGO : info.at + (info.durationMs / 1000) * P.revealDelay;
    if (info.instant || ctx.reducedMotion) return;
    // Each sphere ignites with a small flash. Its birth time is the spheres module's private state,
    // so the same stagger is rebuilt here: city by city from the middle of the map, plus a per-slot jitter.
    const cities = ctx.replica.table('city').slots();
    const pos = ctx.positions.buffers.city, b = ctx.rig.bounds;
    const far = (c: number) => (3 * c + 1 < pos.length ? Math.hypot(pos[3 * c] - b.x, pos[3 * c + 1] - b.z) : 0);
    cities.sort((a, c) => far(a) - far(c) || a - c);
    const height = slotTexHeight(ctx.replica.table('city').capacity);
    const data = new Float32Array(SLOT_TEX_WIDTH * height * 4);
    cities.forEach((c, i) => { data[4 * c] = (i / Math.max(1, cities.length - 1)) * RENDER_LOCAL.reveal.cityStagger; });
    staggerTex?.dispose();
    staggerTex = makeSlotTexture(data, height, THREE.RGBAFormat);
    own.uCityStagger.value = staggerTex;
    const grow = (ctx.config.reveal.growMs * RENDER_LOCAL.reveal.grow) / 1000;
    own.uReveal.value.set(info.at, info.durationMs / 1000, RENDER_LOCAL.reveal.unitJitter, grow);
    igniteUntil = info.at + info.durationMs / 1000 + grow + P.igniteSeconds;
    ensureIgnite();
    ctx.animate(info.durationMs + (grow + P.igniteSeconds + P.fadeIn) * 1000);
  }

  function frame(f: FrameState): void {
    // ambient
    const on = ambientOn() && ctx.state.revealed && f.time >= revealAt;
    ambient.visible = on;
    if (on) {
      if (hostsDirty && f.nowMs - hostsDirtyAt >= P.wind.rehostQuietMs) chooseAmbientHosts();
      const fade = Math.min(1, (f.time - revealAt) / P.fadeIn);
      if (fade !== own.uAmbient.value) { own.uAmbient.value = fade; ctx.invalidate(); }
      const b = ctx.rig.bounds;
      own.uBounds.value.set(b.x - b.r, b.z - b.r, 2 * b.r, 2 * b.r);
    }
    // bursts
    const bursting = f.time < burstsUntil;
    own.uSparks.value = ctx.state.particles ? 1 : 0;
    sparks.visible = bursting && ctx.state.particles;
    shapes.visible = bursting;
    ignite.visible = !!staggerTex && f.time < igniteUntil;
    if (ignite.visible) ensureIgnite();
  }

  function setTheme(mode: ThemeMode): void {
    for (const m of materials) m.blending = blendingFor(mode);
  }

  function dispose(): void {
    for (const off of unsubscribe) off();
    for (const o of objects) ctx.scene.remove(o);
    igniteGeometry?.dispose();
    igniteGeometry = null;
    staggerTex?.dispose();
    staggerTex = null;
    for (const d of disposables) d.dispose();
    for (const m of materials) m.dispose();
    objects.length = materials.length = disposables.length = unsubscribe.length = 0;
  }

  return { name: 'particles', order: 30, init, applyBatch, reveal, frame, setTheme, dispose };
}

export default createParticles;
