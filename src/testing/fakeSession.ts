// A Session that parses nothing: it plays the waiting-screen stages on timers, then reveals a
// synthetic model laid out by the static physics fake. The app shell and the dev harness run against
// it until the real pipeline exists, and UI work can keep using it afterwards.
import type { Config } from '../config';
import type { PipelineEvents, RepoSource, SearchHit, Session, StageInfo } from '../contracts/pipeline';
import type { BackgroundApi, RenderApi, RenderEvents, RenderInit } from '../contracts/render';
import type { PhysicsApi } from '../contracts/physics';
import { createReplica } from '../model';
import type { RepoModel } from '../model/types';
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
    setSelection() {}, setHighlights() {}, setTypeFilter() {}, setMinLines() {},
    async flyTo() {}, async resetView() {}, isDefaultView: () => true,
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

  const session: Session = {
    source, config, replica, physics,
    get render() { return render; },
    content: new MemoryContentSource({}),
    get stage() { return stage; },
    attachCanvas(canvas) {
      if (render) return render;
      const init: RenderInit = { canvas, config, replica, positions: physics.positions, theme: config.settings.appearance === 'light' ? 'light' : 'dark', particles: config.settings.particles };
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
