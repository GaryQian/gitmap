# starmap — architecture plan

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
| "Vertical dimension represents size and importance" | Elevation vs sphere size | Every sphere rests on the plane. Height is the sphere's own size, set by file size and enlarged by up to half for important files (§8.1). |
| "View begins empty, shows as it parses" / Louvain needs the whole graph | Clusters would reshuffle as edges arrive | Nothing is drawn during the parse. The map is revealed at a stable point (§6.8). |
| "All configurable values in one config.json" / API key | Keys must not ship to the browser | `config.json` holds provider and model names. The key lives in `.env.local` / Vercel env vars. |
| "White void with grey vignette" / later: "cosmic void", light and dark | The background brief changed | Superseded by §17: galactic dust wisps in both modes. Light mode keeps the cool-white, warm-light feel of the original. |
| Repo pills show "name and path" | Browsers do not reveal a picked folder's absolute path | Pills show the repo name and its origin remote from `.git/config` (§17.7). |

---

## 3. Runtime topology

```
 MAIN THREAD                      WORKERS
 ┌───────────────────────┐        ┌──────────────────────────────────────────┐
 │ React UI (DOM)        │        │ Coordinator                              │
 │ Renderer (three.js)   │◄─patch─┤  owns canonical ModelStore               │
 │ Input / camera        │        │  schedules work, decides the reveal      │
 │ View replica (typed   │        ├──────────────────────────────────────────┤
 │  arrays for drawing)  │        │ Compute pool ×N (parse, history tasks)   │
 └──────────┬────────────┘        │ Analysis        (resolve, Louvain, layers)│
            │ reads               │ (lanes and priorities: §3.1)             │
            ▼                     │ Physics         (d3-force tiers)          │
   SharedArrayBuffer  ◄───writes──┤                                          │
   positions                      └──────────────────────────────────────────┘
            ▲
            │ fetch (SSE)
   Vercel Functions /api/ai/*  ──►  model provider
```

