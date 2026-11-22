// Fast-pass scanner for stylesheets (PLAN.md §6.3, §6.4): `@import`, `@use`, `@forward` and `url()`.
// One linear sweep that steps over comments and strings, so nothing inside them looks like a rule.
import type { ImportSpec } from '../../contracts/lang';
import { isLocalSpec } from './paths';

export interface StyleSyntax {
  /** `//` starts a comment (SCSS, Sass, Less, Stylus). In plain CSS it does not. */
  lineComments: boolean;
  /** Indented Sass, where `@import a, b` needs no quotes. */
  indented: boolean;
}

/** Syntax of a stylesheet by file extension or by a `<style lang="…">` attribute. */
export function styleSyntax(lang: string | undefined): StyleSyntax {
  const l = (lang ?? '').toLowerCase();
  return { lineComments: l === 'scss' || l === 'sass' || l === 'less' || l === 'styl' || l === 'stylus', indented: l === 'sass' };
}

const QUOTE = 34, APOS = 39, SLASH = 47, STAR = 42, AT = 64, BACKSLASH = 92, NEWLINE = 10;
const isWord = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95;

function skipSpace(s: string, i: number): number {
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  return i;
}

/** The string whose opening quote is at `i`: its contents and the index after it. An unterminated one ends at the line end. */
function readString(s: string, i: number): { value: string; end: number } {
  const quote = s.charCodeAt(i);
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === BACKSLASH) { j += 2; continue; }
    if (c === quote) return { value: s.slice(i + 1, j), end: j + 1 };
    if (c === NEWLINE) break;
    j++;
  }
  return { value: s.slice(i + 1, j), end: Math.min(j, s.length) };
}

const isUrlAt = (s: string, i: number): boolean =>
  (s.charCodeAt(i) | 32) === 117 && (s.charCodeAt(i + 1) | 32) === 114 && (s.charCodeAt(i + 2) | 32) === 108 && s.charCodeAt(i + 3) === 40 &&
  !(i > 0 && isWord(s.charCodeAt(i - 1)));

function push(out: ImportSpec[], spec: string, kind: string): void {
  spec = spec.trim();
  if (isLocalSpec(spec)) out.push({ spec, kind });
}

/** `i` is just after `url(`. Returns the index after the closing parenthesis. */
function readUrl(s: string, i: number, kind: string, out: ImportSpec[]): number {
  let j = skipSpace(s, i);
  const c = s.charCodeAt(j);
  if (c === QUOTE || c === APOS) {
    const str = readString(s, j);
    push(out, str.value, kind);
    j = skipSpace(s, str.end);
    return s.charCodeAt(j) === 41 ? j + 1 : j;
  }
  const close = s.indexOf(')', j);
  const line = s.indexOf('\n', j);
  if (close < 0 || (line >= 0 && line < close)) return j; // not a url() after all
  push(out, s.slice(j, close), kind);
  return close + 1;
}

/** `i` is at `@`. Reads `@import`, `@use` and `@forward`; any other at-rule is stepped over by name. */
function atRule(s: string, i: number, out: ImportSpec[], syntax: StyleSyntax): number {
  let j = i + 1;
  while (j < s.length && isWord(s.charCodeAt(j))) j++;
  const name = s.slice(i + 1, j).toLowerCase();
  if (name === 'use' || name === 'forward') {
    const k = skipSpace(s, j);
    const c = s.charCodeAt(k);
    if (c !== QUOTE && c !== APOS) return j;
    const str = readString(s, k);
    push(out, str.value, `css-${name}`);
    return str.end;
  }
  if (name !== 'import') return j;
  j = skipSpace(s, j);
  if (s.charCodeAt(j) === 40) { // Less options: @import (reference) "x"
    const close = s.indexOf(')', j);
    if (close < 0) return j + 1;
    j = skipSpace(s, close + 1);
  }
  for (;;) { // "a", "b" — a media query after the list is left to the main sweep
    const c = s.charCodeAt(j);
    if (c === QUOTE || c === APOS) {
      const str = readString(s, j);
      push(out, str.value, 'css-import');
      j = str.end;
    } else if (isUrlAt(s, j)) {
      j = readUrl(s, j + 4, 'css-import', out);
    } else if (syntax.indented) {
      const start = j;
      while (j < s.length) { const d = s.charCodeAt(j); if (d === 44 || d === 59 || d === NEWLINE) break; j++; }
      if (j === start) break;
      push(out, s.slice(start, j), 'css-import');
    } else break;
    const k = skipSpace(s, j);
    if (s.charCodeAt(k) !== 44) break;
    j = skipSpace(s, k + 1);
  }
  return j;
}

const ANY = /@(?:import|use|forward)\b|url\(/i;

/**
 * Imports of a stylesheet text. Kinds: 'css-import', 'css-use', 'css-forward' (another stylesheet)
 * and 'css-url' (an image, font or other asset). External URLs and values built from variables are
 * left out.
 */
export function scanStyles(text: string, syntax: StyleSyntax = styleSyntax('css')): ImportSpec[] {
  const out: ImportSpec[] = [];
  if (!ANY.test(text)) return out;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === SLASH) {
      const d = text.charCodeAt(i + 1);
      if (d === STAR) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (d === SLASH && syntax.lineComments) { const e = text.indexOf('\n', i + 2); i = e < 0 ? n : e + 1; continue; }
      i++;
    } else if (c === QUOTE || c === APOS) {
      i = readString(text, i).end;
    } else if (c === AT) {
      i = atRule(text, i, out, syntax);
    } else if ((c | 32) === 117 && isUrlAt(text, i)) {
      i = readUrl(text, i + 4, 'css-url', out);
    } else i++;
  }
  return out;
}
