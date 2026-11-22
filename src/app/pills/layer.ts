// The in-scene pill pool (PLAN.md §8.4, §17.6): city and district labels as pooled DOM elements,
// positioned from render.project() on every rendered frame by writing `transform` on the nodes.
// No React in here, and no per-frame layout: widths are measured once per label text.
import { config } from '../../config';
import type { Session } from '../../contracts/pipeline';
import type { FrameInfo, RenderApi, ScreenPoint } from '../../contracts/render';
import { cityRef, districtRef, type NodeRef } from '../../model/types';
import { clamp, groundToPixels, sceneObstacles } from '../anchor';
import { useApp } from '../store';
import { sceneFadeFloor } from '../theme';
import { APP_LOCAL } from '../tunables';
import { distanceFade, keepPills, type PillBox, type Rect } from './place';

type Kind = 'city' | 'district';

interface Label {
  ref: NodeRef;
  kind: Kind;
  slot: number;
  name: string;
  /** "212", or "148 / 212" when the size slider hides some. Empty on district pills. */
  count: string;
  aria: string;
  /** Identifies the rendered text, for the width cache and for rebinding a pooled element. */
  sig: string;
}
interface CityLabel extends Label { districts: Label[] }

interface Pill {
  el: HTMLButtonElement;
  nameEl: HTMLSpanElement;
  countEl: HTMLSpanElement;
  label: Label | null;
  sig: string;
  x: number;
  y: number;
  opacity: number;
  /** On screen and interactive; false while fading out before it returns to the pool. */
  shown: boolean;
  hideAt: number;
}

interface Candidate extends PillBox { label: Label; opacity: number }

interface Drag {
  pill: Pill;
  ref: NodeRef;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer position minus the node's projected anchor at the press, so the node does not jump. */
  offsetX: number;
  offsetY: number;
  moved: boolean;
}

/** Shift+arrow moves a focused pill's city or district this far on screen: the keyboard's drag. CSS pixels. */
const KEY_NUDGE_PX = 24;

export interface PillLayer {
  /** Counts or names may have changed (the size slider moved): rebuild the labels on the next update. */
  invalidate(): void;
  dispose(): void;
}

