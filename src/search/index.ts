// Search over file paths (PLAN.md §9). The engine is pure and worker-safe; the coordinator keeps one
// index behind Session.search, and the search pill uses matchRanges to highlight what it is given.
import type { SearchHit } from '../contracts/pipeline';
import type { NodeRef } from '../model/types';
import type { SearchResult } from './searchIndex';

export { createSearchIndex, matchPath, matchRanges } from './searchIndex';
export type { SearchIndex, SearchResult } from './searchIndex';
export { SEARCH_LOCAL } from './tunables';

/**
 * Results as the contract's SearchHit. `refOf` gives the node a path belongs to: a header and its
 * implementation share one unit, so the path alone does not say. Paths it has no node for are dropped.
 */
export function toSearchHits(results: readonly SearchResult[], refOf: (path: string) => NodeRef | null | undefined): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const r of results) {
    const ref = refOf(r.path);
    if (ref) hits.push({ ref, path: r.path, score: r.score });
  }
  return hits;
}
