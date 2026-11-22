import { describe, expect, it } from 'vitest';
import { APP_LOCAL } from '../tunables';
import { distanceFade, keepPills, type PillBox } from './place';

const box = (x: number, tier: number, depth: number, sticky = false): PillBox => ({ x, y: 0, width: 100, height: 26, tier, sticky, depth });

describe('in-scene pill placement', () => {
  it('drops the lower-priority pill of an overlapping pair and respects the cap', () => {
    const city = box(0, 1, 500), district = box(50, 2, 100), apart = box(300, 2, 400), far = box(600, 2, 900);
    expect(keepPills([district, far, apart, city], 10)).toEqual([city, apart, far]);
    expect(keepPills([district, far, apart, city], 2)).toEqual([city, apart]);
  });

  it('keeps pills out from under the chrome, except one being dragged', () => {
    const chrome = [{ x: 0, y: 0, width: 150, height: 40 }];
    const under = box(20, 1, 100), dragged = box(20, 0, 100), clear = box(400, 1, 100);
    expect(keepPills([under, clear], 10, chrome)).toEqual([clear]);
    expect(keepPills([dragged], 10, chrome)).toEqual([dragged]);
  });

  it('fades far pills down to the floor it is given, and no further', () => {
    const { fadeStart, fadeEnd } = APP_LOCAL.pills;
    expect(distanceFade(100, 100, 0.7)).toBe(1);
    expect(distanceFade(100 * fadeEnd * 2, 100, 0.7)).toBe(0.7);
    const midway = distanceFade(100 * (fadeStart + fadeEnd) / 2, 100, 0.7);
    expect(midway).toBeGreaterThan(0.7);
    expect(midway).toBeLessThan(1);
    expect(distanceFade(500, Infinity, 0.7)).toBe(1); // before the first frame says where the camera is
  });

  it('lets a pill that was already showing keep its place over a nearer newcomer', () => {
    const showing = box(0, 1, 800, true), newcomer = box(40, 1, 200);
    expect(keepPills([newcomer, showing], 10)).toEqual([showing]);
  });
});
