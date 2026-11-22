// Slow pass for Lua and Luau without a grammar (LanguagePlugin.extractSymbols). The only Lua grammar
// on npm in wasm form is built for an older tree-sitter runtime than the one in use, and there is
// none for Luau, so definitions and references are read by a token walk over the comment-and-string-
// blanked text (./mask.ts). Deliberately conservative: a missed reference is better than a wrong one.
//
// Definitions:
//   function f() / function M.f() / function M:f()        function, or method of M after a colon
//   local function f() / local f = function()             private to the file unless it is returned
//   f = function() / M.f = function()                     at the top level only
//   { f = function() … }                                  in a top-level table: a function of that table
//   type T = … / export type T = …                        Luau type aliases
//   local M = {} with members                             module; class when it sets M.__index, or comes
//                                                         from Base:extend() / setmetatable({}, {__index = Base})
// `exported` is false for locals that the chunk does not hand out: `return M`, `return { f = f }`
// and `M.f = f` at the top level are what make a local visible to other files.
//
// References: calls (`f(…)`, `f "…"`, `f {…}`, with `M` as qualifier in `M.f(…)` and `M:f(…)`),
// superclasses, and the upper-case names in Luau type annotations.
//
// Block nesting is counted from the keywords that take an `end`; Luau's `if … then … else …`
// expression takes none and is told apart by what stands before it. A statement keyword in the first
// column resets the count, so one misread cannot misplace the rest of the file.
import type { RefKind, SymbolDef, SymbolKind, SymbolRef } from '../../contracts/lang';
import { maskLua } from './mask';

const SIGNATURE_CAP = 200;
const DOC_CAP = 300;
/** A doc comment is read this many lines, or this many characters of block comment, above a definition. */
const MAX_DOC_LINES = 40;
const MAX_DOC_CHARS = 2000;
/** How far a parameter list, a returned table and a setmetatable call are followed. */
const MAX_PARAMS_CHARS = 400;
const MAX_RETURN_CHARS = 4000;
const PEEK_CHARS = 200;

const TOKEN = /[A-Za-z_]\w*|\d\w*(?:\.\d\w*)?|\n|::|->|\.\.\.?|[^\s\w]/g;

const KEYWORDS = new Set((
  'and break do else elseif end false for function goto if in local nil not or repeat return then true until while'
).split(' '));
/** Tokens after which an `if` is Luau's if-expression, not a statement. */
const BEFORE_EXPRESSION = new Set(['=', '(', ',', '{', '[', 'return', 'and', 'or', 'not', '+', '-', '*', '/', '%', '^', '..', '<', '>', '~', '#']);
/** Statement keywords that, in the first column, can only be at the top level. */
const TOP_LEVEL_STARTS = new Set(['function', 'local', 'return', 'type', 'export']);

