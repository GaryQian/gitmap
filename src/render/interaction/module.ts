// Interaction (PLAN.md §9, §7.4): picking, hover, click, double-click, the Shift+drag marquee, the
// Home and Escape keys, and the jiggle spring layer. A scene module: it takes pointer input through
// ctx.pointer above the camera (which keeps its drags), reads rest positions from ctx.positions, and
// talks to the spheres through their service. Nothing here writes a layout position.
//
// What other modules can use:
//   ctx.bus.on('hover', ({ slot, ref }) => …)                  the hovered sphere changed
//   ctx.service<InteractionApi>('interaction')?.hoveredSlot()   the current one
import * as THREE from 'three';
import { GEN_ANY, GEN_DISTRICT0, type Vec2 } from '../../contracts/physics';
import { unitRef, type NodeRef, type PatchBatch } from '../../model/types';
import type { PointerHandler, PointerInfo } from '../core/pointer';
import { RENDER_LOCAL } from '../core/tunables';
import type { BatchInfo, FrameState, SceneContext, SceneModule } from '../core/types';
import { touchedUnits } from '../core/unitRow';
import type { SpheresApi } from '../spheres/module';
import { JiggleField, NeighbourHash, neighbourShare } from './jiggle';
import { rectFrom, unitsInRect } from './marquee';
import { buildPickIndex, pickUnit, rayThroughPixel, type PickIndex } from './picking';
import { INTERACTION_LOCAL } from './tunables';

/** What other modules get from `ctx.service<InteractionApi>('interaction')`. */
export interface InteractionApi {
  /** Unit slot of the hovered sphere, or −1. Changes are announced on `ctx.bus` as `hover`. */
  hoveredSlot(): number;
  /** Unit slot of the sphere under a canvas-relative pixel (rest positions; hidden spheres are skipped), or −1. */
  pick(x: number, y: number): number;
}

const L = INTERACTION_LOCAL;
const J = L.jiggle;
/** Floats per unit in ctx.units.info: [radius, district slot, city slot, glow]. */
const INFO = 4;

