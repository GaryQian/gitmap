// Cutting a stretch of a path into matched and unmatched pieces for display. Pure.

export interface Piece { text: string; hit: boolean }

/**
 * `path.slice(from, to)` as pieces, given the match `ranges` of the whole path (start, end pairs,
 * end exclusive, ascending, as the search engine reports them).
 */
export function pieces(path: string, ranges: readonly number[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  let at = from;
  for (let k = 0; k + 1 < ranges.length && at < to; k += 2) {
    const start = Math.max(ranges[k]!, at);
    const end = Math.min(ranges[k + 1]!, to);
    if (end <= start) continue;
    if (start > at) out.push({ text: path.slice(at, start), hit: false });
    out.push({ text: path.slice(start, end), hit: true });
    at = end;
  }
  if (at < to) out.push({ text: path.slice(at, to), hit: false });
  return out;
}
