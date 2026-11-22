import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import {
  countBelow, hiddenCount, hideableSizes, isHidden, languageCounts, sizeToSlider, minBytesValueText, nextTypeFilter, sliderToSize,
} from './slider';

describe('minimum-size slider', () => {
  it('runs from 0 to the largest file, never decreasing, and round-trips', () => {
    const max = 20000;
    expect(sliderToSize(0, max)).toBe(0);
    expect(sliderToSize(1, max)).toBe(max);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const size = sliderToSize(i / 100, max);
      expect(size).toBeGreaterThanOrEqual(previous);
      expect(sliderToSize(sizeToSlider(size, max), max)).toBe(size);
      previous = size;
    }
  });

  it('is logarithmic: half the travel is far below half the range', () => {
    expect(sliderToSize(0.5, 10000)).toBeLessThan(1000);
    expect(sliderToSize(0.5, 10000)).toBeGreaterThan(10);
  });

  it('copes with an empty or tiny repo', () => {
    expect(sliderToSize(0.7, 0)).toBe(0);
    expect(sizeToSlider(50, 0)).toBe(0);
    expect(sliderToSize(1, 1)).toBe(1);
  });
});

describe('hidden count', () => {
  const visual = config.visual;
  const dull = 0;                       // never glows
  const glowing = 1;                    // the most important file always glows
  const bytes = [5, 50, 500, 5, 5000];
  const pct = [dull, dull, dull, glowing, dull];

  it('counts files below the threshold, except the glowing ones', () => {
    expect(hiddenCount(bytes, pct, 0, visual)).toBe(0);
    expect(hiddenCount(bytes, pct, 5, visual)).toBe(0);     // strictly below: a 5-byte file passes "at least 5"
    expect(hiddenCount(bytes, pct, 6, visual)).toBe(1);     // the dull 5-byte file; the glowing one stays
    expect(hiddenCount(bytes, pct, 501, visual)).toBe(3);
    expect(hiddenCount(bytes, pct, 1e9, visual)).toBe(4);   // everything but the glowing file
  });

  it('agrees with the per-file rule for every threshold', () => {
    for (const min of [0, 1, 5, 6, 50, 51, 499, 500, 5000, 5001]) {
      const expected = bytes.filter((l, i) => isHidden(l, pct[i]!, min, visual)).length;
      expect(countBelow(hideableSizes(bytes, pct, visual), min)).toBe(expected);
    }
  });

  it('skips empty slots', () => {
    expect(hideableSizes(bytes, pct, visual, (slot) => slot !== 0)).toEqual([50, 500, 5000]);
  });
});

describe('legend rows and the file-type filter', () => {
  it('counts files per language, most first', () => {
    expect(languageCounts(['ts', 'py', 'ts', '', 'py', 'ts'])).toEqual([
      { lang: 'ts', count: 3 }, { lang: 'py', count: 2 }, { lang: 'other', count: 1 },
    ]);
  });

  it('says the slider value as a size and what it hides', () => {
    expect(minBytesValueText(0, 0, 2000)).toBe('0 bytes, showing every file');
    expect(minBytesValueText(1, 3, 2000)).toBe(`1 byte, hiding 3 of ${(2000).toLocaleString()} files`);
    expect(minBytesValueText(14 * 1024, 1, 1)).toBe('14 KB, hiding 1 of 1 file');
  });

  it('click isolates or clears; Shift+click adds or removes', () => {
    expect(nextTypeFilter([], 'ts', false)).toEqual(['ts']);
    expect(nextTypeFilter(['ts'], 'ts', false)).toEqual([]);
    expect(nextTypeFilter(['ts', 'py'], 'ts', false)).toEqual(['ts']);
    expect(nextTypeFilter(['ts'], 'py', true)).toEqual(['ts', 'py']);
    expect(nextTypeFilter(['ts', 'py'], 'ts', true)).toEqual(['py']);
  });
});
