// Development only: survive the full-page reloads that hot reloading falls back to.
//
// store.ts, session.ts and the other state-holding modules reload the page when they change (and an
// edit anywhere below them, in the pipeline, physics or renderer, reaches them), so every edit used
// to drop back to the landing page. This keeps the open source in IndexedDB (a folder handle, a
// File list and a snapshot model all survive structured cloning, which localStorage cannot hold) and
// the view state in localStorage, and reopens both on the next load.
//
// - Closing the map (back to the landing page with no message) forgets it.
// - A fatal error does not: the next reload, usually the one that brings the fix, tries again.
// - A folder whose read permission did not survive the reload gets a "Reopen" pill on the landing
//   page instead (the browser asks again only from a click).
// - While a map is loading or open, the dev server holds back reloads for this tab and the map shows
//   "Code changed · Reload" instead (scripts/holdReloads.ts, devreload/).
// - `?fresh` on the URL starts at the landing page once; `?fake=…` already reopens itself.
import type { RepoSource } from '../contracts/pipeline';
import type { NodeRef } from '../model/types';
import { queryPermission, requestPermission } from '../persist';
import { setHold, setReopenOffer } from './devreload/state';
import { openSource } from './session';
import { useApp, type AppState } from './store';

const DB_NAME = 'starmap-dev-resume';
const STORE = 'kv';
const SOURCE_KEY = 'source';
const VIEW_KEY = 'starmap.dev.view';

type View = Pick<AppState, 'selection' | 'focus' | 'activeOverlay' | 'typeFilter' | 'minLines' | 'openFile'>;
const VIEW_FIELDS = ['selection', 'focus', 'activeOverlay', 'typeFilter', 'minLines', 'openFile'] as const;

let db: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

/** Transactions on one connection run in the order they are created, so a forget then a save lands as a save. */
async function write(fn: (store: IDBObjectStore) => void): Promise<void> {
  try {
    const tx = (await openDb()).transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    // DataCloneError for a source that cannot be stored: this reload simply starts over
    console.info('starmap(dev): could not keep the open map for the next reload', err);
  }
}

async function readSource(): Promise<RepoSource | null> {
  try {
    const store = (await openDb()).transaction(STORE, 'readonly').objectStore(STORE);
    return await new Promise((resolve, reject) => {
      const req = store.get(SOURCE_KEY);
      req.onsuccess = () => resolve((req.result as RepoSource | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

function saveView(s: AppState): void {
  const view: Partial<View> = {};
  for (const k of VIEW_FIELDS) (view as Record<string, unknown>)[k] = s[k];
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* no storage */ }
}
function loadView(): Partial<View> | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    return typeof v === 'object' && v !== null ? (v as Partial<View>) : null;
  } catch {
    return null;
  }
}
function forgetView(): void {
  try { localStorage.removeItem(VIEW_KEY); } catch { /* no storage */ }
}

/** The saved view, cleaned up enough that a stale or hand-edited entry cannot break the store. */
function usableView(v: Partial<View>): Partial<View> {
  const out: Partial<View> = {};
  const refs = (x: unknown): NodeRef[] | null => Array.isArray(x) && x.every((r) => typeof r === 'string') ? (x as NodeRef[]) : null;
  const ref = (x: unknown): NodeRef | null => (typeof x === 'string' ? (x as NodeRef) : null);
  const selection = refs(v.selection);
  if (selection) out.selection = selection;
  out.focus = selection && selection.includes(ref(v.focus)!) ? ref(v.focus) : null;
  out.openFile = ref(v.openFile);
  if (typeof v.activeOverlay === 'string' || v.activeOverlay === null) out.activeOverlay = v.activeOverlay;
  if (Array.isArray(v.typeFilter) && v.typeFilter.every((t) => typeof t === 'string')) out.typeFilter = v.typeFilter;
  if (typeof v.minLines === 'number' && Number.isFinite(v.minLines)) out.minLines = v.minLines;
  return out;
}

/** The folder handle of a source picked through the Chromium dialog, whose read permission must still hold. */
function fsaRoot(source: RepoSource): FileSystemDirectoryHandle | null {
  const locator = source.kind === 'directory' ? source.locator : source.kind === 'snapshot' ? source.locator : undefined;
  return locator?.kind === 'fsa' ? locator.root : null;
}

let started = false;

/** Keep the open map across reloads and reopen the last one now. Call once at start-up, in development. */
export function startDevResume(opts: { reopen: boolean }): void {
  if (started) return;
  started = true;

  // the view to put back once the reopened map is revealed; null when there is nothing to restore
  let pendingView: Partial<View> | null = null;
  let resuming = false;

  useApp.subscribe((s, prev) => {
    // while a map is loading or open, code changes do not reload the page under it (scripts/holdReloads.ts)
    if ((s.phase === 'landing') !== (prev.phase === 'landing')) setHold(s.phase !== 'landing');
    if (s.phase !== 'landing' && prev.phase === 'landing') setReopenOffer(null);
    if (s.session && s.session !== prev.session) {
      const { source } = s.session;
      void write((st) => st.put(source, SOURCE_KEY));
      if (resuming) resuming = false;
      else { pendingView = null; forgetView(); }
    }
    // closed on purpose (an error leaves a message, and is kept so the next reload retries)
    if (s.phase === 'landing' && prev.phase !== 'landing' && s.message === null && !s.session) {
      void write((st) => st.delete(SOURCE_KEY));
      forgetView();
      pendingView = null;
    }
    if (s.phase !== 'map') return;
    if (prev.phase !== 'map' && pendingView) {
      const view = pendingView;
      pendingView = null;
      useApp.setState(view);
      return;
    }
    if (VIEW_FIELDS.some((k) => s[k] !== prev[k])) saveView(s);
  });

  // a map may already be loading (`?fake` starts before this module arrives)
  if (useApp.getState().phase !== 'landing') setHold(true);

  if (!opts.reopen) return;
  void (async () => {
    const source = await readSource();
    if (!source || useApp.getState().session) return;
    const reopen = async () => {
      const view = loadView();
      pendingView = view ? usableView(view) : null;
      resuming = true;
      console.info(`starmap(dev): reopening the last ${source.kind} map after reload (add ?fresh to skip)`);
      await openSource(source);
    };
    const root = fsaRoot(source);
    if (root && (await queryPermission(root)) !== 'granted') {
      // the browser asks again only from a click: offer one on the landing page
      setReopenOffer({
        name: root.name,
        reopen: async () => {
          if ((await requestPermission(root)) === 'granted') await reopen();
        },
      });
      return;
    }
    await reopen();
  })();
}