- **Coordinator worker** holds the canonical model. The main thread holds a *view replica*: only the columns needed to draw and to answer UI queries.
- **Compute pool**: `N = clamp(round(hardwareConcurrency × scheduler.workerShare), 1, scheduler.maxWorkers)`, with `workerShare` 0.5. Browsers report logical cores, and the spikes got about 7× from 14 workers on 8 physical cores, so half is the useful number. The pool is also capped by memory (`scheduler.memoryCapMB`): 14 tree-sitter workers peaked at 0.8–1.9 GB. It runs parse tasks and history tasks alike (§3.1); there is no separate git worker.
- **Physics worker** receives topology patches straight from the coordinator over a `MessageChannel` and writes positions into a `SharedArrayBuffer`.
- **Patch flow control**: producers coalesce to at most ~10 patch batches per second. The main thread applies whole batches inside a per-frame budget (default 4 ms) and queues the rest; a batch too large for one frame is staged and committed at once (§5.1).
- `SharedArrayBuffer` needs cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` in `vercel.json`, with every asset served same-origin. Fallback when not isolated: the physics worker posts dirty position chunks as transferables at 30 Hz.

### 3.1 Scheduling: who gets the cores

All CPU-heavy work is cut into small tasks (target 20–50 ms each) and run by one **compute pool**. No worker belongs to a subsystem. The coordinator keeps a queue per lane, and each free worker takes the next task from the highest-priority lane that has one.

| Priority | Lane | Contains |
|---|---|---|
| 1 | **Interactive** | Work the user is waiting on right now: reach from the current selection, blame for one file, a sidebar read. Small; runs at once. |
| 2 | **Selected overlay** | The producer of the overlay currently selected, while its data is incomplete. |
| 3 | **Parse** | Fast-pass and slow-pass tasks; re-parsing for an Update. |
| 4 | **Other overlays** | Producers of overlays that are not selected. |
| 5 | **Housekeeping** | Working-tree check, cache writes, snapshot writes. |

**How the three required behaviours fall out**

- **Parsing has priority.** Overlay buttons appear with the map, so before the reveal lane 2 is always empty and the parse takes every worker it can use.
- **A selected overlay takes priority.** Selecting an overlay moves its producer from lane 4 to lane 2 at once; deselecting or switching moves it back. Tasks already running finish (at most ~50 ms), and the next free workers go to the selected overlay. This matters when parse work is still running after the reveal: the slow pass continuing after the 30-second escape hatch, or an Update.
- **Idle workers go to overlays.** The pool is work-conserving: a worker with nothing to take from a higher lane takes from a lower one. There is no fixed split to tune. In particular, the pool is idle while the single-threaded steps run (resolving links, clustering, settling the layout), so overlay processing starts in that window, before the map is even shown.
- **Parse is never starved.** While an overlay is selected, lane 3 keeps at least `scheduler.parseFloorWorkers` (default 1), so "Refined structure ready" still arrives.

**What the overlay lanes actually contain**

The only heavy overlay producer is the history walk, and it feeds Recency, Ownership and Knowledge risk together. Selecting any of the three promotes the same walk. Tests is computed at the reveal and Reach on demand; both take milliseconds in the analysis worker.

- **The walk is split so the pool can share it.** A planner task reads commits newest-first and emits chunks of about 200 consecutive commits. Each chunk is one task: diff every commit's tree against its parent and return per-file totals. Results merge in any order (counts add, last-modified takes the maximum, first-seen the minimum). Consecutive commits stay in one chunk because they share most of their tree objects.
- **Recency finishes early.** It needs only the newest commit per file, so it is marked complete as soon as every current file has been seen once, while the walk continues for the other two. In the spike that point came after 5,000 commits on react, 1.5 s on one thread.
- **Ownership and Knowledge risk need the whole window** (`history.maxCommits`).

How much the pool speeds up the walk is not measured; the spike ran it on one thread.

**Partial results are shown, clearly marked.** Each layer is `pending`, `partial` with a coverage figure, or `complete`. A partial overlay can be selected: files with known values are coloured, the rest are drawn in a neutral "not yet known" style, and values fade in as chunks land. The overlay's button shows a progress ring. Only colour changes; nothing moves.

**Interaction comes first.**

- The pool uses about half the logical cores, which leaves the main thread and the physics worker room to run.
- After the reveal, the renderer reports frame time. If frames run over budget while the user is moving the camera or dragging, the coordinator parks workers serving lanes 3–5, then lane 2 if that is not enough, and restores them when frames recover.

---

## 4. Modules and their boundaries

Single package, strict folder boundaries enforced by a lint rule. Each module exports one `index.ts`; nothing imports another module's internals.

| Module | Responsibility | Reads | Writes | Runs in |
|---|---|---|---|---|
| `model/` | Schema, IDs, `ModelStore`, patch types, (de)serialization | — | — | everywhere |
| `compute/` | The shared worker pool, priority lanes and task queue (§3.1) | task requests | task results | coordinator + pool |
| `ingest/` | Directory access, manifest, parse tasks, scanners | disk | patches: files, raw facts, progress | coordinator + compute pool |
| `analysis/` | Import/symbol resolution, header pairing, Louvain, importance, overlay layers | model | patches: edges, units, clusters, layers | analysis worker |
| `history/` | Git pack walking, per-file commit facts | `.git` | patches: contributors, history layers | compute pool |
| `physics/` | Tiered d3-force layout | cluster/unit/edge patches, commands | position buffers | physics worker |
| `render/` | three.js scene, picking, camera, effects | view replica, position buffers, view state | interaction events | main |
| `ai/` | Digest builder (client), provider adapters + routes (server) | model | patches: annotations | main + Vercel |
| `persist/` | Snapshot save/load (OPFS), repo registry (IndexedDB), export/import, demo | model | model | coordinator |
| `app/` | React shell: landing, waiting screen, top bar, panels, legend, sidebar, tour UI | view replica, view state | commands | main |
| `config/` | Typed loader for `config.json` | — | — | everywhere |

The folders actually used are finer-grained than this table, so that each work package owns one outright; they are listed in [IMPLEMENTATION.md](IMPLEMENTATION.md) §5–6. The boundaries and rules here still hold.

**Stack:** Vite + React + TypeScript, deployed as a static single-page app with Vercel Functions under `/api`. Raw three.js (not react-three-fiber): React must not reconcile thousands of scene objects.

**TypeScript first.** The git index reader, the per-language import scanners and the git pack walker start in TypeScript, each behind an interface that a WASM implementation can replace. M0 measured all three and found no case for Rust or WASM at S and M (§15). tree-sitter is WASM regardless. This avoids a Rust toolchain in the build unless the numbers demand it.

```
starmap/
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
  resetLayout(): Promise<void>;                      // cities and districts back to home positions
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
          parserVersion: string; parsedAt: number; structure: 'full' | 'provisional'; stats: Stats };
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
  layout?: { unit: number[]; district: number[]; city: number[];                // current positions
             home: { district: number[]; city: number[] } };                    // settled positions, for Reset view
}
type NodeRef = `f:${string}` | `u:${string}` | `d:${string}` | `c:${string}`;
```

Rules:

- **Unit** is the drawable sphere: one file, or a C/C++/Obj-C header+implementation pair. Its line count is the sum. The sidebar shows both files as tabs.
- **Persistent IDs** (path-derived for files and units, minted for cities and districts) are what annotations and saved state reference. Dense integer indices are per-session and exist only for typed arrays.
- **One model entity ↔ one drawn entity.** Unit ↔ sphere, edge ↔ line instance, district ↔ pill + ground territory, city ↔ pill + ground territory, POI ↔ beam, tour ↔ tour UI. **Points of interest and tour steps are parented to a file's sphere, never to a district or city**, so they survive any change of clustering. A city or district summary belongs to that cluster and is regenerated if its membership changes.
- **Edge kinds:** `import`, `call`, `reference`, `inherit`, `bridge` (cross-language, with a `mechanism` such as `jni` or `protobuf`, §6.4.1).
- **Layers** hold overlay data: `{ kind: 'scalar' | 'categorical' | 'sparse' | 'parametric', values, domain, colormap, status }`. Switching overlays never recomputes anything.
- **File contents are not in the model.** The sidebar reads them on demand: from disk for a local repo, from the content pack for a demo (§12.1).
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

### 6.3 Parse tasks

- **Contents come from the git packfile** (§6.3.1). Each task is a contiguous range of pack offsets; the worker reads it in large chunks and inflates blobs straight into the scanners. No file bytes cross a thread boundary.
- **Fallback, per file:** when a blob is not in a pack, the worker opens the working-tree file instead, using the root directory handle (structured-cloneable) with a per-directory handle cache.
- Tasks are sized by bytes (~2 MB) and pulled from the shared pool queue (§3.1).
- **Languages are plug-ins.** Each one declares its file extensions, an import scanner, an optional tree-sitter grammar and query, bridge extractors (§6.4.1) and a resolver. A repo pays only for the languages it contains.
- **Fast pass:** per-language scanners that skip comments and strings and extract import/include/using specifiers and line counts. In the same sweep over the bytes, a multi-pattern match looks for bridge trigger words; only files that hit one run a bridge extractor.
- **Slow pass:** tree-sitter with `tags`-style queries for definitions and call-site references. Grammars are separate `.wasm` files, fetched only for languages present. Stylesheets and HTML have no slow pass.
- **Read each file once.** Spike 1 found that opening files, not scanning them, dominates the fast pass (react, one thread: 4.6 s reading vs 0.8 s scanning; measured in Node, the browser read path is not yet measured). The fast pass therefore keeps file bytes in worker memory up to `parser.retainBytes`, and the slow pass reuses them instead of reopening. Only files beyond that budget are read twice.
- **Per-file time cap** (`reveal.perFileTimeoutMs`, default 2 s). A file that exceeds it is skipped: it still gets a sphere, sized from its byte count, with no edges.
- Per-file results are cached by blob OID in OPFS, so an update only re-parses files whose OID changed.

#### 6.3.1 Disk I/O strategy: pack first

Opening files one by one is the limiting cost of the parse. Decided: stop opening them. File contents are read out of the git packfile, which is one large file holding every committed blob, compressed.

**Measured** (`spikes/io/packblobs.ts`; Node, one thread, warm OS cache, Windows 11; code files ≤ 1 MB):

| Repo | Files | Raw MB | Open each file | Read from pack | Pack: disk I/O | Pack: inflate | Bytes read from disk |
|---|---|---|---|---|---|---|---|
| react | 4,590 | 26 | 2.18 s | **0.20 s** | 7 ms in 118 reads | 181 ms | 7.7 MB |
| flutter | 11,314 | 125 | 5.58 s | **1.00 s** | 35 ms in 551 reads | 789 ms | 36 MB |
| tensorflow | 21,453 | 247 | 10.08 s | **1.98 s** | 96 ms in 1,633 reads | 1,607 ms | 107 MB |

- Reading from the pack is 5–10× faster on one thread, and disk I/O drops to 3–5% of the time. Loading the pack index adds 33–344 ms once, shared with the history walker.
- **Decompression becomes the limit** (about 80% of the pack path, roughly 150 MB/s per core with `fflate`). Unlike file opens, it is pure CPU and splits cleanly across workers by offset range.
- All sampled blobs matched the working-tree files byte for byte, or after CRLF → LF conversion. Packed content is always LF, so offsets and line counts do not vary by platform.
- Read size barely matters when warm: 1 MB chunks cut flutter to 50 reads with the same I/O time. Offset-sorted versus path-sorted order made no difference when warm.
- **Not measured:** the browser read paths (per-file File System Access calls, and `FileReaderSync` on pack slices), a cold OS cache, and repos with many loose objects. All three test repos were fresh, fully packed clones with short delta chains. A long-used repo with loose objects and several packs must be benchmarked before these numbers are relied on.

**Strategy, in order of effect**

1. **Pack first, across every pack.** A repo that has been fetched into has several packs, not one. Look up each index entry's blob OID in every pack index, sort by pack and offset, and hand contiguous ranges to the pool. Each worker reads its range in large chunks and inflates and delta-resolves into the scanners. A delta whose base lies outside the range, in another pack or among the loose objects, is resolved through the shared object reader: ranges are a way to split the work, not a promise that a range is self-contained. Both passes run on the inflated bytes.
2. **Loose objects next, read as git objects.** Recent commits and staged files live as individual files under `.git/objects/`. They are read and inflated directly, so the content is exactly the blob the index names. This costs one file open each, but only for recently changed files.
3. **The working tree is the last resort and is never trusted blindly.** It is used only when the blob exists nowhere in `.git` (partial clones) or there is no `.git` at all (plain folders). A file on disk can differ from the committed blob through unstaged edits or CRLF line endings, so its content is hashed the way git hashes a blob. Parse results are cached under the index OID only if that hash matches; otherwise they are cached under the content's own hash and the file is counted as changed.
4. **Special index entries.** Git LFS pointers are treated as binary assets. Submodule entries are skipped. A path in merge conflict appears once, using its "ours" stage.
5. **If a pack disappears mid-read** because git repacked or fetched in the background, the reader reloads the pack list and retries the task once. A second failure falls back to step 3 for the affected files.
6. **Read nothing that is already known.** Parse facts are cached by blob OID, so a return visit reads only blobs whose OID changed. Non-code files are sized from the index and never opened.
7. **Touch less memory.** The browser offers no memory-mapped files and no control over the OS page cache, so the equivalent of reducing page faults is to read fewer bytes (the pack is 5–10× smaller than the raw files), read them in offset order so OS read-ahead works, inflate into a reused per-worker buffer instead of allocating per file, scan bytes directly without first decoding to a string, and transfer buffers between threads instead of copying.
8. **For the working-tree fallback path:** order reads by directory, cache directory handles, keep several reads in flight per worker, and enumerate a directory once when most of its files are wanted.
9. **If inflate still dominates,** it is now the first candidate for WASM, ahead of the scanners.

**What the map shows.** The pack holds what is staged or committed, so the reveal shows that state. A file edited on disk but not yet `git add`ed first appears in its last staged form.

**Background working-tree check.** After the reveal, a low-priority pass compares each tracked file's size and modified time on disk with the values recorded in `.git/index`. A browser has no cheap stat call, so this is a file-handle lookup per file with no content read; it never delays the reveal. **A mismatch is not yet a change:** formatters, builds and checkouts touch timestamps without changing content. A mismatched file is read and hashed the way git hashes a blob (trying CRLF → LF as well), and only if that hash differs from the index OID is it re-parsed off-screen and counted. If any files did change, the top bar offers "N files changed · Update" (§6.8). Nothing moves until that is clicked.

#### 6.3.2 Disk reads after the reveal

The parse is not the only reader. Everything below sits outside the reveal gate and must never delay it.

| Consumer | What it reads | From | How the cost is controlled |
|---|---|---|---|
| **Recency, Ownership, Knowledge risk** | commit and tree objects across history; no file contents | pack | One history walk feeds all of them (§6.5). It runs on whatever workers the parse is not using and takes priority once one of these overlays is selected (§3.1). Newest-first, so the overlays fill in progressively. |
| **Reach, Tests** (and later: misplaced) | nothing | memory | Computed from the graph and file paths already loaded. |
| **Blame for one file** (on demand) | every past version of that one file | pack | Only when asked; a few dozen to a few hundred blobs. |
| **AI digest** | nothing extra | memory | The slow pass keeps each file's signature lines and leading doc comments, and the fast pass keeps the first few KB of README and docs files, so the digest is built with no further reads. |
| **AI detail buttons** | one file plus its neighbours' signatures | disk for the file; memory for signatures | One read per click. |
| **Sidebar reader** | one file | disk | Reads the working-tree file, since that is what the user would edit. One read per open. |
| **Background working-tree check** | size and modified time of every tracked file | disk, metadata only | The one remaining per-file cost. Runs last, throttled, and can be turned off (`parser.workingTreeCheck`). |
| **Return visit** | the snapshot; then only commits newer than the saved head, and only blobs whose OID changed | OPFS, then pack | Overlay layers are stored in the snapshot, so they need no disk at all on return. |

Rules that follow:

- **One pack reader, shared.** The pack index is loaded once into a `SharedArrayBuffer` and used by every pool worker, for parse tasks and history tasks alike. For tensorflow the index covers 2.3 million objects; one copy per worker would cost tens of MB each.
- **The reveal has priority.** Before the map appears, history only ever gets workers the parse has no task for, and the working-tree check waits in the lowest lane (§3.1). Neither lengthens the wait.
- **Layers are saved as they complete**, so a closed tab does not repeat the history walk.

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

### 6.5 Git history (compute pool, never delays the reveal)

History runs as chunked tasks on the shared pool, using idle workers before the reveal and taking priority when a history-based overlay is selected (§3.1).

- Pack walker reading `.idx` and `.pack` through `FileReaderSync` on `File.slice()` (synchronous random access in a worker without loading whole packs). Uses the commit-graph file when present.
- Walks commits newest-first from `HEAD`, diffing each commit's tree against its first parent. **Merge commits are skipped by default** (`history.merges`): diffing a merge against its first parent would credit it with everything its branch brought in and let its date win "last modified". This default is still open (§16). Tree diffs only descend into subtrees whose OID differs, so no blobs are read.
- Emits per-file: last-modified time, first-seen time, commit count and per-author commit counts. Co-change pairs are not collected: their only consumer was the removed Hidden coupling overlay.
- Streams progressively; applies `.mailmap`. Bounded by `history.maxCommits` (50,000) and `history.timeBudgetSeconds` (20), whichever comes first, with a "Load full history" action for the rest.
- **Incremental on return.** The snapshot stores the head commit the walk reached. A later visit walks only commits newer than that and merges them into the saved per-file facts.

**Measured** (raw output of the first, untuned run of the git spike; Node, one thread, full history, 64 KB pages with a 32 MB page cache). After tuning, [M0-RESULTS.md](M0-RESULTS.md) reports 2.5 s, 8.8 s and 52 s for the same three repos:

| Repo | Commits | Time | Pack reads | MB read | Time in I/O | Peak memory | At 20,000 commits |
|---|---|---|---|---|---|---|---|
| react | 21,800 | 3.5 s | 916 | 57 | 0.08 s | 467 MB | 3.4 s, every current file seen |
| flutter | 92,682 | 21.6 s | 6,355 | 397 | 0.5 s | 609 MB | 4.1 s, 88% of current files seen |
| tensorflow | 204,106 | 71.2 s | 69,444 | 4,340 | 3.5 s | 928 MB | 6.5 s, 50% of current files seen |

- **History is CPU-bound in Node, not disk-bound**: I/O is 2–5% of the time; inflating and diffing trees is the rest.
- **The read count is the browser risk.** Tensorflow re-read 4.3 GB from a 1.5 GB pack because the small page cache thrashed: 69,444 reads. In a browser each read is a cross-process call of unknown cost. The spike's follow-up runs settled on 256 KB pages (`history.pageBytes`) and a two-generation object cache of 16–32 MB (`history.objectCacheBytes`); the walker also reads the commit-graph file when present. That file holds each commit's parents, tree and date but not its author, so it lets Recency skip commit objects; Ownership and Knowledge risk still read them. Per-read cost in a browser is still unmeasured.
- **The default cap is 50,000 commits or 20 seconds.** That covers the whole history at S and M. At L it can leave older files without history; they show as "older than the window" in Recency and as unknown in Ownership until "Load full history" is used.
- **Memory, not disk, limits full-history walks at L.** The spike collected two growing tables, authors per file and co-change pairs. The plan no longer collects co-change, so the memory figures above overstate what the product will use; by how much is not measured.
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
- **Orphans.** Isolated nodes stay singletons, and a graph with no edges returns all singletons. Config, docs and data files often have no code edges, so weak "same directory" affinity edges (`clustering.directoryAffinity`, default 0.3) are added to the clustering graph only.
- **Hub suppression.** For clustering only, an edge into a node is down-weighted by the log of that node's in-degree, so one logging utility does not glue the repo into a single city.
- **Path bias (available, off by default).** `clustering.pathBias` multiplies a code edge by `1 + pathBias × proximity`, where proximity is the share of the deeper file's directory chain that both files have in common: 1 in the same directory, 1/2 for sibling directories two levels down, 0 when nothing is shared. Edges across trees are never reduced, so strong coupling across trees still wins. Measured with `scripts/bench/pathbias.ts` on 2026-11-21, it did little: on react the share of each second-level directory kept in one city rose from 0.63 to 0.69–0.70 at a bias of 2–4, but on flutter and GitViz the change was within run-to-run noise. Reweighting edges that are mostly already inside a community does not move much, because modularity compares against a baseline that grows with the same weights. Two follow-up measurements on react, same script and day:
  - **Merge-step bias** (`clustering.mergePathBias`, also off by default): when a community is merged away, a neighbour's score is multiplied by `1 + bias × closeness` of the two communities' dominant directories. Second-level directories kept in one city rose from 0.645 to 0.672 at a bias of 2, and no further at 4. A small gain, with no growth in the largest city.
  - **Directory ties** (the existing `directoryAffinity`): raising it from 0.1 to 0.5 lifted the same figure from 0.645 to 0.778, and 1.5 gave 0.797. This is the lever that works. Its cost is a bigger largest city (30% of files at 0.1, 41% at 0.5) and districts that respect dependencies less (0.58 → 0.54 of edge weight kept inside a district); the share of edge weight kept inside cities barely moved (0.86 → 0.85).
  - So the way to keep directory trees together more firmly is a stronger `directoryAffinity`, chosen together with the balance rules that hold giants back. The two multipliers are minor refinements.
  - **Decided 2026-11-21: `directoryAffinity` is 0.3.** That value sits between the two measured ones (0.1 and 0.5) and was not itself measured.
- **Tests.** Fixture graphs are run through python-louvain offline; our partitions must reach modularity within a tolerance of the reference's (not identical partitions, since the random sequences differ). One test pins the direction of `resolution`.

**City count.** `K = round(citiesPerDecade · log10(files) + cityOffset)`, defaults `3.5` and `−2.2`, both in config:

| Files | 50 | 200 | 1,000 | 5,000 | 10,000 | 100,000 |
|---|---|---|---|---|---|---|
| Cities | 4 | 6 | 8 | 11 | 12 | 15 |

Procedure: take the coarsest dendrogram level with at least K communities and merge the smallest into their most-connected neighbour until K remain. If the coarsest level has too few, raise `resolution` and re-run (a few runs at most).

**Districts.** The same curve applied to each city's own file count, minimum 5 files per district: about 5 districts in a 125-file city, about 8 in an 830-file city. Taken from the next finer dendrogram level restricted to the city; if that level is degenerate, Louvain is re-run on the city's subgraph.

**Balance: a bias against mega-districts and megacities, with no size cap** (decided 2026-11-21, after tensorflow came out as four giant clusters and a few small ones). Louvain is content to return one community of thousands of files beside a hundred small ones, and merging each small one into its most-connected neighbour feeds the giant. Nothing is capped: a block that really is one tightly bound mass stays whole. Instead the algorithm counts and merges differently. The strength is `clustering.sizeBias` for cities (0.5; 0 = plain) and `clustering.districtSizeBias` for districts (1):

- **A second look at giants.** A community larger than an even share of the wanted count is run through Louvain on its own subgraph, where the resolution limit no longer hides its structure. It is divided only if the division is real: its modularity inside the community is at least `clustering.splitModularity` (0.3).
- **Pieces that are not separate are rejoined.** Louvain always returns some division, even of a structureless block. Two communities are joined when the weight between them is at least `clustering.mergeCoupling` (0.4) times the geometric mean of the weights inside them.
- **Effective count.** The wanted number of cities or districts is compared with `(Σsize)² / Σsize²`, not the plain count: twelve equal communities count as 12; one holding 80% of the files plus eleven small ones counts as about 1.5. Merging stops when the effective count is down to the wanted number, so small communities are left standing beside a large one. The plain count can therefore end above the curve; it is bounded at `clustering.countSlack` (1.5) times the wanted number, and at `maxCities` for cities.
- **Size-relative merging.** A community joins the neighbour it is most connected to for that neighbour's size, so a giant needs more connections to be chosen: weight ÷ √size for cities, weight ÷ size for districts.
- **Belonging comes before balance** (weakened 2026-11-21: at full strength cities came out uniform and files sat in cities they had little to do with; on tensorflow only 75% of connection weight stayed inside a city, against 85% with no bias). Three things restore it:
  - Cities are formed with every directory held whole; only districts are formed on the divisible runs. A big flat directory can become several districts but never drifts apart across cities.
  - After whole communities have been divided and merged, each file moves to the city that holds most of its connection weight.
  - The city strength is 0.5, with the gentler √size merge rule. Districts keep the full strength, because inside one city everything is related and what the eye catches is a district the size of the city; they may also run to 2.5× their count curve (`districtCountSlack`).
- **Large flat directories** (thousands of data or fixture files in one folder, with or without code edges among them) used to be a star around the directory and therefore one indivisible district. A directory that holds more than 16 files together now ties them in runs of about √n path-order neighbours, which divide like any other structure. Where a run starts is decided by a hash of the file's path, not its position in the listing, so adding a file moves at most the boundaries next to it.
- **An Update does not re-cluster.** Re-running Louvain after a small change is not local: dropping 1% of tensorflow's files and clustering again moved about a third of the remaining files to another district. So for "N files changed · Update" the caller sets `previous.incremental`: every unit keeps its district, a new unit goes to the district it is most connected to (else to the one holding most of its directory's files), and districts that emptied disappear. Balance is not maintained across Updates; "Apply" and a fresh open cluster from scratch. If more than a fifth of the units are new, a full clustering runs instead.

Measured with imports and call edges, plain rule → current:

| | tensorflow (24,685 units) | react (7,156 units) |
|---|---|---|
| Cities | 13 (522–5,871 files) → 15 (522–4,138) | 11 (134–3,374) → 17 (83–3,105) |
| Largest district | 2,770 → 949 files | 2,888 → 999 files |
| Connection weight inside a city | 85.8% → 86.0% | 84.7% → 84.3% |
| Linked files more connected to another city | 2.4% → 2.2% | 9.2% → 8.9% |

React's largest city is the compiler package with its fixtures, 43% of the repo; it stays one city because that is where those files belong, and it divides into 25 districts. At full strength the largest districts were about 560 files on both repos, at the cost of the misplacement above. An incremental Update after dropping 1% of the files keeps every remaining file in its district (a full re-clustering keeps 70–82%).

**Names.** Most distinctive shared path segment (TF-IDF over path tokens). An AI summary may later override the label through an annotation.

### 6.7 Importance

- PageRank over the directed unit graph (rank flows from a file to the files it depends on), weighted by edge weight × confidence. It counts indirect dependents, so a file used by ten core modules outranks one used by ten leaf scripts.
- Converted to a **percentile across the whole repo** (`importancePct`, 0–1). The percentile is what sphere size and glow consume (§8.1), so "compared to peers across the repo" is literal.
- Also computed: fan-in and fan-out per file, for tooltips and the detail card.

### 6.8 The reveal: when the map appears

Nothing is drawn while parsing. The map is revealed once, already settled.

**Stable point.** All of:

1. The fast pass has finished on every file (skipped files excepted).
2. The slow pass has finished on every file, **or** `reveal.maxWaitSeconds` (default 30) has elapsed since the parse began.
3. Edges are resolved; units, importance, cities and districts are computed.
4. The layout has been simulated to rest off-screen (`PhysicsApi.settle`, time-capped).

The slow pass is inside the gate because in Java, Kotlin, C#, Go and Swift, files in the same package depend on each other without importing each other; imports alone under-describe their structure. Git history, overlays and AI are outside the gate: they colour and annotate the map and never move it.

**Waiting screen.** The dust-wisp background of the current mode, with no grid (§17.8). A centred progress pill names the current stage ("Reading files 6,214 / 10,000", "Finding structure", "Settling layout"). The grid, legend, controls key and the rest of the chrome appear with the map.

**Reveal.** Spheres grow in place, city by city, over about 2 seconds. Nothing travels.

**After the reveal the map only reorganises when asked.**

- If the 30-second escape hatch fired, the model is marked `structure: 'provisional'` and the slow pass continues. The provisional clustering was built from imports plus whichever call edges had been found by then, so it can differ between runs and will usually change once the connection pass completes. **That is accepted:** the first complete pass is what fixes the structure. Meanwhile the map stays frozen: positions, sizes, glow and membership do not change, and new call edges appear as lines only. When the slow pass finishes, the top bar offers **"Refined structure ready · Apply"**, which re-computes importance and clustering and performs one animated re-layout. City and district identities, names and home positions are simply recomputed; nothing depends on them yet, because AI has not run (§11.1).
- **After the first complete pass, clustering is stable.** "N files changed · Update" places changed and new files into the existing city and district they connect to most strongly. It does not re-run Louvain over the whole repo.
- Returning to a repo that has changed: the saved map loads untouched and the top bar offers **"N files changed · Update"**, which re-parses the changed files and applies them in one animated step.
- The same action appears on a first visit when the background working-tree check (§6.3.1) finds files edited on disk but not staged.
- Annotations (POI beams, summaries, tour) and overlay layers arrive live; they attach to existing entities and move nothing.

The patch-driven model and incremental physics (§7.2) are what make those two user-triggered updates local and animated instead of a rebuild.

---

## 7. Physics (reference: `d3/d3-force` v3)

### 7.1 Tiers

Each tier is a set of independent `forceSimulation` instances in the physics worker. A node only interacts with siblings under the same parent.

| Tier | Nodes | Coordinates | Forces |
|---|---|---|---|
| **City** (1 sim) | cities | world XZ | `forceLink` on inter-city weights; spatial-hash collide (radius + gap); weak `forceManyBody`; weak `forceX`/`forceY` gravity |
| **District** (1 sim per city) | that city's districts | local to city centre | `forceLink` on intra-city inter-district weights; spatial-hash collide (√area); custom `forceContain` (city radius); custom `forceExternalPull` (toward the bearing of connected outside cities); optional Lloyd relaxation toward the Voronoi cell centroid |
| **File** (1 sim per district) | that district's spheres | local to district centre | `forceRadial` (size input); `forceLink` on intra-district edges (connectivity input); spatial-hash collide (sphere radius + pad); custom `forceContain` (district cell) |

- **All spheres rest on the plane.** Layout is 2D. A sphere's centre sits at `y = radius`; nothing floats and height is never simulated.
- **Rubber-band links.** `forceLink.distance = rA + rB + gap · f(1/weight)`, strength below 1 so links have give. d3's default strength is `1 / min(degree(source), degree(target))` and its bias makes the higher-degree node move less; we keep that and scale it by a config factor.
- **Collision is our own force, not d3's `forceCollide`.** The stock force took 3.2 s to settle 10k files, over the 3 s budget; the spatial-hash collide written in the physics spike takes 0.7 s. It keeps d3's behaviour of resolving overlap in proportion to radius², so big cities and big files shove small ones aside.
- **No `forceCenter` at the city tier.** It translates every node's position directly each tick, which would make the world slide when one city is dragged. Weak `forceX`/`forceY` gravity is used instead.
- **File tier, the intended look.** Larger spheres tend toward the middle of a district, but not strictly: files that are strongly connected should sit near each other even when that pulls a large file off-centre or a small one inward. Concentric rings sorted by size, as the render spike's placeholder layout shows, are the wrong result.
- **File tier, size vs connectivity.** `forceRadial` targets a radius by size rank (largest spheres at the district centre; size already includes importance, so important files gravitate inward); `forceLink` pulls connected files together. One knob, `physics.file.sizeVsConnectivity` (default 0.5), sets `radial.strength = 2w·base` and scales link strength by `2(1−w)`. d3 already normalises link strength by degree, so equal coefficients give the two inputs equal pull per node. "50/50" is defined operationally this way.
- **Open tuning question.** The physics spike found that `sizeVsConnectivity` at 0.5 leaves 11–17% of files overlapping at 10k after settling, and that about 0.8 does not. The default stays at the specified 0.5; the physics test reports overlap so the value can be chosen from numbers (§16).
- **Voronoi districts.** `d3-delaunay` computes the Voronoi diagram of district centres clipped to the city outline. Each cell is that district's territory and the containment region for its files. Collide radii ∝ √(district area) keep cell areas roughly proportional to content.
- **Space propagates upward.** When a district's content grows, its collide radius grows (eased) → siblings are pushed → the city's radius grows → neighbouring cities are pushed. This is how others "move aside to make room" during a user-triggered update.

### 7.2 Driving d3-force from a worker

Facts from the d3-force source that shape the design:

- A simulation starts its own `d3-timer` on construction. We call `.stop()` immediately and call `.tick()` from our scheduler. Manual `tick()` does not dispatch events and does not check `alphaMin`, so **the scheduler owns sleeping**: a sim leaves the hot set only when both `alpha` and `alphaTarget` are below `alphaMin` (a dragged sim holds `alphaTarget` up while its `alpha` decays).
- Each tick: `alpha += (alphaTarget − alpha) · alphaDecay`, then forces, then velocities are multiplied by the retention factor and added to positions. Nodes with `fx`/`fy` are snapped there with zero velocity.
- Defaults: `alphaMin 0.001`, `alphaDecay ≈ 0.0228` (~300 ticks to rest), `velocityDecay 0.4`. For "friction, settles quickly" we use a higher `velocityDecay` (~0.6) and a faster decay (~150 ticks), all in config.
- **Pre-reveal settle.** `settle()` ticks city → district → file sims to rest with no rendering, under a time cap. d3's fixed-seed random source makes the result reproducible.
- **New nodes with no `x`/`y` are placed on a phyllotaxis spiral by array index** (`radius = 10·√(0.5 + i)`), far from their district for a late index. We always set `x`, `y` before adding: beside an already-placed linked neighbour, else near the parent centre with a small seeded jitter.
- **`simulation.nodes(arr)` re-initialises every force and does not change alpha**; `forceLink` recomputes degree counts, strengths and distances then. Additions are therefore batched (at most one `nodes()`/`links()` call per sim per ~100 ms) and followed by a gentle reheat `alpha(max(alpha, physics.reheat))`, about 0.3 and never 1.
- `simulation.find()` is a linear scan and is not used; picking is done in the renderer (§9).
- Custom forces are plain functions `force(alpha)` with `force.initialize(nodes, random)`. `forceContain`, `forceExternalPull` and the Lloyd force follow that contract.

*Verified in the physics spike:* d3-force and `d3-timer` construct and tick manually inside a worker, and positions are shared with the page without copying.

### 7.3 Scheduler

- A fixed time slice per loop (default 8 ms). Order: city sim, then district sims, then file sims, each sorted by distance to the camera focus. Off-screen file sims tick at a reduced rate.
- After the reveal, and after loading a snapshot, every sim is asleep.
- **Dragging a pill:** set `fx`/`fy` and `alphaTarget ≈ 0.3` on that tier's sim; on release clear them and set `alphaTarget 0`. District drags are clamped to the city radius. Dragging a city wakes only the city sim; its districts and files ride along through the GPU hierarchy without ticking.
- **Home positions.** The settled city and district positions are stored as `layout.home` at the reveal and again after each Apply or Update. Dragging changes only the current positions. `resetLayout()` clears all pins and eases current positions back to home over about 600 ms without running the simulations, then leaves every sim asleep. File positions inside a district are never dragged, so they have no separate home.
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

Spheres are camera-facing quads shaded in the fragment shader, in three instanced draws over the same instances: bodies, glows and ground light (§8.6). World position is composed in the vertex shader from three data textures (file-local, district, city).

**File size sets the radius; importance can enlarge it by up to half.**

```
r_size = clamp(k · lines^(1/3), rMin, rMax)     // volume ∝ lines of code
boost  = importancePct ^ curve                  // 0 for the least important file, 1 for the most
radius = r_size · (1 + 0.5 · boost)
```

File size is the main contributor, and importance only ever scales it. With the defaults (`k = 0.8`, `rMin = 0.8`, `rMax = 12`, `curve = 2`):

| File | Least important | Median importance | Most important |
|---|---|---|---|
| 10 lines | 1.7 | 1.9 | 2.6 |
| 500 lines | 6.3 | 7.1 | 9.5 |
| 3,400 lines or more | 12 | 13.5 | 18 |

- **Size order is mostly preserved.** At most, importance makes a file look like one about 3.4 times its length (1.5³). A small helper can stand out among its peers but can never pass for a large file.
- **The curve keeps the boost for the files that earn it.** A file of median importance grows by about 12%; the full 50% goes only to the most depended-on file in the repo.
- The maximum boost, the curve and the scale are `visual.importanceBoost`, `visual.importanceCurve` and `visual.sizeScale` in config.
- The earlier rule mixed a file-size radius and an importance radius 70/30. Because importance percentiles spread evenly while most files are of similar length, importance ended up moving the radius about twice as much as size did. This rule replaces it.

**Glow marks importance.** Every sphere is drawn as a small star with a lit core (§8.6). What importance adds is the light that leaves the sphere: the outer corona and the pool of coloured light on the ground. That outward glow depends on importance alone: only about the top 10% of files glow. It starts faintly at the 90th percentile and reaches full brightness at the top (`visual.glowFromPct`). Large important files glow too, so the most depended-on file is never dim beside a glowing small helper. The outward glow fades while an overlay is active.

**Minimum-size filter.** The legend's slider sets a minimum line count. It is one shader uniform compared against each sphere's line count: spheres below it, and their lines, are not drawn. The layout does not change, so nothing shifts as the slider moves. Glowing files are exempt, so the slider only removes files that are both small and unimportant.

Other per-instance state (hover, selected ×1.3 with pulsing, dimmed, growing-in, overlay scalar) is animated in the shader from per-instance timestamps. An overlay switch uploads one `Float32Array` attribute and changes a colormap uniform. The file-type filter is a small lookup texture of "dimmed" flags per language.

**Spheres are always drawn individually at S and M.** Collapsing a district into an aggregate when zoomed far out is reserved for L, as part of its accepted degradation.

### 8.2 Ground, territories, shadows

- The plane is one quad with an analytic anti-aliased grid that fades with distance. Behind everything is the procedural dust-wisp background (§17.4), in light and dark variants.
- **Territories:** an offscreen top-down pass draws every sphere's footprint as a soft disc into a low-resolution texture, tagged with district and city id. The ground shader samples it to draw soft shadows, a tinted fill per city and contour lines at district and city boundaries, blended with the Voronoi cell edges for crisp district borders. It re-renders only while a simulation is hot. Cities and districts have boundaries on the plane and no enclosing 3D object.

### 8.3 Edges

- One instanced buffer; each instance is an arc between two unit indices, tessellated and lifted above the plane in the vertex shader, endpoints looked up from the position textures.
- Pulses of energy travel along each arc in the direction of the dependency (§8.6). Width and brightness scale with weight; faintness with low confidence.
- **Level of detail:**
  - Far: one ribbon per city pair. Width shows total traffic; pulses run both ways in proportion to each direction's share.
  - Mid: district↔district ribbons for cities in view, same convention.
  - Near: a small ambient set of file↔file edges for districts in view, strongest first, capped at `render.ambientEdges` (default 1,500). Drawing tens of thousands at once buried the stars in the render spike; most connections should be seen by hovering or selecting.
  - Always: every edge of hovered and selected spheres, in a small "focus" buffer at full strength.

### 8.4 Pills, beams, particles

- **Pills** (city, district, POI labels) are pooled DOM elements positioned with CSS transforms from projected anchors. City pills show "visible / total" files when the size slider hides some. District pills appear only for cities near the camera.
- **POI beams:** instanced vertical quads with an animated shader, anchored through the same parent lookup.
- **Particles:** two GPU point pools, ambient and burst, both stateless (§8.6).

### 8.5 Frame budget

- Quality steps down before frame rate does, in this order: edge count first, then pixel ratio. The render spike found those are the only two levers that matter; particles, glow and territory resolution cost almost nothing and are left alone. Sphere colour and core light are never dropped.
- Ambient motion (particles, pulses, core shimmer) keeps the scene rendering continuously, at a reduced rate when the camera is still and nothing is hovered. Rendering pauses when the tab is hidden.

### 8.6 Visual language: stars, particles, pulses

Everything here is a function of time evaluated in shaders. None of it costs per-sphere or per-edge CPU work per frame.

**Light depends on the mode (§17.5).** In dark mode the stars emit for real: core, corona and particles use additive blending. In light mode additive glow is invisible against a pale background, so emitted light is shown three other ways: a core brighter than the surface, a tinted halo drawn with normal alpha blending, and coloured light cast onto the ground. The layers below are the same in both modes; only the blending changes.

**The sphere as a small star**

A sphere is drawn as a self-lit ball of gas. The first version read as a glossy marble because it borrowed everything from lit objects: a light direction, a shaded rim, a highlight and a crisp silhouette. None of those are used now. The reference is `spikes/render/main.ts`, accepted as the starting point on 2026-11-21.

| Layer | What it looks like | Driven by |
|---|---|---|
| **Body** | The file-type colour, brightest in the middle and deepening toward the edge. No light direction and no highlight. | language |
| **Core** | Not a drawn shape. Brightness rises smoothly toward the centre and goes through an exposure curve, so the centre burns out toward white the way a bright light does in a photograph. Wider and hotter with importance; a slow flicker with its own phase per sphere. | always on; importance |
| **Surface** | Slow, faint turbulence in brightness, shown only when the sphere is large on screen. | zoom |
| **Edge** | No silhouette. The opaque disc is cut slightly inside its radius and the glow begins there at the edge's own brightness, so the edge dissolves into light. | always on |
| **Glow** | A smooth tail of the type colour falling away from the edge. Thin on every star, wide on important ones. | importance (top 10%), selection, hover |
| **Spikes** | Thin, faint four-point diffraction spikes at a fixed tilt, on the top 2–3% only. | importance |
| **Ground light** | Every star lights a small pool on the plane beneath it; important ones light a wide one. | importance |

- **Rejected in the design pass as cartoon-like:** a starburst drawn in the centre, striped rays, expanding rings, and a rim brighter than the body.
- Three instanced draws: opaque bodies with depth; glows with no depth write, additive in dark mode; flat ground-light quads. Bodies sort by centre depth, so no per-pixel depth is written.
- Light mode runs the same shaders with normal blending. It renders correctly but has not had its own tuning pass; dark mode is the tuned default.
- Under an overlay the body takes the overlay colour, the core stays neutral white, and glow and ground light fade out.
- A dimmed sphere (filtered out by the legend) loses its core light and drops to a pale grey body.
- Selected spheres scale ×1.3 and their core, glow and scale breathe together on a ~1.5 s cycle.

**Ambient particles**

- **Stellar wind.** Small motes leave each star's surface, drift outward and upward a few radii, and fade. Each particle is bound to a host sphere chosen in proportion to importance, so important files visibly shed more energy and the smallest files shed almost none. A particle's position is `host position + f(seed, time)`; it follows its host through the same GPU hierarchy.
- **Void dust.** A sparse field of very faint, slow motes through the whole volume, to give depth and parallax when the camera moves.
- One pool, fixed size (`visual.particles.ambient`, default 4,000 at M). Particles fade with distance, so the visible density stays even as the camera zooms. It costs almost nothing to draw, so it is not part of the step-down under load (§8.5); it can be switched off in Settings.

**Interaction particles** (a second small pool; each burst is a spawn time, an origin and a seed)

| Event | Effect |
|---|---|
| **Pointer sweeps past** | A few sparks thrown along the pointer's direction of travel; the sphere wobbles (§7.4). |
| **Single click (select)** | A core flash, a ring of about 40 particles in the type colour expanding outward and settling, and a shockwave ring travelling across the ground. Neighbours touched by the ring wobble. |
| **Double click (open file)** | A nova: a larger burst of about 150 particles, a brief vertical column of light rising from the sphere, and one synchronised pulse sent out along every connection at once, so the file's reach is visible as the sidebar opens. |
| **Reveal** | Each sphere ignites with a small flash as it grows in. |

**Edge pulses**

- A pulse reads as an electrical discharge: a white-hot bead at the head with a short, fast-fading tail in the connection's colour, flickering rapidly as it travels. It runs along the arc **from the file that depends to the file it depends on** (caller → callee, importer → imported).
- A pulse fires, crosses, and then the line rests before firing again, so the scene crackles irregularly instead of scrolling like a conveyor.
- The line is drawn as a thin trace inside a strip three times its width; the spare width carries the glow around a passing pulse. In dark mode both trace and pulse are additive light.
- Pulses move at a constant speed in world units, so longer connections take visibly longer and direction is unambiguous even on a still frame.
- More heavily used connections rest for less time between pulses and carry brighter ones. The trace beneath is constant and clearly visible, not faint.
- Colour runs from the source file's type colour at the start of the arc to the target's at the end.
- Hovered and selected connections get a small flash on the target sphere's core as each pulse arrives. Background edges skip the flash.
- Ribbons between cities and districts carry pulses in both directions at once, in proportion to each direction's traffic.
- A pulse's position is a function of time, the edge's length and a per-edge phase: one time uniform drives every edge, with no per-edge CPU work. The reference is the edge shader in `spikes/render/main.ts`.

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
| "Reset view" pill, or Home key | Fly the camera back to the default framing and return every city and district to its settled position |

- **Picking is on the CPU and hierarchical**: ray vs city circles → district cells → spheres in that district. Positions are already on the main thread via the shared buffer, so there is no GPU readback.
- **Hover connections** come from an adjacency index in the view replica and are written into the focus edge buffer.
- **Search:** fuzzy match over paths in the coordinator worker (`uFuzzy`); selecting a result calls `flyTo`. Files hidden by the size slider stay searchable and reappear when selected.
- **Sidebar reader:** hidden by default, resizable. CodeMirror 6 read-only, lazy-loaded, with a sanitised markdown preview. Reads on demand through a `ContentSource` (§12.1): the working tree for a local repo, the content pack for a demo.

Screen layout:

- **Top bar:** not a solid bar but a top row of floating translucent pills (§17.6): title and repo name, progress, search, the two update actions ("Refined structure ready · Apply", "N files changed · Update") when relevant, the overlay pills, and a settings gear (§17.9).
- **Top left:** selection pills.
- **Top right:** overlay buttons.
- **Bottom left:** controls key (small), with a "Reset view" pill beside it.

**Reset view.** One click undoes everything the user has moved, and nothing else:

- The camera flies to the default framing: the whole map in view, at the default tilt.
- Every city and district eases back to its **home position**, the settled layout from the reveal or from the most recent Apply or Update. Pins left by dragging are cleared, and files ride along with their districts.
- Selection, the active overlay, the file-type filter and the size slider are left as they are.
- The pill is dimmed when the view and layout are already at their defaults.
- **Bottom right:** file-type legend (click to isolate, Shift+click for several) with the **minimum-lines slider**: logarithmic, from 0 to the largest file, starting at `legend.minLinesDefault` (0 = show everything).
- **Bottom centre:** "Tour the repo".

---

## 10. Overlays

All overlays are layers in the model. The history-based ones are computed on the compute pool; Tests and Reach take milliseconds in the analysis worker. History processing starts on idle workers before the reveal, the selected overlay is promoted above remaining parse work, and an overlay can be viewed while still partial (§3.1). The active overlay is shown in the top bar, and importance glow fades while one is active.

| Overlay | Colour | Source | Notes |
|---|---|---|---|
| **Recency** (specified) | bright green → faded grey | history | Falls off fast, so only what changed recently reads as green: brightness halves every two weeks of age (exponential decay) and is all but gone after about three months. Age is measured from the latest change on the map, so a dormant repo or a demo still shows its most recent burst of work. |
| **Ownership** (specified) | bright purple → grey | history | Commit share per author. Contributor picker with fuzzy search, sorted by commits. |
| **Dependency reach** (specified) | hop-count ramp | unit graph | BFS from the selection on demand; toggle "depends on" vs "depended on by" |
| **Knowledge risk** | amber → grey | history | The top author's share of commits to the file. Brightest where one person made nearly all of them. Files with fewer than `overlays.knowledgeRisk.minCommits` commits stay neutral, since a share of two commits means little. |
| **Tests** | three-tone | path patterns + edges | Test files in one colour, source files that a test file imports or calls in a second, and source files no test references highlighted. Test files are recognised by configurable path patterns (`tests/`, `__tests__/`, `*_test.*`, `*.test.*`, `*.spec.*`, `*Test.java`, `test_*.py`). |
| *Later:* Misplaced | highlight | cluster vs directory | Files whose community differs from their folder siblings' |

First release: Recency, Ownership, Reach, Knowledge risk, Tests. Removed from the plan: Hotspots, Cycles and Hidden coupling. A "load-bearing" overlay is not needed: importance is always visible through size and glow.

---

## 11. AI layer

### 11.1 Call structure

- The server is a thin, stateless proxy: `/api/ai/{summaries,pois,tour,detail}`. The browser builds the context from the model; the server validates size, calls the provider, validates the structured result against a schema, and streams it back.
- `AiProvider` interface with an Anthropic adapter (official `@anthropic-ai/sdk`) as the default; other providers are additional adapters behind the same interface.
- **Where the developer configures it:** `config.json → ai.provider`, `ai.models.synthesis`, `ai.models.bulk`; the key in `.env.local` / Vercel project env (`ANTHROPIC_API_KEY`, or the chosen provider's variable). `.env.example` documents it.
- **Model tiers** (decided 2026-11-21): three, chosen per task. The cheapest tier writes the per-city summaries (`claude-haiku-5-5`, or `gpt-6-luna`); a mid tier writes the tour in one call (`claude-sonnet-5-5`, or `gpt-6.1-terra`); the most capable tier selects the points of interest and answers the detail buttons (`claude-opus-5-5`, or `gpt-6.2-astra`). The ids live in `config.json` under `ai.models` and `ai.openaiModels`; the provider is `ai.provider`, or `VITE_AI_PROVIDER` in the environment with the matching key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- **Workflow, not an open-ended agent.** A fixed map-reduce pipeline with structured outputs (`pois[].label` ≤ 3 words, `summary` ≈ 30 words, tour of 3–6 steps of 10–30 words, every item citing `NodeRef`s). The server drops any item whose refs do not exist and retries once on length violations. Refusal stop reasons are handled explicitly.
- **The tour is about architecture and functionality** (decided 2026-11-21). Each step says what that part of the system does and how it fits the whole, so the steps read as a walk through how the repository works. Tour text, city summaries and point-of-interest summaries never state counts or measurements (numbers of links, imports, dependents, files or lines; fan-in or fan-out): the measured structure is for choosing where to go, not for narrating. A point of interest keeps its one structural fact in its separate `evidence` field. The server removes any sentence that breaks this rule.
- **Later option:** a bounded tool-using loop for the detail buttons, with tools (`read_file`, `list_district`, `neighbors`) that execute in the browser, since only the browser has the repo.

Pipeline. **It starts only when the parse has finished** (both passes complete) and consent has been given. If the escape hatch fired, AI waits for the slow pass and never runs on a provisional structure. It does not wait for Apply: its output attaches to files, so it is valid whichever clustering is on screen.

1. **Map:** one bulk-model call per city (parallel) → a short neutral summary of what that city does: its job in the system first, then the main things inside it that do that job (about 30 words, plus a name for the job of at most three words). The summary is shown to the user when the pointer rests on the city's pill (§17.6), and it is also context for the reduce step.
2. **Reduce, two calls in parallel:** POIs and Tour, both given the repo digest plus the city summaries. The shared digest prefix is prompt-cached.
3. **On demand:** POI detail buttons ("Role in the system", "Who uses this", "Key entry points", "Walk me through it") send a focused context: that file's skeleton or content plus its neighbours' signatures.

- **POI count:** about one per city plus a few repo-wide: roughly 7 at 50 files (four cities plus three repo-wide), up to 15 at 10k.
- Results are stored as annotations keyed by a hash of the digest, so a return visit regenerates nothing.

### 11.2 Context design and bias control

The digest is assembled deterministically under a token budget, split by fixed ratio so no source dominates. It is built entirely from what the two parsing passes kept in memory (signatures, doc comments, README and docs excerpts), with no further disk reads (§6.3.2).

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
- **Secrets never leave the machine.** Files matching `ai.excludePaths` (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`, `.npmrc`, `.netrc`, `*.tfvars`, `credentials*`, `secrets.*`) are never read for AI. Every excerpt is also scanned for key-shaped content (private-key headers, common token prefixes, long high-entropy strings), and the whole file is dropped on a hit. This covers the digest and the detail buttons alike; a detail button on a withheld file says so instead of calling the model.
- **Evidence required.** Each POI and tour step cites node refs and one structural fact.
- **Audience instruction.** Reader knows code but not this repo; describe roles and flow, avoid repo-internal jargon.

