// The path index. Pure and worker-safe: strings and typed arrays, no DOM.
//
// How it stays fast at 100k paths: every path is laid end to end in one string (and every file name
// in another), so finding the candidates for a term is a native `indexOf` walk over a few megabytes
// instead of a test per path. The paths are kept ordered shortest first, then fewest segments, then
// by path: the order in which equal matches rank. So an index position is its own tie-break, and a
// scan that has to stop early has already seen the paths that would have won.
import { fuzzySearch } from './fuzzy';
import { foldCase, matchText, occurrenceTier, parseQuery, rangesAt, type Query, type Term } from './match';
import { SEARCH_LOCAL } from './tunables';

const T = SEARCH_LOCAL.tier;

export interface SearchResult {
  path: string;
  /** Higher is better; see SEARCH_LOCAL.tier. Comparable only within one query. */
  score: number;
  /** Matched stretches of `path` for highlighting: start, end pairs, end exclusive, ascending. */
  ranges: number[];
}

export interface SearchIndex {
  /** Replace everything. */
  setPaths(paths: Iterable<string>): void;
  add(paths: Iterable<string>): void;
  remove(paths: Iterable<string>): void;
  /** Best matches first. An empty query gives no results. */
  search(query: string, limit?: number): SearchResult[];
  /**
   * Rebuild the lookup text now if paths changed, instead of during the next search (tens of
   * milliseconds at 100k paths).
   */
  warm(): void;
  readonly size: number;
}

interface Built {
  n: number;
  /** In ranking order for equal matches: shortest, then fewest segments, then by path. */
  paths: string[];
  /** The file name of each path. */
  nameList: string[];
  /** '/' + path + '\n' for every path, original case. */
  all: string;
  /** The same text with case folded; same length. */
  lower: string;
  /** n + 1 entries: where each path's text begins in `all` (at its added '/'). */
  start: Uint32Array;
  /** Where each path's file name begins in `all`. */
  base: Uint32Array;
  /** '\n' + file name for every path, then a last '\n'. */
  names: string;
  namesLower: string;
  /** n + 1 entries: where each file name begins in `names`. */
  nameStart: Uint32Array;
  /** Scratch, zero between searches: the best tier seen for each path. */
  tier: Uint8Array;
}

function build(source: Iterable<string>): Built {
  // Bucket by length and segment count, then order each bucket by path: far fewer string
  // comparisons than sorting everything by a three-part rule.
  const buckets = new Map<number, string[]>();
  for (const p of source) {
    // A newline is the separator in the joined text. Git allows one in a file name; such a file is not searchable.
    if (p === '' || p.includes('\n')) continue;
    let segments = 0;
    for (let c = p.indexOf('/'); c >= 0; c = p.indexOf('/', c + 1)) segments++;
    const key = p.length * 4096 + segments;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p); else buckets.set(key, [p]);
  }
  const paths: string[] = [];
  for (const key of [...buckets.keys()].sort((x, y) => x - y)) {
    for (const p of buckets.get(key)!.sort()) paths.push(p);
  }
  const n = paths.length;

  const start = new Uint32Array(n + 1);
  const base = new Uint32Array(n);
  const nameStart = new Uint32Array(n + 1);
  const nameList = new Array<string>(n);
  let at = 0;
  let nameAt = 1;
  for (let i = 0; i < n; i++) {
    const p = paths[i]!;
    const slash = p.lastIndexOf('/');
    start[i] = at;
    base[i] = at + slash + 2;
    nameStart[i] = nameAt;
    nameList[i] = slash < 0 ? p : p.slice(slash + 1);
    at += p.length + 2;
    nameAt += p.length - slash;
  }
  start[n] = at;
  nameStart[n] = nameAt;
  const all = n === 0 ? '' : `/${paths.join('\n/')}\n`;
  const names = `\n${nameList.join('\n')}\n`;
  return { n, paths, nameList, all, lower: foldCase(all), start, base, names, namesLower: foldCase(names), nameStart, tier: new Uint8Array(n) };
}

