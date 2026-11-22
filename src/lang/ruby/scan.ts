// Fast-pass scanner for Ruby (PLAN.md §6.3). No syntax tree.
//
// One sweep over the text that knows just enough Ruby to stay out of comments, strings, heredocs,
// regex and %-literals. From the code that is left it reads three things:
//   - `require` / `require_relative` / `load` / `autoload` with a literal string argument;
//   - the constants the file defines, fully qualified from the `module` / `class` nesting;
//   - the constant paths the file refers to and does not define (kind 'const'). Autoloaded code
//     (Rails, Zeitwerk) has no requires at all, so these are what its resolver links by name.
//
// Nesting is tracked by indentation, not by counting every keyword that takes an `end`: a `class` or
// `module` closes at the `end` that starts a line at the same indentation (or on the same line).
// Counting keywords needs the full modifier-`if` / `while … do` / endless-`def` rules, and one slip
// there misnames everything below it; indentation recovers at the next definition.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/** Most constant references kept per file, in order of first appearance. */
const MAX_CONST_REFS = 64;
/** Most defined constants kept per file, per decl key. */
const MAX_DECLS = 256;
/** `#{…}` nesting followed inside strings; deeper interpolations are read as plain string text. */
const MAX_INTERPOLATION_DEPTH = 16;
/** Heredoc openers queued on one line. */
const MAX_PENDING_HEREDOCS = 8;
/** Heredoc openers whose terminator is searched for and not found, before the scanner stops looking. */
const MAX_HEREDOC_MISSES = 4;

/** Ruby core constants: never defined by a repo file worth linking to, so not worth a reference. */
const CORE = new Set([
  'Object', 'BasicObject', 'Module', 'Class', 'Kernel', 'Comparable', 'Enumerable', 'Enumerator', 'String', 'Symbol',
  'Integer', 'Float', 'Numeric', 'Rational', 'Complex', 'Array', 'Hash', 'Set', 'Range', 'Regexp', 'MatchData', 'Proc',
  'Method', 'UnboundMethod', 'Struct', 'Data', 'Time', 'File', 'Dir', 'IO', 'Process', 'Signal', 'Thread', 'Mutex',
  'Queue', 'Fiber', 'Ractor', 'Random', 'Math', 'GC', 'ObjectSpace', 'Marshal', 'Encoding', 'Binding', 'Warning',
  'NilClass', 'TrueClass', 'FalseClass', 'Exception', 'StandardError', 'RuntimeError', 'ArgumentError', 'TypeError',
  'NameError', 'NoMethodError', 'KeyError', 'IndexError', 'RangeError', 'IOError', 'EOFError', 'NotImplementedError',
  'ScriptError', 'LoadError', 'SyntaxError', 'SystemExit', 'Interrupt', 'SignalException', 'StopIteration',
  'ZeroDivisionError', 'FloatDomainError', 'FrozenError', 'SecurityError', 'SystemCallError', 'SystemStackError',
  'NoMemoryError', 'LocalJumpError', 'ThreadError', 'FiberError', 'EncodingError', 'RegexpError', 'UncaughtThrowError',
  'NoMatchingPatternError', 'Errno', 'ENV', 'ARGV', 'ARGF', 'DATA', 'STDIN', 'STDOUT', 'STDERR', 'RUBY_VERSION',
  'RUBY_PLATFORM', 'RUBY_ENGINE', 'TOPLEVEL_BINDING',
]);

/** Keywords an operand follows, so a `/` or `%` after one opens a literal. */
const OPERAND_KEYWORDS = new Set([
  'if', 'unless', 'while', 'until', 'and', 'or', 'not', 'then', 'else', 'elsif', 'when', 'case', 'in', 'return', 'do',
  'begin', 'rescue', 'ensure', 'for', 'next', 'break',
]);