### 11.3 Shapes

```ts
interface Poi  { id; parent: UnitRef /* a file's sphere; never a district or city */; label: string /* ≤3 words */; summary: string /* ~30 words */;
                 kind: 'entry' | 'core' | 'boundary' | 'data' | 'risk'; evidence: string;
                 details: Record<string, { status: 'idle' | 'loading' | 'ready'; markdown?: string }> }
interface Tour { id; steps: { parent: UnitRef; frame: 'file' | 'district' | 'city'; text: string /* 10–30 words */; highlights: UnitRef[] }[] /* 3–6 */ }
```

- `UnitRef` is the `u:` form of `NodeRef`: one sphere.
- **Points of interest and tour steps always stand on a file.** One about a whole area is attached to the file that best represents it, and its text says what area it speaks for.
- A tour step also carries a `frame`. The camera frames that file alone, or the district or city the file belongs to at that moment, looked up when the step is shown. A step about a city therefore still works after the clustering changes.
- The server rejects any point of interest or tour step whose parent is not a file.

### 11.4 Operational concerns

- **Consent:** AI is the only path by which code excerpts leave the machine. The app asks once per repo, then generates summaries, POIs and the tour automatically; detail buttons call the model on click. `ai.enabled` in config turns the feature off entirely. The prompt says only what it adds ("Adds city summaries, points of interest and a guided tour.") and does not name the provider. **It can be turned off again per repo:** the settings card has an "AI notes" switch for the open map; Off cancels anything in flight and no further AI request is made for that repo until it is switched on, while notes already written stay on the map. **While AI is not enabled for a repo there is always a prompt at the bottom centre to enable it:** the full question the first time, and after "Not now" (or when switched off) a compact "Add AI notes" pill in the same place. If AI is allowed but a run could not write notes, the pill stays as "Write AI notes" so there is always a way to try again.
- **Abuse:** rate limits only. The `/api/ai/*` routes get a per-IP request limit (a Vercel Firewall rule or a small Redis-backed limiter), a hard cap on input tokens per request, and a cap on detail calls per repo digest. A spend limit on the provider account is the backstop. The provider interface leaves room for a passcode or bring-your-own-key later.
- Demo snapshots ship with AI annotations pre-generated, including every point of interest's detail cards, so demo mode needs no key and makes no model calls.