/** The entry holding `pos`: the largest i ≥ from with starts[i] ≤ pos. Positions arrive ascending, so `from` is the previous answer. */
function locate(starts: Uint32Array, pos: number, from: number, n: number): number {
  if (pos < starts[from + 1]!) return from;
  let lo = from + 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Occurrences of a slash-free term in the file names. `lead` is 1 when the needle starts with the '\n' that precedes every name. */
function scanNames(b: Built, hay: string, needle: string, lead: number, len: number, budget: number, found: number[]): void {
  const { nameStart, base, start, all, tier, n } = b;
  let i = 0;
  let examined = 0;
  for (let o = hay.indexOf(needle); o >= 0; o = hay.indexOf(needle, o + 1)) {
    const p = o + lead;
    i = locate(nameStart, p, i, n);
    const t = occurrenceTier(all, start[i]!, base[i]!, start[i + 1]! - 1, base[i]! + p - nameStart[i]!, len, false);
    if (t > tier[i]!) {
      if (tier[i] === 0) found.push(i);
      tier[i] = t;
    }
    if (++examined >= budget) break;
  }
}

/**
 * Occurrences of a slash-free term in the directories, for paths whose file name did not match.
 * Stops once `need` whole-directory matches are in: nothing later can outrank those.
 */
function scanDirs(b: Built, hay: string, needle: string, lead: number, len: number, budget: number, need: number, found: number[]): void {
  const { base, start, all, tier, n } = b;
  let i = 0;
  let examined = 0;
  let whole = 0;
  let o = hay.indexOf(needle);
  while (o >= 0) {
    const p = o + lead;
    i = locate(start, p, i, n);
    const end = start[i + 1]! - 1;
    if (p >= base[i]! || tier[i]! >= T.inside) { o = hay.indexOf(needle, end); continue; } // the name matched: already in
    const t = occurrenceTier(all, start[i]!, base[i]!, end, p, len, false);
    if (t > tier[i]!) {
      if (tier[i] === 0) found.push(i);
      tier[i] = t;
    }
    if (++examined >= budget) break;
    if (t === T.dirWhole) {
      if (++whole >= need) break;
      o = hay.indexOf(needle, end);
    } else o = hay.indexOf(needle, o + 1);
  }
}

/** Occurrences of a term with a slash, anywhere in the paths. */
function scanPaths(b: Built, hay: string, needle: string, budget: number, found: number[]): void {
  const { base, start, all, tier, n } = b;
  let i = 0;
  let examined = 0;
  for (let o = hay.indexOf(needle); o >= 0; o = hay.indexOf(needle, o + 1)) {
    i = locate(start, o, i, n);
    const t = occurrenceTier(all, start[i]!, base[i]!, start[i + 1]! - 1, o, needle.length, true);
    if (t > tier[i]!) {
      if (tier[i] === 0) found.push(i);
      tier[i] = t;
    }
    if (++examined >= budget) break;
  }
}

/** One term: the candidates come straight from the scans, with their tier. */
function collectOne(b: Built, term: Term, fold: boolean, limit: number, idx: number[], score: number[]): void {
  const { text } = term;
  const len = text.length;
  const budget = SEARCH_LOCAL.scanBudget;
  const paths = fold ? b.lower : b.all;
  if (term.slash) scanPaths(b, paths, text, budget, idx);
  else {
    const names = fold ? b.namesLower : b.names;
    if (len > SEARCH_LOCAL.shortTerm) {
      scanNames(b, names, text, 0, len, Infinity, idx);
      if (idx.length < limit) scanDirs(b, paths, text, 0, len, budget, limit - idx.length, idx);
    } else {
      // One or two characters occur nearly everywhere. Names that start with them come first and are
      // cheap to find; the rest is looked at only when those do not fill the list, and within a budget.
      scanNames(b, names, `\n${text}`, 1, len, Infinity, idx);
      if (idx.length < limit) scanNames(b, names, text, 0, len, budget, idx);
      if (idx.length < limit) scanDirs(b, paths, `/${text}/`, 1, len, budget, limit - idx.length, idx);
    }
  }
  for (const i of idx) {
    score.push(b.tier[i]!);
    b.tier[i] = 0;
  }
}

/** Several terms, in any order: paths holding the longest one are the candidates, and each is scored in full. */
function collectMany(b: Built, query: Query, idx: number[], score: number[]): void {
  const { start, base, all, lower, n } = b;
  const hay = query.fold ? lower : all;
  let driver = query.terms[0]!.text;
  for (const t of query.terms) if (t.text.length >= driver.length) driver = t.text;
  let i = 0;
  let examined = 0;
  for (let o = hay.indexOf(driver); o >= 0; o = hay.indexOf(driver, start[i + 1]!)) {
    i = locate(start, o, i, n);
    const s = start[i]!;
    const e = start[i + 1]! - 1;
    const orig = all.substring(s, e);
    const value = matchText(query.fold ? lower.substring(s, e) : orig, orig, base[i]! - s, query);
    if (value > 0) {
      idx.push(i);
      score.push(value);
    }
    if (++examined >= SEARCH_LOCAL.candidateBudget) break;
  }
}

/** The `limit` best candidates, best first: by score, then by index (which is the tie-break order). */
function selectTop(idx: number[], score: number[], limit: number): number[] {
  const topI: number[] = [];
  const topS: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    const s = score[k]!;
    let at = topI.length;
    if (at === limit) {
      const ws = topS[at - 1]!;
      if (s < ws || (s === ws && i > topI[at - 1]!)) continue;
      at--;
    }
    while (at > 0 && (topS[at - 1]! < s || (topS[at - 1] === s && topI[at - 1]! > i))) {
      topS[at] = topS[at - 1]!;
      topI[at] = topI[at - 1]!;
      at--;
    }
    topS[at] = s;
    topI[at] = i;
  }
  return topI;
}

