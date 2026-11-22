// Comment and literal masking for the C-like languages the bridge extractors read (C, C++, Java,
// Kotlin, Scala). One pass, linear in the text, never throws.

export interface MaskOptions {
  /** Block comments nest (Kotlin, Scala). */
  nestedComments?: boolean;
  /** `"""…"""` strings (Java text blocks, Kotlin and Scala raw strings). */
  tripleQuotes?: boolean;
  /** C++ raw strings: `R"delim(…)delim"`. */
  rawStrings?: boolean;
}

const INTERESTING = /["'/]/g;

/**
 * Same-length copy of `s` in which comments and the *contents* of string and character literals
 * are spaces. Newlines stay, and so do the quote characters, so a caller can find a literal in the
 * masked text and read its value from the original at the same offsets (see `literalAt`).
 */
export function maskCode(s: string, opt: MaskOptions = {}): string {
  const n = s.length;
  const parts: string[] = [];
  let from = 0;
  // Replaces [a, b) by spaces, keeping its newlines.
  const blank = (a: number, b: number) => {
    if (b <= a) return;
    parts.push(s.slice(from, a));
    let lineStart = a;
    for (let k = a; k < b; k++) {
      if (s.charCodeAt(k) === 10) { parts.push(' '.repeat(k - lineStart), '\n'); lineStart = k + 1; }
    }
    parts.push(' '.repeat(b - lineStart));
    from = b;
  };
  const next = new RegExp(INTERESTING.source, 'g');
  let i = 0;
  while (i < n) {
    next.lastIndex = i;
    const hit = next.exec(s);
    if (!hit) break;
    i = hit.index;
    const c = s.charCodeAt(i);

    if (c === 47) { // '/'
      const d = s.charCodeAt(i + 1);
      if (d === 47) {
        let j = i + 2;
        while (j < n && s.charCodeAt(j) !== 10) j++;
        blank(i, j);
        i = j;
      } else if (d === 42) {
        let j = i + 2;
        let depth = 1;
        while (j < n) {
          const e = s.charCodeAt(j);
          if (e === 42 && s.charCodeAt(j + 1) === 47) { j += 2; if (--depth === 0) break; continue; }
          if (opt.nestedComments && e === 47 && s.charCodeAt(j + 1) === 42) { depth++; j += 2; continue; }
          j++;
        }
        if (j > n) j = n;
        blank(i, j);
        i = j;
      } else {
        i++;
      }
      continue;
    }

    if (c === 34) { // '"'
      if (opt.tripleQuotes && s.charCodeAt(i + 1) === 34 && s.charCodeAt(i + 2) === 34) {
        const close = s.indexOf('"""', i + 3);
        let end = close < 0 ? n : close + 3;
        while (end < n && s.charCodeAt(end) === 34) end++; // """…"""" ends with a quote of its own
        blank(i + 1, close < 0 ? n : end - 1);
        i = end;
        continue;
      }
      if (opt.rawStrings && i > 0 && s.charCodeAt(i - 1) === 82 && isRawPrefix(s, i - 2)) {
        const end = rawStringEnd(s, i);
        if (end > 0) { blank(i + 1, end - 1); i = end; continue; }
      }
      let j = i + 1;
      while (j < n) {
        const e = s.charCodeAt(j);
        if (e === 92) { j += 2; continue; }
        if (e === 34 || e === 10) break;
        j++;
      }
      if (j > n) j = n;
      blank(i + 1, j); // an unterminated string ends at the line end
      i = j < n && s.charCodeAt(j) === 34 ? j + 1 : j;
      continue;
    }

    // c === 39: a character literal is 'x' or '\…'; any other quote (a Scala symbol, a C++ digit
    // separator, a Kotlin label) is left alone.
    const d = s.charCodeAt(i + 1);
    let end = -1;
    if (d === 92) {
      const lim = Math.min(n, i + 12);
      let j = i + 3;
      while (j < lim && s.charCodeAt(j) !== 39 && s.charCodeAt(j) !== 10) j++;
      if (j < lim && s.charCodeAt(j) === 39) end = j;
    } else if (d !== 10 && d !== 39 && s.charCodeAt(i + 2) === 39) {
      end = i + 2;
    } else if (d >= 0xd800 && d <= 0xdbff && s.charCodeAt(i + 3) === 39) {
      end = i + 3;
    }
    if (end > 0) { blank(i + 1, end); i = end + 1; } else i++;
  }
  if (from === 0) return s;
  parts.push(s.slice(from));
  return parts.join('');
}

function isIdentChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether the character before the `R` of `R"` lets it start a raw string (nothing, or an encoding prefix). */
function isRawPrefix(s: string, k: number): boolean {
  if (k < 0) return true;
  const c = s.charCodeAt(k);
  if (!isIdentChar(c)) return true;
  // u8R, uR, UR, LR
  return (c === 56 || c === 117 || c === 85 || c === 76) && (k === 0 || !isIdentChar(s.charCodeAt(k - 1)) || c === 56);
}

/** Index just past the closing quote of the raw string whose opening quote is at `q`, or -1. */
function rawStringEnd(s: string, q: number): number {
  const head = s.slice(q + 1, q + 18);
  const open = head.indexOf('(');
  if (open < 0) return -1;
  const terminator = ')' + head.slice(0, open) + '"';
  const close = s.indexOf(terminator, q + 1 + open);
  return close < 0 ? s.length : close + terminator.length;
}

/** Longest literal `literalAt` reads; class paths and method names are far shorter. */
const MAX_LITERAL = 512;

/**
 * The string literal whose opening quote sits at `q` in masked text `code`: its value read from the
 * original `text`, and the offset of its closing quote. Null when `q` is not a quote, the literal
 * is unterminated or too long, or it contains an escape.
 */
export function literalAt(code: string, text: string, q: number): { value: string; end: number } | null {
  if (code.charCodeAt(q) !== 34) return null;
  const rel = code.slice(q + 1, q + 1 + MAX_LITERAL).indexOf('"');
  if (rel < 0) return null;
  const value = text.slice(q + 1, q + 1 + rel);
  if (value.indexOf('\\') >= 0 || value.indexOf('\n') >= 0) return null;
  return { value, end: q + 1 + rel };
}

/** Index of the `)` matching the `(` at `open`, looking at most `limit` characters ahead; -1 if none. */
export function matchParen(code: string, open: number, limit: number): number {
  const stop = Math.min(code.length, open + limit);
  let depth = 0;
  for (let i = open; i < stop; i++) {
    const c = code.charCodeAt(i);
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return i;
  }
  return -1;
}