### 11.5 Chat assistant (decided 2026-11-21)

Once AI is enabled for a repo, a **Chat** pill appears at the bottom centre. It opens the right-edge side panel on a **Chat** tab, beside the File tab.

- **Purpose: informational.** The assistant answers questions about the repo for someone who knows code but not this codebase. It cannot change the repo. It follows the same writing rule as the tour: architecture and behaviour, no narrated link counts unless asked.
- **Model:** the mid tier (`ai.models.chat`: `claude-sonnet-5-5`, or `gpt-6.1-terra`).
- **Context when needed.** Each request carries a compact overview of the map (cities with their summaries, sizes, languages), cached as a prompt prefix. Everything else is fetched by the model through tools, so a question about one file does not pay for the whole repo.
- **Tools run in the browser.** The repo exists only in the page, so the model's tool calls come back to the page, which executes them and sends the results with the next request; the server stays a stateless proxy that streams the reply (`POST /api/ai/chat`, server-sent events). An MCP server was considered and set aside: a provider can only call an MCP server it can reach over the network, and there is none to reach. The catalogue uses MCP's tool shape (name, description, input schema), so the same tools could be served over MCP later, for example to let a desktop assistant drive the map.

| Kind | Tools |
|---|---|
| Look things up | `get_repo_overview`, `list_area`, `search_files`, `get_file`, `get_dependencies`, `read_file`, `get_notes`, `get_view_state` |
| Drive the map | `set_overlay`, `select`, `clear_selection`, `focus_on`, `open_file`, `set_filters`, `reset_view` |

