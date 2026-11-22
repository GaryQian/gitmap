// Naming communities (PLAN.md §6.6): what sets a community apart from its siblings.
//
// Siblings are the groups named together: all cities, or the districts of one city. A name is the
// first of these that no sibling holds yet:
//
//   1. The name the community had before (`previous`), so a pill does not change on a re-run.
//   2. A range of file names, for a piece of one flat directory: a group with half its files
//      directly in a directory whose own files it shares with siblings. A directory with no code
//      in it is cut into runs of neighbouring files (graph.ts), so its pieces are contiguous in
//      path order: "base_api Queu–Reso", "ops_history_v2 A–Conv", "advisory 2018–2021". Each end
//      is the shortest prefix that tells it from the other end and from the file across the
//      boundary, a few characters at most, without what the whole directory shares ("api_def_").
//   3. Its most distinctive directory. Tokens are the directories on a file's path ('a', 'a/b',
//      'a/b/c' for a/b/c/x.ts) and a directory scores
//          (share of the group's files under it) × (share of the files under it that are in the group)
//      which is TF × IDF with both sides as plain shares. Directories that hold every sibling say
//      nothing about one of them: only the deepest of those stands, for the group that is the
//      bulk of its parent. Ties go to the shallower directory. The name is the directory's last
//      segment, or the one above when that says nothing ("react-dom" for react-dom/src); two
//      directories with the same last segment are both qualified ("inline/index-map").
//   4. For a group that shares that directory with a stronger claim: a word of the file names that
//      is mostly its own ("server edge", "kernels conv"), else its next most distinctive
//      directory, alone when it holds a third of the group ("svg") and behind the shared one when
//      it holds less ("packages/react-dom"), else the span of its file names.
//   5. A number ("compiler 2"), when the paths offer nothing else.
//
// Names are never empty and never repeated among siblings. Without `previous` they depend only on
// the paths: not on the order of the groups, of their members, or of the paths given to the
// constructor. One call costs the files of the groups times their depth, plus the own files of
// the directories that are cut into pieces.
import { comparePaths } from '../order';

/** Segments that name nothing: the directory above them is the name. */
const NOISE = new Set(['src', 'source', 'sources', 'lib', 'main']);
/** Names are kept to this length where there is a choice. */
const LIMIT = 24;
/** A directory below the most distinctive one is preferred while it keeps this share of the group's files there. */
const DEEPER = 0.9;
/** How many other directories a group may fall back on. */
const ALTERNATIVES = 4;
/**
 * A directory under the shared one is named beside it ("packages/react-dom") when it holds one in
 * MINOR of the group's files, or when the group is a grab-bag with most files in such directories.
 */
const MINOR = 8;
/** A word of the file names stands for a group when one in WORD of its files there has it. */
const WORD = 5;
/** A group holding this share of a directory's own files is that directory, not a piece of it. */
const OWNED = 0.8;
/** A piece is a range when its files fill this share of the span from its first to its last. */
const CONTIGUOUS = 0.8;
/** A directory's name is cut to no fewer characters than this to make room for a range. */
const SHORT = 8;
/** Characters per end of a range: as few as tell the pieces apart. */
const EDGE = [4, 8, 64];
/** A number at the end of a range is written out up to this many characters. */
const NUMBER = 8;
const DIGIT = /\d/;
const ALNUM = /[\p{L}\p{N}]/u;
const TRAILING = /[^\p{L}\p{N}]+$/u;

interface Claim {
  size: number;
  /** Smallest path rank among the members: an order of groups that does not depend on their index. */
  first: number;
  /** Most distinctive directory (-1: the files sit in none) and its score. */
  best: number;
  score: number;
  /** Next most distinctive directories that are not above `best`, and the group's files under each. */
  alts: number[];
  altFiles: number[];
  /** Directory holding most of the group's files directly, and how many. */
  home: number;
  homeFiles: number;
  /** The group's files directly in `best`. */
  bestFiles: number;
}

