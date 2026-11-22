// In the scene: a label pill on every point of interest's beam, and the detail card a pill opens
// (PLAN.md §8.4, §17.6). React renders the elements when the model changes; where they sit is
// written straight onto them on every rendered frame, never through React state.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { config } from '../../config';
import type { AppMount } from '../../contracts/app';
import type { FrameInfo } from '../../contracts/render';
import { groundToPixels } from '../anchor';
import { LAYER, useDismissable } from '../keys';
import { setFocus, useApp, useRender, useReplica, useSession } from '../store';
import { onUiScale, shownSize } from '../uiScale';
import { PillButton, cx } from '../ui';
import { placeCard, placePills, type PillRequest, type Rect, type Size } from './layout';
import { PoiCard } from './PoiCard';
import { livePois, type LivePoi } from './pois';
import { closePoi, openPoi, usePoiUi } from './state';
import { POI_UI } from './tunables';
import './poi.css';

/** The open card's id: its pill points here with `aria-controls`. One card is open at a time. */
const CARD_ID = 'gm-poi-card';

/** Write a position only when it changed, so an idle frame touches no style. */
function moveTo(el: HTMLElement, x: number, y: number): void {
  const transform = `${Math.round(x)}px ${Math.round(y)}px`;
  if (el.style.translate !== transform) el.style.translate = transform;
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
  /** The pill that holds the group's one tab stop (roving tabindex): the one last focused, while it is on screen. */
  const tabId = useRef<string | null>(null);

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
      if (!size) { size = shownSize(el); sizes.current.set(el, size); }
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
      // one tab stop for the whole group, on a pill that is on screen: Tab does not walk every beam
      const stop = tabId.current !== null && placed.has(tabId.current) ? tabId.current
        : openNow !== null && placed.has(openNow) ? openNow
        : (list.find(({ poi }) => placed.has(poi.id))?.poi.id ?? null);
      for (const { poi } of list) {
        const el = pills.current.get(poi.id);
        const tabIndex = poi.id === stop ? 0 : -1;
        if (el && el.tabIndex !== tabIndex) el.tabIndex = tabIndex;
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

  // another scale (uiScale.ts) gives every pill and card another size on screen
  useEffect(() => onUiScale(() => { sizes.current.clear(); update.current(); }), []);

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
  // the legend's "POI beams" switch takes the label pills (and an open card) with the beams
  const beamsOn = useApp((s) => s.settings.poiBeams);
  useEffect(() => { if (!beamsOn) closePoi(); }, [beamsOn]);
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
    // capture: the map canvas takes pointer events for itself
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [openId]);

  // Closing from the card (its button, or Escape while the focus is in it) gives the focus back to the pill.
  const close = () => {
    const active = document.activeElement;
    const back = openId !== null && (!active || active === document.body || (card.current?.contains(active) ?? false));
    closePoi();
    if (back) pills.current.get(openId)?.focus();
  };
  // Escape closes this card first; a later press clears the selection (keys.ts)
  useDismissable(openId !== null, close, { layer: LAYER.card });

  const toggle = (id: string, e: MouseEvent) => {
    if (openId === id) { closePoi(); return; }
    // one card on a star at a time: the file detail card gives way, the selection stays
    setFocus(null);
    focusCard.current = e.detail === 0; // opened from the keyboard: move focus into the card
    openPoi(id);
  };

  // arrow keys move between the pills on screen, as they do between city pills
  const onGroupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const shown = pois.map(({ poi }) => pills.current.get(poi.id)).filter((el): el is HTMLButtonElement => !!el && el.hasAttribute('data-placed'));
    const at = shown.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    shown[(at + step + shown.length) % shown.length]!.focus();
  };

  if (!render || pois.length === 0 || !beamsOn) return null;
  return (
    <div className="gm-poi-layer" ref={host}>
      <div role="group" aria-label="Points of interest" aria-description="Arrow keys move between them. Enter opens one." onKeyDown={onGroupKey}>
        {pois.map(({ poi }) => (
          <PillButton
            key={poi.id}
            size="small"
            className={cx('gm-poi-pill', openId === poi.id && 'is-open')}
            aria-expanded={openId === poi.id}
            aria-controls={openId === poi.id ? CARD_ID : undefined}
            tabIndex={-1}
            onFocus={() => { tabId.current = poi.id; }}
            ref={(el) => {
              if (el) pills.current.set(poi.id, el); else pills.current.delete(poi.id);
            }}
            onClick={(e) => toggle(poi.id, e)}
          >
            {poi.label}
          </PillButton>
        ))}
      </div>
      {open && <PoiCard key={open.poi.id} id={CARD_ID} poi={open.poi} parent={open.parent} render={render} onClose={close} ref={card} />}
    </div>
  );
}

// after the city and district pills (order 0), so a point of interest draws over them
const mount: AppMount = { region: 'scene', order: 20, Component: PointsOfInterest };
export default mount;