- **The map follows the answer.** When an answer points at a file, the view zooms to it: the assistant is told to fly there (or to select and frame a small group), and if it did not, the panel does it from the file paths the answer mentions. One file is selected and framed; several are selected together and framed as a group. The view is left alone when the user moved it themselves in the meantime.
- **What the assistant does is always visible.** Each action on the map is a one-line entry in the transcript ("Turned on the Recency overlay", "Selected 14 files in Rendering"); look-ups show a quiet progress line. File paths in an answer are buttons that select the file and fly to it.
- **Limits.** A bounded number of tool steps per message, a size budget per tool result, the same per-IP rate limit and input cap as the other routes, and a Stop button. The conversation lasts for the visit and is not saved.
- **Consent.** Chat is offered only when AI notes are allowed for the repo. `read_file` sends the lines it reads to the provider; that is covered by the same consent.


---

## 12. Persistence, export, demo

- **Local only.** No accounts and no server-side storage. Sharing a map means sending the exported file.
- **Snapshot:** the gzipped model in the Origin Private File System, one file per repo, written at the reveal and after each later stage (debounced). The layout cache is included.
- **Registry:** IndexedDB records `{ id, name, remoteUrl, directoryHandle, headOid, indexChecksum, schema, lastOpened }`. `name` and `remoteUrl` are what the landing page's repo pills show (§17.7). `navigator.storage.persist()` is requested.
- **Return visit:** the snapshot loads and renders immediately, untouched. Folder permission is requested in the background; if `indexChecksum` differs, the top bar offers "N files changed · Update" (§6.8).
- **Export / import:** from the settings card, in two forms. "Map and files" writes a package, `<name>.starmap.zip`: the map and the text of its files (§12.1). "Map only" writes the `.starmap.json.gz` file, which holds no file contents. Either can be dropped onto the landing page.
- **Demo mode:** Flutter, TensorFlow, React and this app's own repo, each shipped as one package that the app itself exported (§12.1, and `plan/DEMO-MODE.md` for the full design).
- Bumping `schema` or `parserVersion` invalidates snapshots cleanly.

