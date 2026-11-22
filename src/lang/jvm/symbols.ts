// Slow-pass fallback for Kotlin and Scala, which have no grammar for the tree-sitter runtime:
// definitions and references read from the comment-and-string-blanked text (./mask.ts) by a token
// walk that tracks braces, class headers and (for brace-less Scala 3) indentation. Deliberately
// conservative: a missed reference is better than a wrong one.
import type { RefKind, SymbolDef, SymbolKind, SymbolRef } from '../../contracts/lang';
import { identEnd, isIdentStart, isUpper, maskJvm, skipSpace } from './mask';
import { readDeclName } from './scan';

const NL = 10, LPAREN = 40, RPAREN = 41, STAR = 42, COMMA = 44, DOT = 46, COLON = 58, SEMI = 59, LT = 60, EQUALS = 61;
const GT = 62, QUESTION = 63, AT = 64, LBRACKET = 91, RBRACKET = 93, LBRACE = 123, RBRACE = 125;

/** Longest type-argument list (`<…>`, `[…]`) followed, and longest multi-line Scala import selector skipped. */
const MAX_TYPE_ARGS_CHARS = 160;
const MAX_SELECTOR_CHARS = 2000;
/** How far back on its line a declaration's `private` modifier is looked for. */
const MODIFIER_WINDOW = 200;
const SIGNATURE_CAP = 200;
const DOC_CAP = 300;
/** A doc comment is searched this far above a declaration, across this many annotation lines. */
const MAX_DOC_CHARS = 2000;
const MAX_ANNOTATION_LINES = 5;

const TOKEN = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*|\d\w*(?:\.\d\w*)*|\n|[^\s\w$]/g;

const KOTLIN_WORDS = new Set((
  'as break by catch class companion constructor continue do else false finally for fun if import in init interface is ' +
  'null object package return super this throw true try typealias typeof val var when where while'
).split(' '));
const SCALA_WORDS = new Set((
  'abstract case catch class def do else extends false final finally for forSome given if implicit import lazy match new ' +
  'null object override package private protected return sealed super this throw trait true try type val var while with yield'
).split(' '));

const KOTLIN_PRIVATE = /\bprivate\b/;
const SCALA_PRIVATE = /\bprivate\b(?!\s*\[(?!this\b))/; // `private[pkg]` is visible to other files
/** A line that carries on a class header: `@Inject constructor(`, `private constructor(`, `where T : Any`, `extends Base`. */
const KOTLIN_HEADER_LINE = /^(?:(?:@[\w.]+(?:\([^)]*\))?\s*|(?:private|protected|internal|public)\s+)*constructor|where|by)\b/;
const SCALA_HEADER_LINE = /^(?:extends|with|derives)\b/;

/** An open `{`: the body of a named or anonymous type, or code (a function body, a lambda, a block). */
interface Frame { type: boolean; name?: string }
/** A class header being read: where its supertype list is, and whether a supertype name is due. */
interface Header { paren: number; angle: number; supers: boolean; expect: boolean; delegated: boolean }

/** Leading `/** … *\/` comment of the declaration whose line starts at `lineStart`, flattened and capped. */
function docBefore(text: string, lineStart: number): string | undefined {
  let end = lineStart;
  for (let lines = 0; lines <= MAX_ANNOTATION_LINES && end > 0; lines++) {
    const prevEnd = end - 1;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const above = text.slice(prevStart, prevEnd).trim();
    if (above.endsWith('*/')) {
      const window = text.slice(Math.max(0, prevEnd - MAX_DOC_CHARS), prevEnd).trimEnd();
      const open = window.lastIndexOf('/**');
      if (open < 0 || window.indexOf('*/', open + 3) !== window.length - 2) return undefined;
      const body = window.slice(open + 3, -2).replace(/^[ \t]*\*+ ?/gm, '').replace(/\s+/g, ' ').trim();
      return body ? body.slice(0, DOC_CAP) : undefined;
    }
    if (above.charCodeAt(0) !== AT) return undefined; // only annotation lines may sit in between
    end = prevStart;
  }
  return undefined;
}

