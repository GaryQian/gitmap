// How far back the camera stands for a tour step that frames a district or a city, so the framed
// territory stays clear of the step card at the bottom centre. Uses only the renderer's public
// surface: where screen pixels fall on the ground right now, and the camera's current distance.
import { config } from '../../config';
import type { PositionBuffers } from '../../contracts/physics';
import type { RenderApi } from '../../contracts/render';
import type { ModelReplica } from '../../contracts/store';
import { parseRef, type NodeRef } from '../../model/types';

/** Tour tunables that have no key in config.json yet (see "Requested changes" in the 5E report). */
export const TOUR_LOCAL = {
  framing: {
    /** Space kept between the framed territory and the step card, CSS pixels. */
    cardGapPx: 20,
    /** Space kept to the sides and the bottom of the view, and to the top row of pills. */
    edgePx: 24,
    topPx: 64,
    /** Probes along each edge. */
    samples: 9,
  },
} as const;

/** A rectangle in canvas-relative CSS pixels. */
export interface Box { left: number; top: number; right: number; bottom: number }

/** Territory radius of a `d:` or `c:` ref, from the physics buffers. Null for anything else, or when it is not laid out. */
export function territoryRadius(ref: NodeRef, replica: ModelReplica, positions: PositionBuffers): number | null {
  let parsed;
  try { parsed = parseRef(ref); } catch { return null; }
  if (parsed.kind !== 'district' && parsed.kind !== 'city') return null;
  const rows = parsed.kind === 'district' ? positions.district : positions.city;
  const slot = replica.table(parsed.kind).slotOf(parsed.id);
  const r = slot < 0 ? NaN : rows[3 * slot + 2] ?? NaN;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The camera distance from which a ground disc of `radius`, centred where the camera looks, stays
 * inside `view` and clear of `card`.
 *
 * A flight keeps the camera's angles, and at fixed angles the picture only scales with distance. So
 * the largest disc around the current target that fits today (found by asking where the edges of
 * the free area fall on the ground) gives the answer by proportion. Null when it cannot be worked
 * out, in which case the renderer's own framing is used.
 */
export function clearDistance(
  render: Pick<RenderApi, 'screenToGround'>,
  camera: { cameraDistance: number; target: { x: number; z: number } },
  radius: number,
  view: Box,
  card: Box | null,
): number | null {
  const { cardGapPx, edgePx, topPx, samples } = TOUR_LOCAL.framing;
  const left = view.left + edgePx, right = view.right - edgePx, top = view.top + topPx, bottom = view.bottom - edgePx;
  if (!(radius > 0) || !(camera.cameraDistance > 0) || right <= left || bottom <= top) return null;

  let fits = Infinity;
  /** Probe a screen segment: the disc may not reach the ground under any point of it. */
  const probe = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const ground = render.screenToGround(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (!ground) continue; // above the horizon: no limit from there
      fits = Math.min(fits, Math.hypot(ground.x - camera.target.x, ground.z - camera.target.z));
    }
  };
  probe(left, top, right, top);
  probe(left, bottom, right, bottom);
  probe(left, top, left, bottom);
  probe(right, top, right, bottom);
  if (card) {
    const l = Math.max(left, card.left - cardGapPx), r = Math.min(right, card.right + cardGapPx);
    const t = Math.max(top, card.top - cardGapPx);
    if (l < r && t < bottom) {
      probe(l, t, r, t);
      probe(l, t, l, bottom);
      probe(r, t, r, bottom);
    }
  }
  if (!Number.isFinite(fits) || fits <= 0) return null;
  const distance = (camera.cameraDistance * radius) / fits;
  return Math.min(config.camera.maxDistance, Math.max(config.camera.minDistance, distance));
}
