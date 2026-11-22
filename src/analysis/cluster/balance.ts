// A natural bias against mega-districts and megacities (PLAN.md §6.6 "Balance"). No size is ever
// capped: a community that really is one tightly bound block of a thousand files stays one. What
// changes is how the algorithm counts and how it merges, so giants stop forming by accident.
//
// Louvain optimises modularity and is content to return one community of several thousand files
// beside a hundred small ones. Counting those as "enough communities", then merging each small one
// into its most-connected neighbour (which is usually the giant), is how four huge clusters and a
// few crumbs come about. Three things replace the plain count and the plain merge rule:
//
//   a second look      a community larger than an even share of the wanted count is examined on its
//                      own subgraph and divided where it has real structure, and only there (refine.ts).
//
//   effective count    (Σsize)² / Σsize², the inverse Simpson index: twelve equal communities count
//                      as 12; one holding 80% of the files plus eleven small ones counts as about 1.5.
//                      Merging stops when this is down to the wanted number, which leaves small
//                      communities standing beside a large one instead of feeding them to it.
//
//   size-relative      a community joins the neighbour it is most connected to *for that neighbour's
//   merging            size*: connecting weight / √(partner size). A giant needs more connections
//                      than a small neighbour to be chosen, but a strong tie still wins.
//
// The effective count would let the plain number of cities or districts run far above the curve
// (react: 20 cities where the curve says 11), so it is bounded: at most clustering.countSlack (1.5)
// times the wanted number remain, and never more than maxCities.
//
// clustering.sizeBias (0..1) scales all three: 1 = as described, 0 = plain count and most-connected
// merging. Directories with no code in them are given a structure that can divide in graph.ts.

/** Σsize / largest size over communities of at least `minSize`: the count if all were as big as the largest. */
export function evenShareCount(sizes: ArrayLike<number>, minSize = 0): number {
  let sum = 0, max = 0;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    if (!(s > 0) || s < minSize) continue;
    sum += s;
    if (s > max) max = s;
  }
  return max > 0 ? sum / max : 0;
}

/**
 * Effective number of communities: (Σsize)² / Σsize² (the inverse Simpson index). Equal sizes give
 * their count; a dominant community pulls it toward 1. 0 for no communities.
 */
export function effectiveCount(sizes: ArrayLike<number>, minSize = 0): number {
  let sum = 0, sumSq = 0;
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    if (!(s > 0) || s < minSize) continue;
    sum += s;
    sumSq += s * s;
  }
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

/**
 * Merge score of joining a neighbour of `partnerSize` files over a connection of weight `w`:
 * w at bias 0, w / √size at bias 1, blended in between. The square root is deliberate: dividing by
 * the size itself made a community prefer a small, barely connected neighbour over the large one it
 * really belongs to, and files ended up in cities they had little to do with. IEEE sqrt and division
 * are exact, so every engine computes the same bits (Math.pow may not). `sharp` divides by the
 * size itself; it is used for districts only (see districtBias).
 */
export function mergeScore(w: number, partnerSize: number, bias: number, sharp = false): number {
  if (!(bias > 0) || !(partnerSize > 1)) return w;
  const divisor = 1 + bias * (partnerSize - 1);
  return sharp ? w / divisor : w / Math.sqrt(divisor);
}

/**
 * The two strengths (PLAN.md §6.6 "Balance"). Cities get the gentle one, clustering.sizeBias: at
 * that level a file in the wrong city is what the eye catches, so belonging comes first. Districts
 * get clustering.districtSizeBias (default 1) and the sharp merge score (weight / size): inside a
 * city everything is related anyway, and what the eye catches there is one district the size of
 * the city.
 */
export function districtBias(cfg: { sizeBias: number; districtSizeBias?: number }): number {
  if (!(cfg.sizeBias > 0)) return 0;
  const b = typeof cfg.districtSizeBias === 'number' ? cfg.districtSizeBias : 1;
  return Math.min(1, Math.max(0, b));
}

/**
 * The most communities a merge may leave standing when the wanted number is `target`. The effective
 * count lets the plain count run above the curve; `clustering.countSlack` (default 1.5) says how far.
 */
export function countLimit(target: number, slack: number | undefined): number {
  const s = typeof slack === 'number' && slack >= 1 ? slack : 1.5;
  return Math.max(target, Math.ceil(target * s));
}
