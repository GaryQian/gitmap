// What a map that was opened without its folder still needs (PLAN.md §12): a saved map renders from
// its snapshot at once, and the folder follows when the browser allows it. Whoever opens such a map
// notes here what its folder answered; the map's chrome reads it back from the open session.
import { useSyncExternalStore } from 'react';
import type { RepoSource, Session } from '../../contracts/pipeline';
import type { RepoMeta } from '../../model/types';
import { folderCase, type FolderState } from './classify';
import type { StatusCase } from './messages';

export interface FolderOffer {
  /**
   * 'prompt': one click on "Allow folder access" is enough. 'denied', 'gone': the folder has to be
   * chosen again. 'none': the browser kept no folder for this map (Firefox, Safari).
   */
  state: Exclude<FolderState, 'granted'> | 'none';
  /** The stored folder, when there is one to ask about. */
  root?: FileSystemDirectoryHandle;
  /** The registry record to give a newly chosen folder to. */
  repoId?: string;
}

const offers = new WeakMap<RepoSource, FolderOffer>();
const listeners = new Set<() => void>();
let rev = 0;

/** Note what a source's folder needs: before opening it, and again when the answer changes. */
export function offerFolder(source: RepoSource, offer: FolderOffer): void {
  offers.set(source, offer);
  rev++;
  for (const listener of listeners) listener();
}

export function folderOffer(source: RepoSource): FolderOffer | null {
  return offers.get(source) ?? null;
}

/** Re-renders the caller when an offer changes; `folderNeed` is then read again. */
export function useFolderOffers(): number {
  return useSyncExternalStore(subscribe, () => rev);
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export interface FolderNeed {
  /** The line or action to show. */
  status: StatusCase;
  offer: FolderOffer | null;
}

/**
 * What the open map lacks to read files, or null when it lacks nothing or never had a folder to
 * lack: a demo reads its own content pack, a synthetic map has no files, a folder that is being
 * parsed is right there.
 */
export function folderNeed(session: Pick<Session, 'source' | 'content'> | null, meta: Pick<RepoMeta, 'source'> | null): FolderNeed | null {
  if (!session || session.content !== null) return null;
  const { source } = session;
  if (source.kind !== 'snapshot' || source.locator) return null;
  const offer = folderOffer(source);
  const status = folderCase(offer?.state ?? 'none', meta?.source === 'import');
  return status ? { status, offer } : null;
}
