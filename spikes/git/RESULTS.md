# M0 spike 3: pure-TypeScript git history walker

**Question.** Can a TypeScript git walker compute per-file history facts fast enough in a browser worker? It may not use the git binary or isomorphic-git, and it reads packs by random access.

**Answer.** Yes. Its output matched `git` exactly on every path in all four repos. On Node it walks the full histories of react (21.8k commits) in 2.5 s, flutter (92.7k) in 8.8 s and tensorflow (204k) in 52 s. In a browser the estimate is about 1.1× to 1.4× those times, because each `FileReaderSync` call costs 0.25–1.7 ms. Recency is useful after a few hundred milliseconds. TypeScript is good enough here, so no WASM is needed. The costs that matter are memory and the browser's per-call I/O cost.

## Code (all in `spikes/git/`)

| File | Role |
|---|---|
| `core/fs.ts` | `GitFs` interface: sync `readAt(path, off, len)`, `size`, `list`. `PagedFile` is a page cache over packs, so the number of underlying `readAt` calls stays small. |
| `core/odb.ts` | `.idx` v2 parsing (fanout, OIDs, 32/64-bit offsets, sorted offsets → object extents), pack object reading, OFS_DELTA/REF_DELTA with iterative delta application, loose objects, two-generation byte-budget cache of resolved objects. Uses fflate `unzlibSync` with a preallocated `out`. |
| `core/history.ts` | HEAD → loose ref / packed-refs → commit. Commit parsing. Max-heap walk by committer time over all parents, each commit once. First-parent tree diff that descends only into differing subtrees and never reads blobs. Aggregates per file. |
| `node-fs.ts` | Node `GitFs` (`fs.openSync`/`fs.readSync`), standing in for `FileReaderSync` on `File.slice`. |
| `bench.ts` | Runner; writes `out/<label>.json`. `npx tsx git/bench.ts <repo> [--cache-mb N] [--page-kb K --max-pages P] [--max-commits N] [--time-limit-s S] [--no-cochange] [--no-profile] [--dump f.json]` |
| `verify.ts` | Compares a `--dump` against `git log` (see Correctness). |
| `browser/frs-bench.html` | Worker microbenchmark of the per-call cost of `FileReaderSync`. |

The core (`core/*.ts`) type-checks with `--lib es2022,webworker` and no Node types. It uses only Uint8Array/DataView, `TextDecoder`, `performance.now` and fflate. Node is touched only by the guarded `globalThis.process` memory sampling.

Per-file output: commit count, last-modified (max author time), first-seen (min author time), and commits per author email. Co-change pair counts are kept for commits touching 2–50 files. Commits touching more than 50 files are counted as skipped.

## Correctness

**Semantics chosen.** The walk covers every commit reachable from HEAD, each once. Each commit is diffed against its **first parent**, and a root commit against the empty tree. There is no rename detection and no path-limited history simplification. A deletion counts as a touch. Mode-only changes count. Gitlinks (submodules) count as files. Timestamps are author time.

**Reference command** (`verify.ts`) has exactly those semantics. Per-path aggregates are computed from its output:

```
git -c core.quotepath=off log --no-renames --diff-merges=first-parent --name-only --format=%x01%H%x09%at%x09%ae HEAD
```

Plain `git log -- <path>` is **not** comparable. It applies history simplification, and by default it shows no diff for merges, so it drops merge commits whose first-parent diff touches the file. `--first-parent -- <path>` is also different, because it only walks the mainline. The sample table below shows both diverging.

| Repo | Commits (git / walker) | Paths ever touched | Paths only in one side | Count mismatches | Last-modified mismatches | First-seen mismatches | Per-author mismatches |
|---|---|---|---|---|---|---|---|
| GitViz (loose objects) | 47 / 47 | 147 | 0 | 0 | 0 | 0 | 0 |
| react (2 packs) | 21,800 / 21,800 | 26,713 | 0 | 0 | 0 | 0 | 0 |
| flutter | 92,682 / 92,682 | 32,656 | 0 | 0 | 0 | 0 | 0 |
| tensorflow | 204,106 / 204,106 | 86,553 | 0 | 0 | 0 | 0 | 0 |

