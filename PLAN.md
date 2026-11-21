# gitmap — architecture plan

A browser-based 3D "map of cities" for a codebase. Files are spheres resting on a plane, Louvain communities are cities and districts, d3-force lays them out, and overlays and AI annotations sit on top. Everything heavy runs in the browser, off the main thread.

This plan concentrates on how to keep the app responsive while it parses, clusters, simulates and renders.

**Design sizes.** **S** = 1k files and **M** = 10k files are what the design must be excellent at. **L** = 100k files must work; slight degradation there is acceptable.

Section 16 lists every decision taken in review (2026-11-21).

---

## 1. The shape of the system

1. **The main thread only renders and handles input.** Parsing, link resolution, clustering, git history and physics each run in workers.
2. **The file list comes from `.git/index`, not from crawling.** One file gives every tracked path, its blob hash and its byte size. Ignored directories are never opened, total work is known up front, and the blob hash is a free cache key.
3. **Nothing is shown until the structure is stable.** The parse runs to a defined stable point (§6.8) behind a plain progress screen. The map is then revealed already settled, and it never reorganises unless the user asks.
4. **One data model, changed only by patches.** Parser, analysis and AI write patches; physics, renderer and UI subscribe. Later additions (AI beams, overlay layers, user-requested updates) appear without redrawing the scene.
5. **Positions are hierarchical and composed on the GPU.** A sphere's position is `city + district + local`, looked up from small data textures in the vertex shader. Dragging a city updates one texel, and every sphere, edge, beam and label parented to it follows.
6. **Physics is tiered and sleeps.** City, district and file simulations are separate small d3-force instances driven by our own scheduler. Only "hot" simulations tick.

---

## 2. Spec conflicts and how they were resolved

| Spec says | Conflict | Resolution |
|---|---|---|
| "Input should be a local directory" / "landing page asks for a git repo" | Two inputs | A local directory containing `.git`. A plain folder is also accepted, with a notice that history overlays are unavailable. |
| Selected objects "listed top left" and "as pills in the upper right" | Two places; overlay buttons are also top right | Selection pills top left, under the top bar. Overlay buttons top right. |
| "Hovering opens details" / "clicking brings up more details" | Overlap | Hover = tooltip + that file's connections. Click = select + detail card. Double-click = open in sidebar reader. |
| "Connecting lines between all files" | Unreadable and slow when all drawn | All edges are stored. Zoomed out, they aggregate into city and district ribbons; file-level lines appear for districts in view. Hovered and selected spheres always draw every connection (§8.3). |
| "File ownership by blame" | Line-level blame over full history is too slow in a browser | Ownership = share of commits touching the file per author. True blame on demand for one file. |
| "2-tiered physics" but files also need d3-force | Three levels exist | Three tiers, one rule: a node only interacts with siblings under the same parent. |
| "Vertical dimension represents size and importance" | Elevation vs sphere size | Every sphere rests on the plane. Height is the sphere's own size, which blends file size and importance 70/30 (§8.1). |
| "View begins empty, shows as it parses" / Louvain needs the whole graph | Clusters would reshuffle as edges arrive | Nothing is drawn during the parse. The map is revealed at a stable point (§6.8). |
| "All configurable values in one config.json" / API key | Keys must not ship to the browser | `config.json` holds provider and model names. The key lives in `.env.local` / Vercel env vars. |

---

## 3. Runtime topology

```
 MAIN THREAD                      WORKERS
 ┌───────────────────────┐        ┌──────────────────────────────────────────┐
 │ React UI (DOM)        │        │ Coordinator                              │
 │ Renderer (three.js)   │◄─patch─┤  owns canonical ModelStore               │
 │ Input / camera        │        │  schedules work, decides the reveal      │
 │ View replica (typed   │        ├──────────────────────────────────────────┤
 │  arrays for drawing)  │        │ Parse pool ×N   (scanners, tree-sitter)  │
 └──────────┬────────────┘        │ Analysis        (resolve, Louvain, layers)│
            │ reads               │ Git history     (pack walker)             │
            ▼                     │ Physics         (d3-force tiers)          │
   SharedArrayBuffer  ◄───writes──┤                                          │
   positions                      └──────────────────────────────────────────┘
            ▲
            │ fetch (SSE)
   Vercel Functions /api/ai/*  ──►  model provider
```

- **Coordinator worker** holds the canonical model. The main thread holds a *view replica*: only the columns needed to draw and to answer UI queries.
- **Parse pool**: `N = clamp(hardwareConcurrency − 2, 1, config.parser.maxWorkers)`, reduced when `navigator.deviceMemory` is low.
- **Physics worker** receives topology patches straight from the coordinator over a `MessageChannel` and writes positions into a `SharedArrayBuffer`.
- **Patch flow control**: producers coalesce to at most ~10 patch batches per second. The main thread applies whole batches inside a per-frame budget (default 4 ms) and queues the rest; a batch too large for one frame is staged and committed at once (§5.1).
- `SharedArrayBuffer` needs cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in `vercel.json`, with every asset served same-origin. Fallback when not isolated: the physics worker posts dirty position chunks as transferables at 30 Hz.

---

## 4. Modules and their boundaries

Single package, strict folder boundaries enforced by a lint rule. Each module exports one `index.ts`; nothing imports another module's internals.

| Module | Responsibility | Reads | Writes | Runs in |
|---|---|---|---|---|
| `model/` | Schema, IDs, `ModelStore`, patch types, (de)serialization | — | — | everywhere |
| `ingest/` | Directory access, manifest, parse pool, scanners | disk | patches: files, raw facts, progress | coordinator + pool |
| `analysis/` | Import/symbol resolution, header pairing, Louvain, importance, overlay layers | model | patches: edges, units, clusters, layers | analysis worker |
| `history/` | Git pack walking, per-file commit facts | `.git` | patches: contributors, history layers | git worker |
| `physics/` | Tiered d3-force layout | cluster/unit/edge patches, commands | position buffers | physics worker |
| `render/` | three.js scene, picking, camera, effects | view replica, position buffers, view state | interaction events | main |
| `ai/` | Digest builder (client), provider adapters + routes (server) | model | patches: annotations | main + Vercel |
| `persist/` | Snapshot save/load (OPFS), repo registry (IndexedDB), export/import, demo | model | model | coordinator |
| `app/` | React shell: landing, waiting screen, top bar, panels, legend, sidebar, tour UI | view replica, view state | commands | main |
| `config/` | Typed loader for `config.json` | — | — | everywhere |

**Stack:** Vite + React + TypeScript, deployed as a static single-page app with Vercel Functions under `/api`. Raw three.js (not react-three-fiber): React must not reconcile thousands of scene objects.

**TypeScript first.** The git index reader, the per-language import scanners and the git pack walker start in TypeScript, each behind an interface that a WASM implementation can replace. The M0 measurements decide whether any of them moves to Rust. tree-sitter is WASM regardless. This avoids a Rust toolchain in the build unless the numbers demand it.

```
gitmap/
  config.json            .env.example            vercel.json
  api/ai/                # Vercel functions
  src/{model,ingest,analysis,history,physics,render,ai,persist,app,config}/
  public/demo/           # pre-parsed snapshots
  public/grammars/       # tree-sitter .wasm, one per language, lazily fetched
  fixtures/              # tiny per-language repos with expected edges
```

Key interfaces (sketch):

