// The path index behind Session.search (PLAN.md §9), kept beside the store: in the coordinator worker
// in the browser, in process for Node scripts. It follows the store's file table by itself, so it is
// in step after the reveal, after "Apply" and after an Update without anyone telling it.
import type { SearchHit } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import type { NodeRef } from '../model/types';
import { createSearchIndex, toSearchHits } from '../search';

export interface PipelineSearch {
  /** Best matches first, as unit refs: a header and its implementation both lead to their one sphere. */
  search(query: string, limit?: number): SearchHit[];
  /** Build the lookup text now (after the reveal, while nothing else is waiting) instead of on the first query. */
  warm(): void;
  dispose(): void;
}

export function createPipelineSearch(store: ModelStore): PipelineSearch {
  const index = createSearchIndex();
  const files = store.replica.table('file');
  // Paths are re-read from the file table only when a batch added or removed files.
  let stale = true;
  const unsubscribe = store.subscribe((batch) => {
    if (stale) return;
    if (batch.full) { stale = true; return; }
    for (const op of batch.ops) {
      if ((op.op === 'add' || op.op === 'remove') && op.kind === 'file') { stale = true; return; }
    }
  });

  function sync(): void {
    if (!stale) return;
    stale = false;
    const paths: string[] = [];
    for (const slot of files.slots()) paths.push(files.ids[slot]!);
    index.setPaths(paths);
  }

  /** The sphere a path belongs to, read at query time: memberships change without the paths changing. */
  function refOf(path: string): NodeRef | null {
    const slot = files.slotOf(path);
    const unit = slot >= 0 ? files.cols.unit[slot] : '';
    return unit ? `u:${unit}` : null;
  }

  return {
    search(query, limit) {
      sync();
      return toSearchHits(index.search(query, limit), refOf);
    },
    warm() {
      sync();
      index.warm();
    },
    dispose() { unsubscribe(); },
  };
}
