// Symbol linking (PLAN.md §6.4): definitions and references from the slow pass become file-level raw
// edges of kind 'call', 'reference' and 'inherit'. The bar is "good enough to show architecture":
// a reference from file A to name S links to the file that defines S when that file is
//
//   bound      the target of the import that the reference's qualifier names (`x.S`, see below)
//   named      the target of an import statement of A that lists S                      (strongest)
//   import     the target of any import statement of A, or a member of a scope A can read
//              (Resolver.sees: one-way, the Swift module or C# namespace a file uses)
//   re-export  behind a file A imports: one hop through any statement of that file that lists S,
//              lists '*' or lists nothing (`__init__.py`, umbrella headers), and on through
//              re-exporting statements (`export … from`, Dart `export` and `part`) to a capped depth
//   scope      in A's package / namespace / module (Resolver.scopes)
//   unique     the only file in the repo defining S, S not being a very common or short name (weakest)
//
// and is dropped otherwise. Reachability is judged per unit, so a header and the implementation it
// is paired with count as one place. Several candidate units on the best tier mean no edge.
//
// A qualifier is bound to one of A's imports by, in this order: a name or alias the statement lists
// (ImportSpec.names); the package its target files declare (`decls.package[0]`); the last segment of
// its specifier. In `names`, '*' and '.' mean "everything, no qualifier needed" and a lone '_' means
// the import binds nothing. A qualifier that is the class a definition sits in (`Foo.bar` → method
// bar of Foo) lifts that definition above its tier's other candidates. A Dart part (`part of`) sees
// what its library imports, so the imports of a `part-of` target count as the file's own.
//
// Everything in the per-reference path works on interned integers and reused scratch arrays; the
// only string work per reference is one Map lookup of its name (and one of its qualifier).
import type { FileFacts, ImportSpec, SyntaxFacts } from '../../contracts/lang';
import type { EdgeKind } from '../../model/types';
import { basename } from '../../shared';
import type { PairSymbols } from '../edges';
import { comparePaths } from '../order';
import type { RawEdge, ResolveResult } from '../resolve';
import type { UnitTable } from '../units';

/** Edge confidence by the tier a reference was linked on. */
export const LINK_CONFIDENCE = { named: 1, import: 0.9, reexport: 0.75, scope: 0.7, unique: 0.4 } as const;

/** A repo-wide unique name links only when it is at least this long and not one of COMMON_NAMES. */
const UNIQUE_MIN_LENGTH = 4;
const COMMON_NAMES = new Set([
  'main', 'init', '__init__', 'constructor', 'setup', 'test', 'name', 'data', 'value', 'values', 'index', 'size',
  'length', 'count', 'type', 'error', 'print', 'push', 'open', 'close', 'read', 'write', 'start', 'stop', 'update',
  'create', 'delete', 'remove', 'insert', 'clear', 'reset', 'build', 'call', 'apply', 'find', 'list', 'item', 'items',
  'keys', 'next', 'load', 'save', 'send', 'parse', 'render', 'handle', 'execute', 'process', 'format', 'string',
  'toString', 'equals', 'hashCode', 'clone', 'copy', 'default', 'self', 'this', 'result', 'status', 'state', 'config',
  'options', 'params', 'args', 'event', 'callback', 'handler', 'node', 'path', 'file', 'text', 'begin', 'empty',
]);
/** Import kinds that pass a file's symbols on to whoever imports the importer. */
const REEXPORT_KINDS: readonly string[] = ['export', 'part'];
/** Import kinds whose target's imports the importing file shares (a Dart part and its library). */
const ADOPT_KINDS: readonly string[] = ['part-of', 'part-of-library'];
/** How many re-exporting files a reference is followed through behind an import. */
const REEXPORT_DEPTH = 4;
/** Names defined more often than this are looked up from the referencing file's side (see `probe`). */
const HEAVY_NAME = 32;
/** A scope with more files than this is not searched for such a name: it would be ambiguous anyway. */
const SCOPE_PROBE_CAP = 256;
/** Above this many rows a unit's symbol tally is sorted by the engine instead of by insertion. */
const INSERTION_SORT_MAX = 96;

