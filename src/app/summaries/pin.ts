// What pins a city's card by hand and what lets it go, picked out of the document's own events: a
// click on a city pill, a click on the open map, Escape. The pills and the canvas belong to others;
// nothing here stops, prevents or changes an event, so a click still flies the camera to the city
// and Escape still does whatever else it does.
import { isNodeRef, type NodeRef } from '../../model/types';

const CITY_PILL = '.gm-scene-pill-city[data-ref]';
const MAP_CANVAS = 'canvas.gm-map-canvas';

export type PinGesture =
  | { type: 'pill'; ref: NodeRef }
  | { type: 'ground' }
  | { type: 'escape' };

export interface PinWatchOptions {
  /** A press that travels less than this is a click, not a drag (the pill layer's own rule). CSS pixels. */
  clickSlopPx: number;
  /** Whether this press of Escape is free: nothing else on screen is closing on it. Asked before anything has handled the key. */
  escapeIsFree(e: KeyboardEvent): boolean;
  onGesture(gesture: PinGesture): void;
}

/** Report pin gestures until the returned function is called. */
export function watchPinGestures(doc: Document, options: PinWatchOptions): () => void {
  const win = doc.defaultView ?? window;
  /** The press in progress: where it began, on what, and whether it has turned into a drag. */
  let press: { id: number; x: number; y: number; onMap: boolean; moved: boolean } | null = null;
  let escapeFree = false;

  const closest = (target: EventTarget | null, selector: string): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(selector) : null;

  const onPointerDown = (e: PointerEvent) => {
    press = e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, onMap: closest(e.target, MAP_CANVAS) !== null, moved: false } : null;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!press || press.moved || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= options.clickSlopPx) press.moved = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    // a click on the open map; dragging the map to look around is not one
    if (press && e.pointerId === press.id && press.onMap && !press.moved) options.onGesture({ type: 'ground' });
  };
  const onPointerCancel = () => { press = null; };

  const onClick = (e: MouseEvent) => {
    const pill = closest(e.target, CITY_PILL);
    // the click that ends a drag of the pill still arrives here (the pill layer ignores it too);
    // Enter and Space on a focused pill arrive with no press behind them (`detail` 0)
    const dragged = e.detail > 0 && press !== null && press.moved;
    press = null;
    const ref = pill?.dataset.ref;
    if (!pill || dragged || pill.classList.contains('is-dragging') || !isNodeRef(ref)) return;
    options.onGesture({ type: 'pill', ref });
  };

  // Escape is looked at on the way down, before anything has closed on it, and acted on on the way
  // back up, where a key that something took for itself (stopped or prevented) never arrives.
  const onKeyDownFirst = (e: KeyboardEvent) => {
    escapeFree = e.key === 'Escape' && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && options.escapeIsFree(e);
  };
  const onKeyDownLast = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && escapeFree && !e.defaultPrevented) options.onGesture({ type: 'escape' });
    escapeFree = false;
  };

  // capture: the map canvas and the pill layer take pointer events for themselves
  win.addEventListener('pointerdown', onPointerDown, true);
  win.addEventListener('pointermove', onPointerMove, true);
  win.addEventListener('pointerup', onPointerUp, true);
  win.addEventListener('pointercancel', onPointerCancel, true);
  win.addEventListener('click', onClick, true);
  win.addEventListener('keydown', onKeyDownFirst, true);
  win.addEventListener('keydown', onKeyDownLast);
  return () => {
    win.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('pointermove', onPointerMove, true);
    win.removeEventListener('pointerup', onPointerUp, true);
    win.removeEventListener('pointercancel', onPointerCancel, true);
    win.removeEventListener('click', onClick, true);
    win.removeEventListener('keydown', onKeyDownFirst, true);
    win.removeEventListener('keydown', onKeyDownLast);
  };
}
