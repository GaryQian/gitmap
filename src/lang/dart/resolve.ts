// Import resolution for Dart (PLAN.md §6.4): `package:` URIs through the pubspec.yaml files in the
// repo, relative URIs against the importing file's directory, and `part` / `part of` in both
// directions. `dart:` libraries and packages that are not in the repo resolve to nothing.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, joinPath } from '../../shared';

const EXACT = 1;
/** `part of some.name`, where one library declares the name but lists no such part. */
const NAME_ONLY = 0.8;
/** Several packages or libraries share the name; the nearest one is kept. */
const AMBIGUOUS = 0.5;

const NONE: ResolvedImport[] = [];
const DEP_SECTIONS = new Set(['dependencies', 'dev_dependencies', 'dependency_overrides']);
const KEY_LINE = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface Pubspec {
  name?: string;
  /** Local `path:` dependencies: package name → path as written (relative to the pubspec's directory). */
  pathDeps: Record<string, string>;
}

const unquote = (v: string): string => {
  const a = v.charCodeAt(0);
  return v.length >= 2 && (a === 34 || a === 39) && v.charCodeAt(v.length - 1) === a ? v.slice(1, -1) : v;
};

/**
 * The two things the resolver needs from a pubspec.yaml: the package name and its local path
 * dependencies. Reads line by line; it is not a YAML parser.
 */
