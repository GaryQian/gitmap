// "Reset repo": throw away what was saved for the open repo and parse its folder again from scratch.
// What goes: the map's snapshot, its saved history walk, and the parse cache (the cache is keyed by
// blob id, not by repo, so it is cleared whole; other repos simply parse in full on their next open).
// The registry record stays, so the repo keeps its place on the landing page.
import type { RepoLocator } from '../../contracts/git';
import type { Session } from '../../contracts/pipeline';
import { closeSession, openSource } from '../session';

export interface ResetTarget {
  id: string;
  name: string;
  locator: RepoLocator;
}

/** What a reset would re-parse, or null when the open map has no folder to parse (a demo, an import, a synthetic map). */
export function resetTarget(session: Session | null): ResetTarget | null {
  if (!session) return null;
  const { source } = session;
  const locator = source.kind === 'directory' ? source.locator : source.kind === 'snapshot' ? source.locator : undefined;
  const meta = session.replica.meta;
  if (!locator || !meta) return null;
  return { id: meta.id, name: meta.name, locator };
}

/** Close the map, delete its saved data, and open the folder again as on a first visit. */
export async function resetRepo(target: ResetTarget): Promise<void> {
  // closed first, so the old map cannot write its snapshot back after it was deleted
  closeSession();
  const [{ openPersistence, opfsBlobStore }, { forgetHistory, HISTORY_DIR }] = await Promise.all([
    import('../../persist'),
    import('../../pipeline/persist'),
  ]);
  const p = await openPersistence();
  const results = await Promise.allSettled([
    p.snapshots.remove(target.id),
    p.facts.clear(),
    p.kind === 'durable' ? forgetHistory({ aux: opfsBlobStore(HISTORY_DIR) }, target.id) : Promise.resolve(),
  ]);
  for (const r of results) if (r.status === 'rejected') console.warn('starmap: part of the saved data could not be removed', r.reason);
  p.facts.close();
  await openSource({ kind: 'directory', locator: target.locator });
}
