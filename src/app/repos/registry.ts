// What the landing page needs from the repo registry (PLAN.md §12, §17.7): the saved repos, and a way
// to open one. The registry itself belongs to src/persist; this is the two calls used here, with an
// empty default so the page works in a build or a browser that has none.
import type { RepoSource } from '../../contracts/pipeline';

export interface SavedRepo {
  id: string;
  name: string;
  /** Origin remote without scheme or credentials ("github.com/facebook/react"), or null for a local folder. */
  remoteUrl: string | null;
  /** Epoch milliseconds. */
  lastOpened: number;
}

export interface SavedRepos {
  /** Saved repos, most recently opened first. */
  listSaved(): Promise<SavedRepo[]>;
  /**
   * What to open for a saved repo: its snapshot (with the folder, when the browser still grants it),
   * or the folder alone to parse again. Null when neither is left. Call it from the click itself: the
   * browser only asks for folder permission during a user gesture.
   */
  openSaved(id: string): Promise<RepoSource | null>;
}

export const NO_SAVED_REPOS: SavedRepos = {
  listSaved: async () => [],
  openSaved: async () => null,
};

/**
 * Sources the landing page lists as saved repos. Demos have their own pills and a synthetic map is
 * not a repo. An imported map is not listed either: importModelFile keeps the file's own
 * parserVersion, and the snapshot store discards a snapshot whose version is not this build's, so a
 * saved import could turn into a pill that opens nothing. The user still has the file to drop again.
 */
const LISTED = new Set(['git', 'folder']);

async function fromPersistence(): Promise<SavedRepos> {
  const { openPersistence, requestPermission } = await import('../../persist');
  const persistence = await openPersistence();
  // nothing was saved in a session that cannot keep anything (private browsing)
  if (persistence.kind !== 'durable') return NO_SAVED_REPOS;
  // records as last listed, so a click can ask for folder permission before anything is awaited
  let listed = new Map<string, Awaited<ReturnType<typeof persistence.registry.list>>[number]>();
  return {
    async listSaved() {
      const records = (await persistence.registry.list()).filter((r) => LISTED.has(r.source));
      listed = new Map(records.map((r) => [r.id, r]));
      return records
        .map(({ id, name, remoteUrl, lastOpened }) => ({ id, name, remoteUrl, lastOpened }))
        .sort((a, b) => b.lastOpened - a.lastOpened);
    },
    async openSaved(id) {
      const known = listed.get(id);
      const asked = known?.locator?.kind === 'fsa' ? requestPermission(known.locator.root) : null;
      const record = known ?? (await persistence.registry.get(id));
      if (!record) return null;
      const model = await persistence.snapshots.load(id);
      const granted = asked ? (await asked) === 'granted' : record.locator?.kind === 'node';
      const locator = granted ? record.locator : undefined;
      if (!model && !locator) return null;
      await persistence.registry.touch(id);
      return model ? { kind: 'snapshot', model, locator } : { kind: 'directory', locator: locator! };
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
