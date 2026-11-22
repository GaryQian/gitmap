// Fast-pass scanner for Dart (PLAN.md §6.3). No syntax tree.
//
// Dart allows directives (`library`, `import`, `export`, `part`, `part of`) only at the top of a
// file, before any declaration. The scanner therefore reads directives one after another, skipping
// comments and metadata between them, and stops at the first token that is not a directive. It never
// looks at the rest of the file, so a 2 MB generated file costs as much as its header.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/**
 * Kind tags of the specs this scanner emits:
 *   'import'           import 'uri' …;            (also each alternative URI of a conditional import)
 *   'export'           export 'uri' …;            (also each alternative URI of a conditional export)
 *   'part'             part 'uri';                 library → one of its parts
 *   'part-of'          part of 'uri';              part → its library, by URI
 *   'part-of-library'  part of some.library.name;  part → its library, by declared name (`spec` is the name)
 */
export type DartImportKind = 'import' | 'export' | 'part' | 'part-of' | 'part-of-library';

const NL = 10, DQUOTE = 34, DOLLAR = 36, SQUOTE = 39, LPAREN = 40, RPAREN = 41, STAR = 42, COMMA = 44, DOT = 46, SLASH = 47;
const SEMI = 59, LT = 60, GT = 62, AT = 64, BACKSLASH = 92, LOWER_R = 114, LBRACE = 123, RBRACE = 125;
/** Strings nested through `${…}` deeper than this are skipped without looking inside interpolations. */
const MAX_NESTING = 16;

const isQuote = (c: number): boolean => c === SQUOTE || c === DQUOTE;
const isWordChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === DOLLAR || c >= 128;

/** Index after the whitespace and comments (line comments, and block comments with nesting) starting at `i`. */
function skipTrivia(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 0xfeff) { i++; continue; }
    if (c !== SLASH) break;
    const j = skipComment(s, i);
    if (j === i) break;
    i = j;
  }
  return i;
}

/** Index after the comment starting at `i`, or `i` when there is none. */
function skipComment(s: string, i: number): number {
  const n = s.length;
  const d = s.charCodeAt(i + 1);
  if (d === SLASH) {
    const e = s.indexOf('\n', i + 2);
    return e < 0 ? n : e + 1;
  }
  if (d !== STAR) return i;
  let depth = 1;
  i += 2;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === SLASH && s.charCodeAt(i + 1) === STAR) { depth++; i += 2; continue; }
    if (c === STAR && s.charCodeAt(i + 1) === SLASH) { i += 2; if (--depth === 0) return i; continue; }
    i++;
  }
  return n;
}

/** True when a string literal starts at `i`: a quote, or `r` + quote (raw string). */
function isStringStart(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return isQuote(c) || (c === LOWER_R && isQuote(s.charCodeAt(i + 1)));
}

/**
 * Index after the string literal starting at `i` (single, double or triple quoted, raw or not).
 * Interpolations (`${…}`) are skipped as code, so a quote inside one does not end the string.
 * An unterminated single-line string ends at its line end.
 */
function skipString(s: string, i: number, depth: number): number {
  const n = s.length;
  const raw = s.charCodeAt(i) === LOWER_R;
  if (raw) i++;
  const q = s.charCodeAt(i);
  const triple = s.charCodeAt(i + 1) === q && s.charCodeAt(i + 2) === q;
  i += triple ? 3 : 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === q) {
      if (!triple) return i + 1;
      if (s.charCodeAt(i + 1) === q && s.charCodeAt(i + 2) === q) return i + 3;
    } else if (c === NL && !triple) {
      return i;
    } else if (!raw) {
      if (c === BACKSLASH) i++;
      else if (c === DOLLAR && s.charCodeAt(i + 1) === LBRACE && depth < MAX_NESTING) { i = skipGroup(s, i + 2, LBRACE, RBRACE, depth + 1); continue; }
    }
    i++;
  }
  return n;
}

/** Index after the `close` that matches an `open` already consumed before `i`; strings and comments inside are skipped. */
function skipGroup(s: string, i: number, open: number, close: number, depth: number): number {
  const n = s.length;
  let level = 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === open) level++;
    else if (c === close) { if (--level === 0) return i + 1; }
    else if (isQuote(c)) { i = skipString(s, i, depth); continue; }
    else if (c === LOWER_R && isQuote(s.charCodeAt(i + 1)) && !(i > 0 && isWordChar(s.charCodeAt(i - 1)))) { i = skipString(s, i, depth); continue; }
    else if (c === SLASH) { const j = skipComment(s, i); if (j > i) { i = j; continue; } }
    i++;
  }
  return n;
}