function searchBuilt(b: Built, query: Query, limit: number): SearchResult[] {
  const idx: number[] = [];
  const score: number[] = [];
  if (query.terms.length === 1) collectOne(b, query.terms[0]!, query.fold, limit, idx, score);
  else collectMany(b, query, idx, score);
  const top = selectTop(idx, score, limit);

  // Score the few that are left once more, in full: this finds the ranges, and settles the score of a
  // path a capped scan left half-examined.
  const results: SearchResult[] = [];
  const at: number[] = [];
  for (const i of top) {
    const s = b.start[i]!;
    const e = b.start[i + 1]! - 1;
    const orig = b.all.substring(s, e);
    const value = matchText(query.fold ? b.lower.substring(s, e) : orig, orig, b.base[i]! - s, query, at);
    if (value > 0) results.push({ path: b.paths[i]!, score: value, ranges: rangesAt(query, at) });
  }
  results.sort((x, y) => y.score - x.score); // stable: equal scores stay in index order

  if (results.length < SEARCH_LOCAL.fuzzy.whenFewerThan && results.length < limit) {
    const have = new Set(results.map((r) => r.path));
    for (const m of fuzzySearch(b.paths, b.nameList, query, limit)) {
      const path = b.paths[m.index]!;
      if (have.has(path)) continue;
      results.push({ path, score: m.score, ranges: m.ranges });
      if (results.length === limit) break;
    }
  }
  return results;
}

export function createSearchIndex(paths?: Iterable<string>): SearchIndex {
  let set = new Set<string>(paths);
  let built: Built | null = null;
  return {
    setPaths(next) {
      set = new Set(next);
      built = null;
    },
    add(more) {
      for (const p of more) {
        if (set.has(p)) continue;
        set.add(p);
        built = null;
      }
    },
    remove(gone) {
      for (const p of gone) if (set.delete(p)) built = null;
    },
    search(query, limit = SEARCH_LOCAL.defaultLimit) {
      const parsed = parseQuery(query);
      if (!parsed || !(limit >= 1)) return [];
      built ??= build(set);
      return searchBuilt(built, parsed, Math.floor(limit));
    },
    warm() {
      built ??= build(set);
    },
    get size() {
      return set.size;
    },
  };
}

/** Match one path on its own, as the index would: for highlighting a path that came from elsewhere. */
export function matchPath(path: string, query: string): SearchResult | null {
  const parsed = parseQuery(query);
  if (!parsed) return null;
  const orig = `/${path}`;
  const at: number[] = [];
  const score = matchText(parsed.fold ? foldCase(orig) : orig, orig, orig.lastIndexOf('/') + 1, parsed, at);
  if (score > 0) return { path, score, ranges: rangesAt(parsed, at) };
  const fuzzy = fuzzySearch([path], [orig.slice(orig.lastIndexOf('/') + 1)], parsed, 1)[0];
  return fuzzy ? { path, score: fuzzy.score, ranges: fuzzy.ranges } : null;
}

/** The stretches of `path` a query matches (start, end pairs, end exclusive); empty when it does not match. */
export function matchRanges(path: string, query: string): number[] {
  return matchPath(path, query)?.ranges ?? [];
}
