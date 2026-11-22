import { describe, expect, it } from 'vitest';
import { pointInCell, territoryCells } from './cells';

const shape = { reach: 1.08, pad: 6, weight: 1 };
const bound = (r: number) => shape.reach * r + shape.pad / 2;

describe('territoryCells', () => {
  it('puts the border between two touching discs, not halfway between their centres', () => {
    // radii 30 and 10, centres 40 apart: the discs touch at x = 30
    const cells = territoryCells([{ x: 0, z: 0, bound: bound(30) }, { x: 40, z: 0, bound: bound(10) }], shape);
    const shared = cells[0].neighbour.indexOf(1);
    expect(shared).toBeGreaterThanOrEqual(0);
    expect(cells[0].ring[2 * shared]).toBeCloseTo(30, 6);
    expect(cells[1].neighbour).toContain(0);
    expect(pointInCell(cells[0].ring, 29, 0)).toBe(true);
    expect(pointInCell(cells[0].ring, 31, 0)).toBe(false);
    expect(pointInCell(cells[1].ring, 31, 0)).toBe(true);
  });

  it('leaves a lone district its whole reach', () => {
    const [cell] = territoryCells([{ x: 5, z: -3, bound: 20 }], shape);
    expect(cell.neighbour.every((t) => t === -1)).toBe(true);
    expect(pointInCell(cell.ring, 5 + 19, -3)).toBe(true);
  });
});
