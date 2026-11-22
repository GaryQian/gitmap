// Slow pass for Objective-C without a grammar (LanguagePlugin.extractSymbols): definitions and
// references read from the text after comments, string contents and preprocessor lines are blanked.
// Brackets are matched once, so every later step is a jump and the whole pass stays linear.
//
// Naming: a method is named by the first keyword of its selector (`initWithTitle:duration:` is
// 'initWithTitle'), in definitions and in message sends alike. The full selector is kept in the
// definition's `signature`.
//
// The pass is conservative: where the text is ambiguous it reports nothing.
import type { RefKind, SymbolDef, SymbolKind, SymbolRef } from '../../contracts/lang';
import { blankComments } from './scan';

const SIGNATURE_CHARS = 200;
const DOC_CHARS = 300;
const DOC_LINES = 40;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isIdStart = (c: number) => isUpper(c) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdChar = (c: number) => isIdStart(c) || isDigit(c);

/** Spaces for [a, b) of `s`, keeping its newlines so offsets and line numbers hold. */
function spaces(s: string, a: number, b: number): string {
  const part = s.slice(a, b);
  return part.indexOf('\n') < 0 ? ' '.repeat(b - a) : part.replace(/[^\n]/g, ' ');
}

/**
 * Same-length copy of `text` with comments, the contents of string and character literals, and
 * preprocessor lines replaced by spaces. Quotes stay, so `@"..."` is still recognisable as a literal.
 */
export function blankNonCode(text: string): string {
  const s = blankComments(text);
  const n = s.length;
  const parts: string[] = [];
  let from = 0;
  let i = 0;
  let lineStart = true; // only white space since the last newline
  const blank = (a: number, b: number) => {
    if (b <= a) return;
    parts.push(s.slice(from, a), spaces(s, a, b));
    from = b;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 10) { lineStart = true; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    if (c === 35 && lineStart) { // a directive runs to the line end, through backslash continuations
      const a = i;
      while (i < n && s.charCodeAt(i) !== 10) {
        if (s.charCodeAt(i) === 92) {
          if (s.charCodeAt(i + 1) === 10) i++;
          else if (s.charCodeAt(i + 1) === 13 && s.charCodeAt(i + 2) === 10) i += 2;
        }
        i++;
      }
      blank(a, Math.min(i, n));
      continue;
    }
    lineStart = false;
    if (c === 34 || c === 39) { // string or character literal; ends at the line end if unterminated
      const a = ++i;
      while (i < n) {
        const e = s.charCodeAt(i);
        if (e === 92) { i += 2; continue; }
        if (e === c || e === 10) break;
        i++;
      }
      blank(a, Math.min(i, n));
      if (i < n && s.charCodeAt(i) === c) i++;
      continue;
    }
    i++;
  }
  if (from === 0) return s;
  parts.push(s.slice(from));
  return parts.join('');
}

const BRACKET_KIND = (c: number) => (c === 40 ? 0 : c === 91 ? 1 : c === 123 ? 2 : c === 41 ? 3 : c === 93 ? 4 : c === 125 ? 5 : -1);

/**
 * For each bracket of `s`, the index of its partner, or -1. A closing bracket with no opener of its
 * kind is ignored; openers it skips over stay unmatched.
 */
function matchBrackets(s: string): Int32Array {
  const n = s.length;
  const match = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const open = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c !== 40 && c !== 41 && c !== 91 && c !== 93 && c !== 123 && c !== 125) continue;
    const kind = BRACKET_KIND(c);
    if (kind < 3) { stack.push(i); open[kind]++; continue; }
    const want = kind - 3;
    if (open[want] === 0) continue;
    for (;;) {
      const j = stack.pop()!;
      const k = BRACKET_KIND(s.charCodeAt(j));
      open[k]--;
      if (k === want) { match[j] = i; match[i] = j; break; }
    }
  }
  return match;
}

