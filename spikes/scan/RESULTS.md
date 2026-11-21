# Spike 1: manifest + fast-pass scan throughput

**Question.** How fast can the TypeScript fast pass (git index → file list → line counts + import specifiers) run across a worker pool, and does it need Rust/WASM?

**Method.** `npx tsx scan/bench.ts <repo> 14`. Node 24.13, Windows 11, 16 logical cores. `.git/index` parsed by `scan/gitindex.ts` (v2–v4). Code files filtered by extension, ≤ 1 MB, regular files. Each `worker_threads` worker gets a contiguous, path-sorted slice, reads with `fs.readFileSync`, decodes UTF-8, and runs `scan/scanner.ts` (one pass blanking comments, then per-language regexes). Both scanner files use only web APIs, so they run unchanged in a browser worker.

## Results

| Repo | Index entries | Index parse | Code files | Code MB | 1 worker wall | 14 workers wall | Scan MB/s per core (1 worker) | Imports found |
|---|---|---|---|---|---|---|---|---|
| GitViz | 145 | 0.6 ms | 120 | 1.0 | 0.26 s | 0.29 s | 24 | 517 |
| react | 7,282 | 14 ms | 4,590 | 26.4 | 5.55 s | **0.81 s** | 34 | 12,399 |
| flutter | 16,356 | 19 ms | 11,314 | 124.8 | 12.6 s | **2.20 s** | 30 | 62,271 |
| tensorflow | 38,312 | 44 ms | 21,453 | 246.9 | 18.8 s | **3.03 s** | 35 | 259,203 |

- **Index parse** is negligible: 44 ms for 38k entries.
- **Single-threaded, file reads dominate** (react: 4.6 s reading vs 0.8 s scanning). Per-file open cost on Windows is the main cost, not bytes.
- **Scanning** runs at 30–35 MB/s per core in plain TypeScript. Per-core throughput halves at 14 workers (16 logical = 8 physical cores, plus other spike agents were benchmarking concurrently), but wall time still drops 6–7×.
- **Slowest single file**: 83 ms (a generated Dart data file). Nothing approaches the 2 s per-file cap.

## Correctness checks

- Index v4 (prefix-compressed paths): a scratch repo converted with `git update-index --index-version 4` parses to exactly the `git ls-files` output.
- Spot checks of extracted imports for JS (`ReactDOMRoot.js`), Python (`keras/__init__.py`), Dart (`framework.dart`) and C++ (`tensor.cc`) are clean. No accuracy benchmark against a ground-truth import set was done.

## Conclusion

The fast pass for a 10k-file repo takes ~1–2 s across workers in TypeScript. **No case for Rust/WASM here.** The bottleneck is per-file I/O, which a WASM scanner would not change.

## Not measured

- **Browser File System Access read cost.** Node `fs` is a stand-in; the browser path (`getDirectoryHandle` / `getFileHandle` / `getFile().arrayBuffer()` per file) is likely slower per file. `spikes/fsa/` is a ready page that measures it, but needs a person to pick the folder: `npx vite --config fsa/vite.config.ts`, open http://localhost:5183, pick a repo.
- Cold-cache reads (the repos were likely in the OS cache after the first run).
- A true 100k-file repo; tensorflow (38k entries, 21k code files) is the largest available.
