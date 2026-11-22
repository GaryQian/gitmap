// Public surface of src/persist (package 3L, PLAN.md §12): snapshots in the Origin Private File
// System, the repo registry and the facts cache in IndexedDB, each behind a small interface with an
// in-memory twin. Everything works on the main thread and in a worker. See README.md.
import { memoryBlobStore, opfsAvailable, opfsBlobStore } from './blobStore';
import { indexedDbFactsCache, memoryFactsCache, type PersistentFactsCache } from './factsCache';
import { indexedDbAvailable } from './idb';
import { indexedDbRegistry, memoryRegistry, type RepoRegistry } from './registry';
import { createSnapshotStore, type SnapshotRejection, type SnapshotStore } from './snapshots';

export { memoryBlobStore, opfsBlobStore, opfsAvailable, type BlobStore } from './blobStore';
export {
  createSnapshotStore, createSnapshotWriter, snapshotFileName, SNAPSHOT_SCHEMA,
  type SnapshotStore, type SnapshotStoreOptions, type SnapshotRejection, type SnapshotWriter, type SnapshotWriterOptions,
} from './snapshots';
export {
  indexedDbRegistry, memoryRegistry, recordFromModel, hasChanged, storableLocator, requestPersistentStorage,
  type RepoRegistry, type RepoRecord, type StoredLocator, type IndexedDbRegistry,
} from './registry';
export { queryPermission, requestPermission, type FolderPermission } from './permission';
export {
  indexedDbFactsCache, memoryFactsCache, createFactsCache, memoryFactsBackend, indexedDbFactsBackend,
  type PersistentFactsCache, type FactsCacheOptions, type FactsBackend, type FactsEntry, type FactsTable,
} from './factsCache';
export { indexedDbAvailable } from './idb';

export interface PersistenceOptions {
  /** Use the in-memory backends even where durable storage exists (tests, a "do not remember" mode). */
  memory?: boolean;
  /** OPFS directory holding the snapshots. Default 'snapshots'. */
  snapshotDir?: string;
  /** IndexedDB database names. Defaults 'gitmap-registry' and 'gitmap-facts'. */
  registryDb?: string;
  factsDb?: string;
  /** Default: config.parser.version. */
  parserVersion?: string;
  /** Told when a stored snapshot is discarded on load. */
  onSnapshotRejected?(id: string, reason: SnapshotRejection): void;
}

export interface Persistence {
  /** 'durable': OPFS and IndexedDB. 'memory': nothing outlives this page (Node, private browsing). */
  kind: 'durable' | 'memory';
  snapshots: SnapshotStore;
  registry: RepoRegistry;
  facts: PersistentFactsCache;
  /** Release the database connections. They reopen if the object is used again. */
  close(): void;
}

/**
 * The one entry point for the coordinator. Gives the real backends when both the Origin Private
 * File System and IndexedDB are present and actually open, and the in-memory ones otherwise; it
 * does not mix the two, so `kind` describes all three parts. Never rejects.
 */
export async function openPersistence(opts: PersistenceOptions = {}): Promise<Persistence> {
  const snapshotOptions = { parserVersion: opts.parserVersion, onReject: opts.onSnapshotRejected };
  const factsOptions = { parserVersion: opts.parserVersion };

  if (!opts.memory && opfsAvailable() && indexedDbAvailable()) {
    const blobs = opfsBlobStore(opts.snapshotDir ?? 'snapshots');
    const registry = indexedDbRegistry(opts.registryDb);
    const facts = indexedDbFactsCache(opts.factsDb, factsOptions);
    try {
      // Having the APIs is not having the storage: private windows reject here.
      await Promise.all([blobs.list(), registry.get(''), facts.getFacts(['0'])]);
      return {
        kind: 'durable',
        snapshots: createSnapshotStore(blobs, snapshotOptions),
        registry,
        facts,
        close() { registry.close(); facts.close(); },
      };
    } catch {
      registry.close();
      facts.close();
    }
  }

  return {
    kind: 'memory',
    snapshots: createSnapshotStore(memoryBlobStore(), snapshotOptions),
    registry: memoryRegistry(),
    facts: memoryFactsCache(factsOptions),
    close() { /* nothing held */ },
  };
}