const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isIdentStart = (c: number): boolean => isLower(c) || isUpper(c) || c === 95 || c >= 128;
const isIdentChar = (c: number): boolean => isIdentStart(c) || isDigit(c);
/** Space, tab, carriage return, form feed: whitespace that does not end the line. */
const isBlank = (c: number): boolean => c === 32 || c === 9 || c === 13 || c === 12;
const isPunct = (c: number): boolean => c > 32 && c < 127 && !isLower(c) && !isUpper(c) && !isDigit(c);
/** Characters of an operator method name: `def <=>(other)`, `def []=(k, v)`, `` def `(cmd) ``, `def +@`. */
const isOperatorChar = (c: number): boolean =>
  c === 43 || c === 45 || c === 42 || c === 47 || c === 37 || c === 60 || c === 62 || c === 61 || c === 33
  || c === 126 || c === 94 || c === 38 || c === 124 || c === 91 || c === 93 || c === 96 || c === 64;

function identEnd(s: string, i: number): number {
  while (isIdentChar(s.charCodeAt(i))) i++;
  return i;
}
function blankEnd(s: string, i: number): number {
  while (isBlank(s.charCodeAt(i))) i++;
  return i;
}
/** End of the constant path that starts at `i`: `A`, `A::B::C`. */
function pathEnd(s: string, i: number): number {
  let e = identEnd(s, i);
  while (s.charCodeAt(e) === 58 && s.charCodeAt(e + 1) === 58 && isUpper(s.charCodeAt(e + 2))) e = identEnd(s, e + 2);
  return e;
}

/** Index past the single-quoted string that opens at `i`. */
function skipSingle(s: string, i: number): number {
  const n = s.length;
  for (i++; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) i++;
    else if (c === 39) return i + 1;
  }
  return n;
}
/** Index past the double-quoted or backtick string that opens at `i`, following `#{…}`. */
function skipInterpolated(s: string, i: number, close: number, depth: number): number {
  const n = s.length;
  for (i++; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) i++;
    else if (c === close) return i + 1;
    else if (c === 35 && s.charCodeAt(i + 1) === 123 && depth < MAX_INTERPOLATION_DEPTH) i = skipInterpolation(s, i + 2, depth + 1) - 1;
  }
  return n;
}
/** Index past the `}` that closes the interpolation whose code starts at `i`. */
function skipInterpolation(s: string, i: number, depth: number): number {
  const n = s.length;
  let braces = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 123) braces++;
    else if (c === 125) { if (braces === 0) return i + 1; braces--; }
    else if (c === 39) i = skipSingle(s, i) - 1;
    else if (c === 34 || c === 96) i = skipInterpolated(s, i, c, depth) - 1;
    else if (c === 92) i++;
  }
  return n;
}
/** Index past the regex literal that opens at `i`, flags included; -1 when no `/` closes it before `limit`. */
function regexEnd(s: string, i: number, limit: number): number {
  for (i++; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) i++;
    else if (c === 47) { i++; while (isLower(s.charCodeAt(i))) i++; return i; }
    else if (c === 35 && s.charCodeAt(i + 1) === 123) i = skipInterpolation(s, i + 2, 1) - 1;
  }
  return -1;
}
/** Index past the %-literal whose delimiter is at `i` (bracket delimiters nest); -1 when unclosed before `limit`. */
function percentEnd(s: string, i: number, limit: number): number {
  const open = s.charCodeAt(i);
  const close = open === 40 ? 41 : open === 91 ? 93 : open === 123 ? 125 : open === 60 ? 62 : open;
  let depth = 0;
  for (i++; i < limit; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) i++;
    else if (c === close) { if (depth === 0) return i + 1; depth--; }
    else if (c === open) depth++;
  }
  return -1;
}
/** Index past the quoted literal at `i`, or -1 when it is not a plain one-line string (escapes, `#{…}`). */
function literalEnd(s: string, i: number): number {
  const q = s.charCodeAt(i);
  if (q !== 34 && q !== 39) return -1;
  for (let e = i + 1; e < s.length; e++) {
    const c = s.charCodeAt(e);
    if (c === q) return e + 1;
    if (c === 10 || c === 92 || (c === 35 && q === 34 && s.charCodeAt(e + 1) === 123)) return -1;
  }
  return -1;
}

interface Heredoc { id: string; indented: boolean; end: number }
/**
 * The heredoc opener whose text after `<<` starts at `j`: `~EOS`, `-EOS`, `EOS`, `~'EOS'`, …
 * `operand` says an operand is due here, where `<<` cannot be the shift operator.
 */
