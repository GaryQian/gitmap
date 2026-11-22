// Comment-and-string blanking shared by the JVM import scanner and the Kotlin/Scala symbol
// extractor. The mask has the same length as the source, so offsets and line numbers carry over.

export type JvmLang = 'java' | 'kotlin' | 'scala';

const NL = 10, CR = 13, SPACE = 32, QUOTE = 34, DOLLAR = 36, APOS = 39, STAR = 42, SLASH = 47;
const BACKSLASH = 92, BACKTICK = 96, LBRACE = 123, RBRACE = 125;
/** String templates nested deeper than this are read as plain string contents. */
const MAX_TEMPLATE_DEPTH = 8;

export const isIdentChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === DOLLAR || c >= 128;
export const isIdentStart = (c: number): boolean => isIdentChar(c) && !(c >= 48 && c <= 57);
export const isUpper = (c: number): boolean => c >= 65 && c <= 90;

/** Index after the last identifier character at or after `i`. */
export function identEnd(s: string, i: number): number {
  while (isIdentChar(s.charCodeAt(i))) i++;
  return i;
}
/** Index of the next character that is not a blank or tab (nor a line break, when `newlines`). */
export function skipSpace(s: string, i: number, newlines = false): number {
  for (; ; i++) {
    const c = s.charCodeAt(i);
    if (c === SPACE || c === 9 || (newlines && (c === NL || c === CR))) continue;
    return i;
  }
}

/** Index after the string literal whose opening quote is at `i`. Unterminated one-line strings stop at the line end. */
function stringEnd(s: string, i: number, lang: JvmLang, templates: boolean, depth: number): number {
  const n = s.length;
  const triple = s.charCodeAt(i + 1) === QUOTE && s.charCodeAt(i + 2) === QUOTE;
  const escapes = !triple || lang === 'java';
  let j = i + (triple ? 3 : 1);
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === BACKSLASH && escapes) { j += 2; continue; }
    if (c === QUOTE) {
      if (!triple) return j + 1;
      if (s.charCodeAt(j + 1) === QUOTE && s.charCodeAt(j + 2) === QUOTE) {
        j += 3;
        while (s.charCodeAt(j) === QUOTE) j++; // `""""`: the extra quotes belong to the contents
        return j;
      }
    } else if (c === NL && !triple) {
      return j;
    } else if (c === DOLLAR && templates) {
      const d = s.charCodeAt(j + 1);
      if (d === DOLLAR && lang === 'scala') { j += 2; continue; } // `$$` is a literal dollar
      if (d === LBRACE && depth < MAX_TEMPLATE_DEPTH) { j = templateEnd(s, j + 2, lang, triple, depth + 1); continue; }
    }
    j++;
  }
  return n;
}

/** Index after the `}` closing a `${…}` template whose body starts at `j`. */
function templateEnd(s: string, j: number, lang: JvmLang, multiline: boolean, depth: number): number {
  const n = s.length;
  let braces = 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === LBRACE) braces++;
    else if (c === RBRACE) { if (--braces === 0) return j + 1; }
    else if (c === QUOTE) { j = stringEnd(s, j, lang, true, depth); continue; }
    else if (c === NL && !multiline) return j;
    j++;
  }
  return n;
}

/**
 * Same-length copy of `s` with comments, string contents (templates included), character literals
 * and back-quoted names that are not plain identifiers turned into spaces. Line breaks and the
 * quote characters themselves stay.
 */
export function maskJvm(s: string, lang: JvmLang): string {
  const n = s.length;
  const out = new Uint16Array(n);
  for (let k = 0; k < n; k++) out[k] = s.charCodeAt(k);
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== NL && out[k] !== CR) out[k] = SPACE;
  };
  const nesting = lang !== 'java'; // Kotlin and Scala block comments nest
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === SLASH) {
      const d = s.charCodeAt(i + 1);
      if (d === SLASH) {
        let j = i + 2;
        while (j < n && s.charCodeAt(j) !== NL) j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (d === STAR) {
        let j = i + 2, depth = 1;
        while (j < n && depth > 0) {
          const e = s.charCodeAt(j);
          if (e === STAR && s.charCodeAt(j + 1) === SLASH) { depth--; j += 2; }
          else if (nesting && e === SLASH && s.charCodeAt(j + 1) === STAR) { depth++; j += 2; }
          else j++;
        }
        blank(i, j);
        i = j;
        continue;
      }
    } else if (c === QUOTE) {
      // Kotlin strings always take `${…}`; Scala ones only behind an interpolator (s"…", f"…").
      const templates = lang === 'kotlin' || (lang === 'scala' && i > 0 && isIdentChar(s.charCodeAt(i - 1)));
      const end = stringEnd(s, i, lang, templates, 0);
      const closed = end - 1 > i && s.charCodeAt(end - 1) === QUOTE;
      blank(i + 1, closed ? end - 1 : end);
      i = end;
      continue;
    } else if (c === APOS) {
      const d = s.charCodeAt(i + 1);
      let end = -1;
      if (d === BACKSLASH) { // '\n', '\'', 'A'
        for (let k = i + 3; k <= i + 8 && k < n; k++) if (s.charCodeAt(k) === APOS) { end = k; break; }
      } else if (d !== APOS && d !== NL && s.charCodeAt(i + 2) === APOS) end = i + 2;
      else if (d >= 0xd800 && d <= 0xdbff && s.charCodeAt(i + 3) === APOS) end = i + 3;
      if (end > 0) { blank(i + 1, end); i = end + 1; continue; } // otherwise a Scala symbol or a stray quote
    } else if (c === BACKTICK && nesting) {
      let j = i + 1, plain = true;
      for (; j < n; j++) {
        const d = s.charCodeAt(j);
        if (d === BACKTICK || d === NL) break;
        if (!isIdentChar(d)) plain = false;
      }
      if (s.charCodeAt(j) === BACKTICK) { // `test names with spaces` must not read as code
        if (!plain) blank(i + 1, j);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  let masked = '';
  const CHUNK = 0x4000;
  for (let k = 0; k < n; k += CHUNK) masked += String.fromCharCode.apply(null, out.subarray(k, Math.min(n, k + CHUNK)) as unknown as number[]);
  return masked;
}