**Every path matched exactly**, not just a sample. The comparison was re-run after each optimisation.

On tensorflow, 4 paths were C-quoted by git even with `quotepath=off` (control or special characters). `verify.ts` decodes them with `JSON.parse`, and they matched.

Twenty sampled HEAD files from react (`out/react.verify.txt`):

| file | walker | ref cmd | plain `git log -- f` | `--first-parent -- f` | walker last | plain last |
|---|---|---|---|---|---|---|
| `…/const-propagation-phi-nodes.expect.md` | 5 | 5 | 4 | 2 | 2024-07-18 | 2024-07-18 |
| `…/hoisting-repro-variable-used-in-assignment.expect.md` | 7 | 7 | 6 | 4 | 2025-12-11 | 2025-12-11 |
| `…/profilingCache-test.js` | 50 | 50 | 46 | 44 | 2026-10-12 | 2026-10-12 |
| `…/fb-sources-extended/ComponentWithNestedHooks.js` | 3 | 3 | 2 | 2 | **2024-05-15** | 2022-10-18 |
| `packages/react-dom-bindings/src/shared/ReactDOMInvalidARIAHook.js` | 6 | 6 | 5 | 5 | **2024-05-15** | 2024-03-03 |
| `packages/react-reconciler/src/ReactFiberCompleteWork.js` | 204 | 204 | 201 | 201 | 2026-10-07 | 2026-10-07 |
| `…/ReactFlightWebpackNodeLoader.js` | 23 | 23 | 22 | 22 | 2026-06-05 | 2026-06-05 |
| `scripts/bench/benchmarks/hacker-news/grayarrow.gif` | 2 | 2 | 1 | 1 | **2024-05-15** | 2017-05-09 |
| (12 more, all equal across columns) | | | | | | |

**Semantic caveat for the product.** Under "every commit vs first parent", a merge is credited with everything its side branch brought in. Those changes are therefore counted twice: once on the side-branch commits and once on the merge. The merge date also wins for last-modified. The bold 2024-05-15 rows come from one react merge that touched old files. Choosing which semantics the overlays use is a product decision, and the walker can do any of these with a one-line change:

- skip the diff for merges: `git log --no-merges`-like, the best "who touched it";
- walk first-parent only: mainline recency;
- keep the current behaviour.

## Performance (Node 24, Windows 11, local SSD; final code = "v3")

### Full walks

| Repo | Pack | Objects | Commits | Total walk | Commits/s | Open (idx load) | Trees read (per commit) | Tree bytes scanned | Peak RSS | Peak JS heap | Peak ArrayBuffers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| GitViz | loose | 848 | 47 | 0.47 s | 100 | 24 ms | 598 (12.7) | 0.2 MB | 103 MB | 8 MB | 35 MB |
| react | 139 MB, 2 packs | 267k | 21,800 | **2.48 s** | 8,800 | 33 ms | 286k (13.1) | 465 MB | 436 MB | 116 MB | 147 MB |
| flutter | 455 MB | 1.17M | 92,682 | **8.8 s** | 10,500 | 151 ms | 1.38M (14.9) | 1.1 GB | 562 MB | 180 MB | 189 MB |
| tensorflow | 1.41 GB | 2.31M | 204,106 | **52.2 s** (done, no time cap hit) | 3,900 | 314 ms | 4.26M (20.9) | 10.2 GB | 869 MB | 420 MB | 247 MB |
| (reference) native `git log` with the same output, run on the same machine | | | | react 1.4 s · flutter 5.1 s · tensorflow 28 s | | | | | | | |

- The TS walker is about 1.7× to 1.9× slower than native git doing the same work. Neither side has a commit-graph file.
- RSS includes about 100 MB of Node/tsx baseline. GitViz is slow per commit only because each loose object is a separate Windows file open (313 ms of the 467 ms is I/O). In absolute terms it is irrelevant.
- The tensorflow run was started in the background with a 600 s cap and finished in 52–71 s depending on version, so no partial-progress report was needed.

