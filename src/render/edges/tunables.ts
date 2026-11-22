// Edge tunables that have no key in config.json yet (see "Requested changes" in the 2E report).
// Pulse speed, tail, rest, flicker and trace opacity come from config.visual.edgePulse; the caps come
// from config.render.ambientEdges and config.render.edgeBudget.
export const EDGE_LOCAL = {
  lod: {
    /** City ribbons take over when the camera is farther than this many typical city radii. */
    cityFar: 5,
    /** File edges take over when the camera is nearer than this many typical district radii. */
    districtNear: 5,
    /** The near threshold never exceeds this share of the far one, so the middle level always has room. */
    nearMaxShare: 0.5,
    /** Half-width of each cross-fade, as a factor of distance (1.3 = from threshold / 1.3 to threshold × 1.3). */
    band: 1.3,
    /** Radius of the ground circle counted as "in view", in camera distances. */
    viewRadius: 0.9,
    /** Reselect the in-view sets when the camera target moved by this share of its distance, or zoomed by this factor. */
    reselectMove: 0.12,
    reselectZoom: 1.12,
  },
  /** The ambient file edges never exceed this many per file in the districts in view: a small set, not a canopy. */
  ambientPerUnit: 0.4,
  /** Most district↔district ribbons drawn at once, strongest first. */
  districtRibbons: 400,
  /**
   * Adaptive quality (ctx.quality.edgeScale; src/render/quality) scales every ambient level. City
   * ribbons shrink to that share of what there is, but never below this many: the far view keeps its shape.
   */
  cityRibbonsMin: 8,
  /** Aggregates are rebuilt once batches have been quiet for this long, or at the latest after `rebuildMaxMs`. */
  rebuildQuietMs: 180,
  rebuildMaxMs: 1200,
  /**
   * A model with more edge slots than this is rebuilt in slices of config.render.patchBudgetMs per
   * animation frame (the previous aggregates keep drawing until it is whole); a smaller one at once.
   * SWITCHED OFF (6A stopped before this was run in a browser): the intended value is 50000.
   */
  stagedBuildEdges: Number.POSITIVE_INFINITY,
  /** Rows of a staged build between two points where it may pause. */
  buildChunk: 4096,
  /** While a simulation is hot, the in-view sets are reselected at most this often. */
  hotReselectMs: 400,
  /** An edge whose endpoint is dimmed by the type filter keeps this share of its strength. */
  dimmed: 0.15,
  /** Brightness at confidence 0 (1 at confidence 1). */
  lowConfidence: 0.35,
  /** Seconds over which a newly chosen edge fades in, and a level cross-fades after a model change. */
  fadeIn: 0.45,
  /** Ambient levels drop to this while something is selected (0: hidden) or hovered, so its edges read. */
  focusDim: { selected: 0, hovered: 0.65 },
  /** Ambient edges and ribbons rest this many times longer between pulses than focus edges, so they stay calm. */
  ambientRestScale: 3.5,
  /** A sphere with more connections than `max` takes them in turn: one pulse leaves every `seconds` / `max`
   *  seconds (longer on ambient levels), so about `max` are in flight around it at once. */
  hubPulses: { max: 6, seconds: 1.4 },
  /** Seconds of flash on the target as a focus pulse arrives, and its size in target radii. */
  flashSeconds: 0.32,
  flashRadii: 2.4,
  /** The synchronised pulse of an 'open' burst: speed relative to ordinary pulses, and how long the edges stay up (ms). */
  novaSpeed: 1.8,
  novaHoldMs: 2600,
  /** Arc segments per strip. Edges are fill bound, not vertex bound (spikes/render/RESULTS.md). */
  segments: 16,
  ribbonSegments: 24,
  /** Arc lift = slope × ground length + base, world units. */
  lift: { file: [0.22, 2.0], district: [0.14, 3.0], city: [0.09, 6.0] },
  /** World width = base + gain × strength, then clamped to [min, max] device pixels; the strip is three times that. */
  width: {
    file: { world: [0.15, 0.5], px: [0.9, 3.0] },
    focus: { world: [0.2, 0.6], px: [1.2, 3.4] },
    district: { world: [0.6, 3.0], px: [1.0, 3.6] },
    city: { world: [1.5, 8.0], px: [1.0, 4.5] },
  },
  /** Ribbons: strength of the soft body, of the two lane traces and of the pulses, relative to a file edge. */
  ribbon: { body: 0.6, lane: 2.4, pulse: 0.9 },
} as const;