### 12.1 Packages and demo mode: the map plus the real files, no history

A package is one file, `<name>.starmap.zip`, written by the app's own Export button. A demo is a package the app opens from the list in `config.demo.repos`; the same file dropped on the landing page opens as an ordinary import. The full design, with the decisions behind it, is in `plan/DEMO-MODE.md`.

| Entry | Contents |
|---|---|
| `starmap.json` | A small manifest: repo name, source URL, commit, licence, export time, parser version, how complete the AI work is |
| `map.starmap.json.gz` | The model: files, edges, cities, districts, settled layout, overlay layers, AI annotations including every detail card |
| `files/<path>` | The text of the files on the map, at the commit that was parsed, plus the repo's licence and notice files |

**What is in the files**

- Every file that has a sphere and is text. The bytes are the committed blobs, so they match what the parser saw line for line; each is checked against the blob id the map recorded, when written and again when read.
- The repo's `LICENSE` and `NOTICE` files, always, since permissive licences require the notice to travel with the code.
- Not included: the `.git` directory and any commit history, binary files, files over `parser.maxFileBytes`.
- **Trimming.** A package has a size budget (`demo.package.maxBytes`) and an optional line floor (`demo.package.minLines`). Files are written most important first; what does not fit is left out. A trimmed file keeps its sphere, and the sidebar says "This file is not included in the demo." when it is opened.

**Loading: the map first, then the files as one download**

- The package is fetched with one request. Its first two entries are the manifest and the map, so the map is on screen after the first few megabytes; the rest of the same response is the files, which go on arriving in the background. A file opened before they are all in waits, with a "Downloading the demo's files" line.
- The whole package is kept in the browser's cache, so reopening is instant and works offline. A rebuilt package (a different validator from the host) replaces the cached one.
- **Not one static asset per source file.** Serving a demo repo's `.html` and `.js` files from the app's origin would let a link execute that repo's code with access to the origin's storage, which holds the user's own saved repos. Inside a zip, repo content is never a navigable document.

**No history, but the history overlays still work** (decided)

- Recency, Ownership and Knowledge risk are stored in the map as finished per-file values. Those are aggregates; no commits, trees or diffs are shipped.
- Contributor email addresses are stripped from every exported package. Names are kept so the Ownership picker works.
- Unavailable in a demo, and hidden rather than shown disabled: blame for one file, "N files changed · Update", the working-tree check.
- A demo makes no model calls: its summaries, points of interest, tour and detail cards are in the package.

**A demo never blocks the same repo opened locally.** A demo's id is `demo:<name>`, taken from the demo list and never from the repo it is of, so it shares no saved map, registry record or AI consent with a local clone. The landing page lists both, each as its own pill; the demo's carries a "Demo" tag, as does the title pill of an open demo.

**One way to read a file, three sources**

```ts
interface ContentSource { read(file: NodeRef): Promise<Uint8Array> }
// DirectorySource  — the user's working tree (sidebar, AI detail buttons)
// PackSource       — git packfile blobs (the parser, §6.3.1)
// PackageContent   — a package's files (a demo, or a dropped package)
```

The sidebar and the AI detail buttons ask a `ContentSource` and never know which one they have.

**Making a demo**

1. Open the repo's folder in the app, at the commit the demo should show; apply the refined structure and load the full history if offered.
2. Allow AI and let the summaries, points of interest and tour finish.
3. Settings → Export → "Map and files". The export writes the remaining detail cards, packs the files and saves the package, and prints the line to add to `config.demo.repos`.
4. Put the file in `public/demo/`.

`scripts/build-demo.ts` runs the same pipeline and the same writer in Node, without the AI step: for test fixtures, and as the fallback for a repo too large to export from a tab.

The demo shows its source, commit and licence in the repo info card opened from the title pill.

---

## 13. `config.json`

One file, typed and validated at build, imported by client and server. Secrets are excluded by design. A dev-only tuning panel can override physics and visual values live.

