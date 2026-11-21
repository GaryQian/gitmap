// Ordering helpers. Every stage iterates files and units in path order so the output never depends
// on the order facts arrived in.
import type { FileFacts } from '../contracts/lang';

/** Code-unit comparison: the same on every engine and locale (never localeCompare). */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Files in path order, one per path (a repeated path keeps the entry with the smallest oid). */
export function sortFiles(files: readonly FileFacts[]): FileFacts[] {
  const sorted = [...files].sort((a, b) => comparePaths(a.path, b.path) || comparePaths(a.oid, b.oid));
  let w = 0;
  for (let r = 0; r < sorted.length; r++) {
    if (w > 0 && sorted[w - 1].path === sorted[r].path) continue;
    sorted[w++] = sorted[r];
  }
  sorted.length = w;
  return sorted;
}
