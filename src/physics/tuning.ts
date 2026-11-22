// Every number the physics package uses, resolved once from config (PLAN.md §7, §13).
// Values that config.json does not carry yet are named here with the spike's measured defaults and
// are read from config when the key appears, so adding the key later needs no code change.
import type { Config } from '../config';

export interface Tuning {
  sliceMs: number;
  reheat: number;
  velocityDecay: number;
  alphaMin: number;
  /** Derived from settleTicks: alpha falls from 1 to alphaMin in that many ticks. */
  alphaDecay: number;
  city: { gap: number; linkStrength: number; charge: number; gravity: number };
  district: {
    pad: number; linkStrength: number; externalPull: number;
    /** Pull toward the city centre (forceX/forceY strength), which packs the districts together. */
    gravity: number;
    /** Lloyd relaxation strength: pull toward the Voronoi cell centroid (0 = off). */
    lloyd: number;
    /**
     * Weight of a district's size in its cell: 1 = the power diagram of the district discs, whose
     * edges fall between touching discs so the cells tile the city in proportion to content; 0 = the
     * plain Voronoi diagram, whose edges fall halfway between centres (cells.ts).
     */
    cellWeight: number;
    /**
     * How far a district's territory may reach beyond its disc, as a multiple of the disc radius: a
     * cell is cut off at reach · r (+ half the pad) from its centre. Enough to close the gaps between
     * touching discs; a district on the edge of its city bulges that far and no further, so a city's
     * outline is the union of its districts' territories and not a circle.
     */
    reach: number;
    /** A district centre or radius must change this much before the city's cells are recomputed. */
    cellEps: number;
  };
  file: {
    pad: number; sizeVsConnectivity: number; baseStrength: number; gap: number;
    /**
     * Share of a district's disc its units' padded discs cover: the district radius is the radius of
     * the disc that holds its content at this density, so a district is exactly as large as its
     * content packed, with no empty ring.
     */
    fill: number;
    /**
     * Share of a district's cell its units' collide discs are grown to cover. A cell is larger than
     * the district's disc (it takes in the gaps to its neighbours and a bulge on a free side), so the
     * collide discs are scaled up together until they fill it at this density. Collide then spreads
     * the units over the whole cell with gaps in proportion to their size: no dense core, no thin rim.
     */
    pack: number;
  };
  visual: Config['visual'];
  /** Share of a parent disc's area its children's discs are expected to fill (area estimate of a radius). */
  packing: number;
  /** Size-rank targets of forceRadial reach this share of the district radius. */
  radialExtent: number;
  containStrength: number;
  /** forceExternalPull scale, as a share of the city radius. */
  externalPullScale: number;
  dragAlphaTarget: number;
  resetMs: number;
  /** Worker loop rate, and the rate of position posts when buffers cannot be shared. */
  loopHz: number;
  postHz: number;
  /** Share of the settle cap kept back for the city and district tiers when the file tier runs long. */
  settleReserve: number;
  /** A radius change must exceed max(abs, rel · r) before it reheats the tier above. */
  radiusEpsAbs: number;
  radiusEpsRel: number;
  /** Two units overlap when closer than this share of their radius sum (SettleReport.overlapShare). */
  overlapTolerance: number;
  /** File sims outside the focus radius tick once every this many slices. */
  offFocusEvery: number;
  /** Ticks a simulation heated by an update takes to cool (the pre-reveal settle uses settleTicks). */
  updateTicks: number;
  /**
   * After a tier has cooled, it runs on with only its constraints (collide, containment) until nothing
   * moves faster than relaxSpeed per tick, for at most relaxTicks ticks. This is what clears the
   * overlap the link force leaves behind (spikes/physics/RESULTS.md, "What rest means here").
   */
  relaxTicks: number;
  relaxSpeed: number;
  /** Share of the remaining difference a district's or city's radius covers per slice as it eases to its goal. */
  radiusEase: number;
  /** Ticks a simulation that is only making room (constraints only) stays awake after the last push. */
  pushTicks: number;
  /** Share of the file tier's settle time given to the full forces; the rest is for the relaxation pass. */
  settleFullShare: number;
  /**
   * The settle's squeeze of the city and district tiers: this many ticks at this alpha of the pull
   * toward the middle (and, for cities, their links) against collide, with nothing pushing apart.
   */
  squeezeTicks: number;
  squeezeAlpha: number;
}

/** Read an optional numeric key, falling back to a local default (see "Requested changes" in the 1F and 2D reports). */
function opt(obj: unknown, key: string, fallback: number): number {
  const v = (obj as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function tuningFrom(config: Config): Tuning {
  const p = config.physics;
  const alphaMin = p.alphaMin;
  return {
    sliceMs: p.sliceMs,
    reheat: p.reheat,
    velocityDecay: p.velocityDecay,
    alphaMin,
    alphaDecay: 1 - Math.pow(alphaMin, 1 / Math.max(1, p.settleTicks)),
    city: { gap: p.city.gap, linkStrength: p.city.linkStrength, charge: p.city.charge, gravity: p.city.gravity },
    district: {
      pad: p.district.pad, linkStrength: p.district.linkStrength, externalPull: p.district.externalPull,
      gravity: opt(p.district, 'gravity', 0.05),
      lloyd: opt(p.district, 'lloyd', 0.1),
      cellWeight: Math.min(1, Math.max(0, opt(p.district, 'cellWeight', 1))),
      reach: Math.max(1, opt(p.district, 'reach', 1.12)),
      cellEps: opt(p.district, 'cellEps', 0.5),
    },
    file: {
      pad: p.file.pad,
      sizeVsConnectivity: p.file.sizeVsConnectivity,
      baseStrength: p.file.baseStrength,
      gap: opt(p.file, 'gap', 4 * p.file.pad),
      fill: Math.min(1, Math.max(0.05, opt(p.file, 'fill', 0.8))),
      pack: Math.min(1, Math.max(0.05, opt(p.file, 'pack', 0.8))),
    },
    visual: config.visual,
    packing: opt(p, 'packing', 0.5),
    radialExtent: opt(p.file, 'radialExtent', 0.85),
    containStrength: opt(p, 'containStrength', 0.5),
    externalPullScale: opt(p.district, 'externalPullScale', 0.05),
    dragAlphaTarget: opt(p, 'dragAlphaTarget', 0.3),
    resetMs: opt(p, 'resetMs', 600),
    loopHz: opt(p, 'loopHz', 60),
    postHz: opt(p, 'postHz', 30),
    settleReserve: opt(p, 'settleReserve', 0.15),
    radiusEpsAbs: opt(p, 'radiusEpsAbs', 0.25),
    radiusEpsRel: opt(p, 'radiusEpsRel', 0.02),
    overlapTolerance: opt(p, 'overlapTolerance', 0.95),
    offFocusEvery: opt(p, 'offFocusEvery', 2),
    updateTicks: opt(p, 'updateTicks', 45),
    relaxTicks: opt(p, 'relaxTicks', 120),
    relaxSpeed: opt(p, 'relaxSpeed', 0.02),
    radiusEase: Math.min(1, Math.max(0.01, opt(p, 'radiusEase', 0.2))),
    pushTicks: opt(p, 'pushTicks', 10),
    settleFullShare: Math.min(1, Math.max(0.1, opt(p, 'settleFullShare', 0.75))),
    squeezeTicks: opt(p, 'squeezeTicks', 80),
    squeezeAlpha: Math.min(1, Math.max(0, opt(p, 'squeezeAlpha', 0.5))),
  };
}
