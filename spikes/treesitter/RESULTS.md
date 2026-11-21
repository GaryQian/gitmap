# M0 spike 2: tree-sitter (WASM) slow pass

**Question.** What does the slow pass (tree-sitter parse plus a tags-style query for definitions and call sites) cost when it runs as WASM? Does it fit inside the 30 s reveal budget (`reveal.maxWaitSeconds`) at about 10k files?

**Answer.** Yes, on this machine, with room to spare. With 14 workers, 10k files of real code takes about **3.5 s (JS/TS), 6 s (C++/Python) and 11 s (Dart)** of wall time. The full TensorFlow code set (21k C++/Python files, 234 MB) finishes in 12.7 s. No file came near the 2 s cap: the worst was 0.42 s single-threaded. Scaling is **not linear**. 14 workers give 6.2 to 6.9x, not 14x, because the CPU has only 8 physical cores. On a typical 4-core laptop, a Dart-heavy 10k-file repo is projected at about 20 s. That still fits, but the slow pass then takes most of the 30 s budget.

## Machine and method

- Intel i9-9900K (8 cores / 16 threads, 3.6 GHz base), 64 GB RAM, Windows 11 Pro 26200. Node v24.13.0 (V8). The repos are on local disk.
- Other spike agents were running benchmarks on the same machine at the same time. Absolute numbers may therefore be a few percent pessimistic, and the multi-worker runs may be affected more.
- Runtime: `web-tree-sitter@0.27.2`. Grammars come from `@repomix/tree-sitter-wasms@0.1.17` (built with tree-sitter-cli 0.26). Kotlin and Obj-C are missing from that set, so they come from `tree-sitter-wasms@0.1.13`, loaded through `web-tree-sitter@0.22.6` (see "Dependency changes").
- Per file the pipeline is: `readFileSync` (timed separately) → `TextDecoder` → `parser.parse(string, null, {progressCallback})`. The callback is a 10 s safety cap; the cost of the cap is below noise (see the variants table). Then `query.captures(root)` runs, a `{name, row}` record is built for every `@name` capture (so name strings are actually pulled out of WASM), and finally `tree.delete()`.
- "Parse" and "query" times count only the tree-sitter calls. File reads are reported apart. In the worker runs, reads are included in wall time.
- Single-threaded runs use the **full** set of tracked files for each language (`git ls-files`, filtered by extension), in a deterministic shuffle.
- File-to-language mapping: `.js/.jsx/.mjs/.cjs` → javascript, `.ts` → typescript, `.tsx` → tsx, `.rs` → rust, `.dart` → dart, `.cc/.cpp/.h/.hpp/.cu` → cpp (TF `.h` files are parsed as C++), `.py` → python.
- Queries: `queries.ts`, written by hand after the upstream `tags.scm` files, for TS/TSX/JS, Python, C, C++, Dart, Java and Rust. They cover definitions (class, function, method, interface, type, enum, namespace/module) and references (call sites by callee identifier or member name, plus `new X`). `checkq.ts` checks them on small snippets.

**Node as a stand-in for a browser worker.** Chrome and Node use the same V8 WASM engine (Liftoff baseline, TurboFan tier-up), so per-core parse speed should be close. Differences to expect:
- (a) Browser workers have no `tsx`/Node bootstrap, so per-worker memory is lower.
- (b) Reads in the browser go through File System Access (`getFile().arrayBuffer()`), not `readFileSync`. The scan spike covers that.
- (c) Firefox (SpiderMonkey) and Safari (JSC) were **not** measured.
- (d) Browsers may throttle background tabs and workers.

## 1–2. Grammar sizes and load times

Load time is the median of 5 fresh Node processes. "Runtime init" is `Parser.init()`, the core runtime WASM; it is paid once per worker, not once per grammar. "Load" is `Language.load(bytes)`, meaning compile plus instantiate, excluding disk read. "First parse" is `setLanguage` plus parsing `"x"`.

