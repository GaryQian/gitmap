// Fast-pass scanner for Swift (PLAN.md §6.3). No syntax tree.
//
// One sweep over the text that steps over comments (block comments nest), string literals
// (single-line, multi-line, raw `#"…"#`, with `\(…)` interpolation) and backtick identifiers, and
// tracks brace depth. It reads `import` statements wherever a statement starts, and the names of
// top-level types (brace depth 0), which the resolver needs for `import struct Module.Type`.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

const NL = 10, CR = 13, TAB = 9, SPACE = 32, QUOTE = 34, HASH = 35, LPAREN = 40, RPAREN = 41, STAR = 42, DOT = 46,
  SLASH = 47, SEMI = 59, AT = 64, BACKSLASH = 92, BACKTICK = 96, LBRACE = 123, RBRACE = 125;

/** Longest raw-string delimiter honoured (`###"…"###`); keeps the cost of every escape check constant. */
const MAX_HASHES = 16;
/** Strings nested through interpolation deeper than this are skipped without looking inside. */
const MAX_NESTING = 16;
/** Bounded look-ahead for attribute arguments and escaped identifiers, so the sweep stays linear. */
const MAX_LOOKAHEAD = 256;

const isIdStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdChar = (c: number): boolean => isIdStart(c) || (c >= 48 && c <= 57);

function identEnd(s: string, i: number): number {
  while (i < s.length && isIdChar(s.charCodeAt(i))) i++;
  return i;
}
function skipBlank(s: string, i: number): number {
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== SPACE && c !== TAB) break;
  }
  return i;
}
function lineEnd(s: string, i: number): number {
  const e = s.indexOf('\n', i);
  return e < 0 ? s.length : e;
}

/** `i` is at the opening of a block comment; returns the index after its close, honouring nesting. */
function skipBlockComment(s: string, i: number): number {
  const n = s.length;
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

/**
 * `i` is at the opening quote of a string literal that had `hashes` '#' before it. Returns the index
 * after the closing delimiter. An unterminated single-line string ends at its line end.
 */
function skipString(s: string, i: number, hashes: number, nesting: number): number {
  const n = s.length;
  const multi = s.charCodeAt(i + 1) === QUOTE && s.charCodeAt(i + 2) === QUOTE;
  i += multi ? 3 : 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH) {
      // In a raw string an escape needs the delimiter's '#'s; a bare backslash is literal.
      let j = i + 1, h = 0;
      while (h < hashes && s.charCodeAt(j) === HASH) { j++; h++; }
      if (h < hashes) { i++; continue; }
      const d = s.charCodeAt(j);
      if (d === LPAREN && nesting < MAX_NESTING) { i = skipInterpolation(s, j + 1, multi, nesting + 1); continue; }
      if (d === NL && !multi) return j;
      i = j + 1;
      continue;
    }
    if (c === QUOTE) {
      if (multi && !(s.charCodeAt(i + 1) === QUOTE && s.charCodeAt(i + 2) === QUOTE)) { i++; continue; }
      let j = i + (multi ? 3 : 1), h = 0;
      while (h < hashes && s.charCodeAt(j) === HASH) { j++; h++; }
      if (h === hashes) return j;
      i++;
      continue;
    }
    if (c === NL && !multi) return i;
    i++;
  }
  return n;
}

/** `i` is just inside `\(`; returns the index after the matching `)`. Strings inside are stepped over. */
function skipInterpolation(s: string, i: number, multi: boolean, nesting: number): number {
  const n = s.length;
  let depth = 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === LPAREN) depth++;
    else if (c === RPAREN) { if (--depth === 0) return i + 1; }
    else if (c === QUOTE) { i = skipString(s, i, 0, nesting); continue; }
    else if (c === NL && !multi) return i;
    i++;
  }
  return n;
}

/** `i` is at a '#'. Returns the index after a raw string that starts here, or after the '#'s otherwise. */
function skipHash(s: string, i: number): number {
  let j = i + 1;
  while (j - i < MAX_HASHES && s.charCodeAt(j) === HASH) j++;
  return s.charCodeAt(j) === QUOTE ? skipString(s, j, j - i, 0) : j;
}

/** `text` with comments replaced by a space each; string literals are kept. Used to read Package.swift. */
export function stripSwiftComments(text: string): string {
  const n = text.length;
  let out = '';
  let from = 0;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) { i = skipString(text, i, 0, 0); continue; }
    if (c === HASH) { i = skipHash(text, i); continue; }
    if (c === SLASH) {
      const d = text.charCodeAt(i + 1);
      if (d === SLASH || d === STAR) {
        out += text.slice(from, i) + ' ';
        i = from = d === SLASH ? lineEnd(text, i) : skipBlockComment(text, i);
        continue;
      }
    }
    i++;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** `import <kind> Module.Name` forms: the last path component is a declaration, not a submodule. */
const DECL_KINDS = new Set(['typealias', 'struct', 'class', 'enum', 'protocol', 'actor', 'let', 'var', 'func']);