// Candidate levels, weakest to strongest. A reference without a qualifier prefers its own scope over
// a plain import (Go, Java: an unqualified name is the package's own); a qualified one does not.
const SCOPE_QUALIFIED = 1, REEXPORT = 2, IMPORT = 3, SCOPE = 4, SCOPE_AND_IMPORT = 5, NAMED = 6, BOUND = 7;
/** Added when the qualifier is the candidate definition's container. */
const CONTAINER_MATCH = 8;
const LEVEL_CONFIDENCE = [
  0, LINK_CONFIDENCE.scope, LINK_CONFIDENCE.reexport, LINK_CONFIDENCE.import,
  LINK_CONFIDENCE.scope, LINK_CONFIDENCE.import, LINK_CONFIDENCE.named, LINK_CONFIDENCE.import,
];
// How a qualifier was bound to an import, weakest to strongest.
const BY_SEGMENT = 1, BY_PACKAGE = 2, BY_LISTED_NAME = 3;
// What an import statement brings in.
const BINDS_NOTHING = 0, LISTED_NAMES = 1, EVERYTHING = 2;

const NO_CONTAINER = -1, UNKNOWN_CONTAINER = -2, NO_QUALIFIER = -3;
/** fileScope values besides a scope id: the file has no scope key, or several (see fileScopes). */
const NO_SCOPE = -1, MANY_SCOPES = -2;
const EDGE_KINDS: readonly EdgeKind[] = ['reference', 'call', 'inherit'];

export interface LinkResult {
  /** One raw edge per (referencing file, defining file, kind), `count` = occurrences. */
  edges: RawEdge[];
  /** Top referenced symbols per unit pair, "name:count|name:count", in (src, dst) order. */
  symbols: PairSymbols;
  /** Reference records that became part of an edge. */
  refsLinked: number;
  /** Reference records that named nothing we could pin down (references to the file's own symbols are in neither). */
  refsDropped: number;
}

/**
 * `files` is the path-ordered list `resolved` and `units` were built from. `syntax` may be in any
 * order and may cover only some files; facts for unknown paths are ignored.
 */
