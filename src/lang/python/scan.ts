// Fast-pass import scanner for Python (PLAN.md §6.3). No syntax tree.
//
// A first sweep writes a same-length mask of the source with comments blanked and string contents
// (including triple-quoted strings) overwritten; a second finds `import` / `from` at the start of a
// statement and reads the names that follow.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/** Code unit written over string contents: not whitespace, not an identifier character. */
const FILL = 0x7f;
const SPACE = 32;

const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c >= 128;

/** Same-length copy of `s`: `#` comments become spaces, string contents become FILL, newlines in code stay. */
export function maskPython(s: string): string {
  const n = s.length;
  const out = new Uint16Array(n);
  for (let k = 0; k < n; k++) out[k] = s.charCodeAt(k);
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 35) { while (i < n && s.charCodeAt(i) !== 10) out[i++] = SPACE; continue; }
    if (c === 34 || c === 39) {
      if (s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c) { // triple-quoted
        i += 3;
        while (i < n) {
          const d = s.charCodeAt(i);
          if (d === 92) { out[i] = FILL; if (i + 1 < n) out[i + 1] = FILL; i += 2; continue; }
          if (d === c && s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c) { i += 3; break; }
          out[i++] = FILL;
        }
        continue;
      }
      i++;
      while (i < n) {
        const d = s.charCodeAt(i);
        if (d === 92) { out[i] = FILL; if (i + 1 < n) out[i + 1] = FILL; i += 2; continue; }
        if (d === c) { i++; break; }
        if (d === 10) break; // unterminated: stop at the line end
        out[i++] = FILL;
      }
      continue;
    }
    i++;
  }
  let masked = '';
  const CHUNK = 0x4000;
  for (let k = 0; k < n; k += CHUNK) masked += String.fromCharCode.apply(null, out.subarray(k, Math.min(n, k + CHUNK)) as unknown as number[]);
  return masked;
}

/** Skips blanks and backslash-newline continuations; newlines too when `multiline` (inside parentheses). */
function skipBlank(m: string, i: number, multiline: boolean): number {
  for (; i < m.length; i++) {
    const c = m.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 12) continue;
    if (c === 10 && multiline) continue;
    if (c === 92) {
      const d = m.charCodeAt(i + 1);
      if (d === 10) { i++; continue; }
      if (d === 13 && m.charCodeAt(i + 2) === 10) { i += 2; continue; }
    }
    break;
  }
  return i;
}
function nameEnd(m: string, i: number, dots: boolean): number {
  while (i < m.length) {
    const c = m.charCodeAt(i);
    if (!(isNameChar(c) || (dots && c === 46))) break;
    i++;
  }
  return i;
}
/** Skips an optional `as alias` at `i`. */
function skipAlias(m: string, i: number, multiline: boolean): number {
  const j = skipBlank(m, i, multiline);
  const e = nameEnd(m, j, false);
  if (m.slice(j, e) !== 'as') return i;
  const k = skipBlank(m, e, multiline);
  return nameEnd(m, k, false);
}

const ANY_IMPORT = /\bimport\b/;

/**
 * Imports of a Python source text. Kinds: 'import' (`import a.b` — one spec per module) and 'from'
 * (`from a.b import c, d`, with `names`; '*' for a star import). Relative modules keep their dots:
 * '.', '.mod', '..pkg.mod'.
 */
export function scanPythonImports(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  if (!ANY_IMPORT.test(text)) return { imports };
  const m = maskPython(text);
  // A statement starts a line, or follows ';' or a block-opening ':' (`try: import x`).
  const statement = /(?:^|[;:])[ \t]*(from|import)(?=[ \t.\\])/gm;
  let hit: RegExpExecArray | null;
  while ((hit = statement.exec(m))) {
    let i = statement.lastIndex;
    if (hit[1] === 'import') {
      for (;;) {
        i = skipBlank(m, i, false);
        const e = nameEnd(m, i, true);
        if (e === i) break;
        imports.push({ spec: m.slice(i, e), kind: 'import' });
        i = skipBlank(m, skipAlias(m, e, false), false);
        if (m.charCodeAt(i) !== 44) break;
        i++;
      }
    } else {
      i = skipBlank(m, i, false);
      const e = nameEnd(m, i, true);
      const spec = m.slice(i, e);
      i = skipBlank(m, e, false);
      const kw = nameEnd(m, i, false);
      if (!spec || m.slice(i, kw) !== 'import') { statement.lastIndex = Math.max(statement.lastIndex, i); continue; }
      i = skipBlank(m, kw, false);
      const multiline = m.charCodeAt(i) === 40;
      if (multiline) i++;
      const names: string[] = [];
      for (;;) {
        i = skipBlank(m, i, multiline);
        if (m.charCodeAt(i) === 42) { names.push('*'); i++; break; }
        const ne = nameEnd(m, i, false);
        if (ne === i) break;
        names.push(m.slice(i, ne));
        i = skipBlank(m, skipAlias(m, ne, multiline), multiline);
        if (m.charCodeAt(i) !== 44) break;
        i++;
      }
      imports.push(names.length ? { spec, kind: 'from', names } : { spec, kind: 'from' });
    }
    statement.lastIndex = Math.max(statement.lastIndex, i);
  }
  return { imports };
}