// Words that can stand before `(` without being a call, and type words that open a declarator or a cast.
const NOT_CALLABLE = new Set([
  'if', 'for', 'while', 'switch', 'return', 'case', 'do', 'else', 'catch', 'sizeof', 'typeof', '__typeof', '__typeof__',
  'alignof', '_Alignof', '__alignof__', 'alignas', 'decltype', 'defined', 'new', 'delete', 'throw', 'noexcept',
  'static_assert', '_Static_assert', 'operator', 'template', 'typename', 'using', 'namespace', 'struct', 'union', 'enum', 'class',
  'void', 'int', 'char', 'short', 'long', 'float', 'double', 'bool', 'unsigned', 'signed', 'auto', 'const', 'static', 'BOOL', 'id',
  '__attribute__', '__declspec', '__bridge', '__bridge_transfer', '__bridge_retained',
]);
/** Words after which `name(` is still an expression. After any other word it is a declaration (`Type name(...)`). */
const EXPRESSION_WORDS = new Set(['return', 'else', 'case', 'do', 'in', 'throw', 'goto', 'co_return', 'co_yield', 'co_await']);
/** Words that may stand directly before the type of a declaration. */
const SPECIFIERS = new Set([
  'const', 'static', 'extern', 'inline', 'volatile', 'register', 'typedef', 'struct',
  '__weak', '__strong', '__block', '__unsafe_unretained', '__autoreleasing', '__kindof',
  'nullable', 'nonnull', 'null_unspecified', '_Nullable', '_Nonnull', 'IBOutlet', 'IBInspectable',
  'public', 'private', 'protected', 'package', 'required', 'optional',
]);
/** NSObject basics that are sent everywhere and defined nowhere in a repo. */
const RUNTIME_SELECTORS = new Set([
  'alloc', 'allocWithZone', 'class', 'superclass', 'self', 'retain', 'release', 'autorelease',
  'respondsToSelector', 'isKindOfClass', 'isMemberOfClass', 'conformsToProtocol',
]);
/** A name before `(` that is an attribute or a macro, not the function being defined. */
const ATTRIBUTE_NAME = /^(?:__\w+|[A-Z][A-Z0-9_]*)$/;
/** A statement ending in `namespace x`, `namespace` or `extern "C"`: its block's contents are still file level. */
const FILE_LEVEL_BLOCK = /(?:^|\s)(?:namespace(?:\s+[\w:]+)?|extern\s*"\s*")\s*$/;
const ANONYMOUS_NAMESPACE = /(?:^|\s)namespace\s*$/;
/** At a `(`: a block or function-pointer declarator, `(^name)(` or `(*name)(`. */
const DECLARATOR = /\(\s*[*^]\s*(?:_Nullable\s+|_Nonnull\s+|__\w+\s+)?\w*\s*\)\s*\(/y;
/** At a `[`: `[Class alloc]`. */
const ALLOC = /\[\s*([A-Z]\w*)\s+alloc\s*\]/y;

const collapse = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SIGNATURE_CHARS ? t.slice(0, SIGNATURE_CHARS).trimEnd() + ' …' : t;
};

/** The comment directly above 1-based `line` of the original text, without its markers. */
function docAbove(lines: string[], line: number): string | undefined {
  let k = line - 2;
  if (k < 0) return undefined;
  const collected: string[] = [];
  const last = lines[k].trim();
  if (last.endsWith('*/')) {
    let opened = false;
    for (let steps = 0; k >= 0 && steps < DOC_LINES && !opened; k--, steps++) {
      const t = lines[k].trim();
      collected.push(t);
      opened = t.startsWith('/*');
    }
    if (!opened) return undefined;
  } else if (last.startsWith('//')) {
    for (let steps = 0; k >= 0 && steps < DOC_LINES; k--, steps++) {
      const t = lines[k].trim();
      if (!t.startsWith('//')) break;
      collected.push(t);
    }
  } else return undefined;
  const doc = collected
    .reverse()
    .map((t) => t.replace(/^\/\*[*!]?/, '').replace(/\*\/$/, '').replace(/^\/\/[/!]?/, '').replace(/^\*+/, '').trim())
    .filter((t) => t && !t.startsWith('MARK:'))
    .join(' ');
  if (!doc) return undefined;
  return doc.length > DOC_CHARS ? doc.slice(0, DOC_CHARS).trimEnd() + ' …' : doc;
}

