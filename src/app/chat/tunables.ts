// Numbers of the chat panel and its tools that have no key in config.json yet. They sit here, in one
// place, for the lead to move. Nothing else in this folder repeats them.
export const CHAT_UI = {
  /** Rows a list tool returns when the model names no limit, and the most it may ask for. */
  listDefault: 40,
  listMax: 200,
  searchDefault: 15,
  searchMax: 50,
  /** Districts named per city in the overview; the rest are counted. */
  overviewDistricts: 12,
  /** Contributors named in the overview. */
  overviewContributors: 10,
  /** Dependencies and dependents named by get_file, strongest first. */
  neighbours: 8,
  /** Symbols named per dependency link. */
  symbols: 4,
  /** Authors named in a file's history. */
  authors: 4,
  /** Names offered when a file, an area or a contributor is not found. */
  suggestions: 5,
  /** read_file: lines per call, characters per line, characters per call. */
  readLines: 300,
  readLineChars: 400,
  readChars: 24_000,
  /** read_file: a NUL byte this early means the file is not text (the sidebar's rule). */
  binarySniffBytes: 8 * 1024,
  /** The most files one `select` call selects; the most important are kept. */
  selectionMax: 2000,
  /** Selected files named by get_view_state. */
  viewSelection: 30,
  /** Selected files, and selected cities and districts, named in the note sent with each question. */
  noteFiles: 12,
  noteAreas: 12,
  /** A district (then a city) is framed when it holds at least this share of what was selected. */
  frameShare: 0.6,
  /** Characters of one tool result. The loop has its own budget; this is the executor's backstop. */
  resultChars: 16_000,
  /** Model requests per user message when the loop is not told otherwise. */
  maxSteps: 8,
  /** The streaming answer is re-rendered as markdown at most this often. */
  renderMs: 80,
  /** The composer grows to this many lines, then scrolls. */
  composerLines: 6,
  /** The transcript follows new text while the reader is within this many pixels of its end. */
  followSlopPx: 32,
} as const;