export function linkSymbols(
  files: readonly FileFacts[],
  syntax: readonly SyntaxFacts[],
  resolved: ResolveResult,
  units: UnitTable,
  topSymbols: number,
): LinkResult {
  const result: LinkResult = { edges: [], symbols: { src: [], dst: [], text: [] }, refsLinked: 0, refsDropped: 0 };
  const n = files.length;
  const U = units.count;
  const fileUnit = units.fileUnit;
  if (n === 0 || syntax.length === 0) return result;

  const fileIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) fileIndex.set(files[i].path, i);

  // One SyntaxFacts per file: the one for the file's current blob, else the smallest oid.
  const facts = new Array<SyntaxFacts | undefined>(n);
  for (const s of syntax) {
    const i = fileIndex.get(s.path);
    if (i === undefined) continue;
    const cur = facts[i];
    if (!cur) { facts[i] = s; continue; }
    const sm = s.oid === files[i].oid, cm = cur.oid === files[i].oid;
    if (sm !== cm ? sm : comparePaths(s.oid, cur.oid) < 0) facts[i] = s;
  }

  // ---- interning: symbol names, containers, and everything a qualifier can be bound by ----
  const nameId = new Map<string, number>();
  const names: string[] = [];
  const intern = (s: string): number => {
    let id = nameId.get(s);
    if (id === undefined) { id = names.length; nameId.set(s, id); names.push(s); }
    return id;
  };

  // Exported definitions, visited unit by unit so each name's entries end up sorted by (unit, file).
  const order = filesByUnit(fileUnit, U);
  const eName: number[] = [], eFile: number[] = [], eCont: number[] = [];
  // Every definition of each file, private ones too: they make a name the file's own.
  const ownNames: number[] = [];
  const ownFrom = new Int32Array(n), ownTo = new Int32Array(n);
  for (const f of order) {
    const s = facts[f];
    if (!s) continue;
    ownFrom[f] = ownNames.length;
    for (const d of s.defs) {
      if (!d.name) continue;
      const id = intern(d.name);
      ownNames.push(id);
      ownTo[f] = ownNames.length;
      if (d.exported === false) continue;
      eName.push(id);
      eFile.push(f);
      eCont.push(d.container ? intern(d.container) : d.kind === 'method' ? UNKNOWN_CONTAINER : NO_CONTAINER);
    }
  }

  // Resolved imports per file (CSR by importing file).
  const impStart = new Int32Array(n + 1);
  const rawSrc: number[] = [], rawDst: number[] = [], rawVia: (ImportSpec | undefined)[] = [];
  for (const e of resolved.edges) {
    if (e.kind !== 'import') continue;
    const s = fileIndex.get(e.src), d = fileIndex.get(e.dst);
    if (s === undefined || d === undefined || s === d) continue;
    rawSrc.push(s); rawDst.push(d); rawVia.push(e.via);
    impStart[s + 1]++;
  }
  const M = rawSrc.length;
  for (let i = 0; i < n; i++) impStart[i + 1] += impStart[i];
  const impDst = new Int32Array(M);
  /** BINDS_NOTHING, LISTED_NAMES or EVERYTHING. */
  const impMode = new Uint8Array(M);
  /** The names (and aliases) the statement lists. */
  const impNames = new Array<number[] | null>(M);
  /** The last segment of the specifier, or −1. */
  const impTail = new Int32Array(M);
  /** Bit 1: a re-exporting statement. Bit 2: the target's imports count as the importer's own. */
  const impKind = new Uint8Array(M);
  {
    const fill = impStart.slice(0, n);
    for (let k = 0; k < M; k++) {
      const p = fill[rawSrc[k]]++;
      impDst[p] = rawDst[k];
      const via = rawVia[k];
      const listed = via?.names;
      let ids: number[] | null = null;
      let mode = !listed || listed.length === 0 ? EVERYTHING : LISTED_NAMES;
      if (listed) {
        for (const name of listed) {
          if (name === '*' || name === '.') mode = EVERYTHING;
          else if (name !== '_' && name) (ids ??= []).push(intern(name));
        }
        if (mode === LISTED_NAMES && !ids) mode = BINDS_NOTHING; // `import _ "x"`
      }
      impMode[p] = mode;
      impNames[p] = ids;
      const tail = via ? lastSegment(via.spec) : '';
      impTail[p] = tail ? intern(tail) : -1;
      if (via) impKind[p] = (REEXPORT_KINDS.includes(via.kind) ? 1 : 0) | (ADOPT_KINDS.includes(via.kind) ? 2 : 0);
    }
  }
  /** The package a file declares (`decls.package[0]`), or −1. */
  const filePkg = new Int32Array(n).fill(-1);
  for (let k = 0; k < M; k++) {
    const t = impDst[k];
    const pkg = files[t].decls?.package?.[0];
    if (pkg && filePkg[t] < 0) filePkg[t] = intern(pkg);
  }

  // ---- definition index: name → entries, as columns ----
  const N = names.length;
  const E = eName.length;
  const start = new Int32Array(N + 1);
  for (let k = 0; k < E; k++) start[eName[k] + 1]++;
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const dFile = new Int32Array(E), dUnit = new Int32Array(E), dCont = new Int32Array(E);
  {
    const fill = start.slice(0, N);
    for (let k = 0; k < E; k++) {
      const p = fill[eName[k]]++;
      dFile[p] = eFile[k]; dUnit[p] = fileUnit[eFile[k]]; dCont[p] = eCont[k];
    }
  }
  /** Distinct units defining each name. */
  const nameUnits = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    for (let k = start[i]; k < start[i + 1]; k++) if (k === start[i] || dUnit[k] !== dUnit[k - 1]) nameUnits[i]++;
  }

  // (name, unit) → first entry, for heavy names only: an open-addressing table, so that looking a
  // heavy name up in one unit is one probe instead of a search through its entries.
  let heavyRuns = 0;
  for (let i = 0; i < N; i++) if (start[i + 1] - start[i] > HEAVY_NAME) heavyRuns += nameUnits[i];
  let hSize = 16;
  while (hSize < heavyRuns * 2) hSize *= 2;
  const hMask = hSize - 1;
  const hEntry = new Int32Array(hSize).fill(-1);
  const hash = (name: number, unit: number): number => (Math.imul(name, 0x9e3779b1) ^ Math.imul(unit, 0x85ebca6b)) & hMask;
  for (let i = 0; i < N && heavyRuns > 0; i++) {
    if (start[i + 1] - start[i] <= HEAVY_NAME) continue;
    for (let k = start[i]; k < start[i + 1]; k++) {
      if (k > start[i] && dUnit[k] === dUnit[k - 1]) continue;
      let h = hash(i, dUnit[k]);
      while (hEntry[h] >= 0) h = (h + 1) & hMask;
      hEntry[h] = k;
    }
  }

  // ---- scopes: files sharing a key see each other's symbols without importing ----
  const scopeId = new Map<string, number>();
  const scopeFiles: number[][] = [];
  /** A file's one scope id, or NO_SCOPE / MANY_SCOPES; `fileScopes` lists them all. */
  const fileScope = new Int32Array(n).fill(NO_SCOPE);
  const fileScopes = new Array<number[] | undefined>(n);
  for (let i = 0; i < n; i++) {
    if (!facts[i]) continue;
    const lang = files[i].lang;
    const resolver = lang ? resolved.resolvers.get(lang) : undefined;
    if (!resolver?.scopes) continue;
    let keys: string[] | undefined;
    try { keys = resolver.scopes(files[i]); } catch { keys = undefined; }
    if (!keys || keys.length === 0) continue;
    const ids: number[] = [];
    for (const key of keys) {
      let id = scopeId.get(key);
      if (id === undefined) { id = scopeFiles.length; scopeId.set(key, id); scopeFiles.push([]); }
      if (!ids.includes(id)) { ids.push(id); scopeFiles[id].push(i); }
    }
    fileScopes[i] = ids;
    fileScope[i] = ids.length === 1 ? ids[0] : MANY_SCOPES;
  }
  /** Scopes a file can read without being a member (Resolver.sees), where some file is a member. */
  const fileSees = new Array<number[] | undefined>(n);
  for (let i = 0; i < n && scopeFiles.length > 0; i++) {
    if (!facts[i] || facts[i]!.refs.length === 0) continue;
    const lang = files[i].lang;
    const resolver = lang ? resolved.resolvers.get(lang) : undefined;
    if (!resolver?.sees) continue;
    let keys: string[] | undefined;
    try { keys = resolver.sees(files[i]); } catch { keys = undefined; }
    if (!keys) continue;
    let ids: number[] | undefined;
    for (const key of keys) {
      const id = scopeId.get(key);
      if (id !== undefined && !ids?.includes(id)) (ids ??= []).push(id);
    }
    fileSees[i] = ids;
  }

  // ---- which languages can name each other's symbols: same language, one shared resolver, or an import between them ----
  const langId = new Map<string, number>();
  const fileLang = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const lang = files[i].lang ?? '';
    let id = langId.get(lang);
    if (id === undefined) { id = langId.size; langId.set(lang, id); }
    fileLang[i] = id;
  }
  const L = langId.size;
  const related = new Uint8Array(L * L);
  for (const [la, ia] of langId) {
    const ra = resolved.resolvers.get(la);
    for (const [lb, ib] of langId) {
      if (ia === ib || (ra !== undefined && ra === resolved.resolvers.get(lb))) related[ia * L + ib] = 1;
    }
  }
  for (let k = 0; k < M; k++) {
    const x = fileLang[rawSrc[k]], y = fileLang[rawDst[k]];
    related[x * L + y] = 1; related[y * L + x] = 1;
  }

  // ---- per-file scratch, reused; `gen` marks which entries belong to the current file ----
  const reachGen = new Int32Array(U);
  const reachLvl = new Uint8Array(U);
  const reachList: number[] = [];
  /** Files already queued for the walk behind the current file's imports. */
  const hopSeen = new Int32Array(n);
  // The walk's stack: a file, how many re-exports lie between it and the current file's import, and
  // the names that survive the statements passed on the way (null = all).
  const hopFile: number[] = [], hopDepth: number[] = [], hopNames: (number[] | null)[] = [];
  const localGen = new Int32Array(N);
  // Names listed by import statements: per name, a chain of (unit, level).
  const nmGen = new Int32Array(N), nmHead = new Int32Array(N);
  const nmNext: number[] = [], nmUnit: number[] = [], nmLvl: number[] = [];
  // What a qualifier can be bound by: per name, a chain of (unit, how).
  const bdGen = new Int32Array(N), bdHead = new Int32Array(N);
  const bdNext: number[] = [], bdUnit: number[] = [], bdHow: number[] = [];
  /** Units the current reference's qualifier is bound to carry the current `refStamp`. */
  const boundStamp = new Int32Array(U);
  const uniqueOk = new Uint8Array(N); // 0 unknown, 1 yes, 2 no
  const candUnit: number[] = [], candEntry: number[] = [];
  const fileEdges = new Map<number, RawEdge>();
  // Linked references of the unit being processed, as (target unit, name, count) rows.
  const tDst: number[] = [], tName: number[] = [], tCount: number[] = [];

  let gen = 0, a = 0, ownUnit = 0, reachN = 0, nmN = 0, bdN = 0, hopN = 0, tN = 0, refStamp = 0;
  let aScope = NO_SCOPE;
  let aSees: number[] | undefined;
  let sid = 0, qid = NO_QUALIFIER, qualified = false, bound = false, best = 0, candN = 0;

  const reach = (u: number, lvl: number): void => {
    if (u === ownUnit) return;
    if (reachGen[u] !== gen) { reachGen[u] = gen; reachLvl[u] = lvl; reachList[reachN++] = u; }
    else if (reachLvl[u] < lvl) reachLvl[u] = lvl;
  };
  const listName = (id: number, u: number, lvl: number): void => {
    if (u === ownUnit) return;
    const k = nmN++;
    nmUnit[k] = u; nmLvl[k] = lvl;
    nmNext[k] = nmGen[id] === gen ? nmHead[id] : -1;
    nmGen[id] = gen; nmHead[id] = k;
  };
  const bind = (id: number, u: number, how: number): void => {
    if (u === ownUnit) return;
    const k = bdN++;
    bdUnit[k] = u; bdHow[k] = how;
    bdNext[k] = bdGen[id] === gen ? bdHead[id] : -1;
    bdGen[id] = gen; bdHead[id] = k;
  };

  /** Take statement `e` as an import of the current file. */
  const direct = (e: number): void => {
    if (impMode[e] === BINDS_NOTHING) return;
    const t = impDst[e];
    const u = fileUnit[t];
    reach(u, IMPORT);
    const listed = impNames[e];
    if (listed) for (const id of listed) { listName(id, u, NAMED); bind(id, u, BY_LISTED_NAME); }
    if (filePkg[t] >= 0) bind(filePkg[t], u, BY_PACKAGE);
    if (impTail[e] >= 0) bind(impTail[e], u, BY_SEGMENT);
    if (hopSeen[t] !== gen) { hopSeen[t] = gen; hopFile[hopN] = t; hopDepth[hopN] = 0; hopNames[hopN] = null; hopN++; }
  };
  /** Mark what file `a` can see through its imports, and which names are its own. */
  const enter = (): void => {
    gen++;
    ownUnit = fileUnit[a];
    aScope = fileScope[a];
    aSees = fileSees[a];
    reachN = 0; nmN = 0; bdN = 0; hopN = 0;
    for (let k = ownFrom[a]; k < ownTo[a]; k++) localGen[ownNames[k]] = gen;
    hopSeen[a] = gen;
    for (let e = impStart[a]; e < impStart[a + 1]; e++) {
      direct(e);
      if (impKind[e] & 2) for (let e2 = impStart[impDst[e]]; e2 < impStart[impDst[e] + 1]; e2++) direct(e2);
    }
    // Behind each imported file: any of its statements for one hop, then re-exports only.
    while (hopN > 0) {
      hopN--;
      const t = hopFile[hopN], depth = hopDepth[hopN], filter = hopNames[hopN];
      for (let e = impStart[t]; e < impStart[t + 1]; e++) {
        const reexport = (impKind[e] & 1) !== 0;
        if (impMode[e] === BINDS_NOTHING || (depth > 0 && !reexport)) continue;
        const x = impDst[e];
        const ux = fileUnit[x];
        let passed = filter;
        if (impMode[e] === LISTED_NAMES) {
          const listed = impNames[e]!;
          passed = filter === null ? listed : listed.filter((id) => filter.includes(id));
        }
        if (passed === null) reach(ux, REEXPORT);
        else for (const id of passed) listName(id, ux, REEXPORT);
        if (reexport && depth + 1 < REEXPORT_DEPTH && hopSeen[x] !== gen && (passed === null || passed.length > 0)) {
          hopSeen[x] = gen; hopFile[hopN] = x; hopDepth[hopN] = depth + 1; hopNames[hopN] = passed; hopN++;
        }
      }
    }
  };

  /** Weigh definition entry `k` of the current name as the target of the current reference. */
  const consider = (k: number): void => {
    const u = dUnit[k];
    if (u === ownUnit) return;
    let lvl = reachGen[u] === gen ? reachLvl[u] : 0;
    if (bound && boundStamp[u] === refStamp) {
      lvl = BOUND;
    } else {
      if (lvl < NAMED && nmGen[sid] === gen) {
        for (let j = nmHead[sid]; j >= 0; j = nmNext[j]) if (nmUnit[j] === u && nmLvl[j] > lvl) lvl = nmLvl[j];
      }
      if (aSees !== undefined && lvl < IMPORT) {
        const theirs = fileScopes[dFile[k]];
        if (theirs !== undefined && intersects(aSees, theirs)) lvl = IMPORT;
      }
      if (aScope !== NO_SCOPE && lvl < NAMED) {
        const other = fileScope[dFile[k]];
        if (other === aScope ? other >= 0 || intersects(fileScopes[a]!, fileScopes[dFile[k]]!)
          : other !== NO_SCOPE && (other === MANY_SCOPES || aScope === MANY_SCOPES) && intersects(fileScopes[a]!, fileScopes[dFile[k]]!)) {
          lvl = qualified ? (lvl || SCOPE_QUALIFIED) : lvl === IMPORT ? SCOPE_AND_IMPORT : SCOPE;
        }
      }
      if (lvl === 0) return;
    }
    if (qid >= 0 && dCont[k] === qid) lvl += CONTAINER_MATCH;
    if (lvl < best) return;
    if (lvl > best) { best = lvl; candN = 0; }
    for (let c = 0; c < candN; c++) if (candUnit[c] === u) return;
    candUnit[candN] = u; candEntry[candN] = k; candN++;
  };
  /** Consider the current (heavy) name's entries in unit `u`; lo..hi are the name's entries. */
  const probe = (u: number, lo: number, hi: number): void => {
    for (let h = hash(sid, u); hEntry[h] >= 0; h = (h + 1) & hMask) {
      let k = hEntry[h];
      if (dUnit[k] !== u || k < lo || k >= hi) continue;
      for (; k < hi && dUnit[k] === u; k++) consider(k);
      return;
    }
  };
  /** May the only definition of the current name (entries lo..hi, one unit) be linked from file `a`? */
  const uniqueAllowed = (lo: number, hi: number, qualifier: string | undefined): boolean => {
    if (dUnit[lo] === ownUnit) return false;
    if (uniqueOk[sid] === 0) {
      uniqueOk[sid] = names[sid].length >= UNIQUE_MIN_LENGTH && !COMMON_NAMES.has(names[sid]) ? 1 : 2;
    }
    if (uniqueOk[sid] !== 1 || !related[fileLang[a] * L + fileLang[dFile[lo]]]) return false;
    if (!qualifier) return true;
    // `x.name` can only mean a member of something, or a function of the module called x.
    for (let k = lo; k < hi; k++) if (dCont[k] !== NO_CONTAINER) return true;
    const base = basename(files[dFile[lo]].path);
    return base === qualifier || base.startsWith(qualifier + '.');
  };

  // Files are visited unit by unit, so a unit's top symbols can be tallied in scratch and flushed
  // in (src, dst) order.
  let tallyUnit = -1;
  for (const file of order) {
    a = file;
    const s = facts[a];
    if (!s || s.refs.length === 0) continue;
    if (fileUnit[a] !== tallyUnit) {
      if (tN > 0) flushTopSymbols(result.symbols, tallyUnit, tDst, tName, tCount, tN, names, topSymbols);
      tN = 0;
      tallyUnit = fileUnit[a];
    }
    enter();
    fileEdges.clear();
    const path = files[a].path;
    for (const ref of s.refs) {
      const id = nameId.get(ref.name);
      if (id === undefined) { result.refsDropped++; continue; }
      const lo = start[id], hi = start[id + 1];
      const local = localGen[id] === gen && nmGen[id] !== gen; // the file's own symbol, not one it imports by name

      // Bind the qualifier: to an import of this file (by the strongest way any import offers), and as a container name.
      qualified = !!ref.qualifier;
      qid = NO_QUALIFIER;
      bound = false;
      let boundHow = 0;
      if (qualified && lo < hi) {
        const q = nameId.get(ref.qualifier!);
        if (q !== undefined) {
          qid = q;
          if (bdGen[q] === gen) {
            for (let j = bdHead[q]; j >= 0; j = bdNext[j]) if (bdHow[j] > boundHow) boundHow = bdHow[j];
            refStamp++;
            for (let j = bdHead[q]; j >= 0; j = bdNext[j]) if (bdHow[j] === boundHow) boundStamp[bdUnit[j]] = refStamp;
            bound = true;
          }
        }
      }
      if (local && !bound) continue;
      if (lo === hi) { result.refsDropped++; continue; }

      sid = id;
      best = 0; candN = 0;
      if (hi - lo <= HEAVY_NAME) {
        for (let k = lo; k < hi; k++) consider(k);
      } else {
        // A name defined all over the repo: look only where this file can see.
        for (let r = 0; r < reachN; r++) probe(reachList[r], lo, hi);
        if (nmGen[id] === gen) for (let j = nmHead[id]; j >= 0; j = nmNext[j]) probe(nmUnit[j], lo, hi);
        if (aScope !== NO_SCOPE) {
          for (const sc of fileScopes[a]!) {
            const mates = scopeFiles[sc];
            if (mates.length <= SCOPE_PROBE_CAP) for (const g of mates) probe(fileUnit[g], lo, hi);
          }
        }
        if (aSees !== undefined) {
          for (const sc of aSees) {
            const members = scopeFiles[sc];
            if (members.length <= SCOPE_PROBE_CAP) for (const g of members) probe(fileUnit[g], lo, hi);
          }
        }
      }
      const tier = best & 7;
      if (local && tier !== BOUND) continue; // `x.name` where x is not the import after all: the file's own

      let target = -1, confidence = 0;
      if (candN === 1) {
        target = candEntry[0];
        confidence = tier === BOUND && boundHow === BY_LISTED_NAME ? LINK_CONFIDENCE.named : LEVEL_CONFIDENCE[tier];
      } else if (candN === 0 && nameUnits[id] === 1 && uniqueAllowed(lo, hi, ref.qualifier)) {
        target = lo;
        confidence = LINK_CONFIDENCE.unique;
      }
      if (target < 0) { result.refsDropped++; continue; }

      const f = dFile[target];
      const count = ref.count > 0 ? ref.count : 1;
      const kind = ref.kind === 'call' ? 1 : ref.kind === 'inherit' ? 2 : 0;
      const edge = fileEdges.get(f * 3 + kind);
      if (edge) {
        edge.count! += count;
        if (confidence > edge.confidence) edge.confidence = confidence;
      } else {
        const fresh: RawEdge = { src: path, dst: files[f].path, kind: EDGE_KINDS[kind], confidence, count };
        fileEdges.set(f * 3 + kind, fresh);
        result.edges.push(fresh);
      }
      tDst[tN] = dUnit[target]; tName[tN] = id; tCount[tN] = count; tN++;
      result.refsLinked++;
    }
  }
  if (tN > 0) flushTopSymbols(result.symbols, tallyUnit, tDst, tName, tCount, tN, names, topSymbols);
  return result;
}

