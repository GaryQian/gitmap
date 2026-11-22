// Import resolution for Rust (PLAN.md §6.4): crate roots from every Cargo.toml, the module tree
// grown from them by following `mod` declarations, then `use` paths walked through that tree.
//
// - `mod x;` → the file that defines module `x` (x.rs, x/mod.rs, or its `#[path]`).
// - `use` / qualified paths → walk from `crate`, `self`, `super`, a child module, or another crate
//   of the repo (by library or package name, hyphens as underscores, dependency renames applied) to
//   the deepest module that exists. What is left of the path is an item of that module, so the edge
//   goes to that module's file — or, when the module only re-exports the name with a `use` of its
//   own, to the file the re-export leads to.
// - Paths into crates that are not in the repo (std, dependencies) resolve to nothing.
//
// Files no crate root reaches (tests/, examples/, benches/, src/bin/, build.rs, a folder with no
// Cargo.toml) become roots of their own, so their `mod` declarations still resolve.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, joinPath } from '../../shared';
import { readManifest, crateName, type Manifest } from './cargo';

/** A `pub use` chain is followed this many steps before the re-exporting file is taken as the target. */
const MAX_REEXPORT_STEPS = 4;
/** Basenames whose child modules sit in the same directory (Rust's "mod-rs" files). */
const DIR_OWNERS = new Set(['mod.rs', 'lib.rs', 'main.rs', 'build.rs']);

interface Crate {
  root: Mod;
  /** The package the root belongs to, when a Cargo.toml covers it. */
  manifest: Manifest | null;
  /** Files already grown into this crate's tree. */
  seen: Set<string>;
  /** For a stray root: the package's library or main crate, tried when `crate::x` finds nothing here. */
  fallback: Mod | null;
}
interface Mod {
  name: string;
  file: string;
  /** Directory that holds this module's child module files. */
  dir: string;
  /** A second directory to try, for a stray root: it may be an ordinary module file or a Cargo target. */
  altDir: string | null;
  /** Declared with a body inside `file`, not a file of its own. */
  inline: boolean;
  parent: Mod | null;
  crate: Crate;
  children: Map<string, Mod>;
  /** Names this module re-exports → the files they come from (filled on demand). */
  reexports: Map<string, string[] | null> | null;
}

