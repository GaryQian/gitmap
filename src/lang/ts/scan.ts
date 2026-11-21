// Fast-pass import scanner for TypeScript and JavaScript (PLAN.md §6.3). No syntax tree.
//
// Two linear sweeps. The first writes a same-length "mask" of the source in which comments are
// blank and the contents of string, template and regex literals are overwritten, so nothing inside
// them can look like code. The second finds the keywords import / export / require in the mask and
// reads each statement with a small hand parser, taking specifier text from the original source at
// the same offsets.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/** Code unit written over literal contents: not whitespace, not an identifier character. */
const FILL = 0x7f;
const SPACE = 32;

const isIdentChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c >= 128;
const isIdentStart = (c: number): boolean => isIdentChar(c) && !(c >= 48 && c <= 57);

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Same-length copy of `s`: comments become spaces; the contents of '…', "…", `…` and /…/ literals
 * become FILL (the delimiters stay); code inside `${…}` stays code.
 */
export function maskSource(s: string): string {
  const n = s.length;
  const out = new Uint16Array(n);
  for (let k = 0; k < n; k++) out[k] = s.charCodeAt(k);

  /** Brace depth inside each open `${`, innermost last. */
  const interpolations: number[] = [];
  /** Last significant code unit seen in code; 97 stands for "an identifier or number". */
  let prev = 0;
  let wordStart = 0, wordEnd = 0;

  // Fills a template body from `j` to its closing backtick or to the next `${`; returns the index after it.
  const template = (j: number): number => {
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 96) return j + 1;
      if (c === 92) { out[j] = FILL; if (j + 1 < n) out[j + 1] = FILL; j += 2; continue; }
      if (c === 36 && s.charCodeAt(j + 1) === 123) { interpolations.push(0); return j + 2; }
      out[j++] = FILL;
    }
    return n;
  };
  // Fills a quoted string starting at `j`; an unterminated one ends at the line end.
  const quoted = (j: number, quote: number): number => {
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92) { out[j] = FILL; if (j + 1 < n) out[j + 1] = FILL; j += 2; continue; }
      if (c === quote) return j + 1;
      if (c === 10) return j;
      out[j++] = FILL;
    }
    return n;
  };
  // Index after the closing `/` of a regex literal starting at `j`, or −1 when the line has none.
  const regexEnd = (j: number): number => {
    let inClass = false;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10) return -1;
      if (c === 92) { j += 2; continue; }
      if (inClass) { if (c === 93) inClass = false; } else if (c === 91) inClass = true; else if (c === 47) return j + 1;
      j++;
    }
    return -1;
  };
  const regexAllowed = (): boolean => {
    if (prev === 0) return true;
    if (prev === 97) return REGEX_AFTER.has(s.slice(wordStart, wordEnd));
    return prev !== 41 && prev !== 93 && prev !== 125 && prev !== 34 && prev !== 39 && prev !== 96;
  };

  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c <= SPACE) { i++; continue; }
    if (c === 47) {
      const d = s.charCodeAt(i + 1);
      if (d === 47) { while (i < n && s.charCodeAt(i) !== 10) out[i++] = SPACE; continue; }
      if (d === 42) {
        out[i] = out[i + 1] = SPACE; i += 2;
        while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) out[i++] = SPACE;
        if (i < n) { out[i] = SPACE; if (i + 1 < n) out[i + 1] = SPACE; i += 2; }
        continue;
      }
      if (regexAllowed()) {
        const end = regexEnd(i);
        if (end > 0) {
          for (let k = i + 1; k < end - 1; k++) out[k] = FILL;
          i = end; prev = 41;
          continue;
        }
      }
      prev = c; i++;
      continue;
    }
    if (c === 34 || c === 39) { i = quoted(i, c); prev = c; continue; }
    if (c === 96) {
      const depth = interpolations.length;
      i = template(i + 1);
      prev = interpolations.length > depth ? 123 : 96;
      continue;
    }
    if (c === 123) { if (interpolations.length) interpolations[interpolations.length - 1]++; prev = c; i++; continue; }
    if (c === 125) {
      if (interpolations.length) {
        if (interpolations[interpolations.length - 1] === 0) {
          interpolations.pop();
          const depth = interpolations.length;
          i = template(i + 1);
          prev = interpolations.length > depth ? 123 : 96;
          continue;
        }
        interpolations[interpolations.length - 1]--;
      }
      prev = c; i++;
      continue;
    }
    if (isIdentChar(c)) {
      wordStart = i++;
      while (i < n && isIdentChar(s.charCodeAt(i))) i++;
      wordEnd = i; prev = 97;
      continue;
    }
    prev = c; i++;
  }

  let masked = '';
  const CHUNK = 0x4000;
  for (let k = 0; k < n; k += CHUNK) masked += String.fromCharCode.apply(null, out.subarray(k, Math.min(n, k + CHUNK)) as unknown as number[]);
  return masked;
}