```jsonc
{
  "app":        { "title": "Starmap" },
  "settings":   { "appearance": "dark", "particles": true },
  "theme":      { "fonts": { "ui": "Jost", "code": "Commit Mono" },
                  "dark":  { "void": "#1C1C1C", "dustCool": "#4B5158", "dustWarm": "#6B5A4C", "text": "#EDEFF2", "halo": "#9FD8FF", "warm": "#FFD9A0", "sidebar": "#141414" },
                  "light": { "void": "#F6F8FC", "dustCool": "#D3DAE3", "dustWarm": "#F3DCC6", "text": "#1E2126", "halo": "#2A6FDB", "warm": "#E8A23A", "sidebar": "#FFFFFF" },
                  "pill":  { "opacity": 0.6, "borderOpacity": 0.14, "blurPx": 10, "cardRadiusPx": 20 },
                  "wisps": { "contrast": 0.25, "driftSpeed": 0.02, "parallax": 0.05, "stars": true } },
  "scheduler":  { "workerShare": 0.5, "maxWorkers": 14, "memoryCapMB": 2048, "taskTargetMs": 40, "parseFloorWorkers": 1,
                  "historyChunkCommits": 200, "parkWhenFrameMsOver": 20 },
  "parser":     { "source": "pack", "packChunkBytes": 1048576,
                  "batchBytes": 2097152, "maxFileBytes": 1048576, "retainBytes": 268435456,
                  "exclude": ["**/vendor/**", "**/*.min.js"], "includeUntracked": false, "workingTreeCheck": true,
                  "bridges": ["jni", "protobuf"] },
  "reveal":     { "maxWaitSeconds": 30, "perFileTimeoutMs": 2000, "settleMaxMs": 3000, "growMs": 2000 },
  "history":    { "maxCommits": 50000, "timeBudgetSeconds": 20, "merges": "skip", "pageBytes": 262144, "objectCacheBytes": 33554432 },
  "clustering": { "citiesPerDecade": 3.5, "cityOffset": -2.2, "minCities": 1, "maxCities": 20,
                  "districtsPerDecade": 3.5, "districtOffset": -2.2, "minDistrictSize": 5,
                  "sizeBias": 0.5, "districtSizeBias": 1, "splitModularity": 0.3, "mergeCoupling": 0.4, "countSlack": 1.5, "districtCountSlack": 2.5,
                  "resolution": 1.0, "seed": 1, "directoryAffinity": 0.3, "pathBias": 0, "mergePathBias": 0, "hubDamping": true },
  "physics":    { "sliceMs": 8, "reheat": 0.3, "velocityDecay": 0.6, "settleTicks": 150,
                  "city":     { "gap": 40, "linkStrength": 0.5, "charge": -60, "gravity": 0.02 },
                  "district": { "pad": 6, "linkStrength": 0.6, "externalPull": 0.15, "lloyd": 0.1 },
                  "file":     { "pad": 0.5, "sizeVsConnectivity": 0.5, "baseStrength": 0.1 } },
  "visual":     { "radiusMin": 0.8, "radiusMax": 12, "sizeScale": 0.8, "importanceBoost": 0.5, "importanceCurve": 2,
                  "glowFromPct": 0.9, "selectedScale": 1.3, "languageColors": { "ts": "#3178c6" }, "grid": {}, "background": {},
                  "star":      { "coreGain": [2.4, 5.0], "coreTightness": [13, 8], "limbDarkening": 0.62, "flicker": 0.07, "glowFalloff": [8, 2.2], "spikesFromPct": 0.975, "breatheMs": 1500 },
                  "particles": { "ambient": 4000, "voidDustShare": 0.2, "selectBurst": 40, "openBurst": 150 },
                  "edgePulse": { "speed": 120, "tailLength": 30, "restSeconds": [0.5, 2.4], "flickerHz": 10, "traceOpacity": 0.16 } },
  "legend":     { "minLinesDefault": 0 },
  "demo":       { "repos": [ { "name": "demo-small", "path": "/demo/demo-small/" }, { "name": "demo-medium", "path": "/demo/demo-medium/" } ] },
  "render":     { "ambientEdges": 1500, "edgeBudget": 50000, "maxPills": 150, "patchBudgetMs": 4, "adaptiveDpr": true },
  "interaction":{ "jiggleMax": 0.35, "jiggleSettleMs": 800, "hoverDelayMs": 80 },
  "camera":     { "minDistance": 10, "maxDistance": 5000, "flyMs": 900 },
  "overlays":   { "enabled": ["recency", "ownership", "reach", "knowledgeRisk", "tests"],
                  "knowledgeRisk": { "minCommits": 3 },
                  "tests": { "patterns": ["**/tests/**", "**/__tests__/**", "**/*_test.*", "**/*.test.*", "**/*.spec.*", "**/*Test.java", "**/test_*.py"] } },
  "ai":         { "enabled": true, "provider": "anthropic",
                  "models": { "synthesis": "claude-opus-5-5", "bulk": "claude-haiku-5-5" },
                  "excludePaths": [".env*", "*.pem", "*.key", "id_rsa*", "*.p12", "*.pfx", ".npmrc", ".netrc", "*.tfvars", "credentials*", "secrets.*"], "scanForSecrets": true,
                  "digestTokens": 60000, "budgetSplit": { "structure": 0.35, "skeletons": 0.35, "docs": 0.30 },
                  "pois": { "perCity": 1, "repoWide": 3, "max": 15 }, "tour": { "minSteps": 3, "maxSteps": 6 } }
}
```

---

## 14. Performance targets and how each is met

Targets are goals. M0 measured several of them on one desktop machine (§15); none has been checked in a browser on modest hardware.

| Target | Mechanism |
|---|---|
| Reveal within 30 s at M, showing the final structure in most cases | Manifest from `.git/index`; both passes across the worker pool; per-file time cap; escape hatch |
| No main-thread task > 50 ms during parse | All compute in workers; the waiting screen draws only progress |
| Nothing moves after the reveal unless the user asks | Stable-point gate; frozen map in the escape-hatch case; explicit Apply / Update actions |
| 60 fps at S and M; usable at L with reduced detail | Instanced impostors; GPU-composed hierarchy; edge level-of-detail and budget; adaptive pixel ratio |
| Dragging a city costs O(1) uploads | One texel in the city transform texture |
| Size slider and overlay switch respond in one frame | One uniform; one attribute upload |
| Idle compute near zero | All sims asleep and all workers idle after settle; territory texture re-rendered only while hot. The renderer still draws ambient motion, at a reduced rate (§8.5). |
| Return visit interactive < 1 s (M) | OPFS snapshot with cached layout |
| Update after a pull proportional to the diff | Per-file cache keyed by blob OID |

---

## 15. Milestones

**M0 — Spikes. Done** (2026-11-21; results in [M0-RESULTS.md](M0-RESULTS.md)).

| Spike | Result |
|---|---|
| Fast pass | Pass: 0.8–3.0 s for 4.6k–21k code files across workers, in TypeScript |
| tree-sitter slow pass | Pass on the test machine: 2.3–12.7 s; a 4-core laptop is projected, not measured |
| Git history | Pass in Node: output matches `git log` on four repos |
| Render | Pass on a discrete GPU at 10k; integrated graphics untested |
| Physics | Pass with the spatial-hash collide (0.7 s at 10k); stock d3 collide misses the budget |
| Pack-first reads (added) | 5–10× faster than opening files, in Node (§6.3.1) |

No part needs Rust or WASM at S and M. Still unmeasured: the browser read paths (they need a person to pick a folder: `spikes/fsa` and `spikes/git/browser/frs-bench.html`), integrated graphics, a 4-core laptop, a real 100k-file repo, and the Vercel headers.

The build order, work packages and test policy for M1–M6 are in [IMPLEMENTATION.md](IMPLEMENTATION.md). The summaries below say what each milestone delivers.

**M1 — Skeleton.** Model + patches + store; theme tokens for both modes and the wisp background; landing page and folder validation; manifest; fast pass for TS/JS, Python, C/C++; waiting screen; importance; instanced spheres sized and glowing by it; city-tier sim; reveal.

**M2 — Hierarchy and physics. First showable version.** graphology Louvain with dendrogram levels and the city/district counts; slow pass for the three languages; symbol linking and header pairing; district and file tiers; Voronoi territories; pre-reveal settle; pills and dragging; camera controls; hover, selection, marquee; jiggle; ribbons and edge level-of-detail; legend with type filter and minimum-lines slider. No history, AI or saved repos yet.

**M3 — Parser breadth and persistence.** Remaining languages, including Scala, PHP, Ruby, Vue/Svelte/Astro components, CSS/SCSS and HTML; JNI and Protobuf bridges; OPFS snapshots; "N files changed · Update"; export/import; the `ContentSource` interface; the sidebar reader; the demo build script and demo mode with two repos, including a check that range requests work on the host.

**M4 — History and overlays.** Pack walker as chunked pool tasks; priority lanes and overlay promotion (§3.1); partial-overlay display; Recency, Ownership, Reach, Knowledge risk, Tests; search.

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
| Reading files | Pack first across every pack, then loose objects read as git objects. The working tree is a last resort and is hash-checked before its results are cached. The reveal shows the staged/committed state; on-disk edits are found by a background check that re-hashes on a mismatch, and applied through "N files changed · Update" (§6.3.1). |
| Call-edge accuracy | Name-based with stored confidence; architecture-grade, not compiler-exact. |
| Languages | The original 13 plus Scala, PHP, Ruby, Vue/Svelte/Astro components, CSS/SCSS and HTML. Schema languages, build files, shell and others are not parsed. |
| Cross-language boundaries | High-confidence only: JNI in both directions and Protobuf stubs matched by name. Weaker mechanisms deferred (§6.4.1). |
| Louvain | `graphology-communities-louvain`; python-louvain as behavioural reference; port only if blocked. |
| City count | `round(3.5·log10(files) − 2.2)`: 4 at 50, 8 at 1k, 12 at 10k. Districts use the same curve per city, minimum 5 files. |
| Physics | Three tiers; nodes interact only with siblings. |
| Height | All spheres rest on the plane. Height is sphere size. |
| Sphere size | Set by lines of code (volume-proportional). Importance enlarges it by up to 50%, on a curve that favours the most important files. |
| Importance | PageRank over the dependency graph, as a percentile across the repo. |
| Glow | By importance alone; about the top 10% of files glow (from the 90th percentile). Fades under overlays. |
| Sphere look | Small stars: file-type colour dominates, lit core on every sphere, corona and ground light by importance. Ambient stellar-wind particles; bursts on single and double click (§8.6). |
| Edges | Stored in full; ribbons when zoomed out (one band per pair, two-way pulses); spheres always individual at S and M. Pulses of energy travel from the dependent file to the file it depends on. |
| When the map appears | At the stable point (both passes, clustered, settled), or after 30 s with imports plus partial call edges. Waiting screen is the wisp background with a progress pill, no grid. |
| Visual language | "Cosmic void": dust-wisp background, light and dark modes, Jost throughout, translucent floating pills, opaque sidebar (§17). Dark background is neutral gray; no purple in background or chrome, purple allowed inside the visualization. |
| Landing page | Title, one "Choose a folder" button, and pills for saved and demo repos showing name and origin remote. Nothing else. |
| App title | "Starmap" for now, set by `app.title` in config. |
| Settings | Gear pill in the top row: appearance (dark by default) and particles to start, more to be defined (§17.9). |
| Reset view | A pill beside the bottom-left controls key returns the camera to the default framing and cities and districts to their settled positions. Selection, overlay and filters are kept. |
| After the reveal | Nothing moves unless asked: "Refined structure ready · Apply" and "N files changed · Update". |
| Legend | Minimum-lines slider; hides without changing layout; glowing files exempt. |
| Overlays, first release | Recency, Ownership (commit share), Reach, Knowledge risk, Tests. Hotspots, Cycles and Hidden coupling removed. |
| Compute scheduling | One shared pool with priority lanes: interactive, selected overlay, parse, other overlays, housekeeping. Idle workers always take lower-lane work; parse keeps a one-worker floor (§3.1). |
| AI | Ask once per repo, then automatic, starting only when the parse has finished. Points of interest and tour steps attach to a file, never to a district or city. Secret files and key-shaped content are never sent. Opus 5.5 for synthesis, Haiku 5.5 for bulk. 35/35/30 context split. About one POI per city plus a few. Rate limits only. |
| Clustering stability | The provisional clustering shown when the escape hatch fires may change once the connection pass completes; that is accepted. After the first complete pass it is stable: Update places changed files into existing cities. |
| Storage | Local to the browser; no accounts; share by exported file. |
| Demo | M3, two permissively licensed repos (~200 and ~5,000 files). Each ships a snapshot plus a zip of the actual files, read one entry at a time; no git history is included. Recency, Ownership and Knowledge risk still work from precomputed per-file values, with contributor emails stripped (§12.1). |

