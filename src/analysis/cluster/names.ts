// Naming communities (PLAN.md §6.6): the most distinctive shared path.
//
// Tokens are the directories on a file's path ('a', 'a/b', 'a/b/c' for a/b/c/x.ts). Among sibling
// communities (all cities, or the districts of one city) a directory scores
//     (share of the community's files under it) × (share of the files under it that are in the community)
// which is TF × IDF with both sides as plain shares: "packages" holds every community and scores
// low for each; the folder one community mostly owns scores high there. Ties go to the shallower
// directory, so a city that is one top-level folder gets that folder's name. The name is the
// directory's last segment. Siblings never share a name: the weaker claim falls back to a longer
// path ("react-dom/server"), then to a numeric suffix.

export class Namer {
  // Per directory: last segment, full path, parent directory (-1 at the top), depth.
  private readonly text: string[] = [];
  private readonly full: string[] = [];
  private readonly parent: number[] = [];
  private readonly depth: number[] = [];
  /** Directory per unit node, -1 for a file at the repo root. */
  private readonly dirOf: Int32Array;
  // Per-directory scratch, zero between calls.
  private readonly total: Int32Array;
  private readonly count: Int32Array;

  /** @param paths path per unit node */
  constructor(paths: readonly string[]) {
    const ids = new Map<string, number>();
    const dir = (path: string): number => {
      const cut = path.lastIndexOf('/');
      if (cut < 0) return -1;
      const full = path.slice(0, cut);
      let d = ids.get(full);
      if (d !== undefined) return d;
      const up = dir(full);
      d = this.text.length;
      ids.set(full, d);
      this.text.push(full.slice(full.lastIndexOf('/') + 1));
      this.full.push(full);
      this.parent.push(up);
      this.depth.push(up < 0 ? 0 : this.depth[up] + 1);
      return d;
    };
    this.dirOf = Int32Array.from(paths, dir);
    this.total = new Int32Array(this.text.length);
    this.count = new Int32Array(this.text.length);
  }

  /**
   * One name per sibling group, unique among them and never empty.
   * @param groups   unit nodes per group
   * @param fallback name for a group whose files sit in no directory
   */
  name(groups: readonly ArrayLike<number>[], fallback: string): string[] {
    const { text, full, parent, depth, dirOf, total, count } = this;
    for (const group of groups) {
      for (let j = 0; j < group.length; j++) for (let d = dirOf[group[j]]; d >= 0; d = parent[d]) total[d]++;
    }

    const base: string[] = [];
    const longer: (string | undefined)[] = [];
    const score = new Float64Array(groups.length);
    const touched: number[] = [];
    groups.forEach((group, g) => {
      touched.length = 0;
      for (let j = 0; j < group.length; j++) {
        for (let d = dirOf[group[j]]; d >= 0; d = parent[d]) if (count[d]++ === 0) touched.push(d);
      }
      let best = -1, top = 0;
      for (const d of touched) {
        const s = (count[d] * count[d]) / (group.length * total[d]);
        if (best < 0 || s > top || (s === top && (depth[d] < depth[best] || (depth[d] === depth[best] && full[d] < full[best])))) { best = d; top = s; }
        count[d] = 0;
      }
      base[g] = best < 0 || text[best] === '' ? fallback || 'root' : text[best];
      longer[g] = best >= 0 && parent[best] >= 0 ? `${text[parent[best]]}/${text[best]}` : undefined;
      score[g] = top;
    });
    for (const group of groups) {
      for (let j = 0; j < group.length; j++) for (let d = dirOf[group[j]]; d >= 0; d = parent[d]) total[d] = 0;
    }

    // The strongest claim keeps the plain name.
    const order = groups.map((_, g) => g).sort((x, y) => score[y] - score[x] || groups[y].length - groups[x].length || x - y);
    const used = new Set<string>();
    const names = new Array<string>(groups.length);
    for (const g of order) {
      let name = base[g];
      if (used.has(name) && longer[g] !== undefined) name = longer[g];
      for (let k = 2; used.has(name); k++) name = `${base[g]} ${k}`;
      used.add(name);
      names[g] = name;
    }
    return names;
  }
}