function heredocAt(s: string, j: number, operand: boolean): Heredoc | null {
  let indented = false;
  const flag = s.charCodeAt(j);
  if (flag === 126 || flag === 45) { indented = true; j++; }
  const q = s.charCodeAt(j);
  if (q === 34 || q === 39 || q === 96) {
    for (let e = j + 1; e < s.length; e++) {
      const c = s.charCodeAt(e);
      if (c === 10) return null;
      if (c === q) return e > j + 1 ? { id: s.slice(j + 1, e), indented, end: e + 1 } : null;
    }
    return null;
  }
  // A bare terminator is upper-case by convention; reading `a <<b` as a heredoc is not worth the risk.
  if (!isIdentStart(q) || !(indented || operand || isUpper(q) || q === 95)) return null;
  const e = identEnd(s, j);
  return { id: s.slice(j, e), indented, end: e };
}
/** Start of the line after the heredoc terminator `id`, searching whole lines from `from`; -1 when absent. */
function heredocBodyEnd(s: string, from: number, id: string, indented: boolean): number {
  const n = s.length;
  for (let p = from; p < n;) {
    const q = indented ? blankEnd(s, p) : p;
    if (s.startsWith(id, q)) {
      let e = q + id.length;
      if (s.charCodeAt(e) === 13) e++;
      if (e >= n) return n;
      if (s.charCodeAt(e) === 10) return e + 1;
    }
    const nl = s.indexOf('\n', q);
    if (nl < 0) break;
    p = nl + 1;
  }
  return -1;
}

/** Index past the method name that follows `def` (which ends at `e`): `foo`, `self.foo?`, `Const.bar`, `<=>`, `[]=`. */
function defNameEnd(s: string, e: number): number {
  let j = blankEnd(s, e);
  if (j === e) return e;
  for (;;) {
    if (!isIdentStart(s.charCodeAt(j))) {
      while (isOperatorChar(s.charCodeAt(j))) j++;
      return j;
    }
    j = identEnd(s, j);
    const t = s.charCodeAt(j);
    if (t === 46) { j++; continue; }
    if (t === 58 && s.charCodeAt(j + 1) === 58) { j += 2; continue; }
    if (t === 63 || t === 33 || (t === 61 && s.charCodeAt(j + 1) === 40)) j++;
    return j;
  }
}

/** A `class` / `module` that is still open. */
interface Frame {
  /** Indentation of the line that opened it. */
  indent: number;
  /** Start index of that line, to recognise `class Foo < Bar; end`. */
  lineStart: number;
  /** Fully-qualified name of the namespace inside it. */
  name: string;
}

interface Found {
  imports: ImportSpec[];
  classes: Set<string>;
  constants: Set<string>;
  refs: Set<string>;
}

