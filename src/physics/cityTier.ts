// City tier (PLAN.md §7.1): one simulation of every city in world XZ.
//   forceLink on inter-city edge weight · spatial-hash collide (radius + gap) · weak many-body ·
//   weak forceX/forceY gravity. No forceCenter: it would slide the world when one city is dragged.
// While the tier is only making room for a city that grew (constraintsOnly), collide alone acts, so a
// city nothing overlaps does not move at all. The settle ends with a squeeze (links and gravity against
// collide, no repulsion) so cities do not sit further apart than the gap asks, and then moves any pair
// closer than the gap apart directly, so the gap is a hard minimum (settle.ts).
import { forceLink, forceManyBody, forceX, forceY } from 'd3-force';
import { forceGridCollide, gated } from './forces';
import { makeSim, sleep, type PLink, type PNode, type SimParts } from './sim';
import type { Tuning } from './tuning';

export type CityTier = SimParts;

/** Centre distance two cities keep: half the gap on each side leaves `gap` between touching territories. */
export function citySpacing(a: PNode, b: PNode, t: Tuning): number {
  return a.r + b.r + t.city.gap;
}

export function createCityTier(t: Tuning): CityTier {
  const tier = { nodes: [], links: [], maxW: 1, constraintsOnly: false, squeeze: false, held: new Set(), budget: 0 } as unknown as CityTier;
  const free = () => !tier.constraintsOnly;
  const pulling = () => !tier.constraintsOnly || tier.squeeze;
  // Rubber-band links: rest length grows as the weight falls; d3's degree normalisation is kept and scaled.
  tier.link = forceLink<PNode, PLink>([])
    .distance((l) => l.source.r + l.target.r + t.city.gap * (1 + 2 * (1 - l.w / tier.maxW)))
    .strength((l) => t.city.linkStrength / Math.max(1, Math.min(l.source.deg, l.target.deg)));
  tier.collide = forceGridCollide((n) => n.r + t.city.gap / 2);
  tier.sim = makeSim(t)
    .force('link', gated(tier.link, pulling))
    .force('collide', tier.collide)
    .force('charge', gated(forceManyBody<PNode>().strength(t.city.charge), free))
    .force('x', gated(forceX<PNode>(0).strength(t.city.gravity), pulling))
    .force('y', gated(forceY<PNode>(0).strength(t.city.gravity), pulling));
  sleep(tier.sim); // nothing to simulate until the first city arrives
  return tier;
}