### Time to first useful recency

"Coverage" is the fraction of files in the HEAD tree that already have a last-modified time after the newest N commits (newest by committer time). Times are from the start of the walk; open/idx load adds 33–314 ms.

| Commits walked | react: time, coverage | flutter: time, coverage | tensorflow: time, coverage |
|---|---|---|---|
| 100 | 94 ms, 6.7% | 108 ms, 2.6% | 188 ms, 1.3% |
| 500 | 209 ms, 27.8% | 172 ms, 8.3% | 311 ms, 5.9% |
| 1,000 | 320 ms, 41.5% | 269 ms, 15.2% | 401 ms, 8.7% |
| 2,000 | 524 ms, 54.9% | 414 ms, 33.3% | 651 ms, 15.2% |
| 5,000 | 1.13 s, 100%¹ | 852 ms, 47.1% | 1.62 s, 34.9% |
| 10,000 | 1.72 s, 100% | 1.61 s, 66.8% | 3.23 s, 44.0% |
| 20,000 | 2.40 s, 100% | 2.72 s, 87.8% | 5.11 s, 49.8% |
| 50,000 | n/a | 5.30 s, 93.3% | 12.1 s, 83.6% |
| 100,000 | n/a | n/a | 25.3 s, 86.0% |
| 200,000 | n/a | n/a | 51.7 s, 99.9% |

¹ A repo-wide change between commits 2k and 5k touched every file.

Coverage is low early because many files really have not changed in years; that is not a walker weakness. After N commits, any file without a time is "older than the oldest commit walked so far". The Recency overlay can render that as a lower bound (fully grey) straight away. So recency is useful after about 0.5 s even on tensorflow. Ownership and Hotspots over a partial walk mean "in the last N commits", and the UI should say so.

### Where the time goes

Leaf timers were measured inside the walk (`--no-profile` costs about 3% less). The CPU profile figures are from `node --cpu-prof`.

| | react | flutter | tensorflow |
|---|---|---|---|
| Walk total | 2.48 s | 8.8 s | 52.2 s |
| zlib inflate (fflate) | 0.57 s (23%) | 2.44 s (28%) | 12.95 s (25%) |
| delta apply | 0.22 s (9%) | 0.89 s (10%) | 6.44 s (12%) |
| I/O (`readAt`, 64 KB pages) | 0.06 s (3%) | 0.48 s (5%) | 3.86 s (7%) |
| idx binary search (oid → offset) | 0.14 s (6%) | 0.65 s (7%) | 2.61 s (5%) |
| Remainder: tree parse + merge-walk, path interning, aggregation maps, GC | ~1.5 s (60%) | ~4.3 s (49%) | ~26 s (50%) |
| CPU profile, tensorflow (v2) | | | `diff` 28%, GC 21%, `pathId` 9% (fixed in v3), inflate 10%, `run` (aggregation) 8%, delta 5% |

| Cache / delta stats | react | flutter | tensorflow |
|---|---|---|---|
| Object reads (commits + trees) | 308k | 1.47M | 4.47M |
| Resolved-object cache hit rate (64 MB) | 62.8% | 62.0% | 69.1% |
| Inflate calls (= misses) | 157k | 740k | 1.81M |
| Delta applications | 113k | 474k | 1.39M |
| Mean / max delta chain on a miss | 1.43 / 50 | 1.25 / 49 | 1.77 / 50 |
| Underlying `readAt` calls (64 KB pages × 512) | 927 | 7,617 | 98,961 |

### Cache-size and page-size sweeps (flutter, full walk)

