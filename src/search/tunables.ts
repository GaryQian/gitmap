// Search tunables that have no key in config.json yet. They live here, in one place, so the lead can
// move them into config (see "Requested changes" in the 4E report). Nothing else in src/search repeats
// these numbers.
export const SEARCH_LOCAL = {
  /** Results returned when the caller gives no limit. */
  defaultLimit: 20,
  /** Terms this short match the start of a file name, or a whole directory name, before anything else. */
  shortTerm: 2,
  /**
   * Most occurrences examined by one of the capped scans (inside file names for a short term, in
   * directories, a term with a slash). The index is ordered shortest path first, so what a capped
   * scan drops is the long paths that would have ranked last among equals anyway.
   */
  scanBudget: 20_000,
  /** Most paths scored in full for a query of several terms; each costs far more than one occurrence. */
  candidateBudget: 8_000,
  /** Terms of a query that are used; the rest are ignored. */
  maxTerms: 6,
  fuzzy: {
    /** Typo tolerance only starts when the exact pass found fewer results than this … */
    whenFewerThan: 1,
    /** … and the longest term has at least this many characters: on shorter terms a typo match is noise. */
    minTermLength: 4,
    /** Fuzzy matches ranked (uFuzzy's info pass is the expensive part); beyond this they are dropped. */
    rankAtMost: 400,
    /** Terms permuted for any-order matching; uFuzzy runs factorial(this) passes at most. */
    outOfOrderTerms: 3,
  },
  /**
   * Match quality, higher is better. A query's score is the mean over its terms. Every file-name
   * tier is above every directory tier, and every exact tier is above the fuzzy ones.
   */
  tier: {
    /** The term is the whole file name: "store.ts". */
    exact: 100,
    /** The term is the file name without its extension: "store" for store.ts. */
    stem: 92,
    /** The file name starts with the term, and the term ends at a word boundary: "store" in store.test.ts. */
    prefixWord: 84,
    /** The file name starts with the term: "sto". */
    prefix: 80,
    /** A whole word inside the file name: "test" in store.test.ts, "State" in selectionState.ts. */
    wordWhole: 72,
    /** The start of a word inside the file name. */
    word: 68,
    /** Anywhere inside the file name. */
    inside: 60,
    /** A whole directory name. */
    dirWhole: 36,
    /** The start of a directory name. */
    dirStart: 30,
    /** The start of a word inside a directory name. */
    dirWord: 24,
    /** Anywhere inside a directory name. */
    dirInside: 20,
    /** Terms with a slash. The whole path. */
    pathExact: 100,
    /** The end of the path, starting at a directory boundary: "app/store.ts". */
    pathSuffix: 94,
    /** The end of the path, starting mid-name. */
    pathSuffixLoose: 86,
    /** Reaches into the file name and stops at a word boundary: "app/store". */
    pathIntoNameWord: 80,
    /** Reaches into the file name: "app/sto". */
    pathIntoName: 76,
    /** As the two above, but starting mid-name. */
    pathIntoNameLoose: 66,
    /** Whole directory names only: "app/ui/". */
    pathDirsWhole: 40,
    /** Directories, starting at a boundary. */
    pathDirs: 34,
    /** Directories, starting mid-name. */
    pathDirsLoose: 22,
    /** A typo-tolerant match that lies inside the file name. */
    fuzzyName: 12,
    /** A typo-tolerant match that reaches into the directories. */
    fuzzyPath: 6,
  },
} as const;
