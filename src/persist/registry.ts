// The registry: one small record per repo the user has opened (PLAN.md §12). It is what the landing
// page lists, and where the folder handle lives between visits.
import type { RepoLocator } from '../contracts/git';
import type { RepoMeta, RepoModel, RepoStats } from '../model';
import { lazyDb, requestDone, transactionDone } from './idb';

/**
 * A locator worth keeping between visits: the directory handle ('fsa', structured-cloneable into
 * IndexedDB) or a path ('node'). Dropped files ('files') and in-memory repos ('memory') cannot be
 * reopened later and are never stored.
 */
export type StoredLocator = Extract<RepoLocator, { kind: 'fsa' | 'node' }>;

export interface RepoRecord {
  /** RepoMeta.id; also the snapshot's key. */
  id: string;
  name: string;
  remoteUrl: string | null;
  source: RepoMeta['source'];
  locator?: StoredLocator;
  headOid: string | null;
  indexChecksum: string | null;
  schema: number;
  parserVersion: string;
  /** Epoch milliseconds. */
  lastOpened: number;
  stats?: RepoStats;
}

export interface RepoRegistry {
  /** Every record, most recently opened first. */
  list(): Promise<RepoRecord[]>;
  get(id: string): Promise<RepoRecord | null>;
  /** Insert or replace the whole record (pass the locator again, or it is forgotten). */
  put(record: RepoRecord): Promise<void>;
  /** Set `lastOpened` to now. Does nothing when the id is unknown. */
  touch(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function storableLocator(locator: RepoLocator | undefined): StoredLocator | undefined {
  return locator && (locator.kind === 'fsa' || locator.kind === 'node') ? locator : undefined;
}

/** The registry record for a model as it stands now, opened at `now`. */
export function recordFromModel(model: RepoModel, locator?: RepoLocator, now: number = Date.now()): RepoRecord {
  const { meta } = model;
  const record: RepoRecord = {
    id: meta.id,
    name: meta.name,
    remoteUrl: meta.remoteUrl,
    source: meta.source,
    headOid: meta.headOid,
    indexChecksum: meta.indexChecksum,
    schema: model.schema,
    parserVersion: meta.parserVersion,
    lastOpened: now,
    stats: { ...meta.stats },
  };
  const kept = storableLocator(locator);
  if (kept) record.locator = kept;
  return record;
}

/**
 * True when the repo on disk is no longer the one the record (and so its snapshot) describes: the
 * index was rewritten or HEAD moved. The saved map still renders; this is what decides whether to
 * look for changed files and offer "N files changed · Update" (PLAN.md §6.8).
 */
export function hasChanged(
  record: Pick<RepoRecord, 'headOid' | 'indexChecksum'>,
  current: { headOid: string | null; indexChecksum: string | null },
): boolean {
  return record.indexChecksum !== current.indexChecksum || record.headOid !== current.headOid;
}

/** What is actually stored: the record without a locator that cannot be reopened. */
function clean(record: RepoRecord): RepoRecord {
  const { locator, ...rest } = record;
  const kept = storableLocator(locator);
  return kept ? { ...rest, locator: kept } : rest;
}

const newestFirst = (a: RepoRecord, b: RepoRecord) => b.lastOpened - a.lastOpened || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function memoryRegistry(now: () => number = Date.now): RepoRegistry {
  const records = new Map<string, RepoRecord>();
  return {
    async list() { return [...records.values()].map((r) => ({ ...r })).sort(newestFirst); },
    async get(id) { const r = records.get(id); return r ? { ...r } : null; },
    async put(record) { records.set(record.id, clean(record)); },
    async touch(id) { const r = records.get(id); if (r) r.lastOpened = now(); },
    async remove(id) { records.delete(id); },
  };
}

let persistRequest: Promise<boolean> | null = null;

/**
 * Ask the browser not to evict this origin's storage under pressure (`navigator.storage.persist()`).
 * Asked at most once per context; resolves false where it is refused or unavailable. `persist` is
 * not exposed in workers, so when the registry lives in a worker the app must call this from the page.
 */
export function requestPersistentStorage(): Promise<boolean> {
  persistRequest ??= (async () => {
    try {
      const storage = globalThis.navigator?.storage;
      if (typeof storage?.persist !== 'function') return false;
      return (await storage.persisted()) || (await storage.persist());
    } catch {
      return false;
    }
  })();
  return persistRequest;
}

const STORE = 'repos';

export interface IndexedDbRegistry extends RepoRegistry { close(): void }

/** The registry in IndexedDB. The database is opened on first use. */
export function indexedDbRegistry(dbName = 'starmap-registry', now: () => number = Date.now): IndexedDbRegistry {
  const db = lazyDb(dbName, 1, (d) => { d.createObjectStore(STORE, { keyPath: 'id' }); });
  const store = async (mode: IDBTransactionMode) => {
    const tx = (await db.open()).transaction(STORE, mode);
    return { tx, repos: tx.objectStore(STORE) };
  };
  return {
    async list() {
      const { repos } = await store('readonly');
      return (await requestDone<RepoRecord[]>(repos.getAll())).sort(newestFirst);
    },
    async get(id) {
      const { repos } = await store('readonly');
      return (await requestDone<RepoRecord | undefined>(repos.get(id))) ?? null;
    },
    async put(record) {
      const { tx, repos } = await store('readwrite');
      repos.put(clean(record));
      await transactionDone(tx);
      void requestPersistentStorage(); // best effort, once, now that there is something worth keeping
    },
    async touch(id) {
      const { tx, repos } = await store('readwrite');
      const get = repos.get(id);
      get.onsuccess = () => {
        const record = get.result as RepoRecord | undefined;
        if (record) repos.put({ ...record, lastOpened: now() });
      };
      await transactionDone(tx);
    },
    async remove(id) {
      const { tx, repos } = await store('readwrite');
      repos.delete(id);
      await transactionDone(tx);
    },
    close: () => db.close(),
  };
}
