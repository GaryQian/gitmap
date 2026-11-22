// Public surface of src/analysis. Package 1E owns this folder (2A replaces ./cluster, 2C adds ./link).
//
// analyze() is a short pipeline of pure stages, one file each:
//   resolve.ts     FileFacts            → RawEdge[]   (file → file, kind 'import')
//   units.ts       files (+ UnitMapper) → UnitTable   (file → unit mapping; link/pairs.ts pairs headers)
//   link/          SyntaxFacts          → RawEdge[]   (file → file, kinds 'call' / 'reference' / 'inherit')
//   ../bridges     FileFacts.bridge     → RawEdge[]   (file → file, kind 'bridge': JNI, Protobuf stubs)
//   edges.ts       RawEdge[], UnitTable → UnitEdges   (one edge per ordered unit pair, fan-in/out)
//   importance.ts  UnitEdges            → Importance  (PageRank, then percentile)
//   cluster/       UnitTable, UnitEdges → ClusterResult (cities and districts)
//   assemble.ts    all of the above     → StructureTables
// Beside it, ./layers turns structure and history facts into overlay `layer` operations.
import type { Config } from '../config';
import type { LanguagePlugin } from '../contracts/lang';
import type { AnalysisInput, AnalysisResult, Analyze } from '../contracts/pipeline';
import { bridgeRawEdges, linkBridges } from '../bridges';
import { now } from '../shared';
import { assembleTables } from './assemble';
import { cluster as defaultCluster, type Cluster } from './cluster';
import { aggregateEdges } from './edges';
import { computeImportance } from './importance';
import { pairHeaders } from './link/pairs';
import { linkSymbols } from './link/symbols';
import { sortFiles } from './order';
import { resolveImports } from './resolve';
import { buildUnits, type UnitMapper } from './units';

export type { RawEdge, ResolveResult } from './resolve';
export type { UnitMapper, UnitTable } from './units';
export type { PairSymbols, UnitEdges } from './edges';
export type { Importance } from './importance';
export type { Cluster, ClusterResult } from './cluster';
export type { LinkResult } from './link/symbols';
export { LINK_CONFIDENCE } from './link/symbols';
export { pairHeaders } from './link/pairs';
export * from './layers';

/** Seams for tests and for the stages that later packages replace. */
export interface AnalyzeOptions {
  /** Language plug-ins to resolve with. Default: the registry in src/lang. */
  plugins?: readonly LanguagePlugin[];
  /** File → unit mapping. Default: header + implementation pairs (link/pairs.ts), else one unit per file. */
  unitMapper?: UnitMapper;
  /** Community detection. Default: ./cluster. */
  cluster?: Cluster;
}

/**
 * Facts in, structure out: resolve imports, form units, link symbols (when `input.syntax` is given,
 * complete or not), compute importance, cluster. Pure, and independent of the order of its inputs.
 */
export function analyze(input: AnalysisInput, config: Config, options: AnalyzeOptions = {}): AnalysisResult {
  const ms: Record<string, number> = {};
  const t0 = now();
  let t = t0;
  const lap = (stage: string) => { const t1 = now(); ms[stage] = t1 - t; t = t1; };

  const files = sortFiles(input.files);
  const resolved = resolveImports(files, options.plugins);
  lap('resolve');

  const units = buildUnits(files, resolved.edges, options.unitMapper ?? pairHeaders);
  lap('units');

  const linked = input.syntax ? linkSymbols(files, input.syntax, resolved, units, config.analysis.topSymbolsPerEdge) : null;
  lap('link');

  // Cross-language bridges (PLAN.md §6.4.1): keys the fast pass left on each file, joined by name.
  const bridges = linkBridges(files);
  const raw = linked ? resolved.edges.concat(linked.edges) : resolved.edges.slice();
  for (const edge of bridgeRawEdges(bridges)) raw.push(edge);
  lap('bridges');

  const edges = aggregateEdges(raw, units, linked?.symbols);
  lap('edges');

  const importance = computeImportance(units.count, edges, config.importance);
  lap('importance');

  const clusters = (options.cluster ?? defaultCluster)(units, edges, config, input.previous, input.repoName);
  lap('cluster');

  const tables = assembleTables(files, units, edges, importance.pct, clusters);
  let loc = 0;
  for (const f of files) loc += f.loc || 0;
  lap('assemble');
  ms.total = now() - t0;

  return {
    tables,
    structure: input.syntax && input.syntaxComplete ? 'full' : 'imports-only',
    stats: { files: files.length, units: units.count, edges: edges.count, loc },
    diagnostics: {
      importsTotal: resolved.importsTotal,
      importsResolved: resolved.importsResolved,
      refsLinked: linked?.refsLinked ?? 0,
      refsDropped: linked?.refsDropped ?? 0,
      bridges: bridges.length,
      ms,
    },
  };
}

// The contract's signature (contracts/pipeline.ts); the third parameter is optional on top of it.
analyze satisfies Analyze;
