// In the scene: a label pill on every point of interest's beam, and the detail card a pill opens
// (PLAN.md §8.4, §17.6). React renders the elements when the model changes; where they sit is
// written straight onto them on every rendered frame, never through React state.
import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { FrameInfo } from '../../contracts/render';
import { groundToPixels } from '../anchor';
import { setFocus, useApp, useRender, useReplica, useSession } from '../store';
import { PillButton, cx } from '../ui';
import { placeCard, placePills, type PillRequest, type Rect, type Size } from './layout';
import { PoiCard } from './PoiCard';
import { livePois, type LivePoi } from './pois';
import { closePoi, openPoi, usePoiUi } from './state';
import { POI_UI } from './tunables';
import './poi.css';

/** Write a position only when it changed, so an idle frame touches no style. */
function moveTo(el: HTMLElement, x: number, y: number): void {
  const transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  if (el.style.transform !== transform) el.style.transform = transform;
  if (!el.hasAttribute('data-placed')) el.setAttribute('data-placed', '');
}

function PointsOfInterest() {
  const render = useRender();
  const replica = useReplica();
  const session = useSession();
  const openId = usePoiUi((s) => s.openId);

  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const pills = useRef(new Map<string, HTMLButtonElement>());
  const sizes = useRef(new Map<HTMLElement, Size>());
  /** Where the open card was last anchored: it stays there while its star is off screen. */
  const lastAnchor = useRef<Rect | null>(null);
  const focusCard = useRef(false);

  const pois: LivePoi[] = replica ? livePois(replica, config.visual) : [];
  const open = openId === null ? null : (pois.find((p) => p.poi.id === openId) ?? null);
  const live = useRef({ pois, openId });
  live.current = { pois, openId };

  // ---- placement: once per rendered frame, and after every React render ----
  const update = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!render) { update.current = () => {}; return; }
    const sizeOf = (el: HTMLElement): Size => {
      let size = sizes.current.get(el);
      if (!size) { size = { width: el.offsetWidth, height: el.offsetHeight }; sizes.current.set(el, size); }
      return size;
    };
    /** CSS pixels that one world unit covers at camera distance 1; 0 until a frame has measured it. */
    let pixelsAtUnitDepth = 0;
    const place = (frame?: FrameInfo) => {
      const view = host.current;
      if (!view) return;
      if (frame) {
        // the camera looks at its ground target, so the ground in the middle of the view is at cameraDistance
        const middle = { x: view.clientWidth / 2, y: view.clientHeight / 2, visible: true, depth: frame.cameraDistance };
        const px = groundToPixels(render, middle, 1, 'x');
        if (px > 0) pixelsAtUnitDepth = px * frame.cameraDistance;
      }
      const { pois: list, openId: openNow } = live.current;
      const selection = useApp.getState().selection;
      const focused = document.activeElement;
      const requests: PillRequest[] = [];
      let openBase: Rect | null = null;
      for (const { poi, parent } of list) {
        const el = pills.current.get(poi.id);
        const at = el ? render.project(poi.parent) : null;
        if (!el || !at || !at.visible) continue;
        const size = sizeOf(el);
        // the pill sits on the beam just above the star, which is larger while it is selected
        const radius = parent.radius * (selection.includes(poi.parent) ? config.visual.selectedScale : 1);
        const radiusPx = pixelsAtUnitDepth > 0 && at.depth > 0 ? (radius * pixelsAtUnitDepth) / at.depth : groundToPixels(render, at, radius, 'x');
        const lift = radiusPx + POI_UI.pill.liftPx;
        const request: PillRequest = {
          id: poi.id, x: at.x, y: at.y - lift, ...size,
          priority: poi.id === openNow ? -2 : el === focused ? -1 : at.depth,
        };
        requests.push(request);
        if (poi.id === openNow) openBase = { x: request.x - size.width / 2, y: request.y - size.height, ...size };
      }
      const placed = placePills(requests, POI_UI.pill.gapPx, POI_UI.pill.maxNudges);
      for (const { poi } of list) {
        const el = pills.current.get(poi.id);
        if (!el) continue;
        const rect = placed.get(poi.id);
        if (rect) moveTo(el, rect.x, rect.y);
        else if (el.hasAttribute('data-placed')) el.removeAttribute('data-placed');
      }
      const box = card.current;
      if (!box || openNow === null) { lastAnchor.current = null; return; }
      // opened from elsewhere (the tour) while its star is out of view: the middle of the view will do
      const anchor = placed.get(openNow) ?? openBase ?? lastAnchor.current
        ?? { x: view.clientWidth / 2, y: view.clientHeight / 2, width: 0, height: 0 };
      lastAnchor.current = anchor;
      const { gapPx: gap, marginPx: margin, topMarginPx: topMargin, risePx: rise } = POI_UI.card;
      const spot = placeCard(anchor, sizeOf(box), { width: view.clientWidth, height: view.clientHeight }, { gap, margin, topMargin, rise });
      moveTo(box, spot.x, spot.y);
    };
    update.current = () => place();
    place();
    const off = render.on('frame', place);
    return () => { off(); update.current = () => {}; };
  }, [render]);

  // a render may have added, removed or resized elements: measure again and place at once
  useLayoutEffect(() => {
    sizes.current.clear();
    update.current();
    if (focusCard.current && card.current) { focusCard.current = false; card.current.focus(); }
  });

  // fonts arriving, or an answer filling the card, change sizes without a render of this component
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const e of entries) sizes.current.delete(e.target as HTMLElement);
      update.current();
    });
    for (const el of pills.current.values()) observer.observe(el);
    if (card.current) observer.observe(card.current);
    return () => observer.disconnect();
  });

  // ---- the open card ----
  useEffect(() => closePoi, [session]);
  useEffect(() => { if (openId !== null && replica && !open) closePoi(); }, [openId, open, replica]);

  useEffect(() => {
    if (openId === null) return;
    let down: { x: number; y: number } | null = null;
    const ours = (target: EventTarget | null) =>
      target instanceof Element && (card.current?.contains(target) || target.closest('.gm-poi-pill') !== null);
    const onDown = (e: PointerEvent) => { down = ours(e.target) ? null : { x: e.clientX, y: e.clientY }; };
    // a click elsewhere closes the card; dragging the map to look around does not
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < POI_UI.clickSlopPx) closePoi();
      down = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // Escape closes this card first; the next one clears the selection
      closePoi();
      pills.current.get(openId)?.focus();
    };
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [openId]);

  const toggle = (id: string, e: MouseEvent) => {
    if (openId === id) { closePoi(); return; }
    // one card on a star at a time: the file detail card gives way, the selection stays
    setFocus(null);
    focusCard.current = e.detail === 0; // opened from the keyboard: move focus into the card
    openPoi(id);
  };

  if (!render || pois.length === 0) return null;
  return (
    <div className="gm-poi-layer" ref={host}>
      <div role="group" aria-label="Points of interest">
        {pois.map(({ poi }) => (
          <PillButton
            key={poi.id}
            size="small"
            className={cx('gm-poi-pill', openId === poi.id && 'is-open')}
            aria-haspopup="dialog"
            aria-expanded={openId === poi.id}
            ref={(el) => {
              if (el) pills.current.set(poi.id, el); else pills.current.delete(poi.id);
            }}
            onClick={(e) => toggle(poi.id, e)}
          >
            {poi.label}
          </PillButton>
        ))}
      </div>
      {open && <PoiCard key={open.poi.id} poi={open.poi} parent={open.parent} render={render} ref={card} />}
    </div>
  );
}

// after the city and district pills (order 0), so a point of interest draws over them
const mount: AppMount = { region: 'scene', order: 20, Component: PointsOfInterest };
export default mount;
