// Import resolution for stylesheets (PLAN.md §6.4): relative to the importing file, with Sass
// partials (`_name.scss`), index files (`dir/_index.scss`) and extension probing. Package imports
// (`~pkg/x`, `bootstrap/scss/x`) resolve only when the package's files are in the repo.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, extname, joinPath } from '../../shared';
import { tsResolver } from '../ts';
import { aliasCandidates, aliasRest, cleanSpec, CONVENTION, isLocalSpec, resolveRootRelative } from './paths';

/** Extensions tried when a specifier has none. The importing file's own extension goes first. */
const PROBE_EXTS = ['scss', 'sass', 'less', 'css'];
const STYLE_EXTS = new Set([...PROBE_EXTS, 'pcss', 'styl']);
const INDEX_NAMES = ['_index', 'index'];

const EXACT = 1;
/** Found through a Sass load path we cannot see: the one file in the repo whose path ends with the specifier. */
const LOAD_PATH_GUESS = 0.6;

const under = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function createStyleResolver(index: RepoIndex): Resolver {
  const ts = tsResolver(index);
  const orders = new Map<string, string[]>();
  const extOrder = (own: string): string[] => {
    let o = orders.get(own);
    if (!o) orders.set(own, (o = PROBE_EXTS.includes(own) ? [own, ...PROBE_EXTS.filter((e) => e !== own)] : PROBE_EXTS));
    return o;
  };

  /** Forms a stylesheet path can take on disk, most direct first. */
  const forms = (base: string, own: string): string[] => {
    const partial = under(dirname(base), `_${basename(base)}`);
    if (STYLE_EXTS.has(extname(base))) return [base, partial];
    const out = [base];
    const exts = extOrder(own);
    for (const e of exts) out.push(`${base}.${e}`, `${partial}.${e}`);
    for (const e of exts) for (const name of INDEX_NAMES) out.push(`${base}/${name}.${e}`);
    return out;
  };
  const find = (base: string | null, own: string): string | null => {
    if (!base) return null;
    for (const p of forms(base, own)) if (index.has(p)) return p;
    return null;
  };

  /** A specifier that is not relative to the file: a tsconfig alias, a workspace package, or a load path. */
  const viaAlias = (file: FileFacts, spec: string, asset: boolean, own: string): ResolvedImport | null => {
    const bare = spec.startsWith('~') && !spec.startsWith('~/') ? spec.slice(1) : spec; // webpack's `~pkg/x`
    const hit = ts.resolve(file, { spec: bare, kind: 'import' })[0];
    // The TS/JS resolver also probes .ts and index files; only a file of the kind asked for counts.
    const hitExt = hit ? extname(hit.path) : '';
    if (hit && (asset ? hitExt !== '' && hitExt === extname(bare) : STYLE_EXTS.has(hitExt))) return hit;
    const rest = aliasRest(bare);
    if (rest !== null) {
      for (const c of aliasCandidates(dirname(file.path), rest)) {
        const p = asset ? (index.has(c) ? c : null) : find(c, own);
        if (p) return { path: p, confidence: CONVENTION };
      }
      return null;
    }
    if (asset) return null;
    const found = new Set<string>();
    for (const form of forms(bare, own)) for (const p of index.bySuffix(form)) found.add(p);
    if (found.size !== 1) return null;
    return { path: [...found][0], confidence: LOAD_PATH_GUESS };
  };

  const resolveFrom = (file: FileFacts, raw: string, asset: boolean): ResolvedImport | null => {
    const spec = cleanSpec(raw);
    if (!isLocalSpec(spec)) return null;
    const dir = dirname(file.path);
    const own = extname(file.path);
    const probe = (p: string): string | null => (asset ? (index.has(p) ? p : null) : find(p, own));
    if (spec.startsWith('/')) return resolveRootRelative(index, dir, spec, probe);
    const joined = joinPath(dir, spec);
    const hit = joined ? probe(joined) : null;
    if (hit) return { path: hit, confidence: EXACT };
    if (spec.startsWith('./') || spec.startsWith('../')) return null;
    return viaAlias(file, spec, asset, own);
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const hit = resolveFrom(file, imp.spec, imp.kind === 'css-url');
      return hit && hit.path !== file.path ? [hit] : [];
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The stylesheet resolver for an index, shared by every plug-in that scans styles (CSS, HTML, Vue / Svelte / Astro). */
export function styleResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createStyleResolver(index)));
  return r;
}
