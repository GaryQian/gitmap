// Fast-pass scanner for Rust (PLAN.md §6.3). No syntax tree: one forward sweep that steps over
// comments (nested block comments too), strings, raw strings, char literals and lifetimes, and
// stops at the keywords `mod`, `use`, `extern`, `crate` and `super`.
//
// What it reports, always relative to the *file's* module (see `relativeToFile`):
//   mod name;                    { spec: 'name', kind: 'mod' }; inside `mod a { … }` the spec is 'a::name'
//   use a::b::C;                 { spec: 'a::b', kind: 'use', names: ['C'] }  — read as "from a::b import C"
//   use a::{b, c::{d, e}};       { spec: 'a', names: ['b'] } and { spec: 'a::c', names: ['d', 'e'] }
//   use a::*;                    { spec: 'a', kind: 'use', names: ['*'] }
//   use a::b::{self, C};         { spec: 'a', names: ['b'] } and { spec: 'a::b', names: ['C'] }
//   use a::b as c;               the original name ('b'); the alias is dropped
//   use foo;                     { spec: 'foo', kind: 'use' }
//   extern crate foo;            { spec: 'foo', kind: 'extern-crate' }
//   crate::a::f() / super::T     { spec: 'crate::a', kind: 'path', names: ['f'] } — a qualified path used
//                                without a `use`, once per distinct prefix with every name seen
// and in `decls`:
//   mod      inline modules the file declares ('tests', 'a', 'a::b')
//   modPath  `#[path = "…"]` attributes of `mod` declarations, as 'spec=path'
import type { ImportSpec, ScanResult } from '../../contracts/lang';

const isIdentStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdentChar = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);

function identEnd(s: string, i: number): number {
  while (isIdentChar(s.charCodeAt(i))) i++;
  return i;
}
// `s[i..]` opens a block comment: the index after its matching close, counting nested comments.
function blockCommentEnd(s: string, i: number): number {
  const n = s.length;
  let depth = 1;
  i += 2;
  while (i < n && depth > 0) {
    const c = s.charCodeAt(i);
    if (c === 47 && s.charCodeAt(i + 1) === 42) { depth++; i += 2; } else if (c === 42 && s.charCodeAt(i + 1) === 47) { depth--; i += 2; } else i++;
  }
  return i < n ? i : n;
}
function lineEnd(s: string, i: number): number {
  const e = s.indexOf('\n', i);
  return e < 0 ? s.length : e;
}
/** Skips whitespace and comments. */
function skipTrivia(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (c !== 47) break;
    const d = s.charCodeAt(i + 1);
    if (d === 47) i = lineEnd(s, i); else if (d === 42) i = blockCommentEnd(s, i); else break;
  }
  return i;
}
/** `s[i]` is `"`: the index after the closing quote of an ordinary (escaped) string. */
function stringEnd(s: string, i: number): number {
  const n = s.length;
  i++;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) i += 2; else if (c === 34) return i + 1; else i++;
  }
  return n;
}
/** `s[i]` is `'`: the index after a char literal ('x', '\n', '\u{1F600}') or after a lifetime or label ('a). */
function quoteEnd(s: string, i: number): number {
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 92) {
    const stop = Math.min(s.length, i + 14);
    for (let j = i + 3; j < stop; j++) if (s.charCodeAt(j) === 39) return j + 1;
    return i + 2;
  }
  if (s.charCodeAt(i + 2) === 39) return i + 3;
  if (c1 >= 0xd800 && c1 <= 0xdbff && s.charCodeAt(i + 3) === 39) return i + 4;
  return identEnd(s, i + 1);
}
const isPathSep = (s: string, i: number): boolean => s.charCodeAt(i) === 58 && s.charCodeAt(i + 1) === 58;

const ANY_KEYWORD = /\b(?:mod|use|crate|super)\b/;

