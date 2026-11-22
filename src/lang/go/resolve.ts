// Import resolution for Go (PLAN.md §6.4). An import names a package and a package is a directory:
// every go.mod in the repo gives a module path for its directory, an import path that starts with a
// module path maps to that directory plus the remainder, and the import resolves to the non-test
// .go files directly inside. Standard-library and third-party imports match no module and resolve
// to nothing.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';

/** A package with more files than this is represented by its largest ones. */
const MAX_PACKAGE_FILES = 32;
/**
 * An import is of a package, not of a file: each of the package's n files gets confidence 1/√n,
 * and no less than this. The symbol linker then strengthens the files whose symbols are used.
 */
const MIN_CONFIDENCE = 0.3;

const under = (dir: string, rel: string): string => (dir ? (rel ? `${dir}/${rel}` : dir) : rel);
const isPackageFile = (path: string): boolean => path.endsWith('.go') && !path.endsWith('_test.go');
const unquote = (word: string): string => (/^["`]/.test(word) && word.length >= 2 ? word.slice(1, -1) : word);
const isLocalPath = (p: string): boolean => p === '.' || p === '..' || p.startsWith('./') || p.startsWith('../');

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

export interface GoMod {
  /** The module path, '' when the file declares none. */
  module: string;
  /** `replace` directives whose right-hand side is a local directory, as written (`./x`, `../y`). */
  replaces: { from: string; to: string }[];
}

/** The parts of a go.mod the resolver needs. Tolerant: unknown directives and malformed lines are skipped. */
export function parseGoMod(text: string): GoMod {
  const mod: GoMod = { module: '', replaces: [] };
  let block = '';
  for (const raw of text.split('\n')) {
    const cut = raw.indexOf('//');
    const words = (cut < 0 ? raw : raw.slice(0, cut)).trim().split(/\s+/);
    if (!words[0]) continue;
    let verb = block;
    if (block) {
      if (words[0] === ')') { block = ''; continue; }
    } else {
      if (words.length === 2 && words[1] === '(') { block = words[0]; continue; }
      verb = words.shift()!;
    }
    if (verb === 'module') {
      if (!mod.module && words[0]) mod.module = unquote(words[0]);
    } else if (verb === 'replace') {
      // replace old [version] => new [version]
      const arrow = words.indexOf('=>');
      const to = arrow >= 1 && words[arrow + 1] ? unquote(words[arrow + 1]) : '';
      if (isLocalPath(to)) mod.replaces.push({ from: unquote(words[0]), to });
    }
  }
  return mod;
}

export function createGoResolver(index: RepoIndex): Resolver {
  /** Module path → directories whose go.mod declares it (one, unless the repo holds copies). */
  const modules = new Map<string, string[]>();
  /** Module directory → its local replacements as [import path prefix, directory]. */
  const replaces = new Map<string, [string, string][]>();
  for (const path of index.byBasename('go.mod')) {
    const text = index.text(path);
    if (text === undefined) continue;
    const mod = parseGoMod(text);
    if (!mod.module) continue;
    const dir = dirname(path);
    const dirs = modules.get(mod.module);
    if (dirs) dirs.push(dir); else modules.set(mod.module, [dir]);
    const local: [string, string][] = [];
    for (const r of mod.replaces) {
      const to = joinPath(dir, r.to);
      if (to !== null) local.push([r.from, to]);
    }
    replaces.set(dir, local);
  }

  const moduleByDir = new Map<string, string | null>();
  /** Directory of the nearest go.mod at or above `dir`, or null. */
  const moduleOf = (dir: string): string | null => {
    let hit = moduleByDir.get(dir);
    if (hit === undefined) {
      hit = replaces.has(dir) ? dir : dir === '' ? null : moduleOf(dirname(dir));
      moduleByDir.set(dir, hit);
    }
    return hit;
  };

  const packageName = (path: string): string | undefined => index.get(path)?.decls?.package?.[0];
  const packages = new Map<string, ResolvedImport[]>();
  /** The importable package in `dir`: its non-test .go files. Empty when the directory has none. */
  const packageAt = (dir: string): ResolvedImport[] => {
    let hit = packages.get(dir);
    if (!hit) {
      let files = index.inDir(dir).filter(isPackageFile);
      // Stray commands beside a library (generators behind `//go:build ignore`) are not what an import means.
      const library = files.filter((p) => packageName(p) !== 'main');
      if (library.length) files = library;
      if (files.length > MAX_PACKAGE_FILES) {
        const loc = (p: string): number => index.get(p)?.loc ?? 0;
        files = [...files].sort((a, b) => loc(b) - loc(a) || (a < b ? -1 : 1)).slice(0, MAX_PACKAGE_FILES);
      }
      const confidence = Math.max(MIN_CONFIDENCE, 1 / Math.sqrt(files.length));
      hit = files.map((path) => ({ path, confidence }));
      packages.set(dir, hit);
    }
    return hit;
  };

  const lookup = (fromDir: string, spec: string): ResolvedImport[] => {
    if (isLocalPath(spec)) { // legacy relative import
      const dir = joinPath(fromDir, spec);
      return dir === null ? [] : packageAt(dir);
    }
    const own = moduleOf(fromDir);
    // Local replacements of the importing module come first.
    for (const [from, to] of (own !== null && replaces.get(own)) || []) {
      if (spec !== from && !spec.startsWith(from + '/')) continue;
      const hit = packageAt(under(to, spec.slice(from.length + 1)));
      if (hit.length) return hit;
    }
    // Then the longest module path that prefixes the import; among copies, the one nearest the importer.
    for (let end = spec.length; end > 0; end = spec.lastIndexOf('/', end - 1)) {
      const dirs = modules.get(spec.slice(0, end));
      if (!dirs) continue;
      const rest = spec.slice(end + 1);
      const nearestFirst = dirs.length > 1 ? [...dirs].sort((a, b) => commonSegments(b, fromDir) - commonSegments(a, fromDir)) : dirs;
      for (const dir of nearestFirst) {
        const hit = packageAt(under(dir, rest));
        if (hit.length) return hit;
      }
    }
    // Go's own tree: packages of the module `std` are imported by bare path ('fmt', 'net/http').
    const first = spec.indexOf('/');
    if (!(first < 0 ? spec : spec.slice(0, first)).includes('.')) {
      for (const dir of modules.get('std') ?? []) {
        const hit = packageAt(under(dir, spec));
        if (hit.length) return hit;
      }
    }
    // A vendored copy, when the repo's vendor directory is part of the map (it is excluded by default).
    return packageAt(under(own ?? '', `vendor/${spec}`));
  };

  const memo = new Map<string, ResolvedImport[]>();
  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const spec = imp.spec;
      if (!spec || spec === 'C') return []; // "C" is cgo's pseudo-package
      const dir = dirname(file.path);
      const key = `${dir}\0${spec}`;
      let hits = memo.get(key);
      if (!hits) {
        hits = lookup(dir, spec);
        memo.set(key, hits);
      }
      return hits.some((h) => h.path === file.path) ? hits.filter((h) => h.path !== file.path) : hits;
    },
    // One scope per package directory. An external test package (`package x_test`) shares it.
    scopes: (file: FileFacts): string[] => [`go:${dirname(file.path)}`],
  };
}
