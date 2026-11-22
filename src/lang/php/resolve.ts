// Import resolution for PHP (PLAN.md §6.4).
//
// `use A\B\C` goes through the autoload maps of every composer.json in the repo: PSR-4 (longest
// matching namespace prefix → directory, the rest of the name as a path), then PSR-0. A name those do
// not place falls back to an index of what the files themselves declare (namespace + class, then
// namespace + function, then namespace + constant), which also covers classmap autoloading and repos
// without composer. `require` / `include` paths resolve from the including file's directory.
// Framework and vendor classes that are not in the repo resolve to nothing.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';

const EXACT = 1;
/** A bare include path (`require 'lib/x.php'`) found from a directory above the including file's. */
const ANCESTOR = 0.8;
/** A name several files declare; the one nearest the importing file is kept. */
const AMBIGUOUS = 0.5;

/** Scope key prefix: files of one namespace see each other's classes without `use`. */
const SCOPE = 'php:';

type PrefixMap = Map<string, string[]>;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseJson(text: string): unknown {
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return undefined; }
}

/** Adds one composer `psr-4` / `psr-0` object (prefix → directory or directories) to `into`. */
function addPrefixes(into: PrefixMap, map: unknown, root: string, trimSeparator: boolean): void {
  const entries = asRecord(map);
  if (!entries) return;
  for (const rawPrefix of Object.keys(entries)) {
    const value = entries[rawPrefix];
    let prefix = rawPrefix.charCodeAt(0) === 92 ? rawPrefix.slice(1) : rawPrefix;
    if (trimSeparator && prefix.charCodeAt(prefix.length - 1) === 92) prefix = prefix.slice(0, -1);
    for (const dir of Array.isArray(value) ? value : [value]) {
      if (typeof dir !== 'string') continue;
      const path = joinPath(root, dir);
      if (path === null) continue; // points outside the repo
      const list = into.get(prefix);
      if (!list) into.set(prefix, [path]); else if (!list.includes(path)) list.push(path);
    }
  }
}

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export function createPhpResolver(index: RepoIndex): Resolver {
  // Autoload maps of every composer.json, with directories made repo-relative. PSR-4 prefixes are
  // keyed without their trailing backslash, so a lookup walks a name's own separators.
  const psr4: PrefixMap = new Map();
  const psr0: PrefixMap = new Map();
  for (const manifest of index.byBasename('composer.json')) {
    const text = index.text(manifest);
    const json = text === undefined ? null : asRecord(parseJson(text));
    if (!json) continue;
    const root = dirname(manifest);
    for (const section of ['autoload', 'autoload-dev']) {
      const autoload = asRecord(json[section]);
      if (!autoload) continue;
      addPrefixes(psr4, autoload['psr-4'], root, true);
      addPrefixes(psr0, autoload['psr-0'], root, false);
    }
  }

  // What the files declare, by lower-cased fully-qualified name (PHP names are case-insensitive).
  // A file with several namespaces lists each class under each of them.
  const classFiles = new Map<string, string[]>();
  const functionFiles = new Map<string, string[]>();
  const constFiles = new Map<string, string[]>();
  const declare = (into: Map<string, string[]>, prefix: string, names: readonly string[] | undefined, path: string) => {
    if (!names) return;
    for (const name of names) {
      const key = prefix + name.toLowerCase();
      const list = into.get(key);
      if (!list) into.set(key, [path]); else if (!list.includes(path)) list.push(path);
    }
  };
  for (const file of index.byLang('php')) {
    const decls = file.decls;
    if (!decls) continue;
    const spaces = decls.namespace?.length ? decls.namespace : [''];
    for (const space of spaces) {
      const prefix = space ? space.toLowerCase() + '\\' : '';
      declare(classFiles, prefix, decls.classes, file.path);
      declare(functionFiles, prefix, decls.functions, file.path);
      declare(constFiles, prefix, decls.consts, file.path);
    }
  }

  const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);

  /** The file an autoload map places a fully-qualified name in, if that file exists. */
  const autoloaded = (name: string): string | null => {
    if (psr4.size) {
      // Longest prefix first: cut the name at each backslash from the right; '' is the catch-all prefix.
      for (let cut = name.lastIndexOf('\\'); ; cut = name.lastIndexOf('\\', cut - 1)) {
        const dirs = psr4.get(cut < 0 ? '' : name.slice(0, cut));
        if (dirs) {
          const rel = name.slice(cut + 1).replace(/\\/g, '/') + '.php';
          for (const dir of dirs) if (index.has(under(dir, rel))) return under(dir, rel);
        }
        if (cut <= 0) break;
      }
    }
    if (psr0.size) {
      // PSR-0 keeps the whole name in the path, and underscores in the class name are directories too.
      const ns = name.lastIndexOf('\\');
      const rel = name.slice(0, ns + 1).replace(/\\/g, '/') + name.slice(ns + 1).replace(/_/g, '/') + '.php';
      for (const [prefix, dirs] of psr0) {
        if (!name.startsWith(prefix)) continue;
        for (const dir of dirs) if (index.has(under(dir, rel))) return under(dir, rel);
      }
    }
    return null;
  };

  const autoloadMemo = new Map<string, string | null>();
  const resolveUse = (from: string, spec: string): ResolvedImport[] => {
    const name = spec.charCodeAt(0) === 92 ? spec.slice(1) : spec;
    if (!name) return [];
    let path = autoloadMemo.get(name);
    if (path === undefined) autoloadMemo.set(name, (path = autoloaded(name)));
    if (path !== null) return [{ path, confidence: EXACT }];
    const key = name.toLowerCase();
    const declared = classFiles.get(key) ?? functionFiles.get(key) ?? constFiles.get(key);
    if (!declared) return [];
    if (declared.length === 1) return [{ path: declared[0], confidence: EXACT }];
    let best = declared[0], bestScore = -1;
    for (const candidate of declared) {
      if (candidate === from) continue;
      const score = commonSegments(from, candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return [{ path: best, confidence: AMBIGUOUS }];
  };

  const resolveInclude = (from: string, spec: string): ResolvedImport[] => {
    const dir = dirname(from);
    const direct = joinPath(dir, spec);
    if (direct !== null && index.has(direct)) return [{ path: direct, confidence: EXACT }];
    // './x' and '../x' come from `__DIR__ . '/x'`: only that one place. A bare 'lib/x.php' is looked
    // up on the include path and from the entry script's directory, which are usually ancestors.
    if (spec.charCodeAt(0) === 46) return [];
    for (let d = dir; d !== '';) {
      d = dirname(d);
      const path = joinPath(d, spec);
      if (path !== null && index.has(path)) return [{ path, confidence: ANCESTOR }];
    }
    return [];
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return [];
      const hits = imp.kind === 'require' ? resolveInclude(file.path, imp.spec) : imp.kind === 'use' ? resolveUse(file.path, imp.spec) : [];
      return hits.some((h) => h.path === file.path) ? hits.filter((h) => h.path !== file.path) : hits;
    },
    scopes(file: FileFacts): string[] {
      // Files outside any namespace get no key: the global namespace is too wide to mean "same package".
      return (file.decls?.namespace ?? []).map((space) => SCOPE + space);
    },
  };
}
