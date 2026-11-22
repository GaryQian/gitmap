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
  /** Most district↔district ribbons drawn at once, strongest first. */
  districtRibbons: 400,
  /** Each quality step-down (ctx.counters.quality) multiplies the edge caps by this. */
  qualityStep: 0.5,
  /** Aggregates are rebuilt once batches have been quiet for this long, or at the latest after `rebuildMaxMs`. */
  rebuildQuietMs: 180,
  rebuildMaxMs: 1200,
  /** While a simulation is hot, the in-view sets are reselected at most this often. */
  hotReselectMs: 400,
  /** An edge whose endpoint is dimmed by the type filter keeps this share of its strength. */
  dimmed: 0.15,
  /** Brightness at confidence 0 (1 at confidence 1). */
  lowConfidence: 0.35,
  /** Seconds over which a newly chosen edge fades in, and a level cross-fades after a model change. */
  fadeIn: 0.45,
  /** Ambient levels drop to this while something is hovered or selected, so its edges read. */
  focusDim: 0.45,
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
