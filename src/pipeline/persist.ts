// What the pipeline does with local storage (PLAN.md §12; the sequence is in src/persist/README.md):
// find a saved map for a folder, count what changed since it was saved, keep the stored snapshot and
// the registry record current, and keep the history walk's facts beside the snapshot so the next
// visit walks only newer commits (§6.5). Storage is optional everywhere: with no `deps.persist`
// nothing is read or written. Lead-owned.
import type { Config } from '../config';
import type { RepoLocator } from '../contracts/git';
import type { Manifest } from '../contracts/ingest';
import type { ModelStore } from '../contracts/store';
import { historyFromJson, historyToJson, type HistoryJson, type HistoryResult } from '../history';
import type { LayoutSnapshot, RepoModel } from '../model/types';
import {
  createSnapshotWriter, recordFromModel, snapshotFileName,
  type BlobStore, type RepoRegistry, type SnapshotStore, type SnapshotWriter,
} from '../persist';

/** The storage the pipeline uses. `openPersistence()` gives the first two; all three have in-memory twins. */
export interface PipelinePersistence {
  snapshots: SnapshotStore;
  registry: RepoRegistry;
  /** Named blobs kept beside the snapshots. Without it every visit walks the history from the start. */
  aux?: BlobStore;
}

export interface SavedMap {
  model: RepoModel;
  /** Paths whose content differs between the saved map and the folder: changed, added or deleted. */
  changed: number;
}

/**
 * Paths that differ between a saved model and the folder as the manifest lists it. A path counts
 * once, whether its blob changed, it is new, or it is gone.
 */
export function countChangedFiles(manifest: Manifest, model: RepoModel): number {
  const files = model.tables.file;
  const oids = files.cols.oid;
  const saved = new Map<string, string>();
  files.ids.forEach((path, i) => saved.set(path, oids?.[i] ?? ''));
  let changed = 0, seen = 0;
  for (const entry of manifest.entries) {
    const oid = saved.get(entry.path);
    if (oid === undefined) changed++;
    else { seen++; if (oid !== entry.oid) changed++; }
  }
  return changed + (saved.size - seen);
}

/**
 * The saved map to show instead of parsing (the return visit): the stored snapshot of this repo,
 * when it was written by this parser version from a finished structure. It is shown as it was saved
 * even when the folder has moved on; `changed` says by how much. Null means "parse".
 *
 * Only a git folder qualifies: without an index there are no blob ids to tell what changed, so a
 * plain folder is parsed again each time.
 */
export async function findSavedMap(persist: PipelinePersistence | undefined, manifest: Manifest, id: string, config: Config): Promise<SavedMap | null> {
  if (!persist || manifest.source !== 'git' || !manifest.indexChecksum) return null;
  let model: RepoModel | null;
  try { model = await persist.snapshots.load(id); } catch { return null; }
  if (!model || model.meta.parserVersion !== config.parser.version) return null;
  // A map saved between an imports-only reveal and its refinement is not worth keeping: the parse
  // that follows reads its facts from the cache and ends with the full structure.
  if (model.meta.structure !== 'full') return null;
  const changed = model.meta.indexChecksum === manifest.indexChecksum ? 0 : countChangedFiles(manifest, model);
  return { model, changed };
}

export interface SavingOptions {
  persist: PipelinePersistence;
  store: ModelStore;
  getLayout(): Promise<LayoutSnapshot>;
  locator?: RepoLocator;
  debounceMs: number;
  onError?(err: unknown): void;
}

/**
 * The debounced snapshot writer for one open map. Every save also refreshes the registry record
 * (name, head, checksum, the folder handle), which is what the landing page lists.
 */
export function startSaving(opts: SavingOptions): SnapshotWriter {
  const { persist, store, locator } = opts;
  return createSnapshotWriter({
    store: persist.snapshots,
    debounceMs: opts.debounceMs,
    onError: opts.onError,
    async getModel() {
      if (!store.replica.meta) return null;
      const model = store.toModel(await opts.getLayout());
      // The snapshot is still worth writing when the record cannot be: opening the folder finds it by id.
      try { await persist.registry.put(recordFromModel(model, locator)); } catch (err) { opts.onError?.(err); }
      return model;
    },
  });
}

// ---- the history walk's facts, beside the snapshot ----

const SNAPSHOT_SUFFIX = '.starmap.json.gz';
const HISTORY_SUFFIX = '.history.json.gz';

async function historyBlobName(id: string): Promise<string> {
  const name = await snapshotFileName(id);
  return (name.endsWith(SNAPSHOT_SUFFIX) ? name.slice(0, -SNAPSHOT_SUFFIX.length) : name) + HISTORY_SUFFIX;
}

async function pipeThrough(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The walk saved for a repo, usable as `since`. Null when there is none or it cannot be read. */
export async function loadSavedHistory(persist: PipelinePersistence | undefined, id: string): Promise<HistoryResult | null> {
  if (!persist?.aux) return null;
  try {
    const bytes = await persist.aux.get(await historyBlobName(id));
    if (!bytes) return null;
    const json = new TextDecoder().decode(await pipeThrough(bytes, new DecompressionStream('gzip')));
    return historyFromJson(JSON.parse(json) as HistoryJson);
  } catch {
    return null;
  }
}

/** Keep a finished walk for the next visit. Never rejects: losing it only costs a longer walk. */
export async function saveHistory(persist: PipelinePersistence | undefined, id: string, result: HistoryResult): Promise<void> {
  if (!persist?.aux) return;
  try {
    const json = new TextEncoder().encode(JSON.stringify(historyToJson(result)));
    await persist.aux.put(await historyBlobName(id), await pipeThrough(json, new CompressionStream('gzip')));
  } catch {
    // storage full or gone: the next visit walks from the start
  }
}
