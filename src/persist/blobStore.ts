// Named byte blobs: the storage under the snapshots (PLAN.md §12). Two implementations: the Origin
// Private File System, and a Map for tests, Node and browsers that deny OPFS.
// Works on the main thread and in a worker; nothing here touches `window` or `document`.

export interface BlobStore {
  /** The bytes stored under `name`, or null when there are none. */
  get(name: string): Promise<Uint8Array | null>;
  /** Store `bytes` under `name`, replacing what was there. A reader never sees a half-written blob. */
  put(name: string, bytes: Uint8Array): Promise<void>;
  /** Remove `name`. Removing a name that does not exist is not an error. */
  delete(name: string): Promise<void>;
  /** Every stored name, in no particular order. */
  list(): Promise<string[]>;
}

export function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async get(name) { return blobs.get(name)?.slice() ?? null; },
    async put(name, bytes) { blobs.set(name, bytes.slice()); },
    async delete(name) { blobs.delete(name); },
    async list() { return [...blobs.keys()]; },
  };
}

/** Our own temp files, and the swap files Chromium keeps beside a file while a writable stream is open. */
const TEMP_SUFFIXES = ['.tmp', '.crswap'];
const isTemp = (name: string) => TEMP_SUFFIXES.some((s) => name.endsWith(s));

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'NotFoundError';
}

/** `move` is shipped by every engine for OPFS files but is not in the TypeScript DOM library. */
type MovableFileHandle = FileSystemFileHandle & { move?(name: string): Promise<void> };

/** True when this context has an Origin Private File System it can also write to. */
export function opfsAvailable(): boolean {
  if (typeof globalThis.navigator?.storage?.getDirectory !== 'function') return false;
  if (typeof FileSystemFileHandle === 'undefined') return false;
  // Older Safari has no createWritable; in a worker it can still write through a sync access handle.
  return 'createWritable' in FileSystemFileHandle.prototype || 'createSyncAccessHandle' in FileSystemFileHandle.prototype;
}

function writeSync(access: FileSystemSyncAccessHandle, bytes: Uint8Array): void {
  try {
    access.truncate(0);
    access.write(bytes as Uint8Array<ArrayBuffer>, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

/**
 * Blobs as files of one directory of the Origin Private File System. The directory is opened on
 * first use; that is where a browser that denies OPFS (private browsing) rejects.
 *
 * Writes cannot leave a cut-short file behind:
 * - With `createWritable` (Chromium, Firefox, Safari 26+) the stream writes to a swap file that
 *   replaces the target only on close; a crash before that leaves the previous contents.
 * - Without it (older Safari, workers only) the bytes go to `<name>.tmp` through a sync access
 *   handle and the temp file is renamed over the target. Where even the rename is refused the
 *   target is overwritten in place; a crash then leaves a short file, which a snapshot reader
 *   detects (gzip carries a length and a checksum) and discards.
 *
 * Names ending in `.tmp` or `.crswap` are reserved and never listed.
 */
export function opfsBlobStore(dirName: string): BlobStore {
  let opening: Promise<FileSystemDirectoryHandle> | null = null;
  const dir = (): Promise<FileSystemDirectoryHandle> => {
    if (!opening) {
      opening = (async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(dirName, { create: true });
      })();
      opening.catch(() => { opening = null; }); // let a later call try again
    }
    return opening;
  };

  async function putThroughSyncHandle(d: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
    const tempName = name + TEMP_SUFFIXES[0];
    const temp: MovableFileHandle = await d.getFileHandle(tempName, { create: true });
    writeSync(await temp.createSyncAccessHandle(), bytes);
    if (typeof temp.move === 'function') {
      try { await temp.move(name); return; } catch { /* rename refused: overwrite in place below */ }
    }
    const target = await d.getFileHandle(name, { create: true });
    writeSync(await target.createSyncAccessHandle(), bytes);
    await d.removeEntry(tempName).catch(() => { /* a stale temp file is overwritten by the next put */ });
  }

  return {
    async get(name) {
      try {
        const handle = await (await dir()).getFileHandle(name);
        return new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async put(name, bytes) {
      if (isTemp(name)) throw new Error(`blob name '${name}' ends with a reserved suffix`);
      const d = await dir();
      const handle = await d.getFileHandle(name, { create: true });
      if (typeof handle.createWritable !== 'function') return putThroughSyncHandle(d, name, bytes);
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
      } catch (err) {
        await writable.abort().catch(() => { /* already closed or errored */ });
        throw err;
      }
    },
    async delete(name) {
      try {
        await (await dir()).removeEntry(name);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    async list() {
      const names: string[] = [];
      for await (const name of (await dir()).keys()) if (!isTemp(name)) names.push(name);
      return names;
    },
  };
}
