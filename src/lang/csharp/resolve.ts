// Import resolution for C# (PLAN.md §6.4). C# imports namespaces, not files, so this is fuzzy by
// nature: `using A.B` names every file that declares a type in namespace A.B, at low confidence, and
// the symbol linker narrows that by the type names a file really references. `using static A.B.C` and
// `using X = A.B.C` name one type and resolve to the file (or files, for a partial type) declaring it.
// Anything the repo does not declare (System, libraries) resolves to nothing.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname } from '../../shared';
import { GLOBAL_PREFIX, USING, USING_ALIAS } from './scan';

export const CSHARP = 'csharp';
/** Prefix of scope keys: 'cs:A.B' for namespace A.B, 'cs:' alone for the global namespace. */
export const SCOPE_PREFIX = 'cs:';

/** One `using` never yields more edges than this; a larger namespace keeps its nearest files only. */
export const NAMESPACE_CAP = 8;
/** A file of a `using` namespace: most files of a namespace are not used by any one importer. */
const NAMESPACE = 0.4;
/** Floor for files of a namespace larger than the cap, where confidence falls with its size. */
const CROWDED_FLOOR = 0.1;
/** The one file declaring the type of a `using static` or an alias. */
const TYPE = 1;
/** A file of a partial type declared across several files. */
const PARTIAL_TYPE = 0.8;

const NONE: ResolvedImport[] = [];

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k] && x[k] !== '') k++;
  return k;
}

/** The `NAMESPACE_CAP` paths nearest to `dir`: longest shared directory prefix, then shallowest, then by path. */
function nearest(paths: readonly string[], dir: string): string[] {
  const ranked = paths.map((path) => {
    const d = dirname(path);
    return { path, shared: commonSegments(dir, d), depth: d === '' ? 0 : d.split('/').length };
  });
  ranked.sort((a, b) => b.shared - a.shared || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ranked.slice(0, NAMESPACE_CAP).map((r) => r.path);
}

export function createCSharpResolver(index: RepoIndex): Resolver {
  /** Namespace → files declaring a type directly in it. */
  const namespaceFiles = new Map<string, string[]>();
  /** Fully qualified type → files declaring it (several for a partial type). */
  const typeFiles = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, key: string, path: string) => {
    const list = m.get(key);
    if (!list) m.set(key, [path]); else if (list[list.length - 1] !== path) list.push(path);
  };
  for (const f of index.byLang(CSHARP)) {
    const namespaces = f.decls?.namespace ?? [];
    const classes = f.decls?.classes ?? [];
    for (const cls of classes) push(typeFiles, cls, f.path);
    // A namespace that only wraps another one (`namespace A { namespace B { … } }`) holds no type of this file.
    const owners = new Set<string>();
    for (const cls of classes) {
      let owner = '';
      for (const ns of namespaces) if (ns.length > owner.length && cls.startsWith(ns + '.')) owner = ns;
      if (owner) owners.add(owner);
    }
    for (const ns of owners.size ? owners : namespaces) push(namespaceFiles, ns, f.path);
  }

  const memo = new Map<string, ResolvedImport[]>();
  const hitsFor = (table: Map<string, string[]>, spec: string, dir: string): ResolvedImport[] => {
    const files = table.get(spec);
    if (!files) return NONE;
    const crowded = files.length > NAMESPACE_CAP;
    const isType = table === typeFiles;
    const key = `${isType ? 't' : 'n'}\0${spec}${crowded ? '\0' + dir : ''}`;
    let hits = memo.get(key);
    if (!hits) {
      const confidence = isType
        ? (files.length === 1 ? TYPE : PARTIAL_TYPE)
        : crowded ? Math.max(CROWDED_FLOOR, (NAMESPACE * NAMESPACE_CAP) / files.length) : NAMESPACE;
      hits = (crowded ? nearest(files, dir) : files).map((path) => ({ path, confidence }));
      memo.set(key, hits);
    }
    return hits;
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return NONE;
      const kind = imp.kind.startsWith(GLOBAL_PREFIX) ? imp.kind.slice(GLOBAL_PREFIX.length) : imp.kind;
      const dir = dirname(file.path);
      let hits: ResolvedImport[];
      if (kind === USING) hits = hitsFor(namespaceFiles, imp.spec, dir);
      else {
        hits = hitsFor(typeFiles, imp.spec, dir);
        if (!hits.length && kind === USING_ALIAS) hits = hitsFor(namespaceFiles, imp.spec, dir); // an alias may name a namespace
      }
      return hits.some((h) => h.path === file.path) ? hits.filter((h) => h.path !== file.path) : hits;
    },

    scopes(file: FileFacts): string[] {
      const namespaces = file.decls?.namespace ?? [];
      const keys = namespaces.map((ns) => SCOPE_PREFIX + ns);
      // Code outside every namespace (Unity scripts, top-level programs) shares the global namespace.
      const classes = file.decls?.classes ?? [];
      if (!namespaces.length || classes.some((cls) => !namespaces.some((ns) => cls.startsWith(ns + '.')))) keys.push(SCOPE_PREFIX);
      return keys;
    },

    // Code in A.B.C reads the types of A.B and A without a using, and the types of every namespace
    // it does name in a using. Both are one-way: those namespaces do not see this file.
    sees(file: FileFacts): string[] {
      const keys = new Set<string>();
      for (const ns of file.decls?.namespace ?? []) {
        for (let dot = ns.lastIndexOf('.'); dot > 0; dot = ns.lastIndexOf('.', dot - 1)) {
          const parent = ns.slice(0, dot);
          if (namespaceFiles.has(parent)) keys.add(SCOPE_PREFIX + parent);
        }
      }
      for (const imp of file.imports) {
        const kind = imp.kind.startsWith(GLOBAL_PREFIX) ? imp.kind.slice(GLOBAL_PREFIX.length) : imp.kind;
        if (kind === USING && namespaceFiles.has(imp.spec)) keys.add(SCOPE_PREFIX + imp.spec);
      }
      for (const own of file.decls?.namespace ?? []) keys.delete(SCOPE_PREFIX + own);
      return [...keys];
    },
  };
}
