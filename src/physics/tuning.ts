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
  district: { pad: number; linkStrength: number; externalPull: number };
  file: { pad: number; sizeVsConnectivity: number; baseStrength: number; gap: number };
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
}

/** Read an optional numeric key, falling back to a local default (see "Requested changes" in the 1F report). */
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
    district: { pad: p.district.pad, linkStrength: p.district.linkStrength, externalPull: p.district.externalPull },
    file: {
      pad: p.file.pad,
      sizeVsConnectivity: p.file.sizeVsConnectivity,
      baseStrength: p.file.baseStrength,
      gap: opt(p.file, 'gap', 4 * p.file.pad),
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
  };
}
