// What colour one unit has under an overlay, on the CPU (PLAN.md §8.6, §10). The stars read theirs
// from the ramp texture in the shader; this is the same mapping for the few things that are coloured
// per event rather than per instance, such as a click's burst of particles. Pure.
import type { OverlayView } from '../../contracts/render';
import { hexToRgb } from '../../shared';
import { OVERLAY_UNKNOWN, overlayT, rampColor } from '../spheres/overlay';

export interface OverlayColor {
  /** sRGB 0..1: the ramp colour of the unit's value, or the view's "unknown" colour. */
  rgb: [number, number, number];
  /** False when the value is NaN or missing: the unit is drawn in the neutral "not yet known" style. */
  known: boolean;
}

/** The colour the unit in `slot` takes under `view`. */
export function overlayColorAt(view: OverlayView, slot: number): OverlayColor {
  const t = overlayT(slot >= 0 && slot < view.values.length ? view.values[slot] : undefined, view.domain);
  if (t === OVERLAY_UNKNOWN) return { rgb: hexToRgb(view.unknown), known: false };
  return { rgb: rampColor(view.stops, t, view.discrete), known: true };
}

/**
 * The colour of an effect that belongs to one unit (a burst, a flash): its file-type colour, or under
 * an overlay its overlay colour, so nothing on screen contradicts the overlay. A unit whose value is
 * not yet known gives `neutral`: an unknown star is unlit, and its effects carry no colour either.
 */
export function effectColor(view: OverlayView | null, slot: number, typeColor: readonly [number, number, number], neutral: readonly [number, number, number]): [number, number, number] {
  if (!view) return [typeColor[0], typeColor[1], typeColor[2]];
  const c = overlayColorAt(view, slot);
  return c.known ? c.rgb : [neutral[0], neutral[1], neutral[2]];
}