| Language | Raw KB | gzip-9 KB | brotli-11 KB | Old tree-sitter-wasms KB | Load ms | First parse ms | Source |
|---|---:|---:|---:|---:|---:|---:|---|
| TypeScript | 1384 | 136 | 91 | 2287 | 4.9 | 4.6 | repomix |
| TSX | 1416 | 139 | 97 | 2354 | 4.1 | 4.6 | repomix |
| JavaScript | 406 | 50 | 37 | 632 | 2.4 | 4.9 | repomix |
| Python | 449 | 67 | 48 | 464 | 3.3 | 4.4 | repomix |
| C | 630 | 73 | 48 | 774 | 3.7 | 6.8 | repomix |
| C++ | 3389 | 278 | 167 | 4553 | 6.0 | 8.2 | repomix |
| Obj-C | 7527 | 409 | 196 | 7527 | 7.4 | 9.8 | **legacy only** (0.22 runtime) |
| Java | 407 | 51 | 36 | 420 | 3.1 | 5.4 | repomix |
| Kotlin | 3957 | 319 | 164 | 3957 | 5.0 | 7.8 | **legacy only** (0.22 runtime) |
| C# | 5810 | 353 | 193 | 3885 | 7.4 | 7.2 | repomix |
| Go | 213 | 39 | 28 | 230 | 3.1 | 4.6 | repomix |
| Rust | 1089 | 117 | 80 | 799 | 3.7 | 5.5 | repomix |
| Dart | 974 | 102 | 73 | 961 | 4.5 | 5.3 | repomix |
| Swift | 3344 | 298 | 179 | 3074 | 6.7 | 13.1 | repomix |
| **All 14** | **31,002** | **2,439** | **1,443** | | | | |

- Core runtime: `web-tree-sitter.wasm` is 206 KB (81 KB gzip), plus `web-tree-sitter.js` at 152 KB. `Parser.init()` takes 53–61 ms in a cold process. Obj-C and Kotlin show about 18 ms only because the legacy runtime is a smaller and older build.
- Grammars compile in **2–7 ms** because V8 compiles WASM lazily, function by function. The real cost moves into the first parses; there is no visible warm-up effect, since the first 200 files run at the same MB/s as the rest. Loading all grammars a repo needs costs less than 100 ms per worker. **Grammar loading does not matter for the budget.** Download size does: the 4 MB raw Obj-C/Kotlin/C# grammars are 160–200 KB brotli.
- None of the 14 target languages is missing outright. Kotlin and Obj-C exist only as ABI-14 builds in the old `dylink` format, which `web-tree-sitter` ≥0.25 refuses to load. Before shipping, either build them with a current tree-sitter-cli or ship a second runtime. A second runtime is not recommended.

## 3–4. Single-threaded throughput and query cost

All rows use the full file set. "Total" means parse plus query. Percentile columns are per file, for parse plus query.

| Repo / language | Files | MB | Parse ms | Query ms | Query / parse | Parse MB/s | Total MB/s | Files/s | Mean ms/file | p50 | p95 | p99 | Max ms | Files with ERROR nodes | Defs | Refs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| react / JavaScript | 3915 | 19.7 | 4823 | 1208 | 25% | 4.08 | 3.26 | 649 | 1.54 | 0.21 | 6.0 | 24.2 | 137 | 926 (24%) | 19,393 | 147,174 |
| react / TypeScript | 431 | 2.5 | 414 | 147 | 36% | 5.96 | 4.40 | 769 | 1.30 | 0.29 | 6.1 | 13.5 | 32 | 0 | 2,681 | 14,689 |
| react / TSX | 122 | 0.13 | 32 | 10 | 31% | 3.87 | 2.96 | 2877 | 0.35 | 0.24 | 1.0 | 2.8 | 3 | 0 | 193 | 460 |
| react / Rust (bonus) | 122 | 3.0 | 425 | 158 | 37% | 6.97 | 5.07 | 209 | 4.78 | 2.19 | 15.8 | 36.6 | 53 | 0 | 2,297 | 21,711 |
| **react, all** | 4590 | 25.2 | 5695 | 1523 | 27% | 4.43 | 3.49 | 636 | 1.57 | | | | 137 | | | |
| flutter / Dart | 6637 | 91.0 | 31548 | 7658 | 24% | **2.88** | **2.32** | 169 | 5.91 | 1.53 | 25.4 | 67.1 | 420 | 1031 (16%) | 107,804 | 792,699 |
| tensorflow / C++ (.cc + .h) | 17759 | 187.8 | 40841 | 12705 | 31% | 4.60 | 3.51 | 332 | 3.02 | 1.04 | 11.2 | 32.1 | 361 | 5214 (29%) | 281,171 | 1,763,338 |
| tensorflow / Python | 3233 | 46.4 | 8433 | 2847 | 34% | 5.50 | 4.12 | 287 | 3.49 | 1.45 | 13.3 | 29.0 | 87 | 0 | 71,118 | 427,684 |