```ts
// model — the only way anything changes
type ModelPatch =
  | { op: 'add' | 'update' | 'remove'; kind: EntityKind; rows: ColumnChunk }
  | { op: 'assign'; units: Uint32Array; district: Uint32Array }
  | { op: 'layer'; id: LayerId; values: Float32Array; offset: number }
  | { op: 'annotation'; value: Poi | Tour | Summary }
  | { op: 'progress'; subsystem: Subsystem; done: number; total: number };
interface PatchBatch { rev: number; baseRev: number; ops: ModelPatch[] }            // see §5.1
interface ModelStore {
  propose(ops: ModelPatch[]): Promise<Rev>;          // validates, assigns slots and a revision
  subscribe(fn: (batch: PatchBatch) => void): Unsub;
  snapshotAt(): { rev: Rev; columns: ViewColumns };  // for resync
}

// physics — commands in, shared buffers out
interface PhysicsApi {
  applyBatch(batch: PatchBatch): void;
  settle(maxMs: number): Promise<void>;              // run every sim to rest, off-screen
  drag(ref: NodeRef, x: number, z: number): void;   release(ref: NodeRef): void;
  setFocus(cameraTarget: Vec2, radius: number): void;
  buffers(): { unit: SharedArrayBuffer; district: SharedArrayBuffer; city: SharedArrayBuffer; gen: SharedArrayBuffer };
}

// render — imperative, no React inside
interface RenderApi {
  applyBatch(batch: PatchBatch): void;                // resyncs itself on a revision gap
  reveal(): Promise<void>;                           // grow the settled map in place
  setOverlay(layer: LayerId | null, params?: unknown): void;
  setSelection(refs: NodeRef[]): void;
  setTypeFilter(langs: LangId[]): void;   setMinLines(n: number): void;
  flyTo(ref: NodeRef, opts?: FlyOpts): Promise<void>;
  on(evt: 'hover' | 'click' | 'dblclick' | 'marquee' | 'dragpill', fn: Handler): Unsub;
}
```

---

## 5. Data model

One document, three provenance classes, each section independently versioned:

- **Ground truth** (parser, history): `files`, `rawEdges`, `contributors`, per-file history facts.
- **Derived** (analysis, physics): `units`, `edges` (unit-level), `cities`, `districts`, `layers`, `layout` cache.
- **Generated** (AI, async): `pois`, `tours`, `summaries`.

```ts
interface RepoModel {
  schema: 1;
  meta: { id: string; name: string; headOid: string; indexChecksum: string;
          parserVersion: string; parsedAt: number; structure: 'full' | 'imports-only'; stats: Stats };
  strings: string[];                       // shared string table (paths, symbols, names)
  files:   Columns<{ path; lang; bytes; loc; oid; unit }>;
  units:   Columns<{ primaryFile; fileCount; loc; importancePct; district }>;   // 1 unit = 1 sphere
  edges:   Columns<{ src; dst; kind; weight; confidence }>;                     // unit → unit, directed
  edgeSymbols: Columns<{ edge; symbol; count }>;                                // top symbols per edge
  cities:    { id: string; name: string; districts: string[] }[];
  districts: { id: string; city: string; name: string }[];
  contributors: { id: number; name: string; emails: string[]; commits: number }[];
  layers: Record<LayerId, Layer>;
  annotations: { pois: Poi[]; tours: Tour[]; summaries: Summary[] };
  layout?: { unit: number[]; district: number[]; city: number[] };              // cached positions
}
type NodeRef = `f:${string}` | `u:${string}` | `d:${string}` | `c:${string}`;
```

Rules:

- **Unit** is the drawable sphere: one file, or a C/C++/Obj-C header+implementation pair. Its line count is the sum. The sidebar shows both files as tabs.
- **Persistent IDs** (path-derived for files and units, minted for cities and districts) are what annotations and saved state reference. Dense integer indices are per-session and exist only for typed arrays.
- **One model entity ↔ one drawn entity.** Unit ↔ sphere, edge ↔ line instance, district ↔ pill + ground territory, city ↔ pill + ground territory, POI ↔ beam, tour ↔ tour UI. Every generated entity carries `parent: NodeRef`.
- **Edge kinds:** `import`, `call`, `reference`, `inherit`, `bridge` (cross-language, with a `mechanism` such as `jni` or `protobuf`, §6.4.1), `cochange` (from history, never drawn as a dependency line).
- **Layers** hold overlay data: `{ kind: 'scalar' | 'categorical' | 'sparse' | 'parametric', values, domain, colormap, status }`. Switching overlays never recomputes anything.
- **File contents are not in the model.** The sidebar reads from disk on demand.
- **Wire and disk format:** columnar JSON (arrays of numbers plus a string table), gzipped with `CompressionStream`. One JSON file, as specified.

### 5.1 Patch protocol: keeping the renderer and the model in agreement

A patch batch is a numbered list of operations, and it is the only way the model changes. The renderer and the physics worker never read the model directly; they apply the same batches in the same order.

```ts
interface PatchBatch {
  rev: number;          // revision this batch produces
  baseRev: number;      // revision it must be applied on top of (always rev − 1)
  ops: ModelPatch[];    // applied together or not at all
}
```

**Rules**

1. **One writer.** Parser, analysis, history and AI only *propose* operations. The coordinator's `ModelStore` validates them (IDs unique, parents and endpoints resolve, values match the schema), applies them and assigns the next revision. A proposal that fails validation is rejected back to its producer and never forwarded.
2. **Gaps are detected.** A subscriber applies a batch only if `baseRev` equals the revision it is on. Any mismatch triggers a **resync**: it discards its copy and reloads the drawable columns from the store at the current revision.
3. **The store assigns slots.** Every entity has a permanent ID and a dense slot number used in GPU buffers and physics buffers. The store allocates slots and sends them in the `add` operation, so store, physics and renderer always mean the same entity by a given slot. A removed entity leaves an empty slot that later additions may reuse; slots are never renumbered during a session. Compaction happens only when a snapshot is written.
4. **The renderer is a projection.** Each operation kind has exactly one handler, and those handlers are the only code that writes instance buffers, lookup textures and DOM pools. The renderer holds no model state of its own. Camera, hover, selection and jiggle offsets live in a separate view state that refers to entities by permanent ID.
5. **Batches are transactions.** A user-triggered update (for example "Refined structure ready · Apply") changes memberships, sizes and edges in one batch. The renderer applies a whole batch between two frames or stages it across frames and commits it at once; it never draws a half-applied batch.
6. **Loading is the same path.** Opening a saved map, an imported file or a demo is one large `add` batch through the same handlers. There is no second code path that builds the scene.

**Operation → handler**

| Operation | Renderer | Physics |
|---|---|---|
| `add` / `update` / `remove` unit | write or clear one sphere instance | add or remove a node in that district's sim (batched, §7.2) |
| `add` / `update` / `remove` edge | write or clear one arc instance; update adjacency index | update that tier's links |
| `add` / `update` / `remove` city, district | pill pool, territory ids | add or remove a node or a sim |
| `assign` | district index attribute per sphere | move nodes between sims |
| `layer` | upload one attribute range | — |
| `annotation` | beam, pill, tour UI | — |
| `progress` | top bar only | — |

**Positions are not patches.** The physics worker writes positions to shared memory, indexed by the same slots. It consumes the same batch stream and stamps its buffer header with the revision it has applied. The renderer ignores position rows for slots it has not created yet, and holds a newly added sphere hidden until physics reports a revision at or beyond the one that added it.

**How accuracy is checked**

The invariant: applying batches one at a time must produce exactly the buffers that a rebuild from the full model at the same revision produces.

- **Property test:** generate random valid batch sequences, apply them incrementally, rebuild from scratch, and compare every column and texture.
- **Development builds:** run the same comparison on the live scene on a timer and after every user-triggered update, plus counts (live sphere instances = units in the model; every beam's parent exists; every edge's endpoints are live).
- **Production:** a handler that throws, or a revision gap, triggers a resync instead of continuing with a suspect scene. Resyncs are counted and logged; a non-zero count is a bug to investigate.

