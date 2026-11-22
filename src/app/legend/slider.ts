// The legend's arithmetic, kept pure (PLAN.md §8.1, §9): the logarithmic minimum-lines slider, how
// many files a threshold hides, the per-language counts and the file-type filter's transitions.
import type { Config } from '../../config';
import { glowAmount } from '../../shared';

/**
 * Slider position (0..1) → minimum line count, logarithmic from 0 to the largest file: the first
 * half of the travel covers the small files, where most of a repo lives.
 */
export function sliderToLines(position: number, maxLines: number): number {
  const t = Math.min(1, Math.max(0, position));
  if (!(maxLines > 0) || t === 0) return 0;
  return Math.min(maxLines, Math.round(Math.pow(maxLines + 1, t) - 1));
}

/** Minimum line count → slider position (0..1); the inverse of `sliderToLines` up to rounding. */
export function linesToSlider(lines: number, maxLines: number): number {
  if (!(maxLines > 0) || !(lines > 0)) return 0;
  return Math.min(1, Math.log(lines + 1) / Math.log(maxLines + 1));
}

/** The size slider's rule: a file below the threshold is hidden unless it glows (the top files by importance). */
export function isHidden(loc: number, importancePct: number, minLines: number, visual: Config['visual']): boolean {
  return loc < minLines && glowAmount(importancePct, visual) <= 0;
}

/**
 * Line counts of the files the slider is able to hide (everything that does not glow), ascending.
 * Build it once per model revision; `countBelow` then answers each slider movement in O(log n).
 */
export function hideableLines(loc: ArrayLike<number>, importancePct: ArrayLike<number>, visual: Config['visual'], live?: (slot: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < loc.length; i++) {
    if (live && !live(i)) continue;
    if (glowAmount(importancePct[i] ?? 0, visual) <= 0) out.push(loc[i] ?? 0);
  }
  return out.sort((a, b) => a - b);
}

/** How many entries of an ascending list are below `n`. */
export function countBelow(sorted: ArrayLike<number>, n: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < n) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** How many files a minimum of `minLines` hides. Glowing files are exempt, so they count as visible. */
export function hiddenCount(loc: ArrayLike<number>, importancePct: ArrayLike<number>, minLines: number, visual: Config['visual']): number {
  return countBelow(hideableLines(loc, importancePct, visual), minLines);
}

export interface LanguageCount { lang: string; count: number }

/** Files per language, most files first; ties in id order so rows do not swap places. */
export function languageCounts(langs: ArrayLike<string>, live?: (slot: number) => boolean): LanguageCount[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < langs.length; i++) {
    if (live && !live(i)) continue;
    const lang = langs[i] || 'other';
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count || (a.lang < b.lang ? -1 : 1));
}

/**
 * A click on a legend row. Plain click isolates that type, or clears the filter when it is already
 * the only one; Shift+click adds the type to the filter or takes it out. Empty = every type shown.
 */
export function nextTypeFilter(current: readonly string[], lang: string, shift: boolean): string[] {
  if (shift) return current.includes(lang) ? current.filter((l) => l !== lang) : [...current, lang];
  return current.length === 1 && current[0] === lang ? [] : [lang];
}
