// A natural bias against mega-districts and megacities (PLAN.md §6.6 "Balance"). No size is ever
// capped: a community that really is one tightly bound block of a thousand files stays one. What
// changes is how the algorithm counts and how it merges, so giants stop forming by accident.
//
// Louvain optimises modularity and is content to return one community of several thousand files
// beside a hundred small ones. Counting those as "enough communities", then merging each small one
// into its most-connected neighbour (which is usually the giant), is how four huge clusters and a
// few crumbs come about. Three measures replace the plain count and the plain merge rule:
//
//   even-share count   Σsize / largest size: how many communities there would be if all were as big
//                      as the largest. The Louvain resolution is raised until this reaches the wanted
//                      number, i.e. until the largest community is no bigger than an even share
//                      (index.ts). A giant that will not divide at any resolution tried is accepted.
//
//   effective count    (Σsize)² / Σsize², the inverse Simpson index: twelve equal communities count
//                      as 12; one holding 80% of the files plus eleven small ones counts as about 1.5.
//                      Merging stops when this is down to the wanted number, which leaves small
//                      communities standing beside a large one instead of feeding them to it.
//
//   size-relative      a community joins the neighbour it is most connected to *for that neighbour's
//   merging            size*: connecting weight / partner size. A giant needs proportionally more
//                      connections than a small neighbour to be chosen.
//
// clustering.sizeBias (0..1) scales all three: 1 = as described, 0 = plain count and most-connected
// merging. Directories with no code in them are made divisible in graph.ts.

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
 * How many communities a Louvain level counts as when deciding whether its resolution is high
 * enough: the plain number of communities of at least `minSize` files, blended toward the
 * even-share count by `bias` (0..1). Never more than the plain number.
 */
export function levelCount(sizes: ArrayLike<number>, minSize: number, bias: number): number {
  let plain = 0;
  for (let i = 0; i < sizes.length; i++) if (sizes[i] >= minSize && sizes[i] > 0) plain++;
  const b = Math.min(1, Math.max(0, bias));
  return b === 0 ? plain : (1 - b) * plain + b * Math.min(plain, evenShareCount(sizes, minSize));
}

/** Merge score of joining a neighbour of `partnerSize` files over a connection of weight `w`. */
export function mergeScore(w: number, partnerSize: number, bias: number): number {
  return bias > 0 && partnerSize > 1 ? w / Math.pow(partnerSize, bias) : w;
}