export class Namer {
  private readonly paths: readonly string[];
  // Per directory: last segment, full path, parent directory (-1 at the top), depth.
  private readonly text: string[] = [];
  private readonly full: string[] = [];
  private readonly parent: number[] = [];
  private readonly depth: number[] = [];
  /** Directory per unit node, -1 for a file at the repo root. */
  private readonly dirOf: Int32Array;
  /** Position of each unit node in path order. */
  private readonly rank: Int32Array;
  /** Unit nodes directly in each directory, in path order: dirFiles[dirStart[d] .. dirStart[d + 1]]. */
  private readonly dirStart: Int32Array;
  private readonly dirFiles: Int32Array;
  private readonly prefixes = new Map<number, string>();
  // Scratch, clear between calls. Per directory: sibling files under it and directly in it, and the
  // same for the group at hand. Per unit node: its group in this call.
  private readonly total: Int32Array;
  private readonly ownTotal: Int32Array;
  private readonly count: Int32Array;
  private readonly own: Int32Array;
  private readonly groupOf: Int32Array;

  /** @param paths path per unit node, in any order */
  constructor(paths: readonly string[]) {
    this.paths = paths;
    const n = paths.length;
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
    const dirs = this.text.length;

    const order = new Int32Array(n);
    let sorted = true;
    for (let i = 0; i < n; i++) { order[i] = i; if (i > 0 && paths[i - 1] > paths[i]) sorted = false; }
    if (!sorted) order.sort((x, y) => comparePaths(paths[x], paths[y]));
    this.rank = new Int32Array(n);
    this.dirStart = new Int32Array(dirs + 1);
    for (let k = 0; k < n; k++) { this.rank[order[k]] = k; if (this.dirOf[k] >= 0) this.dirStart[this.dirOf[k] + 1]++; }
    for (let d = 0; d < dirs; d++) this.dirStart[d + 1] += this.dirStart[d];
    this.dirFiles = new Int32Array(this.dirStart[dirs]);
    const fill = this.dirStart.slice(0, dirs);
    for (let k = 0; k < n; k++) { const d = this.dirOf[order[k]]; if (d >= 0) this.dirFiles[fill[d]++] = order[k]; }

    this.total = new Int32Array(dirs);
    this.ownTotal = new Int32Array(dirs);
    this.count = new Int32Array(dirs);
    this.own = new Int32Array(dirs);
    this.groupOf = new Int32Array(n).fill(-1);
  }

