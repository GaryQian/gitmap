// Fast-pass scanner for Java, Kotlin and Scala (PLAN.md §6.3). No syntax tree: one sweep blanks
// comments and strings (./mask.ts), a second walks braces and a few keywords to read the package,
// the imports and the top-level declarations the resolver's package index is built from.
import type { ImportSpec, ScanResult } from '../../contracts/lang';
import { identEnd, isIdentChar, isIdentStart, maskJvm, skipSpace, type JvmLang } from './mask';

const NL = 10, CR = 13, LPAREN = 40, RPAREN = 41, STAR = 42, COMMA = 44, DOT = 46, COLON = 58, SEMI = 59;
const LT = 60, GT = 62, QUESTION = 63, BACKTICK = 96, LBRACE = 123, RBRACE = 125, MINUS = 45;

/** Longest `<…>` type-parameter list and `{…}` selector list the scanner follows. */
const MAX_ANGLE_CHARS = 160;
const MAX_SELECTOR_CHARS = 1000;
/** Comma-separated expressions read from one Scala `import`. */
const MAX_IMPORT_EXPRESSIONS = 64;
/** How far back on its line a declaration's `private` modifier is looked for. */
const MODIFIER_WINDOW = 200;

const WORDS: Record<JvmLang, string> = {
  java: 'package|import|class|interface|enum|record',
  kotlin: 'package|import|class|interface|object|typealias|fun|val|var',
  scala: 'package|import|class|trait|object|enum|type|def|val|var',
};
const SWEEPS = {} as Record<JvmLang, RegExp>;
for (const lang of Object.keys(WORDS) as JvmLang[]) SWEEPS[lang] = new RegExp(`[{}()]|\\b(?:${WORDS[lang]})\\b`, 'g');