/**
 * Fold one unit's linked references (rows 0..rows-1) into "name:count|name:count" per target unit:
 * most referenced first, ties by name, at most `top` names. Appended to `out` in target order.
 */
function flushTopSymbols(
  out: PairSymbols, unit: number,
  dst: number[], name: number[], count: number[], rows: number,
  names: readonly string[], top: number,
): void {
  // Order the rows by (target, name); a unit rarely has more than a few dozen.
  const idx = new Int32Array(rows);
  if (rows <= INSERTION_SORT_MAX) {
    for (let i = 0; i < rows; i++) {
      let j = i;
      for (; j > 0; j--) {
        const p = idx[j - 1];
        if (dst[p] < dst[i] || (dst[p] === dst[i] && name[p] <= name[i])) break;
        idx[j] = p;
      }
      idx[j] = i;
    }
  } else {
    for (let i = 0; i < rows; i++) idx[i] = i;
    idx.sort((x, y) => dst[x] - dst[y] || name[x] - name[y]);
  }
  const mName: number[] = [], mCount: number[] = [];
  for (let i = 0; i < rows;) {
    const d = dst[idx[i]];
    let m = 0;
    for (; i < rows && dst[idx[i]] === d; i++) {
      const r = idx[i];
      if (m > 0 && mName[m - 1] === name[r]) mCount[m - 1] += count[r];
      else { mName[m] = name[r]; mCount[m] = count[r]; m++; }
    }
    // Take the best `top` by repeated selection: groups are small. A name that holds the
    // separator (C++ `operator|`) cannot be encoded and is passed over.
    let text = '';
    for (let k = 0, taken = 0; taken < top && k < m; k++) {
      let b = k;
      for (let j = k + 1; j < m; j++) {
        if (mCount[j] > mCount[b] || (mCount[j] === mCount[b] && comparePaths(names[mName[j]], names[mName[b]]) < 0)) b = j;
      }
      const bn = mName[b], bc = mCount[b];
      mName[b] = mName[k]; mCount[b] = mCount[k];
      mName[k] = bn; mCount[k] = bc;
      if (names[bn].includes('|')) continue;
      text += (taken++ ? '|' : '') + names[bn] + ':' + bc;
    }
    out.src.push(unit); out.dst.push(d); out.text.push(text);
  }
}

