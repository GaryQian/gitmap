// What the landing page needs from the repo registry (PLAN.md §12, §17.7): the saved repos, a way to
// open one, and a way to drop one. The registry itself belongs to src/persist; this is the handful of
// calls used here, with an empty default so the page works in a build or a browser that has none.
import { config } from '../../config';
import type { RepoSource } from '../../contracts/pipeline';
import type { RepoModel } from '../../model/types';
import type { FolderOffer } from '../status/folder';

export interface SavedRepo {
  id: string;
  name: string;
  /** Origin remote without scheme or credentials ("github.com/facebook/react"), or null for a local folder. */
  remoteUrl: string | null;
  /** Epoch milliseconds. */
  lastOpened: number;
}

/** What to open for a saved repo, and what its folder still needs when it could not come along. */
export interface SavedOpen {
  source: RepoSource;
  /** Present when the map opens from its snapshot alone: files and updates wait for the folder. */
  folder?: FolderOffer;
}

export interface SavedRepos {
  /** False when nothing outlives this page (private browsing, storage denied). */
  readonly remembers: boolean;
  /** Saved repos, most recently opened first. */
  listSaved(): Promise<SavedRepo[]>;
  /**
   * What to open for a saved repo (PLAN.md §12). Its snapshot opens at once, with the folder when
   * the browser already allows it and without when it would have to ask: the map then offers
   * "Allow folder access". A repo whose snapshot is gone or was written by another parser or schema
   * version is parsed again from its folder; for that the browser may ask for permission, which it
   * only does during a user gesture, so call this from the click itself. Null when neither a
   * snapshot nor a readable folder is left.
   */
  openSaved(id: string): Promise<SavedOpen | null>;
  /** Forget a saved repo: its record, its snapshot and its saved history. The folder itself is never touched. */
  removeSaved(id: string): Promise<void>;
  /** Keep a newly chosen folder with a saved repo, so the next visit asks about this one. */
  rememberFolder(id: string, root: FileSystemDirectoryHandle): Promise<void>;
}

export const NO_SAVED_REPOS: SavedRepos = {
  remembers: false,
  listSaved: async () => [],
  openSaved: async () => null,
  removeSaved: async () => {},
  rememberFolder: async () => {},
};

/**
 * Sources the landing page lists as saved repos. Demos have their own pills and a synthetic map is
 * not a repo. An imported map is not listed either: importModelFile keeps the file's own
 * parserVersion, and the snapshot store discards a snapshot whose version is not this build's, so a
 * saved import could turn into a pill that opens nothing. The user still has the file to drop again.
 */
const LISTED = new Set(['git', 'folder']);

async function fromPersistence(): Promise<SavedRepos> {
  const { openPersistence, opfsBlobStore, probeFolder, requestPermission, SNAPSHOT_SCHEMA } = await import('../../persist');
  const persistence = await openPersistence();
  // nothing was saved in a session that cannot keep anything (private browsing)
  if (persistence.kind !== 'durable') return NO_SAVED_REPOS;
  const { registry, snapshots } = persistence;
  // records as last listed, so a click can ask for folder permission before anything is awaited
  let listed = new Map<string, Awaited<ReturnType<typeof registry.list>>[number]>();
  /** Listed repos whose snapshot this build will not be able to show: opening one means parsing its folder. */
  let stale = new Set<string>();
  return {
    remembers: true,
    async listSaved() {
      const records = (await registry.list()).filter((r) => LISTED.has(r.source));
      const stored = new Set(await snapshots.list().catch(() => records.map((r) => r.id)));
      listed = new Map(records.map((r) => [r.id, r]));
      stale = new Set(records
        .filter((r) => r.schema !== SNAPSHOT_SCHEMA || r.parserVersion !== config.parser.version || !stored.has(r.id))
        .map((r) => r.id));
      return records
        .map(({ id, name, remoteUrl, lastOpened }) => ({ id, name, remoteUrl, lastOpened }))
        .sort((a, b) => b.lastOpened - a.lastOpened);
    },
    async openSaved(id) {
      const known = listed.get(id);
      const root = known?.locator?.kind === 'fsa' ? known.locator.root : null;
      // Parsing again needs the folder, and the browser asks only during the click: before any await.
      const asked = root && stale.has(id) ? requestPermission(root) : null;
      const record = known ?? (await registry.get(id));
      if (!record) return null;
      let model: RepoModel | null = null;
      try {
        model = await snapshots.load(id);
      } catch (err) {
        console.warn('starmap: the saved map could not be read from storage', err);
      }
      const { locator } = record;
      let folder: FolderOffer['state'] | 'granted' = 'none';
      if (locator?.kind === 'fsa') {
        if (asked) await asked;
        folder = await probeFolder(locator.root);
        if (!model && folder === 'prompt' && !asked) {
          // the snapshot turned out to be unusable only now; the click is usually still fresh enough to ask
          await requestPermission(locator.root);
          folder = await probeFolder(locator.root);
        }
      } else if (locator?.kind === 'node') folder = 'granted';

      if (!model) {
        // evicted, damaged, or from another parser or schema version: the folder is parsed again
        if (!locator || folder !== 'granted') return null;
        await registry.touch(id).catch(() => { /* the order of the pills is all that is lost */ });
        return { source: { kind: 'directory', locator } };
      }
      await registry.touch(id).catch(() => { /* as above */ });
      if (locator && folder === 'granted') return { source: { kind: 'snapshot', model, locator } };
      // The map shows at once from its snapshot; the folder follows from the map's own chrome.
      const offer: FolderOffer = { state: folder === 'granted' ? 'none' : folder, repoId: id };
      if (locator?.kind === 'fsa') offer.root = locator.root;
      return { source: { kind: 'snapshot', model }, folder: offer };
    },
    async removeSaved(id) {
      listed.delete(id);
      stale.delete(id);
      await registry.remove(id);
      await snapshots.remove(id).catch(() => { /* nothing was stored, or it is already gone */ });
      // and the history walk kept beside the snapshot (never rejects)
      const { forgetHistory, HISTORY_DIR } = await import('../../pipeline/persist');
      await forgetHistory({ aux: opfsBlobStore(HISTORY_DIR) }, id);
    },
    async rememberFolder(id, root) {
      const record = await registry.get(id);
      if (!record) return;
      const next = { ...record, locator: { kind: 'fsa' as const, root } };
      await registry.put(next);
      if (listed.has(id)) listed.set(id, next);
    },
  };
}

let shared: Promise<SavedRepos> | null = null;

/** The saved repos of this browser. Resolves to the empty default when there is no persistence to ask. */
export function savedRepos(): Promise<SavedRepos> {
  shared ??= fromPersistence().catch((err) => {
    console.warn('starmap: saved repos are unavailable', err);
    return NO_SAVED_REPOS;
  });
  return shared;
}

/** "github.com/facebook/react" for a repo with a remote; "local folder" without one (PLAN.md §17.7). */
export function whereLabel(remoteUrl: string | null): string {
  return remoteUrl || 'local folder';
}
