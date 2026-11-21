// City tier (PLAN.md §7.1): one simulation of every city in world XZ.
//   forceLink on inter-city edge weight · spatial-hash collide (radius + gap) · weak many-body ·
//   weak forceX/forceY gravity. No forceCenter: it would slide the world when one city is dragged.
import { forceLink, forceManyBody, forceX, forceY } from 'd3-force';
import { forceGridCollide } from './forces';
import { makeSim, sleep, type PLink, type PNode, type SimParts } from './sim';
import type { Tuning } from './tuning';

export type CityTier = SimParts;

export function createCityTier(t: Tuning): CityTier {
  const tier = { nodes: [], links: [], maxW: 1 } as unknown as CityTier;
  // Rubber-band links: rest length grows as the weight falls; d3's degree normalisation is kept and scaled.
  tier.link = forceLink<PNode, PLink>([])
    .distance((l) => l.source.r + l.target.r + t.city.gap * (1 + 2 * (1 - l.w / tier.maxW)))
    .strength((l) => t.city.linkStrength / Math.max(1, Math.min(l.source.deg, l.target.deg)));
  // Half the gap on each side leaves `gap` between two touching territories.
  tier.collide = forceGridCollide((n) => n.r + t.city.gap / 2);
  tier.sim = makeSim(t)
    .force('link', tier.link)
    .force('collide', tier.collide)
    .force('charge', forceManyBody<PNode>().strength(t.city.charge))
    .force('x', forceX<PNode>(0).strength(t.city.gravity))
    .force('y', forceY<PNode>(0).strength(t.city.gravity));
  sleep(tier.sim); // nothing to simulate until the first city arrives
  return tier;
}