// ---- statement parsing over the mask ----

function skipWs(m: string, i: number): number {
  while (i < m.length && m.charCodeAt(i) <= SPACE) i++;
  return i;
}
function identEnd(m: string, i: number): number {
  while (i < m.length && isIdentChar(m.charCodeAt(i))) i++;
  return i;
}
/** The string literal whose opening quote is at `i` in the mask: its source text and the index after it. */
function literal(m: string, s: string, i: number): { text: string; end: number } | null {
  const q = m.charCodeAt(i);
  if (q !== 34 && q !== 39 && q !== 96) return null;
  let j = i + 1;
  while (j < m.length && m.charCodeAt(j) === FILL) j++;
  if (j === i + 1 || m.charCodeAt(j) !== q) return null; // empty, or a template with `${…}`
  return { text: s.slice(i + 1, j), end: j + 1 };
}
function isFromThenLiteral(m: string, s: string, i: number): boolean {
  const e = identEnd(m, i);
  return m.slice(i, e) === 'from' && literal(m, s, skipWs(m, e)) !== null;
}

/** Reads `a, b as c, type d }` after an opening brace; pushes the source-side names. Returns the index after `}`, or −1. */
function braceList(m: string, i: number, names: string[]): number {
  for (;;) {
    i = skipWs(m, i);
    const c = m.charCodeAt(i);
    if (c === 125) return i + 1;
    if (c === 44) { i++; continue; }
    const words: string[] = [];
    while (words.length < 5) {
      i = skipWs(m, i);
      if (!isIdentStart(m.charCodeAt(i))) break;
      const e = identEnd(m, i);
      words.push(m.slice(i, e));
      i = e;
    }
    if (words.length === 0 || words.length > 4) return -1;
    const typeOnly = words[0] === 'type' && (words.length === 2 || words.length === 4 || (words.length === 3 && words[1] !== 'as'));
    names.push(words[typeOnly ? 1 : 0]);
  }
}

function push(out: ImportSpec[], spec: string, kind: string, names: string[]): void {
  out.push(names.length ? { spec, kind, names } : { spec, kind });
}

/** `i` is just after the keyword `import`. Returns where to resume (i when this is not an import). */
function parseImport(m: string, s: string, i: number, out: ImportSpec[]): number {
  let j = skipWs(m, i);
  let c = m.charCodeAt(j);
  if (c === 40) { // import('x')
    const lit = literal(m, s, skipWs(m, j + 1));
    if (!lit) return i;
    const after = m.charCodeAt(skipWs(m, lit.end));
    if (after !== 41 && after !== 44) return i;
    out.push({ spec: lit.text, kind: 'dynamic' });
    return lit.end;
  }
  const bare = literal(m, s, j); // import 'x'
  if (bare) { out.push({ spec: bare.text, kind: 'import' }); return bare.end; }
  if (j === i) return i; // import.meta, `import:` and the like

  const names: string[] = [];
  if (isIdentStart(c)) { // `type` / `typeof` modifier
    const e = identEnd(m, j);
    const word = m.slice(j, e);
    if (word === 'type' || word === 'typeof') {
      const k = skipWs(m, e);
      const d = m.charCodeAt(k);
      if (d === 123 || d === 42 || (isIdentStart(d) && !isFromThenLiteral(m, s, k))) { j = k; c = d; }
    }
  }
  if (isIdentStart(c)) { // default binding
    names.push('default');
    j = skipWs(m, identEnd(m, j));
    if (m.charCodeAt(j) === 44) j = skipWs(m, j + 1);
    c = m.charCodeAt(j);
  }
  if (c === 42) { // * as ns
    j = skipWs(m, j + 1);
    let e = identEnd(m, j);
    if (m.slice(j, e) !== 'as') return i;
    j = skipWs(m, e);
    e = identEnd(m, j);
    if (e === j) return i;
    names.push('*');
    j = skipWs(m, e);
  } else if (c === 123) {
    const e = braceList(m, j + 1, names);
    if (e < 0) return i;
    j = skipWs(m, e);
  }
  const e = identEnd(m, j);
  if (m.slice(j, e) !== 'from') return i;
  const lit = literal(m, s, skipWs(m, e));
  if (!lit) return i;
  push(out, lit.text, 'import', names);
  return lit.end;
}

