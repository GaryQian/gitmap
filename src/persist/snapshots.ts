// Snapshots: one gzipped model per repo in a BlobStore (PLAN.md §12), and the debounced writer that
// keeps the stored copy current as later stages finish.
import { config } from '../config';
import { decodeModel, encodeModel, type RepoModel } from '../model';
import type { BlobStore } from './blobStore';

/**
 * The model schema this build reads and writes. Typed from RepoModel, so a schema bump in
 * src/model/types.ts fails the type check here until this is raised with it.
 */
export const SNAPSHOT_SCHEMA: RepoModel['schema'] = 1;

const SUFFIX = '.gitmap.json.gz';
/** Longest escaped id used as a file name; a longer id is stored under its SHA-256 instead. */
const MAX_ESCAPED = 120;
const HASHED_PREFIX = '~';

function escapeId(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    // a-z 0-9 . - pass through; everything else, upper case included, becomes _hh. The mapping is
    // one-to-one, so two ids never share a file, even on a case-insensitive file system.
    const plain = (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d;
    out += plain ? String.fromCharCode(byte) : '_' + byte.toString(16).padStart(2, '0');
  }
  return out;
}

function unescapeId(escaped: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] !== '_') { bytes.push(escaped.charCodeAt(i)); continue; }
    const byte = Number.parseInt(escaped.slice(i + 1, i + 3), 16);
    if (i + 3 > escaped.length || Number.isNaN(byte)) return null;
    bytes.push(byte);
    i += 2;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The blob name a repo's snapshot is stored under: filesystem-safe, and different for different ids. */
export async function snapshotFileName(id: string): Promise<string> {
  const escaped = escapeId(id);
  if (escaped.length <= MAX_ESCAPED) return escaped + SUFFIX;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return HASHED_PREFIX + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') + SUFFIX;
}

export type SnapshotRejection = 'unreadable' | 'parserVersion';

export interface SnapshotStoreOptions {
  /** Snapshots written by another parser version are discarded on load. Default: config.parser.version. */
  parserVersion?: string;
  /** Told when `load` discards a stored snapshot, and why. */
  onReject?(id: string, reason: SnapshotRejection): void;
}

export interface SnapshotStore {
  /** Write the model under its `meta.id`, replacing the previous snapshot. Resolves with the bytes written. */
  save(model: RepoModel): Promise<number>;
  /**
   * The stored model, or null when there is none. A snapshot this build cannot use (damaged or cut
   * short, another schema, another parser version) is deleted and reported as null, so the caller
   * simply parses the repo again. Rejects only when the storage itself fails.
   */
  load(id: string): Promise<RepoModel | null>;
  remove(id: string): Promise<void>;
  /** Ids of the stored snapshots. */
  list(): Promise<string[]>;
}

export function createSnapshotStore(blobs: BlobStore, opts: SnapshotStoreOptions = {}): SnapshotStore {
  const parserVersion = opts.parserVersion ?? config.parser.version;

  async function decode(bytes: Uint8Array): Promise<RepoModel | null> {
    try {
      const model = await decodeModel(bytes); // rejects damaged bytes and any other schema
      return model.schema === SNAPSHOT_SCHEMA && typeof model.meta?.id === 'string' ? model : null;
    } catch {
      return null;
    }
  }

  return {
    async save(model) {
      const bytes = await encodeModel(model);
      await blobs.put(await snapshotFileName(model.meta.id), bytes);
      return bytes.length;
    },
    async load(id) {
      const name = await snapshotFileName(id);
      const bytes = await blobs.get(name);
      if (!bytes) return null;
      const model = await decode(bytes);
      const reason: SnapshotRejection | null =
        !model || model.meta.id !== id ? 'unreadable' : model.meta.parserVersion !== parserVersion ? 'parserVersion' : null;
      if (reason) {
        await blobs.delete(name).catch(() => { /* it is rejected again on the next load */ });
        opts.onReject?.(id, reason);
        return null;
      }
      return model;
    },
    async remove(id) {
      await blobs.delete(await snapshotFileName(id));
    },
    async list() {
      const ids: string[] = [];
      for (const name of await blobs.list()) {
        if (!name.endsWith(SUFFIX)) continue;
        const stem = name.slice(0, -SUFFIX.length);
        if (!stem.startsWith(HASHED_PREFIX)) {
          const id = unescapeId(stem);
          if (id !== null) ids.push(id);
          continue;
        }
        // A very long id is stored under its hash; the id itself is only inside the file.
        const bytes = await blobs.get(name);
        const model = bytes && await decode(bytes);
        if (model) ids.push(model.meta.id);
      }
      return ids;
    },
  };
}

export interface SnapshotWriterOptions {
  store: Pick<SnapshotStore, 'save'>;
  /** The model to write, read at the moment a save starts. Return null to skip that save. */
  getModel(): RepoModel | null | Promise<RepoModel | null>;
  /** How long after the first `schedule()` of a burst the save runs. */
  debounceMs: number;
  /** A save failed (quota, storage error, getModel threw). Nothing is thrown at the caller. */
  onError?(err: unknown): void;
  onSaved?(info: { id: string; bytes: number; ms: number }): void;
}

export interface SnapshotWriter {
  /**
   * Ask for a save. Calls within `debounceMs` of the first one share a single save, which runs
   * when that window ends (the window is not pushed back by later calls, so a steady stream of
   * stages still gets written). A call made while a save is running leads to one more save after it.
   */
  schedule(): void;
  /**
   * Save now, without waiting for the window, and resolve once the stored snapshot is at least as
   * new as this call. Always performs a save, whether or not one was scheduled; check `pending`
   * first to write only when something changed. Never rejects.
   */
  flush(): Promise<void>;
  /** True while a save is scheduled or running. */
  readonly pending: boolean;
  /** Drop any scheduled save and ignore further calls. A save already running finishes. */
  dispose(): void;
}

/** Coalesces snapshot saves ("written at the reveal and after each later stage, debounced"). Saves never overlap. */
export function createSnapshotWriter(opts: SnapshotWriterOptions): SnapshotWriter {
  const { store, getModel, debounceMs } = opts;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let running: Promise<void> | null = null;
  let disposed = false;

  const report = (err: unknown) => { try { opts.onError?.(err); } catch { /* the callback's own problem */ } };
  const clearTimer = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const arm = () => { if (timer === null && !disposed) timer = setTimeout(() => { timer = null; void run(); }, debounceMs); };

  async function saveOnce(): Promise<void> {
    try {
      const started = Date.now();
      const model = await getModel();
      if (!model) return;
      const bytes = await store.save(model);
      try { opts.onSaved?.({ id: model.meta.id, bytes, ms: Date.now() - started }); } catch { /* as above */ }
    } catch (err) {
      report(err);
    }
  }

  /** Start a save unless one is running. The returned promise never rejects. */
  function run(): Promise<void> {
    if (running) return running;
    clearTimer();
    dirty = false;
    const mine = saveOnce().finally(() => {
      running = null;
      if (dirty) arm(); // schedule() was called while this save was in flight
    });
    running = mine;
    return mine;
  }

  return {
    schedule() {
      if (disposed) return;
      dirty = true;
      if (!running) arm();
    },
    async flush() {
      if (disposed) return;
      dirty = true;
      clearTimer();
      // A save in flight may have read the model before this call: wait for it, then write once more.
      while (running) await running;
      if (dirty && !disposed) await run();
      else while (running) await running; // a concurrent flush() started the save this call wanted
    },
    get pending() { return dirty || running !== null; },
    dispose() {
      disposed = true;
      dirty = false;
      clearTimer();
    },
  };
}
