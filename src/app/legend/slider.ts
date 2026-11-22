// The legend's arithmetic, kept pure (PLAN.md §8.1, §9): the logarithmic minimum-size slider, how
// many files a threshold hides, the per-language counts and the file-type filter's transitions.
import type { Config } from '../../config';
import { glowAmount } from '../../shared';
import { formatBytes } from '../units';

/**
 * Slider position (0..1) → minimum file size in bytes, logarithmic from 0 to the largest file: the
 * first half of the travel covers the small files, where most of a repo lives.
 */
export function sliderToSize(position: number, maxBytes: number): number {
  const t = Math.min(1, Math.max(0, position));
  if (!(maxBytes > 0) || t === 0) return 0;
  return Math.min(maxBytes, Math.round(Math.pow(maxBytes + 1, t) - 1));
}

/** Minimum size → slider position (0..1); the inverse of `sliderToSize` up to rounding. */
export function sizeToSlider(bytes: number, maxBytes: number): number {
  if (!(maxBytes > 0) || !(bytes > 0)) return 0;
  return Math.min(1, Math.log(bytes + 1) / Math.log(maxBytes + 1));
}

/** The size slider's rule: a file below the threshold is hidden unless it glows (the top files by importance). */
export function isHidden(bytes: number, importancePct: number, minBytes: number, visual: Config['visual']): boolean {
  return bytes < minBytes && glowAmount(importancePct, visual) <= 0;
}

/**
 * Sizes of the files the slider is able to hide (everything that does not glow), ascending.
 * Build it once per model revision; `countBelow` then answers each slider movement in O(log n).
 */
export function hideableSizes(bytes: ArrayLike<number>, importancePct: ArrayLike<number>, visual: Config['visual'], live?: (slot: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (live && !live(i)) continue;
    if (glowAmount(importancePct[i] ?? 0, visual) <= 0) out.push(bytes[i] ?? 0);
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

/** How many files a minimum of `minBytes` hides. Glowing files are exempt, so they count as visible. */
export function hiddenCount(bytes: ArrayLike<number>, importancePct: ArrayLike<number>, minBytes: number, visual: Config['visual']): number {
  return countBelow(hideableSizes(bytes, importancePct, visual), minBytes);
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

/** What a screen reader says for the slider's value: the threshold, then what it does to the map. */
export function minBytesValueText(minBytes: number, hidden: number, total: number): string {
  const size = formatBytes(minBytes);
  if (hidden <= 0) return `${size}, showing every file`;
  return `${size}, hiding ${hidden.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}`;
}

/**
 * A click on a legend row. Plain click isolates that type, or clears the filter when it is already
 * the only one; Shift+click adds the type to the filter or takes it out. Empty = every type shown.
 */
export function nextTypeFilter(current: readonly string[], lang: string, shift: boolean): string[] {
  if (shift) return current.includes(lang) ? current.filter((l) => l !== lang) : [...current, lang];
  return current.length === 1 && current[0] === lang ? [] : [lang];
}
