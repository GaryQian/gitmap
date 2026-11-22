// Turning one parsed file into definitions and references (PLAN.md §6.3, slow pass). Works for any
// plug-in's query that follows the capture convention in src/contracts/lang.ts:
//
//   @definition.<kind> with an inner @name      → a SymbolDef
//   @reference.<kind>  with an inner @name      → a SymbolRef, counted per (name, kind, qualifier)
//   @qualifier, @container                      → as the contract describes
//
// and for these optional captures, which a query may use and need not:
//
//   @local   anywhere in a pattern: the symbol is private to its file (`exported: false`).
//   @export  on an identifier: that name is exported from the file after all, whatever @local said
//            (`export { a }`, `module.exports = a`).
//   @doc     the node holding the symbol's documentation, for languages that keep it inside the
//            definition (a Python docstring). Otherwise the comment block right above is used.
//   @ignore  anywhere in a pattern: its @name is neither a definition nor a reference, whatever other
//            patterns say (a cheap way to carve an exception out of a general pattern).
//
// A plug-in whose language decides `exported` from the name alone gives SyntaxSpec.exported instead;
// @local and @export are then not consulted.
//
// @name is paired with its @definition/@reference capture through the query match they share, so the
// two may sit on the same node (`(type_identifier) @name @reference.type`) or nest. Text predicates
// (#eq?, #match?, …) are applied by web-tree-sitter before a match is seen here.
//
// Several patterns may match the same @name node. They describe one symbol: the lowest pattern index
// decides its kind, and @local, @doc, @container and @qualifier are taken from any of them. A pattern
// with a @name but no @definition/@reference capture only adds such details. Put the specific
// pattern before the general one.
import type { Node, Query, QueryOptions } from 'web-tree-sitter';
import type { RefKind, SymbolDef, SymbolKind, SymbolRef } from '../../contracts/lang';

/** Capture suffix → kind, with the spellings upstream tags.scm files use for the same things. */
const DEF_KINDS = new Map<string, SymbolKind>([
  ['function', 'function'], ['method', 'method'], ['class', 'class'], ['interface', 'interface'], ['type', 'type'],
  ['enum', 'enum'], ['struct', 'struct'], ['trait', 'trait'], ['module', 'module'], ['constant', 'constant'],
  ['variable', 'variable'], ['macro', 'macro'],
  ['namespace', 'module'], ['package', 'module'], ['constructor', 'method'], ['field', 'variable'], ['property', 'variable'],
  ['union', 'struct'], ['protocol', 'interface'], ['typedef', 'type'],
]);
const REF_KINDS = new Map<string, RefKind>([
  ['call', 'call'], ['type', 'type'], ['inherit', 'inherit'], ['reference', 'reference'],
  ['class', 'type'], ['implementation', 'inherit'], ['send', 'call'],
]);
/** Definitions that name what is declared inside them. */
const CONTAINER_KINDS = new Set<SymbolKind>(['class', 'interface', 'struct', 'trait', 'module', 'enum']);

/** Longest identifier kept; anything longer is not a name anyone links to. */
const MAX_NAME_CHARS = 128;
/** Wrappers a definition sits in whose start is the real start of the declaration. */
const WRAPPER_TYPES = /template|decorated/;
/** Siblings that may stand between a doc comment and its definition. */
const ATTRIBUTE_TYPES = /attribute|annotation|decorator/;
const COMMENT_TYPES = /comment/;
/** Levels a definition is followed outward to find where its declaration starts (`export const f = …`). */
const MAX_CLIMB = 4;
/** Comment nodes joined into one doc block (a run of line comments). */
const MAX_DOC_COMMENTS = 40;

export interface ExtractOptions {
  /** Caps of SymbolDef.signature and SymbolDef.doc. */
  signatureChars: number;
  docChars: number;
  /** SyntaxSpec.exported of the plug-in, when it has one. */
  exported?: (name: string, kind: SymbolKind) => boolean;
  /** Passed to the query. A progress callback that cancels it leaves a partial result; the caller decides what that is worth. */
  query?: QueryOptions;
}
export interface Extracted { defs: SymbolDef[]; refs: SymbolRef[] }

interface DefRec {
  pattern: number;
  kind: SymbolKind;
  node: Node;
  name: string;
  row: number;
  start: number;
  end: number;
  local: boolean;
  container?: string;
  doc?: Node;
}
interface RefRec { pattern: number; kind: RefKind; name: string; qualifier?: string }
interface Note { local: boolean; container?: string; doc?: Node }

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
}

function shortName(node: Node): string | undefined {
  const t = node.text;
  return t.length > 0 && t.length <= MAX_NAME_CHARS && !/\s/.test(t) ? t : undefined;
}