  /**
   * One name per sibling group, unique among them and never empty.
   * @param groups   unit nodes per group; the groups share no node
   * @param fallback name for a group whose files sit in no directory
   * @param previous per group, the name it had on the last run (when the community persists): it
   *                 is kept unless a sibling holds it already
   */
  name(groups: readonly ArrayLike<number>[], fallback: string, previous?: readonly (string | undefined)[]): string[] {
    const { parent, dirOf, total, ownTotal, groupOf } = this;
    let files = 0;
    let any = -1;
    groups.forEach((group, g) => {
      files += group.length;
      for (let j = 0; j < group.length; j++) {
        const node = group[j];
        any = node;
        groupOf[node] = g;
        if (dirOf[node] >= 0) ownTotal[dirOf[node]]++;
        for (let d = dirOf[node]; d >= 0; d = parent[d]) total[d]++;
      }
    });
    // The deepest directory that holds every file.
    let common = any < 0 ? -1 : dirOf[any];
    while (common >= 0 && total[common] !== files) common = parent[common];

    const claims = groups.map((group) => this.claim(group, files, common));
    const names = new Array<string | undefined>(groups.length).fill(undefined);
    const taken = new Set<string>();
    const take = (g: number, options: readonly string[], numbered: string): void => {
      let name = options.find((o) => o !== '' && !taken.has(o));
      for (let k = 2; name === undefined; k++) if (!taken.has(`${numbered} ${k}`)) name = `${numbered} ${k}`;
      names[g] = name;
      taken.add(name);
    };
    const byPath = groups.map((_, g) => g).sort((x, y) => claims[x].first - claims[y].first || x - y);

    // 1. Names kept from the last run.
    if (previous) {
      for (const g of byPath) {
        const kept = previous[g];
        if (kept && !taken.has(kept)) { names[g] = kept; taken.add(kept); }
      }
    }

    // The sibling files directly in a directory, in path order, and where each of its pieces lies.
    const listings = new Map<number, number[]>();
    const lo = new Int32Array(groups.length).fill(-1);
    const hi = new Int32Array(groups.length).fill(-1);
    const listing = (dir: number): number[] => {
      let list = listings.get(dir);
      if (list) return list;
      list = [];
      for (let k = this.dirStart[dir]; k < this.dirStart[dir + 1]; k++) {
        const g = groupOf[this.dirFiles[k]];
        if (g < 0) continue;
        if (claims[g].home === dir) { if (lo[g] < 0) lo[g] = list.length; hi[g] = list.length; }
        list.push(this.dirFiles[k]);
      }
      listings.set(dir, list);
      return list;
    };
    const isPiece = (c: Claim): boolean => c.home >= 0 && c.homeFiles * 2 >= c.size && c.homeFiles < OWNED * ownTotal[c.home];
    // Range names for a piece, best first: with the directory where that fits ("ops a–f"); without
    // it where only that fits and the file names carry the meaning ("error.invalid-muta–reas");
    // with the directory cut short ("preserve-memo-val… e–pres"); and as long as it takes otherwise.
    const ranges = (g: number): string[] => {
      const list = listing(claims[g].home);
      const fits: string[] = [];
      const long: string[] = [];
      const label = this.label(claims[g].home);
      for (const cap of EDGE) {
        const [span, bare] = this.range(claims[g].home, list, lo[g], hi[g], cap);
        const withDir = `${label} ${span}`;
        if (taken.has(withDir) || taken.has(bare)) continue;
        const room = LIMIT - span.length - 2;
        if (withDir.length <= LIMIT) fits.push(withDir);
        else if (bare !== '' && bare.length <= LIMIT) fits.push(bare);
        else if (bare === '' && room >= SHORT) fits.push(`${label.slice(0, room).replace(TRAILING, '')}… ${span}`);
        long.push(bare === '' ? withDir : bare);
      }
      return [...fits, ...long];
    };

    // 2. Contiguous pieces of a flat directory: ranges of file names.
    for (const g of byPath) {
      const c = claims[g];
      if (names[g] !== undefined || !isPiece(c)) continue;
      listing(c.home);
      if (c.homeFiles < CONTIGUOUS * (hi[g] - lo[g] + 1)) continue;
      const name = ranges(g).find((o) => !taken.has(o));
      if (name !== undefined) { names[g] = name; taken.add(name); }
    }

    // 3–5. Directories, strongest claim first.
    const rest = byPath.filter((g) => names[g] === undefined)
      .sort((x, y) => claims[y].score - claims[x].score || claims[y].size - claims[x].size || claims[x].first - claims[y].first);
    const owner = new Map<number, number>();
    for (const g of rest) if (claims[g].best >= 0 && !owner.has(claims[g].best)) owner.set(claims[g].best, g);
    const sameLabel = new Map<string, number[]>();
    for (const d of owner.keys()) sameLabel.set(this.label(d), [...(sameLabel.get(this.label(d)) ?? []), d]);
    const plain = (d: number): boolean => {
      const same = sameLabel.get(this.label(d))!;
      const o = this.origin(d);
      return same.length === 1 || (d === o && same.every((x) => this.origin(x) === o));
    };
    const words = new Map<number, Map<string, number>>();
    for (const g of rest) {
      const c = claims[g];
      const base = (c.best >= 0 ? this.label(c.best) : fallback) || 'root';
      const options: string[] = [];
      if (c.best < 0) options.push(base);
      else if (owner.get(c.best) === g) {
        if (plain(c.best)) options.push(base);
        options.push(this.qualified(c.best));
      }
      if (isPiece(c)) {
        const word = this.word(groups[g], c, listing(c.home), words);
        if (word !== undefined) options.push(`${this.label(c.home)} ${word}`);
      }
      c.alts.forEach((d, k) => {
        const label = this.label(d);
        if (label === base) return;
        const large = c.altFiles[k] * 3 >= c.size;
        if (large) options.push(label);
        if (this.under(d, c.best)) { if (c.altFiles[k] * MINOR >= c.size || c.bestFiles * 2 < c.size) options.push(`${base}/${label}`); }
        else if (large) options.push(this.qualified(d));
      });
      if (isPiece(c) && c.homeFiles * 2 >= hi[g] - lo[g] + 1) options.push(...ranges(g));
      take(g, options, base);
    }

    for (const group of groups) {
      for (let j = 0; j < group.length; j++) {
        groupOf[group[j]] = -1;
        if (dirOf[group[j]] >= 0) ownTotal[dirOf[group[j]]] = 0;
        for (let d = dirOf[group[j]]; d >= 0 && total[d] !== 0; d = parent[d]) total[d] = 0;
      }
    }
    return names as string[];
  }