- **Throughput is 2.3 to 5 MB/s per core for parse plus query.** Dart is the slowest grammar, at about 60% of the speed of C++ and Python.
- **The tags query adds 24–37% on top of parse.** This includes copying every captured name string out of WASM. It is a real cost, not noise, so budget **parse × 1.3**.
- Reading files took about 2.5 s for react, 4.8 s for flutter and 14.5 s for TF, single-threaded with Windows `readFileSync`. That is comparable to the parse cost on Windows and is excluded from the numbers above. It belongs to spike 1.

**Variants on react** (same 4590 files, single-threaded):

| Variant | Parse ms | Query ms | JS parse MB/s | JS files with errors | Peak RSS MB |
|---|---:|---:|---:|---:|---:|
| Baseline (cap on, query on, delete trees) | 5695 | 1523 | 4.08 | 926 | 198 |
| No progressCallback cap | 5923 | 1620 | 3.93 | 926 | 196 |
| No query | 5815 | — | 4.00 | 926 | 157 |
| No `tree.delete()` | 6673 | 1869 | 3.50 | 926 | **702** |
| react `.js` parsed with the **TSX** grammar | 3578 (JS only) | 1311 | **5.49** | **277** | 170 |

- The `progressCallback` time cap costs nothing measurable, so the per-file 2 s cap is free to keep.
- **React's `.js` files are Flow-typed.** The JavaScript grammar runs error recovery on 24% of them, and that recovery is slow. The TSX grammar parses them 34% faster, with 70% fewer files containing errors and 28% more definitions found. A cheap heuristic is worth considering: if a `.js` file contains `@flow` or type annotations, parse it with TSX.

## 5. Parallel scaling (measured with `worker_threads`)

Workers pull file indices from a shared `Atomics.add` counter, in git (directory) order. Each worker reads, decodes, parses, queries and deletes on its own. "Work" is wall time from all workers ready to all workers done, with reads included. "Startup" is spawning the workers and loading grammars.

| Repo | Workers | Startup ms | Work ms | Speedup | Total CPU parse+query ms | Peak RSS MB |
|---|---:|---:|---:|---:|---:|---:|
| react (4590 files, 25 MB) | 1 | 315 | 10,903 | 1.0 | 7,742 | 228 |
| | 2 | 271 | 5,418 | 2.0 | 7,994 | 309 |
| | 4 | 328 | 3,004 | 3.6 | 9,025 | 373 |
| | 8 | 495 | 1,912 | 5.7 | 11,781 | 601 |
| | 14 | 686 | **1,588** | **6.9** | 15,159 | 827 |
| flutter Dart (6637 files, 91 MB) | 1 | 231 | 46,305 | 1.0 | 39,717 | 304 |
| | 4 | 291 | 13,192 | 3.5 | 46,612 | 660 |
| | 8 | 467 | 9,757 | 4.7 | 68,127 | 1,044 |
| | 14 | 845 | **7,461** | **6.2** | 81,100 | 1,375 |
| tensorflow C++/Py (20,992 files, 234 MB) | 1 | 304 | 79,863 | 1.0 | 63,408 | 346 |
| | 8 | 552 | 15,138 | 5.3 | 99,524 | 1,718 |
| | 14 | 850 | **11,888** | **6.7** | 118,390 | 1,942 |

