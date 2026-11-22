import { describe, expect, it } from 'vitest';
import type { NodeRef } from '../model/types';
import {
  EMPTY_SELECTION, clearSelection, clickSelect, focusSelected, marqueeSelect, removeSelected, replaceSelection, shiftClickSelect,
} from './selectionState';

const a: NodeRef = 'u:a.ts', b: NodeRef = 'u:b.ts', c: NodeRef = 'u:c.ts';

describe('selection transitions', () => {
  it('click replaces and focuses; click on empty space clears', () => {
    const one = clickSelect({ selection: [a, b], focus: a }, c);
    expect(one).toEqual({ selection: [c], focus: c });
    expect(clickSelect(one, null)).toEqual(EMPTY_SELECTION);
  });

  it('Shift+click adds and focuses, then removes; on empty space it changes nothing', () => {
    const two = shiftClickSelect(clickSelect(EMPTY_SELECTION, a), b);
    expect(two).toEqual({ selection: [a, b], focus: b });
    expect(shiftClickSelect(two, null)).toBe(two);
    // removing the focused node hands the focus to the most recent one left
    expect(shiftClickSelect(two, b)).toEqual({ selection: [a], focus: a });
    expect(shiftClickSelect(two, a)).toEqual({ selection: [b], focus: b });
  });

  it('marquee adds without duplicates and keeps the focus', () => {
    const start = clickSelect(EMPTY_SELECTION, a);
    expect(marqueeSelect(start, [b, a, c, b])).toEqual({ selection: [a, b, c], focus: a });
    expect(marqueeSelect(EMPTY_SELECTION, [b, c])).toEqual({ selection: [b, c], focus: null });
    expect(marqueeSelect(start, [a])).toBe(start);
  });

  it('remove, focus, replace and clear keep focus inside the selection', () => {
    const three = { selection: [a, b, c], focus: b };
    expect(removeSelected(three, b)).toEqual({ selection: [a, c], focus: c });
    expect(removeSelected(three, a)).toEqual({ selection: [b, c], focus: b });
    expect(focusSelected(three, c).focus).toBe(c);
    expect(focusSelected(three, 'u:elsewhere.ts')).toBe(three);
    expect(focusSelected(three, null)).toEqual({ selection: [a, b, c], focus: null });
    expect(replaceSelection(three, [c])).toEqual({ selection: [c], focus: c });
    expect(replaceSelection(three, [a, c])).toEqual({ selection: [a, c], focus: null });
    expect(replaceSelection(three, [a, b])).toEqual({ selection: [a, b], focus: b });
    expect(clearSelection(three)).toEqual(EMPTY_SELECTION);
  });
});