export function createPillLayer(container: HTMLElement, render: RenderApi, session: Session): PillLayer {
  const T = APP_LOCAL.pills;
  const doc = container.ownerDocument;
  const pool: Pill[] = [];
  const byRef = new Map<NodeRef, Pill>();
  const byEl = new WeakMap<Element, Pill>();
  const widths = new Map<string, number>();
  const heights: Partial<Record<Kind, number>> = {};
  let cities: CityLabel[] = [];
  let modelDirty = true;
  let lastFrame: FrameInfo | null = null;
  let view = { width: container.clientWidth, height: container.clientHeight };
  let scheduled = 0;
  let disposed = false;
  let drag: Drag | null = null;
  let suppressClick = false;
  /** The pill that holds the group's one tab stop (roving tabindex), and the order arrow keys walk. */
  let tabRef: NodeRef | null = null;
  let tabPill: Pill | null = null;
  let order: Pill[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<Pill>();
  /** Where the fixed chrome is, in scene coordinates; re-read now and then, never per frame. */
  let chrome: Rect[] = [];
  let chromeReadAt = -Infinity;
  /** The least opacity a distance-faded pill may have, for the mode it was worked out for. */
  let minFade = 0;
  let fadeMode: string | null = null;

  // ---- elements ----

  function createPill(): Pill {
    const el = doc.createElement('button');
    el.type = 'button';
    el.tabIndex = -1;
    el.hidden = true;
    const nameEl = doc.createElement('span');
    nameEl.className = 'gm-scene-pill-name';
    const countEl = doc.createElement('span');
    countEl.className = 'gm-scene-pill-count';
    el.append(nameEl, countEl);
    container.append(el);
    const pill: Pill = { el, nameEl, countEl, label: null, sig: '', x: NaN, y: NaN, opacity: -1, shown: false, hideAt: 0 };
    byEl.set(el, pill);
    return pill;
  }

  function bind(pill: Pill, label: Label): void {
    pill.label = label;
    // Other features (the city summary card) read this to tell which node a pooled pill stands for.
    pill.el.dataset.ref = label.ref;
    if (pill.sig === label.sig) return;
    pill.sig = label.sig;
    pill.el.className = `gm-scene-pill gm-scene-pill-${label.kind}`;
    pill.nameEl.textContent = label.name;
    pill.countEl.textContent = label.count;
    pill.countEl.hidden = label.count === '';
    pill.el.setAttribute('aria-label', label.aria);
  }

  /** One hidden pill measures every label, once per distinct text. */
  const ruler = createPill();
  ruler.el.hidden = false;
  ruler.el.style.visibility = 'hidden';
  ruler.el.setAttribute('aria-hidden', 'true');

  function sizeOf(label: Label): { width: number; height: number } {
    let width = widths.get(label.sig);
    if (width === undefined || heights[label.kind] === undefined) {
      bind(ruler, label);
      width = ruler.el.offsetWidth;
      heights[label.kind] = ruler.el.offsetHeight;
      widths.set(label.sig, width);
    }
    return { width, height: heights[label.kind]! };
  }

  function acquire(label: Label): Pill {
    const pill = pool.pop() ?? createPill();
    bind(pill, label);
    pill.el.hidden = false;
    pill.x = pill.y = NaN;
    pill.opacity = -1;
    byRef.set(label.ref, pill);
    return pill;
  }

  function release(pill: Pill): void {
    if (pill.label) byRef.delete(pill.label.ref);
    pill.label = null;
    pill.shown = false;
    pill.el.hidden = true;
    pill.el.classList.remove('is-dragging');
    if (tabPill === pill) { pill.el.tabIndex = -1; tabPill = null; }
    pool.push(pill);
  }

  // ---- labels from the model ----

  function rebuild(): void {
    modelDirty = false;
    const replica = session.replica;
    const cityTable = replica.table('city'), districtTable = replica.table('district');
    let counts: Map<NodeRef, { visible: number; total: number }>;
    try { counts = render.visibleCounts(); } catch { counts = new Map(); }
    const bySlot: (CityLabel | undefined)[] = [];
    cities = [];
    for (const slot of cityTable.slots()) {
      const ref = cityRef(cityTable.ids[slot]!);
      const name = cityTable.cols.name[slot] || 'City';
      const n = counts.get(ref);
      const hiding = !!n && n.visible < n.total;
      const count = !n ? '' : hiding ? `${n.visible.toLocaleString()} / ${n.total.toLocaleString()}` : n.total.toLocaleString();
      const aria = !n ? name : hiding ? `${name}, ${n.visible} of ${n.total} files shown` : `${name}, ${n.total} ${n.total === 1 ? 'file' : 'files'}`;
      const label: CityLabel = { ref, kind: 'city', slot, name, count, aria, sig: `c|${name}|${count}`, districts: [] };
      bySlot[slot] = label;
      cities.push(label);
    }
    const parent = districtTable.refSlots.city ?? [];
    for (const slot of districtTable.slots()) {
      const city = bySlot[parent[slot] ?? -1];
      const name = districtTable.cols.name[slot];
      if (!city || !name) continue;
      city.districts.push({ ref: districtRef(districtTable.ids[slot]!), kind: 'district', slot, name, count: '', aria: `${name}, a district of ${city.name}`, sig: `d|${name}` });
    }
    // labels are new objects: pills already on screen pick up their new text on the next pass
    if (widths.size > 4096) widths.clear();
  }

  // ---- the fixed chrome: pills do not show through it ----

  function readChrome(now: number): void {
    chromeReadAt = now;
    chrome = [];
    const frame = container.closest('.gm-app')?.querySelector('.gm-frame');
    if (!frame) return;
    const origin = container.getBoundingClientRect();
    for (const el of frame.querySelectorAll<HTMLElement>('.gm-pill, .gm-card, .gm-region-rightEdge > *')) {
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) chrome.push({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height });
    }
  }

  // ---- one pass: choose, then write ----

  function offer(label: Label, at: ScreenPoint, radius: number, opacity: number): void {
    const pill = byRef.get(label.ref);
    const held = !!pill && (drag?.pill === pill || doc.activeElement === pill.el);
    if (opacity <= 0.01 && !held) return;
    const { width, height } = sizeOf(label);
    // the pill sits just above the far edge of its territory, so it does not cover the stars inside
    const lift = Math.min(groundToPixels(render, at, radius, 'y') + T.liftPadPx, view.height * T.maxLiftShare);
    // ... and stays whole inside the view while its anchor is in it, like a label pinned to the edge
    const x = clamp(at.x - width / 2, T.edgePx, view.width - width - T.edgePx);
    const y = clamp(at.y - lift - height, T.edgePx, view.height - height - T.edgePx);
    candidates.push({
      label, x, y, width, height, opacity: held ? 1 : opacity, depth: at.depth,
      tier: held ? 0 : label.kind === 'city' ? 1 : 2, sticky: !!pill && pill.shown,
    });
  }

  function update(): void {
    if (scheduled) { cancelAnimationFrame(scheduled); scheduled = 0; }
    if (disposed) return;
    if (modelDirty) rebuild();
    const now = performance.now();
    const positions = session.physics.positions;
    const cameraDistance = lastFrame?.cameraDistance ?? Infinity;
    // a far pill fades, but never below what keeps its text readable over a bright star (theme.ts)
    const mode = useApp.getState().mode;
    if (mode !== fadeMode) { fadeMode = mode; minFade = sceneFadeFloor(mode); }
    const fade = (depth: number): number => Math.max(minFade, distanceFade(depth, cameraDistance));

    candidates.length = 0;
    for (const city of cities) {
      const at = render.project(city.ref);
      if (!at) continue;
      const radius = positions.city[3 * city.slot + 2] ?? 0;
      if (at.visible) offer(city, at, radius, fade(at.depth));
      // districts are always named, even when their city's centre is off screen; where pills would
      // overlap, the city's wins (keepPills)
      for (const district of city.districts) {
        const dAt = render.project(district.ref);
        if (dAt?.visible) offer(district, dAt, positions.district[3 * district.slot + 2] ?? 0, fade(dAt.depth));
      }
    }

    if (now - chromeReadAt >= T.chromeReadMs) readChrome(now);
    const kept = keepPills(candidates, config.render.maxPills, sceneObstacles.size ? [...chrome, ...sceneObstacles] : chrome);
    seen.clear();
    order = [];
    for (const c of kept) {
      const pill = byRef.get(c.label.ref) ?? acquire(c.label);
      bind(pill, c.label);
      moveTo(pill, c.x, c.y);
      if (Math.abs(pill.opacity - c.opacity) > 0.02 || !pill.shown) {
        pill.opacity = c.opacity;
        pill.el.style.opacity = c.opacity.toFixed(2);
      }
      if (!pill.shown) { pill.shown = true; pill.el.style.pointerEvents = ''; }
      seen.add(pill);
      order.push(pill);
    }
    // a dropped pill fades where it is (still following its anchor), then returns to the pool
    for (const c of candidates) {
      const pill = byRef.get(c.label.ref);
      if (pill && !seen.has(pill)) moveTo(pill, c.x, c.y);
    }
    let fading = false;
    for (const pill of byRef.values()) {
      if (seen.has(pill)) continue;
      if (pill.shown) {
        pill.shown = false;
        pill.hideAt = now;
        pill.opacity = 0;
        pill.el.style.opacity = '0';
        pill.el.style.pointerEvents = 'none';
        fading = true;
      } else if (now - pill.hideAt >= T.fadeMs) {
        release(pill); // deleting the entry being visited is safe in a Map
      } else {
        fading = true;
      }
    }
    if (fading) schedule(); // finish the fades even if the scene is idle

    // one tab stop for the whole group: the pill last focused, else the first one showing
    const next = order.find((p) => p.label?.ref === tabRef) ?? order[0] ?? null;
    if (next !== tabPill) {
      if (tabPill) tabPill.el.tabIndex = -1;
      if (next) next.el.tabIndex = 0;
      tabPill = next;
    }
  }

  function moveTo(pill: Pill, x: number, y: number): void {
    const rx = Math.round(x), ry = Math.round(y);
    if (rx === pill.x && ry === pill.y) return;
    pill.x = rx;
    pill.y = ry;
    pill.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
  }

  function schedule(): void {
    if (!scheduled && !disposed) scheduled = requestAnimationFrame(() => { scheduled = 0; update(); });
  }

  // ---- dragging a pill moves its city or district; a click flies to it ----

  const pillOf = (target: EventTarget | null): Pill | null => {
    const el = target instanceof Element ? target.closest('.gm-scene-pill') : null;
    const pill = el ? byEl.get(el) : undefined;
    return pill && pill.label && pill.shown ? pill : null;
  };

  function local(e: PointerEvent): { x: number; y: number } {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent): void {
    const pill = pillOf(e.target);
    if (!pill || e.button !== 0 || drag) return;
    const ref = pill.label!.ref;
    const at = render.project(ref);
    if (!at) return;
    const p = local(e);
    drag = { pill, ref, pointerId: e.pointerId, startX: p.x, startY: p.y, offsetX: p.x - at.x, offsetY: p.y - at.y, moved: false };
    suppressClick = false;
    try { pill.el.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = local(e);
    if (!drag.moved) {
      if (Math.hypot(p.x - drag.startX, p.y - drag.startY) < T.clickSlopPx) return;
      drag.moved = true;
      drag.pill.el.classList.add('is-dragging');
    }
    // where the node's anchor should now be on screen, taken down to the ground
    const ground = render.screenToGround(p.x - drag.offsetX, p.y - drag.offsetY);
    if (ground) {
      try { session.physics.drag(drag.ref, ground.x, ground.z); } catch (err) { console.warn('starmap: physics.drag failed', err); }
    }
    schedule();
  }

  function endDrag(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { pill, ref, moved } = drag;
    drag = null;
    pill.el.classList.remove('is-dragging');
    try { pill.el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!moved) return;
    suppressClick = true; // the click that follows a drag is not a "fly to"
    setTimeout(() => { suppressClick = false; }, 0);
    try { session.physics.release(ref); } catch (err) { console.warn('starmap: physics.release failed', err); }
    schedule();
  }

  function onClick(e: MouseEvent): void {
    const pill = pillOf(e.target);
    if (!pill) return;
    if (suppressClick) { suppressClick = false; return; }
    void render.flyTo(pill.label!.ref).catch(() => {});
  }

  /** The keyboard's drag: one step on screen, then let go, exactly as a short drag with the pointer would. */
  function nudge(pill: Pill, dx: number, dy: number): void {
    const ref = pill.label!.ref;
    const at = render.project(ref);
    const ground = at ? render.screenToGround(at.x + dx, at.y + dy) : null;
    if (!ground) return;
    try {
      session.physics.drag(ref, ground.x, ground.z);
      session.physics.release(ref);
    } catch (err) { console.warn('starmap: physics.drag failed', err); }
    schedule();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const step = dx || dy;
    const pill = step === 0 ? null : pillOf(e.target);
    if (!pill || order.length === 0) return;
    e.preventDefault();
    if (e.shiftKey) { nudge(pill, dx * KEY_NUDGE_PX, dy * KEY_NUDGE_PX); return; }
    const at = order.indexOf(pill);
    order[(at + step + order.length) % order.length]!.el.focus();
  }

  function onFocusIn(e: FocusEvent): void {
    const pill = pillOf(e.target);
    if (pill) { tabRef = pill.label!.ref; schedule(); }
  }

  /** The wheel zooms the map even when the pointer happens to be over a pill. */
  function onWheel(e: WheelEvent): void {
    const canvas = container.parentElement?.querySelector('canvas');
    if (!canvas || !pillOf(e.target)) return;
    e.preventDefault();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
    }));
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);
  container.addEventListener('lostpointercapture', endDrag);
  container.addEventListener('click', onClick);
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('focusin', onFocusIn);
  container.addEventListener('wheel', onWheel, { passive: false });

  // ---- what makes a pass necessary ----

  const offFrame = render.on('frame', (frame) => { lastFrame = frame; update(); });
  const offReplica = session.replica.subscribe(() => { modelDirty = true; schedule(); });
  const resize = new ResizeObserver(() => {
    view = { width: container.clientWidth, height: container.clientHeight };
    schedule();
  });
  resize.observe(container);
  // text set in a fallback font was measured too early
  const onFonts = () => { widths.clear(); schedule(); };
  doc.fonts?.addEventListener('loadingdone', onFonts);
  schedule();

  return {
    invalidate() { modelDirty = true; schedule(); },
    dispose() {
      disposed = true;
      if (scheduled) cancelAnimationFrame(scheduled);
      offFrame();
      offReplica();
      resize.disconnect();
      doc.fonts?.removeEventListener('loadingdone', onFonts);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', endDrag);
      container.removeEventListener('pointercancel', endDrag);
      container.removeEventListener('lostpointercapture', endDrag);
      container.removeEventListener('click', onClick);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('wheel', onWheel);
      if (drag) { try { session.physics.release(drag.ref); } catch { /* the session is going away */ } }
      container.replaceChildren();
    },
  };
}
