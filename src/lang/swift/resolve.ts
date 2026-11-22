// Modules and import resolution for Swift (PLAN.md §6.4).
//
// Swift has no file-level imports: the files of one module see each other with no statement at all,
// and `import X` names a whole module. So the structure comes from `scopes` — one key per module,
// which the symbol linker uses to match names between a module's files — and `resolve` stays
// deliberately sparse. A module import is not a file dependency, and an edge to every file of the
// module would bury the map; `resolve` returns at most MAX_TARGETS files, and only where one file
// is the honest target:
//   1. `import struct Core.Money`   → the file of `Core` that declares the top-level type `Money`;
//   2. a test file by name          → `MoneyTests.swift` importing `Core` → `Money.swift` in `Core`;
//   3. the module's eponymous file  → `Core/Core.swift`, the usual home of its namespace and
//                                     re-exports, as a faint stand-in for "depends on Core".
// Otherwise it returns [] and cross-module edges come from the linker (unique type names).
// System and third-party modules are not modules of the repo and resolve to nothing.
//
// Which module a file belongs to:
//   - under a Swift package (`Package.swift`): the target whose directory holds it, with target
//     names and custom `path:` values read from the manifest by a tolerant scan; a file under no
//     declared target falls back to the directory convention `Sources/<Target>/…`, `Tests/<Target>/…`;
//   - with no manifest: the first folder under the nearest Xcode project root (the folder holding
//     `*.xcodeproj`), or under the repo root.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, joinPath } from '../../shared';
import { stripSwiftComments } from './scan';

/** `import struct Module.Type` resolved to the declaring file. */
const DECLARED = 0.9;
/** A test file linked to its subject by file name. */
const TEST_SUBJECT = 0.6;
/** A plain module import standing on the module's eponymous file. */
const MODULE_FILE = 0.3;
/** Most files one import statement may resolve to. */
const MAX_TARGETS = 3;

const MANIFEST = 'Package.swift';
/** Where SwiftPM looks for a target with no `path:`, in its order. */
const SOURCE_DIRS = ['Sources', 'Source', 'src', 'srcs'];
const TEST_DIRS = ['Tests', 'Sources', 'Source', 'src', 'srcs'];
const PLUGIN_DIRS = ['Plugins'];
/** First-level folders that hold one folder per module rather than being a module. */
const CONTAINER_DIRS = new Set([...SOURCE_DIRS, ...TEST_DIRS, ...PLUGIN_DIRS]);
const TEST_SUFFIX = /(?:Tests|Test|Specs|Spec)$/;

export interface PackageTarget {
  name: string;
  kind: 'source' | 'test' | 'plugin';
  /** Custom `path:` relative to the package root. */
  path?: string;
}
export interface PackageManifest {
  name?: string;
  targets: PackageTarget[];
}

const TARGET_CALL = /\.(target|executableTarget|testTarget|macro|plugin)\s*\(/g;
const STRING_ARG = /\s*:\s*"((?:[^"\\\n]|\\.)*)"/y;
const WORD_CHAR = /\w/;
const PACKAGE_NAME = /\bPackage\s*\(\s*name\s*:\s*"([^"\\\n]+)"/;

/**
 * Target names and custom paths of a `Package.swift`, read without evaluating it: every
 * `.target(…)`-style call with a literal `name:`. Targets built in loops or from variables are
 * missed; their files fall back to the directory convention.
 */
export function parsePackageManifest(source: string): PackageManifest {
  const text = stripSwiftComments(source);
  const n = text.length;
  const byName = new Map<string, PackageTarget>();
  TARGET_CALL.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = TARGET_CALL.exec(text))) {
    const kind = hit[1] === 'testTarget' ? 'test' : hit[1] === 'plugin' ? 'plugin' : 'source';
    let name: string | undefined, path: string | undefined;
    let depth = 1;
    let i = TARGET_CALL.lastIndex;
    for (; i < n && depth > 0; i++) {
      const c = text.charCodeAt(i);
      if (c === 40 || c === 91) depth++;
      else if (c === 41 || c === 93) depth--;
      else if (c === 34) { // a string: step over it
        for (i++; i < n; i++) {
          const d = text.charCodeAt(i);
          if (d === 92) i++; else if (d === 34 || d === 10) break;
        }
      } else if (depth === 1 && (c === 110 || c === 112) && (text.startsWith('name', i) || text.startsWith('path', i)) && !WORD_CHAR.test(text[i - 1])) {
        // An argument label of the call itself; labels of nested calls (`.product(name:…)`) sit deeper.
        STRING_ARG.lastIndex = i + 4;
        const arg = STRING_ARG.exec(text);
        if (arg) {
          if (c === 110) name ??= arg[1]; else path ??= arg[1];
          i = STRING_ARG.lastIndex - 1;
        }
      }
    }
    // Resuming after the call skips `.target(name:)` dependency references nested inside it.
    TARGET_CALL.lastIndex = i;
    if (!name) continue;
    const known = byName.get(name);
    if (!known) byName.set(name, path === undefined ? { name, kind } : { name, kind, path });
    else if (known.path === undefined && path !== undefined) known.path = path;
  }
  const name = PACKAGE_NAME.exec(text)?.[1];
  const targets = [...byName.values()];
  return name ? { name, targets } : { targets };
}

