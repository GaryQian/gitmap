// Particle tunables that have no key in config.json yet (see "Requested changes" in the 2E report).
// Pool sizes come from config.visual.particles (ambient, voidDustShare, selectBurst, openBurst).
export const PARTICLE_LOCAL = {
  wind: {
    /** A file sheds wind in proportion to importance ^ power; files below `fromPct` shed none. */
    fromPct: 0.5,
    power: 6,
    /** Hosts are chosen again this long after the model, the size slider or the type filter last changed. */
    rehostQuietMs: 400,
  },
  /** Seconds for the ambient pool to fade in after the reveal, and its delay as a share of the reveal. */
  fadeIn: 1.5,
  revealDelay: 0.7,
  /** Bursts alive at once; an older one is replaced when all are in use. */
  maxBursts: 8,
  /** Seconds a select burst and an open burst last (particles, ring, flash, column). */
  selectSeconds: 1.2,
  openSeconds: 1.9,
  /** Ground shockwave: reach in sphere radii plus a fixed distance, world units. */
  ringRadii: 9,
  ringWorld: 18,
  /** Column of light on 'open': height and width in sphere radii. */
  columnHeight: 26,
  columnWidth: 1.5,
  /** The flash as each sphere ignites at the reveal: seconds, and size in sphere radii. */
  igniteSeconds: 0.5,
  igniteRadii: 3.4,
} as const;
