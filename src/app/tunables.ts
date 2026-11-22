// Chrome tunables that have no key in config.json yet. They live here, in one place, so the lead can
// move them into config (see "Requested changes" in the 2G report). Nothing else in src/app repeats
// these numbers.
export const APP_LOCAL = {
  pills: {
    /** A city shows its district pills when it is no farther than this many camera distances … */
    districtNear: 1.6,
    /** … and its territory radius over its depth reaches this; pills are at full strength by `districtFull`. */
    districtFrom: 0.2,
    districtFull: 0.3,
    /** City pills start to fade at this many camera distances and reach `fadeFloor` at `fadeEnd`. */
    fadeStart: 1.3,
    fadeEnd: 3.5,
    fadeFloor: 0.6,
    /** Space kept around a pill when dropping overlapping ones, CSS pixels. */
    gapPx: 4,
    /** A pill sits this far above the far edge of its territory, and never more than this share of the view above its anchor. */
    liftPadPx: 6,
    /** Pills keep this far inside the edges of the view. */
    edgePx: 6,
    maxLiftShare: 0.28,
    /** How long a dropped pill takes to fade before its element returns to the pool; matches pills.css. */
    fadeMs: 160,
    /** How often, at most, the pills look up where the fixed chrome is, so as not to show through it. */
    chromeReadMs: 300,
    /** A press that travels less than this is a click (fly to), not a drag. CSS pixels. */
    clickSlopPx: 4,
  },
  anchor: {
    /** Gap between a sphere's edge and its tooltip or detail card, CSS pixels. */
    tooltipGapPx: 10,
    cardGapPx: 16,
    /** Anchored elements stay this far inside the view. */
    marginPx: 8,
  },
  selection: {
    /** Selection pills shown before "+N more". */
    pillsShown: 5,
  },
  detail: {
    /** Dependents and dependencies listed by name. */
    namesShown: 4,
  },
  legend: {
    /** Steps of the minimum-lines slider. */
    sliderSteps: 200,
  },
  reset: {
    /** How often, at most, the "Reset view" pill asks whether the view and layout are at their defaults. */
    pollMs: 120,
  },
} as const;
