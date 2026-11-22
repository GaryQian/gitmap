import { describe, expect, it } from 'vitest';
import type { OverlayView } from '../../contracts/render';
import { OVERLAY_UNKNOWN, RAMP_WIDTH } from '../spheres/overlay';
import { OverlayFade } from './fade';

const view = (id: string, values: number[], color = '#ff0000'): OverlayView => ({
  id, values: Float32Array.from(values), domain: [0, 10], stops: [{ t: 0, color: '#000000' }, { t: 1, color }], unknown: '#808080',
});
const live = Uint8Array.from([1, 1, 1, 0]);
const from = (f: OverlayFade) => [0, 1, 2, 3].map((s) => f.data[2 * s]);
const to = (f: OverlayFade) => [0, 1, 2, 3].map((s) => f.data[2 * s + 1]);
const rampEnd = (f: OverlayFade, row: number) => Array.from(f.ramp.subarray(row * RAMP_WIDTH * 4 + (RAMP_WIDTH - 1) * 4, row * RAMP_WIDTH * 4 + RAMP_WIDTH * 4 - 1));
/** Run frames until nothing moves; returns how many it took. */
const settle = (f: OverlayFade, dt = 50) => { let n = 0; while (f.step(dt, live) && n < 1000) n++; return n; };

describe('overlay fade', () => {
  it('maps values to ramp positions and NaN, missing and empty slots to unknown', () => {
    const f = new OverlayFade(300);
    f.resize(4);
    f.set(view('recency', [5, NaN]), live);
    expect(to(f)).toEqual([0.5, OVERLAY_UNKNOWN, OVERLAY_UNKNOWN, OVERLAY_UNKNOWN]);
    // nothing was showing: no cross-fade, only the fade from language colours
    expect(from(f)).toEqual(to(f));
    expect(f.blend).toBe(1);
    expect(f.mix).toBe(0);
    expect(settle(f)).toBeGreaterThan(1);
    expect(f.mix).toBe(1);
  });

  it('new values for the same overlay fade in from the old ones', () => {
    const f = new OverlayFade(300);
    f.resize(4);
    f.set(view('recency', [5, NaN, NaN]), live);
    settle(f);
    f.dataDirty = false;
    f.set(view('recency', [5, 10, NaN]), live);
    expect(f.dataDirty).toBe(true);
    expect(from(f).slice(0, 3)).toEqual([0.5, OVERLAY_UNKNOWN, OVERLAY_UNKNOWN]);
    expect(to(f).slice(0, 3)).toEqual([0.5, 1, OVERLAY_UNKNOWN]);
    expect(f.blend).toBe(0);
    f.step(150, live);
    expect(f.blend).toBeGreaterThan(0);
    expect(f.blend).toBeLessThan(1);
    expect(f.mix).toBe(1);
    // an update landing mid-fade waits for the fade instead of restarting it
    f.set(view('recency', [5, 10, 0]), live);
    expect(to(f).slice(0, 3)).toEqual([0.5, 1, OVERLAY_UNKNOWN]);
    settle(f);
    expect(to(f).slice(0, 3)).toEqual([0.5, 1, 0]);
    expect(f.blend).toBe(1);
  });

  it('switching overlays cross-fades between the two ramps, and null fades back to language colours', () => {
    const f = new OverlayFade(300);
    f.resize(4);
    f.set(view('recency', [10, 10, 10], '#00ff00'), live);
    settle(f);
    f.set(view('ownership', [0, 10, NaN], '#ff00ff'), live);
    expect(rampEnd(f, 0)).toEqual([0, 255, 0]);
    expect(rampEnd(f, 1)).toEqual([255, 0, 255]);
    expect(from(f).slice(0, 3)).toEqual([1, 1, 1]);
    expect(to(f).slice(0, 3)).toEqual([0, 1, OVERLAY_UNKNOWN]);
    expect(f.blend).toBe(0);
    settle(f);
    f.set(null, live);
    expect(f.showing).toBe(true);
    // the overlay's values stay in place while it fades out
    expect(to(f).slice(0, 3)).toEqual([0, 1, OVERLAY_UNKNOWN]);
    settle(f);
    expect(f.mix).toBe(0);
    expect(f.showing).toBe(false);
  });

  it('is instant under reduced motion, and keeps values across a resize', () => {
    const f = new OverlayFade(300, true);
    f.resize(4);
    f.set(view('recency', [5, 10, 0]), live);
    expect([f.mix, f.blend]).toEqual([1, 1]);
    f.set(view('recency', [0, 0, 0]), live);
    expect([f.mix, f.blend]).toEqual([1, 1]);
    expect(from(f)).toEqual(to(f));
    f.resize(8);
    expect(to(f).slice(0, 3)).toEqual([0, 0, 0]);
    expect(f.data[2 * 6 + 1]).toBe(OVERLAY_UNKNOWN);
    f.writeSlot(3, true);
    expect(f.data[2 * 3 + 1]).toBe(OVERLAY_UNKNOWN); // the view has no value for slot 3
    f.set(null, live);
    expect(f.mix).toBe(0);
  });
});
