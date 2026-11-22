// The typo-tolerant pass, on uFuzzy: one substitution, transposition, insertion or deletion per term.
// It only runs when the exact pass comes back (nearly) empty, and its results rank below every exact
// match, so fuzzy noise never displaces a real substring hit.
import uFuzzy from '@leeoniya/ufuzzy';
import type { Query } from './match';
import { SEARCH_LOCAL } from './tunables';

const F = SEARCH_LOCAL.fuzzy;
const T = SEARCH_LOCAL.tier;

let instance: uFuzzy | null = null;
const matcher = (): uFuzzy => (instance ??= new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 }));

/** The query as uFuzzy takes it: words of ASCII letters and digits, which is what it matches on. Null when no word is long enough to tolerate a typo. */
function fuzzyNeedle(query: Query): string | null {
  const words = query.terms.flatMap((t) => t.text.split(/[^A-Za-z\d]+/)).filter(Boolean);
  if (!words.some((w) => w.length >= F.minTermLength)) return null;
  return words.join(' ');
}

export interface FuzzyMatch { index: number; score: number; ranges: number[] }

/** uFuzzy over one haystack, best first; too many matches to rank are cut to the first ones. */
function ranked(haystack: string[], needle: string): FuzzyMatch[] {
  const uf = matcher();
  let [idxs, info, order] = uf.search(haystack, needle, F.outOfOrderTerms, F.rankAtMost);
  if (idxs && !info && idxs.length > 0) {
    // The caller's haystack is ordered shortest path first, so the first ones are the ones to keep.
    const first = idxs.slice().sort((a, b) => a - b).slice(0, F.rankAtMost);
    [idxs, info, order] = uf.search(haystack, needle, F.outOfOrderTerms, F.rankAtMost, first);
  }
  if (!idxs || !info || !order) return [];
  return order.map((o) => ({ index: info.idx[o]!, score: 0, ranges: info.ranges[o]!.slice() }));
}

/**
 * Typo-tolerant matches of a query, best first, with ranges in path coordinates. `names[i]` is the
 * file name of `paths[i]`. One word is looked for in the file names only, which is where a typo is
 * worth forgiving and a third of the text; several words, in any order, in the whole path, with
 * matches that lie inside the file name first.
 */
export function fuzzySearch(paths: string[], names: string[], query: Query, limit: number): FuzzyMatch[] {
  const needle = fuzzyNeedle(query);
  if (!needle) return [];
  if (!needle.includes(' ')) {
    const found = ranked(names, needle).slice(0, limit);
    for (const m of found) {
      const shift = paths[m.index]!.length - names[m.index]!.length;
      m.score = T.fuzzyName;
      m.ranges = m.ranges.map((r) => r + shift);
    }
    return found;
  }
  const inName: FuzzyMatch[] = [];
  const beyond: FuzzyMatch[] = [];
  for (const m of ranked(paths, needle)) {
    const named = m.ranges.length > 0 && m.ranges[0]! >= paths[m.index]!.length - names[m.index]!.length;
    m.score = named ? T.fuzzyName : T.fuzzyPath;
    (named ? inName : beyond).push(m);
  }
  return inName.concat(beyond).slice(0, limit);
}