function wordEnd(s: string, i: number, dots: boolean): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (!(isWordChar(c) || (dots && c === DOT))) break;
    i++;
  }
  return i;
}

/** Text between the quotes of the string literal spanning [start, end). */
function stringValue(s: string, start: number, end: number): string {
  if (s.charCodeAt(start) === LOWER_R) start++;
  const q = s.charCodeAt(start);
  const len = s.charCodeAt(start + 1) === q && s.charCodeAt(start + 2) === q && end - start >= 6 ? 3 : 1;
  const closed = end - len >= start + len && s.charCodeAt(end - 1) === q;
  return s.slice(start + len, closed ? end - len : end);
}

/**
 * Directives of a Dart source text: one ImportSpec per URI (see DartImportKind), with `names` for
 * `show` lists, and `decls.library` when the file declares a library name.
 */
export function scanDart(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  let library: string | undefined;
  const s = text;
  const n = s.length;
  let i = 0;
  if (s.charCodeAt(0) === 35 && s.charCodeAt(1) === 33) { // #! script tag
    const e = s.indexOf('\n');
    i = e < 0 ? n : e + 1;
  }

  /** Reads one string literal (or several adjacent ones) at `i`; null when there is none. Leaves `i` after it. */
  const readUri = (): string | null => {
    if (!isStringStart(s, i)) return null;
    let uri = '';
    do {
      const end = skipString(s, i, 0);
      uri += stringValue(s, i, end);
      i = skipTrivia(s, end);
    } while (isStringStart(s, i));
    return uri;
  };
  const endDirective = (): void => {
    i = skipTrivia(s, i);
    if (s.charCodeAt(i) === SEMI) i++;
  };

  while (i < n) {
    i = skipTrivia(s, i);
    const c = s.charCodeAt(i);
    if (c === AT) { // metadata: @name.name<…>(…)
      i = wordEnd(s, i + 1, true);
      if (s.charCodeAt(i) === LT) i = skipGroup(s, i + 1, LT, GT, 0);
      if (s.charCodeAt(i) === LPAREN) i = skipGroup(s, i + 1, LPAREN, RPAREN, 0);
      continue;
    }
    const e = wordEnd(s, i, false);
    if (e === i) break;
    const word = s.slice(i, e);
    if (word === 'augment') { i = e; continue; }
    if (word === 'library') {
      i = skipTrivia(s, e);
      const ne = wordEnd(s, i, true);
      if (ne > i) { library = s.slice(i, ne); i = ne; } else readUri();
      endDirective();
    } else if (word === 'part') {
      i = skipTrivia(s, e);
      const oe = wordEnd(s, i, false);
      if (s.slice(i, oe) === 'of') {
        i = skipTrivia(s, oe);
        const uri = readUri();
        if (uri !== null) { if (uri) imports.push({ spec: uri, kind: 'part-of' }); } else {
          const ne = wordEnd(s, i, true);
          if (ne > i) imports.push({ spec: s.slice(i, ne), kind: 'part-of-library' });
          i = ne;
        }
      } else {
        const uri = readUri();
        if (uri) imports.push({ spec: uri, kind: 'part' });
      }
      endDirective();
    } else if (word === 'import' || word === 'export') {
      i = skipTrivia(s, e);
      const first = readUri();
      if (first === null) break;
      const uris = [first];
      let names: string[] | undefined;
      for (;;) { // configurations, prefix and combinators, in whatever order they come
        i = skipTrivia(s, i);
        const we = wordEnd(s, i, false);
        const w = s.slice(i, we);
        if (w === 'if') {
          i = skipTrivia(s, we);
          if (s.charCodeAt(i) !== LPAREN) break;
          i = skipTrivia(s, skipGroup(s, i + 1, LPAREN, RPAREN, 0));
          const alt = readUri();
          if (alt === null) break;
          uris.push(alt);
        } else if (w === 'deferred') {
          i = we;
        } else if (w === 'as') {
          i = skipTrivia(s, we);
          i = wordEnd(s, i, false);
        } else if (w === 'show' || w === 'hide') {
          i = we;
          for (;;) {
            i = skipTrivia(s, i);
            const ne = wordEnd(s, i, false);
            if (ne === i) break;
            if (w === 'show') (names ??= []).push(s.slice(i, ne));
            i = skipTrivia(s, ne);
            if (s.charCodeAt(i) !== COMMA) break;
            i++;
          }
        } else break;
      }
      for (const uri of uris) if (uri) imports.push(names ? { spec: uri, kind: word, names } : { spec: uri, kind: word });
      endDirective();
    } else break; // the first declaration: no directive can follow
  }
  return library ? { imports, decls: { library: [library] } } : { imports };
}
