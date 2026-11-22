// The pipeline itself, free of any environment: manifest → fast pass → structure → settle → reveal
// (PLAN.md §6.8). The browser coordinator worker and the Node scripts both run this with different
// dependencies. Lead-owned.
//
// Beside the parse: the history walk starts with the manifest and fills its layers as it goes
// (./history), a folder whose map was saved is shown from the snapshot instead of parsed (./persist),
// and the Tests layer rides in the structure batch. What follows the reveal is in ./post.
import { testsLayer } from '../analysis';
import type { Config } from '../config';
import type { ComputePool } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';
import type { FactsCache, Manifest } from '../contracts/ingest';
import type { FileFacts, SyntaxFacts } from '../contracts/lang';
import type { SettleReport } from '../contracts/physics';
import type { AnalysisInput, AnalysisResult, PipelineEvents, RepoSource, Stage } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { buildManifest, runFastPass, runSlowPass } from '../ingest';
import { pluginById } from '../lang';
import { diffStructure } from '../model';
import type { LayoutSnapshot, RepoMeta, RepoModel } from '../model/types';
import type { SnapshotWriter } from '../persist';
import { hash32, now as defaultNow } from '../shared';
import { syntheticMeta, syntheticTables } from '../testing/synthetic';
import { createRevealGate, type GateClock, type RevealGate } from './gate';
import { startHistory, type HistoryRun } from './history';
import { findSavedMap, type PipelinePersistence } from './persist';
import type { PipelineSearch } from './search';

/** The part of physics the pipeline drives. In the browser these are messages to the main thread. */
export interface PipelinePhysics {
  settle(maxMs: number): Promise<SettleReport>;
  /** Animated re-layout after Apply or Update: reheat what changed, resolve when asleep. Falls back to settle. */
  relayout?(maxMs: number): Promise<SettleReport>;
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
  /** Snapshots, registry and the history facts. Absent: nothing is saved and every visit parses. */
  persist?: PipelinePersistence;
  /** The path index behind Session.search; warmed after the reveal. */
  search?: PipelineSearch;
  /** False: do not walk git history (a benchmark of the parse alone). Default true. */
  history?: boolean;
  now?: () => number;
  /** Clock for the reveal gate's escape hatch (tests inject a fake). */
  gateClock?: GateClock;
}

/** What a finished run leaves behind for the steps that follow the reveal (slow pass, history, AI, update). */
export interface PipelineState {
  source: RepoSource;
  repo: RepoAccess | null;
  manifest: Manifest | null;
  facts: FileFacts[];
  /** Slow-pass facts received so far; complete only when `syntaxComplete`. */
  syntax: SyntaxFacts[];
  syntaxComplete: boolean;
  /** Settles when the slow pass ends, which may be after the reveal. Never rejects. */
  slowPass: Promise<void> | null;
  gate: RevealGate | null;
  analysis: AnalysisResult | null;
  structure: 'full' | 'imports-only';
  settle: SettleReport | null;
  /** A folder was shown from its stored snapshot instead of being parsed (the return visit, PLAN.md §12). */
  fromSnapshot: boolean;
  /** Paths that differ between that snapshot and the folder; 0 after a parse. */
  changedFiles: number;
  /** The history walk and its layers; null when the source has no git history to walk. */
  history: HistoryRun | null;
  /** The debounced snapshot writer, once the map is revealed and there is storage to write to. */
  saver: SnapshotWriter | null;
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
    syntaxComplete: state.syntaxComplete,
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
    // The Tests overlay needs only paths and edges, so it arrives with the structure it describes (PLAN.md §3.1).
    testsLayer(result.tables, deps.config),
  ]);
  state.analysis = result;
  // The history layers hold one value per unit: hand them the units that exist now.
  state.history?.refresh();
  return result;
}

