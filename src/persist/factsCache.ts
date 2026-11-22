// Parse facts cached by blob oid (PLAN.md §6.3): a return visit, or another clone of the same
// project, parses only blobs it has not seen. Implements FactsCache from the ingest contract.
//
// Keys are `<parserVersion>:<oid>`, so raising config.parser.version makes every old entry
// unreachable at once. The cache stores exactly what it is given; whether a cached fact fits a
// given path is the fast pass's decision (the same blob can sit at several paths).
import { config } from '../config';
import type { FactsCache } from '../contracts/ingest';
import type { FileFacts, SyntaxFacts } from '../contracts/lang';
import { lazyDb, transactionDone } from './idb';

export type FactsTable = 'facts' | 'syntax';
const TABLES: readonly FactsTable[] = ['facts', 'syntax'];

export interface FactsEntry { key: string; value: unknown; seen: number }

/** The storage under the cache: two keyed tables. Every call is one batch (one transaction). */
export interface FactsBackend {
  /** One result per key, in order; undefined for a key that is not stored. */
  getMany(table: FactsTable, keys: string[]): Promise<({ value: unknown; seen: number } | undefined)[]>;
  putMany(table: FactsTable, entries: FactsEntry[]): Promise<void>;
  /** Delete entries whose key does not start with `keepPrefix` or whose `seen` is before `seenBefore`. Resolves with the number deleted. */
  prune(table: FactsTable, keepPrefix: string, seenBefore: number): Promise<number>;
  clear(): Promise<void>;
  close?(): void;
}

export interface FactsCacheOptions {
  /** Default: config.parser.version. */
  parserVersion?: string;
  now?: () => number;
}

export interface PersistentFactsCache extends FactsCache {
  /** Drop entries of other parser versions and entries not used for `olderThanMs`. Resolves with the number dropped. */
  prune(olderThanMs: number): Promise<number>;
  clear(): Promise<void>;
  close(): void;
}

/** A read refreshes an entry's `seen` time only when it is older than this, so reads stay read-only. */
const REFRESH_SEEN_AFTER_MS = 24 * 60 * 60 * 1000;

export function createFactsCache(backend: FactsBackend, opts: FactsCacheOptions = {}): PersistentFactsCache {
  const prefix = `${opts.parserVersion ?? config.parser.version}:`;
  const now = opts.now ?? Date.now;

  async function get<T>(table: FactsTable, oids: string[]): Promise<Map<string, T>> {
    const wanted = [...new Set(oids)].filter((oid) => oid !== '');
    const out = new Map<string, T>();
    if (!wanted.length) return out;
    const found = await backend.getMany(table, wanted.map((oid) => prefix + oid));
    const time = now();
    const stale: FactsEntry[] = [];
    found.forEach((entry, i) => {
      if (!entry) return;
      out.set(wanted[i], entry.value as T);
      if (time - entry.seen > REFRESH_SEEN_AFTER_MS) stale.push({ key: prefix + wanted[i], value: entry.value, seen: time });
    });
    // Keep what is still in use from being pruned. Not awaited: the caller is waiting to parse.
    if (stale.length) backend.putMany(table, stale).catch(() => { /* best effort */ });
    return out;
  }

  async function put(table: FactsTable, items: { oid: string }[]): Promise<void> {
    const time = now();
    const entries: FactsEntry[] = [];
    for (const item of items) if (item.oid) entries.push({ key: prefix + item.oid, value: item, seen: time });
    if (entries.length) await backend.putMany(table, entries);
  }

  return {
    getFacts: (oids) => get<FileFacts>('facts', oids),
    putFacts: (facts) => put('facts', facts),
    getSyntax: (oids) => get<SyntaxFacts>('syntax', oids),
    putSyntax: (facts) => put('syntax', facts),
    async prune(olderThanMs) {
      const seenBefore = now() - olderThanMs;
      let dropped = 0;
      for (const table of TABLES) dropped += await backend.prune(table, prefix, seenBefore);
      return dropped;
    },
    clear: () => backend.clear(),
    close: () => backend.close?.(),
  };
}

