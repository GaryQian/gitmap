// The map's keyboard plumbing. Window-level shortcuts (Home, "/") must leave text fields alone
// (`isTyping`). Escape closes one thing per press, the topmost: everything that closes on Escape
// registers here instead of listening for the key itself. Tab walks the regions in reading order,
// which is not the order the shell lays them out in the document.
import { useEffect, useRef } from 'react';

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

/** True when a key press belongs to a field the user is typing in, not to the map. */
export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && TEXT_INPUTS.has((target.getAttribute('type') ?? '').toLowerCase());
}

// ---- Escape: one layer per press ----

/**
 * What Escape closes first. A higher layer closes before a lower one; within a layer, the one opened
 * most recently goes first. So: an open list or picker, then a card or popover, then the tour, then
 * the sidebar, and last the selection.
 */
export const LAYER = { selection: 0, sidebar: 1, tour: 2, card: 3, list: 4 } as const;

export interface Dismissable {
  /** Close it, and put the focus back where it belongs. Called for one press of Escape. */
  close(): void;
  /** One of `LAYER`; a card when left out. */
  layer?: number;
  /**
   * Whether a text field belongs to this layer. Escape pressed in a field the user is typing in
   * closes only a layer that owns the field (the search field's own list, the editor's sidebar);
   * anywhere else it closes the topmost layer.
   */
  owns?(field: EventTarget): boolean;
}

interface Entry { item: Dismissable; opened: number }

const open: Entry[] = [];
let opened = 0;
let listening = false;

function onEscape(e: KeyboardEvent): void {
  // a control that used the key itself (the editor closing its search panel) has said so
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
  dismissTop(isTyping(e.target) ? e.target : null);
}

/**
 * Put something that closes on Escape on the stack while it is open. Returns the function that takes
 * it off again; call it when the thing closes, however it was closed.
 */
export function registerDismissable(item: Dismissable): () => void {
  const entry: Entry = { item, opened: ++opened };
  open.push(entry);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('keydown', onEscape);
  }
  return () => {
    const at = open.indexOf(entry);
    if (at >= 0) open.splice(at, 1);
  };
}

/** The layer the next Escape closes; `typingIn` is the text field the key was pressed in, if any. */
export function topDismissable(typingIn: EventTarget | null = null): Dismissable | null {
  let top: Entry | null = null;
  for (const entry of open) {
    if (typingIn && !entry.item.owns?.(typingIn)) continue;
    const layer = entry.item.layer ?? LAYER.card;
    if (!top || layer > (top.item.layer ?? LAYER.card) || (layer === (top.item.layer ?? LAYER.card) && entry.opened > top.opened)) top = entry;
  }
  return top?.item ?? null;
}

/** Close the topmost layer. False when nothing was open. */
export function dismissTop(typingIn: EventTarget | null = null): boolean {
  const top = topDismissable(typingIn);
  if (!top) return false;
  top.close();
  return true;
}

/**
 * `registerDismissable` for a component: on the stack while `isOpen`. Its place among layers opened
 * at other times is fixed when it opens; `close` and `owns` may change between renders.
 */
export function useDismissable(isOpen: boolean, close: () => void, options: { layer?: number; owns?: (field: EventTarget) => boolean } = {}): void {
  const latest = useRef({ close, owns: options.owns });
  latest.current = { close, owns: options.owns };
  const { layer } = options;
  useEffect(() => {
    if (!isOpen) return;
    return registerDismissable({
      layer,
      close: () => latest.current.close(),
      owns: (field) => latest.current.owns?.(field) ?? false,
    });
  }, [isOpen, layer]);
}

// ---- Tab: the regions in reading order ----

/**
 * The order Tab visits the regions in (mounts.tsx puts the name on each as `data-region`). The scene
 * and the sidebar come first in the document, or last, because of how they are laid out; read on
 * screen, they come after the top row.
 */
export const TAB_REGIONS = ['topLeft', 'topCenter', 'topRight', 'scene', 'rightEdge', 'bottomLeft', 'bottomCenter', 'bottomRight', 'overlay'] as const;

/** `items` (in document order) in the order Tab visits them: by region, document order within one. */
export function orderByRegion<T>(items: readonly T[], regionOf: (item: T) => string | null): T[] {
  const rank = (item: T): number => {
    const at = (TAB_REGIONS as readonly string[]).indexOf(regionOf(item) ?? '');
    return at < 0 ? TAB_REGIONS.length : at;
  };
  return items.map((item, i) => ({ item, rank: rank(item), i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.item);
}

const TABBABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) =>
    // an editable region is a tab stop although its `tabIndex` reads -1 (the code editor)
    (el.tabIndex >= 0 || (el.isContentEditable && !el.hasAttribute('tabindex')))
    && !(el as HTMLButtonElement).disabled && !el.closest('[inert]')
    && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true })));
}

const regionOf = (el: Element): string | null => el.closest<HTMLElement>('[data-region]')?.dataset.region ?? null;

function onTab(e: KeyboardEvent): void {
  // a control that uses Tab itself (the editor indenting) has prevented the default
  if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const root = document.querySelector<HTMLElement>('.gm-app[data-phase="map"]');
  if (!root) return;
  const inDocument = tabStops(root);
  const stops = orderByRegion(inDocument, regionOf);
  if (stops.length < 2 || stops.every((el, i) => el === inDocument[i])) return; // the browser's order is already right

  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  let next: HTMLElement | undefined;
  const at = active ? stops.indexOf(active) : -1;
  if (at >= 0) {
    next = stops[at + (e.shiftKey ? -1 : 1)];
  } else if (!active) {
    next = e.shiftKey ? stops[stops.length - 1] : stops[0];
  } else {
    // the focus is on something that is not a tab stop (a card that took it when it opened, a pill
    // reached with the arrow keys): go on from where it stands
    const before = (stop: HTMLElement): boolean => {
      const a = orderByRegion([stop, active], regionOf);
      if (regionOf(stop) !== regionOf(active)) return a[0] === stop;
      return (stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    };
    next = e.shiftKey ? [...stops].reverse().find((stop) => before(stop)) : stops.find((stop) => !before(stop));
  }

  if (next) {
    e.preventDefault();
    next.focus();
    if (next instanceof HTMLInputElement && isTyping(next)) next.select();
    return;
  }
  // Past the last stop (or before the first): the focus leaves the page, as it would have. The
  // browser goes on from the focused element in document order, so start it from that end.
  const edge = e.shiftKey ? inDocument[0] : inDocument[inDocument.length - 1];
  if (edge && edge !== active) edge.focus({ preventScroll: true });
}

/** Make Tab follow `TAB_REGIONS` on the map. Returns the function that stops it. */
export function installTabOrder(): () => void {
  window.addEventListener('keydown', onTab);
  return () => window.removeEventListener('keydown', onTab);
}

// This module holds state (the open layers). Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
