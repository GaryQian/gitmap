// Fast-pass scanner for Go (PLAN.md §6.3). No syntax tree.
//
// Go fixes where imports may stand: after the package clause and before every other declaration.
// The scanner reads tokens from the top of the file, skipping comments: `package <name>`, then each
// `import` declaration (one spec, or a parenthesised group), and it stops at the first token that
// is neither. The rest of the file is never read, so a string or a comment that mentions `import`
// further down cannot be taken for one, and the cost is the length of the file's header.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

const isIdentStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdentPart = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);

/** Index of the next token at or after `i`: skips white space, `;`, a byte-order mark and both comment forms. */
function skipTrivia(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 59 || c === 0xfeff) { i++; continue; }
    if (c === 47) {
      const d = s.charCodeAt(i + 1);
      if (d === 47) { const e = s.indexOf('\n', i + 2); i = e < 0 ? n : e + 1; continue; }
      if (d === 42) { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    }
    break;
  }
  return i;
}

function identEnd(s: string, i: number): number {
  while (i < s.length && isIdentPart(s.charCodeAt(i))) i++;
  return i;
}

const keywordAt = (s: string, i: number, word: string): boolean =>
  s.startsWith(word, i) && !isIdentPart(s.charCodeAt(i + word.length));

/** Index just past the string literal that opens at `i` ("interpreted" or `raw`), or -1 when there is none. */
function stringEnd(s: string, i: number): number {
  const quote = s.charCodeAt(i);
  if (quote === 96) { const e = s.indexOf('`', i + 1); return e < 0 ? -1 : e + 1; }
  if (quote !== 34) return -1;
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 34) return j + 1;
    if (c === 92) j++;
    else if (c === 10) break;
  }
  return -1;
}

/** Reads one import spec (`"path"`, `alias "path"`, `. "path"`, `_ "path"`) at `i`. Returns the index past it, or -1. */
function readSpec(s: string, i: number, out: ImportSpec[]): number {
  let alias = '';
  const c = s.charCodeAt(i);
  if (c === 46) { alias = '.'; i = skipTrivia(s, i + 1); }
  else if (isIdentStart(c)) { const e = identEnd(s, i); alias = s.slice(i, e); i = skipTrivia(s, e); }
  const end = stringEnd(s, i);
  if (end < 0) return -1;
  const spec = s.slice(i + 1, end - 1);
  if (spec) out.push(alias ? { spec, kind: 'import', names: [alias] } : { spec, kind: 'import' });
  return end;
}

/**
 * Imports and package name of a Go source text. Every import has kind 'import' and the path as
 * written; `names` holds the alias when there is one: an identifier, '.' (the package's exported
 * names join the file's scope) or '_' (imported for its side effects only). `decls.package` is the
 * declared package name ('store', 'main', 'store_test').
 */
export function scanGo(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  let pkg = '';
  let i = skipTrivia(text, 0);
  if (keywordAt(text, i, 'package')) {
    i = skipTrivia(text, i + 7);
    const e = identEnd(text, i);
    pkg = text.slice(i, e);
    i = e;
  }
  scan: for (;;) {
    i = skipTrivia(text, i);
    if (!keywordAt(text, i, 'import')) break;
    i = skipTrivia(text, i + 6);
    if (text.charCodeAt(i) !== 40) {
      i = readSpec(text, i, imports);
      if (i < 0) break;
      continue;
    }
    i++;
    for (;;) {
      i = skipTrivia(text, i);
      if (i >= text.length) break scan;
      if (text.charCodeAt(i) === 41) { i++; break; }
      i = readSpec(text, i, imports);
      if (i < 0) break scan; // not an import spec: give up instead of guessing
    }
  }
  return pkg ? { imports, decls: { package: [pkg] } } : { imports };
}
