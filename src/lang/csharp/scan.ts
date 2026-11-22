// Fast-pass scanner for C# (PLAN.md §6.3). No syntax tree.
//
// One sweep with a small lexer that steps over comments, preprocessor lines, character literals and
// every kind of string (regular, verbatim, interpolated, raw). On top of it a brace tracker knows
// whether the current position is at namespace level, inside a type body, or inside any other block
// (method bodies, accessors, initialisers). `using` directives are read only at namespace level, so
// `using (…)` statements and `using var x = …` declarations are never imports; type keywords are
// read only outside blocks.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

// Token codes. Punctuation is returned as its own character code (always above 32).
const EOF = 0;
const IDENT = 1;
const LITERAL = 2;

// Scope kinds on the brace stack.
const BLOCK = 0;
const NAMESPACE = 1;
const TYPE = 2;

/** Interpolated strings nested deeper than this are read as plain strings (keeps the scanner off the stack limit). */
const MAX_NESTING = 16;
/** A `delegate` header longer than this many tokens is given up on. */
const MAX_DELEGATE_TOKENS = 256;

const isIdentStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isIdentPart = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);

/** `i` is at the opening quote of a raw string (three or more quotes); returns the index after it. */
function skipRaw(s: string, i: number): number {
  let quotes = 3;
  while (s.charCodeAt(i + quotes) === 34) quotes++;
  let j = i + quotes;
  for (;;) {
    const k = s.indexOf('"""', j);
    if (k < 0) return s.length;
    let run = 3;
    while (s.charCodeAt(k + run) === 34) run++;
    if (run >= quotes) return k + run;
    j = k + run;
  }
}

/** `i` is at the opening quote of a regular or raw string; returns the index after it. */
function skipString(s: string, i: number): number {
  if (s.charCodeAt(i + 1) === 34 && s.charCodeAt(i + 2) === 34) return skipRaw(s, i);
  const n = s.length;
  for (let j = i + 1; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) j++;
    else if (c === 34) return j + 1;
    else if (c === 10) return j; // unterminated: stop at the line end
  }
  return n;
}

/** `i` is at the opening quote of a verbatim string (`@"…"`, quotes doubled inside); returns the index after it. */
function skipVerbatim(s: string, i: number): number {
  let j = i + 1;
  for (;;) {
    const k = s.indexOf('"', j);
    if (k < 0) return s.length;
    if (s.charCodeAt(k + 1) !== 34) return k + 1;
    j = k + 2;
  }
}

/** `i` is at an apostrophe; returns the index after the character literal, or `i + 1` when it is not one. */
function skipChar(s: string, i: number): number {
  if (s.charCodeAt(i + 1) === 39) return i + 2;
  let j = s.charCodeAt(i + 1) === 92 ? i + 3 : i + 2;
  const limit = Math.min(s.length, j + 10); // room for '\U0001F600'
  for (; j < limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 39) return j + 1;
    if (c === 10) break;
  }
  return i + 1;
}

/** `i` is just inside an interpolation hole; returns the index after its closing brace. Holes hold code, strings included. */
function skipHole(s: string, i: number, depth: number): number {
  const n = s.length;
  let braces = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 125) {
      j++;
      if (braces === 0) return j;
      braces--;
    } else if (c === 123) { braces++; j++; }
    else if (c === 39) j = skipChar(s, j);
    else if (c === 34 || c === 36 || c === 64) {
      const e = skipStringAt(s, j, depth);
      if (e > j) j = e;
      else { j++; while (c === 36 && s.charCodeAt(j) === 36) j++; }
    } else j++;
  }
  return n;
}

/** `i` is at the opening quote of an interpolated string; returns the index after it. */
function skipInterpolated(s: string, i: number, verbatim: boolean, depth: number): number {
  if (s.charCodeAt(i + 1) === 34 && s.charCodeAt(i + 2) === 34) return skipRaw(s, i); // raw: holes are not followed
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 34) {
      if (verbatim && s.charCodeAt(j + 1) === 34) { j += 2; continue; }
      return j + 1;
    }
    if (c === 92 && !verbatim) { j += 2; continue; }
    if (c === 10 && !verbatim) return j; // unterminated: stop at the line end
    if (c === 123) {
      if (s.charCodeAt(j + 1) === 123) { j += 2; continue; }
      j = skipHole(s, j + 1, depth);
      continue;
    }
    j++;
  }
  return n;
}

/**
 * End of the string literal that starts at `i` — `"…"`, `@"…"`, `$"…"`, `$@"…"`, `@$"…"`, `"""…"""`,
 * `$$"""…"""` — or `i` itself when no string starts there (`@name`, a stray `$`).
 */
function skipStringAt(s: string, i: number, depth: number): number {
  let j = i;
  let dollars = 0;
  let verbatim = false;
  for (;; j++) {
    const c = s.charCodeAt(j);
    if (c === 36) dollars++;
    else if (c === 64 && !verbatim) verbatim = true;
    else break;
  }
  if (s.charCodeAt(j) !== 34) return i;
  if (dollars > 0 && depth < MAX_NESTING) return skipInterpolated(s, j, verbatim, depth + 1);
  return verbatim ? skipVerbatim(s, j) : skipString(s, j);
}