function sweep(s: string, found: Found): void {
  const n = s.length;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let lineStart = i;
  let lineIndent = 0;
  let atLineStart = true;   // no token on this line yet
  let blank = true;         // whitespace precedes the current character
  let prevValue = false;    // the previous token can end an expression, so `/`, `%`, `<<`, `?` after it are operators
  let prevWord = false;     // … and is a plain identifier, which may be a method name taking an argument
  let prevDot = false;      // the previous token is `.` or `&.`
  let scope = 0;            // the previous token is `::` — 1 at the start of a path (`::Foo`), 2 after an expression (`x::Foo`)
  let noGuessBefore = 0;    // no more `puts /re/`-style guesses before this index, after one failed on the line
  let regexGone = false;    // an operand-position `/` found no closing `/` in the rest of the text
  let percentGone = false;  // the same for a %-literal
  let heredocMisses = 0;
  const pending: Heredoc[] = [];
  const frames: Frame[] = [];

  const namespace = (): string => (frames.length ? frames[frames.length - 1].name : '');
  let eol = -1;
  /** Index of the newline that ends the line `from` is on. Remembered, so asking again on one long line stays cheap. */
  const lineEnd = (from: number): number => {
    if (eol < from) { const nl = s.indexOf('\n', from); eol = nl < 0 ? n : nl; }
    return eol;
  };

  /** `require 'x'` and friends, the keyword ending at `e`. Returns the index past the statement's string, or -1. */
  const readRequire = (word: string, e: number): number => {
    let j = blankEnd(s, e);
    if (s.charCodeAt(j) === 40) j = blankEnd(s, j + 1);
    let constant = '';
    if (word === 'autoload') {
      if (s.charCodeAt(j) !== 58 || !isUpper(s.charCodeAt(j + 1))) return -1;
      const ne = identEnd(s, j + 1);
      constant = s.slice(j + 1, ne);
      j = blankEnd(s, ne);
      if (s.charCodeAt(j) !== 44) return -1;
      j = blankEnd(s, j + 1);
    }
    const end = literalEnd(s, j);
    if (end < 0 || end - j < 3) return -1;
    const spec = s.slice(j + 1, end - 1);
    if (constant) found.imports.push({ spec, kind: 'autoload', names: [constant] });
    else found.imports.push({ spec, kind: word === 'require_dependency' ? 'require' : word });
    return end;
  };

  /** `class X`, `class << self`, `module X`, the keyword ending at `e`. Returns the index past the name, or -1. */
  const readDefinition = (isClass: boolean, e: number): number => {
    let j = blankEnd(s, e);
    if (j === e) return -1;
    if (isClass && s.charCodeAt(j) === 60 && s.charCodeAt(j + 1) === 60) {
      frames.push({ indent: lineIndent, lineStart, name: namespace() });
      return j + 2;
    }
    const absolute = s.charCodeAt(j) === 58 && s.charCodeAt(j + 1) === 58;
    if (absolute) j += 2;
    if (!isUpper(s.charCodeAt(j))) return -1;
    const end = pathEnd(s, j);
    const outer = absolute ? '' : namespace();
    const name = outer ? `${outer}::${s.slice(j, end)}` : s.slice(j, end);
    frames.push({ indent: lineIndent, lineStart, name });
    if (found.classes.size < MAX_DECLS) found.classes.add(name);
    return end;
  };

  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      i++;
      if (pending.length) {
        for (const h of pending) {
          if (heredocMisses >= MAX_HEREDOC_MISSES) break;
          const after = heredocBodyEnd(s, i, h.id, h.indented);
          if (after < 0) heredocMisses++; else i = after;
        }
        pending.length = 0;
      }
      lineStart = i; atLineStart = true; blank = true; prevValue = false; prevWord = false; scope = 0;
      continue;
    }
    if (isBlank(c)) { i++; blank = true; continue; }
    if (c === 35) { i = lineEnd(i); continue; }
    if (atLineStart && i === lineStart) {
      if (c === 61 && s.startsWith('=begin', i) && !isIdentChar(s.charCodeAt(i + 6))) {
        const close = s.indexOf('\n=end', i);
        if (close < 0) return;
        i = lineEnd(close + 1);
        continue;
      }
      if (c === 95 && s.startsWith('__END__', i)) {
        const after = s.charCodeAt(i + 7);
        if (i + 7 >= n || after === 10 || after === 13) return;
      }
    }

    const first = atLineStart, spaced = blank, dotted = prevDot, scoped = scope, wasValue = prevValue, wasWord = prevWord;
    if (first) lineIndent = i - lineStart;
    atLineStart = false; blank = false; prevDot = false; scope = 0; prevValue = false; prevWord = false;

    if (isIdentStart(c)) {
      let e = identEnd(s, i);
      if (dotted || scoped === 2) { // a method name (`x.class`, `Foo::bar`) or a constant looked up at run time (`x::Foo`)
        const t = s.charCodeAt(e);
        if ((t === 63 || t === 33) && s.charCodeAt(e + 1) !== 61) e++;
        i = e; prevValue = true; prevWord = !isUpper(c);
        continue;
      }

      if (isUpper(c)) {
        if (s.charCodeAt(e) === 40) { i = e; prevValue = true; continue; } // Integer(x): a method call
        const headEnd = e;
        while (s.charCodeAt(e) === 58 && s.charCodeAt(e + 1) === 58 && isUpper(s.charCodeAt(e + 2))) {
          const next = identEnd(s, e + 2);
          if (s.charCodeAt(next) === 40) break; // Nokogiri::HTML(x): a method call on the path so far
          e = next;
        }
        if (e === headEnd && s.charCodeAt(e) === 58 && s.charCodeAt(e + 1) !== 58) { i = e + 1; continue; } // `Key: value`
        const k = blankEnd(s, e);
        const a = s.charCodeAt(k), b = s.charCodeAt(k + 1);
        const assigned = (a === 61 && b !== 61 && b !== 126 && b !== 62) || (a === 124 && b === 124 && s.charCodeAt(k + 2) === 61);
        const path = s.slice(i, e);
        if (assigned && scoped === 0) {
          const outer = namespace();
          if (found.constants.size < MAX_DECLS) found.constants.add(outer ? `${outer}::${path}` : path);
        } else if (found.refs.size < MAX_CONST_REFS * 4 && !CORE.has(e === headEnd ? path : s.slice(i, headEnd))) {
          found.refs.add(scoped === 1 ? `::${path}` : path);
        }
        i = e; prevValue = true;
        continue;
      }

      const t = s.charCodeAt(e);
      if (t === 58 && s.charCodeAt(e + 1) !== 58) { i = e + 1; continue; } // `key: value`, including `class:` and `if:`
      if ((t === 63 || t === 33) && s.charCodeAt(e + 1) !== 61) e++;
      const word = s.slice(i, e);
      switch (word) {
        case 'require': case 'require_relative': case 'require_dependency': case 'load': case 'autoload': {
          const end = readRequire(word, e);
          if (end >= 0) { i = end; prevValue = true; continue; }
          break;
        }
        case 'class': case 'module': {
          const end = readDefinition(word === 'class', e);
          if (end >= 0) { i = end; prevValue = true; continue; }
          break;
        }
        case 'def':
          i = defNameEnd(s, e); prevValue = true;
          continue;
        case 'end':
          if (first) {
            while (frames.length && frames[frames.length - 1].indent > lineIndent) frames.pop();
            if (frames.length && frames[frames.length - 1].indent === lineIndent) frames.pop();
          } else if (frames.length && frames[frames.length - 1].lineStart === lineStart) frames.pop();
          i = e; prevValue = true;
          continue;
        case 'self': case 'true': case 'false': case 'nil':
          i = e; prevValue = true;
          continue;
      }
      i = e;
      if (!OPERAND_KEYWORDS.has(word)) { prevValue = true; prevWord = true; }
      continue;
    }

    switch (c) {
      case 39: // '
        i = skipSingle(s, i); prevValue = true;
        continue;
      case 34: case 96: // " `
        i = skipInterpolated(s, i, c, 0); prevValue = true;
        continue;
      case 47: { // '/': a regex where an operand is due, or after a method name as in `match /re/`
        const next = s.charCodeAt(i + 1);
        const guess = wasWord && spaced && i >= noGuessBefore && !isBlank(next) && next !== 10 && next !== 61;
        if (wasValue ? guess : !regexGone) {
          const limit = wasValue ? lineEnd(i) : n;
          const end = regexEnd(s, i, limit);
          if (end >= 0) { i = end; prevValue = true; continue; }
          if (wasValue) noGuessBefore = limit; else regexGone = true;
        }
        i++;
        continue;
      }
      case 37: { // '%': %w[…] %i(…) %q{…} %r{…} %(…), on the same terms as a regex
        let j = i + 1;
        const type = s.charCodeAt(j);
        const typed = type === 113 || type === 81 || type === 119 || type === 87 || type === 105 || type === 73 || type === 114 || type === 115 || type === 120;
        if (typed) j++;
        const d = s.charCodeAt(j);
        const opens = typed ? isPunct(d) : d === 40 || d === 91 || d === 123 || d === 60 || d === 124 || d === 33;
        if (opens && (wasValue ? wasWord && spaced && i >= noGuessBefore : !percentGone)) {
          const limit = wasValue ? lineEnd(i) : n;
          let end = percentEnd(s, j, limit);
          if (end >= 0) {
            if (type === 114) while (isLower(s.charCodeAt(end))) end++;
            i = end; prevValue = true;
            continue;
          }
          if (wasValue) noGuessBefore = limit; else percentGone = true;
        }
        i++;
        continue;
      }
      case 60: { // '<': a heredoc opener after `<<`
        if (s.charCodeAt(i + 1) !== 60) { i++; continue; }
        const h = heredocAt(s, i + 2, !wasValue);
        if (h && (h.indented || !wasValue || spaced) && pending.length < MAX_PENDING_HEREDOCS) {
          pending.push(h);
          i = h.end; prevValue = true;
          continue;
        }
        i += 2;
        continue;
      }
      case 58: { // ':': `::`, a symbol, or punctuation
        const d = s.charCodeAt(i + 1);
        if (d === 58) { scope = wasValue && !spaced ? 2 : 1; i += 2; continue; }
        if (isIdentStart(d)) {
          let e = identEnd(s, i + 1);
          const t = s.charCodeAt(e);
          if (t === 63 || t === 33) e++;
          i = e; prevValue = true;
          continue;
        }
        i++; // `:"quoted symbol"` is read as a string on the next turn
        continue;
      }
      case 63: { // '?': a character literal (`?a`, `?\n`) where an operand is due, else the ternary
        const d = s.charCodeAt(i + 1);
        if (!wasValue && d > 32) { i += d === 92 ? 3 : 2; prevValue = true; continue; }
        i++;
        continue;
      }
      case 36: { // '$': a global, including `$'`, `$"` and `` $` ``
        const d = s.charCodeAt(i + 1);
        i = isIdentStart(d) ? identEnd(s, i + 1) : d > 32 ? i + 2 : i + 1;
        prevValue = true;
        continue;
      }
      case 64: { // '@'
        const j = s.charCodeAt(i + 1) === 64 ? i + 2 : i + 1;
        i = identEnd(s, j); prevValue = true;
        continue;
      }
      case 46: // '.'
        if (s.charCodeAt(i + 1) === 46) { while (s.charCodeAt(i) === 46) i++; } else { i++; prevDot = true; }
        continue;
      case 41: case 93: case 125: // ) ] }
        i++; prevValue = true;
        continue;
    }
    if (isDigit(c)) {
      i = identEnd(s, i);
      if (s.charCodeAt(i) === 46 && isDigit(s.charCodeAt(i + 1))) i = identEnd(s, i + 1);
      prevValue = true;
      continue;
    }
    i++;
  }
}

