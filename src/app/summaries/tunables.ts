// Summary-card tunables that have no key in config.json yet (see "Requested changes" in the report).
// The hover delay itself is config.interaction.hoverDelayMs. Nothing else in src/app/summaries
// repeats these numbers; the fade's duration lives in summaries.css.
export const SUMMARY_UI = {
  /** Gap between a pill and its summary card, CSS pixels. */
  gapPx: 8,
  /** The card stays this far inside the view. */
  marginPx: 12,
  /** After a card has been showing, another pill shows its own without the hover delay for this long. */
  graceMs: 450,
} as const;
