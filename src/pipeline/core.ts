// The pipeline itself, free of any environment: manifest → fast pass → structure → settle → reveal
// (PLAN.md §6.8). The browser coordinator worker and the Node scripts both run this with different
// dependencies. Lead-owned.
import type { Config } from '../config';
import type { ComputePool } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';
import type { FactsCache, Manifest } from '../contracts/ingest';
import type { FileFacts, SyntaxFacts } from '../contracts/lang';
import type { SettleReport } from '../contracts/physics';
import type { AnalysisInput, AnalysisResult, PipelineEvents, RepoSource, Stage } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { buildManifest, runFastPass } from '../ingest';
import { pluginById } from '../lang';
import { diffStructure } from '../model';
import type { LayoutSnapshot, RepoMeta, RepoModel } from '../model/types';
import { hash32, now as defaultNow } from '../shared';
import { syntheticMeta, syntheticTables } from '../testing/synthetic';

/** The part of physics the pipeline drives. In the browser these are messages to the main thread. */
export interface PipelinePhysics {
  settle(maxMs: number): Promise<SettleReport>;
  loadLayout(layout: LayoutSnapshot): Promise<void> | void;
  getLayout(): Promise<LayoutSnapshot>;
}

export interface PipelineDeps {
  config: Config;
  pool: ComputePool;
  store: ModelStore;
  physics: PipelinePhysics;
  emit<E extends keyof PipelineEvents>(evt: E, e: PipelineEvents[E]): void;
  /** Open the repo in this thread (the pool opens its own copies in its workers). */
  openRepo(locator: RepoLocator): Promise<RepoAccess>;
  /** Fetch and decode a demo snapshot. */
  loadDemo?(baseUrl: string): Promise<RepoModel>;
  cache?: FactsCache;
  now?: () => number;
}

