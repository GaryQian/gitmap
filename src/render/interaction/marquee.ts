// Marquee selection (PLAN.md §9: Shift+drag): the units whose projected centres fall inside a
// screen rectangle. Pure.
import type { PositionBuffers } from '../../contracts/physics';
import { forEachUnit, type PickIndex } from './picking';

/** A screen rectangle in canvas-relative CSS pixels, with x0 ≤ x1 and y0 ≤ y1. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** The rectangle spanned by two corners, in either order. */
export function rectFrom(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/**
 * Unit slots whose rest centre (y = radius) projects inside `rect`, in the index's order.
 * `viewProjection` is projection × view as 16 column-major numbers (a THREE.Matrix4's `elements`);
 * `width` and `height` are the canvas size in CSS pixels. Points behind the camera never match.
 */
export function unitsInRect(
  rect: Rect, viewProjection: ArrayLike<number>, width: number, height: number,
  index: PickIndex, pos: PositionBuffers, isShown?: (slot: number) => boolean,
): number[] {
  const m = viewProjection;
  const out: number[] = [];
  forEachUnit(index, pos, (slot, x, y, z) => {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 0)) return;
    const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * width;
    if (sx < rect.x0 || sx > rect.x1) return;
    const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * height;
    if (sy < rect.y0 || sy > rect.y1) return;
    if (isShown && !isShown(slot)) return;
    out.push(slot);
  });
  return out;
}
