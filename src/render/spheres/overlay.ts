// Overlay colouring: one float per instance and a small ramp texture built from OverlayView.stops. Pure.
import type { ColorStop } from '../../contracts/render';
import { hexToRgb } from '../../shared';

export const RAMP_WIDTH = 256;
/** Attribute value for "not yet known" (NaN in the layer). The shader draws it in the unknown colour. */
export const OVERLAY_UNKNOWN = -1;

type Rgb = readonly [number, number, number];
interface RgbStop { t: number; rgb: Rgb }

const NO_STOPS: Rgb = [0.5, 0.5, 0.5];

/** Stops sorted by t, colours as sRGB 0..1. */
function sortedStops(stops: readonly ColorStop[]): RgbStop[] {
  return [...stops].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, rgb: hexToRgb(s.color) }));
}

function sampleSorted(sorted: readonly RgbStop[], t: number, discrete: boolean): Rgb {
  if (!sorted.length) return NO_STOPS;
  // a = the last stop at or before t, b = the first stop at or after it (clamped at both ends)
  let a = sorted[0], b = sorted[sorted.length - 1];
  for (const s of sorted) if (s.t <= t) a = s;
  for (let j = sorted.length - 1; j >= 0; j--) if (sorted[j].t >= t) b = sorted[j];
  if (b.t <= a.t) return t < a.t ? b.rgb : a.rgb;
  if (discrete) return t - a.t <= b.t - t ? a.rgb : b.rgb;
  const k = (t - a.t) / (b.t - a.t);
  return [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k];
}

/**
 * The ramp's colour at t = 0..1, sRGB 0..1. Between stops the colour is interpolated; with
 * `discrete` it is the nearest stop's colour instead. The same rule fills the ramp texture.
 */
export function rampColor(stops: readonly ColorStop[], t: number, discrete = false): [number, number, number] {
  const [r, g, b] = sampleSorted(sortedStops(stops), t, discrete);
  return [r, g, b];
}

/** RGBA bytes for a ramp across t = 0..1 (see rampColor). */
export function buildRamp(stops: readonly ColorStop[], discrete = false, width = RAMP_WIDTH): Uint8Array {
  const out = new Uint8Array(width * 4);
  const sorted = sortedStops(stops);
  for (let i = 0; i < width; i++) {
    const rgb = sampleSorted(sorted, width > 1 ? i / (width - 1) : 0, discrete);
    out[4 * i] = Math.round(rgb[0] * 255); out[4 * i + 1] = Math.round(rgb[1] * 255); out[4 * i + 2] = Math.round(rgb[2] * 255); out[4 * i + 3] = 255;
  }
  return out;
}

/** Attribute value for a unit the overlay filters out (−Infinity in the view). The shader does not draw it. */
export const OVERLAY_HIDDEN = -2;

/** A layer value → ramp position 0..1, OVERLAY_UNKNOWN for NaN or a missing value, or OVERLAY_HIDDEN for −Infinity. */
export function overlayT(value: number | undefined, domain: readonly [number, number]): number {
  if (value === undefined || Number.isNaN(value)) return OVERLAY_UNKNOWN;
  if (value === -Infinity) return OVERLAY_HIDDEN;
  const span = domain[1] - domain[0];
  if (!(span > 0)) return 0;
  const t = (value - domain[0]) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
