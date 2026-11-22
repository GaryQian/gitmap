// Matching a query against one path: the query's terms, how good one occurrence of a term is, and
// the best occurrence of every term. Pure, no DOM; shared by the index and by the highlighter.
//
// A path is always matched as the text '/' + path. With the slash in front, every directory and the
// file name are preceded by one, so "starts a path segment" is one test with no special case for the
// root, and a term such as "/src/app" matches at the root without help.
import { SEARCH_LOCAL } from './tunables';

const T = SEARCH_LOCAL.tier;
const SLASH = 47;
const DOT = 46;

export interface Term {
  /** Lower-cased when the query folds case. */
  text: string;
  /** Holds a '/': it is matched against the whole path, and may run from a directory into the file name. */
  slash: boolean;
}

export interface Query {
  terms: Term[];
  /** Smart case: true (ignore case) unless the query has an upper-case letter. */
  fold: boolean;
  /** Length of the longest term. */
  longest: number;
}

/** Split a query into terms. Null when nothing is left to search for. */
export function parseQuery(raw: string): Query | null {
  const cleaned = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim();
  if (!cleaned) return null;
  const terms: Term[] = [];
  const seen = new Set<string>();
  let longest = 0;
  for (let word of cleaned.split(/\s+/)) {
    if (word.startsWith('./')) word = word.slice(2);
    if (word === '' || word === '/' || seen.has(word)) continue;
    seen.add(word);
    terms.push({ text: word, slash: word.includes('/') });
    longest = Math.max(longest, word.length);
    if (terms.length === SEARCH_LOCAL.maxTerms) break;
  }
  return terms.length === 0 ? null : { terms, fold: cleaned === cleaned.toLowerCase(), longest };
}

/** Lower-case without changing the length, so offsets into the result are offsets into the original. */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  return out;
}

const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;
/** Letters, digits and everything outside ASCII: the characters a word in a file name is made of. */
const isWord = (c: number): boolean => isLower(c) || isUpper(c) || (c >= 48 && c <= 57) || c > 127;

/** A word starts at `pos`: after punctuation, or at a camelCase hump ("State" in selectionState, "Parser" in XMLParser). */
function wordStartsAt(text: string, pos: number): boolean {
  const prev = text.charCodeAt(pos - 1);
  if (!isWord(prev)) return true;
  const cur = text.charCodeAt(pos);
  if (!isUpper(cur)) return false;
  return isLower(prev) || (isUpper(prev) && isLower(text.charCodeAt(pos + 1)));
}

/** A word ends just before `e`. */
function wordEndsAt(text: string, e: number, end: number): boolean {
  if (e >= end) return true;
  const next = text.charCodeAt(e);
  return !isWord(next) || (isUpper(next) && isLower(text.charCodeAt(e - 1)));
}

function hasDot(text: string, from: number, end: number): boolean {
  for (let i = from; i < end; i++) if (text.charCodeAt(i) === DOT) return true;
  return false;
}

/**
 * How good the occurrence of a term at `pos` is (a value from SEARCH_LOCAL.tier). `text` holds the
 * path in its original case in [start, end), beginning with the added '/'; `base` is where its file
 * name begins. The text may be one path or many joined together.
 */
export function occurrenceTier(text: string, start: number, base: number, end: number, pos: number, len: number, slash: boolean): number {
  const e = pos + len;
  if (slash) {
    const aligned = text.charCodeAt(pos) === SLASH || text.charCodeAt(pos - 1) === SLASH;
    if (e === end) return pos <= start + 1 ? T.pathExact : aligned ? T.pathSuffix : T.pathSuffixLoose;
    if (e > base) return !aligned ? T.pathIntoNameLoose : wordEndsAt(text, e, end) ? T.pathIntoNameWord : T.pathIntoName;
    if (!aligned) return T.pathDirsLoose;
    return text.charCodeAt(e - 1) === SLASH || text.charCodeAt(e) === SLASH ? T.pathDirsWhole : T.pathDirs;
  }
  if (pos === base) {
    if (e === end) return T.exact;
    if (text.charCodeAt(e) === DOT && !hasDot(text, e + 1, end)) return T.stem;
    return wordEndsAt(text, e, end) ? T.prefixWord : T.prefix;
  }
  if (pos > base) {
    if (!wordStartsAt(text, pos)) return T.inside;
    return wordEndsAt(text, e, end) ? T.wordWhole : T.word;
  }
  if (text.charCodeAt(pos - 1) === SLASH) return text.charCodeAt(e) === SLASH ? T.dirWhole : T.dirStart;
  return wordStartsAt(text, pos) ? T.dirWord : T.dirInside;
}

// Outputs of findBest, kept out of the return value so the hot loop allocates nothing.
let foundTier = 0;
let foundPos = -1;

/**
 * The best occurrence of one term in one path. `hay` is '/' + path in the case being searched,
 * `orig` the same text in its original case.
 */
function findBest(hay: string, orig: string, base: number, term: Term): boolean {
  const { text, slash } = term;
  const len = text.length;
  const end = hay.length;
  let best = 0;
  let bestPos = -1;
  if (slash) {
    for (let p = hay.indexOf(text); p >= 0; p = hay.indexOf(text, p + 1)) {
      const tier = occurrenceTier(orig, 0, base, end, p, len, true);
      if (tier > best) { best = tier; bestPos = p; }
    }
  } else {
    // The file name first: any match there outranks any match in a directory.
    for (let p = hay.indexOf(text, base); p >= 0; p = hay.indexOf(text, p + 1)) {
      const tier = occurrenceTier(orig, 0, base, end, p, len, false);
      if (tier > best) { best = tier; bestPos = p; }
      if (p === base) break; // nothing later can beat a match at the start of the name
    }
    if (best === 0) {
      for (let p = hay.indexOf(text, 1); p >= 0; p = hay.indexOf(text, p + 1)) {
        const tier = occurrenceTier(orig, 0, base, end, p, len, false);
        if (tier > best) { best = tier; bestPos = p; }
        if (tier === T.dirWhole) break;
      }
    }
  }
  foundTier = best;
  foundPos = bestPos;
  return best > 0;
}

/**
 * Score one path text against a query: the mean tier of its terms, or 0 when a term is missing.
 * `at`, when given, receives the position of each term's best occurrence in the text.
 */
export function matchText(hay: string, orig: string, base: number, query: Query, at?: number[]): number {
  const { terms } = query;
  let sum = 0;
  for (let k = 0; k < terms.length; k++) {
    if (!findBest(hay, orig, base, terms[k]!)) return 0;
    sum += foundTier;
    if (at) at[k] = foundPos;
  }
  return sum / terms.length;
}

/** Start, end pairs (end exclusive) in the path for the terms found at `at`, in order and merged where they touch. */
export function rangesAt(query: Query, at: readonly number[]): number[] {
  const spans: [number, number][] = [];
  query.terms.forEach((term, k) => {
    // −1: positions are in '/' + path
    const from = Math.max(0, at[k]! - 1);
    const to = at[k]! - 1 + term.text.length;
    if (to > from) spans.push([from, to]);
  });
  spans.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [from, to] of spans) {
    const last = out.length - 1;
    if (last >= 0 && from <= out[last]!) out[last] = Math.max(out[last]!, to);
    else out.push(from, to);
  }
  return out;
}
