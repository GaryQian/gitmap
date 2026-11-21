// Keeping city and district ids across re-runs (AnalysisInput.previous): a new community that is
// mostly an old one keeps the old id. Independent of how the communities were found.

/**
 * Match new groups to previous ids by shared members.
 * @param groupOf    new group index per member
 * @param groupCount number of new groups
 * @param prevOf     previous id per member (undefined when the member is new)
 * @returns per new group, the previous id it continues, or undefined
 *
 * Pairs are taken greedily by overlap, each side used once. A pair counts as "the same community"
 * when the overlap is more than half of the smaller side.
 */
export function matchPrevious(
  groupOf: ArrayLike<number>, groupCount: number, prevOf: readonly (string | undefined)[],
): (string | undefined)[] {
  const size = new Int32Array(groupCount);
  const prevSize = new Map<string, number>();
  const overlap: Map<string, number>[] = Array.from({ length: groupCount }, () => new Map());
  for (let i = 0; i < groupOf.length; i++) {
    const g = groupOf[i];
    size[g]++;
    const p = prevOf[i];
    if (p === undefined) continue;
    prevSize.set(p, (prevSize.get(p) ?? 0) + 1);
    overlap[g].set(p, (overlap[g].get(p) ?? 0) + 1);
  }
  const pairs: { g: number; id: string; n: number }[] = [];
  for (let g = 0; g < groupCount; g++) for (const [id, n] of overlap[g]) pairs.push({ g, id, n });
  pairs.sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.g - b.g);

  const kept: (string | undefined)[] = new Array(groupCount).fill(undefined);
  const taken = new Set<string>();
  for (const { g, id, n } of pairs) {
    if (kept[g] !== undefined || taken.has(id)) continue;
    if (n * 2 <= Math.min(size[g], prevSize.get(id)!)) continue;
    kept[g] = id;
    taken.add(id);
  }
  return kept;
}

/**
 * Final ids: a kept previous id where there is one, else the group's own fresh id, made unique
 * with a '~2', '~3', ... suffix when something else already holds it.
 */
export function mintIds(fresh: readonly string[], kept: readonly (string | undefined)[]): string[] {
  const used = new Set<string>();
  for (const k of kept) if (k !== undefined) used.add(k);
  return fresh.map((id, g) => {
    if (kept[g] !== undefined) return kept[g]!;
    let out = id;
    for (let k = 2; used.has(out); k++) out = `${id}~${k}`;
    used.add(out);
    return out;
  });
}