/** True when the line starting at `i` carries on a class header left open on the line before. */
function continuesHeader(m: string, i: number, kotlin: boolean): boolean {
  i = skipSpace(m, i);
  const c = m.charCodeAt(i);
  if (c === COLON || c === LBRACE || c === COMMA) return true;
  if (!isIdentStart(c) && c !== AT) return false;
  let end = m.indexOf('\n', i);
  if (end < 0 || end > i + MODIFIER_WINDOW) end = Math.min(m.length, i + MODIFIER_WINDOW);
  return (kotlin ? KOTLIN_HEADER_LINE : SCALA_HEADER_LINE).test(m.slice(i, end));
}

function extract(text: string, lang: 'kotlin' | 'scala', defs: SymbolDef[], refs: Map<string, SymbolRef>): void {
  const m = maskJvm(text, lang);
  const kotlin = lang === 'kotlin';
  const words = kotlin ? KOTLIN_WORDS : SCALA_WORDS;
  const privateRx = kotlin ? KOTLIN_PRIVATE : SCALA_PRIVATE;
  const rx = TOKEN;
  rx.lastIndex = 0;

  const frames: Frame[] = [];
  /** Scala 3 nesting by indentation, used while no brace is open. */
  const indents: { indent: number; type: boolean; name: string }[] = [];
  let paren = 0, line = 1, lineStart = 0, lineIndent = -1, first = true;
  /** A type whose `{` has not come yet. */
  // (`null as …`: both are assigned inside the closures below, which plain `= null` would hide from the type checker)
  let pending = null as { name?: string; paren: number } | null;
  let header = null as Header | null;
  /** The last four tokens, line breaks left out. */
  let p1 = '', p2 = '', p3 = '', p4 = '';

  const addRef = (name: string, kind: RefKind, qualifier?: string): void => {
    const key = `${kind}\0${name}\0${qualifier ?? ''}`;
    const ref = refs.get(key);
    if (ref) ref.count++;
    else refs.set(key, qualifier ? { name, kind, count: 1, qualifier } : { name, kind, count: 1 });
  };

  /** Ends a class header (and forgets its body-less type) when a new statement starts at its level. */
  const endHeader = (): void => {
    if (header && header.paren === paren) header = null;
    if (pending && pending.paren === paren) pending = null;
  };
  const startHeader = (name: string | undefined): void => {
    pending = { name, paren };
    header = kotlin ? { paren, angle: 0, supers: false, expect: false, delegated: false } : null; // Scala's starts at `extends`
  };
  const enclosingType = (): string | undefined => {
    for (let k = frames.length - 1; k >= 0; k--) if (frames[k].type) return frames[k].name;
    return undefined;
  };

  /** Records a definition whose keyword is at `at`. `callable`: a fun/def; `nests`: later declarations may sit inside it. */
  const addDef = (name: string, kind: SymbolKind, at: number, callable: boolean, nests = true): void => {
    let container: string | undefined;
    let local = false; // inside a function body, a lambda or an anonymous class
    let member = false;
    const top = frames[frames.length - 1];
    if (top) {
      member = top.type;
      if (top.type && top.name) container = top.name; else local = true;
    } else if (!kotlin) {
      if (lineIndent < 0) { // measured once per line
        let k = lineStart;
        while (m.charCodeAt(k) === 32 || m.charCodeAt(k) === 9) k++;
        lineIndent = k - lineStart;
      }
      const indent = lineIndent;
      while (indents.length && indents[indents.length - 1].indent >= indent) indents.pop();
      const parent = indents[indents.length - 1];
      if (parent) {
        member = parent.type;
        if (parent.type) container = parent.name; else local = true;
      }
      if (nests) indents.push({ indent, type: !callable, name });
    }
    const def: SymbolDef = { name, kind: callable ? (member ? 'method' : 'function') : kind, line };
    if (container) def.container = container;
    // The statement runs from the line start (or the last `{`, `}` or `;` before the keyword) to its body.
    const lead = Math.max(lineStart, at - MODIFIER_WINDOW);
    const before = m.slice(lead, at);
    const from = lead + Math.max(before.lastIndexOf('{'), before.lastIndexOf('}'), before.lastIndexOf(';')) + 1;
    if (local || privateRx.test(m.slice(from, at))) def.exported = false;
    const limit = Math.min(m.length, at + 2 * SIGNATURE_CAP);
    let to = at;
    for (let depth = 0; to < limit; to++) {
      const c = m.charCodeAt(to);
      if (c === NL || c === LBRACE || c === RBRACE || c === SEMI) break;
      if (c === LPAREN || c === LBRACKET) depth++;
      else if (c === RPAREN || c === RBRACKET) depth--;
      else if (c === EQUALS && callable && depth === 0 && m.charCodeAt(to + 1) !== EQUALS && m.charCodeAt(to + 1) !== GT) break; // an expression body
    }
    let signature = text.slice(from, to).trim();
    if (signature.endsWith(':')) signature = signature.slice(0, -1).trimEnd(); // Scala 3 `object Main:`
    if (signature) def.signature = signature.slice(0, SIGNATURE_CAP);
    const doc = docBefore(text, lineStart);
    if (doc) def.doc = doc;
    defs.push(def);
  };

  /**
   * Index after the type-argument list opening at `i` (`<…>` in Kotlin, `[…]` in Scala), or -1 when
   * it is not a short list of plain type names. With `collect`, its upper-case names become type references.
   */
  const typeArgs = (i: number, collect: boolean): number => {
    const open = m.charCodeAt(i), close = open === LT ? GT : RBRACKET;
    const limit = Math.min(m.length, i + MAX_TYPE_ARGS_CHARS);
    const found: string[] = [];
    let depth = 0;
    for (let j = i; j < limit;) {
      const c = m.charCodeAt(j);
      if (isIdentStart(c)) {
        const e = identEnd(m, j);
        if (collect && isUpper(c) && m.charCodeAt(j - 1) !== DOT) found.push(m.slice(j, e));
        j = e;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        if (--depth === 0) {
          for (const name of found) addRef(name, 'type');
          return j + 1;
        }
      } else if (!(c === 32 || c === 9 || c === COMMA || c === DOT || c === QUESTION || c === STAR)) return -1;
      j++;
    }
    return -1;
  };

  /** Reads the identifier after a keyword ending at `end`; null when none follows on the line. */
  const nameAfter = (end: number): { name: string; end: number } | null => {
    const i = skipSpace(m, end);
    if (!isIdentStart(m.charCodeAt(i))) return null;
    const e = identEnd(m, i);
    return { name: m.slice(i, e), end: e };
  };

  /** A `:` — the start of a Kotlin supertype list, or a type annotation (`x: Foo`, `): List<Foo>`). */
  const colon = (at: number): string | undefined => {
    if (p1 === ':' || m.charCodeAt(at + 1) === COLON) return undefined; // `Foo::bar`
    if (header && header.paren === paren) {
      if (!kotlin) header = null; // Scala 3: `class A extends B:` opens the body
      else if (!header.supers && header.angle === 0) { header.supers = true; header.expect = true; return undefined; }
    }
    if (p1 === '?') return undefined; // Kotlin `?:`
    let i = skipSpace(m, at + 1);
    while (isIdentStart(m.charCodeAt(i)) && !isUpper(m.charCodeAt(i))) { // a package-qualified type: `x: com.acme.Order`
      const dot = identEnd(m, i);
      if (m.charCodeAt(dot) !== DOT) return undefined;
      i = dot + 1;
    }
    if (!isUpper(m.charCodeAt(i))) return undefined;
    const e = identEnd(m, i);
    const name = m.slice(i, e);
    addRef(name, 'type');
    let end = e;
    if (m.charCodeAt(e) === (kotlin ? LT : LBRACKET)) {
      const k = typeArgs(e, true);
      if (k > 0) end = k;
    }
    rx.lastIndex = end;
    return name;
  };

  /** A punctuation or number token. Returns a further token it consumed, for the token history. */
  const punct = (c: number, at: number): string | undefined => {
    switch (c) {
      case LBRACE:
        if (pending && pending.paren === paren) { frames.push({ type: true, name: pending.name }); pending = null; }
        else frames.push({ type: false });
        if (header && header.paren === paren) header = null;
        return undefined;
      case RBRACE:
        frames.pop();
        endHeader();
        return undefined;
      case LPAREN: case LBRACKET:
        paren++;
        return undefined;
      case RPAREN: case RBRACKET:
        if (paren > 0) paren--;
        if (header && paren < header.paren) header = null;
        if (pending && paren < pending.paren) pending = null;
        return undefined;
      case LT:
        if (kotlin && header && header.paren === paren) header.angle++;
        return undefined;
      case GT:
        if (kotlin && header && header.paren === paren && header.angle > 0 && p1 !== '-') header.angle--;
        return undefined;
      case COMMA:
        if (header && header.supers && header.paren === paren && header.angle === 0) { header.expect = true; header.delegated = false; }
        return undefined;
      case SEMI:
        endHeader();
        return undefined;
      case EQUALS:
        if (m.charCodeAt(at + 1) !== GT) endHeader();
        return undefined;
      case COLON:
        return colon(at);
      default:
        return undefined;
    }
  };

  /** A declaration keyword of Kotlin. Returns the declared name when it consumed one; null when `tok` is no such keyword. */
  const kotlinKeyword = (tok: string, at: number, end: number): string | undefined | null => {
    switch (tok) {
      case 'class': case 'interface': {
        if (p1 === ':' || p1 === '.') return undefined; // `Foo::class`
        const n = nameAfter(end);
        if (!n) return undefined;
        addDef(n.name, tok === 'interface' ? 'interface' : p1 === 'enum' ? 'enum' : 'class', at, false);
        startHeader(n.name);
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'object': {
        const n = nameAfter(end);
        if (!n) { // `object : Listener { … }`, or a companion, whose members belong to the enclosing class
          startHeader(p1 === 'companion' ? enclosingType() : undefined);
          return undefined;
        }
        addDef(n.name, 'class', at, false);
        startHeader(n.name);
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'typealias': {
        const n = nameAfter(end);
        if (!n) return undefined;
        addDef(n.name, 'type', at, false, false);
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'fun': {
        endHeader();
        const d = readDeclName(m, end);
        if (!d || m.charCodeAt(skipSpace(m, d.end)) !== LPAREN) return undefined; // `fun interface`, an anonymous function
        addDef(d.name, 'function', at, true);
        rx.lastIndex = d.end;
        return d.name;
      }
      case 'val': case 'var':
        endHeader();
        return undefined;
      default:
        return null;
    }
  };

  const SCALA_KINDS: Record<string, SymbolKind> = { class: 'class', trait: 'trait', object: 'module', enum: 'enum' };
  const scalaKeyword = (tok: string, at: number, end: number): string | undefined | null => {
    switch (tok) {
      case 'class': case 'trait': case 'object': case 'enum': {
        if (p1 === '.') return undefined;
        const n = nameAfter(end);
        if (!n || words.has(n.name) || (tok === 'enum' && !isUpper(n.name.charCodeAt(0)))) return undefined;
        addDef(n.name, SCALA_KINDS[tok], at, false);
        pending = { name: n.name, paren };
        header = null;
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'type': {
        if (p1 === '.') return undefined; // `x.type`
        const n = nameAfter(end);
        if (!n || words.has(n.name)) return undefined;
        addDef(n.name, 'type', at, false, false);
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'def': {
        endHeader();
        const n = nameAfter(end);
        if (!n || words.has(n.name)) return undefined; // `def this(…)`, symbolic names
        addDef(n.name, 'function', at, true);
        rx.lastIndex = n.end;
        return n.name;
      }
      case 'val': case 'var':
        endHeader();
        return undefined;
      case 'extends':
        header = { paren, angle: 0, supers: true, expect: true, delegated: false };
        return undefined;
      case 'new': { // `new Foo(…)`, `new a.b.Foo[T]`
        let i = skipSpace(m, end), e = i, name = '';
        while (isIdentStart(m.charCodeAt(i))) {
          e = identEnd(m, i);
          name = m.slice(i, e);
          if (m.charCodeAt(e) !== DOT) break;
          i = e + 1;
        }
        if (!name || !isUpper(name.charCodeAt(0))) return undefined;
        addRef(name, 'type');
        rx.lastIndex = e;
        return name;
      }
      default:
        return null;
    }
  };

  /** An identifier or keyword token. Returns a further token it consumed, for the token history. */
  const word = (tok: string, at: number, wasFirst: boolean): string | undefined => {
    const end = at + tok.length;

    // Inside a supertype list: `: Base(args), Other by impl` / `extends Base with Other`.
    if (header && header.supers && header.paren === paren && header.angle === 0) {
      if (kotlin && tok === 'by') { header.expect = false; header.delegated = true; return undefined; }
      if (!kotlin && tok === 'with') { header.expect = true; return undefined; }
      if (header.expect && !words.has(tok)) {
        if (m.charCodeAt(skipSpace(m, end)) === DOT) return undefined; // a package or outer type: its last segment is the supertype
        addRef(tok, 'inherit');
        header.expect = false;
        return undefined;
      }
      if (!header.delegated) header = null; // the list is over
    }

    if (tok === 'import' || tok === 'package') {
      if (tok === 'package' && !kotlin && nameAfter(end)?.name === 'object') return undefined; // `package object x`
      let e = m.indexOf('\n', end);
      if (e < 0) e = m.length;
      // A Scala selector list left open on this line: skip to its `}` so the brace is not taken for a block's.
      const rest = m.slice(end, e);
      const open = rest.lastIndexOf('{');
      if (!kotlin && open >= 0 && rest.indexOf('}', open) < 0) {
        const close = m.slice(e, e + MAX_SELECTOR_CHARS).indexOf('}');
        if (close >= 0) {
          for (let k = e; k < e + close; k++) if (m.charCodeAt(k) === NL) { line++; lineStart = k + 1; lineIndent = -1; }
          e += close + 1;
        }
      }
      rx.lastIndex = e;
      return undefined;
    }

    const declared = kotlin ? kotlinKeyword(tok, at, end) : scalaKeyword(tok, at, end);
    if (declared !== null) return declared;
    if (words.has(tok)) return undefined;

    const c = tok.charCodeAt(0);
    if (p1 === '@') { // an annotation, or a label such as `this@Outer`
      if (isUpper(c)) addRef(tok, 'type');
      return undefined;
    }
    const afterDot = p1 === '.';
    if (kotlin && !afterDot && (tok === 'get' || tok === 'set')) return undefined; // property accessors

    const j = skipSpace(m, end);
    const next = m.charCodeAt(j);
    let call = next === LPAREN;
    if (!call && j === end && next === (kotlin ? LT : LBRACKET)) { // `name<T>(…)`, `name[T](…)`
      const k = typeArgs(j, false);
      call = k > 0 && m.charCodeAt(k) === LPAREN;
    }
    // `name { … }`: a call with only a trailing block, where it cannot be a type followed by a body.
    if (!call && next === LBRACE && !afterDot && (wasFirst || p1 === '=' || p1 === '(' || p1 === '{' || p1 === ';')) call = true;
    if (call) {
      let qualifier: string | undefined;
      if (afterDot) { // `x.name(` / `x?.name(` where x starts the expression
        const q = p2 === '?' ? p3 : p2;
        const before = p2 === '?' ? p4 : p3;
        if (isIdentStart(q.charCodeAt(0)) && q !== '_' && !words.has(q) && before !== '.') qualifier = q;
      }
      addRef(tok, 'call', qualifier);
      return undefined;
    }
    // `Type.member` and Kotlin's `Type::class`: an upper-case name used as a qualifier.
    if (isUpper(c) && !afterDot && j === end && (next === DOT || (kotlin && next === COLON && m.charCodeAt(j + 1) === COLON))) addRef(tok, 'type');
    return undefined;
  };

  let hit: RegExpExecArray | null;
  while ((hit = rx.exec(m))) {
    const tok = hit[0];
    const at = hit.index;
    const c = tok.charCodeAt(0);
    if (c === NL) {
      line++;
      lineStart = at + 1;
      lineIndent = -1;
      first = true;
      // A header that does not carry on over the line break is over, and its type has no body.
      const open: { paren: number } | null = header ?? pending;
      if (open && open.paren === paren && !(header && (header.expect || header.angle > 0)) && !continuesHeader(m, at + 1, kotlin)) {
        header = null;
        pending = null;
      }
      continue;
    }
    const wasFirst = first;
    first = false;
    const extra = isIdentStart(c) ? word(tok, at, wasFirst) : punct(c, at);
    p4 = p3; p3 = p2; p2 = p1; p1 = tok;
    if (extra) { p4 = p3; p3 = p2; p2 = p1; p1 = extra; }
  }
}

/**
 * Definitions (class, object, interface, trait, enum, type alias, fun, def) and references (calls,
 * type annotations, `Type.member` qualifiers, annotations, supertypes) of a Kotlin or Scala source
 * text, counted per name. `exported` is false for `private` declarations and for ones local to a
 * function body or an anonymous class. Never throws.
 */
export function extractJvmSymbols(text: string, lang: 'kotlin' | 'scala'): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const defs: SymbolDef[] = [];
  const refs = new Map<string, SymbolRef>();
  try {
    extract(text, lang, defs, refs);
  } catch {
    // keep what was found
  }
  return { defs, refs: [...refs.values()] };
}
