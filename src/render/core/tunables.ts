// Render tunables that have no key in config.json yet. They live here, in one place, so the lead can
// move them into config (see "Requested changes" in the 1G report). Nothing else in src/render
// repeats these numbers.
export const RENDER_LOCAL = {
  camera: {
    /** Vertical field of view, degrees (the spike's value). */
    fovDeg: 45,
    /** Camera azimuth of the default view: looking along −Z with +X to the right. */
    defaultAzimuth: Math.PI / 2,
    /** Elevation clamps, radians above the ground plane. */
    minElevation: 0.2,
    maxElevation: 1.45,
    /** Zoom factor per wheel pixel (exponential). */
    zoomSpeed: 0.0015,
    /** Orbit radians per dragged pixel. */
    orbitSpeed: 0.006,
    /** Share of the viewport the map may fill in the default framing. */
    fitMargin: 0.88,
    /** flyTo distance for a unit, in multiples of its radius. */
    unitFocusRadii: 16,
    /** How far past the map's bounding radius the look-at point may travel. */
    targetLimit: 1.25,
    /** A wheel gesture counts as "moving" for this long after its last event. */
    wheelSettleMs: 160,
  },
  pointer: {
    /** A press that travels less than this is a click, not a drag. CSS pixels. */
    clickSlopPx: 4,
  },
  loop: {
    /** Frame rate when nothing moves (ambient shimmer only). */
    idleFps: 20,
    /** Frames kept for the fps average. */
    statFrames: 90,
  },
  reveal: {
    /** Shares of config.reveal.growMs: spread across cities, jitter inside a city, one sphere's own growth. */
    cityStagger: 0.55,
    unitJitter: 0.15,
    grow: 0.3,
  },
  spheres: {
    /** Stars never draw smaller than this many device pixels in radius. */
    minPixelRadius: 0.9,
    /** Extra scale at the peak of a selected sphere's breath. */
    breatheScale: 0.05,
    hoverScale: 1.08,
    /** Glow given by selection, highlight and hover (0..1, same scale as importance glow). */
    selectedGlow: 0.85,
    highlightGlow: 0.7,
    hoverGlow: 0.45,
    overlayFadeMs: 300,
    initialCapacity: 1024,
  },
  background: {
    /** Linear resolution of the wisp pass relative to the canvas (PLAN.md §17.4: quarter resolution). */
    scale: 0.25,
    /** World units of camera travel per `theme.wisps.parallax` of background shift. */
    parallaxWorld: 1000,
    /** Extra wisp contrast at full emphasis (landing-page drag-over). */
    emphasisGain: 0.6,
    /** The standalone background: frame rate and resolution relative to the canvas's CSS size. */
    standaloneFps: 24,
    standaloneScale: 0.5,
  },
  grid: {
    /** Each coarser grid level is this many cells of the finer one. */
    majorEvery: 5,
  },
} as const;
