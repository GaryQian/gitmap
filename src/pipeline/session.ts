// The main-thread Session: a view replica, the physics client, the renderer once a canvas is
// attached, and a coordinator worker that does everything else (PLAN.md §3). Lead-owned.
import type { Config } from '../config';
import type { ContentSource, RepoLocator } from '../contracts/git';
import type { PhysicsApi } from '../contracts/physics';
import type { PipelineEvents, RepoSource, SearchHit, Session, StageInfo } from '../contracts/pipeline';
import type { RenderApi } from '../contracts/render';
import { createReplica } from '../model';
import { parseRef, type NodeRef, type PatchBatch, type RepoModel } from '../model/types';
import { createPhysicsClient } from '../physics';
import { createRenderer } from '../render';
import { Emitter } from '../shared';
import type { CoordinatorCalls, CoordinatorMethod, FromCoordinator, MainCalls, ToCoordinator } from './protocol';

function appearance(config: Config): 'dark' | 'light' {
  const a = config.settings.appearance;
  if (a === 'light') return 'light';
  if (a === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

/** Read working-tree files straight from the picked folder (sidebar reader, AI detail buttons). */
function directoryContent(locator: RepoLocator): ContentSource | null {
  if (locator.kind === 'fsa') {
    const dirs = new Map<string, Promise<FileSystemDirectoryHandle>>([['', Promise.resolve(locator.root)]]);
    const dir = (path: string): Promise<FileSystemDirectoryHandle> => {
      let d = dirs.get(path);
      if (!d) {
        const i = path.lastIndexOf('/');
        const parent = dir(i < 0 ? '' : path.slice(0, i));
        d = parent.then((p) => p.getDirectoryHandle(i < 0 ? path : path.slice(i + 1)));
        dirs.set(path, d);
      }
      return d;
    };
    return {
      async read(ref: NodeRef) {
        const path = parseRef(ref).id;
        const i = path.lastIndexOf('/');
        const d = await dir(i < 0 ? '' : path.slice(0, i));
        const file = await (await d.getFileHandle(i < 0 ? path : path.slice(i + 1))).getFile();
        return new Uint8Array(await file.arrayBuffer());
      },
    };
  }
  if (locator.kind === 'files') {
    const byPath = new Map(locator.files.map((f) => [f.path, f.file]));
    return {
      async read(ref: NodeRef) {
        const file = byPath.get(parseRef(ref).id);
        if (!file) throw new Error('That file is not in the chosen folder.');
        return new Uint8Array(await file.arrayBuffer());
      },
    };
  }
  return null;
}

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
  let content: ContentSource | null = source.kind === 'directory' ? directoryContent(source.locator) : source.kind === 'snapshot' && source.locator ? directoryContent(source.locator) : null;

  const send = (m: ToCoordinator) => worker?.postMessage(m);
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
    // loadLayout is a message to the physics worker; a round trip makes sure the positions have
    // landed before the coordinator goes on to the reveal.
    loadLayout: async (layout) => { physics.loadLayout(layout); await physics.getLayout(); },
    getLayout: () => physics.getLayout(),
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
        theme: opts.theme ?? appearance(config),
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
      });
      return started;
    },
    on: (evt, fn) => events.on(evt, fn),
    applyRefined: () => call('applyRefined'),
    update: () => call('update'),
    setSelectedOverlay(layer) { send({ type: 'selectedOverlay', layer }); },
    reportFrame(frameMs, interacting) { send({ type: 'frame', frameMs, interacting }); },
    async search(query, limit = 20): Promise<SearchHit[]> {
      // Plain substring match until the search package (4E) replaces it.
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
    dispose() {
      disposed = true;
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