/** What a finished run leaves behind for the steps that follow the reveal (slow pass, history, AI, update). */
export interface PipelineState {
  source: RepoSource;
  repo: RepoAccess | null;
  manifest: Manifest | null;
  facts: FileFacts[];
  syntax: SyntaxFacts[];
  analysis: AnalysisResult | null;
  structure: 'full' | 'imports-only';
  settle: SettleReport | null;
  /** Milliseconds per stage, for benchmarks. */
  timings: Record<string, number>;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function repoId(name: string, remoteUrl: string | null): string {
  return remoteUrl ? `git:${remoteUrl}` : `local:${name}:${hash32(name).toString(16)}`;
}

/** Previous memberships and names from the store, so a re-analysis keeps ids stable. */
export function previousStructure(store: ModelStore): AnalysisInput['previous'] {
  const units = store.replica.table('unit'), districts = store.replica.table('district'), cities = store.replica.table('city');
  const out: NonNullable<AnalysisInput['previous']> = { unitDistrict: {}, districtCity: {}, districtName: {}, cityName: {} };
  for (const s of units.slots()) out.unitDistrict[units.ids[s]!] = units.cols.district[s];
  for (const s of districts.slots()) { out.districtCity[districts.ids[s]!] = districts.cols.city[s]; out.districtName[districts.ids[s]!] = districts.cols.name[s]; }
  for (const s of cities.slots()) out.cityName[cities.ids[s]!] = cities.cols.name[s];
  return out;
}

/** Run analysis on the pool and propose the difference to the store as one batch. */
export async function analyzeAndApply(deps: PipelineDeps, state: PipelineState, opts: { keepIds: boolean; extraMeta?: Partial<RepoMeta> }): Promise<AnalysisResult> {
  const input: AnalysisInput = {
    repoName: state.manifest?.repoName ?? 'repo',
    files: state.facts,
    syntax: state.syntax.length ? state.syntax : undefined,
    syntaxComplete: state.structure === 'full',
    previous: opts.keepIds ? previousStructure(deps.store) : undefined,
  };
  const result = await deps.pool.run<AnalysisResult, AnalysisInput>({ type: 'analysis.analyze', lane: 'parse', input });
  const ops = diffStructure(deps.store.replica, result.tables);
  const languages: NonNullable<RepoMeta['languages']> = {};
  for (const id of new Set(result.tables.unit.cols.lang ?? [])) {
    const p = pluginById(id);
    if (p) languages[id] = { name: p.name, color: p.color };
  }
  deps.store.propose([
    ...ops,
    { op: 'meta', value: { structure: result.structure, stats: result.stats, parsedAt: Date.now(), languages, ...opts.extraMeta } },
  ]);
  state.analysis = result;
  return result;
}

export async function runSource(source: RepoSource, deps: PipelineDeps): Promise<PipelineState> {
  const now = deps.now ?? defaultNow;
  const { config, store, pool, emit } = deps;
  const state: PipelineState = { source, repo: null, manifest: null, facts: [], syntax: [], analysis: null, structure: 'imports-only', settle: null, timings: {} };
  let t0 = now();
  const lap = (name: string) => { const t = now(); state.timings[name] = t - t0; t0 = t; };
  const stage = (s: Stage, label: string, done?: number, total?: number) => emit('stage', { stage: s, label, done, total });

  if (source.kind === 'synthetic') {
    stage('structure', 'Finding structure');
    const tables = syntheticTables({ files: source.files, seed: source.seed });
    store.propose([{ op: 'meta', value: syntheticMeta(`synthetic-${source.files}`, tables) }, ...diffStructure(store.replica, tables)]);
    state.structure = 'full';
    lap('structure');
    stage('layout', 'Settling layout');
    state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: 'full' });
    return state;
  }

  if (source.kind === 'snapshot' || source.kind === 'demo') {
    stage('structure', 'Loading map');
    let model: RepoModel;
    if (source.kind === 'demo') {
      if (!deps.loadDemo) throw new Error('Demo loading is not available here.');
      model = await deps.loadDemo(source.baseUrl);
    } else model = source.model;
    store.load(model);
    state.structure = model.meta.structure;
    lap('load');
    stage('layout', 'Settling layout');
    if (model.layout) await deps.physics.loadLayout(model.layout);
    else state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: state.structure });
    return state;
  }

  // ---- a folder on disk ----
  stage('manifest', 'Listing files');
  await pool.setRepo(source.locator);
  const repo = (state.repo = await deps.openRepo(source.locator));
  const manifest = (state.manifest = await buildManifest(repo, config));
  if (manifest.entries.length === 0) throw new Error('No files to map were found in that folder.');
  emit('progress', { subsystem: 'manifest', done: 1, total: 1 });
  store.propose([{
    op: 'meta',
    value: {
      id: repoId(manifest.repoName, manifest.remoteUrl), name: manifest.repoName, remoteUrl: manifest.remoteUrl,
      source: manifest.source, headOid: manifest.headOid, indexChecksum: manifest.indexChecksum,
      parserVersion: config.parser.version, parsedAt: Date.now(), structure: 'imports-only',
      stats: { files: manifest.entries.length, units: 0, edges: 0, loc: 0 },
    },
  }]);
  if (manifest.historyUnavailable) emit('notice', { kind: 'no-history', reason: manifest.historyUnavailable });
  lap('manifest');

  const total = manifest.entries.length;
  stage('reading', `Reading files 0 / ${fmt(total)}`, 0, total);
  let lastEmit = 0;
  state.facts = await runFastPass(manifest, pool, config, {
    cache: deps.cache,
    onProgress(done, all) {
      const t = now();
      if (t - lastEmit < 100 && done < all) return;
      lastEmit = t;
      emit('progress', { subsystem: 'fastPass', done, total: all });
      stage('reading', `Reading files ${fmt(done)} / ${fmt(all)}`, done, all);
    },
  });
  lap('fastPass');

  stage('structure', 'Finding structure');
  emit('progress', { subsystem: 'resolve', done: 0, total: 1 });
  const result = await analyzeAndApply(deps, state, { keepIds: false });
  state.structure = result.structure;
  emit('progress', { subsystem: 'resolve', done: 1, total: 1 });
  lap('structure');

  stage('layout', 'Settling layout');
  emit('progress', { subsystem: 'layout', done: 0, total: 1 });
  state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
  emit('progress', { subsystem: 'layout', done: 1, total: 1 });
  lap('layout');

  stage('revealed', '');
  emit('reveal', { structure: state.structure });
  return state;
}