/** A module name as Swift spells it: characters that cannot be in an identifier become '_'. */
const moduleName = (name: string): string => name.replace(/[^\p{L}\p{N}_]/gu, '_');

interface Root {
  dir: string;
  /** Package name from the manifest, when there is one. */
  name?: string;
}
interface Module {
  /** Scope key: 'swift:' + module name, prefixed by the root directory when that is not the repo root. */
  key: string;
  name: string;
  root: string;
  files: string[];
  byBasename?: Map<string, string[]>;
  byType?: Map<string, string[]>;
  /** The file named after the module; null when there is none. */
  own?: string | null;
}

const isManifest = (path: string): boolean => {
  const b = basename(path);
  return b === MANIFEST || (b.startsWith('Package@swift-') && b.endsWith('.swift'));
};

export function createSwiftResolver(index: RepoIndex): Resolver {
  const sources = index.byLang('swift').filter((f) => !isManifest(f.path));

  // Every directory with Swift sources somewhere beneath it.
  const sourceDirs = new Set<string>();
  for (const f of sources) {
    for (let d = dirname(f.path); !sourceDirs.has(d); d = dirname(d)) {
      sourceDirs.add(d);
      if (d === '') break;
    }
  }

  // Roots: the repo root, Xcode project folders, and package roots (which win where they coincide).
  const roots = new Map<string, Root>([['', { dir: '' }]]);
  for (const p of index.byBasename('project.pbxproj')) {
    const project = dirname(p);
    if (project.endsWith('.xcodeproj')) roots.set(dirname(project), { dir: dirname(project) });
  }
  const modules = new Map<string, Module>();
  const byName = new Map<string, Module[]>();
  const moduleAt = (root: string, rawName: string): Module => {
    const name = moduleName(rawName);
    const key = `swift:${root ? root + '/' : ''}${name}`;
    let m = modules.get(key);
    if (!m) {
      modules.set(key, (m = { key, name, root, files: [] }));
      const list = byName.get(name);
      if (list) list.push(m); else byName.set(name, [m]);
    }
    return m;
  };

  // Directories of the targets declared by package manifests.
  const targetDirs = new Map<string, Module>();
  for (const manifestPath of index.byBasename(MANIFEST)) {
    const dir = dirname(manifestPath);
    const manifest = parsePackageManifest(index.text(manifestPath) ?? '');
    roots.set(dir, manifest.name ? { dir, name: manifest.name } : { dir });
    for (const target of manifest.targets) {
      let at: string | null = null;
      if (target.path !== undefined) at = joinPath(dir, target.path);
      else {
        for (const parent of target.kind === 'test' ? TEST_DIRS : target.kind === 'plugin' ? PLUGIN_DIRS : SOURCE_DIRS) {
          const candidate = joinPath(dir, parent, target.name);
          if (candidate !== null && sourceDirs.has(candidate)) { at = candidate; break; }
        }
      }
      if (at !== null && sourceDirs.has(at) && !targetDirs.has(at)) targetDirs.set(at, moduleAt(dir, target.name));
    }
  }

  /** Module of a directory by convention: `relative` is its path below the root, '' for the root itself. */
  const conventional = (root: Root, relative: string): Module => {
    const rootName = root.name ?? (basename(root.dir) || 'main');
    if (relative === '') return moduleAt(root.dir, rootName);
    const segments = relative.split('/');
    if (!CONTAINER_DIRS.has(segments[0])) return moduleAt(root.dir, segments[0]);
    // `Sources/x.swift`, with no target folder, is the single target named after the package.
    return moduleAt(root.dir, segments[1] ?? (segments[0] === 'Tests' ? rootName + 'Tests' : rootName));
  };

  const byDir = new Map<string, Module>();
  const moduleOfDir = (dir: string): Module => {
    let m = byDir.get(dir);
    if (!m) {
      const declared = targetDirs.get(dir);
      const root = roots.get(dir);
      if (declared) m = declared;
      else if (root) m = conventional(root, '');
      else {
        // The nearest target or root above decides.
        let d = dirname(dir);
        while (!targetDirs.has(d) && !roots.has(d)) d = dirname(d);
        m = targetDirs.get(d) ?? conventional(roots.get(d)!, d ? dir.slice(d.length + 1) : dir);
      }
      byDir.set(dir, m);
    }
    return m;
  };

  const moduleOfFile = new Map<string, Module>();
  for (const f of sources) {
    const m = moduleOfDir(dirname(f.path));
    m.files.push(f.path);
    moduleOfFile.set(f.path, m);
  }

  /** The repo module an import names, seen from `own`; a name shared by several roots goes to the importer's own. */
  const imported = (name: string, own: Module | undefined): Module | undefined => {
    const list = byName.get(name);
    if (!list) return undefined;
    if (list.length === 1) return list[0];
    return own ? list.find((m) => m.root === own.root) : undefined;
  };

  const filesByType = (m: Module): Map<string, string[]> => {
    if (!m.byType) {
      m.byType = new Map();
      for (const path of m.files) {
        for (const type of index.get(path)?.decls?.classes ?? []) {
          const list = m.byType.get(type);
          if (list) list.push(path); else m.byType.set(type, [path]);
        }
      }
    }
    return m.byType;
  };
  const filesByBasename = (m: Module): Map<string, string[]> => {
    if (!m.byBasename) {
      m.byBasename = new Map();
      for (const path of m.files) {
        const b = basename(path);
        const list = m.byBasename.get(b);
        if (list) list.push(path); else m.byBasename.set(b, [path]);
      }
    }
    return m.byBasename;
  };
  /** The file named after the module, shallowest first. */
  const ownFile = (m: Module): string | null => {
    if (m.own === undefined) {
      let best: string | null = null, bestDepth = Infinity;
      for (const path of m.files) {
        const b = basename(path);
        if (moduleName(b.slice(0, -'.swift'.length)) !== m.name) continue;
        const depth = path.split('/').length;
        if (depth < bestDepth) { best = path; bestDepth = depth; }
      }
      m.own = best;
    }
    return m.own;
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const dot = imp.spec.indexOf('.');
      const own = moduleOfFile.get(file.path);
      const target = imported(dot < 0 ? imp.spec : imp.spec.slice(0, dot), own);
      if (!target || target === own) return [];

      // 1. `import struct Core.Money`: the files declaring the named top-level types.
      if (imp.names) {
        const out: ResolvedImport[] = [];
        for (const name of imp.names) {
          for (const path of filesByType(target).get(name) ?? []) {
            if (out.length < MAX_TARGETS && !out.some((r) => r.path === path)) out.push({ path, confidence: DECLARED });
          }
        }
        if (out.length) return out;
      }

      // 2. A test file and its subject: `MoneyTests.swift` importing the module that holds `Money.swift`.
      const stem = basename(file.path).replace(/\.swift$/, '');
      const subject = stem.replace(TEST_SUFFIX, '');
      if (subject && subject !== stem) {
        const hits = filesByBasename(target).get(subject + '.swift');
        if (hits && hits.length <= MAX_TARGETS) return hits.map((path) => ({ path, confidence: TEST_SUBJECT }));
      }

      // 3. The module's eponymous file stands for the module.
      const path = ownFile(target);
      return path ? [{ path, confidence: MODULE_FILE }] : [];
    },

    scopes(file: FileFacts): string[] {
      if (isManifest(file.path)) return [];
      return [(moduleOfFile.get(file.path) ?? moduleOfDir(dirname(file.path))).key];
    },

    // `import Core` makes every public symbol of Core readable from this file, without Core's files
    // seeing this one: one-way visibility instead of an import edge to each of the module's files.
    sees(file: FileFacts): string[] {
      if (isManifest(file.path)) return [];
      const own = moduleOfFile.get(file.path);
      const keys: string[] = [];
      for (const imp of file.imports) {
        const dot = imp.spec.indexOf('.');
        const target = imported(dot < 0 ? imp.spec : imp.spec.slice(0, dot), own);
        if (target && target !== own && !keys.includes(target.key)) keys.push(target.key);
      }
      return keys;
    },
  };
}
