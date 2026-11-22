// Beam tunables that have no key in config.json yet (see "Requested changes" in the 5D report).
// The colour is theme.<mode>.warm; nothing else in src/render/poi repeats these numbers.
export const POI_LOCAL = {
  /** Instances allocated up front; the buffers double when a model carries more points of interest. */
  initialCapacity: 16,
  /** Seconds a new beam takes to rise to its height. */
  riseSeconds: 0.7,
  /** At the reveal, beams rise once this share of the grow-in has passed, spread over `revealSpread` seconds. */
  revealAfter: 0.8,
  revealSpread: 0.5,
  height: {
    /** Height as a share of the beam's distance from the camera, so it reads at every zoom … */
    perDepth: 0.25,
    /** … clamped to this many world units … */
    min: 30,
    max: 420,
    /** … and never shorter than this many radii of its star, so it still towers when the camera is close. */
    minRadii: 12,
  },
  halfWidth: {
    /** Half-width of the quad in star radii, and its floor in world units. */
    perRadius: 0.85,
    minWorld: 1.6,
    /** Clamp on screen, device pixels: far beams stay a thin line, near ones never become a wall. */
    minPx: 5,
    maxPx: 26,
  },
  /** Brightness kept by a beam so far away that its width sits on the pixel floor. */
  farFloor: 0.6,
  /** How fast the shimmer travels up the column, beam heights per second (0 under reduced motion). */
  shimmerSpeed: 0.11,
  /** Overall strength in dark mode (additive) and light mode (alpha blended). */
  gainDark: 1.25,
  gainLight: 1.0,
  /** After the sphere glows (1.5), before edges and particles (2, 3). */
  renderOrder: 1.6,
} as const;
