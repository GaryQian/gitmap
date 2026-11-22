# src/persist — snapshots, registry, facts cache

Local storage for starmap (PLAN.md §12, §6.3). Works on the main thread and in a worker. Every backend sits behind a small interface with an in-memory twin, which is what Node, tests and private windows get.

## API

```ts
const p = await openPersistence();          // never rejects
p.kind                                      // 'durable' (OPFS + IndexedDB) | 'memory' (nothing outlives the page)
p.snapshots                                 // SnapshotStore
p.registry                                  // RepoRegistry
p.facts                                     // FactsCache (the ingest contract) + prune / clear
```

| Part | Durable backend | What it does |
|---|---|---|
| `SnapshotStore` `save(model)` `load(id)` `remove(id)` `list()` | OPFS directory `snapshots/`, one `<escaped id>.starmap.json.gz` per repo | `load` returns `null` and deletes the file when it is damaged or cut short, has another `schema`, or has another `meta.parserVersion` than `config.parser.version`. It rejects only when the storage itself fails. |
| `createSnapshotWriter({ store, getModel, debounceMs, onError, onSaved })` | — | `schedule()` after every stage; calls within `debounceMs` share one save, saves never overlap, errors go to `onError`. `flush()` saves now and waits (it always saves; test `pending` first if that matters). |
| `RepoRegistry` `list()` `get(id)` `put(record)` `touch(id)` `remove(id)` | IndexedDB `starmap-registry` | `list()` is most recently opened first. `recordFromModel(model, locator?)` builds the record; only `fsa` (the directory handle) and `node` locators are kept. The first `put` asks for `navigator.storage.persist()`. |
| `queryPermission(handle)` `requestPermission(handle)` | — | `'granted' \| 'prompt' \| 'denied'` for a stored directory handle. `requestPermission` only works inside a click or key handler on the page. |
| `hasChanged(record, { headOid, indexChecksum })` | — | True when the repo on disk is no longer what the snapshot describes. |
| `FactsCache` `getFacts` `putFacts` `getSyntax` `putSyntax` `prune(olderThanMs)` `clear()` | IndexedDB `starmap-facts`, stores `facts` and `syntax` | Keyed `<parserVersion>:<oid>`. One transaction per call whatever the batch size. Entries with an empty oid are ignored. `prune` drops other parser versions and entries not used for the given time. |

Lower-level pieces, for tests and scripts: `memoryBlobStore()`, `opfsBlobStore(dir)`, `createSnapshotStore(blobs, opts)`, `memoryRegistry()`, `indexedDbRegistry(db?)`, `memoryFactsCache(opts)`, `indexedDbFactsCache(db?, opts)`, `createFactsCache(backend, opts)`, `snapshotFileName(id)`.

## First visit

1. `p = await openPersistence()`; pass `p.facts` to the pipeline as its `FactsCache`.
2. `writer = createSnapshotWriter({ store: p.snapshots, getModel, debounceMs })`, where `getModel` returns the current `RepoModel` including the layout.
3. At the reveal: `writer.schedule()` and `p.registry.put(recordFromModel(model, locator))`.
4. After each later stage (slow pass applied, a history layer completed, annotations arrived, an Update applied): `writer.schedule()`. When `headOid` or `indexChecksum` changed, `put` the record again, with the locator.
5. On `visibilitychange` to hidden: `if (writer.pending) void writer.flush()`.

## Return visit

1. **Registry.** `p.registry.list()` feeds the landing page's repo pills (`name`, `remoteUrl`, `stats`).
2. **Snapshot.** On a click: `model = await p.snapshots.load(record.id)`.
   - `null` means there is nothing usable (evicted, or made by another schema or parser version). Treat it as a first visit: if `record.locator` is there, ask for permission in this same click and parse; the facts cache makes that parse cheap unless the parser version changed.
3. **Render immediately.** Open `{ kind: 'snapshot', model }` without waiting for the folder. Call `p.registry.touch(record.id)`.
4. **Permission, in the background.** With `record.locator?.kind === 'fsa'`: `await queryPermission(record.locator.root)`.
   - `'granted'`: carry on to step 5.
   - `'prompt'`: show "Allow access to the folder" in the top bar; its click handler calls `requestPermission(record.locator.root)` first thing, then step 5.
   - `'denied'`, or no locator (Firefox, Safari, an imported file): the map stays as it is; the sidebar asks for the folder when a file is opened.
5. **Compare.** Open the repo from the locator, read `headOid` and `indexChecksum`, and call `hasChanged(record, current)`.
   - Unchanged: attach the locator as the content source; done.
   - Changed: diff the manifest's blob oids against `model.tables.file.cols.oid`, and offer **"N files changed · Update"** (package 3M). Nothing moves until it is clicked. A moved `headOid` also means the history walk has newer commits to add (`meta.history.reachedOid`).
6. **After an Update:** `writer.schedule()` and `p.registry.put(recordFromModel(newModel, record.locator))`.

## Notes

- Deleting a repo: `p.registry.remove(id)` and `p.snapshots.remove(id)`. Snapshots without a registry record can be found by comparing `p.snapshots.list()` with the registry.
- `navigator.storage.persist()` is not exposed in workers. If the registry lives in a worker, call `requestPersistentStorage()` once from the page.
- Run `p.facts.prune(...)` now and then (for example at start-up, in the background) so facts of deleted repos and old parser versions do not pile up.
- A snapshot whose `meta.parserVersion` differs from this build's is discarded on load. An imported file saved as a snapshot is subject to the same rule.