---

## 6. Ingest and analysis pipeline

### 6.1 Acquire

- **Chromium-first.** `showDirectoryPicker()`; the directory handle is stored in IndexedDB so a return visit needs one permission click.
- Firefox/Safari: drag-and-drop a folder or `<input webkitdirectory>`. Parsing and demo mode work; the folder cannot be remembered and must be re-supplied to read file contents.
- **Desktop only.** Mouse and keyboard; no touch or phone layout.

### 6.2 Manifest

1. Parse `.git/index` → tracked paths, blob OIDs, byte sizes. Handle index v2–v4, split index and sparse index; on anything unsupported, or when there is no `.git`, fall back to a directory walk with a gitignore matcher.
2. Drop paths matching `config.parser.exclude` (vendored dirs, lockfiles, minified/generated files, binaries by extension, files over a size cap).
3. **Untracked files are off the map by default.** `parser.includeUntracked: true` adds untracked-but-not-ignored files by walking directories.

The manifest gives the waiting screen its totals and lets physics and render preallocate buffers.

### 6.3 Parse pool

- Each worker gets the **root directory handle** (structured-cloneable) and a batch of paths, resolves file handles itself with a per-directory handle cache, and reads with `getFile().arrayBuffer()`. No file bytes cross a thread boundary.
- Batches are sized by bytes (~2 MB) and pulled from a shared queue. Paths are ordered by directory to keep handle caches warm.
- **Languages are plug-ins.** Each one declares its file extensions, an import scanner, an optional tree-sitter grammar and query, bridge extractors (§6.4.1) and a resolver. A repo pays only for the languages it contains.
- **Fast pass:** per-language scanners that skip comments and strings and extract import/include/using specifiers and line counts. In the same sweep over the bytes, a multi-pattern match looks for bridge trigger words; only files that hit one run a bridge extractor.
- **Slow pass:** tree-sitter with `tags`-style queries for definitions and call-site references. Grammars are separate `.wasm` files, fetched only for languages present. Stylesheets and HTML have no slow pass.
- **Read each file once.** Spike 1 found that opening files, not scanning them, dominates the fast pass (react, one thread: 4.6 s reading vs 0.8 s scanning; measured in Node, the browser read path is not yet measured). The fast pass therefore keeps file bytes in worker memory up to `parser.retainBytes`, and the slow pass reuses them instead of reopening. Only files beyond that budget are read twice.
- **Per-file time cap** (`reveal.perFileTimeoutMs`, default 2 s). A file that exceeds it is skipped: it still gets a sphere, sized from its byte count, with no edges.
- Per-file results are cached by blob OID in OPFS, so an update only re-parses files whose OID changed.

### 6.4 Resolve and link (analysis worker)

| Language | Import resolution | Symbol/call linking |
|---|---|---|
| TS / JS | relative paths, extension and `index` probing, `tsconfig` `paths`/`baseUrl`, workspace package names | named imports → exporting file; references through import bindings |
| Python | dotted module → path, relative imports, `src/` layouts, `__init__` | `from x import y` bindings; attribute calls on imported modules |
| C / C++ / Obj-C | `#include` by suffix match against an index of all headers, nearest-directory tie-break | references to symbols declared in included headers; header↔impl pairing |
| Java / Kotlin / Scala | `package` declaration index → file; wildcard imports → package. One shared namespace, so a Kotlin file importing a Java or Scala class resolves directly. | type references within package and imports |
| C# | `using` namespace → files declaring that namespace (fuzzy) | narrowed by referenced type names |
| Go | `go.mod` module path + package directory | `pkg.Symbol` selectors; same-package references |
| Rust | `mod` tree from crate roots (`Cargo.toml`), `use` paths | path-qualified calls, `use` bindings |
| Dart | `package:` via `pubspec.yaml`, relative URIs | imported identifiers |
| Swift | module-level imports only | same-module symbol table (name match), lower confidence |
| PHP | `use` namespaces → files through the PSR-4 map in `composer.json`; `require`/`include` with literal paths | class references through `use` bindings |
| Ruby | `require_relative`; `require` against `lib/` load paths; autoloaded constants by naming convention (`UserMailer` → `user_mailer.rb`) | constant references; convention-based links carry lower confidence |
| Vue / Svelte / Astro | the script block (Astro: the frontmatter) goes through the TS/JS scanner and resolver; style blocks through the stylesheet scanner | as TS/JS, on the extracted script block |
| CSS / SCSS | `@import`, `@use`, `@forward`, `url()`; SCSS partials (`_name.scss`) | none (fast pass only) |
| HTML | `<script src>`, `<link href>` | none (fast pass only) |

Languages that share a namespace need no bridge: Java, Kotlin and Scala; C, C++ and Obj-C (shared headers); TS and JS. Any other file type still gets a sphere, a colour and a line count, and joins its folder's community through directory affinity (§6.6).

- **Accuracy bar: good enough to show architecture, not compiler-exact.** A reference from file A to name S resolves to definition file B if B is reachable through A's imports (or shares A's package/module). A globally unique name links with reduced confidence. Anything else is dropped.
- Every edge stores `confidence`. Low-confidence edges are drawn fainter and count less in clustering and importance.
- Edge weight = `1` per import + `log(1 + referenceCount)`. The top referenced symbols per edge are kept, so prominently called methods get thicker lines and can be named in tooltips.
- **Header pairing:** same basename, extension in `{h,hh,hpp,hxx} × {c,cc,cpp,cxx,m,mm}`, same directory or mirrored `include/`↔`src/`; prefer the implementation that includes the header.

#### 6.4.1 Cross-language boundaries (high-confidence only)

Every bridge between languages is two sides agreeing on a name. Each side emits keys in a shared namespace, "provides `jni:com.foo.Bar#load`" or "consumes" the same, and the linker joins them with a hash map into an edge of kind `bridge` that records its mechanism. Direction is consumer → provider.

Only mechanisms where the name is fixed by a specification or a generator are included:

| Mechanism | Consumer side | Provider side | Trigger words |
|---|---|---|---|
| **JNI** | Java `native` method, Kotlin `external fun`, in class `com.foo.Bar` | C/C++ function named `Java_com_foo_Bar_method`; or a `RegisterNatives` table (`JNINativeMethod` entries with the method name string, class taken from the accompanying `FindClass`) | `native`, `external`, `JNIEXPORT`, `Java_`, `RegisterNatives` |
| **JNI, native → JVM** | C/C++ `FindClass("com/foo/Bar")`, refined by `GetMethodID` / `GetStaticMethodID` name strings | the Java, Kotlin or Scala class | `FindClass`, `GetMethodID` |
| **Protobuf stubs** | code importing a generated stub (`foo_pb2`, `foo.pb.go`, `foo_pb.ts`, `FooOuterClass`, `foo.pb.h`) | the `.proto` file with the matching name and path, which becomes a hub linking client and server | stub-name suffixes in import specifiers |

- **JNI name mangling** is implemented exactly: `.` → `_`, a literal `_` → `_1`, `$` (nested and companion classes) → `_00024`, and overloads append `__` plus the mangled argument signature.
- **Protobuf** is matched by file name and path only. `.proto` files are not parsed, and no other schema language is covered.
- **Ambiguity rule:** a key with more than one provider produces no edge.
- Bridge edges count toward clustering and importance like any other edge, and the tooltip names the mechanism.
- **Known misses:** names built at runtime, reflection, and generated code that is gitignored.

