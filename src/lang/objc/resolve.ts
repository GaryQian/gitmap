// Import resolution for Objective-C (PLAN.md §6.4). `#import` and `#include` go to the C-family
// include resolver, so C, C++ and Objective-C keep one header namespace. `@import Module;` resolves
// only when the module is plainly in the repo: a module map declares it, or its umbrella header sits
// where the convention puts it. System modules (Foundation, UIKit) match neither and resolve to nothing.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';
import { blankComments, includeResolver } from '../cfamily';
import { MODULE_IMPORT } from './scan';

/** Basename pattern of module maps; the plug-in lists it under `manifests` so their text is kept. */
export const MODULE_MAPS = '*.modulemap';

const CONFIDENCE = {
  /** The umbrella header a module map names. */
  mapUmbrella: 0.9,
  /** One of several headers a module map lists. */
  mapHeader: 0.6,
} as const;

/** Where an umbrella header conventionally sits, as include paths matched by suffix. */
const UMBRELLA_LAYOUTS: ((module: string) => string)[] = [
  (m) => `${m}/${m}.h`,
  (m) => `${m}.framework/Headers/${m}.h`,
  (m) => `${m}/include/${m}.h`,
];

/** A header named in a module map: beside the map, or in a framework's Headers folder. */
function mapHeaderPath(index: RepoIndex, mapDir: string, header: string): string | undefined {
  for (const base of ['.', '../Headers', '../PrivateHeaders', 'Headers']) {
    const p = joinPath(mapDir, base, header);
    if (p && index.has(p)) return p;
  }
  return undefined;
}

/** Module name → the headers its module maps name. Reads every `*.modulemap` whose text was kept. */
function readModuleMaps(index: RepoIndex): Map<string, ResolvedImport[]> {
  const modules = new Map<string, ResolvedImport[]>();
  for (const file of index.files) {
    if (!file.path.endsWith('.modulemap')) continue;
    const raw = index.text(file.path);
    if (!raw) continue;
    const text = blankComments(raw);
    const dir = dirname(file.path);
    const moduleDecl = /\bmodule[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\][ \t]*)*\{/g;
    let m: RegExpExecArray | null;
    while ((m = moduleDecl.exec(text))) {
      // The block runs to its matching brace; submodules inside belong to this module.
      let depth = 1;
      let end = moduleDecl.lastIndex;
      for (; end < text.length && depth > 0; end++) {
        const c = text.charCodeAt(end);
        if (c === 123) depth++;
        else if (c === 125) depth--;
      }
      const body = text.slice(moduleDecl.lastIndex, end);
      moduleDecl.lastIndex = end;

      const umbrella: string[] = [];
      const listed: string[] = [];
      const header = /\b((?:(?:umbrella|private|textual|exclude)[ \t]+)*)header[ \t]+"([^"\n]+)"/g;
      let h: RegExpExecArray | null;
      while ((h = header.exec(body))) {
        if (h[1].includes('exclude')) continue;
        const p = mapHeaderPath(index, dir, h[2]);
        if (p) (h[1].includes('umbrella') ? umbrella : listed).push(p);
      }
      const umbrellaDir = /\bumbrella[ \t]+"([^"\n]+)"/g;
      while ((h = umbrellaDir.exec(body))) {
        const d = joinPath(dir, h[1]);
        if (d !== null) for (const p of index.inDir(d)) if (p.endsWith('.h')) listed.push(p);
      }

      const found = umbrella.length
        ? umbrella.map((path) => ({ path, confidence: CONFIDENCE.mapUmbrella }))
        : listed.map((path) => ({ path, confidence: CONFIDENCE.mapHeader }));
      const known = modules.get(m[1]) ?? [];
      for (const r of found) if (!known.some((k) => k.path === r.path)) known.push(r);
      if (known.length) modules.set(m[1], known);
    }
  }
  return modules;
}

/** The resolver for `.m` and `.mm` files of one repo. */
export function createObjcResolver(index: RepoIndex): Resolver {
  const includes = includeResolver(index);
  let moduleMaps: Map<string, ResolvedImport[]> | undefined;
  const bySuffix = (file: FileFacts, spec: string) => includes.resolve(file, { spec, kind: 'include-system' });

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (imp.kind !== MODULE_IMPORT) return includes.resolve(file, imp);
      const parts = imp.spec.split('.');
      const module = parts[0];
      if (!module) return [];
      // `@import Module.Part;` names one header of the module when the repo has it.
      if (parts.length > 1) {
        const part = bySuffix(file, `${module}/${parts[parts.length - 1]}.h`);
        if (part.length) return part;
      }
      moduleMaps ??= readModuleMaps(index);
      const declared = moduleMaps.get(module)?.filter((r) => r.path !== file.path);
      if (declared?.length) return declared;
      for (const layout of UMBRELLA_LAYOUTS) {
        const umbrella = bySuffix(file, layout(module));
        if (umbrella.length) return umbrella;
      }
      return [];
    },
  };
}