### Risks

- **Pack reading in the browser is unmeasured.** The 5–10× gain is from Node. If `FileReaderSync` slice reads carry a high per-call cost, larger chunks are the lever; if the gain disappears, the working-tree path remains.
- **The wait before the reveal.** If the slow pass regularly exceeds 30 s at M, most users see a provisional structure first and have to press Apply. The spike measured 2.3–12.7 s on an 8-core desktop and projects about 21 s for a Dart-heavy 10k-file repo on a 4-core laptop, so slower machines are close to the limit. The levers are the time cap and the per-language cost of tree-sitter.
- **Provisional structure** is weak for Java, Kotlin, C#, Go and Swift, which is exactly when the escape hatch matters most. The map is labelled as provisional in that state.
- **Git history is proven in Node, not yet in a browser.** The walker's output matches `git log` on four repos, but it has not run end to end in a browser on a disk-backed pack, where each read is a cross-process call. If that cost is high, the levers are page size and the commit cap.
- **Symbol linking accuracy** varies by language (weakest: C#, Swift, macro-heavy C++). Confidence is stored per edge so weak links are discounted.
- **Library dependence for Louvain.** The dendrogram's per-level format is undocumented; if it cannot give nested levels cleanly, districts fall back to per-city runs, and a port is the last resort.
- **tree-sitter quality, not size.** All 14 grammars are 1.4 MB compressed, so payload is not a concern. Syntax errors are: 29% of tensorflow's C++ files, 16% of flutter's Dart and 24% of react's Flow-typed JS had parse errors in the spike, which will cost call edges in those languages.

---

## 17. Visual language: cosmic void

The product is a star map of a codebase. The one loud thing on screen is the stars. Background, chrome and type stay quiet so the data carries the image.

### 17.1 Principles

1. **The void is the page.** One procedural background of galactic dust wisps runs unbroken behind the landing page, the waiting screen and the map. Moving between them never cuts to a different surface.
2. **Chrome floats.** Interface elements are translucent pills and rounded cards laid over the visualization, never bars or docked panels. The single exception is the sidebar reader, which is opaque because it holds code.
3. **Two temperatures.** Cool tones are structure (void, dust, text). Warm light is attention (selection, importance glow, the tour). Nothing else is warm.
4. **Sentence case, plain verbs.** No all-caps labels, no decorative separators. A button says what it does: "Choose a folder", "Update", "Apply".
5. **Motion answers the user.** The only ambient motion is the scene's own (wisps, particles, pulses). Chrome moves only in response to an action, and everything respects `prefers-reduced-motion`.

### 17.2 Type

- **Jost** for all interface text. It is a geometric sans in the Futura lineage, the letterform of mid-century star charts and the Apollo plaques, and its light weights read as airy without being thin.
  - Title: Light (300), large, widely tracked.
  - Pills and labels: Regular (400), 12–13 px, slightly open tracking.
  - Emphasis (repo names, selected state, counts): Medium (500).
- **Commit Mono** only where text is code: the sidebar reader and code excerpts in AI detail cards. File paths in pills and tooltips stay in Jost.
- Fonts are self-hosted `woff2` (the cross-origin isolation in §3 rules out third-party font hosts).
- *To check in M1:* Jost's small x-height at 11–12 px on a translucent pill. If it is not comfortably legible, Figtree takes over text below 13 px and Jost keeps titles and map labels.

### 17.3 Colour

Both modes are fully supported. Dark is the default, and the mode can be changed in Settings (§17.9).

| Role | Dark, "deep field" | Light, "day nebula" |
|---|---|---|
| **Void** (background base) | `#1C1C1C` neutral charcoal gray | `#F6F8FC` cool white |
| **Cool dust** (wisps) | `#4B5158` steel gray | `#D3DAE3` pale blue-gray |
| **Warm dust** (wisps) | `#6B5A4C` warm taupe | `#F3DCC6` pale peach |
| **Starlight / Ink** (text) | `#EDEFF2` | `#1E2126` neutral charcoal |
| **Halo** (focus, links, active state) | `#9FD8FF` pale sky blue | `#2A6FDB` clear blue |
| **Warm light** (selection, tour, importance) | `#FFD9A0` | `#E8A23A` |
| **Sidebar surface** (opaque) | `#141414` | `#FFFFFF` |

- **No purple in the background or the chrome.** The void, the wisps, text, borders and focus states are neutral grays with blue and warm accents only. Indigo and violet tints are avoided there. Purple remains available inside the visualization: as a file-type colour and as the Ownership overlay's ramp.

- **File-type colours** are defined once per language as a hue and chroma, with lightness set per mode so spheres stay saturated on either background (lighter on dark, deeper on light).
- **Overlay ramps** keep their specified bright ends (green for Recency, purple for Ownership, amber for Knowledge risk). The faded end is the mode's cool dust colour, so "old" or "not yours" recedes into the background in both modes.
- All tokens live under `theme` in `config.json` and are emitted as CSS custom properties and shader uniforms from the same source.

### 17.4 The background

- A full-screen procedural shader: domain-warped noise in two layers, cool dust and a sparser warm layer, at low contrast so it never competes with the spheres. Dark mode adds a sparse field of fixed star points; light mode has none.
- It drifts very slowly and has slight parallax against camera movement, which is what gives the void depth.
- Rendered at quarter resolution and upscaled. The landing page and waiting screen use the same shader on a small canvas of their own.
- Reduced motion, or no WebGL: a static render of the same wisps.

### 17.5 The scene in each mode

| Element | Dark | Light |
|---|---|---|
| **Sphere light** (§8.6) | True emission: core, corona and particles use additive blending, with bloom | Additive light is invisible on a pale background, so: a core brighter than the body, a tinted halo with normal blending, coloured light on the ground |
| **City and district territories** (§8.2) | Soft pools of light and luminous contour lines | Soft shadows and tinted fills with contour lines |
| **Ground grid** | Starlight at very low opacity | Ink at very low opacity |
| **Edge pulses** | Bright packets on a faint trace, additive | Saturated packets on a faint ink trace |

The territory texture and every shader are the same in both modes; only blend mode and token values change.

### 17.6 Chrome

Shape: fully rounded pills for single-line elements, 20 px radius for multi-line cards. A one-pixel hairline border in the text colour at low opacity. No drop shadows; in dark mode active elements get a faint halo instead.

Material: the void colour (dark) or white (light) at 55–70% opacity. Text on any pill must reach 4.5:1 contrast against the worst-case backdrop, which sets the minimum opacity.

- **Backdrop blur is rationed.** Blurring behind an element over a canvas that redraws every frame is paid per element per frame. Only the fixed chrome (about ten elements) gets `backdrop-filter`, at a small radius. In-scene pills for cities, districts and points of interest (up to 150) use a flat translucent fill. Blur is dropped under load together with the steps in §8.5.

What was called the "top bar" elsewhere in this plan is a top row of separate floating pills:

| Position | Element |
|---|---|
| Top left | Title pill: the app title in Light and the repo name in Medium. Below it, selection pills. |
| Top centre | Search pill. Beside it, one progress pill: a segment per subsystem and a thin overall line along its lower edge. Action pills appear here when relevant, as a message with a button segment ("Refined structure ready" + "Apply"; "3 files changed" + "Update"). |
| Top right | One pill per overlay; the active one is more opaque with a halo ring and, while partial, a progress ring. A round settings pill (gear icon) sits at the end (§17.9). |
| Bottom left | Controls key: one tiny pill that expands on hover. Beside it, a "Reset view" pill (§9). |
| Bottom centre | "Tour the repo" pill; tour steps are a translucent card in the same place. |
| Bottom right | File-type legend: a translucent card holding the type rows and the minimum-lines slider. |
| In scene | City pills (name and file count), smaller district pills, point-of-interest pills; tooltips and the detail card are translucent cards anchored to their sphere. Resting the pointer on a city pill (or focusing it) shows the AI summary of what that city does in a small card under the pill; with no summary there is no card. Selecting the city (clicking its pill) keeps its summary up until the city is deselected; hovering another city pill meanwhile shows that one. |
| Right edge | Sidebar reader: opaque, resizable, hidden until a file is opened. |

### 17.7 Landing page

```
┌────────────────────────────────────────────────────────┐
│                                                        │
│                  (wisps, full bleed)                   │
│                                                        │
│                        Starmap                          │
│                                                        │
│                  (  Choose a folder  )                 │
│                                                        │
│      ( react  github.com/facebook/react )              │
│      ( starmap  local folder )   ( demo-small  Demo )   │
│                                                        │
└────────────────────────────────────────────────────────┘
```

- Centred. The title, one button, and below it the repo pills. Nothing else: no navigation, tagline, footer or settings.
- **The whole page is the drop target.** Dragging a folder over it brightens the wisps slightly; there is no drop-zone box.
- **Repo pills** list saved repos by most recently opened, then demos. Each shows the repo name and its location, and clicking one opens it.
- **The title** comes from `app.title` in `config.json` (default "Starmap") and is also the document title and the title pill in the map view.
- Messages appear only when needed, as one quiet line under the button: an unsupported browser, or a folder that could not be read.

**A constraint on "path".** Browsers do not reveal the absolute path of a folder the user picks; the page receives only the folder's name. The pill therefore shows the origin remote read from `.git/config` (for example `github.com/facebook/react`), which also tells two same-named clones apart. A repo with no remote shows "local folder", and a demo shows "Demo".

### 17.8 Waiting screen

The same wisps, no grid, and a single centred progress pill naming the current stage. The reveal grows the map in over the background that is already there.

### 17.9 Settings

The gear pill at the end of the top row opens a translucent card anchored beneath it. It holds viewer preferences, not project configuration.

| Setting | Values | Default |
|---|---|---|
| Appearance | Dark, Light, System | Dark |
| Particles | On, Off (ambient and click particles) | On |
| *Further settings* | To be defined | — |

- Each setting's default comes from `settings` in `config.json`; the viewer's choice is saved in the browser and applies to every repo.
- Changes take effect immediately, with no confirm step. Appearance swaps theme tokens and shader uniforms without rebuilding the scene.
- Turning particles off is separate from the automatic step-down under load (§8.5): one is a preference, the other protects frame rate.
- The landing page has no settings control; it follows the saved appearance, which is dark on a first visit.
