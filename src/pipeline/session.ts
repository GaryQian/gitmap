// The main-thread Session: a view replica, the physics client, the renderer once a canvas is
// attached, and a coordinator worker that does everything else (PLAN.md §3). Lead-owned.
import type { Config } from '../config';
import { directorySource, openPackage, readPackage, type OpenedPackage } from '../content';
import type { ContentSource } from '../contracts/git';
import type { PhysicsApi } from '../contracts/physics';
import type { PipelineEvents, RepoSource, SearchHit, Session, StageInfo } from '../contracts/pipeline';
import type { RenderApi } from '../contracts/render';
import { createReplica } from '../model';
import type { PatchBatch, RepoModel } from '../model/types';
import { createPhysicsClient } from '../physics';
import { createRenderer } from '../render';
import { Emitter } from '../shared';
import type { CoordinatorCalls, CoordinatorMethod, FromCoordinator, MainCalls, ToCoordinator } from './protocol';

/** A package's files, before the package itself is open: every call waits for it. */
function packageContent(opening: () => Promise<OpenedPackage>): ContentSource {
  let opened: OpenedPackage | null = null;
  const pkg = async () => (opened ??= await opening());
  return {
    read: async (ref) => (await pkg()).content.read(ref),
    progress: () => opened?.content.progress() ?? { loaded: 0, total: null, done: false },
    has: (path) => opened?.content.has(path) ?? null,
  };
}

const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1);