// A rectangle in normalised device coordinates, drawn over everything: a faint fill and a thin
// outline in the theme's accent colour.
const MARQUEE_VERT = /* glsl */ `
uniform vec4 uRect;
varying vec2 vUv;
void main() { vUv = position.xy; gl_Position = vec4(mix(uRect.xy, uRect.zw, position.xy), 0.0, 1.0); }`;
const MARQUEE_FRAG = /* glsl */ `
uniform vec3 uHalo; uniform vec2 uSizePx; uniform vec3 uLook;
varying vec2 vUv;
void main() {
  vec2 px = vUv * uSizePx;
  float edge = min(min(px.x, uSizePx.x - px.x), min(px.y, uSizePx.y - px.y));
  float line = 1.0 - smoothstep(uLook.z, uLook.z + 1.0, edge);
  gl_FragColor = vec4(uHalo, mix(uLook.x, uLook.y, line));
}`;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function createInteraction(): SceneModule {
  let ctx!: SceneContext;
  let spheres: SpheresApi | undefined;
  /** Rebuilt on the next pick after a batch that touched units or districts. */
  let index: PickIndex | null = null;
  const hashes = new Map<number, { gen: number; unit: Float32Array; maxRadius: number; hash: NeighbourHash }>();
  const cleanup: (() => void)[] = [];
  const scratch = new THREE.Vector3();
  const viewProjection = new THREE.Matrix4();

  // ---- pointer state ----
  const ptr = {
    inside: false, touch: false, x: 0, y: 0, clientX: 0, clientY: 0,
    /** Ground point under the pointer at its last free move, and the pointer's ground velocity. */
    ground: null as Vec2 | null, groundTime: 0, vx: 0, vz: 0,
  };
  /** The sphere under the pointer right now, before any hover delay. */
  let raw = -1;
  /** The sphere waiting out the hover delay, or already hovered. */
  let candidate = -1;
  let hovered = -1;
  let hoveredId: string | null = null;
  /** Hover dismissed with Escape: stays off until the pointer leaves that sphere. */
  let dismissed = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastClick: { t: number; x: number; y: number; slot: number; id: string | null } | null = null;
  /** The browser's count for the current press (mousedown.detail: 2 for a double-click's second); 0 when it sent none. */
  let pressCount = 0;
  let marquee: { x0: number; y0: number; x1: number; y1: number; moved: boolean; cancelled: boolean } | null = null;
  let quad: THREE.Mesh | null = null;
  const quadUniforms = {
    uRect: { value: new THREE.Vector4() }, uSizePx: { value: new THREE.Vector2(1, 1) },
    uLook: { value: new THREE.Vector3(L.marquee.fill, L.marquee.line, L.marquee.linePx) },
  };
  const seenView = { x: NaN, z: NaN, distance: NaN, azimuth: NaN, elevation: NaN, width: 0, height: 0 };
  let wasDragging = false;

  // ---- jiggle ----
  let field!: JiggleField;
  let lastStep = 0;

  const sphereApi = () => (spheres ??= ctx.service<SpheresApi>('spheres'));
  const isShown = (slot: number) => sphereApi()?.isShown(slot) ?? true;
  const nudge = (slot: number, x: number, z: number) => sphereApi()?.setNudge(slot, x, 0, z);

  function refOf(slot: number): NodeRef | null {
    const id = slot >= 0 ? ctx.replica.table('unit').ids[slot] : null;
    return id == null ? null : unitRef(id);
  }

  // ---- picking ----
  function getIndex(): PickIndex {
    if (!index) index = buildPickIndex(ctx.units.info, ctx.replica.table('unit').capacity, INFO);
    return index;
  }

  function pickAt(x: number, y: number): number {
    if (!ctx.state.revealed) return -1;
    const rig = ctx.rig;
    const ray = rayThroughPixel(ctx.camera, rig.width, rig.height, x, y, scratch);
    const hit = pickUnit(ray, getIndex(), ctx.positions.buffers, {
      isShown, minRadiusPerDistance: L.pick.minRadiusPx * rig.worldPerPixel(1), maxDistance: ctx.camera.far,
    });
    return hit ? hit.slot : -1;
  }

  // ---- hover ----
  function stopTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function commit(slot: number): void {
    const ref = refOf(slot);
    if (!ref) slot = -1;
    if (slot === hovered) return;
    hovered = slot;
    hoveredId = slot >= 0 ? ctx.replica.table('unit').ids[slot] : null;
    sphereApi()?.setHover(slot);
    ctx.bus.emit('hover', { slot, ref });
    ctx.emit('hover', { ref, x: ptr.clientX, y: ptr.clientY });
    ctx.invalidate();
  }

  /** The sphere under the pointer changed: drop the old hover at once, start the delay for the new one. */
  function setCandidate(slot: number): void {
    if (slot === candidate) return;
    candidate = slot;
    stopTimer();
    if (hovered >= 0 && slot !== hovered) commit(-1);
    if (slot < 0 || slot === hovered) return;
    timer = setTimeout(() => {
      timer = null;
      if (candidate !== slot) return;
      if (ptr.inside && !marquee && !ctx.pointer.dragging && pickAt(ptr.x, ptr.y) === slot) commit(slot);
      else { candidate = -1; evaluate(); }
    }, ctx.config.interaction.hoverDelayMs);
  }

  /** Look again at what is under the pointer (it moved, or the scene moved under it). */
  function evaluate(): void {
    if (!ptr.inside || ptr.touch || marquee) { raw = -1; setCandidate(-1); return; }
    raw = pickAt(ptr.x, ptr.y);
    if (raw !== dismissed) dismissed = -1;
    // no hover starts in the middle of a drag; the one in place stays while it is still under the pointer
    const blocked = raw === dismissed || (ctx.pointer.dragging && raw !== hovered);
    setCandidate(blocked ? -1 : raw);
  }

  function clearHover(): void {
    stopTimer();
    candidate = -1;
    commit(-1);
  }

  // ---- jiggle ----
  function districtHash(d: number) {
    const idx = getIndex(), pos = ctx.positions.buffers;
    const at = GEN_DISTRICT0 + d < pos.gen.length ? GEN_DISTRICT0 + d : GEN_ANY;
    const gen = Atomics.load(pos.gen, at);
    let h = hashes.get(d);
    if (!h || h.gen !== gen || h.unit !== pos.unit) {
      if (hashes.size >= 8) hashes.clear();
      let maxRadius = 0;
      for (let i = idx.districtStart[d]; i < idx.districtStart[d + 1]; i++) maxRadius = Math.max(maxRadius, idx.radius[idx.unitList[i]]);
      const cell = Math.max(1e-3, 2 * maxRadius * J.neighbourReach);
      h = { gen, unit: pos.unit, maxRadius, hash: new NeighbourHash(idx.unitList, idx.districtStart[d], idx.districtStart[d + 1], pos.unit, cell) };
      hashes.set(d, h);
    }
    return h;
  }

  function wake(): void {
    if (!field.size) return;
    ctx.animate(ctx.config.interaction.jiggleSettleMs + 100);
    ctx.invalidate();
  }

  /** The pointer swept onto a sphere: it takes an impulse along the pointer's travel, its neighbours a share. */
  function sweep(slot: number): void {
    const idx = getIndex(), unit = ctx.positions.buffers.unit;
    const r = idx.radius[slot], d = ctx.units.info[INFO * slot + 1];
    if (!(r > 0) || !(d >= 0) || d >= idx.districtStart.length - 1 || 2 * slot + 1 >= unit.length) return;
    let vx = ptr.vx * J.impulseGain, vz = ptr.vz * J.impulseGain;
    const speed = Math.hypot(vx, vz), cap = field.maxSpeed(r);
    if (speed > cap) { vx *= cap / speed; vz *= cap / speed; }
    if (!field.size) lastStep = performance.now();
    if (!field.kick(slot, r, vx, vz, true)) return;
    const h = districtHash(d);
    h.hash.near(unit[2 * slot], unit[2 * slot + 1], (r + h.maxRadius) * J.neighbourReach, (n, _dx, _dz, distance) => {
      if (n === slot) return;
      const share = neighbourShare(distance, r, idx.radius[n], J.neighbourShare, J.neighbourReach);
      if (share > 0 && isShown(n)) field.kick(n, idx.radius[n], vx * share, vz * share);
    });
    wake();
  }

  /** A click's ring: the neighbours it touches are pushed outward (PLAN.md §8.6). */
  function ring(slot: number): void {
    if (ctx.reducedMotion || slot < 0) return;
    const idx = getIndex(), unit = ctx.positions.buffers.unit;
    const r = idx.radius[slot], d = ctx.units.info[INFO * slot + 1];
    if (!(r > 0) || !(d >= 0) || d >= idx.districtStart.length - 1 || 2 * slot + 1 >= unit.length) return;
    const reach = r * J.selectRingRadii;
    if (!field.size) lastStep = performance.now();
    districtHash(d).hash.near(unit[2 * slot], unit[2 * slot + 1], reach, (n, dx, dz, distance) => {
      if (n === slot || !(distance > 0) || !isShown(n)) return;
      const rn = idx.radius[n];
      const k = (J.selectRingKick * (1 - distance / reach) * field.maxSpeed(rn)) / distance;
      field.kick(n, rn, dx * k, dz * k);
    });
    wake();
  }

  function trackVelocity(p: PointerInfo): void {
    const now = performance.now();
    const g = ctx.rig.groundAt(p.x, p.y);
    const dt = now - ptr.groundTime;
    if (g && ptr.ground && dt > 0 && dt < J.velocityWindowMs) {
      const k = 1000 / dt;
      ptr.vx = 0.5 * ptr.vx + 0.5 * (g.x - ptr.ground.x) * k;
      ptr.vz = 0.5 * ptr.vz + 0.5 * (g.z - ptr.ground.z) * k;
    } else if (dt >= J.velocityWindowMs || !g) {
      ptr.vx = ptr.vz = 0;
    }
    if (dt > 0 || !ptr.ground) { ptr.ground = g; ptr.groundTime = now; }
  }

  // ---- marquee ----
  function drawMarquee(): void {
    if (!quad) return;
    const m = marquee;
    quad.visible = !!m && m.moved && !m.cancelled;
    if (m && quad.visible) {
      const r = rectFrom(m.x0, m.y0, m.x1, m.y1), w = ctx.rig.width, h = ctx.rig.height;
      quadUniforms.uRect.value.set((r.x0 / w) * 2 - 1, 1 - (r.y1 / h) * 2, (r.x1 / w) * 2 - 1, 1 - (r.y0 / h) * 2);
      const dpr = ctx.uniforms.uPixelRatio.value;
      quadUniforms.uSizePx.value.set(Math.max(1, (r.x1 - r.x0) * dpr), Math.max(1, (r.y1 - r.y0) * dpr));
    }
    ctx.invalidate();
  }

  function finishMarquee(cancelled: boolean): void {
    const m = marquee;
    marquee = null;
    drawMarquee();
    if (!m || cancelled || m.cancelled || !m.moved) return;
    const cam = ctx.camera;
    viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const slots = unitsInRect(rectFrom(m.x0, m.y0, m.x1, m.y1), viewProjection.elements, ctx.rig.width, ctx.rig.height, getIndex(), ctx.positions.buffers, isShown);
    const refs: NodeRef[] = [];
    for (const s of slots) { const ref = refOf(s); if (ref) refs.push(ref); }
    ctx.emit('marquee', { refs });
  }

  // ---- click ----
  function burst(ref: NodeRef, kind: 'select' | 'open'): void {
    // the path RenderApi.burst takes, so the particles module reacts
    ctx.bus.emit('burst', { ref, kind });
    ctx.invalidate();
  }

  /** Ease the camera to centre a sphere, coming closer only when it is far away. */
  function focus(ref: NodeRef): void {
    const a = ctx.anchor(ref);
    if (!a) return;
    const close = Math.max(ctx.config.camera.minDistance, a.r * RENDER_LOCAL.camera.unitFocusRadii);
    const distance = Math.min(ctx.rig.view.distance, close * L.click.focusSlack);
    void ctx.rig.flyTo({ x: a.x, z: a.z, distance }, ctx.reducedMotion ? 0 : ctx.config.camera.flyMs, performance.now());
    ctx.invalidate();
  }

  /**
   * The click this press repeats, when it is the second of a double-click. The browser's own count
   * decides (within a generous time, so a stale click is never picked up); where it sent none
   * (touch), time alone does.
   */
  function earlierClick(p: PointerInfo, now: number) {
    if (!lastClick || Math.hypot(p.x - lastClick.x, p.y - lastClick.y) > L.click.doubleSlopPx) return null;
    const age = now - lastClick.t;
    return (pressCount > 0 ? pressCount >= 2 && age < 2 * L.click.doubleMs : age < L.click.doubleMs) ? lastClick : null;
  }

  function note(p: PointerInfo): void {
    ptr.x = p.x; ptr.y = p.y; ptr.clientX = p.clientX; ptr.clientY = p.clientY;
    ptr.touch = p.pointerType === 'touch';
  }

  const handler: PointerHandler = {
    name: 'interaction',
    priority: 10,
    down(p) {
      note(p);
      ptr.inside = true;
      pressCount = 0;
      if (p.button !== 0 || !p.shift || p.space || !ctx.state.revealed) return false;
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, cancelled: false };
      raw = -1;
      setCandidate(-1);
      return true;
    },
    move(p, captured) {
      note(p);
      if (captured) {
        const m = marquee;
        if (!m) return true;
        m.x1 = p.x; m.y1 = p.y;
        if (Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > RENDER_LOCAL.pointer.clickSlopPx) m.moved = true;
        drawMarquee();
        return true;
      }
      ptr.inside = true;
      const before = raw;
      trackVelocity(p);
      evaluate();
      if (!ctx.reducedMotion && raw >= 0 && raw !== before) sweep(raw);
      return false;
    },
    up(_p, cancelled) { finishMarquee(cancelled); },
    click(p) {
      if (p.button !== 0) return false;
      const now = performance.now();
      // the second click of a double-click is not a new click: `dblclick` follows
      if (earlierClick(p, now)) return true;
      const slot = pickAt(p.x, p.y);
      const ref = refOf(slot);
      lastClick = { t: now, x: p.x, y: p.y, slot: ref ? slot : -1, id: ref ? ctx.replica.table('unit').ids[slot] : null };
      if (ref && !p.shift && L.click.focus) focus(ref);
      ctx.emit('click', { ref, shift: p.shift, x: p.clientX, y: p.clientY });
      if (ref) { burst(ref, 'select'); ring(slot); }
      return true;
    },
    dblclick(p) {
      if (p.button !== 0) return false;
      // what the first click hit, when there was one: the camera may already be easing toward it
      const first = earlierClick(p, performance.now())?.slot ?? -1;
      const ref = refOf(first >= 0 ? first : pickAt(p.x, p.y));
      lastClick = null;
      if (!ref) return true;
      // the second press stopped the flight the first click began (any press takes the camera): resume it
      if (!p.shift && L.click.focus) focus(ref);
      ctx.emit('dblclick', { ref, x: p.clientX, y: p.clientY });
      burst(ref, 'open');
      return true;
    },
    leave() {
      ptr.inside = false;
      ptr.ground = null;
      raw = -1;
      dismissed = -1;
      setCandidate(-1);
    },
  };

  // ---- module hooks ----
  function init(context: SceneContext): void {
    ctx = context;
    const { config, canvas } = ctx;
    field = new JiggleField({
      settleMs: config.interaction.jiggleSettleMs, maxRadii: config.interaction.jiggleMax,
      damping: J.damping, restFraction: J.restFraction, maxActive: J.maxActive,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.ShaderMaterial({
      uniforms: { ...quadUniforms, uHalo: ctx.uniforms.uHalo }, vertexShader: MARQUEE_VERT, fragmentShader: MARQUEE_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    quad.renderOrder = 100;
    quad.visible = false;
    ctx.scene.add(quad);

    cleanup.push(ctx.pointer.add(handler));

    // The router does not show a captured drag to other handlers, so the pointer's position during
    // the camera's drags is followed here: hover is looked at again where the drag ends.
    const onMove = (e: PointerEvent) => {
      if (!ctx.pointer.dragging || marquee) return;
      const rect = canvas.getBoundingClientRect();
      ptr.x = e.clientX - rect.left; ptr.y = e.clientY - rect.top; ptr.clientX = e.clientX; ptr.clientY = e.clientY;
      ptr.inside = ptr.x >= 0 && ptr.y >= 0 && ptr.x <= rect.width && ptr.y <= rect.height;
      ptr.ground = null;
    };
    canvas.addEventListener('pointermove', onMove);
    cleanup.push(() => canvas.removeEventListener('pointermove', onMove));
    const onMouseDown = (e: MouseEvent) => { if (e.button === 0) pressCount = e.detail; };
    canvas.addEventListener('mousedown', onMouseDown);
    cleanup.push(() => canvas.removeEventListener('mousedown', onMouseDown));

    const onKey = (e: KeyboardEvent) => {
      // keys typed into a field belong to the field
      if (e.defaultPrevented || isTyping(e.target)) return;
      if (e.key === 'Home' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void ctx.rig.flyTo(ctx.rig.defaultView(), ctx.reducedMotion ? 0 : config.camera.flyMs, performance.now());
        ctx.invalidate();
      } else if (e.key === 'Escape') {
        // not consumed: cards and the sidebar may close on the same key
        if (marquee) { marquee.cancelled = true; drawMarquee(); }
        dismissed = raw;
        clearHover();
      }
    };
    window.addEventListener('keydown', onKey);
    cleanup.push(() => window.removeEventListener('keydown', onKey));

    cleanup.push(ctx.bus.on('minBytes', () => {
      // a sphere the slider just hid cannot stay hovered
      if (hovered >= 0 && !isShown(hovered)) clearHover();
    }));

    const api: InteractionApi = { hoveredSlot: () => hovered, pick: pickAt };
    ctx.provide('interaction', api);
  }

  function applyBatch(batch: PatchBatch, info: BatchInfo): void {
    const touched = info.rebuild ? null : touchedUnits(batch);
    if (!touched || touched.all || touched.slots.length) { index = null; hashes.clear(); }
    const ids = ctx.replica.table('unit').ids;
    if (hovered >= 0 && ids[hovered] !== hoveredId) clearHover();
    if (lastClick && lastClick.slot >= 0 && ids[lastClick.slot] !== lastClick.id) lastClick = null;
    if (!field.size) return;
    if (info.rebuild) field.clear(nudge);
    else for (const s of field.slots()) if (!(ctx.units.info[INFO * s] > 0)) field.drop(s, nudge);
  }

  function frame(f: FrameState): void {
    // the scene moved under a resting pointer (zoom, orbit, a flight), or a drag began or ended
    const v = ctx.rig.view, w = ctx.rig.width, h = ctx.rig.height;
    const dragging = ctx.pointer.dragging;
    const moved = v.x !== seenView.x || v.z !== seenView.z || v.distance !== seenView.distance || v.azimuth !== seenView.azimuth
      || v.elevation !== seenView.elevation || w !== seenView.width || h !== seenView.height;
    if (moved) { seenView.x = v.x; seenView.z = v.z; seenView.distance = v.distance; seenView.azimuth = v.azimuth; seenView.elevation = v.elevation; seenView.width = w; seenView.height = h; }
    if ((moved || dragging !== wasDragging) && (ptr.inside || hovered >= 0) && !marquee) evaluate();
    wasDragging = dragging;

    // nothing is integrated while no sphere is active
    if (!field.size) return;
    const dt = Math.min(0.1, Math.max(0, (f.nowMs - lastStep) / 1000));
    lastStep = f.nowMs;
    field.step(dt, nudge);
    if (field.size) ctx.invalidate();
  }

  function dispose(): void {
    stopTimer();
    for (const off of cleanup) off();
    cleanup.length = 0;
    if (quad) {
      ctx.scene.remove(quad);
      quad.geometry.dispose();
      (quad.material as THREE.Material).dispose();
      quad = null;
    }
    marquee = null;
    index = null;
    hashes.clear();
  }

  return { name: 'interaction', init, applyBatch, frame, dispose };
}

export default createInteraction;
