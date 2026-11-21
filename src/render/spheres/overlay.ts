// Overlay colouring: one float per instance and a small ramp texture built from OverlayView.stops. Pure.
import type { ColorStop } from '../../contracts/render';
import { hexToRgb } from '../../shared';

export const RAMP_WIDTH = 256;
/** Attribute value for "not yet known" (NaN in the layer). The shader draws it in the unknown colour. */
export const OVERLAY_UNKNOWN = -1;

/**
 * RGBA bytes for a ramp across t = 0..1. Stops are sorted by t. Between stops the colour is
 * interpolated; with `discrete` each texel takes the nearest stop's colour instead.
 */
export function buildRamp(stops: readonly ColorStop[], discrete = false, width = RAMP_WIDTH): Uint8Array {
  const out = new Uint8Array(width * 4);
  const sorted = [...stops].sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, rgb: hexToRgb(s.color) }));
  for (let i = 0; i < width; i++) {
    const t = width > 1 ? i / (width - 1) : 0;
    let rgb: readonly number[] = [0.5, 0.5, 0.5];
    if (sorted.length) {
      // a = the last stop at or before t, b = the first stop at or after it (clamped at both ends)
      let a = sorted[0], b = sorted[sorted.length - 1];
      for (const s of sorted) if (s.t <= t) a = s;
      for (let j = sorted.length - 1; j >= 0; j--) if (sorted[j].t >= t) b = sorted[j];
      if (b.t <= a.t) rgb = t < a.t ? b.rgb : a.rgb;
      else if (discrete) rgb = t - a.t <= b.t - t ? a.rgb : b.rgb;
      else { const k = (t - a.t) / (b.t - a.t); rgb = [a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k, a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k, a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k]; }
    }
    out[4 * i] = Math.round(rgb[0] * 255); out[4 * i + 1] = Math.round(rgb[1] * 255); out[4 * i + 2] = Math.round(rgb[2] * 255); out[4 * i + 3] = 255;
  }
  return out;
}

/** A layer value → ramp position 0..1, or OVERLAY_UNKNOWN for NaN or a missing value. */
export function overlayT(value: number | undefined, domain: readonly [number, number]): number {
  if (value === undefined || Number.isNaN(value)) return OVERLAY_UNKNOWN;
  const span = domain[1] - domain[0];
  if (!(span > 0)) return 0;
  const t = (value - domain[0]) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
