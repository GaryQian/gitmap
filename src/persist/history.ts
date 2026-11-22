// Where a repo's saved history walk lives, and how to drop it. The walk itself is written and read
// by the pipeline (src/pipeline/persist.ts); the name and the "forget" live here so the app can
// remove a saved repo without importing the pipeline.
import type { BlobStore } from './blobStore';
import { snapshotFileName } from './snapshots';

/** The OPFS directory beside `snapshots/` that holds each repo's history facts. */
export const HISTORY_DIR = 'history';

const SNAPSHOT_SUFFIX = '.starmap.json.gz';
const HISTORY_SUFFIX = '.history.json.gz';

/** File name of a repo's saved history walk: its snapshot's name with the history suffix. */
export async function historyBlobName(id: string): Promise<string> {
  const name = await snapshotFileName(id);
  return (name.endsWith(SNAPSHOT_SUFFIX) ? name.slice(0, -SNAPSHOT_SUFFIX.length) : name) + HISTORY_SUFFIX;
}

/** Drop the walk saved for a repo, so the next open walks from the start. Never rejects. */
export async function forgetHistory(persist: { aux?: BlobStore } | undefined, id: string): Promise<void> {
  if (!persist?.aux) return;
  try { await persist.aux.delete(await historyBlobName(id)); } catch { /* nothing saved, or storage gone */ }
}