/** File indices ordered by (unit, file). */
function filesByUnit(fileUnit: Int32Array, unitCount: number): Int32Array {
  const start = new Int32Array(unitCount + 1);
  for (let i = 0; i < fileUnit.length; i++) start[fileUnit[i] + 1]++;
  for (let u = 0; u < unitCount; u++) start[u + 1] += start[u];
  const out = new Int32Array(fileUnit.length);
  for (let i = 0; i < fileUnit.length; i++) out[start[fileUnit[i]]++] = i;
  return out;
}

function intersects(x: readonly number[], y: readonly number[]): boolean {
  for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) if (x[i] === y[j]) return true;
  return false;
}

/**
 * The name an import specifier most likely binds: its last segment after '/', '\', '::' or '.',
 * without a file extension. './util/format.js' → 'format', 'os.path' → 'path', 'a::b' → 'b'.
 */
function lastSegment(spec: string): string {
  const cut = Math.max(spec.lastIndexOf('/'), spec.lastIndexOf('\\'), spec.lastIndexOf(':'));
  const tail = spec.slice(cut + 1);
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return tail;
  // After a path separator a dot starts an extension; in a dotted module name it separates segments.
  return cut >= 0 && dot > 0 ? tail.slice(0, dot) : tail.slice(dot + 1);
}
