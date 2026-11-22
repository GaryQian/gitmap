// Adaptive-quality and large-map tunables that have no key in config.json yet (see "Requested config
// keys" in the 6A report). What config already holds is read from there: render.edgeBudget,
// render.adaptiveDpr, render.maxDpr, and scheduler.parkWhenFrameMsOver (the app's "slow frame" line).
export const QUALITY_LOCAL = {
  /**
   * SWITCHED OFF (6A stopped before this was run in a browser or unit-tested): set to true to let the
   * controller step quality. While false, quality stays at step 0 and nothing is measured.
   */
  adaptive: false as boolean,
  /**
   * A frame is slow when it took longer than this many display frame intervals (a missed refresh),
   * and longer than config.scheduler.parkWhenFrameMsOver: a 120 Hz display is not held to 120 fps.
   */
  slowRatio: 1.4,
  /** Frames are judged in windows of this much measured time, and at least this many frames. */
  windowMs: 1000,
  windowFrames: 8,
  /** Step down when at least this share of a window's frames were slow. */
  downShare: 0.5,
  /** A window counts toward stepping back up when at most this share of its frames were slow. */
  upShare: 0.05,
  /** After a step, frames are ignored for this long (the step itself costs a frame or two). */
  settleMs: 400,
  /** Step back up after this much good time. Doubles (up to the maximum) each time a step up had to be undone. */
  upAfterMs: 6000,
  upAfterMaxMs: 60000,
  /** A step down this soon after a step up means the step up was a mistake. */
  probationMs: 5000,
  /** Measured frames further apart than this do not belong to the same window. */
  staleMs: 3000,
  /** Edge steps: each multiplies the edge budget and caps by `edgeStepScale`. Pixel-ratio steps come after them. */
  edgeSteps: 4,
  edgeStepScale: 0.5,
  /** Pixel-ratio steps, as shares of the display's own ratio; never below 1, and the last step is always 1. */
  pixelRatioShares: [0.75, 0.625, 0.5],
  large: {
    /**
     * A map with at least this many files is "large" (L): it starts below full quality and may collapse districts.
     * SWITCHED OFF (6A stopped before the large-map path was run in a browser): the intended value is 30000.
     */
    units: Number.POSITIVE_INFINITY,
    /** Where a large map starts: edge steps and pixel-ratio steps already taken. It steps up when frames allow. */
    startEdgeStep: 1,
    startPixelRatioStep: 1,
  },
  aggregate: {
    /**
     * A district is one aggregate while a typical star in it would be smaller than the first value
     * (radius in device pixels); every star is drawn once it would be larger than the second. In
     * between, stars give way one by one.
     */
    starPx: [0.45, 1.15],
    /** How much glow (importance) holds a star back from collapsing, 0..1: 1 keeps the brightest stars for good. */
    keepGlow: 0.9,
    /** The aggregate's radius as a share of the district's territory radius, and its height over the ground. */
    radius: 1.0,
    lift: 0.4,
    /** Opacity of the dimmest and of the brightest aggregate (brightness follows summed importance). */
    alpha: [0.3, 0.8],
    lightAlpha: [0.35, 0.75],
    /** How sharply the aggregate falls off toward its edge (higher: tighter core). */
    falloff: 1.6,
    /** Fine grain inside the aggregate, so it reads as a crowd of stars: cells across its diameter per √file, and strength. */
    grainPerRootUnit: 1.6,
    grain: 0.55,
  },
} as const;