/** Values are cloned on the way in and out, as a database would, so callers cannot alias cached facts. */
export function memoryFactsBackend(): FactsBackend {
  const tables: Record<FactsTable, Map<string, { value: unknown; seen: number }>> = { facts: new Map(), syntax: new Map() };
  return {
    async getMany(table, keys) {
      const t = tables[table];
      return keys.map((key) => {
        const entry = t.get(key);
        return entry && { value: structuredClone(entry.value), seen: entry.seen };
      });
    },
    async putMany(table, entries) {
      const t = tables[table];
      for (const e of entries) t.set(e.key, { value: structuredClone(e.value), seen: e.seen });
    },
    async prune(table, keepPrefix, seenBefore) {
      const t = tables[table];
      let dropped = 0;
      for (const [key, entry] of t) {
        if (!key.startsWith(keepPrefix) || entry.seen < seenBefore) { t.delete(key); dropped++; }
      }
      return dropped;
    },
    async clear() { for (const table of TABLES) tables[table].clear(); },
  };
}

export function memoryFactsCache(opts?: FactsCacheOptions): PersistentFactsCache {
  return createFactsCache(memoryFactsBackend(), opts);
}

/**
 * Two object stores, `facts` and `syntax`, with out-of-line string keys and values `{ seen, v }`;
 * an index on `seen` serves prune. A read of any size is one read-only transaction with the gets
 * queued back to back, and a write is one relaxed-durability transaction: losing the last few
 * entries in a crash only means parsing those files again.
 */
export function indexedDbFactsBackend(dbName = 'starmap-facts'): FactsBackend {
  const db = lazyDb(dbName, 1, (d) => {
    for (const table of TABLES) d.createObjectStore(table).createIndex('seen', 'seen');
  });
  type Stored = { seen: number; v: unknown };
  return {
    async getMany(table, keys) {
      const tx = (await db.open()).transaction(table, 'readonly');
      const store = tx.objectStore(table);
      const out = new Array<{ value: unknown; seen: number } | undefined>(keys.length);
      keys.forEach((key, i) => {
        const request = store.get(key) as IDBRequest<Stored | undefined>;
        request.onsuccess = () => { const s = request.result; if (s) out[i] = { value: s.v, seen: s.seen }; };
      });
      await transactionDone(tx);
      return out;
    },
    async putMany(table, entries) {
      const tx = (await db.open()).transaction(table, 'readwrite', { durability: 'relaxed' });
      const store = tx.objectStore(table);
      for (const e of entries) store.put({ seen: e.seen, v: e.value } satisfies Stored, e.key);
      await transactionDone(tx);
    },
    async prune(table, keepPrefix, seenBefore) {
      const tx = (await db.open()).transaction(table, 'readwrite', { durability: 'relaxed' });
      const store = tx.objectStore(table);
      let dropped = 0;
      // Other parser versions: everything sorting before or after the keys that start with the prefix.
      const outside = [IDBKeyRange.upperBound(keepPrefix, true), IDBKeyRange.lowerBound(keepPrefix + '￿', true)];
      for (const range of outside) {
        const count = store.count(range);
        count.onsuccess = () => { dropped += count.result; };
        store.delete(range);
      }
      // Then whatever is left that has not been used since the cutoff.
      const cursor = store.index('seen').openKeyCursor(IDBKeyRange.upperBound(seenBefore, true));
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        store.delete(at.primaryKey);
        dropped++;
        at.continue();
      };
      await transactionDone(tx);
      return dropped;
    },
    async clear() {
      const tx = (await db.open()).transaction(TABLES, 'readwrite');
      for (const table of TABLES) tx.objectStore(table).clear();
      await transactionDone(tx);
    },
    close: () => db.close(),
  };
}

/** The facts cache in IndexedDB. The database is opened on first use. */
export function indexedDbFactsCache(dbName?: string, opts?: FactsCacheOptions): PersistentFactsCache {
  return createFactsCache(indexedDbFactsBackend(dbName), opts);
}
