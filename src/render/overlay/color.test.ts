import { describe, expect, it } from 'vitest';
import type { OverlayView } from '../../contracts/render';
import { buildRamp, rampColor } from '../spheres/overlay';
import { effectColor, overlayColorAt } from './color';

const view = (values: number[], discrete = false): OverlayView => ({
  id: 'recency', values: Float32Array.from(values), domain: [0, 10], discrete,
  stops: [{ t: 0, color: '#000000' }, { t: 0.5, color: '#ff0000' }, { t: 1, color: '#ffffff' }], unknown: '#204060',
});

describe('overlay colour of one unit', () => {
  it('follows the ramp for known values and clamps outside the domain', () => {
    const v = view([0, 5, 10, 99, -4]);
    expect(overlayColorAt(v, 0)).toEqual({ rgb: [0, 0, 0], known: true });
    expect(overlayColorAt(v, 1)).toEqual({ rgb: [1, 0, 0], known: true });
    expect(overlayColorAt(v, 2).rgb).toEqual([1, 1, 1]);
    expect(overlayColorAt(v, 3).rgb).toEqual([1, 1, 1]);
    expect(overlayColorAt(v, 4).rgb).toEqual([0, 0, 0]);
  });

  it('gives NaN, a missing slot and a negative slot the unknown colour, never a ramp colour', () => {
    const v = view([NaN, 5]);
    const unknown = { rgb: [0x20 / 255, 0x40 / 255, 0x60 / 255], known: false };
    expect(overlayColorAt(v, 0)).toEqual(unknown);
    expect(overlayColorAt(v, 7)).toEqual(unknown);
    expect(overlayColorAt(v, -1)).toEqual(unknown);
  });

  it('agrees with the ramp texture the stars read, discrete or not', () => {
    for (const discrete of [false, true]) {
      const v = view([0, 2, 4, 6, 8, 10], discrete);
      const ramp = buildRamp(v.stops, discrete, 101);
      for (let s = 0; s < 6; s++) {
        const texel = Array.from(ramp.subarray(4 * s * 20, 4 * s * 20 + 3));
        expect(overlayColorAt(v, s).rgb.map((c) => Math.round(c * 255))).toEqual(texel);
      }
    }
    expect(rampColor(view([]).stops, 0.2, true)).toEqual([0, 0, 0]);
    expect(rampColor(view([]).stops, 0.3, true)).toEqual([1, 0, 0]);
  });
});

describe('colour of a unit\'s effects', () => {
  const type = [0.2, 0.4, 0.6] as const, neutral = [0.5, 0.5, 0.5] as const;

  it('is the file-type colour with no overlay, the overlay colour under one, and neutral when unknown', () => {
    const v = view([5, NaN]);
    expect(effectColor(null, 0, type, neutral)).toEqual([0.2, 0.4, 0.6]);
    expect(effectColor(v, 0, type, neutral)).toEqual([1, 0, 0]);
    expect(effectColor(v, 1, type, neutral)).toEqual([0.5, 0.5, 0.5]);
  });
});