| Variant | Walk | Hit rate | readAt calls | Peak RSS |
|---|---|---|---|---|
| **v1: Map-order LRU, 4 MB** | 11.4 s | 54.4% | 7.8k | 504 MB |
| v1: Map-order LRU, 64 MB | 21.6 s | 62.2% | 6.4k | 609 MB |
| v1: Map-order LRU, 256 MB | 51.1 s | 62.5% | 5.3k | 926 MB |
| v2: two-generation cache, 8 MB | 9.9 s | 57.2% | 15.1k | 481 MB |
| v2: 32 MB | 9.2 s | 61.3% | 9.6k | 519 MB |
| v2: 64 MB | 9.1 s | 62.0% | 7.6k | 552 MB |
| v2: 256 MB | 8.9 s | 62.5% | 5.6k | 816 MB |
| v2: 64 MB, **no page cache** (one `readAt` per object) | 13.7 s | 62.0% | **740k** | 549 MB |
| v3: + per-directory path interning | 8.8 s | 62.0% | 7.6k | 562 MB |
| v3, no co-change (tensorflow) | 48.4 s (vs 52.2 s) | | | 795 MB (vs 869) |

Findings:

1. **The first LRU was the bottleneck: 48% of CPU.** It used a JS `Map` in insertion order and evicted via `map.entries().next()`. In V8, after many deletes that call is O(deleted slots). Replacing it with a two-generation cache (young/old Maps swapped when full) made flutter 2.4× faster and stopped a bigger cache from making things slower.
2. **Hit rate saturates by about 32 MB.** Most hits are the parent commit's trees re-read one step later. Above 32 MB, extra cache buys about 1%, so **16–32 MB is the right default**.
3. **The page cache is mandatory in the browser** (next section).

### Browser I/O cost (measured in a worker; Chromium 156, desktop app pane)

`FileReaderSync.readAsArrayBuffer(blob.slice(off, off+len))` at random offsets of a 256 MB **in-memory** Blob:

| Read size | µs per call | Throughput |
|---|---|---|
| 256 B | 252 | 1 MB/s |
| 4 KB | 266 | 15 MB/s |
| 64 KB | 381 | 164 MB/s |
| 256 KB | 599 | 417 MB/s |
| 1 MB | 1,716 | 583 MB/s |

Each call has a fixed cost of about 0.25 ms (Blob reads are IPC to the browser process). Reading **once per object would be fatal**: tensorflow's 1.8M misses × 0.25 ms ≈ 450 s. With pages, the estimated browser overhead on top of the Node times is:

| Repo | Page config | readAt calls | Bytes read | Est. browser I/O | Est. browser total |
|---|---|---|---|---|---|
| react | 1 MB × 128 (128 MB) | 82 | 81 MB | 0.14 s | **~2.6 s** |
| flutter | 64 KB × 512 (32 MB) | 7,617 | 476 MB | 2.9 s | ~11.7 s |
| flutter | 1 MB × 128 | 1,244 | 1.24 GB | 2.1 s | **~11 s** |
| tensorflow | 64 KB × 512 | 98,961 | 6.2 GB | 37.6 s | ~90 s |
| tensorflow | 256 KB × 512 (128 MB) | 30,321 | 7.6 GB | 18.2 s | **~70 s** |
| tensorflow | 1 MB × 128 | 25,665 | 25.7 GB (thrashing) | 44 s | ~124 s |

Trees are spread across the whole pack: the read extent equals the pack size on flutter and react. So there is no small "commits + trees" prefix that could be loaded in one go.

## Viability for the plan's history overlays

- **Viable at S and M, and still fine at L**, behind the plan's "never blocks the reveal" rule. A repo with about 20k commits finishes in about 3 s in a worker. One with about 90k commits finishes in about 11 s. Recency is usable within 0.3–0.7 s everywhere.
- **TypeScript is good enough. Do not move to WASM for this.** Inflate is only 25% of the time, so a WASM zlib (roughly 2× faster) would save at most about 12%. The rest is JS-level tree scanning and maps.
- **Memory is the real limit at L.** tensorflow peaks at about 670 MB of heap plus ArrayBuffers in the worker. The main costs are 3.1M (file, author) entries, 1.85M co-change pairs, the 64 MB idx plus 37 MB of offset arrays, and the caches.

## Recommended defaults and limits