  /** What one group can be named after. `total` and `ownTotal` hold the sibling counts. */
  private claim(group: ArrayLike<number>, files: number, common: number): Claim {
    const { full, parent, depth, dirOf, rank, total, count, own } = this;
    const c: Claim = { size: group.length, first: Number.MAX_SAFE_INTEGER, best: -1, score: 0, alts: [], altFiles: [], home: -1, homeFiles: 0, bestFiles: 0 };
    const touched: number[] = [];
    for (let j = 0; j < group.length; j++) {
      const node = group[j];
      if (rank[node] < c.first) c.first = rank[node];
      if (dirOf[node] >= 0) own[dirOf[node]]++;
      for (let d = dirOf[node]; d >= 0; d = parent[d]) if (count[d]++ === 0) touched.push(d);
    }
    const score = (d: number): number => (count[d] * count[d]) / (group.length * total[d]);
    const before = (d: number, s: number, e: number, t: number): boolean =>
      s > t || (s === t && (depth[d] < depth[e] || (depth[d] === depth[e] && full[d] < full[e])));
    for (const d of touched) {
      if (own[d] > c.homeFiles || (own[d] === c.homeFiles && own[d] > 0 && full[d] < full[c.home])) { c.home = d; c.homeFiles = own[d]; }
      if (total[d] === files && d !== common) continue;
      const s = score(d);
      if (c.best < 0 || before(d, s, c.best, c.score)) { c.best = d; c.score = s; }
    }
    // Down the path while the files stay together: a directory below that keeps nearly all of them
    // says more ("playground" under "apps", "compiler" under "packages" for a group with a few
    // files elsewhere in it). Such directories lie on one path, so the deepest is the last of them.
    const top = c.best;
    for (const d of touched) {
      if (top >= 0 && depth[d] > depth[c.best] && count[d] >= DEEPER * count[top] && this.under(d, top)) c.best = d;
    }
    if (c.best !== top) c.score = score(c.best);
    // A group with half its files directly in one directory is named after that directory rather
    // than one above it that it shares with others.
    if (c.homeFiles * 2 >= c.size && c.best !== c.home && this.under(c.home, c.best) && count[c.best] * 2 < total[c.best]) {
      c.best = c.home;
      c.score = score(c.home);
    }
    if (c.best >= 0) c.bestFiles = own[c.best];
    // The next most distinctive directories. One above the best holds the same files and more.
    const scores: number[] = [];
    for (let d = c.best; d >= 0; d = parent[d]) count[d] = -count[d];
    for (const d of touched) {
      if (count[d] < 0 || total[d] === files) continue;
      const s = score(d);
      let at = c.alts.length;
      while (at > 0 && before(d, s, c.alts[at - 1], scores[at - 1])) at--;
      if (at >= ALTERNATIVES) continue;
      c.alts.splice(at, 0, d); scores.splice(at, 0, s); c.altFiles.splice(at, 0, count[d]);
      if (c.alts.length > ALTERNATIVES) { c.alts.pop(); scores.pop(); c.altFiles.pop(); }
    }
    for (const d of touched) { count[d] = 0; own[d] = 0; }
    return c;
  }

  /** The directory a name comes from: `d`, or the first one above it whose segment says something. */
  private origin(d: number): number {
    let o = d;
    while (NOISE.has(this.text[o]) && this.parent[o] >= 0) o = this.parent[o];
    return o;
  }

  private label(d: number): string {
    return this.text[this.origin(d)];
  }

  /** The label with one more segment: "react-dom/src" for a skipped segment, else "packages/react-dom". */
  private qualified(d: number): string {
    const o = this.origin(d);
    if (o !== d) return `${this.text[o]}/${this.text[d]}`;
    return this.parent[o] < 0 ? this.text[o] : `${this.label(this.parent[o])}/${this.text[o]}`;
  }

  /** Whether directory `d` lies below directory `top`. */
  private under(d: number, top: number): boolean {
    if (top < 0) return false;
    let a = d;
    while (a >= 0 && this.depth[a] > this.depth[top]) a = this.parent[a];
    return a === top && d !== top;
  }

  private fileName(node: number): string {
    const path = this.paths[node];
    return path.slice(path.lastIndexOf('/') + 1);
  }

