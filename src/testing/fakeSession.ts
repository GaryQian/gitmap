// A Session that parses nothing: it plays the waiting-screen stages on timers, then reveals a
// synthetic model laid out by the static physics fake. The app shell and the dev harness run against
// it until the real pipeline exists, and UI work can keep using it afterwards.
import type { Config } from '../config';
import { DETAIL_QUESTIONS } from '../contracts/ai';
import type { PipelineEvents, RepoSource, SearchHit, Session, SessionAi, StageInfo } from '../contracts/pipeline';
import type { BackgroundApi, RenderApi, RenderEvents, RenderInit } from '../contracts/render';
import type { PhysicsApi } from '../contracts/physics';
import { createReplica } from '../model';
import type { ModelPatch, Poi, PoiDetail, RepoModel, TourStep, UnitRef } from '../model/types';
import { createRenderer } from '../render';
import { Emitter } from '../shared';
import { MemoryContentSource } from './memory';
import { createStaticPhysics } from './staticPhysics';
import { syntheticMeta, syntheticTables, tablesToFullBatch } from './synthetic';

/** A RenderApi that draws nothing. */
export function createNoopRenderer(_init?: Partial<RenderInit>): RenderApi {
  const emitter = new Emitter<RenderEvents>();
  return {
    applyBatch() {}, setPositions() {}, async reveal() {}, setTheme() {}, setParticles() {}, setOverlay() {},
    setSelection() {}, setHighlights() {}, setTypeFilter() {}, setMinBytes() {},
    async flyTo() {}, async flyToFit() {}, async resetView() {}, isDefaultView: () => true, setViewInset() {},
    project: () => null, screenToGround: () => null, visibleCounts: () => new Map(), burst() {},
    on: (evt, fn) => emitter.on(evt, fn),
    stats: () => ({ fps: 0, frameMs: 0, spheres: 0, edgesDrawn: 0, quality: 0, resyncs: 0 }),
    dispose() {},
  };
}

export function createNoopBackground(): BackgroundApi {
  return { setTheme() {}, setEmphasis() {}, dispose() {} };
}

export interface FakeSessionOptions {
  files?: number;
  seed?: number;
  /** Total time spent on the waiting screen, ms. Default 2500; 0 reveals at once. */
  waitMs?: number;
  /** Emit a "refined-ready" notice this long after the reveal. */
  refinedAfterMs?: number;
}

