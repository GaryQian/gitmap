import { describe, expect, it } from 'vitest';
import { isPhone, PHONE_MAX_SIDE } from './phone';

describe('isPhone', () => {
  const touch = { coarsePointer: true, mobileAgent: true };
  const mouse = { coarsePointer: false, mobileAgent: false };

  it('is a phone upright or sideways', () => {
    expect(isPhone({ width: 390, height: 844, ...touch })).toBe(true);
    expect(isPhone({ width: 844, height: 390, ...touch })).toBe(true);
    // either signal of a touch device is enough: some browsers report only one
    expect(isPhone({ width: 390, height: 844, coarsePointer: true, mobileAgent: false })).toBe(true);
    expect(isPhone({ width: 390, height: 844, coarsePointer: false, mobileAgent: true })).toBe(true);
  });

  it('is not a desktop window, however small, nor a tablet', () => {
    expect(isPhone({ width: 1440, height: 900, ...mouse })).toBe(false);
    expect(isPhone({ width: 380, height: 500, ...mouse })).toBe(false);
    expect(isPhone({ width: 1024, height: 768, ...touch })).toBe(false);
    expect(isPhone({ width: PHONE_MAX_SIDE + 1, height: 2000, ...touch })).toBe(false);
  });
});
