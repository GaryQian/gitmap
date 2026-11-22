// Point-of-interest chrome tunables that have no key in config.json yet (see "Requested changes" in
// the 5D report). Nothing else in src/app/poi repeats these numbers.
export const POI_UI = {
  pill: {
    /** Gap between the top of the parent star and the pill, CSS pixels. */
    liftPx: 22,
    /** Space kept between two pills. */
    gapPx: 4,
    /** A pill that would overlap a higher-priority one moves up its beam by up to this many rows before it hides. */
    maxNudges: 2,
  },
  card: {
    /** Gap between the pill and its card. */
    gapPx: 12,
    /** The card stays this far inside the view; the top margin clears the row of chrome pills. */
    marginPx: 12,
    topMarginPx: 58,
    /** How far above the pill's top edge the card's top edge sits. */
    risePx: 10,
  },
  /** A press that travels less than this is a click elsewhere (closes the card), not a camera drag. */
  clickSlopPx: 4,
} as const;
