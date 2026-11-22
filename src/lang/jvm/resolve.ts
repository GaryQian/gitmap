// Import resolution for Java, Kotlin and Scala (PLAN.md §6.4). The three share one namespace, so
// one index of package → files and qualified name → declaring file serves them all: a Kotlin file
// importing a Java or Scala class resolves like any other import. Built from the scanners' `decls`.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, extname } from '../../shared';

export const JVM_LANGS = ['java', 'kotlin', 'scala'] as const;

const EXACT = 1;
/** Several files declare the same qualified name (source sets, flavours): the nearest is kept. */
const AMBIGUOUS = 0.7;
/** A Scala import that only resolves relative to an enclosing package. */
const RELATIVE = 0.9;
/** A wildcard import: every file of the package might be meant. */
const WILDCARD = 0.5;
/** Most files one wildcard import links to; a larger package keeps the nearest ones at a confidence scaled down by its size. */
const WILDCARD_CAP = 16;
const WILDCARD_FLOOR = 0.1;
/** Most files one imported top-level function name links to (overloads spread over files). */
const MEMBER_CAP = 4;
/** Extensions of scripts, which belong to no package. */
const SCRIPT_EXTENSIONS = new Set(['kts', 'sc']);

const packageOf = (file: FileFacts): string => file.decls?.package?.[0] ?? '';

function stem(path: string): string {
  const base = basename(path);
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

/** `paths` ordered by how much of their directory they share with `dir`, nearest first; path order breaks ties. */
function nearestFirst(paths: readonly string[], dir: string): string[] {
  return paths
    .map((path) => ({ path, score: commonSegments(dir, dirname(path)) }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => e.path);
}

function createJvmResolver(index: RepoIndex): Resolver {
  const packages = new Map<string, string[]>(); // package → files
  const types = new Map<string, string[]>();    // qualified type name → declaring files
  const members = new Map<string, string[]>();  // qualified top-level function or property → declaring files
  const push = (map: Map<string, string[]>, key: string, path: string): void => {
    const list = map.get(key);
    if (!list) map.set(key, [path]); else if (!list.includes(path)) list.push(path);
  };

  for (const lang of JVM_LANGS) {
    for (const file of index.byLang(lang)) {
      const pkg = packageOf(file);
      const qualify = (name: string): string => (pkg ? `${pkg}.${name}` : name);
      if (pkg || !SCRIPT_EXTENSIONS.has(extname(file.path))) push(packages, pkg, file.path);
      let classes = file.decls?.classes ?? [];
      // A Java file is named after its public type.
      if (classes.length === 0 && lang === 'java' && !/^(package|module)-info$/.test(stem(file.path))) classes = [stem(file.path)];
      for (const name of classes) push(types, qualify(name), file.path);
      const own = file.decls?.members ?? [];
      for (const name of own) push(members, qualify(name), file.path);
      // Java sees a Kotlin file's top-level functions as static members of `<File>Kt`.
      if (lang === 'kotlin' && own.length) {
        const s = stem(file.path);
        push(types, qualify(s.charAt(0).toUpperCase() + s.slice(1) + 'Kt'), file.path);
      }
    }
  }

  const pick = (files: readonly string[], dir: string): ResolvedImport[] =>
    files.length === 1 ? [{ path: files[0], confidence: EXACT }] : [{ path: nearestFirst(files, dir)[0], confidence: AMBIGUOUS }];

  const wildcardMemo = new Map<string, ResolvedImport[]>();
  /** Everything `import target.*` brings in: the type's own file, or the files of the package. */
  const wildcard = (target: string, dir: string): ResolvedImport[] => {
    const key = `${dir}\0${target}`;
    let hits = wildcardMemo.get(key);
    if (hits) return hits;
    hits = [];
    const owner = types.get(target);
    if (owner) hits.push(...pick(owner, dir)); // members of a class, an object or an enum
    const files = packages.get(target);
    if (files) {
      const capped = files.length > WILDCARD_CAP;
      const confidence = capped ? Math.max(WILDCARD_FLOOR, (WILDCARD * WILDCARD_CAP) / files.length) : WILDCARD;
      for (const path of capped ? nearestFirst(files, dir).slice(0, WILDCARD_CAP) : files) {
        if (!hits.some((h) => h.path === path)) hits.push({ path, confidence });
      }
    }
    wildcardMemo.set(key, hits);
    return hits;
  };

  /** Files declaring the fully-qualified `name`: a type, a top-level function, a package, or a member of a type. */
  const lookup = (name: string, dir: string): ResolvedImport[] => {
    const type = types.get(name);
    if (type) return pick(type, dir);
    const member = members.get(name);
    if (member) {
      if (member.length === 1) return [{ path: member[0], confidence: EXACT }];
      return nearestFirst(member, dir).slice(0, MEMBER_CAP).map((path) => ({ path, confidence: AMBIGUOUS }));
    }
    if (packages.has(name)) return wildcard(name, dir); // Scala `import a.b`, then `b.C` in the code
    // A static or member import (`a.b.C.m`, `a.b.Outer.Inner`): the nearest enclosing name that is a
    // type. Reaching a package of the repo first means the name is not declared here (generated code).
    for (let owner = name; ;) {
      const dot = owner.lastIndexOf('.');
      if (dot < 0) return [];
      owner = owner.slice(0, dot);
      const files = types.get(owner);
      if (files) return pick(files, dir);
      if (packages.has(owner)) return [];
    }
  };

  const resolveFrom = (prefix: string, imp: ImportSpec, dir: string): ResolvedImport[] => {
    const spec = prefix ? `${prefix}.${imp.spec}` : imp.spec;
    if (!imp.names) return lookup(spec, dir);
    const hits: ResolvedImport[] = [];
    for (const name of imp.names) {
      for (const hit of name === '*' ? wildcard(spec, dir) : lookup(`${spec}.${name}`, dir)) {
        const seen = hits.find((h) => h.path === hit.path);
        if (!seen) hits.push({ path: hit.path, confidence: hit.confidence }); // a copy: wildcard lists are memoised
        else if (hit.confidence > seen.confidence) seen.confidence = hit.confidence;
      }
    }
    return hits;
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return [];
      const dir = dirname(file.path);
      let hits = resolveFrom('', imp, dir);
      if (hits.length === 0 && file.lang === 'scala') {
        // Scala resolves an import against the enclosing packages too: in `a.b.c`, `import d.E` may be `a.b.d.E`.
        for (let pkg = packageOf(file); pkg && hits.length === 0; pkg = pkg.slice(0, Math.max(0, pkg.lastIndexOf('.')))) {
          hits = resolveFrom(pkg, imp, dir).map((h) => ({ path: h.path, confidence: h.confidence * RELATIVE }));
        }
      }
      // Copies again: a lone wildcard returns its memoised list.
      return hits.filter((h) => h.path !== file.path).map((h) => ({ path: h.path, confidence: h.confidence }));
    },
    scopes(file: FileFacts): string[] {
      const pkg = packageOf(file);
      if (pkg) return [`jvm:${pkg}`];
      // The unnamed package: only files side by side share it, and scripts share nothing.
      return SCRIPT_EXTENSIONS.has(extname(file.path)) ? [] : [`jvm:@${dirname(file.path)}`];
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The JVM resolver for an index; one instance serves the Java, Kotlin and Scala plug-ins. */
export function jvmResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createJvmResolver(index)));
  return r;
}