const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export function createRustResolver(index: RepoIndex): Resolver {
  const isRust = (path: string): boolean => index.get(path)?.lang === 'rust';

  // ---- manifests ----
  const manifests = new Map<string, Manifest>();
  for (const path of index.byBasename('Cargo.toml')) manifests.set(dirname(path), readManifest(dirname(path), index.text(path)));
  const packageByDir = new Map<string, Manifest | null>();
  /** The nearest package manifest at or above `dir`. */
  const packageOf = (dir: string): Manifest | null => {
    let hit = packageByDir.get(dir);
    if (hit === undefined) {
      const own = manifests.get(dir);
      hit = own && own.packageName !== null ? own : dir === '' ? null : packageOf(dirname(dir));
      packageByDir.set(dir, hit);
    }
    return hit;
  };
  const workspaceOf = (m: Manifest): Manifest['workspace'] => {
    for (let dir = m.dir; ; dir = dirname(dir)) {
      const ws = manifests.get(dir)?.workspace;
      if (ws) return ws;
      if (dir === '') return null;
    }
  };
  const editionCache = new Map<Manifest, boolean>();
  /** In the 2015 edition a `use` path starts at the crate root. */
  const is2015 = (m: Manifest | null): boolean => {
    if (!m || !m.known) return false;
    let hit = editionCache.get(m);
    if (hit === undefined) {
      const edition = m.edition === 'workspace' ? workspaceOf(m)?.edition ?? '2021' : m.edition ?? '2015';
      editionCache.set(m, (hit = edition === '2015'));
    }
    return hit;
  };

  // ---- module tree ----
  const modsOfFile = new Map<string, Mod[]>();
  /** Library crates by crate name and by package name. */
  const libs = new Map<string, Mod[]>();
  const primaryOfPackage = new Map<Manifest, Mod>();

  const register = (m: Mod) => {
    const list = modsOfFile.get(m.file);
    if (list) list.push(m); else modsOfFile.set(m.file, [m]);
  };
  const makeMod = (name: string, file: string, dir: string, inline: boolean, parent: Mod | null, crate: Crate): Mod =>
    ({ name, file, dir, altDir: null, inline, parent, crate, children: new Map(), reexports: null });

  /** The inline module at `segs` below `m`; created on the way when `create`. */
  const inlineChild = (m: Mod, segs: readonly string[], create: boolean): Mod | null => {
    let cur = m;
    for (const seg of segs) {
      let next = cur.children.get(seg);
      if (!next) {
        if (!create) return null;
        next = makeMod(seg, cur.file, under(cur.dir, seg), true, cur, cur.crate);
        next.altDir = cur.altDir === null ? null : under(cur.altDir, seg);
        cur.children.set(seg, next);
      }
      cur = next;
    }
    return cur;
  };

  /** Files that `mod <name>;` (written in `facts`, inside module `parent`) can load, each with its child directory. */
  const declFiles = (parent: Mod, facts: FileFacts, spec: string, name: string): { file: string; dir: string }[] => {
    const out: { file: string; dir: string }[] = [];
    const prefix = spec + '=';
    for (const entry of facts.decls?.modPath ?? []) {
      if (!entry.startsWith(prefix)) continue;
      // `#[path]` is relative to the declaring file's directory, or to the inline module's own.
      const file = joinPath(parent.inline ? parent.dir : dirname(parent.file), entry.slice(prefix.length));
      if (file !== null && isRust(file) && !out.some((o) => o.file === file)) out.push({ file, dir: dirname(file) });
    }
    if (out.length) return out;
    for (const dir of parent.altDir === null ? [parent.dir] : [parent.dir, parent.altDir]) {
      for (const file of [under(dir, `${name}.rs`), under(dir, `${name}/mod.rs`)]) {
        if (isRust(file)) return [{ file, dir: under(dir, name) }];
      }
    }
    return out;
  };

  /** Grows the tree below a file-level module by following the `mod` declarations of its file, and of theirs. */
  const grow = (start: Mod) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      const facts = index.get(cur.file);
      if (!facts) continue;
      for (const path of facts.decls?.mod ?? []) inlineChild(cur, path.split('::'), true);
      const done = new Set<string>();
      for (const imp of facts.imports) {
        if (imp.kind !== 'mod' || done.has(imp.spec)) continue;
        done.add(imp.spec);
        const segs = imp.spec.split('::');
        const name = segs.pop()!;
        const parent = inlineChild(cur, segs, true)!;
        for (const { file, dir } of declFiles(parent, facts, imp.spec, name)) {
          const child = makeMod(name, file, dir, false, parent, cur.crate);
          if (!parent.children.has(name)) parent.children.set(name, child);
          register(child);
          if (!cur.crate.seen.has(file)) { cur.crate.seen.add(file); stack.push(child); }
        }
      }
    }
  };

  /**
   * A crate rooted at `file`. A declared root keeps its child modules beside it. A stray one that is
   * not a mod-rs file looks in the directory named after it first (as an ordinary module would) and
   * beside it second (as a Cargo target would).
   */
  const makeRoot = (file: string, stray: boolean): Mod => {
    const manifest = packageOf(dirname(file));
    const crate = { manifest, seen: new Set([file]), fallback: stray && manifest ? primaryOfPackage.get(manifest) ?? null : null } as Crate;
    const name = basename(file).replace(/\.rs$/, '');
    const root = makeMod(name, file, dirname(file), false, null, crate);
    if (stray && !DIR_OWNERS.has(basename(file))) { root.dir = under(dirname(file), name); root.altDir = dirname(file); }
    crate.root = root;
    return root;
  };
  const addRoot = (file: string, stray: boolean): Mod | null => {
    if (!isRust(file) || modsOfFile.has(file)) return null;
    const root = makeRoot(file, stray);
    register(root);
    grow(root);
    return root;
  };

  // Libraries first, so a module shared by a library and a binary counts as the library's.
  const packages = [...manifests.values()].filter((m) => m.packageName !== null).sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  const inPackage = (m: Manifest, rel: string): string | null => joinPath(m.dir, rel);
  for (const m of packages) {
    const file = inPackage(m, m.libPath ?? 'src/lib.rs');
    const root = file === null ? null : addRoot(file, false);
    if (!root) continue;
    primaryOfPackage.set(m, root);
    for (const key of new Set([m.libName ?? crateName(m.packageName!), crateName(m.packageName!)])) {
      const list = libs.get(key);
      if (list) list.push(root); else libs.set(key, [root]);
    }
  }
  for (const m of packages) {
    for (const rel of ['src/main.rs', ...m.targetPaths]) {
      const file = inPackage(m, rel);
      const root = file === null ? null : addRoot(file, false);
      if (root && !primaryOfPackage.has(m)) primaryOfPackage.set(m, root);
    }
  }
  // Everything still unreached: a file no other unreached file declares is a root; then whatever is left.
  const unreached = () => index.byLang('rust').map((f) => f.path).filter((p) => !modsOfFile.has(p)).sort();
  const strays = unreached();
  const declared = new Set<string>();
  for (const path of strays) {
    const facts = index.get(path)!;
    const probe = makeRoot(path, true);
    for (const imp of facts.imports) {
      if (imp.kind !== 'mod') continue;
      const segs = imp.spec.split('::');
      const name = segs.pop()!;
      for (const { file } of declFiles(inlineChild(probe, segs, true)!, facts, imp.spec, name)) if (file !== path) declared.add(file);
    }
  }
  for (const path of strays) if (!declared.has(path)) addRoot(path, true);
  for (const path of unreached()) addRoot(path, true);

  // ---- paths ----
  /** A crate of the repo by the name code uses for it, from the point of view of `from`. */
  const crateByName = (name: string, from: Mod): Mod | null => {
    const manifest = from.crate.manifest;
    const real = manifest?.renames.get(name) ?? (manifest ? workspaceOf(manifest)?.renames.get(name) : undefined) ?? name;
    const list = libs.get(real);
    if (!list) return null;
    let best = list[0], bestScore = -1;
    if (list.length > 1) {
      for (const lib of list) {
        const score = commonSegments(lib.file, from.file);
        if (score > bestScore) { best = lib; bestScore = score; }
      }
    }
    return best;
  };

  /** Files a name re-exported by `m` comes from, or null when `m` has no `use` that names it. */
  const reexported = (m: Mod, name: string, step: number): string[] | null => {
    if (m.inline || step >= MAX_REEXPORT_STEPS) return null;
    const known = m.reexports?.get(name);
    if (known !== undefined) return known;
    let hit: string[] | null = null;
    for (const imp of index.get(m.file)?.imports ?? []) {
      if (imp.kind !== 'use' || !imp.names || !imp.names.includes(name)) continue;
      const files = resolvePath(m, imp.spec, [name], true, step + 1).filter((p) => p !== m.file);
      if (files.length) { hit = files; break; }
    }
    (m.reexports ??= new Map()).set(name, hit);
    return hit;
  };

  /**
   * Files for the module path `spec` seen from `from`, and for `names` inside it. `relative` allows a
   * first segment that is a module in scope (a `use`); without it only crates and keywords start a path.
   */
  const resolvePath = (from: Mod, spec: string, names: readonly string[] | undefined, relative: boolean, step: number): string[] => {
    const segs = spec.split('::');
    const head = segs[0];
    let m: Mod | null = null;
    let at = 1;
    if (head === '') {
      m = crateByName(segs[1] ?? '', from);
      at = 2;
    } else if (head === 'crate') {
      m = from.crate.root;
      const next = segs.length > 1 ? segs[1] : names?.length === 1 ? names[0] : undefined;
      const fallback = from.crate.fallback;
      if (fallback && next !== undefined && !m.children.has(next) && fallback.children.has(next)) m = fallback;
    } else if (head === 'self') {
      m = from;
    } else if (head === 'super') {
      m = from;
      for (at = 0; m && segs[at] === 'super'; at++) m = m.parent;
    } else {
      const root = from.crate.root;
      if (relative && (is2015(from.crate.manifest) ? root : from).children.has(head)) {
        m = is2015(from.crate.manifest) ? root : from;
        at = 0;
      } else m = crateByName(head, from);
    }
    if (!m) return [];
    for (; at < segs.length; at++) {
      const child = m.children.get(segs[at]);
      if (!child) break;
      m = child;
    }
    if (at < segs.length) return reexported(m, segs[at], step) ?? [m.file]; // the rest names an item of `m`
    if (!names || names.length === 0) return [m.file];
    const out: string[] = [];
    const add = (p: string) => { if (!out.includes(p)) out.push(p); };
    for (const name of names) {
      const child = name === '*' ? undefined : m.children.get(name);
      if (child) add(child.file);
      else for (const p of (name === '*' ? null : reexported(m, name, step)) ?? [m.file]) add(p);
    }
    return out;
  };

  const exact = (paths: readonly string[], self: string): ResolvedImport[] => {
    const out: ResolvedImport[] = [];
    for (const path of paths) if (path !== self && !out.some((o) => o.path === path)) out.push({ path, confidence: 1 });
    return out;
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const from = modsOfFile.get(file.path)?.[0];
      if (!from || !imp.spec) return [];
      switch (imp.kind) {
        case 'mod': {
          const segs = imp.spec.split('::');
          const name = segs.pop()!;
          const parent = inlineChild(from, segs, false);
          return parent ? exact(declFiles(parent, file, imp.spec, name).map((d) => d.file), file.path) : [];
        }
        case 'use': return exact(resolvePath(from, imp.spec, imp.names, true, 0), file.path);
        case 'path': return exact(resolvePath(from, imp.spec, imp.names, false, 0), file.path);
        case 'extern-crate': {
          const lib = crateByName(imp.spec, from);
          return lib ? exact([lib.file], file.path) : [];
        }
        default: return [];
      }
    },
  };
}