| Setting | Recommendation | Why |
|---|---|---|
| `history.maxCommits` | **50,000** default; "load full history" button above that | ~5 s Node / ~6–7 s browser on flutter-like repos and ~12 s / ~17 s on tensorflow; covers 84–93% of HEAD files exactly, the rest are "older than X" |
| Time budget | Also stop at ~20 s wall and report "history to <date>" | tensorflow-class repos |
| Object cache | 16–32 MB, two-generation (not Map-order LRU) | hit rate saturates |
| Pack page cache | 256 KB pages, 128 MB budget for packs > 500 MB; 1 MB × 128 for smaller packs | minimises `FileReaderSync` calls |
| Co-change | ≤ 50 files per commit (as spec'd); prune pairs with count 1 periodically, or cap the map at ~1M entries | 1.85M pairs on tensorflow |
| Progress | Emit a snapshot every ~2,000 commits or 500 ms | first useful recency in < 1 s |

## Suggested optimisations (not implemented), most effective first

1. **Use the commit-graph file when present.** None of these repos have one, but GitHub/`git maintenance` clones often do. It gives parents, root tree and commit time without inflating any commit object, which removes the ~10–20% commit-read share (2.1 s of 8.8 s on flutter).
2. **Skip unchanged entries in large trees faster.** 10 GB of tree bytes are merge-walked on tensorflow (avg 2.4 KB × 4.26M reads). Options: memcmp-style skipping of identical runs, or a per-tree-OID parsed index (name offsets) cached alongside the object so big directories are binary-searched. This targets the ~50% "remainder" bucket.
3. **Cut GC churn and aggregation cost.** Use typed-array per-file counters instead of JS arrays. Use a packed `Int32Array` open-addressing hash for (file, author) and co-change pairs instead of `Map<number, number>`. Avoid `subarray` allocations per inflate. GC was 21% of tensorflow CPU.
4. **Re-use the tree diff for the next commit.** The parent's subtrees are read twice (once as "old", once as "new"). This is already mostly absorbed by the cache (62–69% hits), so the remaining gain is small.
5. **Parallelise.** Split the walk across 2–4 workers by commit ranges, each with its own pack handles, and merge the aggregates. Max/min/count/add merge trivially. This is the strongest lever for L repos if the full walk matters.
6. A WASM inflate (e.g. zlib-ng / libdeflate) would give at most about 12–15% overall. Do it last.

## What was not measured / caveats

- **The full walker did not run inside a browser.** The browser numbers are estimates: Node walk time plus calls × measured `FileReaderSync` cost. That cost was measured on an **in-memory Blob**, not a disk-backed `File` from `showDirectoryPicker`, because a file picker cannot be automated here. Disk-backed reads may cost more per call. Browser V8 should match Node's JIT, but this was not verified.
- The browser setup layer was not built. It must asynchronously enumerate `.git/objects/pack`, the 256 loose-object dirs, refs and packed-refs into `File` objects before the sync walk; `GitFs.list/size` assume this pre-pass. Its cost is unmeasured, though it should be small for packed repos and is per-file for loose-heavy ones.
- Not handled:
  - `.mailmap`;
  - shallow clones (`.git/shallow`);
  - `objects/info/alternates`;
  - multi-pack-index;
  - `.idx` v1;
  - SHA-256 repos;
  - worktrees / `.git` files;
  - grafts / replace refs.

  None of the test repos needed these. The plan already degrades shallow clones and external worktrees.
- Loose objects are not cached. That is fine for small loose repos; a repo with a big loose backlog plus packs was not tested.
- Delta chains of 50 were exercised (max 50 on react and tensorflow) iteratively, with no recursion.
- Timings are single runs on a desktop while other spike agents may have been using the CPU. Expect ±10–15% noise; e.g. tensorflow v2 vs v3 vs `--no-profile` ranged 52–58 s.
- Peak RSS includes about 100 MB of Node/tsx/esbuild baseline. In a worker, the meaningful number is JS heap + ArrayBuffers.
- Rename following (`--follow`) is not done; the plan does not ask for it.
- The `out/` folder contains JSON from every run, including the superseded v1 (`flutter-c*.json`, `react.json`, `flutter.json`, `tensorflow.json` = v1 at 71 s), plus the `*.verify.txt` outputs. The 98 MB tensorflow dump was deleted after verification.