/** Comment or docstring text without its markers, on one line, capped. */
export function cleanDoc(raw: string, max: number): string {
  let s = raw.trim();
  const quote = /^[a-zA-Z]{0,2}("""|'''|"|'|`)/.exec(s);
  if (quote) {
    s = s.slice(quote[0].length);
    if (s.endsWith(quote[1])) s = s.slice(0, -quote[1].length);
  }
  const lines = s.split(/\r?\n/).map((line) => line.trim()
    .replace(/^\/\*+!?/, '')
    .replace(/\*+\/$/, '')
    .replace(/^(?:\/\/+!?|#+!?|--+|;+|%+|\*+)\s?/, '')
    .trim());
  return cap(lines.filter(Boolean).join(' ').replace(/\s+/g, ' '), max);
}

/** The definition node and the wrappers its declaration starts in, innermost first. */
function declarationChain(def: Node, defIds: Set<number>, text: string): Node[] {
  const chain = [def];
  let n = def;
  for (let i = 0; i < MAX_CLIMB; i++) {
    const p = n.parent;
    if (!p || !p.parent || defIds.has(p.id)) break;
    // `export`, `const`, `static` and the like sit before the definition on its own line; a body or a
    // list the definition is merely the first item of does not.
    const lead = p.startPosition.row === n.startPosition.row && /^[\w\s]*$/.test(text.slice(p.startIndex, n.startIndex));
    if (!lead && !WRAPPER_TYPES.test(p.type)) break;
    chain.push(p);
    n = p;
  }
  return chain;
}

/** The comment block that ends on the line above `node` (or above its attributes), as source text. */
function commentAbove(node: Node, text: string): string | undefined {
  let below = node;
  let p = node.previousNamedSibling;
  for (let i = 0; p && ATTRIBUTE_TYPES.test(p.type) && i < 8; i++) { below = p; p = p.previousNamedSibling; }
  if (!p || !COMMENT_TYPES.test(p.type) || p.endPosition.row < below.startPosition.row - 1) return undefined;
  const last = p;
  let first = p;
  for (let i = 1; i < MAX_DOC_COMMENTS; i++) {
    const q = first.previousNamedSibling;
    if (!q || !COMMENT_TYPES.test(q.type) || q.endPosition.row < first.startPosition.row - 1) break;
    first = q;
  }
  // A comment that trails code on its own line belongs to that code.
  const lineStart = text.lastIndexOf('\n', first.startIndex - 1) + 1;
  if (text.slice(lineStart, first.startIndex).trim() !== '') return undefined;
  return text.slice(first.startIndex, last.endIndex);
}

function signatureOf(def: DefRec, start: number, text: string, max: number): string {
  // The body is the definition's own, or that of the function it is assigned (`f = () => {…}`).
  const assigned = def.node.childForFieldName('value') ?? def.node.childForFieldName('right');
  const body = def.node.childForFieldName('body') ?? assigned?.childForFieldName('body') ?? null;
  let end = body && body.startIndex > start ? body.startIndex : def.end;
  if (!body && (def.kind === 'constant' || def.kind === 'variable')) {
    const eol = text.indexOf('\n', start);
    if (eol >= 0 && eol < end) end = eol;
  }
  // Collapse at most a few times the cap: a signature is short, a body-less definition may not be.
  const s = text.slice(start, Math.min(end, start + max * 4)).replace(/\s+/g, ' ').trim().replace(/\s*[;{,]$/, '');
  return cap(s, max);
}

/** Definitions and references of one file. */
export function extractSymbols(root: Node, query: Query, text: string, options: ExtractOptions): Extracted {
  const defs = new Map<number, DefRec>();
  const refs = new Map<number, RefRec>();
  const notes = new Map<number, Note>();
  const exported = new Set<string>();
  const ignored = new Set<number>();

  for (const m of query.matches(root, options.query)) {
    let name: Node | undefined, def: Node | undefined, ref: Node | undefined, doc: Node | undefined;
    let defKind: SymbolKind | undefined, refKind: RefKind | undefined, qualifier: string | undefined, container: string | undefined;
    let local = false, ignore = false;
    for (const c of m.captures) {
      const cn = c.name;
      if (cn === 'name') name ??= c.node;
      else if (cn === 'export') exported.add(c.node.text);
      else if (cn === 'local') local = true;
      else if (cn === 'ignore') ignore = true;
      else if (cn === 'qualifier') qualifier ??= shortName(c.node);
      else if (cn === 'container') container ??= shortName(c.node);
      else if (cn === 'doc') doc ??= c.node;
      else if (cn.startsWith('definition.')) { const k = DEF_KINDS.get(cn.slice(11)); if (k) { def = c.node; defKind = k; } }
      else if (cn.startsWith('reference.')) { ref = c.node; refKind = REF_KINDS.get(cn.slice(10)) ?? 'reference'; }
    }
    if (!name) continue;
    const key = name.startIndex;
    if (ignore) { ignored.add(key); continue; }
    if (def && defKind) {
      const text0 = shortName(name);
      if (!text0) continue;
      const had = defs.get(key);
      const rec: DefRec = !had || m.patternIndex < had.pattern
        ? { pattern: m.patternIndex, kind: defKind, node: def, name: text0, row: name.startPosition.row, start: def.startIndex, end: def.endIndex, local: had?.local ?? false, container: had?.container, doc: had?.doc }
        : had;
      rec.local ||= local;
      rec.container ??= container;
      rec.doc ??= doc;
      defs.set(key, rec);
    } else if (ref && refKind) {
      const had = refs.get(key);
      if (!had || m.patternIndex < had.pattern) {
        const text0 = shortName(name);
        if (!text0) continue;
        refs.set(key, { pattern: m.patternIndex, kind: refKind, name: text0, qualifier: qualifier ?? had?.qualifier });
      } else had.qualifier ??= qualifier;
    } else if (local || container || doc) {
      const had = notes.get(key);
      notes.set(key, { local: local || !!had?.local, container: had?.container ?? container, doc: had?.doc ?? doc });
    }
  }

  for (const key of ignored) { defs.delete(key); refs.delete(key); }

  // Definitions in source order, each with the innermost class or namespace around it.
  const list = [...defs.entries()].sort((a, b) => a[1].start - b[1].start || b[1].end - a[1].end || a[0] - b[0]);
  const defIds = new Set<number>();
  for (const [, d] of list) defIds.add(d.node.id);
  const open: DefRec[] = [];
  const out: SymbolDef[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const [key, d] of list) {
    const note = notes.get(key);
    while (open.length && open[open.length - 1].end <= d.start) open.pop();
    let container = d.container ?? note?.container;
    if (!container) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].end >= d.end) { container = open[i].name; break; }
      }
    }
    if (CONTAINER_KINDS.has(d.kind)) open.push(d);

    // One declaration reached through two name nodes is one symbol (name, kind, line), and so is a
    // run of overloads or a prototype directly followed by its definition.
    const line = `${d.name}\n${d.kind}\n${d.row}`;
    const id = `${container ?? ''}\n${d.name}\n${d.kind}`;
    if (seen.has(line) || id === previous) continue;
    seen.add(line);
    previous = id;

    const sym: SymbolDef = { name: d.name, kind: d.kind, line: d.row + 1 };
    if (container) sym.container = container;
    const isExported = options.exported ? options.exported(d.name, d.kind) : !((d.local || note?.local) && !exported.has(d.name));
    if (!isExported) sym.exported = false;
    const chain = declarationChain(d.node, defIds, text);
    const signature = signatureOf(d, chain[chain.length - 1].startIndex, text, options.signatureChars);
    if (signature) sym.signature = signature;
    const docNode = d.doc ?? note?.doc;
    let raw = docNode ? docNode.text : undefined;
    for (let i = 0; raw === undefined && i < chain.length; i++) raw = commentAbove(chain[i], text);
    const doc = raw ? cleanDoc(raw, options.docChars) : '';
    if (doc) sym.doc = doc;
    out.push(sym);
  }

  // References, counted per (name, kind, qualifier). A definition's own name is not a reference to it.
  const counted = new Map<string, SymbolRef>();
  for (const [key, r] of refs) {
    if (defs.has(key)) continue;
    const id = `${r.name}\n${r.kind}\n${r.qualifier ?? ''}`;
    const had = counted.get(id);
    if (had) had.count++;
    else counted.set(id, r.qualifier ? { name: r.name, kind: r.kind, count: 1, qualifier: r.qualifier } : { name: r.name, kind: r.kind, count: 1 });
  }
  return { defs: out, refs: [...counted.values()] };
}

/**
 * Share of the source that sits in ERROR nodes, 0..1; a MISSING token counts as one character.
 * Zero exactly when the tree has no error.
 */
export function errorShare(root: Node, errors: Query | null, length: number): number {
  if (!root.hasError) return 0;
  const total = Math.max(1, length);
  let covered = 0, end = -1;
  if (errors) {
    for (const c of errors.captures(root)) {
      const n = c.node;
      if (n.startIndex < end) continue; // inside an error already counted
      covered += Math.max(1, n.endIndex - n.startIndex);
      end = Math.max(n.endIndex, n.startIndex + 1);
    }
  }
  return Math.min(1, Math.max(covered, 1) / total);
}
