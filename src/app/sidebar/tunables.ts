// The reader's tunables. config.json has no `sidebar` section yet, so they live here in one place
// for the lead to move (see "Requested changes" in the 3O report). Nothing else repeats these numbers.
export const SIDEBAR_LOCAL = {
  /** Width of the reader the first time it opens, CSS pixels. */
  widthDefaultPx: 520,
  widthMinPx: 320,
  widthMaxPx: 1200,
  /** The map keeps at least this much of the window, whatever width was saved. */
  mapMinPx: 360,
  /** Arrow keys on the resize handle move it this far; with Shift, `keyStepLargePx`. */
  keyStepPx: 16,
  keyStepLargePx: 64,
  /** Files larger than this show their first part with a note. */
  maxTextBytes: 2 * 1024 * 1024,
  /** A NUL byte this early means the file is not text. */
  binarySniffBytes: 8 * 1024,
  /** localStorage key for the saved width and the markdown view. */
  storageKey: 'gitmap.sidebar',
} as const;
