// Which in-scene pills get to show (PLAN.md §8.4). Pure: rectangles in, the kept ones out.
import { APP_LOCAL } from '../tunables';

export interface PillBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Lower shows first: 0 a pill being dragged or holding keyboard focus, 1 cities, 2 districts. */
  tier: number;
  /** Was on screen in the previous frame. Staying put beats swapping places with a neighbour. */
  sticky: boolean;
  /** Camera distance of the anchor; nearer wins within a tier. */
  depth: number;
}

export function byPriority(a: PillBox, b: PillBox): number {
  return a.tier - b.tier || Number(b.sticky) - Number(a.sticky) || a.depth - b.depth;
}

export interface Rect { x: number; y: number; width: number; height: number }

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * Keep pills in priority order, dropping any that would overlap one already kept, up to `max`.
 * `blocked` are rectangles no pill may lie under (the fixed chrome, an open detail card); a pill
 * being dragged or holding focus (tier 0) ignores them. Sorts `boxes` in place and returns the kept
 * ones, highest priority first.
 */
export function keepPills<T extends PillBox>(boxes: T[], max: number, blocked: readonly Rect[] = [], gap: number = APP_LOCAL.pills.gapPx): T[] {
  boxes.sort(byPriority);
  const kept: T[] = [];
  for (const box of boxes) {
    if (kept.length >= max) break;
    let free = true;
    if (box.tier > 0) for (let i = 0; i < blocked.length && free; i++) free = !overlaps(box, blocked[i]!, gap);
    for (let i = 0; i < kept.length && free; i++) free = !overlaps(box, kept[i]!, gap);
    if (free) kept.push(box);
  }
  return kept;
}

/** Pills fade with distance: full strength up close, down to a floor far behind the camera's target. */
export function distanceFade(depth: number, cameraDistance: number): number {
  const { fadeStart, fadeEnd, fadeFloor } = APP_LOCAL.pills;
  if (!(cameraDistance > 0) || !Number.isFinite(cameraDistance)) return 1;
  const t = (depth / cameraDistance - fadeStart) / (fadeEnd - fadeStart);
  return t <= 0 ? 1 : t >= 1 ? fadeFloor : 1 - t * (1 - fadeFloor);
}
