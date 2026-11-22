import { describe, expect, it } from 'vitest';
import { placeCard, placePills, type PillRequest, type Rect } from './layout';

const pill = (id: string, x: number, y: number, priority: number): PillRequest => ({ id, x, y, width: 100, height: 24, priority });
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('point-of-interest pill placement', () => {
  it('puts a pill centred above its anchor', () => {
    const placed = placePills([pill('a', 300, 200, 1)], 4, 2);
    expect(placed.get('a')).toEqual({ x: 250, y: 176, width: 100, height: 24 });
  });

  it('nudges the lower-priority pill up its beam, and never lets two overlap', () => {
    const placed = placePills([pill('far', 310, 205, 9), pill('near', 300, 200, 1)], 4, 2);
    const near = placed.get('near')!, far = placed.get('far')!;
    expect(near.y).toBe(176);
    expect(far.x).toBe(260);
    expect(far.y).toBeLessThan(near.y - 24);
    expect(overlap(near, far)).toBe(false);
  });

  it('hides a pill that still overlaps after its nudges, lowest priority first', () => {
    const crowd = [0, 1, 2, 3, 4].map((i) => pill(`p${i}`, 300 + i, 200, i));
    const placed = placePills(crowd, 4, 2);
    expect([...placed.keys()].sort()).toEqual(['p0', 'p1', 'p2']);
    const rects = [...placed.values()];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!)).toBe(false);
  });
});

describe('detail card placement', () => {
  const view = { width: 1000, height: 700 };
  const card = { width: 340, height: 300 };
  const o = { gap: 12, margin: 12, topMargin: 58, rise: 10 };

  it('sits to the right of the pill, or to the left when the right has no room', () => {
    expect(placeCard({ x: 200, y: 300, width: 100, height: 24 }, card, view, o)).toEqual({ x: 312, y: 290 });
    expect(placeCard({ x: 800, y: 300, width: 100, height: 24 }, card, view, o)).toEqual({ x: 448, y: 290 });
  });

  it('stays inside the view when its anchor does not', () => {
    for (const anchor of [{ x: -500, y: -90 }, { x: 2000, y: 900 }, { x: 480, y: 690 }]) {
      const at = placeCard({ ...anchor, width: 100, height: 24 }, card, view, o);
      expect(at.x).toBeGreaterThanOrEqual(o.margin);
      expect(at.x + card.width).toBeLessThanOrEqual(view.width - o.margin);
      expect(at.y).toBeGreaterThanOrEqual(o.topMargin);
      expect(at.y + card.height).toBeLessThanOrEqual(view.height - o.margin);
    }
  });
});