Not included, because the match is by convention or free-form string and therefore weaker: C-symbol FFI (Rust `extern`, cgo, `ctypes`, `DllImport`, Dart FFI), extension modules (pybind11, CPython, N-API), named channels (Flutter, Electron, Tauri), HTTP routes, and path strings in config files. The key/join mechanism accepts them later without structural change.

### 6.5 Git history (git worker, never blocks the reveal)

- Pack walker reading `.idx` and `.pack` through `FileReaderSync` on `File.slice()` (synchronous random access in a worker without loading whole packs). Uses the commit-graph file when present.
- Walks commits newest-first from `HEAD`, diffing each commit's tree against its first parent. Tree diffs only descend into subtrees whose OID differs, so no blobs are read.
- Emits per-file: last-modified time, first-seen time, commit count, per-author commit counts; plus co-change pairs for small commits.
- Streams progressively; bounded by `config.history.maxCommits`; applies `.mailmap`.
- Unsupported cases degrade to "no history layers" with a notice: plain folders, shallow clones (partial), worktrees whose `.git` points outside the picked folder.

### 6.6 Community detection

**Library:** `graphology-communities-louvain` in the analysis worker. **Behavioural reference:** `taynaud/python-louvain`.

| Need | Library | Reference equivalent |
|---|---|---|
| Cities and districts from one run, districts nested in cities | `louvain.detailed()` returns `dendrogram` (an array of partitions, one per level) | `generate_dendrogram`, `partition_at_level` |
| City↔city and district↔district link weights for physics | Computed by us: sum edge weights per community pair, intra-community weight kept as a self-loop | `induced_graph` |
| Steering the number of cities | `resolution` (default 1; higher gives more communities) | `resolution` |
| Same repo → same map | `rng` set to a seeded generator from `config.clustering.seed`, nodes inserted in path order | `random_state` |
| Edge weights | `getEdgeWeight` | `weight` |
| Warm start | Not offered. Not needed: clustering runs once before the reveal and afterwards only when the user asks. | `partition=` |

The library's README reports about 1 second for 50k nodes and 1M edges, well inside the budget at S and M. It does not document the per-level format of `dendrogram`; pinning that with a test is the first task of the clustering work. If the library blocks us, a TypeScript port of the reference is the fallback, behind the same interface.

Graph preparation, informed by how the reference behaves:

- **Symmetrise.** The reference rejects directed graphs. Clustering uses `w(u,v) = w(u→v) + w(v→u)`; direction is kept in the model for pulses, importance and reach.
- **Orphans.** Isolated nodes stay singletons, and a graph with no edges returns all singletons. Config, docs and data files often have no code edges, so weak "same directory" affinity edges (`clustering.directoryAffinity`, default 0.1) are added to the clustering graph only.
- **Hub suppression.** For clustering only, an edge into a node is down-weighted by the log of that node's in-degree, so one logging utility does not glue the repo into a single city.
- **Tests.** Fixture graphs are run through python-louvain offline; our partitions must reach modularity within a tolerance of the reference's (not identical partitions, since the random sequences differ). One test pins the direction of `resolution`.

**City count.** `K = round(citiesPerDecade · log10(files) + cityOffset)`, defaults `3.5` and `−2.2`, both in config:

| Files | 50 | 200 | 1,000 | 5,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Cities | 4 | 6 | 8 | 11 | 12 | 15 |

Procedure: take the coarsest dendrogram level with at least K communities and merge the smallest into their most-connected neighbour until K remain. If the coarsest level has too few, raise `resolution` and re-run (a few runs at most).

**Districts.** The same curve applied to each city's own file count, minimum 5 files per district: about 5 districts in a 125-file city, about 8 in an 830-file city. Taken from the next finer dendrogram level restricted to the city; if that level is degenerate, Louvain is re-run on the city's subgraph.

**Names.** Most distinctive shared path segment (TF-IDF over path tokens). An AI summary may later override the label through an annotation.

### 6.7 Importance

- PageRank over the directed unit graph (rank flows from a file to the files it depends on), weighted by edge weight × confidence. It counts indirect dependents, so a file used by ten core modules outranks one used by ten leaf scripts.
- Converted to a **percentile across the whole repo** (`importancePct`, 0–1). The percentile is what sphere size and glow consume (§8.1), so "compared to peers across the repo" is literal.
- Also computed: fan-in/fan-out and strongly connected components, stored as layers.

### 6.8 The reveal: when the map appears

Nothing is drawn while parsing. The map is revealed once, already settled.

**Stable point.** All of:

1. The fast pass has finished on every file (skipped files excepted).
2. The slow pass has finished on every file, **or** `reveal.maxWaitSeconds` (default 30) has elapsed since the parse began.
3. Edges are resolved; units, importance, cities and districts are computed.
4. The layout has been simulated to rest off-screen (`PhysicsApi.settle`, time-capped).

The slow pass is inside the gate because in Java, Kotlin, C#, Go and Swift, files in the same package depend on each other without importing each other; imports alone under-describe their structure. Git history, overlays and AI are outside the gate: they colour and annotate the map and never move it.

**Waiting screen.** Plain white, no grid. The top bar shows the repo name and per-subsystem progress; a centred readout names the current stage ("Reading files 6,214 / 10,000", "Finding structure", "Settling layout"). The grid, legend and controls key appear with the map.

**Reveal.** Spheres grow in place, city by city, over about 2 seconds. Nothing travels.

**After the reveal the map only reorganises when asked.**

- If the 30-second escape hatch fired, the model is marked `structure: 'imports-only'` and the slow pass continues. The map stays frozen: positions, sizes, glow and membership do not change. New call edges appear as lines only. When the slow pass finishes, the top bar offers **"Refined structure ready · Apply"**, which re-computes importance and clustering and performs one animated re-layout.
- Returning to a repo that has changed: the saved map loads untouched and the top bar offers **"N files changed · Update"**, which re-parses the changed files and applies them in one animated step.
- Annotations (POI beams, summaries, tour) and overlay layers arrive live; they attach to existing entities and move nothing.

The patch-driven model and incremental physics (§7.2) are what make those two user-triggered updates local and animated instead of a rebuild.

---

## 7. Physics (reference: `d3/d3-force` v3)

### 7.1 Tiers

Each tier is a set of independent `forceSimulation` instances in the physics worker. A node only interacts with siblings under the same parent.

| Tier | Nodes | Coordinates | Forces |
|---|---|---|---|
| **City** (1 sim) | cities | world XZ | `forceLink` on inter-city weights; `forceCollide(radius + gap)`; weak `forceManyBody`; weak `forceX`/`forceY` gravity |
| **District** (1 sim per city) | that city's districts | local to city centre | `forceLink` on intra-city inter-district weights; `forceCollide(√area)`; custom `forceContain` (city radius); custom `forceExternalPull` (toward the bearing of connected outside cities); optional Lloyd relaxation toward the Voronoi cell centroid |
| **File** (1 sim per district) | that district's spheres | local to district centre | `forceRadial` (size input); `forceLink` on intra-district edges (connectivity input); `forceCollide(sphere radius + pad)`; custom `forceContain` (district cell) |

