// Interaction tunables that have no key in config.json yet (see "Requested changes" in the 2F
// report). The three that do — hoverDelayMs, jiggleMax, jiggleSettleMs — are read from config.
export const INTERACTION_LOCAL = {
  pick: {
    /** A sphere is never a smaller target than a disc of this radius on screen. CSS pixels. */
    minRadiusPx: 4,
  },
  click: {
    /**
     * Two clicks this close in place are one double-click (the second is not a new click) when the
     * browser counts them as one, or, where it does not count (touch), when they are this close in time.
     */
    doubleMs: 500,
    doubleSlopPx: 6,
    /** A plain click on a sphere eases the camera to centre it (PLAN.md §9: "select and focus"). */
    focus: true,
    /**
     * Focus comes in no further than this many times the distance RenderApi.flyTo uses for a unit,
     * and never moves the camera away: a click from close up only recentres.
     */
    focusSlack: 4,
  },
  marquee: {
    /** Opacity of the rectangle's fill and of its outline, and the outline's width in device pixels. */
    fill: 0.08,
    line: 0.75,
    linePx: 1,
  },
  jiggle: {
    /** Damping ratio of the spring: below 1 it wobbles before it settles. */
    damping: 0.35,
    /** A sphere is at rest once its offset is below this share of the clamp. */
    restFraction: 0.02,
    /** Share of the pointer's ground speed given to the sphere it sweeps onto. */
    impulseGain: 0.5,
    /** Share of that impulse passed to a touching neighbour, fading to nothing at `neighbourReach`. */
    neighbourShare: 0.45,
    /** Neighbours are reached up to this many times the two radii apart (1 = touching). */
    neighbourReach: 1.6,
    /** Spheres integrated at once. Past this, only the sphere under the pointer is added. */
    maxActive: 64,
    /** A click's ring pushes neighbours within this many radii outward, by this share of the strongest kick. */
    selectRingRadii: 6,
    selectRingKick: 0.7,
    /** A pointer that rested longer than this starts with no speed. */
    velocityWindowMs: 120,
  },
} as const;
