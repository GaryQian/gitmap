// Import resolution for Python (PLAN.md §6.4): dotted module → file, searched from the importing
// file's package root, its own directory, the repo root, its other ancestors, and every directory
// that holds a top-level package (`src/` layouts). Relative imports resolve inside the package.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname } from '../../shared';

/** How a module path can exist on disk, preferred first. */
const MODULE_SUFFIXES = ['.py', '/__init__.py', '.pyi', '/__init__.pyi'];
const INIT_FILES = ['__init__.py', '__init__.pyi'];

const EXACT = 1;
/** Found only under a source root unrelated to the importing file. */
const OTHER_ROOT = 0.8;
/** Found under several unrelated source roots; the nearest one is kept. */
const AMBIGUOUS_ROOT = 0.5;

const under = (dir: string, rel: string): string => (dir ? (rel ? `${dir}/${rel}` : dir) : rel);

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

export function createPythonResolver(index: RepoIndex): Resolver {
  const initOf = (dir: string): string | null => {
    for (const f of INIT_FILES) if (index.has(under(dir, f))) return under(dir, f);
    return null;
  };
  /** File of the module at `path` (no extension): 'a/b' → a/b.py or a/b/__init__.py. '' is the package at the root. */
  const moduleFile = (path: string): string | null => {
    if (!path) return initOf('');
    for (const s of MODULE_SUFFIXES) if (index.has(path + s)) return path + s;
    return null;
  };

  /**
   * Files for `module` (slash-separated, '' for the package itself) looked up under `base`. With
   * names (`from module import a, b`), each name that is a submodule resolves to that submodule and
   * the rest to the module's own file.
   */
  const lookup = (base: string, module: string, names: readonly string[] | undefined): string[] | null => {
    const full = under(base, module);
    const own = moduleFile(full);
    const out: string[] = [];
    const add = (p: string) => { if (!out.includes(p)) out.push(p); };
    let named = false;
    for (const name of names ?? []) {
      if (name === '*') continue;
      named = true;
      const sub = moduleFile(under(full, name));
      if (sub) add(sub); else if (own) add(own);
    }
    if (!named && own) add(own);
    return out.length ? out : null;
  };

  // Directories that hold a top-level package, and what each offers at its top level.
  const rootsByTopName = new Map<string, string[]>();
  const offer = (name: string, root: string) => {
    const list = rootsByTopName.get(name);
    if (!list) rootsByTopName.set(name, [root]); else if (!list.includes(root)) list.push(root);
  };
  const sourceRoots = new Set<string>();
  for (const init of index.byBasename('__init__.py')) {
    const pkg = dirname(init);
    if (pkg === '') continue;
    const parent = dirname(pkg);
    if (initOf(parent)) continue; // a subpackage
    sourceRoots.add(parent);
    offer(basename(pkg), parent);
  }
  for (const root of sourceRoots) {
    for (const p of index.inDir(root)) {
      const b = basename(p);
      if (b.endsWith('.py') && b !== '__init__.py') offer(b.slice(0, -3), root);
    }
  }

  const basesByDir = new Map<string, string[]>();
  /** Search bases for absolute imports from files in `dir`, most likely first. */
  const basesFor = (dir: string): string[] => {
    let list = basesByDir.get(dir);
    if (!list) {
      list = [];
      const add = (d: string) => { if (!list!.includes(d)) list!.push(d); };
      if (initOf(dir)) { // inside a package: the directory above its topmost package
        let d = dir;
        while (d !== '' && initOf(d)) d = dirname(d);
        add(d);
      } else add(dir); // a script: its own directory is on sys.path
      add('');
      for (let d = dir; ; d = dirname(d)) { add(d); if (d === '') break; }
      basesByDir.set(dir, list);
    }
    return list;
  };

  const resolveAbsolute = (dir: string, spec: string, names: readonly string[] | undefined): ResolvedImport[] => {
    const parts = spec.split('.');
    if (parts.some((p) => !p)) return [];
    const module = parts.join('/');
    const bases = basesFor(dir);
    for (const base of bases) {
      const hit = lookup(base, module, names);
      if (hit) return hit.map((path) => ({ path, confidence: EXACT }));
    }
    let best: string[] | null = null, bestScore = -1, found = 0;
    for (const root of rootsByTopName.get(parts[0]) ?? []) {
      if (bases.includes(root)) continue;
      const hit = lookup(root, module, names);
      if (!hit) continue;
      found++;
      const score = commonSegments(dir, root);
      if (score > bestScore) { best = hit; bestScore = score; }
    }
    if (!best) return [];
    const confidence = found === 1 ? OTHER_ROOT : AMBIGUOUS_ROOT;
    return best.map((path) => ({ path, confidence }));
  };

  const resolveRelative = (dir: string, spec: string, names: readonly string[] | undefined): ResolvedImport[] => {
    let level = 0;
    while (spec.charCodeAt(level) === 46) level++;
    let pkg = dir;
    for (let k = 1; k < level; k++) { if (pkg === '') return []; pkg = dirname(pkg); }
    const parts = spec.slice(level).split('.');
    const rest = spec.length > level ? parts.join('/') : '';
    if (spec.length > level && parts.some((p) => !p)) return [];
    return (lookup(pkg, rest, names) ?? []).map((path) => ({ path, confidence: EXACT }));
  };

  const memo = new Map<string, ResolvedImport[]>();
  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const spec = imp.spec;
      if (!spec) return [];
      const dir = dirname(file.path);
      const key = `${dir}\0${spec}\0${imp.names ? imp.names.join(',') : ''}`;
      let hits = memo.get(key);
      if (!hits) {
        hits = spec.charCodeAt(0) === 46 ? resolveRelative(dir, spec, imp.names) : resolveAbsolute(dir, spec, imp.names);
        memo.set(key, hits);
      }
      return hits.some((h) => h.path === file.path) ? hits.filter((h) => h.path !== file.path) : hits;
    },
  };
}