- **All spheres rest on the plane.** Layout is 2D. A sphere's centre sits at `y = radius`; nothing floats and height is never simulated.
- **Rubber-band links.** `forceLink.distance = rA + rB + gap · f(1/weight)`, strength below 1 so links have give. d3's default strength is `1 / min(degree(source), degree(target))` and its bias makes the higher-degree node move less; we keep that and scale it by a config factor.
- **Mass.** `forceCollide` resolves overlap in proportion to radius², so big cities and big files shove small ones aside.
- **No `forceCenter` at the city tier.** It translates every node's position directly each tick, which would make the world slide when one city is dragged. Weak `forceX`/`forceY` gravity is used instead.
- **File tier, size vs connectivity.** `forceRadial` targets a radius by size rank (largest spheres at the district centre; size already includes importance, so important files gravitate inward); `forceLink` pulls connected files together. One knob, `physics.file.sizeVsConnectivity` (default 0.5), sets `radial.strength = 2w·base` and scales link strength by `2(1−w)`. d3 already normalises link strength by degree, so equal coefficients give the two inputs equal pull per node. "50/50" is defined operationally this way.
- **Voronoi districts.** `d3-delaunay` computes the Voronoi diagram of district centres clipped to the city outline. Each cell is that district's territory and the containment region for its files. Collide radii ∝ √(district area) keep cell areas roughly proportional to content.
- **Space propagates upward.** When a district's content grows, its collide radius grows (eased) → siblings are pushed → the city's radius grows → neighbouring cities are pushed. This is how others "move aside to make room" during a user-triggered update.

### 7.2 Driving d3-force from a worker

Facts from the d3-force source that shape the design:

- A simulation starts its own `d3-timer` on construction. We call `.stop()` immediately and call `.tick()` from our scheduler. Manual `tick()` does not dispatch events and does not check `alphaMin`, so **the scheduler owns sleeping**: a sim whose `alpha < alphaMin` leaves the hot set.
- Each tick: `alpha += (alphaTarget − alpha) · alphaDecay`, then forces, then velocities are multiplied by the retention factor and added to positions. Nodes with `fx`/`fy` are snapped there with zero velocity.
- Defaults: `alphaMin 0.001`, `alphaDecay ≈ 0.0228` (~300 ticks to rest), `velocityDecay 0.4`. For "friction, settles quickly" we use a higher `velocityDecay` (~0.6) and a faster decay (~150 ticks), all in config.
- **Pre-reveal settle.** `settle()` ticks city → district → file sims to rest with no rendering, under a time cap. d3's fixed-seed random source makes the result reproducible.
- **New nodes with no `x`/`y` are placed on a phyllotaxis spiral by array index** (`radius = 10·√(0.5 + i)`), far from their district for a late index. We always set `x`, `y` before adding: beside an already-placed linked neighbour, else near the parent centre with a small seeded jitter.
- **`simulation.nodes(arr)` re-initialises every force and does not change alpha**; `forceLink` recomputes degree counts, strengths and distances then. Additions are therefore batched (at most one `nodes()`/`links()` call per sim per ~100 ms) and followed by a gentle reheat `alpha(max(alpha, physics.reheat))`, about 0.3 and never 1.
- `simulation.find()` is a linear scan and is not used; picking is done in the renderer (§9).
- Custom forces are plain functions `force(alpha)` with `force.initialize(nodes, random)`. `forceContain`, `forceExternalPull` and the Lloyd force follow that contract.

*To verify in the first spike:* that `d3-timer` constructs cleanly in a worker with no `requestAnimationFrame`.

### 7.3 Scheduler

- A fixed time slice per loop (default 8 ms). Order: city sim, then district sims, then file sims, each sorted by distance to the camera focus. Off-screen file sims tick at a reduced rate.
- After the reveal, and after loading a snapshot, every sim is asleep.
- **Dragging a pill:** set `fx`/`fy` and `alphaTarget ≈ 0.3` on that tier's sim; on release clear them and set `alphaTarget 0`. District drags are clamped to the city radius. Dragging a city wakes only the city sim; its districts and files ride along through the GPU hierarchy without ticking.
- Position buffers: `unit[i] = (x, z)` local, `district[j] = (x, z, r)` local, `city[k] = (x, z, r)` world, plus a per-district generation counter (`Atomics`) so the renderer uploads only rows that changed.

### 7.4 Jiggle is not physics

Hover wobble, bump transfer and selection pulsing are a **display-only spring layer in the renderer**:

- Each *active* sphere (pointer-near or recently bumped; dozens at most) has an offset and velocity integrated on the main thread, damped to settle in under 1 s.
- The pointer imparts an impulse along its velocity. Neighbours in the same district receive a fraction through a small spatial hash.
- Displacement is clamped (`interaction.jiggleMax`), and **hit-testing uses rest positions**, so a sphere never runs away from the cursor.
- Layout positions are untouched, so jiggle cannot reheat a simulation.

---

## 8. Rendering

### 8.1 Spheres: size, glow, visibility

One instanced draw call for all spheres, drawn as camera-facing quads shaded as spheres in the fragment shader. World position is composed in the vertex shader from three data textures (file-local, district, city).

**Size is 70% file size, 30% importance, mixed as radii:**

```
r_size   = clamp(k · lines^(1/3), rMin, rMax)          // volume ∝ lines of code
r_import = rMin + (rMax − rMin) · importancePct        // percentile across the repo
radius   = 0.7 · r_size + 0.3 · r_import
```

With `rMax = 12`: a 10-line file that is the most depended-on in the repo gets a radius of about 4; a huge file nothing depends on shrinks by about 30%. The 70/30 split is `visual.sizeBlend` in config.

**Glow marks importance.** Every sphere is drawn as a small star with a lit core (§8.6). What importance adds is the light that leaves the sphere: the outer corona and the pool of coloured light on the ground. That outward glow depends on importance alone: it starts faintly at the 70th percentile and reaches full brightness at the top (`visual.glowFromPct`). Large important files glow too, so the most depended-on file is never dim beside a glowing small helper. The outward glow fades while an overlay is active.

**Minimum-size filter.** The legend's slider sets a minimum line count. It is one shader uniform compared against each sphere's line count: spheres below it, and their lines, are not drawn. The layout does not change, so nothing shifts as the slider moves. Glowing files are exempt, so the slider only removes files that are both small and unimportant.

Other per-instance state (hover, selected ×1.3 with pulsing, dimmed, growing-in, overlay scalar) is animated in the shader from per-instance timestamps. An overlay switch uploads one `Float32Array` attribute and changes a colormap uniform. The file-type filter is a small lookup texture of "dimmed" flags per language.

**Spheres are always drawn individually at S and M.** Collapsing a district into an aggregate when zoomed far out is reserved for L, as part of its accepted degradation.

### 8.2 Ground, territories, shadows

- The plane is one quad with an analytic anti-aliased grid that fades with distance. The background is a full-screen gradient with a soft grey vignette.
- **Territories:** an offscreen top-down pass draws every sphere's footprint as a soft disc into a low-resolution texture, tagged with district and city id. The ground shader samples it to draw soft shadows, a tinted fill per city and contour lines at district and city boundaries, blended with the Voronoi cell edges for crisp district borders. It re-renders only while a simulation is hot. Cities and districts have boundaries on the plane and no enclosing 3D object.

### 8.3 Edges

- One instanced buffer; each instance is an arc between two unit indices, tessellated and lifted above the plane in the vertex shader, endpoints looked up from the position textures.
- Pulses of energy travel along each arc in the direction of the dependency (§8.6). Width and brightness scale with weight; faintness with low confidence.
- **Level of detail:**
  - Far: one ribbon per city pair. Width shows total traffic; pulses run both ways in proportion to each direction's share.
  - Mid: district↔district ribbons for cities in view, same convention.
  - Near: file↔file edges for districts in view, strongest first, under `render.edgeBudget`.
  - Always: every edge of hovered and selected spheres, in a small "focus" buffer at full strength.

### 8.4 Pills, beams, particles

- **Pills** (city, district, POI labels) are pooled DOM elements positioned with CSS transforms from projected anchors. City pills show "visible / total" files when the size slider hides some. District pills appear only for cities near the camera.
- **POI beams:** instanced vertical quads with an animated shader, anchored through the same parent lookup.
- **Particles:** two GPU point pools, ambient and burst, both stateless (§8.6).

