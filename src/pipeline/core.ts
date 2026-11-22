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
import type { AnalysisInput, AnalysisResult, PipelineEvents, RepoSource, Stage, StageInfo } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { buildManifest, runFastPass, runSlowPass } from '../ingest';
import { pluginById } from '../lang';
import { diffStructure } from '../model';
import type { LayoutSnapshot, RepoMeta, RepoModel } from '../model/types';
import type { SnapshotWriter } from '../persist';
import { hash32, now as defaultNow } from '../shared';
import { syntheticMeta, syntheticTables } from '../testing/synthetic';
import { settleDetails } from './ai';
import { createRevealGate, type GateClock, type RevealGate } from './gate';
import { startHistory, type HistoryRun } from './history';
import { findSavedMap, type PipelinePersistence } from './persist';
import type { PipelineSearch } from './search';
import type { WorkingTreeChange } from './update';

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
  /** The model of a demo, from its package, marked as that demo (id `demo:<name>`). */
  loadDemo?(source: Extract<RepoSource, { kind: 'demo' }>): Promise<RepoModel>;
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
  /**
   * The N of "N files changed · Update" as last announced: paths that differ between the map and the
   * folder, by blob id (a return visit) and by what the working-tree check found edited on disk.
   */
  changedFiles: number;
  /** What the background working-tree check confirmed (PLAN.md §6.3.1); absent until it has run. */
  workingTree?: WorkingTreeChange[];
  /** The history walk and its layers; null when the source has no git history to walk. */
  history: HistoryRun | null;
  /** The debounced snapshot writer, once the map is revealed and there is storage to write to. */
  saver: SnapshotWriter | null;
  /** Milliseconds per stage, for benchmarks. */
  timings: Record<string, number>;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * How long a settle may run. The plan's cap (reveal.settleMaxMs) suits small and medium maps; a
 * larger one needs longer to come to rest with nothing overlapping, so the cap grows with the number
 * of files, up to a ceiling. Waiting a few more seconds beats revealing a map that is still overlapped.
 */
/**
 * The share of the wait before the reveal that each stretch takes, as [from, to] of StageInfo.overall.
 * Rough shares of the time measured on the test repos: parsing code is most of it.
 */
const WAIT = {
  reading: [0.03, 0.22],
  parsing: [0.22, 0.8],
  structure: [0.8, 0.9],
  layout: [0.9, 1],
} as const;
const within = (span: readonly [number, number], share: number): number => span[0] + (span[1] - span[0]) * Math.min(1, Math.max(0, share));
/** Until the first batch of parsed code comes back, the line moves by time a little way into the stretch. */
const PARSERS_LOADING = { creepTo: WAIT.parsing[0] + 0.04, creepMs: 1500 } as const;
/** A stage line is sent at most this often while a pass runs. */
const PROGRESS_EVERY_MS = 60;

export function settleCap(config: Config, units: number): number {
  const r = config.reveal;
  return Math.min(Math.max(r.settleMaxMs, r.settleCeilingMs), Math.max(r.settleMaxMs, units * r.settleMsPerFile));
}

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
export interface AnalyzeOptions {
  /** Hand analysis the current memberships and names, so ids stay stable where communities persist. */
  keepIds: boolean;
  /**
   * With keepIds: an Update. Units stay in their districts and only new ones are placed
   * (AnalysisInput.previous.incremental). Leave it out for "Apply", which re-clusters.
   */
  incremental?: boolean;
  extraMeta?: Partial<RepoMeta>;
}