export function readPubspec(text: string): Pubspec {
  const out: Pubspec = { pathDeps: {} };
  let section = '';
  let depIndent = -1;      // indent of the dependency names in the current section
  let dep = '';            // the dependency whose block is open
  let blockIndent = -1;    // indent of the innermost `key:` line that opened a block
  for (const rawLine of text.split('\n')) {
    const hash = rawLine.search(/(^|\s)#/);
    const line = (hash < 0 ? rawLine : rawLine.slice(0, hash)).trimEnd();
    const body = line.trimStart();
    if (!body) continue;
    const indent = line.length - body.length;
    const m = KEY_LINE.exec(body);
    if (!m) continue;
    const key = m[1], value = m[2].trim();
    if (indent === 0) {
      section = key;
      depIndent = -1;
      dep = '';
      if (key === 'name' && value && out.name === undefined) out.name = unquote(value);
      continue;
    }
    if (!DEP_SECTIONS.has(section)) continue;
    if (depIndent < 0) depIndent = indent;
    if (indent === depIndent) {
      dep = key;
      blockIndent = indent;
      const inline = /^\{.*\bpath\s*:\s*([^,}]+)/.exec(value); // shop_core: { path: ../shop_core }
      if (inline) out.pathDeps[key] = unquote(inline[1].trim());
    } else if (key === 'path' && value && dep && blockIndent === depIndent) {
      out.pathDeps[dep] = unquote(value); // directly under the dependency, not under its `git:` or `hosted:`
    } else if (!value) {
      blockIndent = indent;
    }
  }
  return out;
}

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k] && x[k] !== '') k++;
  return k;
}
/** The candidate whose directory shares the longest path prefix with `dir`. */
function nearest(dir: string, candidates: readonly string[]): string {
  let best = candidates[0], bestScore = -1;
  for (const c of candidates) {
    const score = commonSegments(dir, c);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

export function createDartResolver(index: RepoIndex): Resolver {
  // Every package in the repo: its directory, its name, its local path dependencies.
  const dirsByName = new Map<string, string[]>();
  const nameByDir = new Map<string, string>();
  const pathDepsByDir = new Map<string, Record<string, string>>();
  for (const manifest of index.byBasename('pubspec.yaml')) {
    const dir = dirname(manifest);
    const spec = readPubspec(index.text(manifest) ?? '');
    const name = spec.name ?? basename(dir); // by convention a package's folder carries its name
    if (!name) continue;
    nameByDir.set(dir, name);
    pathDepsByDir.set(dir, spec.pathDeps);
    const list = dirsByName.get(name);
    if (list) list.push(dir); else dirsByName.set(name, [dir]);
  }

  const packageOfDir = new Map<string, string | null>();
  /** Directory of the package a directory belongs to: the nearest one, going up, with a pubspec.yaml. */
  const packageOf = (dir: string): string | null => {
    let hit = packageOfDir.get(dir);
    if (hit === undefined) {
      hit = nameByDir.has(dir) ? dir : dir === '' ? null : packageOf(dirname(dir));
      packageOfDir.set(dir, hit);
    }
    return hit;
  };

  const inPackage = (pkgDir: string | null, rest: string): string | null => {
    if (pkgDir === null) return null;
    const path = joinPath(pkgDir, 'lib', rest);
    return path !== null && index.has(path) ? path : null;
  };

  /** package:<name>/<rest> → <package dir>/lib/<rest>. */
  const resolvePackage = (fromDir: string, uri: string): ResolvedImport[] => {
    const slash = uri.indexOf('/');
    if (slash < 0) return NONE;
    const name = uri.slice('package:'.length, slash);
    const rest = uri.slice(slash + 1);
    const dirs = dirsByName.get(name);
    if (!dirs || !rest) return NONE;
    // The importing file's own package first, then a path dependency it declares, then any package of that name.
    const own = packageOf(fromDir);
    if (own !== null) {
      const self = nameByDir.get(own) === name ? inPackage(own, rest) : null;
      if (self) return [{ path: self, confidence: EXACT }];
      const declared = pathDepsByDir.get(own)?.[name];
      const dep = declared === undefined ? null : inPackage(joinPath(own, declared), rest);
      if (dep) return [{ path: dep, confidence: EXACT }];
    }
    const hits: string[] = [];
    for (const dir of dirs) {
      const path = inPackage(dir, rest);
      if (path) hits.push(path);
    }
    if (hits.length === 0) return NONE;
    if (hits.length === 1) return [{ path: hits[0], confidence: EXACT }];
    return [{ path: nearest(fromDir, hits), confidence: AMBIGUOUS }];
  };

  const uriMemo = new Map<string, ResolvedImport[]>();
  const resolveUri = (fromDir: string, uri: string): ResolvedImport[] => {
    const key = `${fromDir}\0${uri}`;
    let hits = uriMemo.get(key);
    if (!hits) {
      if (uri.startsWith('package:')) hits = resolvePackage(fromDir, uri);
      else if (SCHEME.test(uri) || uri.charCodeAt(0) === 47) hits = NONE; // dart:, http:, an absolute path
      else {
        const path = joinPath(fromDir, uri);
        hits = path !== null && index.has(path) ? [{ path, confidence: EXACT }] : NONE;
      }
      uriMemo.set(key, hits);
    }
    return hits;
  };

  let librariesByName: Map<string, FileFacts[]> | undefined;
  /** `part of some.name` → the file that declares `library some.name`, preferring one that lists this file as a part. */
  const resolveLibraryName = (file: FileFacts, name: string): ResolvedImport[] => {
    if (!librariesByName) {
      librariesByName = new Map();
      for (const f of index.byLang('dart')) {
        for (const lib of f.decls?.library ?? []) {
          const list = librariesByName.get(lib);
          if (list) list.push(f); else librariesByName.set(lib, [f]);
        }
      }
    }
    const candidates = (librariesByName.get(name) ?? []).filter((f) => f.path !== file.path);
    if (candidates.length === 0) return NONE;
    const owners = candidates.filter((lib) => {
      const dir = dirname(lib.path);
      return lib.imports.some((imp) => imp.kind === 'part' && resolveUri(dir, imp.spec).some((r) => r.path === file.path));
    });
    if (owners.length) return owners.map((lib) => ({ path: lib.path, confidence: EXACT }));
    if (candidates.length === 1) return [{ path: candidates[0].path, confidence: NAME_ONLY }];
    return [{ path: nearest(dirname(file.path), candidates.map((f) => f.path)), confidence: AMBIGUOUS }];
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return NONE;
      const hits = imp.kind === 'part-of-library' ? resolveLibraryName(file, imp.spec) : resolveUri(dirname(file.path), imp.spec);
      return hits.some((h) => h.path === file.path) ? hits.filter((h) => h.path !== file.path) : hits;
    },
  };
}