### 8.5 Frame budget

- Quality steps down before frame rate does, in this order: ambient particle count, corona and ground-light resolution, pixel ratio, edge budget. Sphere colour, core light and edge pulses are never dropped.
- Ambient motion (particles, pulses, core shimmer) keeps the scene rendering continuously, at a reduced rate when the camera is still and nothing is hovered. Rendering pauses when the tab is hidden.

### 8.6 Visual language: stars, particles, pulses

Everything here is a function of time evaluated in shaders. None of it costs per-sphere or per-edge CPU work per frame.

**Light on a white world.** Additive glow is invisible against white, so emitted light is shown three other ways: a core brighter than the surface, a tinted halo drawn with normal alpha blending, and coloured light cast onto the white ground.

**The sphere as a small star**

| Layer | What it looks like | Driven by |
|---|---|---|
| **Body** | Saturated file-type colour across most of the disc. This is the dominant read at any distance. | language |
| **Core** | A white-hot centre blending outward into the type colour, as if lit from inside. Covers roughly the inner third of the radius. Slow shimmer (two noise octaves, a few percent of brightness) so no two stars pulse in step. | always on; each sphere has its own phase |
| **Rim** | Slightly deeper tone of the type colour at the edge, with a thin warm highlight on the upper side, so the body still reads as a sphere and not a flat disc. | fixed light direction |
| **Corona** | A soft tinted halo beyond the silhouette, with faint radial streaks that rotate slowly. | importance (from the 70th percentile), selection, hover |
| **Ground light** | A pool of the type colour on the plane beneath, blended into the territory texture. Low-importance spheres leave only a neutral contact shadow. | importance |

- The body and core are part of the sphere impostor's fragment shader. The corona is the same quad, enlarged for instances that need it, so there is still one draw call.
- Under an overlay the body takes the overlay colour, the core stays neutral white, and corona and ground light fade out.
- A dimmed sphere (filtered out by the legend) loses its core light and drops to a pale grey body.
- Selected spheres scale ×1.3 and their core, corona and scale breathe together on a ~1.5 s cycle.

**Ambient particles**

- **Stellar wind.** Small motes leave each star's surface, drift outward and upward a few radii, and fade. Each particle is bound to a host sphere chosen in proportion to importance, so important files visibly shed more energy and the smallest files shed almost none. A particle's position is `host position + f(seed, time)`; it follows its host through the same GPU hierarchy.
- **Void dust.** A sparse field of very faint, slow motes through the whole volume, to give depth and parallax when the camera moves.
- One pool, fixed size (`visual.particles.ambient`, default 4,000 at M). Particles fade with distance, so the visible density stays even as the camera zooms. This pool is the first thing reduced under load.

**Interaction particles** (a second small pool; each burst is a spawn time, an origin and a seed)

| Event | Effect |
|---|---|
| **Pointer sweeps past** | A few sparks thrown along the pointer's direction of travel; the sphere wobbles (§7.4). |
| **Single click (select)** | A core flash, a ring of about 40 particles in the type colour expanding outward and settling, and a shockwave ring travelling across the ground. Neighbours touched by the ring wobble. |
| **Double click (open file)** | A nova: a larger burst of about 150 particles, a brief vertical column of light rising from the sphere, and one synchronised pulse sent out along every connection at once, so the file's reach is visible as the sidebar opens. |
| **Reveal** | Each sphere ignites with a small flash as it grows in. |

**Edge pulses**

- A pulse is a packet of light with a bright head and a fading tail that travels along the arc **from the file that depends to the file it depends on** (caller → callee, importer → imported).
- Pulses move at a constant speed in world units, so longer connections take visibly longer and direction is unambiguous even on a still frame.
- More heavily used connections carry more frequent and brighter pulses. The line beneath stays a faint constant trace.
- Colour runs from the source file's type colour at the start of the arc to the target's at the end.
- Hovered and selected connections get a small flash on the target sphere's core as each pulse arrives. Background edges skip the flash.
- Ribbons between cities and districts carry pulses in both directions at once, in proportion to each direction's traffic.
- A pulse's position is `fract(time · speed / length − phase)` per edge instance: one time uniform drives every edge.

---

## 9. Interaction and controls

| Input | Action |
|---|---|
| Left-drag on empty space | Pan; the grabbed ground point stays under the cursor |
| Middle-drag or Space+drag | Orbit around the ground point under the pointer (ray → plane) |
| Wheel | Zoom toward the cursor |
| Hover | Jiggle + tooltip + draw that sphere's connections |
| Click | Select and focus; detail card |
| Double-click | Open file in the sidebar reader |
| Shift+click | Add/remove from selection |
| Shift+drag | Marquee select |
| Drag a pill | Move the city or district in the simulation (district clamped to its city) |

- **Picking is on the CPU and hierarchical**: ray vs city circles → district cells → spheres in that district. Positions are already on the main thread via the shared buffer, so there is no GPU readback.
- **Hover connections** come from an adjacency index in the view replica and are written into the focus edge buffer.
- **Search:** fuzzy match over paths in the coordinator worker (`uFuzzy`); selecting a result calls `flyTo`. Files hidden by the size slider stay searchable and reappear when selected.
- **Sidebar reader:** hidden by default, resizable. CodeMirror 6 read-only, lazy-loaded, with a sanitised markdown preview. Reads from the directory handle on demand.

Screen layout:

- **Top bar:** repo name, subsystem progress chips, overall bar, search, active-overlay indicator, and the two update actions ("Refined structure ready · Apply", "N files changed · Update") when relevant.
- **Top left:** selection pills.
- **Top right:** overlay buttons.
- **Bottom left:** controls key (small).
- **Bottom right:** file-type legend (click to isolate, Shift+click for several) with the **minimum-lines slider**: logarithmic, from 0 to the largest file, starting at `legend.minLinesDefault` (0 = show everything).
- **Bottom centre:** "Tour the repo".

---

## 10. Overlays

All overlays are layers in the model, computed in workers after the reveal. The active overlay is shown in the top bar, and importance glow fades while one is active.

| Overlay | Colour | Source | Notes |
|---|---|---|---|
| **Recency** (specified) | bright green → faded grey | history | Log-scaled age |
| **Ownership** (specified) | bright purple → grey | history | Commit share per author. Contributor picker with fuzzy search, sorted by commits. |
| **Dependency reach** (specified) | hop-count ramp | unit graph | BFS from the selection on demand; toggle "depends on" vs "depended on by" |
| **Hotspots** | heat | history × lines | Frequently changed *and* large |
| **Cycles** | highlight | SCCs | Files in dependency cycles; cross-city cycles emphasised |
| *Later:* Hidden coupling | links | co-change without a static edge | Files that change together but do not reference each other |
| *Later:* Knowledge risk | ramp | history | Files with a single dominant author |
| *Later:* Misplaced | highlight | cluster vs directory | Files whose community differs from their folder siblings' |
| *Later:* Tests | two-tone | path heuristics + edges | Test files, and source files no test references |

First release: Recency, Ownership, Reach, Hotspots, Cycles. A "load-bearing" overlay is not needed: importance is always visible through size and glow.

---

## 11. AI layer

### 11.1 Call structure

