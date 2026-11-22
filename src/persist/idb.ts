// The few IndexedDB helpers the registry and the facts cache share. IndexedDB is reached through
// `globalThis.indexedDB`, which exists on the main thread and in workers alike.

export function indexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

export function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction has committed; rejects when it aborts (quota, a failed request). */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export interface LazyDb {
  /** The open connection; opened on first use and reopened if the browser closed it. */
  open(): Promise<IDBDatabase>;
  close(): void;
}

/**
 * A database opened on demand. `upgrade` creates the object stores; it runs inside the version
 * change transaction with the version the database had before (0 for a new one).
 */
export function lazyDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void): LazyDb {
  let opening: Promise<IDBDatabase> | null = null;
  const forget = () => { opening = null; };
  return {
    open() {
      if (opening) return opening;
      const mine = new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalThis.indexedDB.open(name, version);
        request.onupgradeneeded = (event) => upgrade(request.result, event.oldVersion);
        request.onblocked = () => reject(new Error(`IndexedDB '${name}' is held open at an older version by another tab`));
        request.onerror = () => reject(request.error ?? new Error(`IndexedDB '${name}' could not be opened`));
        request.onsuccess = () => {
          const db = request.result;
          // Another tab wants to upgrade or delete the database: let go, and reopen on the next use.
          db.onversionchange = () => { db.close(); if (opening === mine) forget(); };
          db.onclose = () => { if (opening === mine) forget(); };
          resolve(db);
        };
      });
      opening = mine;
      mine.catch(() => { if (opening === mine) forget(); });
      return mine;
    },
    close() {
      const mine = opening;
      forget();
      mine?.then((db) => db.close(), () => { /* never opened */ });
    },
  };
}