export function createBrowserSession(source: RepoSource, config: Config): Session {
  const events = new Emitter<PipelineEvents>();
  const replica = createReplica();
  const fileGuess = source.kind === 'synthetic' ? source.files : source.kind === 'snapshot' ? source.model.tables.unit.ids.length : 8192;
  const physics: PhysicsApi = createPhysicsClient({
    config,
    capacity: { units: Math.max(1024, Math.ceil(fileGuess * 1.25)), districts: Math.max(512, Math.ceil(fileGuess / 4)), cities: 256 },
  });
  let render: RenderApi | null = null;
  let stage: StageInfo = { stage: 'idle', label: '' };
  let revealed = false;
  let disposed = false;
  let worker: Worker | null = null;
  let started: Promise<void> | null = null;
  /** The blob id the map recorded for a path: what a package's files are checked against. */
  const oidOf = (path: string): string | null => {
    const files = replica.table('file');
    const slot = files.slotOf(path);
    return slot >= 0 ? files.cols.oid[slot] || null : null;
  };
  // A demo is one package (plan/DEMO-MODE.md §4): the page downloads it once, hands the map to the
  // coordinator as soon as that part has arrived, and keeps the files, which go on arriving.
  let demo: Promise<OpenedPackage> | null = null;
  const openDemo = (): Promise<OpenedPackage> => {
    if (source.kind !== 'demo') return Promise.reject(new Error('This map is not a demo.'));
    demo ??= openPackage(typeof location === 'undefined' ? source.url : new URL(source.url, location.href).href, {
      oidOf,
      onProgress(loaded, total) {
        if (disposed || revealed) return;
        stage = { stage: 'structure', label: total ? `Downloading demo ${megabytes(loaded)} / ${megabytes(total)} MB` : `Downloading demo ${megabytes(loaded)} MB`, done: loaded, total: total ?? undefined };
        events.emit('stage', stage);
      },
    });
    return demo;
  };
  let dropped: Promise<OpenedPackage> | null = null;
  /**
   * Where file contents come from (PLAN.md §12.1): the user's folder, or the package the map came
   * in, checked against the blob ids the map recorded. Null when there is neither.
   */
  function contentFor(): ContentSource | null {
    if (source.kind === 'directory') return directorySource(source.locator);
    if (source.kind === 'snapshot') {
      if (source.locator) return directorySource(source.locator);
      const file = source.package;
      return file ? packageContent(() => (dropped ??= readPackage(file, { oidOf }))) : null;
    }
    if (source.kind === 'demo') return packageContent(openDemo);
    return null;
  }
  let content: ContentSource | null = contentFor();
  /** Tell the coordinator the page was hidden, so a snapshot that is waiting gets written (PLAN.md §12). */
  const onVisibility = () => { if (document.visibilityState === 'hidden') send({ type: 'hidden' }); };

  const send = (m: ToCoordinator) => worker?.postMessage(m);
  /** Counts ai.cancel() calls, so a detail request whose file read straddles a cancel is dropped. */
  let aiCancels = 0;
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  function call<M extends CoordinatorMethod>(method: M, ...args: Parameters<CoordinatorCalls[M]>): Promise<ReturnType<CoordinatorCalls[M]>> {
    if (!worker) return Promise.reject(new Error('The map has not started loading.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      send({ type: 'call', id, method, args });
    });
  }

  const mainCalls: { [M in keyof MainCalls]: (...args: Parameters<MainCalls[M]>) => Promise<ReturnType<MainCalls[M]>> | ReturnType<MainCalls[M]> } = {
    settle: (maxMs) => physics.settle(maxMs),
    relayout: (maxMs) => physics.relayout(maxMs),
    // loadLayout is a message to the physics worker; a round trip makes sure the positions have
    // landed before the coordinator goes on to the reveal.
    loadLayout: async (layout) => { physics.loadLayout(layout); await physics.getLayout(); },
    getLayout: () => physics.getLayout(),
    demoPackage: async () => {
      const { manifest, map } = await openDemo();
      return { manifest, map };
    },
  };

  function onBatch(batch: PatchBatch): void {
    if (!replica.apply(batch)) {
      // A gap should be impossible on an ordered channel; surface it instead of drawing a suspect scene.
      events.emit('error', { message: 'The map fell out of step with its data and needs to be reloaded.', fatal: true });
      return;
    }
    physics.applyBatch(batch);
    render?.applyBatch(batch);
    events.emit('batch', batch);
  }

  let frameSent = 0;
  const session: Session = {
    source, config, replica, physics,
    get render() { return render; },
    get content() { return content; },
    get stage() { return stage; },
    attachCanvas(canvas, opts = {}) {
      if (render) return render;
      render = createRenderer({
        canvas, config, replica, positions: physics.positions,
        theme: opts.theme ?? 'dark',
        particles: opts.particles ?? config.settings.particles,
        reducedMotion: opts.reducedMotion ?? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches),
      });
      physics.onBuffers((b) => render?.setPositions(b));
      // The model may have arrived first: an empty batch at the current revision makes the renderer
      // notice the gap and rebuild itself from the replica (PLAN.md §5.1).
      if (replica.rev > 0) render.applyBatch({ rev: replica.rev, baseRev: replica.rev - 1, ops: [] });
      if (revealed) void render.reveal({ instant: true });
      render.on('frame', (f) => {
        physics.setFocus(f.target, f.cameraDistance);
        if (f.time - frameSent > 250) { frameSent = f.time; session.reportFrame(f.frameMs, f.moving); }
      });
      return render;
    },
    start() {
      if (started) return started;
      started = new Promise<void>((resolve, reject) => {
        worker = new Worker(new URL('./coordinator.worker.ts', import.meta.url), { type: 'module' });
        worker.onerror = (e) => {
          const message = e.message || 'The background worker stopped unexpectedly.';
          stage = { stage: 'failed', label: message };
          events.emit('stage', stage);
          events.emit('error', { message, fatal: true });
          reject(new Error(message));
        };
        worker.onmessage = (ev: MessageEvent<FromCoordinator>) => {
          if (disposed) return;
          const msg = ev.data;
          switch (msg.type) {
            case 'event':
              if (msg.evt === 'batch') onBatch(msg.payload);
              else if (msg.evt === 'stage') { stage = msg.payload; events.emit('stage', stage); }
              else if (msg.evt === 'reveal') {
                revealed = true;
                events.emit('reveal', msg.payload);
                void render?.reveal();
                resolve();
              } else events.emit(msg.evt, msg.payload as never);
              break;
            case 'request':
              Promise.resolve()
                .then(() => (mainCalls[msg.method] as (...a: unknown[]) => unknown)(...msg.args))
                .then(
                  (value) => send({ type: 'reply', id: msg.id, ok: true, value }),
                  (err) => send({ type: 'reply', id: msg.id, ok: false, error: String(err?.message ?? err) }),
                );
              break;
            case 'result': {
              const p = pending.get(msg.id);
              if (!p) break;
              pending.delete(msg.id);
              if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
              break;
            }
            case 'failed':
              stage = { stage: 'failed', label: msg.message };
              events.emit('stage', stage);
              events.emit('error', { message: msg.message, fatal: true });
              reject(new Error(msg.message));
              break;
            case 'started':
              break;
          }
        };
        send({ type: 'start', source, config });
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        // A parsed folder is saved for the next visit: ask the browser not to evict it. Only the page
        // can ask (navigator.storage.persist is not exposed in workers), and nothing waits for the answer.
        if (source.kind === 'directory') {
          void import('../persist').then((p) => p.requestPersistentStorage()).catch(() => { /* storage stays best-effort */ });
        }
      });
      return started;
    },
    on: (evt, fn) => events.on(evt, fn),
    applyRefined: () => call('applyRefined'),
    update: () => call('update'),
    setSelectedOverlay(layer) { send({ type: 'selectedOverlay', layer }); },
    reportFrame(frameMs, interacting) { send({ type: 'frame', frameMs, interacting }); },
    loadFullHistory: () => call('loadFullHistory'),
    ai: {
      get available() {
        return worker !== null && config.ai.enabled && source.kind !== 'demo'
          && source.kind !== 'synthetic' && !(source.kind === 'snapshot' && !source.locator);
      },
      start: () => call('aiStart'),
      async requestDetail(poiId, question) {
        // The file itself says more than its skeleton: read it here, where the folder is, when it can be read.
        const poi = replica.annotations.find((a) => a.type === 'poi' && a.id === poiId);
        const asked = aiCancels;
        let text: string | null = null;
        try {
          if (poi?.type === 'poi' && content) text = new TextDecoder().decode(await content.read(poi.parent));
        } catch { /* the skeleton will do */ }
        // AI notes were switched off while the file was being read: ask for nothing.
        if (asked !== aiCancels) return { failure: null };
        return call('aiDetail', poiId, question, text);
      },
      cancel() {
        aiCancels++;
        void call('aiCancel').catch(() => { /* nothing was running */ });
      },
    },
    async search(query, limit = 20): Promise<SearchHit[]> {
      // The index lives in the coordinator, beside the store (src/search). The substring match below
      // only answers while no coordinator is running: before start() and after dispose().
      if (worker) return call('search', query, limit);
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const units = replica.table('unit');
      const hits: SearchHit[] = [];
      for (const s of units.slots()) {
        const id = units.ids[s]!;
        const at = id.toLowerCase().lastIndexOf(q);
        if (at >= 0) hits.push({ ref: `u:${id}`, path: id, score: at >= id.lastIndexOf('/') ? 2 : 1 });
      }
      return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
    },
    async exportModel(): Promise<RepoModel> {
      return call('exportModel', await physics.getLayout());
    },
    // only a map with its folder beside it has files to read back
    ...((source.kind === 'directory' || (source.kind === 'snapshot' && source.locator)) && {
      readFiles: (paths: string[]) => call('readFiles', paths),
    }),
    dispose() {
      disposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new Error('closed'));
      pending.clear();
      render?.dispose();
      physics.dispose();
      events.clear();
      content = null;
    },
  };
  return session;
}
