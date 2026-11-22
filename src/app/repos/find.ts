// Finding a repo among the landing page's pills by what was typed (PLAN.md §17.7). Fuzzy: letters in
// order with gaps ("rct" finds "react"), and one slip per word ("raect"). The name counts for more
// than where the repo is from. Pure.
import uFuzzy from '@leeoniya/ufuzzy';
import type { RepoPillItem } from './demos';

/** Letters in order, any gap between them. */
const loose = new uFuzzy({ intraMode: 0, intraIns: Infinity });
/** One wrong, missing, extra or swapped letter in a word. */
const slips = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });

/** Indexes of the lines of `haystack` that match, best first. */
function ranked(matcher: uFuzzy, haystack: string[], needle: string): number[] {
  try {
    const [idxs, info, order] = matcher.search(haystack, needle, 0, 1000);
    return info && order ? order.map((i) => info.idx[i]!) : (idxs ?? []);
  } catch {
    return []; // something uFuzzy cannot turn into a pattern matches nothing
  }
}

/** Where a pill says its repo is from; '' for a local folder, which has nothing to search. */
function whereOf(item: RepoPillItem): string {
  return (item.kind === 'demo' ? item.repo.location : item.repo.remoteUrl) ?? '';
}

/**
 * The pills that match `query`, best first: names that hold its letters in order, then names one
 * slip away, then repos matched only by where they are from. An empty query matches nothing: the
 * search starts with no pills, and they appear as the user types.
 */
export function findRepos(items: readonly RepoPillItem[], query: string, limit = Infinity): RepoPillItem[] {
  const needle = query.trim();
  if (needle === '' || items.length === 0) return [];
  const names = items.map((item) => item.repo.name);
  const wheres = items.map(whereOf);
  const found = new Set<number>();
  for (const pass of [ranked(loose, names, needle), ranked(slips, names, needle), ranked(loose, wheres, needle)]) {
    for (const i of pass) found.add(i);
  }
  return [...found].slice(0, limit).map((i) => items[i]!);
}