export function scanRust(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  if (!ANY_KEYWORD.test(text)) return { imports };
  const n = text.length;
  const inlineMods: string[] = [];
  const modPaths: string[] = [];
  /** Qualified `crate::…` / `super::…` paths outside `use`: prefix → names. */
  const qualified = new Map<string, Set<string>>();
  /** Inline modules open at the cursor, and the brace depth each was opened at. */
  const ctx: string[] = [];
  const ctxDepth: number[] = [];
  let depth = 0;
  /** Bracket depth inside an attribute `#[…]`, 0 outside. */
  let attr = 0;
  /** `#[path = "…"]` values waiting for the `mod` they belong to. */
  let pending: string[] = [];
  /** Progress through `pub ( in`: the path after it is a visibility, not a reference. */
  let vis = 0;

  /** A path as written inside the open inline modules → the same path from the file's own module. */
  const relativeToFile = (segs: string[]): string[] => {
    if (ctx.length === 0) return segs;
    if (segs[0] === 'self') return ['self', ...ctx, ...segs.slice(1)];
    if (segs[0] !== 'super') return segs;
    let up = 0;
    while (segs[up] === 'super') up++;
    return up <= ctx.length ? ['self', ...ctx.slice(0, ctx.length - up), ...segs.slice(up)] : segs.slice(ctx.length);
  };

  /** After `mod`: a declaration (`mod x;`) is an import, an inline module (`mod x {`) opens a context. */
  const parseMod = (from: number): number => {
    let i = skipTrivia(text, from);
    if (text.charCodeAt(i) === 114 && text.charCodeAt(i + 1) === 35) i += 2; // r#name
    const e = identEnd(text, i);
    if (e === i || !isIdentStart(text.charCodeAt(i))) return from;
    const name = text.slice(i, e);
    const after = skipTrivia(text, e);
    const c = text.charCodeAt(after);
    if (c === 59) {
      const spec = ctx.length ? `${ctx.join('::')}::${name}` : name;
      imports.push({ spec, kind: 'mod' });
      for (const p of pending) modPaths.push(`${spec}=${p}`);
      pending = [];
      return after + 1;
    }
    if (c === 123) {
      ctx.push(name);
      ctxDepth.push(depth++);
      inlineMods.push(ctx.join('::'));
      pending = [];
      return after + 1;
    }
    return e;
  };

  /** After `use`: walks the use-tree to its `;`, grouping leaves by the path in front of them. */
  const parseUse = (from: number): number => {
    let i = skipTrivia(text, from);
    if (text.charCodeAt(i) === 60) return i; // `impl Trait + use<'a, T>`: not an import
    const path: string[] = [];
    const marks: number[] = []; // path length at each open brace
    const groups = new Map<string, string[]>();
    const leaf = (name: string) => {
      let prefix = path;
      if (name === 'self' && path.length > 0) { name = path[path.length - 1]; prefix = path.slice(0, -1); }
      if (prefix.length === 0) {
        if (name !== '*' && name !== 'self' && name !== 'super' && name !== 'crate') imports.push({ spec: name, kind: 'use' });
        return;
      }
      if (prefix.length === 1 && prefix[0] === '') { imports.push({ spec: `::${name}`, kind: 'use' }); return; } // use ::krate;
      const key = relativeToFile(prefix).join('::');
      const names = groups.get(key);
      if (!names) groups.set(key, [name]); else if (!names.includes(name)) names.push(name);
    };
    for (;;) {
      i = skipTrivia(text, i);
      const c = text.charCodeAt(i);
      const base = marks.length ? marks[marks.length - 1] : 0;
      if (c === 59) { i++; break; }
      if (c === 123) { marks.push(path.length); i++; continue; }
      if (c === 125) { if (marks.length === 0) break; path.length = marks.pop()!; i++; continue; }
      if (c === 44) { path.length = base; i++; continue; }
      if (c === 42) { leaf('*'); i++; continue; }
      if (isPathSep(text, i)) { if (path.length === base) path.push(''); i += 2; continue; } // leading `::`
      if (!isIdentStart(c)) break;
      if (c === 114 && text.charCodeAt(i + 1) === 35) i += 2; // r#name
      const e = identEnd(text, i);
      if (e === i) break;
      const seg = text.slice(i, e);
      i = skipTrivia(text, e);
      if (isPathSep(text, i)) { path.push(seg); i += 2; continue; }
      if (text.charCodeAt(i) === 97 && text.charCodeAt(i + 1) === 115 && !isIdentChar(text.charCodeAt(i + 2))) { // `as alias`
        i = identEnd(text, skipTrivia(text, i + 2));
      }
      leaf(seg);
    }
    for (const [spec, names] of groups) imports.push({ spec, kind: 'use', names });
    return i;
  };

  /** After `extern`: `extern crate name;`. */
  const parseExtern = (from: number): number => {
    const i = skipTrivia(text, from);
    const e = identEnd(text, i);
    if (text.slice(i, e) !== 'crate') return from;
    const s = skipTrivia(text, e);
    const se = identEnd(text, s);
    if (se > s && isIdentStart(text.charCodeAt(s)) && text.slice(s, se) !== 'self') imports.push({ spec: text.slice(s, se), kind: 'extern-crate' });
    return se;
  };

  /** At `crate` / `super` outside a `use`: `crate::a::b::f` is a reference to `f` in `crate::a::b`. */
  const parseQualified = (head: string, from: number): number => {
    const segs = [head];
    let i = from;
    while (isPathSep(text, i) && isIdentStart(text.charCodeAt(i + 2))) {
      const e = identEnd(text, i + 2);
      segs.push(text.slice(i + 2, e));
      i = e;
    }
    if (segs.length < 2) return i;
    const name = segs.pop()!;
    if (name === 'super' || name === 'self') return i;
    const prefix = relativeToFile(segs);
    if (prefix[0] === 'self') return i; // the file itself or an inline module of it
    const key = prefix.join('::');
    const names = qualified.get(key);
    if (names) names.add(name); else qualified.set(key, new Set([name]));
    return i;
  };

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    const pv = vis;
    vis = 0;
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) { i = lineEnd(text, i); vis = pv; } else if (d === 42) { i = blockCommentEnd(text, i); vis = pv; } else i++;
      continue;
    }
    if (c === 34) { i = stringEnd(text, i); continue; }
    if (c === 39) { i = quoteEnd(text, i); continue; }
    if (isIdentStart(c)) {
      const e = identEnd(text, i);
      const len = e - i;
      if (len > 6) { i = e; continue; }
      const word = text.slice(i, e);
      if (word === 'r' || word === 'br' || word === 'cr') {
        let k = e;
        while (text.charCodeAt(k) === 35) k++;
        if (text.charCodeAt(k) === 34) { // raw string r#"…"#
          const close = '"' + '#'.repeat(k - e);
          const end = text.indexOf(close, k + 1);
          i = end < 0 ? n : end + close.length;
          continue;
        }
        if (word === 'r' && k === e + 1 && isIdentStart(text.charCodeAt(k))) { i = identEnd(text, k); continue; } // r#keyword is a name
      }
      if (word === 'mod') i = parseMod(e);
      else if (word === 'use') i = parseUse(e);
      else if (word === 'extern') i = parseExtern(e);
      else if (word === 'crate' || word === 'super') i = pv === 3 ? e : parseQualified(word, e);
      else if (word === 'path' && attr > 0) {
        i = e;
        let k = skipTrivia(text, e);
        if (text.charCodeAt(k) === 61) {
          k = skipTrivia(text, k + 1);
          if (text.charCodeAt(k) === 34) {
            i = stringEnd(text, k);
            pending.push(text.slice(k + 1, i - 1).replace(/\\+/g, '/'));
          }
        }
      } else {
        if (word === 'pub') vis = 1; else if (word === 'in' && pv === 2) vis = 3;
        i = e;
      }
      continue;
    }
    if (c >= 48 && c <= 57) { i = identEnd(text, i); continue; } // a number with its suffix: 1u8, 0xff
    if (c === 123) { depth++; if (pending.length) pending = []; } else if (c === 125) {
      depth--;
      if (ctx.length && depth === ctxDepth[ctxDepth.length - 1]) { ctx.pop(); ctxDepth.pop(); }
      if (pending.length) pending = [];
    } else if (c === 59) { if (pending.length) pending = []; } else if (c === 40) { if (pv === 1) vis = 2; } else if (c === 35) {
      const d = text.charCodeAt(i + 1);
      if (d === 91 || (d === 33 && text.charCodeAt(i + 2) === 91)) { attr = 1; i += d === 91 ? 2 : 3; continue; }
    } else if (c === 91) { if (attr > 0) attr++; } else if (c === 93) { if (attr > 0) attr--; }
    i++;
  }

  for (const [spec, names] of qualified) imports.push({ spec, kind: 'path', names: [...names] });
  if (inlineMods.length === 0 && modPaths.length === 0) return { imports };
  const decls: Record<string, string[]> = {};
  if (inlineMods.length) decls.mod = inlineMods;
  if (modPaths.length) decls.modPath = modPaths;
  return { imports, decls };
}