const TYPE_WORDS = new Set(['class', 'interface', 'enum', 'record', 'object', 'trait', 'typealias', 'type']);
const PRIVATE = /\bprivate\b(?!\s*\[)/; // Scala's `private[pkg]` is visible to other files
const SELECTOR = /^`?([\w$\u0080-￿]+|\*)`?(?:\s*(?:=>|\bas\b)\s*(\S+))?/;

/** Index after the `>` matching the `<` at `i`, or -1 when it is not a short, well-formed type list. */
export function skipAngles(m: string, i: number): number {
  const limit = Math.min(m.length, i + MAX_ANGLE_CHARS);
  let depth = 0;
  for (let j = i; j < limit; j++) {
    const c = m.charCodeAt(j);
    if (c === LT) depth++;
    else if (c === GT) { if (m.charCodeAt(j - 1) !== MINUS && --depth === 0) return j + 1; }
    else if (c === LBRACE || c === RBRACE || c === SEMI) return -1;
  }
  return -1;
}

/**
 * Name of a Kotlin `fun` / `val` / `var` declaration starting at `i` (just after the keyword):
 * skips type parameters and an extension receiver, so `<T> List<T>.second` yields `second`.
 */
export function readDeclName(m: string, i: number): { name: string; end: number } | null {
  i = skipSpace(m, i);
  if (m.charCodeAt(i) === LT) {
    i = skipAngles(m, i);
    if (i < 0) return null;
    i = skipSpace(m, i);
  }
  for (;;) {
    if (!isIdentStart(m.charCodeAt(i))) return null;
    const end = identEnd(m, i);
    const name = m.slice(i, end);
    let j = end;
    if (m.charCodeAt(j) === LT) {
      j = skipAngles(m, j);
      if (j < 0) return { name, end };
    }
    if (m.charCodeAt(j) === QUESTION) j++;
    if (m.charCodeAt(j) !== DOT) return { name, end };
    i = j + 1;
  }
}

/** Names picked by a Scala `{A, B => C, _}` selector list whose body starts at `i`, and the index after its `}`. */
function readSelectors(m: string, i: number): [string[], number] {
  const limit = Math.min(m.length, i + MAX_SELECTOR_CHARS);
  let close = i;
  while (close < limit && m.charCodeAt(close) !== RBRACE) close++;
  if (close >= limit) return [[], i];
  const names: string[] = [];
  for (const raw of m.slice(i, close).split(',')) {
    const item = raw.trim();
    const hit = item ? SELECTOR.exec(item) : null;
    if (!hit || hit[2] === '_') continue; // `A => _` hides A
    let name = hit[1];
    if (name === 'given') {
      if (item !== 'given') continue; // `given Ord[Int]` selects by type
      name = '*';
    } else if (name === '_') name = '*';
    if (!names.includes(name)) names.push(name);
  }
  return [names, close + 1];
}

/**
 * Reads the import that follows the keyword at `i`, appends its specs and returns the index after it.
 * Kinds: 'import' and 'static' (Java `import static`). `spec` is the dotted name as written; a
 * wildcard or a Scala selector list leaves the package or type in `spec` and puts '*' or the
 * selected names in `names`. Aliases (`as D`, `D => E`) are dropped: the name is the imported one.
 */
function readImport(m: string, i: number, lang: JvmLang, out: ImportSpec[]): number {
  const java = lang === 'java', scala = lang === 'scala';
  i = skipSpace(m, i, java);
  let kind = 'import';
  if (java && m.startsWith('static', i) && !isIdentChar(m.charCodeAt(i + 6))) {
    kind = 'static';
    i = skipSpace(m, i + 6, true);
  }
  for (let expression = 0; expression < MAX_IMPORT_EXPRESSIONS; expression++) {
    const segs: string[] = [];
    let names: string[] | undefined;
    for (;;) {
      const c = m.charCodeAt(i);
      if (c === STAR) { names = ['*']; i++; break; }
      if (c === LBRACE && scala) { [names, i] = readSelectors(m, i + 1); break; }
      if (c === BACKTICK) {
        const e = identEnd(m, i + 1);
        if (e === i + 1 || m.charCodeAt(e) !== BACKTICK) break;
        segs.push(m.slice(i + 1, e));
        i = e + 1;
      } else {
        const e = identEnd(m, i);
        if (e === i) break;
        segs.push(m.slice(i, e));
        i = e;
      }
      const j = skipSpace(m, i, java);
      if (m.charCodeAt(j) !== DOT) break;
      i = skipSpace(m, j + 1, java);
    }
    if (scala) {
      if (segs[0] === '_root_') segs.shift();
      const last = segs[segs.length - 1];
      if (!names && segs.length > 1 && (last === '_' || last === 'given')) { segs.pop(); names = ['*']; }
    }
    if (segs.length && (!names || names.length)) {
      const spec = segs.join('.');
      out.push(names ? { spec, kind, names } : { spec, kind });
    }
    if (!scala) return i;
    // Scala: `import a.B as C` (alias dropped), then `, c.D` starts another expression.
    let j = skipSpace(m, i);
    if (m.startsWith('as', j) && !isIdentChar(m.charCodeAt(j + 2))) {
      i = identEnd(m, skipSpace(m, j + 2));
      j = skipSpace(m, i);
    }
    if (m.charCodeAt(j) !== COMMA) return i;
    i = skipSpace(m, j + 1, true);
  }
  return i;
}

/** True when the keyword at `at` begins a statement: only blanks separate it from a line start, `;`, `{` or `}`. */
function startsStatement(m: string, at: number): boolean {
  let k = at - 1;
  while (k >= 0 && (m.charCodeAt(k) === 32 || m.charCodeAt(k) === 9)) k--;
  if (k < 0) return true;
  const c = m.charCodeAt(k);
  return c === NL || c === CR || c === SEMI || c === LBRACE || c === RBRACE;
}

function sweep(text: string, lang: JvmLang, imports: ImportSpec[], pkg: string[], classes: Set<string>, members: Set<string>): void {
  const m = maskJvm(text, lang);
  const kotlin = lang === 'kotlin', scala = lang === 'scala';
  const rx = SWEEPS[lang];
  rx.lastIndex = 0;

  let lineStart = 0, nextBreak = m.indexOf('\n');
  const lineStartOf = (at: number): number => {
    while (nextBreak >= 0 && nextBreak < at) { lineStart = nextBreak + 1; nextBreak = m.indexOf('\n', lineStart); }
    return lineStart;
  };
  const isPrivate = (at: number): boolean => PRIVATE.test(m.slice(Math.max(lineStartOf(at), at - MODIFIER_WINDOW), at));

  let depth = 0, paren = 0, bracedPackage = false;
  let hit: RegExpExecArray | null;
  while ((hit = rx.exec(m))) {
    const at = hit.index;
    const c = m.charCodeAt(at);
    if (c === LBRACE) { depth++; continue; }
    if (c === RBRACE) { if (depth > 0) depth--; continue; }
    if (c === LPAREN) { paren++; continue; }
    if (c === RPAREN) { if (paren > 0) paren--; continue; }
    const word = hit[0];
    const end = rx.lastIndex;
    const before = m.charCodeAt(at - 1);
    // Not the keyword: part of a longer name, a member (`x.type`), `Foo::class`, or back-quoted.
    if (isIdentChar(before) || before === DOT || before === COLON || before === BACKTICK || isIdentChar(m.charCodeAt(end))) continue;

    if (word === 'import') {
      // Java and Kotlin import at the top of the file only; Scala imports anywhere.
      if ((!scala && (depth > 0 || paren > 0)) || !startsStatement(m, at)) continue;
      rx.lastIndex = Math.max(end, readImport(m, end, lang, imports));
      continue;
    }
    if (depth > 0 || paren > 0) continue; // everything below is top-level only

    if (word === 'package') {
      const i = skipSpace(m, end);
      let e = i;
      while (isIdentChar(m.charCodeAt(e)) || m.charCodeAt(e) === DOT) e++;
      const name = m.slice(i, e);
      if (!name || (scala && name === 'object')) continue; // `package object x` is recorded by its `object`
      // Scala chains clauses (`package a.b` then `package c` is a.b.c); the others declare one package.
      if (scala || pkg.length === 0) pkg.push(name);
      rx.lastIndex = e;
      if (scala) {
        const j = skipSpace(m, e);
        if (m.charCodeAt(j) === LBRACE) { bracedPackage = true; rx.lastIndex = j + 1; } // `package a { … }` nests nothing
      }
      continue;
    }

    // Scala 3 can nest without braces: there, only a declaration on an unindented line is top-level.
    if (scala && !bracedPackage) {
      const first = m.charCodeAt(lineStartOf(at));
      if (first === 32 || first === 9) continue;
    }

    if (TYPE_WORDS.has(word)) {
      const i = skipSpace(m, end);
      if (!isIdentStart(m.charCodeAt(i))) continue; // `object : Listener { … }`
      const e = identEnd(m, i);
      classes.add(m.slice(i, e));
      rx.lastIndex = e;
    } else if (kotlin) {
      // Top-level functions and properties are imported by name, like types.
      const d = readDeclName(m, end);
      if (!d || (word === 'fun' && m.charCodeAt(skipSpace(m, d.end)) !== LPAREN)) continue; // `fun interface X`
      if (!isPrivate(at)) members.add(d.name);
      rx.lastIndex = d.end;
    } else if (scala) {
      const i = skipSpace(m, end);
      if (!isIdentStart(m.charCodeAt(i))) continue; // `val (a, b) = …`
      const e = identEnd(m, i);
      if (!isPrivate(at)) members.add(m.slice(i, e));
      rx.lastIndex = e;
    }
  }
}

/**
 * Imports and declarations of a Java, Kotlin or Scala source text. `decls` holds `package` (one
 * dotted name), `classes` (top-level type names: class, interface, enum, record, object, trait,
 * type alias) and, for Kotlin and Scala, `members` (top-level functions and properties that are not
 * private). Never throws.
 */
export function scanJvm(text: string, lang: JvmLang): ScanResult {
  const imports: ImportSpec[] = [];
  const pkg: string[] = [];
  const classes = new Set<string>();
  const members = new Set<string>();
  try {
    sweep(text, lang, imports, pkg, classes, members);
  } catch {
    // a scanner must not throw: keep what was read
  }
  const decls: Record<string, string[]> = {};
  if (pkg.length) decls.package = [pkg.join('.')];
  if (classes.size) decls.classes = [...classes];
  if (members.size) decls.members = [...members];
  const result: ScanResult = { imports };
  if (pkg.length || classes.size || members.size) result.decls = decls;
  return result;
}