/**
 * Definitions and references of one Objective-C or Objective-C++ source file.
 *
 * Definitions: classes (`@implementation Name`, `@interface Name` that is not a category), protocols
 * (kind 'interface'), methods with a body inside `@implementation` (container = the class), and C
 * functions with a body at file level.
 *
 * References: message sends as 'call' named by the selector's first keyword, with the receiver as
 * `qualifier` when it is a class name (`[Track alloc]`, and `[[Track alloc] initWithTitle:…]` for the
 * init that follows, and the superclass for `[super name]` when the file names it, which is otherwise
 * dropped); the class of such a receiver as 'reference'; pointer declarations (`Track *t`,
 * `NSArray<Track *> *`) and `id<Proto>` as 'type'; superclass and adopted protocols as 'inherit';
 * plain C calls `name(` inside bodies as 'call'. Member calls (`a.b()`, `a->b()`) count only in `.mm`.
 */
export function extractObjcSymbols(text: string, path = ''): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const s = blankNonCode(text);
  const n = s.length;
  const match = matchBrackets(s);
  const cxx = /\.mm$/i.test(path);

  const defs: SymbolDef[] = [];
  const refs = new Map<string, SymbolRef>();
  const addRef = (name: string, kind: RefKind, qualifier?: string) => {
    const key = `${kind}\n${name}\n${qualifier ?? ''}`;
    const hit = refs.get(key);
    if (hit) hit.count++;
    else refs.set(key, qualifier ? { name, kind, count: 1, qualifier } : { name, kind, count: 1 });
  };

  // ---- small readers over the blanked text ----
  const skipSpace = (i: number) => { while (i < n && isSpace(s.charCodeAt(i))) i++; return i; };
  /** Index of the last non-space character before `i`, or -1. */
  const before = (i: number) => { i--; while (i >= 0 && isSpace(s.charCodeAt(i))) i--; return i; };
  /** End of the identifier starting at `i` (`i` itself when there is none). */
  const identEnd = (i: number) => { if (!isIdStart(s.charCodeAt(i))) return i; i++; while (i < n && isIdChar(s.charCodeAt(i))) i++; return i; };
  /** Start of the identifier ending just before `e` (`e` itself when there is none). */
  const identStart = (e: number) => { let b = e; while (b > 0 && isIdChar(s.charCodeAt(b - 1))) b--; return b < e && isIdStart(s.charCodeAt(b)) ? b : e; };
  /** After the bracket group opening at `i`, or -1 when it never closes. */
  const groupEnd = (i: number) => (match[i] < 0 ? -1 : match[i] + 1);

  // Definitions are found in text order, so line numbers come from one forward sweep.
  let linePos = 0;
  let lineNo = 1;
  const lineAt = (pos: number) => {
    for (; linePos < pos; linePos++) if (s.charCodeAt(linePos) === 10) lineNo++;
    return lineNo;
  };
  const define = (name: string, kind: SymbolKind, at: number, signature: string, more?: Partial<SymbolDef>) => {
    defs.push({ name, kind, line: lineAt(at), ...more, signature: collapse(signature) });
  };

  /** `<A, B>` at `i` as a list of plain names, with the index after it; null when it is not such a list. */
  const nameList = (i: number): { names: string[]; end: number } | null => {
    if (s.charCodeAt(i) !== 60) return null;
    let e = i + 1;
    for (let depth = 1; e < n; e++) {
      const c = s.charCodeAt(e);
      if (c === 60) depth++;
      else if (c === 62) { if (--depth === 0) break; } else if (c === 59 || c === 123 || c === 125 || c === 64 || c === 40) return null;
    }
    if (e >= n) return null;
    const names = s.slice(i + 1, e).split(',').map((t) => t.trim());
    return { names: names.every((t) => /^[A-Za-z_]\w*$/.test(t)) ? names : [], end: e + 1 };
  };

  // ---- pass 1: file-level structure (definitions, inheritance, where the bodies are) ----
  /** Top-level `{...}` blocks other than namespaces and ivar lists, as [open, close] pairs in order. */
  const bodies: number[] = [];
  /** The class whose @implementation each body sits in, by body. */
  const bodyOwner: (string | null)[] = [];
  const superclassOf = new Map<string, string>();
  let container: { name: string; implementation: boolean } | null = null;
  const classesDefined = new Set<string>();
  const fileLevelBlocks: number[] = []; // 1 for an anonymous namespace
  let anonymous = 0;

  /** `@interface` / `@implementation` at `at`, with the keyword ending at `i`. Returns where the header ends. */
  const classHeader = (at: number, i: number, implementation: boolean): number => {
    let j = skipSpace(i);
    const nameEnd = identEnd(j);
    if (nameEnd === j) return i;
    const name = s.slice(j, nameEnd);
    j = skipSpace(nameEnd);
    // `<...>` straight after the name is a generic parameter list unless nothing but protocols follows.
    let protocols: string[] = [];
    const first = nameList(j);
    if (first) { protocols = first.names; j = skipSpace(first.end); }
    let category: string | null = null;
    if (s.charCodeAt(j) === 40 && match[j] > 0) {
      category = s.slice(j + 1, match[j]).trim();
      protocols = [];
      j = skipSpace(match[j] + 1);
    }
    let superclass = '';
    if (s.charCodeAt(j) === 58 && s.charCodeAt(j + 1) !== 58) {
      const a = skipSpace(j + 1);
      const e = identEnd(a);
      if (e > a) { superclass = s.slice(a, e); protocols = []; j = e; }
    }
    const adopted = nameList(skipSpace(j));
    if (adopted) { protocols = adopted.names; j = adopted.end; }
    const headerEnd = j;
    const ivars = skipSpace(j);
    if (s.charCodeAt(ivars) === 123) j = match[ivars] < 0 ? n : match[ivars] + 1;

    if (category === null && !classesDefined.has(name)) {
      classesDefined.add(name);
      define(name, 'class', at, s.slice(at, headerEnd));
    }
    if (category) addRef(name, 'reference'); // a category extends a class that lives elsewhere
    if (superclass) { addRef(superclass, 'inherit'); superclassOf.set(name, superclass); }
    for (const p of protocols) addRef(p, 'inherit');
    container = { name, implementation };
    return j;
  };

  /** `@protocol` at `at`, with the keyword ending at `i`. */
  const protocolHeader = (at: number, i: number): number => {
    let j = skipSpace(i);
    const nameEnd = identEnd(j);
    if (nameEnd === j) return i; // `@protocol(Name)`, an expression
    const name = s.slice(j, nameEnd);
    j = skipSpace(nameEnd);
    const c = s.charCodeAt(j);
    if (c === 59 || c === 44) return j; // forward declaration
    const adopted = nameList(j);
    if (adopted) j = adopted.end; else j = nameEnd;
    define(name, 'interface', at, s.slice(at, j));
    for (const p of adopted?.names ?? []) addRef(p, 'inherit');
    container = { name, implementation: false };
    return j;
  };

  /** `- (type)name...` or `+ (type)name...` at `i`. Returns where it ends, or `i` when it is not a method. */
  const method = (i: number): number => {
    let j = skipSpace(i + 1);
    if (s.charCodeAt(j) === 40) {
      if (match[j] < 0) return i;
      j = skipSpace(match[j] + 1);
    }
    const nameEnd = identEnd(j);
    if (nameEnd === j) return i;
    let k = nameEnd;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 123 || c === 59) break;
      if (c === 64 || c === 125) return i;
      if ((c === 40 || c === 91) && match[k] > 0) { k = match[k] + 1; continue; }
      k++;
    }
    if (k >= n) return i;
    if (s.charCodeAt(k) === 59) return k + 1; // a declaration
    if (container?.implementation) {
      const name = s.slice(j, nameEnd);
      define(name, 'method', i, s.slice(i, k), { container: container.name });
    }
    const close = match[k] < 0 ? n : match[k];
    bodies.push(k, close);
    bodyOwner.push(container?.implementation ? container.name : null);
    return Math.min(n, close + 1);
  };

  /** The function a file-level `{` at `brace` gives a body to, if the statement before it is a function header. */
  const functionHeader = (from: number, brace: number): void => {
    let j = from;
    while (j < brace) {
      const c = s.charCodeAt(j);
      if (c === 61) return; // an initialiser
      if (c === 91) { j = match[j] > j && match[j] < brace ? match[j] + 1 : j + 1; continue; }
      if (c !== 40) { j++; continue; }
      const close = match[j];
      if (close < 0 || close > brace) return;
      const nameEnd = before(j) + 1;
      const nameStart = identStart(nameEnd);
      if (nameStart === nameEnd || nameStart < from) return; // a function pointer, a cast, a block
      const name = s.slice(nameStart, nameEnd);
      if (ATTRIBUTE_NAME.test(name)) { j = close + 1; continue; } // __attribute__((...)), API_AVAILABLE(...), TEST(...)
      if (NOT_CALLABLE.has(name)) return;
      const q = before(nameStart);
      const more: Partial<SymbolDef> = {};
      let kind: SymbolKind = 'function';
      if (q >= from && s.charCodeAt(q) === 126) return; // a destructor
      if (q > from && s.charCodeAt(q) === 58 && s.charCodeAt(q - 1) === 58) { // C++ `Class::name(`
        const ownerEnd = before(q - 1) + 1;
        const ownerStart = identStart(ownerEnd);
        if (ownerStart < ownerEnd) { more.container = s.slice(ownerStart, ownerEnd); kind = 'method'; }
      }
      if (anonymous > 0 || /\bstatic\b/.test(s.slice(from, nameStart))) more.exported = false;
      define(name, kind, nameStart, s.slice(from, brace), more);
      return;
    }
  };

  /** True when only white space separates `i` from the start of its line. */
  const opensLine = (i: number) => {
    for (let k = i - 1; k >= 0; k--) {
      const c = s.charCodeAt(k);
      if (c === 10) return true;
      if (c !== 32 && c !== 9 && c !== 13) return false;
    }
    return true;
  };

  let statement = 0; // where the current file-level statement began
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    if (c === 64) { // '@'
      const wordEnd = identEnd(i + 1);
      const word = s.slice(i + 1, wordEnd);
      if (word === 'end') { container = null; i = wordEnd; }
      else if (word === 'interface' || word === 'implementation') i = Math.max(wordEnd, classHeader(i, wordEnd, word === 'implementation'));
      else if (word === 'protocol') i = Math.max(wordEnd, protocolHeader(i, wordEnd));
      else i = Math.max(wordEnd, i + 1);
      statement = i;
    } else if (c === 59) {
      statement = ++i;
    } else if (c === 125) { // closes a namespace or an extern "C" block
      if (fileLevelBlocks.length) anonymous -= fileLevelBlocks.pop()!;
      statement = ++i;
    } else if (c === 40 || c === 91) {
      i = match[i] < 0 ? i + 1 : match[i] + 1;
    } else if (c === 123) {
      const head = s.slice(statement, i);
      if (FILE_LEVEL_BLOCK.test(head)) {
        const isAnonymous = ANONYMOUS_NAMESPACE.test(head) ? 1 : 0;
        fileLevelBlocks.push(isAnonymous);
        anonymous += isAnonymous;
        statement = ++i;
        continue;
      }
      functionHeader(statement, i);
      const close = match[i] < 0 ? n : match[i];
      bodies.push(i, close);
      bodyOwner.push(null);
      i = statement = Math.min(n, close + 1);
    } else if ((c === 45 || c === 43) && container && opensLine(i)) {
      // between @interface/@implementation and @end
      const end = method(i);
      if (end > i) i = statement = end; else i++;
    } else {
      i++;
    }
  }

  /** A forward-only lookup of the body a position is in (its number, or -1); ask in increasing order. */
  const bodyCursor = () => {
    let b = 0;
    return (pos: number) => {
      while (b < bodies.length && bodies[b + 1] < pos) b += 2;
      return b < bodies.length && bodies[b] < pos ? b >> 1 : -1;
    };
  };

  // ---- pass 2: message sends ----
  /** End of the primary expression at `i` with its postfix chain (`.x`, `->x`, `::x`, calls, subscripts), or -1. */
  const postfixEnd = (e: number): number => {
    for (;;) {
      const c = s.charCodeAt(e);
      if (c === 46 && isIdStart(s.charCodeAt(e + 1))) e = identEnd(e + 1);
      else if (c === 45 && s.charCodeAt(e + 1) === 62 && isIdStart(s.charCodeAt(e + 2))) e = identEnd(e + 2);
      else if (c === 58 && s.charCodeAt(e + 1) === 58 && isIdStart(s.charCodeAt(e + 2))) e = identEnd(e + 2);
      else if ((c === 40 || c === 91) && match[e] > 0) e = match[e] + 1;
      else return e;
    }
  };
  const primaryEnd = (i: number): number => {
    const c = s.charCodeAt(i);
    let e = -1;
    if (c === 91 || c === 40) e = groupEnd(i);
    else if (isIdStart(c)) e = identEnd(i);
    else if (c === 64) { // a literal: @"...", @(...), @[...], @{...}, @42, @YES, @selector(...)
      const d = s.charCodeAt(i + 1);
      if (d === 34) { const q = skipSpace(i + 2); e = s.charCodeAt(q) === 34 ? q + 1 : -1; }
      else if (d === 40 || d === 91 || d === 123) e = groupEnd(i + 1);
      else if (isIdStart(d)) { e = identEnd(i + 1); if (s.charCodeAt(e) === 40) e = groupEnd(e); }
      else if (isDigit(d)) { e = i + 2; while (e < n && (isIdChar(s.charCodeAt(e)) || s.charCodeAt(e) === 46)) e++; }
    }
    return e < 0 ? -1 : postfixEnd(e);
  };
  /** The first selector keyword when a selector starts after the receiver ending at `e`, inside the send closing at `close`. */
  const selectorAfter = (e: number, close: number): string | null => {
    if (e < 0 || e >= close) return null;
    const k = skipSpace(e);
    const ke = identEnd(k);
    if (ke === k) return null;
    const t = skipSpace(ke);
    return t === close || (s.charCodeAt(t) === 58 && s.charCodeAt(t + 1) !== 58) ? s.slice(k, ke) : null;
  };
  /** False where a `[` continues an expression (a subscript, an array declarator) or opens `@[...]`. */
  const opensExpression = (open: number): boolean => {
    const q = before(open);
    if (q < 0) return true;
    const c = s.charCodeAt(q);
    if (c === 64 || c === 93 || c === 34 || c === 39) return false;
    if (isIdChar(c)) return EXPRESSION_WORDS.has(s.slice(identStart(q + 1), q + 1));
    return true;
  };

  let inBody = bodyCursor();
  for (let open = s.indexOf('['); open >= 0; open = s.indexOf('[', open + 1)) {
    const close = match[open];
    const body = inBody(open);
    if (close < 0 || body < 0 || !opensExpression(open)) continue;
    const r = skipSpace(open + 1);
    let receiverEnd = -1;
    let name: string | null = null;
    if (s.charCodeAt(r) === 40 && match[r] > 0) {
      // `(Type *)value selector` first, then `(expression) selector`
      const operand = skipSpace(match[r] + 1);
      receiverEnd = primaryEnd(operand);
      name = selectorAfter(receiverEnd, close);
    }
    if (name === null) {
      receiverEnd = primaryEnd(r);
      name = selectorAfter(receiverEnd, close);
    }
    if (name === null) continue;

    const first = s.charCodeAt(r);
    let qualifier: string | undefined;
    let allocated = false;
    if (isUpper(first) && identEnd(r) === receiverEnd) qualifier = s.slice(r, receiverEnd);
    else if (first === 91) {
      ALLOC.lastIndex = r;
      const m = ALLOC.exec(s);
      if (m && ALLOC.lastIndex === receiverEnd) { qualifier = m[1]; allocated = true; }
    }
    if (qualifier && !allocated) addRef(qualifier, 'reference'); // the inner `[Class alloc]` already counted it
    if (RUNTIME_SELECTORS.has(name)) continue;
    if (identEnd(r) === receiverEnd && s.slice(r, receiverEnd) === 'super') {
      // A send to super goes to an ancestor. It is kept only when this file names the superclass.
      const owner = bodyOwner[body];
      qualifier = owner ? superclassOf.get(owner) : undefined;
      if (!qualifier) continue;
    }
    addRef(name, 'call', qualifier);
  }

  // ---- pass 3: C calls, @selector and @protocol expressions ----
  inBody = bodyCursor();
  for (let p = s.indexOf('('); p >= 0; p = s.indexOf('(', p + 1)) {
    if (inBody(p) < 0) continue;
    let e = p;
    while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
    const b = identStart(e);
    if (b === e) continue;
    const name = s.slice(b, e);
    const q = before(b);
    const c = q < 0 ? 0 : s.charCodeAt(q);
    if (c === 64) { // @selector(first:second:) and @protocol(Name) name a method and a protocol
      if (q !== b - 1 || (name !== 'selector' && name !== 'protocol')) continue;
      const a = skipSpace(p + 1);
      const ae = identEnd(a);
      if (ae > a) addRef(s.slice(a, ae), 'reference');
      continue;
    }
    if (NOT_CALLABLE.has(name)) continue;
    DECLARATOR.lastIndex = p;
    if (DECLARATOR.test(s)) continue;
    if (c === 46 || (c === 62 && s.charCodeAt(q - 1) === 45)) { // a.name( or a->name(
      if (cxx) addRef(name, 'call');
      continue;
    }
    if (c === 58 && s.charCodeAt(q - 1) === 58) { // ns::name(
      const ownerEnd = before(q - 1) + 1;
      const ownerStart = identStart(ownerEnd);
      addRef(name, 'call', ownerStart < ownerEnd ? s.slice(ownerStart, ownerEnd) : undefined);
      continue;
    }
    if (c === 94 || c === 126) continue; // a block's return type, a destructor
    if (c === 62 && q > 0 && !isSpace(s.charCodeAt(q - 1))) continue; // `vector<int> name(...)`
    if (isIdChar(c) && !EXPRESSION_WORDS.has(s.slice(identStart(q + 1), q + 1))) continue; // `Type name(...)`
    addRef(name, 'call');
  }

  // ---- pass 4: class properties through dot syntax, `Class.name` ----
  inBody = bodyCursor();
  const classDot = /\b([A-Z][A-Za-z0-9_]*)\.([a-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = classDot.exec(s))) {
    if (inBody(m.index) < 0) continue;
    const prev = m.index > 0 ? s.charCodeAt(m.index - 1) : 0;
    if (prev === 46 || prev === 62 || prev === 58 || prev === 64) continue; // a.B.c, a->B.c, ns::B.c
    if (!/[a-z]/.test(m[1])) continue; // URL.path: an all-capitals name is more often a variable than a class
    if (s.charCodeAt(skipSpace(classDot.lastIndex)) === 40) continue; // a C++ member call, counted above
    addRef(m[1], 'reference');
    addRef(m[2], 'call', m[1]);
  }

  // ---- pass 5: types ----
  // `Name *` (with optional `<...>` between) where a declaration can start; `Name<A, B> *` also names protocols.
  const pointerType = /\b([A-Z][A-Za-z0-9_]*)(?=\s*(?:<([^<>;(){}]*)>\s*)?\*+\s*[A-Za-z_),>])/g;
  while ((m = pointerType.exec(s))) {
    const q = before(m.index);
    const c = q < 0 ? 59 : s.charCodeAt(q);
    let qualifier: string | undefined;
    if (c === 58 && q > 0 && s.charCodeAt(q - 1) === 58) { // ns::Name *
      const ownerEnd = before(q - 1) + 1;
      const ownerStart = identStart(ownerEnd);
      if (ownerStart < ownerEnd) qualifier = s.slice(ownerStart, ownerEnd);
    } else if (isIdChar(c)) {
      if (!SPECIFIERS.has(s.slice(identStart(q + 1), q + 1))) continue;
    } else if (c !== 59 && c !== 123 && c !== 125 && c !== 40 && c !== 41 && c !== 44 && c !== 60) continue;
    addRef(m[1], 'type', qualifier);
    if (m[2] && /^[\w\s,]+$/.test(m[2])) for (const p of m[2].split(',')) if (p.trim()) addRef(p.trim(), 'type');
  }
  const idOfProtocols = /\bid\s*<\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*>/g;
  while ((m = idOfProtocols.exec(s))) for (const p of m[1].split(',')) addRef(p.trim(), 'type');

  if (defs.length) {
    const lines = text.split('\n');
    for (const d of defs) {
      const doc = docAbove(lines, d.line);
      if (doc) d.doc = doc;
    }
  }
  return { defs, refs: [...refs.values()] };
}
