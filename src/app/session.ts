// Opening and closing a map, and the wiring between the store, the Session and its renderer.
import { config } from '../config';
import type { RepoSource, Session } from '../contracts/pipeline';
import type { RenderApi } from '../contracts/render';
import { createSession } from '../pipeline';
import type { FakeSessionOptions } from '../testing/fakeSession';
import {
  addToSelection, freshView, IDLE_STAGE, pushNotice, selectOnly, setHover, setOpenFile, toggleSelection, useApp,
} from './store';

export function isNotImplemented(err: unknown): boolean {
  return err instanceof Error && /not implemented/i.test(err.message);
}

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

/** Close whatever is open and start a map from `source`: landing → waiting → map. */
export async function openSource(source: RepoSource): Promise<void> {
  closeSession();
  const mine = ++generation;
  useApp.setState({ phase: 'waiting', message: null });
  let session: Session;
  try {
    session = await makeSession(source);
  } catch (err) {
    if (mine === generation) closeSession(errorMessage(err));
    return;
  }
  if (mine !== generation) { session.dispose(); return; }
  const current = () => useApp.getState().session === session;

  const offs = [
    session.on('stage', (stage) => useApp.setState({ stage })),
    session.on('progress', ({ subsystem, done, total, label }) =>
      useApp.setState((s) => ({ progress: { ...s.progress, [subsystem]: { done, total, label } } }))),
    session.on('reveal', () => { if (current()) useApp.setState({ phase: 'map' }); }),
    session.on('notice', pushNotice),
    session.on('error', (e) => {
      if (!current()) return;
      if (e.fatal) closeSession(e.message); else pushNotice({ kind: 'info', message: e.message });
    }),
  ];
  unwire = () => { for (const off of offs) off(); };
  useApp.setState((s) => ({ session, sessionId: s.sessionId + 1, stage: session.stage }));

  try {
    await session.start();
  } catch (err) {
    if (current()) closeSession(errorMessage(err));
    return;
  }
  if (current()) useApp.setState({ phase: 'map' });
}

/** Dispose the open map and return to the landing page, optionally with a message under the button. */
export function closeSession(message: string | null = null): void {
  generation++;
  const { session } = useApp.getState();
  unwire?.();
  unwire = null;
  useApp.setState({
    phase: 'landing', session: null, render: null, stage: IDLE_STAGE, progress: {}, notices: [], message,
    backgroundEmphasis: 0, ...freshView(),
  });
  try { session?.dispose(); } catch (err) { console.warn('gitmap: session.dispose failed', err); }
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
    // any other failure (no WebGL, say) ends the session with the reason on the landing page.
    if (isNotImplemented(err)) console.warn('gitmap: no renderer yet', err);
    else closeSession(errorMessage(err));
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
  try { fn(); } catch (err) { console.warn(`gitmap: ${what} failed`, err); }
}

// Store → renderer and session. Everything is pushed once when a renderer appears, then on change.
useApp.subscribe((s, prev) => {
  const r = s.render;
  if (r) {
    const first = r !== prev.render;
    if (first || s.mode !== prev.mode) attempt('setTheme', () => r.setTheme(s.mode));
    if (first || s.settings.particles !== prev.settings.particles) attempt('setParticles', () => r.setParticles(s.settings.particles));
    if (first || s.selection !== prev.selection) attempt('setSelection', () => r.setSelection(s.selection));
    if (first || s.typeFilter !== prev.typeFilter) attempt('setTypeFilter', () => r.setTypeFilter(s.typeFilter));
    if (first || s.minLines !== prev.minLines) attempt('setMinLines', () => r.setMinLines(s.minLines));
  }
  if (s.session && s.session === prev.session && s.activeOverlay !== prev.activeOverlay) {
    const { session, activeOverlay } = s;
    attempt('setSelectedOverlay', () => session.setSelectedOverlay(activeOverlay));
  }
});

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
