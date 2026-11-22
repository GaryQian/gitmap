// Import resolution for Vue, Svelte and Astro components (PLAN.md §6.4): script imports go to the
// TS/JS resolver, style imports to the stylesheet resolver. The TS/JS resolver already returns a file
// named with its extension (`./Foo.vue`, `@/components/Foo.svelte` through tsconfig `paths`), so
// what is added here is small: imports that leave the component extension off, the bundler aliases
// that projects without a tsconfig rely on, and `src` attributes.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, extname, joinPath } from '../../shared';
import { aliasCandidates, aliasRest, cleanSpec, CONVENTION, isLocalSpec, probeModule, resolveRootRelative, styleResolver } from '../css';
import { tsResolver } from '../ts';

function createComponentResolver(index: RepoIndex): Resolver {
  const ts = tsResolver(index);
  const styles = styleResolver(index);

  const resolveFrom = (file: FileFacts, imp: ImportSpec): ResolvedImport[] => {
    if (imp.kind.startsWith('css-')) return styles.resolve(file, imp);
    const direct = ts.resolve(file, imp);
    if (direct.length) return direct;

    const spec = cleanSpec(imp.spec);
    const dir = dirname(file.path);
    const ext = extname(file.path);
    /** `p` with the importing component's own extension, as bundlers set up for Vue resolve `./Foo`. */
    const sibling = (p: string | null): string | null => {
      if (!p) return null;
      for (const c of [`${p}.${ext}`, `${p}/index.${ext}`]) if (index.has(c)) return c;
      return null;
    };
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const hit = sibling(joinPath(dir, spec));
      return hit ? [{ path: hit, confidence: 1 }] : [];
    }
    const rest = aliasRest(spec);
    if (rest !== null) {
      for (const c of aliasCandidates(dir, rest)) {
        const hit = probeModule(index, c) ?? sibling(c);
        if (hit) return [{ path: hit, confidence: CONVENTION }];
      }
    }
    if (imp.kind !== 'src' || !isLocalSpec(spec)) return [];
    if (spec.startsWith('/')) {
      const hit = resolveRootRelative(index, dir, spec);
      return hit ? [hit] : [];
    }
    // <script src="x.ts"> / <style src="x.scss"> without './': relative to the component.
    const beside = joinPath(dir, spec);
    if (beside && index.has(beside)) return [{ path: beside, confidence: 1 }];
    return styles.resolve(file, { spec, kind: 'css-import' });
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      return resolveFrom(file, imp).filter((r) => r.path !== file.path);
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The component resolver for an index; one instance serves the Vue, Svelte and Astro plug-ins. */
export function componentResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createComponentResolver(index)));
  return r;
}
