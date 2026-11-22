// Keeping a DOM element beside a node of the scene: project the node on every rendered frame and
// write the element's transform directly, never through React state (PLAN.md §8.4).
import { useLayoutEffect, type RefObject } from 'react';
import type { RenderApi, ScreenPoint } from '../contracts/render';
import type { NodeRef } from '../model/types';
import { useRender } from './store';
import { shownSize } from './uiScale';

/** How far the probes that measure the ground's scale on screen are from the anchor, CSS pixels. */
const PROBE_PX = 12;

/**
 * CSS pixels that `world` units on the ground cover at a projected point: sideways (`'x'`), or up the
 * screen (`'y'`, foreshortened by the camera's tilt and refined once for perspective). 0 when the
 * ground cannot be found there (at or above the horizon).
 */
export function groundToPixels(render: RenderApi, at: ScreenPoint, world: number, axis: 'x' | 'y'): number {
  if (!(world > 0)) return 0;
  const origin = render.screenToGround(at.x, at.y);
  if (!origin) return 0;
  const span = (px: number): number => {
    const g = axis === 'x' ? render.screenToGround(at.x + px, at.y) : render.screenToGround(at.x, at.y - px);
    return g ? Math.hypot(g.x - origin.x, g.z - origin.z) : 0;
  };
  const near = span(PROBE_PX);
  if (!(near > 0)) return 0;
  let px = (PROBE_PX * world) / near;
  if (axis === 'y') {
    // each pixel covers more ground the farther up the screen it is: correct the first guess once
    const reached = span(px);
    px = reached > 0 ? (px * world) / reached : px / 2;
  }
  return px;
}

export interface Placement { x: number; y: number }
export interface Box { width: number; height: number }

/** Where an anchored element of size `box` goes for an anchor projected at `at`; null hides it. */
export type Place = (at: ScreenPoint, box: Box, view: Box, render: RenderApi) => Placement | null;

/**
 * Boxes of anchored cards, in scene coordinates, that the in-scene pills keep clear of: a pill
 * showing through a translucent card makes both unreadable. Kept up to date without reading the DOM.
 */
export const sceneObstacles = new Set<Placement & Box>();

/**
 * Keep `element` placed beside `target`, following it frame by frame. The element should be
 * absolutely positioned at the top left of the `scene` region. With `obstacle`, in-scene pills stay
 * out from under it. Returns a function that stops.
 */
export function followAnchor(render: RenderApi, target: NodeRef, element: HTMLElement, place: Place, obstacle = false): () => void {
  const view = (element.offsetParent as HTMLElement | null) ?? element.parentElement;
  // measured once: the caller re-anchors when the element's content changes
  const box = { x: 0, y: 0, ...shownSize(element) };
  let size = { width: view?.clientWidth ?? 0, height: view?.clientHeight ?? 0 };
  let x = NaN, y = NaN, showing: boolean | null = null;
  const update = () => {
    const at = render.project(target);
    const spot = at && at.visible ? place(at, box, size, render) : null;
    if (showing !== !!spot) {
      showing = !!spot;
      element.style.visibility = showing ? 'visible' : 'hidden';
      if (obstacle && showing) sceneObstacles.add(box); else sceneObstacles.delete(box);
    }
    if (!spot) return;
    const rx = Math.round(spot.x), ry = Math.round(spot.y);
    if (rx === x && ry === y) return;
    box.x = x = rx;
    box.y = y = ry;
    element.style.translate = `${rx}px ${ry}px`;
  };
  const resize = view ? new ResizeObserver(() => {
    size = { width: view.clientWidth, height: view.clientHeight };
    // a new window size can bring a new scale (uiScale.ts)
    Object.assign(box, shownSize(element));
    x = NaN;
    update();
  }) : null;
  if (view) resize!.observe(view);
  update();
  const off = render.on('frame', update);
  return () => { off(); resize?.disconnect(); sceneObstacles.delete(box); };
}

/** `followAnchor` for a component: re-anchors when the target or `rev` (anything that changes the element's size) changes. */
export function useAnchor(target: NodeRef | null, element: RefObject<HTMLElement | null>, place: Place, rev: unknown = null, obstacle = false): void {
  const render = useRender();
  useLayoutEffect(() => {
    const el = element.current;
    if (!render || !target || !el) return;
    return followAnchor(render, target, el, place, obstacle);
  }, [render, target, element, place, rev, obstacle]);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
