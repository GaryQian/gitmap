// Which in-scene pill the summary card belongs to right now: the one the pointer rests on or the one
// with keyboard focus, and otherwise the pill of the selected city, whose card is pinned. The pills
// are pooled elements owned by pills/layer.ts, so they are found by event delegation and watched from
// outside; nothing here changes them.
import { isNodeRef, type NodeRef } from '../../model/types';
import { cardOwner } from './logic';

/** City and district pills; `data-ref` says which node a pooled element stands for at the moment. */
const PILL = '.gm-scene-pill[data-ref]';
/** What says where a pill is, which node it stands for, and whether it is hidden, fading or dragged. */
const PILL_STATE = ['class', 'data-ref', 'hidden', 'style'];

export interface PillTarget {
  el: HTMLElement;
  ref: NodeRef;
  /** The card of the selected city, which stays up; false for one that lasts as long as the hover or focus. */
  pinned: boolean;
  /** It takes the place of a card that is on screen (or was a moment ago): it appears without the fade. */
  instant: boolean;
}

export interface TrackOptions {
  /** How long the pointer rests on a pill before its card shows. */
  delayMs: number;
  /** After a hover card has been on screen, the next pill shows its own without the delay for this long. */
  graceMs: number;
  /** Whether the card of this node has anything in it. An empty one is not on screen. */
  hasCard(ref: NodeRef): boolean;
  onTarget(target: PillTarget | null): void;
  /** The target's pill moved, or changed in some way that leaves it standing for the same node. */
  onMove(): void;
}

export interface PillTracker {
  /** The city whose card stays up (the selected one), or null. */
  setPinned(ref: NodeRef | null): void;
  /**
   * Look again: drop a pill that was recycled, hidden or picked up, find the pinned city's pill if it
   * is back, and report a new target or a move. Call it on every rendered frame while there is a
   * target or a pinned city, and when what `hasCard` answers may have changed.
   */
  check(): void;
  dispose(): void;
}

