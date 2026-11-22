// Overlay chrome tunables that have no key in config.json yet (see "Requested changes" in the 4D
// report). Nothing else in src/app/overlays repeats these numbers.
export const OVERLAY_UI = {
  /** While layer chunks stream in, the active overlay is rebuilt at most once in this many milliseconds. */
  recomputeMs: 250,
  /** Contributors listed in the picker before "N more"; typing narrows the list. */
  contributorsShown: 60,
  /** Dependency reach: the hop slider runs 1..this; one step further is "All". */
  reachSliderMax: 10,
  /** Recency: steps of the age slider; the last one is "every file". */
  ageSliderSteps: 100,
} as const;