- The server is a thin, stateless proxy: `/api/ai/{summaries,pois,tour,detail}`. The browser builds the context from the model; the server validates size, calls the provider, validates the structured result against a schema, and streams it back.
- `AiProvider` interface with an Anthropic adapter (official `@anthropic-ai/sdk`) as the default; other providers are additional adapters behind the same interface.
- **Where the developer configures it:** `config.json → ai.provider`, `ai.models.synthesis`, `ai.models.bulk`; the key in `.env.local` / Vercel project env (`ANTHROPIC_API_KEY`, or the chosen provider's variable). `.env.example` documents it.
- **Default models:** `claude-opus-5-5` for POI selection, the tour and detail expansions; `claude-haiku-5-5` for the per-city summaries.
- **Workflow, not an open-ended agent.** A fixed map-reduce pipeline with structured outputs (`pois[].label` ≤ 3 words, `summary` ≈ 30 words, tour of 3–6 steps of 10–30 words, every item citing `NodeRef`s). The server drops any item whose refs do not exist and retries once on length violations. Refusal stop reasons are handled explicitly.
- **Later option:** a bounded tool-using loop for the detail buttons, with tools (`read_file`, `list_district`, `neighbors`) that execute in the browser, since only the browser has the repo.

Pipeline, started at the reveal once consent is given:

1. **Map:** one bulk-model call per city (parallel) → a short neutral summary of what that city contains.
2. **Reduce, two calls in parallel:** POIs and Tour, both given the repo digest plus the city summaries. The shared digest prefix is prompt-cached.
3. **On demand:** POI detail buttons ("Role in the system", "Who uses this", "Key entry points", "Walk me through it") send a focused context: that file's skeleton or content plus its neighbours' signatures.

- **POI count:** about one per city plus a few repo-wide: roughly 5 at 50 files, up to about 15 at 10k.
- Results are stored as annotations keyed by a hash of the digest, so a return visit regenerates nothing.

### 11.2 Context design and bias control

The digest is assembled deterministically under a token budget, split by fixed ratio so no source dominates:

| Share | Content | Why |
|---|---|---|
| ~35% | **Structure:** cities → districts with size, language mix, dominant paths; inter-city edge weights; entry points; build manifests reduced to names, targets and scripts | The architecture as measured |
| ~35% | **Code skeletons:** signatures and leading doc comments (no bodies) of selected files per district | Grounds claims in code |
| ~30% | **Docs:** root README, plus `README`/`ARCHITECTURE`/`CONTRIBUTING`/docs index at each city's and major district's root; headings outline + leading excerpt | Intent and vocabulary |

Bias mitigations:

- **Docs are labelled as claims** that may be stale or promotional and must be reconciled with the measured structure.
- **Stratified budget.** Each city's share is ∝ √size with a floor.
- **Not only hubs.** Per district: top files by importance, one most *distinctive*, and one seeded-random representative.
- **No order cues.** Candidate lists are shuffled with a fixed seed.
- **Exclusions:** vendored, generated, fixtures, lockfiles. Tests appear only as structure.
- **Evidence required.** Each POI and tour step cites node refs and one structural fact.
- **Audience instruction.** Reader knows code but not this repo; describe roles and flow, avoid repo-internal jargon.

### 11.3 Shapes

```ts
interface Poi  { id; parent: NodeRef; label: string /* ≤3 words */; summary: string /* ~30 words */;
                 kind: 'entry' | 'core' | 'boundary' | 'data' | 'risk'; evidence: string;
                 details: Record<string, { status: 'idle' | 'loading' | 'ready'; markdown?: string }> }
interface Tour { id; steps: { target: NodeRef; text: string /* 10–30 words */; highlights: NodeRef[] }[] /* 3–6 */ }
```

### 11.4 Operational concerns

- **Consent:** AI is the only path by which code excerpts leave the machine. The app asks once per repo, then generates summaries, POIs and the tour automatically; detail buttons call the model on click. `ai.enabled` in config turns the feature off entirely.
- **Abuse:** rate limits only. The `/api/ai/*` routes get a per-IP request limit (a Vercel Firewall rule or a small Redis-backed limiter), a hard cap on input tokens per request, and a cap on detail calls per repo digest. A spend limit on the provider account is the backstop. The provider interface leaves room for a passcode or bring-your-own-key later.
- Demo snapshots ship with AI annotations pre-generated, so demo mode needs no key.

---

## 12. Persistence, export, demo

- **Local only.** No accounts and no server-side storage. Sharing a map means sending the exported file.
- **Snapshot:** the gzipped model in the Origin Private File System, one file per repo, written at the reveal and after each later stage (debounced). The layout cache is included.
- **Registry:** IndexedDB records `{ id, name, directoryHandle, headOid, indexChecksum, schema, lastOpened }`. `navigator.storage.persist()` is requested.
- **Return visit:** the snapshot loads and renders immediately, untouched. Folder permission is requested in the background; if `indexChecksum` differs, the top bar offers "N files changed · Update" (§6.8).
- **Export / import:** the same `.gitmap.json.gz` file, downloaded or dropped onto the landing page.
- **Demo mode (M3):** two pre-parsed, permissively licensed open-source repos, one around 200 files and one around 5,000, with file contents bundled in a lazily fetched companion pack so the sidebar works. Exact repos chosen at M3.
- Bumping `schema` or `parserVersion` invalidates snapshots cleanly.

---

## 13. `config.json`

One file, typed and validated at build, imported by client and server. Secrets are excluded by design. A dev-only tuning panel can override physics and visual values live.

```jsonc
{
  "parser":     { "maxWorkers": 12, "batchBytes": 2097152, "maxFileBytes": 1048576, "retainBytes": 268435456,
                  "exclude": ["**/vendor/**", "**/*.min.js"], "includeUntracked": false, "bridges": ["jni", "protobuf"] },
  "reveal":     { "maxWaitSeconds": 30, "perFileTimeoutMs": 2000, "settleMaxMs": 3000, "growMs": 2000 },
  "history":    { "maxCommits": 20000, "maxFilesPerCommit": 50 },
  "clustering": { "citiesPerDecade": 3.5, "cityOffset": -2.2, "minCities": 1, "maxCities": 20,
                  "districtsPerDecade": 3.5, "districtOffset": -2.2, "minDistrictSize": 5,
                  "resolution": 1.0, "seed": 1, "directoryAffinity": 0.1, "hubDamping": true },
  "physics":    { "sliceMs": 8, "reheat": 0.3, "velocityDecay": 0.6, "settleTicks": 150,
                  "city":     { "gap": 40, "linkStrength": 0.5, "charge": -60, "gravity": 0.02 },
                  "district": { "pad": 6, "linkStrength": 0.6, "externalPull": 0.15, "lloyd": 0.1 },
                  "file":     { "pad": 0.5, "sizeVsConnectivity": 0.5, "baseStrength": 0.1 } },
  "visual":     { "radiusMin": 0.6, "radiusMax": 12, "sizeBlend": { "lines": 0.7, "importance": 0.3 },
                  "glowFromPct": 0.7, "selectedScale": 1.3, "languageColors": { "ts": "#3178c6" }, "grid": {}, "background": {},
                  "star":      { "coreRadius": 0.33, "shimmer": 0.04, "coronaScale": 1.8, "breatheMs": 1500 },
                  "particles": { "ambient": 4000, "voidDustShare": 0.2, "selectBurst": 40, "openBurst": 150 },
                  "edgePulse": { "speed": 60, "tail": 0.15, "maxRatePerSec": 2 } },
  "legend":     { "minLinesDefault": 0 },
  "render":     { "edgeBudget": 150000, "maxPills": 150, "patchBudgetMs": 4, "adaptiveDpr": true },
  "interaction":{ "jiggleMax": 0.35, "jiggleSettleMs": 800, "hoverDelayMs": 80 },
  "camera":     { "minDistance": 10, "maxDistance": 5000, "flyMs": 900 },
  "overlays":   { "enabled": ["recency", "ownership", "reach", "hotspots", "cycles"] },
  "ai":         { "enabled": true, "provider": "anthropic",
                  "models": { "synthesis": "claude-opus-5-5", "bulk": "claude-haiku-5-5" },
                  "digestTokens": 60000, "budgetSplit": { "structure": 0.35, "skeletons": 0.35, "docs": 0.30 },
                  "pois": { "perCity": 1, "repoWide": 3, "max": 15 }, "tour": { "minSteps": 3, "maxSteps": 6 } }
}
```

---

## 14. Performance targets and how each is met

Targets are goals to validate in M0, not measurements.

| Target | Mechanism |
|---|---|
| Reveal within 30 s at M, showing the final structure in most cases | Manifest from `.git/index`; both passes across the worker pool; per-file time cap; escape hatch |
| No main-thread task > 50 ms during parse | All compute in workers; the waiting screen draws only progress |
| Nothing moves after the reveal unless the user asks | Stable-point gate; frozen map in the escape-hatch case; explicit Apply / Update actions |
| 60 fps at S and M; usable at L with reduced detail | Instanced impostors; GPU-composed hierarchy; edge level-of-detail and budget; adaptive pixel ratio |
| Dragging a city costs O(1) uploads | One texel in the city transform texture |
| Size slider and overlay switch respond in one frame | One uniform; one attribute upload |
| Idle CPU near zero | All sims asleep after settle; territory texture re-rendered only while hot |
| Return visit interactive < 1 s (M) | OPFS snapshot with cached layout |
| Update after a pull proportional to the diff | Per-file cache keyed by blob OID |

---

## 15. Milestones

**M0 — Spikes.** Each produces a number, and together they decide whether any piece moves from TypeScript to WASM:
1. Read throughput and fast-pass scanning: File System Access + worker pool on a 1k and a 10k-file repo (and one 100k).
2. tree-sitter in WASM: grammar sizes, parse time per MB, query cost. This sets the real default for `reveal.maxWaitSeconds`.
3. Git pack walk via `FileReaderSync`: commits per second on a long history.
4. Render: 10k impostor spheres + arcs + territory pass on integrated graphics; the same at 100k to size the L degradation.
5. `SharedArrayBuffer` under COOP/COEP on a Vercel preview; d3-force (with `d3-timer`) constructed and manually ticked in a worker.

**M1 — Skeleton.** Model + patches + store; landing page and folder validation; manifest; fast pass for TS/JS, Python, C/C++; waiting screen; instanced spheres with size blend and glow; city-tier sim; reveal.

**M2 — Hierarchy and physics. First showable version.** graphology Louvain with dendrogram levels and the city/district counts; importance; slow pass for the three languages; district and file tiers; Voronoi territories; pre-reveal settle; pills and dragging; camera controls; hover, selection, marquee; jiggle; ribbons and edge level-of-detail; legend with type filter and minimum-lines slider. No history, AI or saved repos yet.

**M3 — Parser breadth and persistence.** Remaining languages, including Scala, PHP, Ruby, Vue/Svelte/Astro components, CSS/SCSS and HTML; JNI and Protobuf bridges; header pairing; OPFS snapshots; "N files changed · Update"; export/import; demo mode with two repos.

**M4 — History and overlays.** Pack walker; Recency, Ownership, Reach, Hotspots, Cycles; search; sidebar reader.

**M5 — AI.** Consent prompt; digest builder; server routes and provider adapter; city summaries; POIs with beams and detail buttons; tour with camera choreography.

**M6 — Polish.** Particles, visual tuning, adaptive quality, L-size degradation, error and empty states, accessibility of the DOM layer.

**Testing throughout:** golden fixture repos per language (expected edges); schema round-trip tests; the patch-equivalence property test (§5.1); seeded determinism tests for clustering and layout; modularity checks against python-louvain on fixture graphs; a synthetic graph generator for performance benchmarks; a Playwright smoke test against the demo snapshot.

---

## 16. Decisions and risks

### Decisions taken in review (2026-11-21)

| Topic | Decision |
|---|---|
| Scale | Design for S and M. L must work; slight degradation acceptable. |
| First showable version | End of M2. |
| Browsers | Chromium-first. Firefox/Safari: drag-and-drop and demo mode. Desktop only. |
| Framework | Vite single-page app + Vercel Functions. |
| Implementation language | TypeScript first behind swappable interfaces; M0 decides on any WASM. |
| Input | Git repos; plain folders accepted without history overlays. Untracked files off by default. |
| Call-edge accuracy | Name-based with stored confidence; architecture-grade, not compiler-exact. |
| Languages | The original 13 plus Scala, PHP, Ruby, Vue/Svelte/Astro components, CSS/SCSS and HTML. Schema languages, build files, shell and others are not parsed. |
| Cross-language boundaries | High-confidence only: JNI in both directions and Protobuf stubs matched by name. Weaker mechanisms deferred (§6.4.1). |
| Louvain | `graphology-communities-louvain`; python-louvain as behavioural reference; port only if blocked. |
| City count | `round(3.5·log10(files) − 2.2)`: 4 at 50, 8 at 1k, 12 at 10k. Districts use the same curve per city, minimum 5 files. |
| Physics | Three tiers; nodes interact only with siblings. |
| Height | All spheres rest on the plane. Height is sphere size. |
| Sphere size | 70% lines of code (volume-proportional), 30% importance percentile, mixed as radii. |
| Importance | PageRank over the dependency graph, as a percentile across the repo. |
| Glow | By importance alone, from the 70th percentile up; fades under overlays. |
| Sphere look | Small stars: file-type colour dominates, lit core on every sphere, corona and ground light by importance. Ambient stellar-wind particles; bursts on single and double click (§8.6). |
| Edges | Stored in full; ribbons when zoomed out (one band per pair, two-way pulses); spheres always individual at S and M. Pulses of energy travel from the dependent file to the file it depends on. |
| When the map appears | At the stable point (both passes, clustered, settled), or after 30 s with imports plus partial call edges. Waiting screen is plain white with progress, no grid. |
| After the reveal | Nothing moves unless asked: "Refined structure ready · Apply" and "N files changed · Update". |
| Legend | Minimum-lines slider; hides without changing layout; glowing files exempt. |
| Overlays, first release | Recency, Ownership (commit share), Reach, Hotspots, Cycles. |
| AI | Ask once per repo, then automatic. Opus 5.5 for synthesis, Haiku 5.5 for bulk. 35/35/30 context split. About one POI per city plus a few. Rate limits only. |
| Storage | Local to the browser; no accounts; share by exported file. |
| Demo | M3, two permissively licensed repos (~200 and ~5,000 files), contents bundled. |

### Risks

- **The wait before the reveal.** If the slow pass regularly exceeds 30 s at M, most users see the imports-only structure first and have to press Apply. M0 spike 2 measures this; the levers are the time cap, more workers, or moving scanners to WASM.
- **Imports-only structure** is weak for Java, Kotlin, C#, Go and Swift, which is exactly when the escape hatch matters most. The map is labelled as provisional in that state.
- **Git history in the browser** is the least proven piece. Fallback: `isomorphic-git` for small histories with a depth cap; worst case, history overlays are unavailable for very long histories.
- **Symbol linking accuracy** varies by language (weakest: C#, Swift, macro-heavy C++). Confidence is stored per edge so weak links are discounted.
- **Library dependence for Louvain.** The dendrogram's per-level format is undocumented; if it cannot give nested levels cleanly, districts fall back to per-city runs, and a port is the last resort.
- **tree-sitter payload** (several MB for large grammars), mitigated by lazy per-language loading.