/**
 * Imports and declarations of a Ruby source text.
 *
 * Import kinds: 'require', 'require_relative', 'load', 'autoload' (the constant in `names`) — literal
 * string arguments only — then 'const': each distinct constant path the code refers to and the file
 * does not define, as written (`UserMailer`, `Admin::UsersController`; `::Foo` when written absolute).
 *
 * decls: `classes` are the modules and classes the file defines, fully qualified from the nesting
 * (`module A; class B` → 'A', 'A::B'); `constants` are the other constants it assigns ('A::B::LIMIT').
 */
export function scanRuby(text: string): ScanResult {
  const found: Found = { imports: [], classes: new Set(), constants: new Set(), refs: new Set() };
  try { sweep(text, found); } catch { /* keep what was read: scan must never throw */ }

  // A reference the file can satisfy itself is not an import: `B` or `A::B` when it defines `A::B`.
  const own = new Set<string>();
  const ownTails = new Set<string>();
  for (const name of [...found.classes, ...found.constants]) {
    own.add(name);
    for (let at = name.indexOf('::'); at >= 0; at = name.indexOf('::', at + 2)) ownTails.add(name.slice(at + 2));
  }
  const imports = found.imports;
  let kept = 0;
  for (const ref of found.refs) {
    if (kept >= MAX_CONST_REFS) break;
    if (ref.startsWith('::') ? own.has(ref.slice(2)) : own.has(ref) || ownTails.has(ref)) continue;
    imports.push({ spec: ref, kind: 'const' });
    kept++;
  }

  const decls: Record<string, string[]> = {};
  if (found.classes.size) decls.classes = [...found.classes];
  if (found.constants.size) decls.constants = [...found.constants];
  return found.classes.size || found.constants.size ? { imports, decls } : { imports };
}
