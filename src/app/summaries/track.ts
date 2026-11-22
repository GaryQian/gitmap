// Which in-scene pill the summary card belongs to right now: the one the pointer rests on, or the
// one with keyboard focus. The pills are pooled elements owned by pills/layer.ts, so they are found
// by event delegation and watched from outside; nothing here changes them.
import { isNodeRef, type NodeRef } from '../../model/types';

/** City and district pills; `data-ref` says which node a pooled element stands for at the moment. */
const PILL = '.gm-scene-pill[data-ref]';

export interface PillTarget {
  el: HTMLElement;
  ref: NodeRef;
  /** Shown without the hover delay, right after another card: it appears without the fade. */
  instant: boolean;
}

export interface TrackOptions {
  /** How long the pointer rests on a pill before its card shows. */
  delayMs: number;
  /** After a card has been on screen, the next pill shows its own without the delay for this long. */
  graceMs: number;
  /** Whether the card of this target has anything in it. An empty one is not on screen, so it starts no grace period. */
  hasCard(target: PillTarget): boolean;
  onTarget(target: PillTarget | null): void;
  /** The target's pill moved, or changed in some way that leaves it standing for the same node. */
  onMove(): void;
}

export interface PillTracker {
  /** Look at the target's pill again: drop it if it was recycled, hidden or picked up; otherwise report a move. */
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
  let shown: PillTarget | null = null;
  let timer = 0;
  let lastCardAt = -Infinity;

  const pillOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(PILL) : null;

  /** On screen, standing for a node, and not fading out or being dragged. */
  const usable = (el: HTMLElement): boolean =>
    el.isConnected && !el.hidden && isNodeRef(el.dataset.ref) && el.style.pointerEvents !== 'none' && !el.classList.contains('is-dragging');

  const watcher = new MutationObserver(() => check());

  function leave(): void {
    if (shown && options.hasCard(shown)) lastCardAt = performance.now();
  }

  function show(el: HTMLElement, instant: boolean): void {
    timer = 0;
    if (!usable(el)) { hide(); return; }
    leave();
    shown = { el, ref: el.dataset.ref as NodeRef, instant };
    watcher.disconnect();
    // `style` carries the pill's position (and its fade out), so every move of the pill arrives here
    watcher.observe(el, { attributes: true, attributeFilter: ['class', 'data-ref', 'hidden', 'style'] });
    options.onTarget(shown);
  }

  function hide(): void {
    if (!shown) return;
    leave();
    shown = null;
    watcher.disconnect();
    options.onTarget(null);
  }

  /** Bring the card in line with what is hovered and focused. `rested`: the pointer must rest first. */
  function sync(rested: boolean): void {
    if (timer) { win.clearTimeout(timer); timer = 0; }
    if (dismissed && dismissed !== hovered && dismissed !== focused) dismissed = null;
    const wanted = latest === 'focus' ? focused ?? hovered : hovered ?? focused;
    const next = wanted && wanted !== dismissed ? wanted : null;
    if (next === (shown?.el ?? null)) return;
    if (!next) { hide(); return; }
    // a card is on screen, or was a moment ago: the neighbour's card takes its place at once
    const warm = shown ? options.hasCard(shown) : performance.now() - lastCardAt < options.graceMs;
    if (warm || !rested) { show(next, warm); return; }
    hide();
    timer = win.setTimeout(() => show(next, false), options.delayMs);
  }

  function check(): void {
    if (!shown) return;
    const { el, ref } = shown;
    if (el.classList.contains('is-dragging')) {
      dismissed = el;
      hide();
    } else if (!usable(el) || el.dataset.ref !== ref) {
      // recycled to another node, hidden, or fading out: the pointer has to find it again
      if (hovered === el) hovered = null;
      if (focused === el) focused = null;
      sync(false);
    } else {
      options.onMove();
    }
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
    if (e.key !== 'Escape' || !shown || !options.hasCard(shown)) return;
    // Escape closes the card of the focused pill before it clears the selection (app/README.md, "Keys").
    // A card that is only hovered goes too, but the key stays with whatever has the focus.
    if (doc.activeElement === shown.el) e.stopPropagation();
    dismissed = shown.el;
    hide();
  };

  doc.addEventListener('pointerover', onPointerOver);
  doc.addEventListener('pointerout', onPointerOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  win.addEventListener('keydown', onKeyDown, true);

  return {
    check,
    dispose() {
      if (timer) win.clearTimeout(timer);
      watcher.disconnect();
      doc.removeEventListener('pointerover', onPointerOver);
      doc.removeEventListener('pointerout', onPointerOut);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      win.removeEventListener('keydown', onKeyDown, true);
      shown = null;
    },
  };
}
