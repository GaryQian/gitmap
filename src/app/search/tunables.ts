// Search pill tunables that have no key in config.json yet (see "Requested changes" in the 4E report).
export const SEARCH_UI = {
  /** Wait this long after the last keystroke before asking the session. */
  debounceMs: 80,
  /** Results asked for; the list scrolls beyond the rows that fit (search.css). */
  limit: 12,
} as const;
