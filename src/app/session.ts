// Opening and closing a map, and the wiring between the store, the Session and its renderer.
import { config } from '../config';
import type { RepoLocator } from '../contracts/git';
import type { RepoSource, Session } from '../contracts/pipeline';
import type { RenderApi } from '../contracts/render';
import type { RepoModel } from '../model/types';
import { createSession } from '../pipeline';
import type { FakeSessionOptions } from '../testing/fakeSession';
import { lineFor, statusLine } from './status/actions';
import { classifyBackground, classifyFatal, WORKTREE_REASON } from './status/classify';
import { gitIsFile } from './status/probe';
import { buildIsStale } from './status/stale';
import {
  addToSelection, freshView, IDLE_STAGE, pushNotice, selectOnly, setHover, setMessage, setOpenFile, toggleSelection, useApp,
  type AppState, type LineAction,
} from './store';

export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}

/** An error's own words. For the console: what the viewer reads comes from status/messages.ts. */
export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/**
 * `?fake=<files>` plays the whole flow on a synthetic model. Optional extras for looking at states:
 * `&wait=<ms>` on the waiting screen, `&refined=<ms>` raises "Refined structure ready" after the
 * reveal, `&seed=<n>`.
 */
export function fakeOptionsFromUrl(search: string = location.search): FakeSessionOptions | null {
  const qs = new URLSearchParams(search);
  if (!qs.has('fake')) return null;
  const num = (name: string): number | undefined => {
    const raw = qs.get(name);
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const files = num('fake');
  return { files: files ? Math.floor(files) : undefined, waitMs: num('wait'), refinedAfterMs: num('refined'), seed: num('seed') };
}

async function fakeSession(opts: FakeSessionOptions): Promise<Session> {
  // loaded on demand so the synthetic generator stays out of the main bundle
  const { createFakeSession } = await import('../testing/fakeSession');
  return createFakeSession(config, opts);
}

async function makeSession(source: RepoSource): Promise<Session> {
  const fake = fakeOptionsFromUrl();
  if (fake) return fakeSession(fake);
  try {
    return createSession(source, config);
  } catch (err) {
    // the pipeline is still a stub: show the flow on a synthetic model instead
    if (isNotImplemented(err)) return fakeSession(source.kind === 'synthetic' ? { files: source.files, seed: source.seed } : {});
    throw err;
  }
}

let generation = 0;
let unwire: (() => void) | null = null;

/** View state a reopened map takes over from the one it replaces. */
export type CarriedView = Partial<Pick<AppState, 'selection' | 'focus' | 'activeOverlay' | 'typeFilter' | 'minBytes' | 'openFile'>>;

/**
 * End the open map, or the attempt at one, with the one line for what went wrong (status/messages.ts).
 * The reason as it was reported goes to the console, never to the page.
 */
function fail(err: unknown, source: RepoSource): void {
  console.warn('starmap: the map could not be opened', err);
  const { id, params } = classifyFatal(err, { kind: source.kind, name: source.kind === 'demo' ? source.name : undefined });
  const line = lineFor(id, params);
  closeSession(line.text, line.action);
  if (id !== 'worker-failed') return;
  // A worker that will not start does not say why. When the build was replaced under this tab,
  // say that instead: reloading is then the whole fix.
  void buildIsStale().then((stale) => {
    if (!stale || useApp.getState().message !== line.text) return;
    const updated = lineFor('app-updated');
    setMessage(updated.text, updated.action);
  });
}

/** Close whatever is open and start a map from `source`: landing → waiting → map. */
export async function openSource(source: RepoSource, opts: { view?: CarriedView } = {}): Promise<void> {
  closeSession();
  const mine = ++generation;
  useApp.setState({ phase: 'waiting', message: null, messageAction: null });
  let session: Session;
  try {
    session = await makeSession(source);
  } catch (err) {
    if (mine === generation) fail(err, source);
    return;
  }
  if (mine !== generation) { session.dispose(); return; }
  const current = () => useApp.getState().session === session;
  let view = opts.view ?? null;
  const reveal = () => {
    if (!current()) return;
    useApp.setState({ phase: 'map', ...(view ?? {}) });
    view = null;
  };
  // "No history" is said once per map: not again after it is dismissed, whatever arrives later.
  let historyNoticed = false;

  const offs = [
    session.on('stage', (stage) => useApp.setState({ stage })),
    session.on('progress', ({ subsystem, done, total, label }) =>
      useApp.setState((s) => ({ progress: { ...s.progress, [subsystem]: { done, total, label } } }))),
    session.on('reveal', reveal),
    session.on('notice', (notice) => {
      if (notice.kind === 'info') {
        // the pipeline's sentence ends with whatever the exception said: keep that for the console
        console.info('starmap:', notice.message);
        pushNotice(statusLine(classifyBackground(notice.message), { fades: true }));
      } else if (notice.kind === 'no-history') {
        if (historyNoticed) return;
        historyNoticed = true;
        // a `.git` that is a file is a linked worktree, which the reason cannot tell from a plain folder
        void gitIsFile(source).then((worktree) => {
          if (current()) pushNotice(worktree ? { kind: 'no-history', reason: WORKTREE_REASON } : notice);
        });
      } else pushNotice(notice);
    }),
    session.on('error', (e) => {
      if (!current()) return;
      if (e.fatal) { fail(e.message, source); return; }
      // the map stays: one quiet line that goes away by itself
      console.warn('starmap:', e.message);
      pushNotice(statusLine(classifyBackground(e.message), { fades: true }));
    }),
  ];
  unwire = () => { for (const off of offs) off(); };
  useApp.setState((s) => ({ session, sessionId: s.sessionId + 1, stage: session.stage }));

  try {
    await session.start();
  } catch (err) {
    if (current()) fail(err, source);
    return;
  }
  reveal();
}

/**
 * Dispose the open map and return to the landing page, optionally with a line under the button and
 * the one thing that line offers to do.
 */
export function closeSession(message: string | null = null, action: LineAction | null = null): void {
  generation++;
  const { session } = useApp.getState();
  unwire?.();
  unwire = null;
  useApp.setState({
    phase: 'landing', session: null, render: null, stage: IDLE_STAGE, progress: {}, notices: [], message,
    messageAction: message === null ? null : action, contextLost: false, backgroundEmphasis: 0, ...freshView(),
  });
  try { session?.dispose(); } catch (err) { console.warn('starmap: session.dispose failed', err); }
}

/**
 * Give the open map its folder: the same map is opened again from what is on screen, this time with
 * the folder beside it, so files can be read and changes counted. The `Session` contract has no way
 * to attach a folder to a running map, so this is a reopen; the selection, the filters and the open
 * file carry over. Resolves false when there is no map to reopen.
 */
export async function reopenWithFolder(locator: RepoLocator): Promise<boolean> {
  const { session } = useApp.getState();
  if (!session) return false;
  let model: RepoModel | null = null;
  try {
    model = await session.exportModel(); // with the layout as it is now
  } catch (err) {
    console.warn('starmap: the open map could not be exported; reopening it as it was loaded', err);
    if (session.source.kind === 'snapshot') model = session.source.model;
  }
  if (!model || useApp.getState().session !== session) return false;
  const s = useApp.getState();
  const view: CarriedView = {
    selection: s.selection, focus: s.focus, activeOverlay: s.activeOverlay, typeFilter: s.typeFilter, minBytes: s.minBytes, openFile: s.openFile,
  };
  await openSource({ kind: 'snapshot', model, locator }, { view });
  return true;
}

/** Hand the map canvas to the open session. The renderer then follows the store (see below). */
export function attachCanvas(canvas: HTMLCanvasElement): void {
  const { session, render: attached } = useApp.getState();
  if (!session || attached) return;
  let render: RenderApi;
  try {
    const s = useApp.getState();
    render = session.attachCanvas(canvas, { theme: s.mode, particles: s.settings.particles, reducedMotion: s.reducedMotion });
  } catch (err) {
    // While the renderer is still a stub the map screen shows its chrome over the bare background;
    // any other failure ends the session with one line on the landing page. three.js throws
    // "Error creating WebGL context" when the browser will not give it one.
    if (isNotImplemented(err)) { console.warn('starmap: no renderer yet', err); return; }
    console.warn('starmap: the renderer could not be created', err);
    const line = lineFor(/webgl|context/i.test(errorMessage(err)) ? 'webgl-unavailable' : 'map-not-drawn');
    closeSession(line.text, line.action);
    return;
  }
  // pointer events from the scene become view state; features read it from the store
  render.on('hover', (e) => setHover(e.ref));
  // click replaces and focuses, Shift+click adds or removes, a click on empty space clears (selectionState.ts)
  render.on('click', (e) => {
    if (!e.shift) selectOnly(e.ref);
    else if (e.ref !== null) toggleSelection(e.ref);
  });
  render.on('dblclick', (e) => setOpenFile(e.ref));
  render.on('marquee', (e) => addToSelection(e.refs));
  useApp.setState({ render });
}

/** A renderer or session method may still be another package's stub; one failing must not break the rest. */
function attempt(what: string, fn: () => void): void {
  try { fn(); } catch (err) { console.warn(`starmap: ${what} failed`, err); }
}

// Store → renderer and session. Everything is pushed once when a renderer appears, then on change.
useApp.subscribe((s, prev) => {
  const r = s.render;
  if (r) {
    const first = r !== prev.render;
    if (first || s.mode !== prev.mode) attempt('setTheme', () => r.setTheme(s.mode));
    if (first || s.settings.particles !== prev.settings.particles) attempt('setParticles', () => r.setParticles(s.settings.particles));
    if (first || s.settings.ribbons !== prev.settings.ribbons) attempt('setRibbons', () => r.setRibbons(s.settings.ribbons));
    if (first || s.settings.poiBeams !== prev.settings.poiBeams) attempt('setPoiBeams', () => r.setPoiBeams(s.settings.poiBeams));
    if (first || s.selection !== prev.selection) attempt('setSelection', () => r.setSelection(s.selection));
    if (first || s.typeFilter !== prev.typeFilter) attempt('setTypeFilter', () => r.setTypeFilter(s.typeFilter));
    if (first || s.minBytes !== prev.minBytes) attempt('setMinBytes', () => r.setMinBytes(s.minBytes));
  }
  if (s.session && s.session === prev.session && s.activeOverlay !== prev.activeOverlay) {
    const { session, activeOverlay } = s;
    attempt('setSelectedOverlay', () => session.setSelectedOverlay(activeOverlay));
  }
});

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