/** Words that can follow `class` or `actor` without being the name of a declared type. */
const NOT_A_TYPE_NAME = new Set(['in', 'is', 'as', 'func', 'var', 'let', 'subscript']);

/** Reads what follows the `import` keyword at `i`; returns the index after it. */
function readImport(s: string, i: number, kind: string, out: ImportSpec[]): number {
  i = skipBlank(s, i);
  let e = identEnd(s, i);
  if (e === i) return i;
  let declaration = false;
  if (DECL_KINDS.has(s.slice(i, e))) {
    const j = skipBlank(s, e);
    if (j > e && isIdStart(s.charCodeAt(j))) { declaration = true; i = j; e = identEnd(s, j); }
  }
  const parts = [s.slice(i, e)];
  while (s.charCodeAt(e) === DOT && isIdStart(s.charCodeAt(e + 1))) {
    i = e + 1;
    e = identEnd(s, i);
    parts.push(s.slice(i, e));
  }
  if (declaration && parts.length > 1) {
    const name = parts.pop()!;
    out.push({ spec: parts.join('.'), kind, names: [name] });
  } else {
    out.push({ spec: parts.join('.'), kind });
  }
  return e;
}

/**
 * Imports and top-level type names of a Swift source text.
 *
 * Import kinds: 'import', 'testable' (`@testable import`) and 'exported' (`@_exported import`).
 * `spec` is the module path (`Core`, `Foundation.NSString`); `import struct Core.Money` gives
 * `{ spec: 'Core', names: ['Money'] }`. `decls.classes` lists the class, struct, enum, protocol,
 * actor and typealias names declared at the top level (extensions are not declarations).
 */
export function scanSwift(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  const classes = new Set<string>();
  const n = text.length;
  let i = 0;
  let depth = 0;
  // True while the current statement has shown only attributes and access modifiers.
  let clean = true;
  let kind = 'import';
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === SPACE || c === TAB || c === CR) { i++; continue; }
    if (c === NL || c === SEMI) { clean = true; kind = 'import'; i++; continue; }
    if (c === SLASH) {
      const d = text.charCodeAt(i + 1);
      if (d === SLASH) { i = lineEnd(text, i); continue; }
      if (d === STAR) { i = skipBlockComment(text, i); continue; }
      clean = false; i++;
      continue;
    }
    if (c === QUOTE) { i = skipString(text, i, 0, 0); clean = false; continue; }
    if (c === HASH) { i = skipHash(text, i); clean = false; continue; }
    if (c === LBRACE) { depth++; clean = true; kind = 'import'; i++; continue; }
    if (c === RBRACE) { if (depth > 0) depth--; clean = true; kind = 'import'; i++; continue; }
    if (c === BACKTICK) {
      // An escaped identifier (`class`): step over it so it is not read as a keyword.
      const stop = Math.min(n, i + MAX_LOOKAHEAD);
      let j = i + 1;
      while (j < stop && isIdChar(text.charCodeAt(j))) j++;
      i = text.charCodeAt(j) === BACKTICK ? j + 1 : i + 1;
      clean = false;
      continue;
    }
    if (c === AT) {
      const e = identEnd(text, i + 1);
      if (clean) {
        const name = text.slice(i + 1, e);
        if (name === 'testable') kind = 'testable'; else if (name === '_exported') kind = 'exported';
      }
      i = e;
      // Attribute arguments on the same line: `@_spi(Internal) import Foo`.
      if (clean && text.charCodeAt(i) === LPAREN) {
        const stop = Math.min(n, i + MAX_LOOKAHEAD);
        let level = 0;
        for (let j = i; j < stop; j++) {
          const d = text.charCodeAt(j);
          if (d === NL) break;
          if (d === LPAREN) level++;
          else if (d === RPAREN && --level === 0) { i = j + 1; break; }
        }
      }
      continue;
    }
    if (isIdStart(c)) {
      const e = identEnd(text, i);
      const member = i > 0 && text.charCodeAt(i - 1) === DOT;
      const len = e - i;
      // Every keyword of interest is 4 to 11 characters long ('enum', 'open' … 'fileprivate').
      const word = !member && len >= 4 && len <= 11 ? text.slice(i, e) : '';
      i = e;
      switch (word) {
        case 'import':
          if (clean) i = readImport(text, i, kind, imports);
          clean = false;
          break;
        case 'public': case 'internal': case 'private': case 'fileprivate': case 'package': case 'open':
          break;
        case 'class': case 'struct': case 'enum': case 'protocol': case 'actor': case 'typealias':
          if (depth === 0) {
            const j = skipBlank(text, i);
            const k = identEnd(text, j);
            if (j > i && k > j && isIdStart(text.charCodeAt(j))) {
              const name = text.slice(j, k);
              // `actor` is only a contextual keyword (`for actor in cast`), and `class func` is a member.
              if (!NOT_A_TYPE_NAME.has(name)) classes.add(name);
              i = k;
            }
          }
          clean = false;
          break;
        default:
          clean = false;
      }
      continue;
    }
    clean = false;
    i++;
  }
  return classes.size ? { imports, decls: { classes: [...classes] } } : { imports };
}