**Extrapolation versus reality.** Linear scaling is single-threaded CPU divided by 14. It predicts 0.52 s for react, 2.8 s for flutter and 4.6 s for TF. The measured times are **about 2.6x to 3x worse**. Total CPU per file roughly doubles from 1 to 14 workers. The likely causes are the 8 physical cores (hyperthreads add little to this kind of compute), turbo clocks dropping under all-core load, and shared cache and memory bandwidth. Plan on an **effective speedup of about 0.45 to 0.5x the physical core count, plus a little from SMT**, not on the worker count.

**Projected slow pass for 10k files** (14 workers on this machine, measured rates, plus about 0.8 s startup):

| Repo profile | Measured rate at 14 workers | 10k files |
|---|---:|---:|
| JS/TS like react (5.6 KB average) | 2,890 files/s, 15.8 MB/s | ~4 s |
| C++/Python like TF (11.4 KB average) | 1,766 files/s, 19.7 MB/s | ~6.5 s |
| Dart like flutter (14 KB average) | 890 files/s, 12.2 MB/s | ~12 s |

**Full repos.** react: 2.3 s. flutter Dart only: 8.3 s (the C++/Obj-C/Java in the flutter engine was not run). TF C++/Python: 12.7 s. TF's other roughly 17k tracked files (pbtxt, mlir, md and so on) are not parsed by tree-sitter.

**Laptop projection (not measured).** Take a 4-core/8-thread laptop at about 0.8x per-core speed with an effective speedup of about 3.5x. A Dart-heavy 10k-file repo would take about 10k × 5.9 ms / (3.5 × 0.8) ≈ **21 s**, and a C++ one about 11 s. That fits inside 30 s, but leaves little time for resolve, clustering and settle, which share the same budget. The 30 s escape hatch in §6.8 is the right design and should stay.

## 6. Memory

- **Trees must be deleted.** Without `tree.delete()`, RSS grows linearly: 122 → 691 MB over 4.5k react files, about 23x the source bytes, and the tree slows down by about 15%. Trees live in the WASM heap, so JS garbage collection never frees them.
- With deletion, single-threaded RSS rises at first and then levels off. It plateaus around 300 MB over 21k TF files: about 110 MB at the start, 250 MB by file 4000, 300 MB from file 11000 on. WASM linear memory never shrinks, so the plateau is the high-water mark set by the largest trees. Within that bound there is no leak.
- With 14 workers, peak RSS is 0.8 GB (react), 1.4 GB (flutter) and 1.9 GB (TF), or about 60–140 MB per worker. Part of that is Node and `tsx` bootstrap in each worker, so browser workers should be lighter, but the WASM heap high-water mark per worker (about 50–150 MB on big files) stays. On a low-memory machine, cap the pool size, for example by `navigator.deviceMemory`.
- The parser itself is reused across files (one `Parser` per language per worker). `parser.reset()` is called only after a cancelled parse.

## 7. Per-file time cap and worst files

**No file exceeded 2 s, or even 0.5 s, single-threaded.** At 14 workers, per-file CPU roughly doubles, so the worst file would be about 0.8–0.9 s. That is still under the cap.

Worst 5 files by parse plus query, single-threaded:

| Repo | File | KB | Parse ms | Query ms |
|---|---|---:|---:|---:|
| flutter | packages/flutter/lib/src/material/icons.dart | 1818 | 327 | 93 |
| flutter | packages/flutter/test/material/text_field_test.dart | 716 | 310 | 78 |
| tensorflow | tensorflow/compiler/mlir/lite/schema/schema_generated.h | 1126 | 274 | 87 |
| flutter | engine/src/flutter/lib/web_ui/lib/src/engine/font_fallback_data.dart | 2208 | 271 | 59 |
| flutter | packages/flutter/test/widgets/editable_text_test.dart | 676 | 259 | 63 |