  /**
   * What nearly all file names of a directory start with, up to a separator ("api_def_"): it is
   * left out of ranges. Taken from the names a tenth of the way in from either end, so a stray
   * BUILD file does not hide it.
   */
  private prefix(dir: number): string {
    let p = this.prefixes.get(dir);
    if (p !== undefined) return p;
    const from = this.dirStart[dir];
    const n = this.dirStart[dir + 1] - from;
    const a = this.fileName(this.dirFiles[from + Math.floor(n * 0.1)]);
    const b = this.fileName(this.dirFiles[from + Math.min(n - 1, Math.floor(n * 0.9))]);
    let k = lcp(a, b);
    while (k > 0 && ALNUM.test(a[k - 1])) k--;
    p = n < 2 ? '' : a.slice(0, k);
    this.prefixes.set(dir, p);
    return p;
  }

  /**
   * Files lo..hi of a directory's listing as a range: to go after the directory's name ("a–f" for
   * "ops a–f"), and to stand alone where the names say enough by themselves
   * ("error.invalid-muta–reas", else ''). What the run's own names share up to a separator is written once;
   * what the whole directory shares ("api_def_") is left out. Each end is cut where it parts from
   * the other end and from the file across the boundary, and after `cap` characters at most.
   */
  private range(dir: number, list: readonly number[], lo: number, hi: number, cap: number): [string, string] {
    const shared = this.prefix(dir);
    const first = this.fileName(list[lo]);
    const last = this.fileName(list[hi]);
    let k = lcp(first, last);
    const apart = k + 1;
    while (k > 0 && ALNUM.test(first[k - 1])) k--;
    const both = shared !== '' && first.startsWith(shared) && last.startsWith(shared);
    const context = first.slice(both ? shared.length : 0, k);
    const from = (name: string): number => (shared !== '' && name.startsWith(shared) ? Math.max(k, shared.length) : k);
    let a = edge(first, from(first), Math.max(apart, lo > 0 ? lcp(first, this.fileName(list[lo - 1])) + 1 : 0), cap);
    let b = edge(last, from(last), Math.max(apart, hi + 1 < list.length ? lcp(last, this.fileName(list[hi + 1])) + 1 : 0), cap);
    if (a === b && lo !== hi) { a = edge(first, from(first), apart, first.length); b = edge(last, from(last), apart, last.length); }
    const span = a === b ? a : `${a}–${b}`;
    const stem = context === '' && both ? shared : context;
    return [`${context}${span}`, stem === '' ? '' : `${stem}${span}`];
  }

  /**
   * A word that many of the group's files in its home directory have in their names (one in WORD at
   * least) and that is mostly theirs: scored like a directory, by share of the group × share of the word.
   */
  private word(group: ArrayLike<number>, c: Claim, list: readonly number[], cache: Map<number, Map<string, number>>): string | undefined {
    let all = cache.get(c.home);
    if (!all) {
      all = new Map();
      for (const node of list) for (const w of words(this.fileName(node))) all.set(w, (all.get(w) ?? 0) + 1);
      cache.set(c.home, all);
    }
    const mine = new Map<string, number>();
    for (let j = 0; j < group.length; j++) {
      if (this.dirOf[group[j]] !== c.home) continue;
      for (const w of words(this.fileName(group[j]))) mine.set(w, (mine.get(w) ?? 0) + 1);
    }
    let best: string | undefined;
    let top = 0;
    for (const [w, n] of mine) {
      const everywhere = all.get(w)!;
      if (n < 2 || n * WORD < c.homeFiles || n * 2 <= everywhere) continue;
      const s = (n * n) / (c.homeFiles * everywhere);
      if (best === undefined || s > top || (s === top && w < best)) { best = w; top = s; }
    }
    return best;
  }
}

/**
 * One end of a range: `name` from `from` to `to`, `cap` characters at most, starting and ending on a
 * letter or digit and never in the middle of a number ("2018", not "201").
 */
function edge(name: string, from: number, to: number, cap: number): string {
  let start = from;
  while (start < name.length - 1 && !ALNUM.test(name[start])) start++;
  let end = Math.min(Math.max(to, start + 1), start + cap, name.length);
  while (end < name.length && end - start < NUMBER && DIGIT.test(name[end - 1]) && DIGIT.test(name[end])) end++;
  return name.slice(start, end).replace(TRAILING, '') || name.slice(start, end) || name;
}

/** Length of the longest common prefix. */
function lcp(a: string, b: string): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

/** The words of a file name, lower case, without its extension: 'ReactDOMFizzServerEdge.js' → react, dom, fizz, server, edge. */
function words(name: string): Set<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const out = new Set<string>();
  for (const w of stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}