export async function analyzeAndApply(deps: PipelineDeps, state: PipelineState, opts: AnalyzeOptions): Promise<AnalysisResult> {
  const previous = opts.keepIds ? previousStructure(deps.store) : undefined;
  if (previous && opts.incremental) previous.incremental = true;
  const input: AnalysisInput = {
    repoName: state.manifest?.repoName ?? 'repo',
    files: state.facts,
    syntax: state.syntax.length ? state.syntax : undefined,
    syntaxComplete: state.syntaxComplete,
    previous,
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
  const stage = (s: Stage, label: string, done?: number, total?: number, overall?: Pick<StageInfo, 'overall' | 'creepTo' | 'creepMs'>) =>
    emit('stage', { stage: s, label, done, total, ...overall });

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
    state.settle = await deps.physics.settle(settleCap(config, store.replica.table('unit').count));
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: 'full' });
    return state;
  }

  /** A finished model, from a file, a demo or local storage: one full batch, its saved layout, the reveal. */
  async function showModel(model: RepoModel): Promise<void> {
    // An answer that was being written when the map was saved or exported will never arrive.
    store.load(settleDetails(model));
    // Maps saved before the Tests overlay existed get it now; it needs nothing but the structure.
    if (!store.replica.layers.has('tests')) store.propose([testsLayer(store.replica, config)]);
    state.structure = model.meta.structure;
    lap('load');
    stage('layout', 'Settling layout');
    if (model.layout) await deps.physics.loadLayout(model.layout);
    else state.settle = await deps.physics.settle(settleCap(config, store.replica.table('unit').count));
    lap('layout');
    stage('revealed', '');
    emit('reveal', { structure: state.structure });
  }

  if (source.kind === 'snapshot' || source.kind === 'demo') {
    stage('structure', 'Loading map');
    let model: RepoModel;
    if (source.kind === 'demo') {
      if (!deps.loadDemo) throw new Error('Demo loading is not available here.');
      model = await deps.loadDemo(source);
    } else model = source.model;
    await showModel(model);
    return state;
  }

  // ---- a folder on disk ----
  stage('manifest', 'Listing files', undefined, undefined, { overall: 0, creepTo: WAIT.reading[0], creepMs: 1500 });
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
  stage('reading', `Reading files 0 / ${fmt(total)}`, 0, total, { overall: WAIT.reading[0] });
  let lastEmit = 0;
  state.facts = await runFastPass(manifest, pool, config, {
    cache,
    onProgress(done, all, share = all > 0 ? done / all : 1) {
      const t = now();
      if (t - lastEmit < PROGRESS_EVERY_MS && done < all) return;
      lastEmit = t;
      emit('progress', { subsystem: 'fastPass', done, total: all });
      stage('reading', `Reading files ${fmt(done)} / ${fmt(all)}`, done, all, { overall: within(WAIT.reading, share) });
    },
  });
  gate.fastPassDone();
  lap('fastPass');

  // The slow pass is inside the gate, but only until reveal.maxWaitSeconds: past that the map is
  // revealed from imports plus whatever call facts have arrived, and the pass carries on (§6.8).
  // the parsers load before the first batch comes back: about a second with nothing to count
  stage('structure', 'Reading code', undefined, undefined, { overall: WAIT.parsing[0], ...PARSERS_LOADING });
  let lastSlow = 0;
  state.slowPass = runSlowPass(manifest, pool, config, {
    cache,
    onBatch(batch) { if (!state.syntaxComplete) for (const f of batch) state.syntax.push(f); },
    onProgress(done, all, share = all > 0 ? done / all : 1) {
      const t = now();
      if (t - lastSlow < PROGRESS_EVERY_MS && done < all) return;
      lastSlow = t;
      emit('progress', { subsystem: 'slowPass', done, total: all });
      if (gate.phase === 'parsing') stage('structure', `Reading code ${fmt(done)} / ${fmt(all)}`, done, all, { overall: within(WAIT.parsing, share), ...(share === 0 ? PARSERS_LOADING : null) });
    },
  }).then(
    (all) => { state.syntax = all; state.syntaxComplete = true; },
    (err) => { emit('notice', { kind: 'info', message: `Call analysis stopped early: ${String(err?.message ?? err)}` }); },
  ).then(() => { state.timings.slowPass = now() - t0; gate.slowPassDone(); });

  await gate.readyToStructure();
  lap('slowPassWait');
  // One task, with nothing to count while it runs: the line moves by time (StageInfo.creepTo).
  stage('structure', 'Finding structure', undefined, undefined, { overall: WAIT.structure[0], creepTo: WAIT.structure[1], creepMs: 600 + total * 0.25 });
  emit('progress', { subsystem: 'resolve', done: 0, total: 1 });
  const result = await analyzeAndApply(deps, state, { keepIds: false });
  state.structure = result.structure;
  emit('progress', { subsystem: 'resolve', done: 1, total: 1 });
  gate.structureReady();
  lap('structure');

  const cap = settleCap(config, store.replica.table('unit').count);
  stage('layout', 'Settling layout', undefined, undefined, { overall: WAIT.layout[0], creepTo: WAIT.layout[1], creepMs: cap * 0.4 });
  emit('progress', { subsystem: 'layout', done: 0, total: 1 });
  state.settle = await deps.physics.settle(cap);
  emit('progress', { subsystem: 'layout', done: 1, total: 1 });
  lap('layout');

  stage('revealed', '');
  emit('reveal', { structure: state.structure });
  gate.settled();
  return state;
}
