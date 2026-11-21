// Public surface of src/analysis. Package 1E owns this folder (2A replaces ./cluster, 2C adds ./link).
//
// analyze() is a short pipeline of pure stages, one file each:
//   resolve.ts     FileFacts            → RawEdge[]   (file → file, kind 'import')
//   units.ts       files (+ UnitMapper) → UnitTable   (file → unit mapping; one unit per file for now)
//   edges.ts       RawEdge[], UnitTable → UnitEdges   (one edge per ordered unit pair, fan-in/out)
//   importance.ts  UnitEdges            → Importance  (PageRank, then percentile)
//   cluster/       UnitTable, UnitEdges → ClusterResult (cities and districts)
//   assemble.ts    all of the above     → StructureTables
import type { Config } from '../config';
import type { LanguagePlugin } from '../contracts/lang';
import type { AnalysisInput, AnalysisResult, Analyze } from '../contracts/pipeline';
import { now } from '../shared';
import { assembleTables } from './assemble';
import { cluster as defaultCluster, type Cluster } from './cluster';
import { aggregateEdges } from './edges';
import { computeImportance } from './importance';
import { sortFiles } from './order';
import { resolveImports } from './resolve';
import { buildUnits, type UnitMapper } from './units';

export type { RawEdge, ResolveResult } from './resolve';
export type { UnitMapper, UnitTable } from './units';
export type { UnitEdges } from './edges';
export type { Importance } from './importance';
export type { Cluster, ClusterResult } from './cluster';

/** Seams for tests and for the stages that later packages replace. */
export interface AnalyzeOptions {
  /** Language plug-ins to resolve with. Default: the registry in src/lang. */
  plugins?: readonly LanguagePlugin[];
  /** File → unit mapping. Default: one unit per file. */
  unitMapper?: UnitMapper;
  /** Community detection. Default: ./cluster. */
  cluster?: Cluster;
}

/** Facts in, structure out: resolve imports, form units, compute importance, cluster. Pure. */
export function analyze(input: AnalysisInput, config: Config, options: AnalyzeOptions = {}): AnalysisResult {
  const ms: Record<string, number> = {};
  const t0 = now();
  let t = t0;
  const lap = (stage: string) => { const t1 = now(); ms[stage] = t1 - t; t = t1; };

  const files = sortFiles(input.files);
  const resolved = resolveImports(files, options.plugins);
  lap('resolve');

  const units = buildUnits(files, resolved.edges, options.unitMapper);
  lap('units');

  const edges = aggregateEdges(resolved.edges, units);
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
      refsLinked: 0,
      refsDropped: 0,
      bridges: 0,
      ms,
    },
  };
}

// The contract's signature (contracts/pipeline.ts); the third parameter is optional on top of it.
analyze satisfies Analyze;