Next worst: TF `spmd_partitioner_test.cc` (976 KB, 294 ms total) and react `ReactFiberConfigDOM.js` (241 KB, 137 ms). Parse time grows roughly linearly with size, at 150–400 ms per MB. At these speeds, the 2 s cap corresponds to roughly 5–10 MB of source in one file, single-threaded.

## Surprises

1. **The ABI mismatch was real.** `web-tree-sitter@0.27` cannot load any grammar from `tree-sitter-wasms@0.1.13`, which uses the old `dylink` section; it fails in `getDylinkMetadata`. The newer `@repomix/tree-sitter-wasms` loads fine, but has no Kotlin or Obj-C.
2. **Scaling is about 6.5x at 14 workers,** because of the 8 physical cores and clocks dropping under load. Per-file CPU roughly doubles under full load.
3. **There are many syntax errors on real code.** 29% of TF C++ files contain ERROR nodes (macros like `TF_RETURN_IF_ERROR` and unexpanded `#define` bodies), as do 16% of flutter Dart files (the community Dart grammar lags behind Dart 3 syntax) and 24% of react JS files (Flow). Python and TS had none. The trees still yield most definitions and references, but the quality of edges in those languages needs checking against golden fixtures. Error recovery is also the slow path: TSX on Flow files is 34% faster.
4. Grammar compile time is negligible (lazy WASM compilation). Download size, not load time, is what matters.
5. The Dart grammar is about 1.6x slower per MB than C++ or Python.

## What was not measured

- Real browsers: Chrome, Firefox, Safari, Web Workers, File System Access reads, and OPFS caching. Node is a stand-in.
- A laptop or integrated-graphics-class CPU. The laptop numbers above are a projection.
- Parsing for TS, TSX, JS, Python, C++, Dart and Rust only. C, Obj-C, Java, Kotlin, C#, Go and Swift were load-timed but not throughput-tested on a corpus. Queries exist for C and Java but were run only on snippets.
- The quality of query results (precision and recall of definitions and call references). Only counts were collected, and the queries are a first draft.
- Interleaving the fast and slow passes on the same pool, and the cost of moving results back to the analysis worker (serialization).
- `parse()` with a `Uint8Array` or callback input. Only string input was used, which web-tree-sitter copies to WASM as UTF-16 in 10 KB chunks.
- Throughput of the legacy runtime (0.22) for Kotlin and Obj-C.

## Dependency changes (root `spikes/package.json`)

- `npm i @repomix/tree-sitter-wasms@0.1.17`: modern-ABI grammars that load in `web-tree-sitter@0.27.2`.
- `npm i web-tree-sitter-legacy@npm:web-tree-sitter@0.22.6`: an aliased old runtime, used only to load and time the Kotlin and Obj-C grammars from `tree-sitter-wasms`.
- Nothing was removed. `web-tree-sitter@0.27.2` and `tree-sitter-wasms@0.1.13` are still installed.

## Files

- `bench.ts`: single-threaded benchmark. Flags: `--repo`, `--langs`, `--limit`, `--no-delete`, `--no-cap`, `--no-query`, `--as <lang>`, `--tag`.
- `scale.ts` and `worker.ts`: the `worker_threads` scaling run.
- `grammars.ts` and `loadone.ts`: grammar sizes and cold load time.
- `lib.ts`: loading, the extension map, and per-file processing.
- `queries.ts`: the tags queries.
- `checkq.ts`: query sanity check.
- `dump.ts`: syntax-tree dumper.
- `out-*.json`: raw results. `out-*.files.json` holds per-file timings as `[path, lang, bytes, parseMs, queryMs]`.

To reproduce, run from `spikes/`: `npx tsx treesitter/bench.ts --repo ../../react --langs typescript,tsx,javascript,rust --tag react`