/** Import kinds: a namespace, `using static` of a type, and `using Alias = …` (alias kept in `names`). */
export const USING = 'using';
export const USING_STATIC = 'using-static';
export const USING_ALIAS = 'using-alias';
/** Prefix of the three kinds above when the directive is a `global using`. */
export const GLOBAL_PREFIX = 'global-';

/**
 * Imports and declarations of a C# source text.
 *
 * Imports: `using A.B;` → { spec: 'A.B', kind: 'using' }; `using static A.B.C;` → kind 'using-static';
 * `using X = A.B.C;` → { spec: 'A.B.C', kind: 'using-alias', names: ['X'] }. A `global using` has the
 * same kinds prefixed with 'global-'. `global::` and extern-alias qualifiers are dropped.
 *
 * Decls: `namespace` — every namespace the file declares, fully qualified (block-scoped, nested and
 * file-scoped); `classes` — every class, struct, interface, record, enum and delegate, qualified by
 * its namespace and enclosing types ('A.B.Outer.Inner'; a bare name when it is in the global namespace).
 */
export function scanCSharp(text: string): ScanResult {
  const n = text.length;
  const imports: ImportSpec[] = [];
  const namespaces = new Set<string>();
  const classes = new Set<string>();

  // ---- lexer ----
  let i = 0;
  /** Only blanks since the last newline: a '#' here starts a preprocessor line. */
  let fresh = true;
  let tokStart = 0;
  let tokEnd = 0;
  /** False for an identifier written with '@' (`@class`), which is never a keyword. */
  let tokPlain = true;

  const next = (): number => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c <= 32) { if (c === 10) fresh = true; i++; continue; }
      if (c === 47) {
        const d = text.charCodeAt(i + 1);
        if (d === 47) { const e = text.indexOf('\n', i + 2); i = e < 0 ? n : e; continue; }
        if (d === 42) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      }
      if (c === 35 && fresh) { const e = text.indexOf('\n', i + 1); i = e < 0 ? n : e; continue; }
      fresh = false;
      if (isIdentStart(c)) {
        tokStart = i++;
        while (i < n && isIdentPart(text.charCodeAt(i))) i++;
        tokEnd = i;
        tokPlain = true;
        return IDENT;
      }
      if (c === 34 || c === 36 || c === 64) {
        const e = skipStringAt(text, i, 0);
        if (e > i) { i = e; return LITERAL; }
        if (c === 64 && isIdentStart(text.charCodeAt(i + 1))) {
          tokStart = ++i;
          while (i < n && isIdentPart(text.charCodeAt(i))) i++;
          tokEnd = i;
          tokPlain = false;
          return IDENT;
        }
        i++;
        while (c === 36 && text.charCodeAt(i) === 36) i++;
        return c;
      }
      if (c === 39) {
        const e = skipChar(text, i);
        if (e > i + 1) { i = e; return LITERAL; }
        i++;
        return c;
      }
      if (c >= 48 && c <= 57) {
        i++;
        while (i < n) {
          const d = text.charCodeAt(i);
          if (isIdentPart(d)) i++;
          else if (d === 46 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57) i += 2;
          else break;
        }
        return LITERAL;
      }
      i++;
      return c;
    }
    return EOF;
  };
  const word = (): string => text.slice(tokStart, tokEnd);
  /** Go back to a position recorded just after a token. */
  const rewind = (to: number): void => { i = to; fresh = false; };

  /** Reads `A.B.C` (dropping a leading `alias::`); '' and no movement when no name starts here. */
  const dotted = (): string => {
    let save = i;
    if (next() !== IDENT) { rewind(save); return ''; }
    let name = word();
    for (;;) {
      save = i;
      const t = next();
      if (t === 46 && next() === IDENT) { name += '.' + word(); continue; }
      if (t === 58 && next() === 58 && next() === IDENT) { name = word(); continue; }
      rewind(save);
      return name;
    }
  };

  // ---- scopes ----
  const scopes: number[] = [];
  /** Full namespace of each open namespace block. */
  const nsStack: string[] = [];
  /** Dotted chain of each open type body ('Outer', 'Outer.Inner'). */
  const typeStack: string[] = [];
  let fileNs = '';
  /** Open braces that are neither a namespace nor a type body. */
  let blocks = 0;
  let parens = 0;
  /** A namespace or type header was read and its '{' or ';' has not come yet. */
  let pending = BLOCK;
  let pendingName = '';
  let pendingParens = 0;
  let prev = EOF;

  const currentNs = (): string => (nsStack.length ? nsStack[nsStack.length - 1] : fileNs);
  const declareType = (name: string): void => {
    const chain = typeStack.length ? `${typeStack[typeStack.length - 1]}.${name}` : name;
    const ns = currentNs();
    classes.add(ns ? `${ns}.${chain}` : chain);
    pending = TYPE;
    pendingName = chain;
    pendingParens = parens;
  };

  /** After `using` at namespace level: a directive is pushed, anything else (a declaration, a statement) is left alone. */
  const usingDirective = (prefix: string): void => {
    const save = i;
    let isStatic = false;
    for (;;) {
      const before = i;
      if (next() === IDENT && tokPlain) {
        const w = word();
        if (w === 'static') { isStatic = true; continue; }
        if (w === 'unsafe') continue;
      }
      rewind(before);
      break;
    }
    const name = dotted();
    if (name) {
      const t = next();
      if (t === 59) {
        imports.push({ spec: name, kind: prefix + (isStatic ? USING_STATIC : USING) });
        return;
      }
      if (t === 61 && !isStatic && !name.includes('.')) {
        const target = dotted(); // '' for a tuple or other unnamed type
        if (target) imports.push({ spec: target, kind: prefix + USING_ALIAS, names: [name] });
        return;
      }
    }
    rewind(save);
  };

  /** After `delegate` outside any block: the name is the last identifier before the parameter list. */
  const delegateDeclaration = (): void => {
    const save = i;
    let name = '';
    let angle = 0;
    for (let count = 0; count < MAX_DELEGATE_TOKENS; count++) {
      const before = i;
      const t = next();
      if (t === IDENT) {
        if (tokPlain && tokEnd - tokStart === 8 && word() === 'delegate') break; // never part of a header: keeps the look-ahead linear
        if (angle === 0) name = word();
      } else if (t === 60) angle++;
      else if (t === 62) { if (angle > 0) angle--; }
      else if (t === 40) {
        if (name && angle === 0) { rewind(before); declareType(name); return; }
        for (let depth = 1; depth > 0;) { // a tuple type
          const u = next();
          if (u === EOF) break;
          if (u === 40) depth++;
          else if (u === 41) depth--;
        }
      } else if (t === EOF || t === 59 || t === 123 || t === 125 || t === 61 || (t === 42 && !name)) break; // anonymous method, function pointer
    }
    rewind(save);
  };

  for (;;) {
    const t = next();
    if (t === EOF) break;
    if (t === 123) {
      if (pending !== BLOCK && parens <= pendingParens) {
        if (pending === NAMESPACE) {
          const outer = currentNs();
          const full = outer ? `${outer}.${pendingName}` : pendingName;
          namespaces.add(full);
          nsStack.push(full);
        } else typeStack.push(pendingName);
        scopes.push(pending);
        pending = BLOCK;
      } else {
        scopes.push(BLOCK);
        blocks++;
      }
    } else if (t === 125) {
      const kind = scopes.pop();
      if (kind === BLOCK) blocks--;
      else if (kind === NAMESPACE) nsStack.pop();
      else if (kind === TYPE) typeStack.pop();
    } else if (t === 59) {
      if (pending !== BLOCK && parens <= pendingParens) {
        if (pending === NAMESPACE && scopes.length === 0) { // file-scoped: the rest of the file
          fileNs = pendingName;
          namespaces.add(fileNs);
        }
        pending = BLOCK;
      }
    } else if (t === 40) parens++;
    else if (t === 41) { if (parens > 0) parens--; }
    else if (t === IDENT && tokPlain && blocks === 0 && pending === BLOCK) {
      const len = tokEnd - tokStart;
      if (len >= 4 && len <= 9) {
        switch (word()) {
          case 'using':
            if (typeStack.length === 0) usingDirective('');
            break;
          case 'global':
            if (typeStack.length === 0) {
              const save = i;
              if (next() === IDENT && tokPlain && word() === 'using') usingDirective(GLOBAL_PREFIX);
              else rewind(save);
            }
            break;
          case 'namespace':
            if (typeStack.length === 0) {
              const name = dotted();
              if (name) { pending = NAMESPACE; pendingName = name; pendingParens = parens; }
            }
            break;
          case 'class': case 'struct': case 'interface': case 'enum':
            if (prev !== 58) { // not the `where T : class` constraint
              const save = i;
              if (next() === IDENT) declareType(word());
              else rewind(save);
            }
            break;
          case 'record': { // contextual keyword: `record Name` followed by what a record header allows
            const save = i;
            if (next() !== IDENT) { rewind(save); break; }
            const name = word();
            if (tokPlain && (name === 'struct' || name === 'class')) { rewind(save); break; } // read as that keyword next
            const afterName = i;
            const u = next();
            const header = u === 40 || u === 123 || u === 60 || u === 58 || u === 59 || (u === IDENT && word() === 'where');
            rewind(header ? afterName : save);
            if (header) declareType(name);
            break;
          }
          case 'delegate':
            delegateDeclaration();
            break;
        }
      }
    }
    prev = t;
  }

  if (namespaces.size === 0 && classes.size === 0) return { imports };
  const decls: Record<string, string[]> = {};
  if (namespaces.size) decls.namespace = [...namespaces];
  if (classes.size) decls.classes = [...classes];
  return { imports, decls };
}