/** `i` is just after the keyword `export`. Only re-exports (`export … from 'x'`) produce a spec. */
function parseExport(m: string, s: string, i: number, out: ImportSpec[]): number {
  let j = skipWs(m, i);
  let c = m.charCodeAt(j);
  if (isIdentStart(c)) {
    const e = identEnd(m, j);
    if (m.slice(j, e) !== 'type') return i;
    j = skipWs(m, e);
    c = m.charCodeAt(j);
  }
  const names: string[] = [];
  if (c === 42) {
    j = skipWs(m, j + 1);
    const e = identEnd(m, j);
    if (m.slice(j, e) === 'as') {
      j = skipWs(m, e);
      const e2 = identEnd(m, j);
      if (e2 === j) return i;
      j = skipWs(m, e2);
    }
    names.push('*');
  } else if (c === 123) {
    const e = braceList(m, j + 1, names);
    if (e < 0) return i;
    j = skipWs(m, e);
  } else return i;
  const e = identEnd(m, j);
  if (m.slice(j, e) !== 'from') return i;
  const lit = literal(m, s, skipWs(m, e));
  if (!lit) return i;
  push(out, lit.text, 'export', names);
  return lit.end;
}

/** `i` is just after the keyword `require`. */
function parseRequire(m: string, s: string, i: number, out: ImportSpec[]): number {
  const j = skipWs(m, i);
  if (m.charCodeAt(j) !== 40) return i;
  const lit = literal(m, s, skipWs(m, j + 1));
  if (!lit) return i;
  const k = skipWs(m, lit.end);
  if (m.charCodeAt(k) !== 41) return i;
  out.push({ spec: lit.text, kind: 'require' });
  return k + 1;
}

const ANY_KEYWORD = /\b(?:import|export|require)\b/;

/**
 * Imports of a TS/JS source text. Kinds: 'import' (static, including type-only and side-effect
 * imports), 'export' (re-export), 'require', 'dynamic' (`import('x')`). `names` holds the names as the
 * exporting file knows them: 'default' for a default import, '*' for a namespace.
 */
export function scanImports(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  if (!ANY_KEYWORD.test(text)) return { imports };
  const m = maskSource(text);
  const keyword = /\b(?:import|export|require)\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = keyword.exec(m))) {
    const start = hit.index;
    const end = start + hit[0].length;
    const before = start > 0 ? m.charCodeAt(start - 1) : 0;
    // `.import`, `$require`, `#import`: a property or another identifier. A spread (`...require('x')`) is fine.
    if (before === 36 || before === 35 || before === 64) continue;
    if (before === 46 && !(start > 1 && m.charCodeAt(start - 2) === 46)) continue;
    if (m.charCodeAt(end) === 36) continue;
    const first = hit[0].charCodeAt(0);
    const next = first === 105 ? parseImport(m, text, end, imports) : first === 101 ? parseExport(m, text, end, imports) : parseRequire(m, text, end, imports);
    if (next > end) keyword.lastIndex = next;
  }
  return { imports };
}