export function createFakeSession(config: Config, opts: FakeSessionOptions = {}): Session {
  const files = opts.files ?? 1000;
  const waitMs = opts.waitMs ?? 2500;
  const source: RepoSource = { kind: 'synthetic', files, seed: opts.seed };
  const events = new Emitter<PipelineEvents>();
  const replica = createReplica();
  const physics: PhysicsApi = createStaticPhysics({ config, capacity: { units: files + 64, districts: 1024, cities: 64 } });
  let render: RenderApi | null = null;
  let stage: StageInfo = { stage: 'idle', label: '' };
  let disposed = false;
  let revealed = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const setStage = (s: StageInfo) => { stage = s; events.emit('stage', s); };

  /** One more batch on top of the synthetic model, through every consumer, as the coordinator would send it. */
  const applyOps = (ops: ModelPatch[]): void => {
    const batch = { rev: replica.rev + 1, baseRev: replica.rev, ops };
    replica.apply(batch);
    physics.applyBatch(batch);
    render?.applyBatch(batch);
    events.emit('batch', batch);
  };

  // Canned AI annotations, so the consent flow, the summaries, the beams and the tour can be looked
  // at without a server: a summary on every city, two points of interest, a three-step tour.
  let aiDone = false;
  let aiCancelled = false;
  const ai: SessionAi = {
    available: true,
    async start() {
      if (aiDone || !revealed) return { failure: null };
      aiCancelled = false;
      const pause = Math.min(600, waitMs / 3);
      const cities = replica.table('city'), units = replica.table('unit');
      const total = cities.count + 2;
      events.emit('progress', { subsystem: 'ai', done: 0, total });
      await sleep(pause);
      if (disposed || aiCancelled) { events.emit('progress', { subsystem: 'ai', done: total, total }); return { failure: null }; }
      applyOps([
        { op: 'meta', value: { digestHash: 'fake-digest' } },
        ...cities.slots().map((slot): ModelPatch => {
          const id = cities.ids[slot]!;
          const name = cities.cols.name[slot] || id;
          return {
            op: 'annotation',
            value: {
              type: 'summary', id: `summary:${id}`, parent: `c:${id}`, label: `${name} services`,
              text: `Holds the code behind ${name}: its entry points, the modules they call, and the helpers those share. Most of the links from other areas arrive at a few central files here.`,
            },
          };
        }),
      ]);
      events.emit('progress', { subsystem: 'ai', done: cities.count, total });
      await sleep(pause);
      if (disposed || aiCancelled) { events.emit('progress', { subsystem: 'ai', done: total, total }); return { failure: null }; }
      // the most important files, most important first
      const ranked = units.slots().sort((a, b) => units.cols.importancePct[b] - units.cols.importancePct[a]).map((slot) => `u:${units.ids[slot]!}` as UnitRef);
      if (ranked.length > 0) {
        const at = (i: number) => ranked[Math.min(i, ranked.length - 1)];
        const idle = (): Record<string, PoiDetail> => Object.fromEntries(Object.keys(DETAIL_QUESTIONS).map((q) => [q, { status: 'idle' }]));
        const pois: Poi[] = [
          { type: 'poi', id: 'poi:fake-entry', parent: at(0), label: 'Main entry', kind: 'entry', summary: 'Where a request first arrives. It reads the configuration, builds the services the rest of the code shares, and hands control to the router.', evidence: 'The highest importance on the map; many files depend on it.', refs: [], details: idle() },
          { type: 'poi', id: 'poi:fake-core', parent: at(1), label: 'Shared core', kind: 'core', summary: 'The types and helpers nearly every area imports. A change here reaches most of the map, so it is the file to read before touching anything else.', evidence: 'Second highest importance; imported from several cities.', refs: [], details: idle() },
        ];
        const steps: TourStep[] = [
          { parent: at(0), frame: 'city', text: 'Start with the area that receives every request: this city holds the entry points and the code that wires the rest together.', highlights: [at(0)] },
          { parent: at(1), frame: 'district', text: 'Next to it sit the shared types and helpers. Most other areas reach in here, which is why its links fan out so widely.', highlights: [at(1)] },
          { parent: at(2), frame: 'file', text: 'Finish at one of the files that does the actual work, called from the entry point through the shared core.', highlights: [at(0), at(1)] },
        ];
        applyOps([
          ...pois.map((value): ModelPatch => ({ op: 'annotation', value })),
          { op: 'annotation', value: { type: 'tour', id: 'tour:v2', steps } },
        ]);
      }
      aiDone = true;
      events.emit('progress', { subsystem: 'ai', done: total, total });
      return { failure: null };
    },
    async requestDetail(poiId, question) {
      const find = () => replica.annotations.find((a): a is Poi => a.type === 'poi' && a.id === poiId);
      const setDetail = (detail: PoiDetail): void => {
        const poi = find();
        if (poi) applyOps([{ op: 'annotation', value: { ...poi, details: { ...poi.details, [question]: detail } } }]);
      };
      if (!find()) return { failure: null };
      setDetail({ status: 'loading' });
      await sleep(Math.min(800, waitMs / 2));
      if (disposed) return { failure: null };
      setDetail({
        status: 'ready',
        markdown: `**${DETAIL_QUESTIONS[question]}**\n\nA canned answer from the fake session: no server was asked. In the real app this is written from the file and the signatures of its neighbours.\n\n- reads its configuration once\n- is called from the entry point\n- has no callers outside its city`,
      });
      return { failure: null };
    },
    cancel() { aiCancelled = true; },
  };

  const session: Session = {
    source, config, replica, physics,
    get render() { return render; },
    content: new MemoryContentSource({}),
    ai,
    get stage() { return stage; },
    attachCanvas(canvas, attach = {}) {
      if (render) return render;
      const init: RenderInit = {
        canvas, config, replica, positions: physics.positions,
        theme: attach.theme ?? 'dark',
        particles: attach.particles ?? config.settings.particles, reducedMotion: attach.reducedMotion,
      };
      try { render = createRenderer(init); } catch { render = createNoopRenderer(init); }
      physics.onBuffers((b) => render?.setPositions(b));
      if (replica.rev > 0) {
        // the model arrived before the canvas: hand the renderer the whole thing as one full batch
        const tables = syntheticTables({ files, seed: opts.seed });
        render.applyBatch(tablesToFullBatch(tables, syntheticMeta(`synthetic-${files}`, tables), replica.rev));
      }
      if (revealed) void render.reveal({ instant: true });
      return render;
    },
    async start() {
      const steps = 20;
      setStage({ stage: 'manifest', label: 'Listing files' });
      await sleep(waitMs * 0.05);
      for (let i = 1; i <= steps && !disposed; i++) {
        const done = Math.round((files * i) / steps);
        setStage({ stage: 'reading', label: `Reading files ${done.toLocaleString()} / ${files.toLocaleString()}`, done, total: files });
        events.emit('progress', { subsystem: 'fastPass', done, total: files });
        await sleep((waitMs * 0.6) / steps);
      }
      setStage({ stage: 'structure', label: 'Finding structure' });
      await sleep(waitMs * 0.2);
      const tables = syntheticTables({ files, seed: opts.seed });
      const batch = tablesToFullBatch(tables, syntheticMeta(`synthetic-${files}`, tables));
      replica.apply(batch);
      physics.applyBatch(batch);
      render?.applyBatch(batch);
      events.emit('batch', batch);
      setStage({ stage: 'layout', label: 'Settling layout' });
      await physics.settle(config.reveal.settleMaxMs);
      await sleep(waitMs * 0.15);
      if (disposed) return;
      revealed = true;
      setStage({ stage: 'revealed', label: '' });
      events.emit('reveal', { structure: 'full' });
      void render?.reveal();
      if (opts.refinedAfterMs !== undefined) setTimeout(() => !disposed && events.emit('notice', { kind: 'refined-ready' }), opts.refinedAfterMs);
    },
    on: (evt, fn) => events.on(evt, fn),
    async applyRefined() { events.emit('notice', { kind: 'cleared', which: 'refined-ready' }); },
    async update() { events.emit('notice', { kind: 'cleared', which: 'files-changed' }); },
    setSelectedOverlay() {},
    reportFrame() {},
    async search(query, limit = 20): Promise<SearchHit[]> {
      const q = query.toLowerCase();
      const units = replica.table('unit');
      const hits: SearchHit[] = [];
      for (const s of units.slots()) {
        const id = units.ids[s]!;
        if (id.toLowerCase().includes(q)) hits.push({ ref: `u:${id}`, path: id, score: 1 });
        if (hits.length >= limit) break;
      }
      return hits;
    },
    async exportModel(): Promise<RepoModel> {
      throw new Error('fake session cannot export');
    },
    dispose() { disposed = true; render?.dispose(); physics.dispose(); events.clear(); },
  };
  return session;
}