export async function runSource(source: RepoSource, deps: PipelineDeps): Promise<PipelineState> {
  const now = deps.now ?? defaultNow;
  const { config, store, pool, emit } = deps;
  const state: PipelineState = {
    source, repo: null, manifest: null, facts: [], syntax: [], syntaxComplete: false, slowPass: null, gate: null,
    analysis: null, structure: 'imports-only', settle: null, fromSnapshot: false, changedFiles: 0, history: null, saver: null,
    timings: {},
  };
  let t0 = now();
  const lap = (name: string) => { const t = now(); state.timings[name] = t - t0; t0 = t; };
  const stage = (s: Stage, label: string, done?: number, total?: number) => emit('stage', { stage: s, label, done, total });

  if (source.kind === 'synthetic') {
    stage('structure', 'Finding structure');
    const tables = syntheticTables({ files: source.files, seed: source.seed });
    store.propose([
      { op: 'meta', value: syntheticMeta(`synthetic-${source.files}`, tables) },
      ...diffStructure(store.replica, tables),
      testsLayer(tables, config),
    ]);
    state.structure = 'full';
    lap('structure');
    stage('layout', 'Settling layout');
    state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: 'full' });
    return state;
  }

  /** A finished model, from a file, a demo or local storage: one full batch, its saved layout, the reveal. */
  async function showModel(model: RepoModel): Promise<void> {
    store.load(model);
    // Maps saved before the Tests overlay existed get it now; it needs nothing but the structure.
    if (!store.replica.layers.has('tests')) store.propose([testsLayer(store.replica, config)]);
    state.structure = model.meta.structure;
    lap('load');
    stage('layout', 'Settling layout');
    if (model.layout) await deps.physics.loadLayout(model.layout);
    else state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: state.structure });
  }

  if (source.kind === 'snapshot' || source.kind === 'demo') {
    stage('structure', 'Loading map');
    let model: RepoModel;
    if (source.kind === 'demo') {
      if (!deps.loadDemo) throw new Error('Demo loading is not available here.');
      model = await deps.loadDemo(source.baseUrl);
    } else model = source.model;
    await showModel(model);
    return state;
  }

  // ---- a folder on disk ----
  stage('manifest', 'Listing files');
  await pool.setRepo(source.locator);
  const repo = (state.repo = await deps.openRepo(source.locator));
  const manifest = (state.manifest = await buildManifest(repo, config));
  if (manifest.entries.length === 0) throw new Error('No files to map were found in that folder.');
  emit('progress', { subsystem: 'manifest', done: 1, total: 1 });
  const id = repoId(manifest.repoName, manifest.remoteUrl);
  if (manifest.historyUnavailable) emit('notice', { kind: 'no-history', reason: manifest.historyUnavailable });
  // History never waits for the parse and the parse never waits for it: the walk takes the workers
  // the parse has no task for (PLAN.md §3.1) and holds its layers back until the map has units.
  const walkHistory = (start: boolean) => {
    if (deps.history === false || manifest.source !== 'git' || manifest.historyUnavailable) return;
    state.history = startHistory({
      config, pool, store, emit, persist: deps.persist, repoId: id, start,
      paths: manifest.entries.map((e) => e.path),
      onLayersSaved: () => state.saver?.schedule(),
    });
  };

  // The return visit (PLAN.md §12): a folder whose map is in local storage is shown as it was saved,
  // untouched, and anything that changed since is only counted.
  const saved = source.fresh ? null : await findSavedMap(deps.persist, manifest, id, config);
  if (saved) {
    lap('manifest');
    state.fromSnapshot = true;
    state.changedFiles = saved.changed;
    stage('structure', 'Loading map');
    await showModel(saved.model);
    if (saved.changed > 0) emit('notice', { kind: 'files-changed', count: saved.changed });
    // The saved layers already cover this head: walk only when there are newer commits to add.
    const meta = saved.model.meta;
    walkHistory(!meta.history || meta.headOid !== manifest.headOid);
    state.history?.refresh();
    return state;
  }

  store.propose([{
    op: 'meta',
    value: {
      id, name: manifest.repoName, remoteUrl: manifest.remoteUrl,
      source: manifest.source, headOid: manifest.headOid, indexChecksum: manifest.indexChecksum,
      parserVersion: config.parser.version, parsedAt: Date.now(), structure: 'imports-only',
      stats: { files: manifest.entries.length, units: 0, edges: 0, loc: 0 },
    },
  }]);
  walkHistory(true);
  lap('manifest');

  // `fresh` also means "do not trust what was cached": the facts are read from the files again.
  const cache = source.fresh ? undefined : deps.cache;

  const gate = (state.gate = createRevealGate({ maxWaitMs: config.reveal.maxWaitSeconds * 1000, clock: deps.gateClock }));
  gate.onRefinedReady(() => emit('notice', { kind: 'refined-ready' }));
  gate.begin();

  const total = manifest.entries.length;
  stage('reading', `Reading files 0 / ${fmt(total)}`, 0, total);
  let lastEmit = 0;
  state.facts = await runFastPass(manifest, pool, config, {
    cache,
    onProgress(done, all) {
      const t = now();
      if (t - lastEmit < 100 && done < all) return;
      lastEmit = t;
      emit('progress', { subsystem: 'fastPass', done, total: all });
      stage('reading', `Reading files ${fmt(done)} / ${fmt(all)}`, done, all);
    },
  });
  gate.fastPassDone();
  lap('fastPass');

  // The slow pass is inside the gate, but only until reveal.maxWaitSeconds: past that the map is
  // revealed from imports plus whatever call facts have arrived, and the pass carries on (§6.8).
  stage('structure', 'Finding structure');
  let lastSlow = 0;
  state.slowPass = runSlowPass(manifest, pool, config, {
    cache,
    onBatch(batch) { if (!state.syntaxComplete) for (const f of batch) state.syntax.push(f); },
    onProgress(done, all) {
      const t = now();
      if (t - lastSlow < 100 && done < all) return;
      lastSlow = t;
      emit('progress', { subsystem: 'slowPass', done, total: all });
      if (gate.phase === 'parsing') stage('structure', `Finding structure ${fmt(done)} / ${fmt(all)}`, done, all);
    },
  }).then(
    (all) => { state.syntax = all; state.syntaxComplete = true; },
    (err) => { emit('notice', { kind: 'info', message: `Call analysis stopped early: ${String(err?.message ?? err)}` }); },
  ).then(() => { state.timings.slowPass = now() - t0; gate.slowPassDone(); });

  await gate.readyToStructure();
  lap('slowPassWait');
  stage('structure', 'Finding structure');
  emit('progress', { subsystem: 'resolve', done: 0, total: 1 });
  const result = await analyzeAndApply(deps, state, { keepIds: false });
  state.structure = result.structure;
  emit('progress', { subsystem: 'resolve', done: 1, total: 1 });
  gate.structureReady();
  lap('structure');

  stage('layout', 'Settling layout');
  emit('progress', { subsystem: 'layout', done: 0, total: 1 });
  state.settle = await deps.physics.settle(config.reveal.settleMaxMs);
  emit('progress', { subsystem: 'layout', done: 1, total: 1 });
  lap('layout');

  stage('revealed', '');
  emit('reveal', { structure: state.structure });
  gate.settled();
  return state;
}