/** `Name.a.b:method(` after `function`; group 1 the dotted path, group 2 the method. */
const FUNCTION_NAME = /\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)(?:\s*:\s*([A-Za-z_]\w*))?\s*[(<]/y;
/** ` Name = {`, ` Name: T = setmetatable(` after `local`, or `= {` after a first-column global. */
const TABLE_DECL = /\s*(?::[^=\n]+)?=\s*(?:\{|setmetatable\b)/y;
/** ` = Base:extend(`: the class libraries' way of declaring a subclass. */
const SUBCLASS_DECL = /\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[.:](?:extend|subclass|inherit)\s*\(/y;
/** `(Name, { __index = Base })` and `({}, { __index = Base })` after `setmetatable`. */
const METATABLE = /^\s*\(\s*(?:([A-Za-z_]\w*)|\{\s*\})\s*,\s*\{\s*__index\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*[,}]/;
/** One entry of `return { a = a, b }`: group 1 is the value when it is a plain name. */
const RETURNED_ENTRY = /(?:^|[,;{])\s*(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_]\w*)\s*(?=[,;}])/g;
const IDENT = /[A-Za-z_]\w*/y;

const isIdent = (tok: string): boolean => /^[A-Za-z_]/.test(tok);
const isUpper = (tok: string): boolean => { const c = tok.charCodeAt(0); return c >= 65 && c <= 90; };
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('.') + 1);

function skipBlank(s: string, i: number): number {
  while (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9) i++;
  return i;
}

/** Index past the bracket that closes the one opening at `i`, or -1 when it is not found within `max` characters. */
function closeOf(m: string, i: number, max: number): number {
  const open = m.charCodeAt(i), close = open === 40 ? 41 : open === 123 ? 125 : 93;
  const limit = Math.min(m.length, i + max);
  for (let depth = 0, j = i; j < limit; j++) {
    const c = m.charCodeAt(j);
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return -1;
}

function flatten(lines: string[]): string | undefined {
  const s = lines.map((l) => l.trim().replace(/^[-*]+\s?/, '').replace(/[-*]+$/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  return s ? s.slice(0, DOC_CAP) : undefined;
}

/** The comment that ends on the line above `lineStart`: a run of `--` lines or one `--[[ … ]]` block. */
function docBefore(text: string, lineStart: number): string | undefined {
  const lines: string[] = [];
  let end = lineStart;
  for (let k = 0; k < MAX_DOC_LINES && end > 0; k++) {
    const prevEnd = end - 1;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    if (prevStart > prevEnd) break;
    const above = text.slice(prevStart, prevEnd).trim();
    if (k === 0 && /\]=*\]$/.test(above)) {
      const window = text.slice(Math.max(0, prevEnd - MAX_DOC_CHARS), prevEnd);
      const block = /--\[(=*)\[((?:(?!\]\1\])[\s\S])*)\]\1\]\s*$/.exec(window);
      return block ? flatten(block[2].split('\n')) : undefined;
    }
    if (!above.startsWith('--') || above.startsWith('--!')) break; // `--!strict` is a directive
    lines.unshift(above);
    end = prevStart;
  }
  return flatten(lines);
}

interface Def extends SymbolDef {
  /** Declared `local` at the top level: exported only when the chunk hands it out. */
  local?: boolean;
}
/** A table that may turn out to be a module or a class. */
interface Table { line: number; lineStart: number; local: boolean }
/** An open `{`: the table it belongs to when that is known, and the block depth it opened at. */
interface Brace { name?: string; depth: number }
type Frame = 'function' | 'do' | 'if' | 'repeat' | 'exprif';

function extract(text: string, luau: boolean, defs: Def[], refs: Map<string, SymbolRef>): void {
  const m = maskLua(text);
  const rx = TOKEN;
  rx.lastIndex = 0;

  const frames: Frame[] = [];
  const braces: Brace[] = [];
  const tables = new Map<string, Table>();
  const classes = new Set<string>();
  const owners = new Set<string>();   // tables that got a member
  const handedOut = new Set<string>(); // locals the chunk returns or assigns into a table
  let line = 1, lineStart = 0, first = true;
  let typeLine = false;       // inside `type T = …`, to the end of the line
  let afterExprElse = false;  // the last `else` closed an if-expression
  let p1 = '', p2 = '', p3 = '', p4 = '';

  const addRef = (name: string, kind: RefKind, qualifier?: string): void => {
    const key = `${kind}\0${name}\0${qualifier ?? ''}`;
    const ref = refs.get(key);
    if (ref) ref.count++;
    else refs.set(key, qualifier ? { name, kind, count: 1, qualifier } : { name, kind, count: 1 });
  };

  const lineEnd = (from: number): number => { const e = m.indexOf('\n', from); return e < 0 ? m.length : e; };

  /** Records a definition on the current line whose source text runs to `to`. */
  const addDef = (name: string, kind: SymbolKind, to: number, more: { container?: string; local?: boolean; exported?: boolean } = {}): void => {
    if (name.startsWith('__')) return; // metamethods are never called by name
    const def: Def = { name, kind, line };
    if (more.container) { def.container = more.container; owners.add(more.container); }
    if (more.exported === false) def.exported = false;
    if (more.local) def.local = true;
    const from = skipBlank(text, lineStart);
    const signature = text.slice(from, Math.max(from, Math.min(to, from + SIGNATURE_CAP * 4))).replace(/\s+/g, ' ').trim().replace(/\s*[={]$/, '');
    if (signature) def.signature = signature.slice(0, SIGNATURE_CAP);
    const doc = docBefore(text, lineStart);
    if (doc) def.doc = doc;
    defs.push(def);
  };

  /** Where the signature of the function whose parameter list opens at or after `from` ends. */
  const signatureEnd = (from: number): number => {
    const open = m.indexOf('(', from);
    if (open < 0 || open > from + PEEK_CHARS) return lineEnd(from);
    const close = closeOf(m, open, MAX_PARAMS_CHARS);
    if (close < 0) return lineEnd(from);
    return m.charCodeAt(skipBlank(m, close)) === 58 ? lineEnd(close) : close; // a Luau return type follows
  };

  const noteTable = (name: string, local: boolean): void => {
    if (!tables.has(name)) tables.set(name, { line, lineStart, local });
  };

  /** `function` — a named definition in one of its forms, or an anonymous function. */
  const functionKeyword = (end: number): string | undefined => {
    const topLevel = frames.length === 0;
    const inTable = braces.length > 0;
    frames.push('function');

    FUNCTION_NAME.lastIndex = end;
    const named = FUNCTION_NAME.exec(m);
    if (named) {
      const path = named[1].split('.').map((s) => s.trim());
      const nameEnd = FUNCTION_NAME.lastIndex - 1;
      const to = signatureEnd(nameEnd);
      if (p1 === 'local') addDef(path[0], 'function', to, topLevel ? { local: true, exported: false } : { exported: false });
      else if (named[2]) addDef(named[2], 'method', to, { container: path[path.length - 1] });
      else if (path.length > 1) addDef(path[path.length - 1], 'function', to, { container: path[path.length - 2] });
      else addDef(path[0], 'function', to);
      rx.lastIndex = nameEnd;
      return named[2] ?? path[path.length - 1];
    }

    // `name = function(…)`: the name is two tokens back.
    if (p1 !== '=' || !isIdent(p2) || KEYWORDS.has(p2)) return undefined;
    const to = signatureEnd(end);
    if (p3 === 'local') addDef(p2, 'function', to, topLevel && !inTable ? { local: true, exported: false } : { exported: false });
    else if (!topLevel) return undefined;
    else if (inTable) { // a field of a top-level table
      if (braces.length === 1 && braces[0].depth === 0 && (p3 === '{' || p3 === ',' || p3 === ';')) addDef(p2, 'function', to, { container: braces[0].name });
    } else if (p3 === '.') {
      if (isIdent(p4) && p4 !== 'self') addDef(p2, 'function', to, { container: p4 });
    } else if (p3 !== ':' && p3 !== ',') addDef(p2, 'function', to);
    return undefined;
  };

  /** `return` at the top level: what the chunk hands to whoever requires it. */
  const returned = (end: number): void => {
    const i = skipBlank(m, end);
    if (m.charCodeAt(i) === 123) {
      const close = closeOf(m, i, MAX_RETURN_CHARS);
      if (close < 0) return;
      const body = m.slice(i, close);
      RETURNED_ENTRY.lastIndex = 0;
      for (let hit = RETURNED_ENTRY.exec(body); hit; hit = RETURNED_ENTRY.exec(body)) handedOut.add(hit[1]);
      return;
    }
    IDENT.lastIndex = i;
    const name = IDENT.exec(m);
    if (name && !KEYWORDS.has(name[0])) handedOut.add(name[0]);
  };

  /** A name in type position: `Foo`, `Mod.Foo`. Returns the index past it. */
  const typeName = (tok: string, end: number): number => {
    if (m.charCodeAt(end) === 46 && m.charCodeAt(end + 1) !== 46) {
      IDENT.lastIndex = end + 1;
      const member = IDENT.exec(m);
      if (member) {
        if (isUpper(member[0])) addRef(member[0], 'type', tok);
        return IDENT.lastIndex;
      }
    }
    if (isUpper(tok) && tok.length > 1) addRef(tok, 'type');
    return end;
  };

  /** An identifier or keyword. Returns a further token it consumed, for the token history. */
  const word = (tok: string, at: number, wasFirst: boolean): string | undefined => {
    const end = at + tok.length;
    if (wasFirst && at === lineStart && TOP_LEVEL_STARTS.has(tok)) { frames.length = 0; braces.length = 0; }

    switch (tok) {
      case 'function':
        return functionKeyword(end);
      case 'do': case 'repeat':
        frames.push(tok);
        return undefined;
      case 'if': {
        const top = frames[frames.length - 1];
        const expression = (BEFORE_EXPRESSION.has(p1) || (p1 === 'else' && afterExprElse) || (p1 === 'then' && top === 'exprif'));
        frames.push(expression ? 'exprif' : 'if');
        return undefined;
      }
      case 'else':
        afterExprElse = frames[frames.length - 1] === 'exprif';
        if (afterExprElse) frames.pop();
        return undefined;
      case 'end': case 'until':
        while (frames[frames.length - 1] === 'exprif') frames.pop();
        if (wasFirst && at === lineStart && frames.length > 1) frames.length = 1; // a block closed in the first column is a top-level one
        frames.pop();
        return undefined;
      case 'return':
        if (frames.length === 0 && braces.length === 0) returned(end);
        return undefined;
      case 'local': {
        if (frames.length > 0 || braces.length > 0) return undefined;
        IDENT.lastIndex = skipBlank(m, end);
        const name = IDENT.exec(m);
        if (!name || KEYWORDS.has(name[0])) return undefined;
        const after = IDENT.lastIndex;
        TABLE_DECL.lastIndex = after;
        SUBCLASS_DECL.lastIndex = after;
        const base = SUBCLASS_DECL.exec(m);
        if (base) {
          noteTable(name[0], true);
          classes.add(name[0]);
          addRef(lastSegment(base[1]), 'inherit');
        } else if (TABLE_DECL.test(m)) noteTable(name[0], true);
        return undefined;
      }
      case 'setmetatable': {
        // `setmetatable(Class, { __index = Base })`, or the same on a fresh table being declared.
        const meta = METATABLE.exec(m.slice(end, end + PEEK_CHARS));
        if (!meta) break;
        const subject = meta[1] ?? (p1 === '=' && isIdent(p2) ? p2 : undefined);
        const base = lastSegment(meta[2]);
        if (subject && tables.has(subject) && base !== subject) { classes.add(subject); addRef(base, 'inherit'); }
        break;
      }
      case 'type': case 'export': {
        // Contextual in Luau: `type T =`, `type T<A> =`, `export type T =` at the start of a statement.
        if (tok === 'export' ? !wasFirst : !(wasFirst || p1 === 'export')) break;
        if (tok === 'export') return undefined;
        IDENT.lastIndex = skipBlank(m, end);
        const name = IDENT.exec(m);
        if (!name) break;
        const next = m.charCodeAt(skipBlank(m, IDENT.lastIndex));
        if (next !== 61 && next !== 60) break;
        addDef(name[0], 'type', lineEnd(end), p1 === 'export' ? {} : { exported: false });
        typeLine = true;
        rx.lastIndex = IDENT.lastIndex;
        return name[0];
      }
    }
    if (KEYWORDS.has(tok)) return undefined;

    if (tok === '__index' && p1 === '.' && isIdent(p2) && m.charCodeAt(skipBlank(m, end)) === 61 && m.charCodeAt(skipBlank(m, end) + 1) !== 61) {
      classes.add(p2); // `Foo.__index = Foo`
      return undefined;
    }

    const j = skipBlank(m, end);
    const next = m.charCodeAt(j);
    const member = p1 === '.' || p1 === ':';
    const call = next === 40 || ((next === 34 || next === 123) && !typeLine);

    // Type positions: after an annotation's `:`, a cast's `::`, a function type's `->`, and all of a `type` line.
    if (!call || typeLine) {
      const typed = typeLine ? p1 !== '.' : p1 === '::' || p1 === '->' || (p1 === ':' && p2 !== ':') || (luau && (p1 === '|' || p1 === '&') && isUpper(tok));
      if (typed) {
        const after = typeName(tok, end);
        if (after !== end) { rx.lastIndex = after; return m.slice(end + 1, after); }
      }
      return undefined;
    }

    let qualifier: string | undefined;
    if (member && isIdent(p2) && !KEYWORDS.has(p2) && p2 !== 'self' && p3 !== '.' && p3 !== ':') qualifier = p2;
    addRef(tok, 'call', qualifier);
    return undefined;
  };

  /** `Name = {` or `Name.field = name` starting a top-level line. */
  const statementStart = (tok: string, at: number): void => {
    const end = at + tok.length;
    TABLE_DECL.lastIndex = end;
    if (TABLE_DECL.test(m) && m.charCodeAt(skipBlank(m, end)) === 61) { noteTable(tok, false); return; }
    const assigned = /^\.[A-Za-z_]\w*[ \t]*=[ \t]*([A-Za-z_]\w*)[ \t]*(?:;|\r?\n|$)/.exec(m.slice(end, end + PEEK_CHARS));
    if (assigned) handedOut.add(assigned[1]);
  };

  let hit: RegExpExecArray | null;
  while ((hit = rx.exec(m))) {
    const tok = hit[0];
    const at = hit.index;
    const c = tok.charCodeAt(0);
    if (c === 10) {
      line++;
      lineStart = at + 1;
      first = true;
      typeLine = false;
      continue;
    }
    const wasFirst = first;
    first = false;
    let extra: string | undefined;
    if (c === 34) { // a string: one token, whatever it spans
      const close = m.indexOf('"', at + 1);
      const end = close < 0 ? m.length : close + 1;
      for (let k = m.indexOf('\n', at); k >= 0 && k < end; k = m.indexOf('\n', k + 1)) { line++; lineStart = k + 1; }
      rx.lastIndex = end;
    } else if (c === 123) {
      const owner = p1 === '=' && isIdent(p2) && p3 !== '.' && p3 !== ':' ? p2 : undefined;
      braces.push({ name: owner, depth: frames.length });
    } else if (c === 125) {
      braces.pop();
    } else if (isIdent(tok)) {
      if (wasFirst && frames.length === 0 && braces.length === 0 && !KEYWORDS.has(tok)) statementStart(tok, at);
      extra = word(tok, at, wasFirst);
    }
    p4 = p3; p3 = p2; p2 = p1; p1 = tok;
    if (extra) { p4 = p3; p3 = p2; p2 = p1; p1 = extra; }
  }

  // Tables that turned out to hold something: classes and modules, at the line that declared them.
  for (const [name, table] of tables) {
    const isClass = classes.has(name);
    if (!isClass && !owners.has(name)) continue;
    const def: Def = { name, kind: isClass ? 'class' : 'module', line: table.line };
    if (table.local) { def.local = true; def.exported = false; }
    const from = skipBlank(text, table.lineStart);
    const signature = text.slice(from, Math.min(lineEnd(from), from + SIGNATURE_CAP)).trim().replace(/\s*=\s*\{\}?\s*$/, '');
    if (signature) def.signature = signature;
    const doc = docBefore(text, table.lineStart);
    if (doc) def.doc = doc;
    defs.push(def);
  }
  defs.sort((a, b) => a.line - b.line);
  for (const def of defs) {
    if (def.local && handedOut.has(def.name)) delete def.exported;
    delete def.local;
  }
}

/**
 * Definitions and references of a Lua (`luau: false`) or Luau source text; see the head of this file
 * for what is read. Never throws.
 */
export function extractLuaSymbols(text: string, luau: boolean): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const defs: Def[] = [];
  const refs = new Map<string, SymbolRef>();
  try {
    extract(text, luau, defs, refs);
  } catch {
    // keep what was found
  }
  for (const def of defs) delete def.local;
  return { defs, refs: [...refs.values()] };
}
