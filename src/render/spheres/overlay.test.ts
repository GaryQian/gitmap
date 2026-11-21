import { describe, expect, it } from 'vitest';
import { OVERLAY_UNKNOWN, buildRamp, overlayT } from './overlay';

const texel = (ramp: Uint8Array, i: number) => Array.from(ramp.subarray(4 * i, 4 * i + 4));

describe('overlay ramp', () => {
  const stops = [{ t: 0, color: '#000000' }, { t: 0.5, color: '#ff0000' }, { t: 1, color: '#ffffff' }];

  it('interpolates between stops and lands on them exactly', () => {
    const ramp = buildRamp(stops, false, 101);
    expect(ramp.length).toBe(101 * 4);
    expect(texel(ramp, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(ramp, 50)).toEqual([255, 0, 0, 255]);
    expect(texel(ramp, 100)).toEqual([255, 255, 255, 255]);
    const quarter = texel(ramp, 25);
    expect(quarter[0]).toBeGreaterThan(100);
    expect(quarter[0]).toBeLessThan(155);
    expect(quarter[1]).toBe(0);
  });

  it('snaps to the nearest stop when discrete', () => {
    const ramp = buildRamp(stops, true, 101);
    expect(texel(ramp, 20)).toEqual([0, 0, 0, 255]);
    expect(texel(ramp, 30)).toEqual([255, 0, 0, 255]);
    expect(texel(ramp, 70)).toEqual([255, 0, 0, 255]);
    expect(texel(ramp, 80)).toEqual([255, 255, 255, 255]);
  });

  it('accepts unsorted stops, a single stop, and stops that do not span 0..1', () => {
    expect(buildRamp([...stops].reverse(), false, 101)).toEqual(buildRamp(stops, false, 101));
    const flat = buildRamp([{ t: 0.3, color: '#102030' }], false, 8);
    for (let i = 0; i < 8; i++) expect(texel(flat, i)).toEqual([16, 32, 48, 255]);
    const inner = buildRamp([{ t: 0.4, color: '#000000' }, { t: 0.6, color: '#ffffff' }], false, 11);
    expect(texel(inner, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(inner, 10)).toEqual([255, 255, 255, 255]);
  });
});

describe('overlay value mapping', () => {
  it('maps the domain onto 0..1 and clamps', () => {
    expect(overlayT(5, [0, 10])).toBeCloseTo(0.5);
    expect(overlayT(-3, [0, 10])).toBe(0);
    expect(overlayT(40, [0, 10])).toBe(1);
  });

  it('marks NaN and missing values as unknown', () => {
    expect(overlayT(NaN, [0, 1])).toBe(OVERLAY_UNKNOWN);
    expect(overlayT(undefined, [0, 1])).toBe(OVERLAY_UNKNOWN);
    expect(OVERLAY_UNKNOWN).toBeLessThan(0);
  });
});