export function trackPills(doc: Document, options: TrackOptions): PillTracker {
  const win = doc.defaultView ?? window;
  let hovered: HTMLElement | null = null;
  /** The pill with keyboard focus (`:focus-visible`); a pill focused by a click is not it. */
  let focused: HTMLElement | null = null;
  let latest: 'pointer' | 'focus' = 'pointer';
  /** Its card was dismissed (Escape, or a drag): nothing more until the pointer and the focus have left it. */
  let dismissed: HTMLElement | null = null;
  /** The hovered or focused pill, once the pointer has rested on it. */
  let live: { el: HTMLElement; ref: NodeRef } | null = null;
  /** `live` came straight after another hover card, without the delay. */
  let liveWarm = false;
  let pinnedRef: NodeRef | null = null;
  /** The pill standing for the pinned city, while one does. */
  let pinnedEl: HTMLElement | null = null;
  /** What was last reported. */
  let current: PillTarget | null = null;
  let timer = 0;
  let lastLiveCardAt = -Infinity;

  const pillOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(PILL) : null;

  /** On screen, standing for a node, and not fading out or being dragged. */
  const usable = (el: HTMLElement): boolean =>
    el.isConnected && !el.hidden && isNodeRef(el.dataset.ref) && el.style.pointerEvents !== 'none' && !el.classList.contains('is-dragging');

  // ---- watching the pills that matter ----

  const watcher = new MutationObserver(() => check());
  let watchedLive: HTMLElement | null = null;
  let watchedPinned: HTMLElement | null = null;
  let watchedPool: Element | null = null;

  function rewatch(): void {
    const liveEl = live?.el ?? null;
    // the pinned city's pill is not on screen: wait for the pool to hand one out
    const pool = pinnedRef && !pinnedEl ? doc.querySelector('.gm-scene-pills') : null;
    if (liveEl === watchedLive && pinnedEl === watchedPinned && pool === watchedPool) return;
    watcher.disconnect();
    watchedLive = liveEl;
    watchedPinned = pinnedEl;
    watchedPool = pool;
    // `style` carries a pill's position (and its fade out), so every move of the pill arrives here
    if (liveEl) watcher.observe(liveEl, { attributes: true, attributeFilter: PILL_STATE });
    if (pinnedEl && pinnedEl !== liveEl) watcher.observe(pinnedEl, { attributes: true, attributeFilter: PILL_STATE });
    if (pool) watcher.observe(pool, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  /** The pill that stands for the pinned city, if one is on screen (never the layer's hidden measuring pill). */
  function findPinned(): void {
    if (!pinnedRef) { pinnedEl = null; return; }
    if (pinnedEl && pinnedEl.isConnected && !pinnedEl.hidden && pinnedEl.dataset.ref === pinnedRef) return;
    pinnedEl = null;
    for (const el of doc.querySelectorAll<HTMLElement>(PILL)) {
      if (el.dataset.ref === pinnedRef && !el.hidden && el.getAttribute('aria-hidden') !== 'true') { pinnedEl = el; return; }
    }
  }

  // ---- who the card belongs to ----

  /** Work out whose card shows now; report it if it changed, a move if it did not. */
  function update(): void {
    findPinned();
    const showable = pinnedEl && usable(pinnedEl) ? pinnedRef : null;
    const owner = cardOwner(live?.ref ?? null, showable, options.hasCard);
    const el = !owner ? null : owner.pinned ? pinnedEl : live!.el;
    rewatch();
    if (el === (current?.el ?? null) && owner?.ref === current?.ref && owner?.pinned === current?.pinned) {
      if (current) options.onMove();
      return;
    }
    const replaces = current !== null && options.hasCard(current.ref);
    current = owner && el ? { el, ref: owner.ref, pinned: owner.pinned, instant: replaces || (!owner.pinned && liveWarm) } : null;
    options.onTarget(current);
  }

  function setLive(el: HTMLElement | null, warm = false): void {
    timer = 0;
    if (live && options.hasCard(live.ref)) lastLiveCardAt = performance.now();
    live = el && usable(el) ? { el, ref: el.dataset.ref as NodeRef } : null;
    liveWarm = warm;
    update();
  }

  /** Bring the hover card in line with what is hovered and focused. `rested`: the pointer must rest first. */
  function sync(rested: boolean): void {
    if (timer) { win.clearTimeout(timer); timer = 0; }
    if (dismissed && dismissed !== hovered && dismissed !== focused) dismissed = null;
    const wanted = latest === 'focus' ? focused ?? hovered : hovered ?? focused;
    const next = wanted && wanted !== dismissed ? wanted : null;
    if (next === (live?.el ?? null)) return;
    if (!next) { setLive(null); return; }
    // a hover card is on screen, or was a moment ago: the neighbour's card takes its place at once
    const warm = live ? options.hasCard(live.ref) : performance.now() - lastLiveCardAt < options.graceMs;
    if (warm || !rested) { setLive(next, warm); return; }
    setLive(null);
    timer = win.setTimeout(() => setLive(next), options.delayMs);
  }

  function check(): void {
    if (live) {
      const { el, ref } = live;
      if (el.classList.contains('is-dragging')) {
        // picked up: its hover card is gone until the pointer has left it (a pinned card returns at the drop)
        dismissed = el;
        setLive(null);
        return;
      }
      if (!usable(el) || el.dataset.ref !== ref) {
        // recycled to another node, hidden, or fading out: the pointer has to find it again
        if (hovered === el) hovered = null;
        if (focused === el) focused = null;
        live = null;
        sync(false);
        if (!live) update();
        return;
      }
    }
    update();
  }

  function setHovered(el: HTMLElement | null): void {
    if (el === hovered) return;
    hovered = el;
    if (el) latest = 'pointer';
    sync(true);
  }

  const onPointerOver = (e: PointerEvent) => setHovered(pillOf(e.target));
  // straight from one pill to the next there is no moment without a target, so no flash
  const onPointerOut = (e: PointerEvent) => { if (pillOf(e.target)) setHovered(pillOf(e.relatedTarget)); };

  const onFocusIn = (e: FocusEvent) => {
    const pill = pillOf(e.target);
    const next = pill && pill.matches(':focus-visible') ? pill : null;
    if (next === focused) return;
    focused = next;
    if (next) latest = 'focus';
    sync(false);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!focused || pillOf(e.target) !== focused) return;
    focused = null;
    sync(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // only the card of the hovered or focused pill is ours to close; a pinned card that nobody is
    // pointing at goes when the app's own Escape clears the selection
    if (e.key !== 'Escape' || !live || !current || current.el !== live.el || !options.hasCard(current.ref)) return;
    // Escape closes the card of the focused pill before it clears the selection (app/README.md, "Keys").
    // A card that is only hovered goes too, but the key stays with whatever has the focus. With a
    // city selected the key is never taken: clearing the selection is what unpins its card.
    if (pinnedRef === null && doc.activeElement === live.el) e.stopPropagation();
    dismissed = live.el;
    setLive(null);
  };

  doc.addEventListener('pointerover', onPointerOver);
  doc.addEventListener('pointerout', onPointerOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  win.addEventListener('keydown', onKeyDown, true);

  return {
    setPinned(ref) {
      if (ref === pinnedRef) return;
      pinnedRef = ref;
      pinnedEl = null;
      update();
    },
    check,
    dispose() {
      if (timer) win.clearTimeout(timer);
      watcher.disconnect();
      doc.removeEventListener('pointerover', onPointerOver);
      doc.removeEventListener('pointerout', onPointerOut);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      win.removeEventListener('keydown', onKeyDown, true);
      live = current = null;
    },
  };
}
