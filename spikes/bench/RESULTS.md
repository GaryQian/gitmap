# Pre-Round-1 checks: Vercel, shared memory, browser reads, integrated GPU

Run 2026-11-21 against two Vercel deployments in account `garyqians-projects`:

| Deployment | What it is | Public URL |
|---|---|---|
| `gitmap-scaffold` | Last commit (`9df88f7`, Round 0) exported with `git archive`, built by Vercel | https://gitmap-scaffold.vercel.app |
| `gitmap-m0-bench` | Static build of the M0 benchmark pages (`npx vite build --config bench.vite.config.ts`) | https://gitmap-m0-bench.vercel.app |

Both were meant as previews. The first deployment of a new Vercel project is always production, even with `--target=preview`, so both have **public** `*.vercel.app` aliases; the per-deployment URLs require Vercel login.

## Verified

| Check | Result |
|---|---|
| COOP/COEP headers on Vercel | `same-origin` / `require-corp` on `/`, `/dev`, `/dev.html` and `/assets/*.js` (scaffold) and on every bench page |
| Cross-origin isolation (Chrome 156) | `crossOriginIsolated` true on the scaffold `/dev` page and in a worker it starts |
| SharedArrayBuffer on Vercel | Worker `Atomics.add` on a shared buffer is visible to the page (scaffold `/dev`) |
| d3-force worker on Vercel | Physics page: page and worker isolated, shared buffers OK, 10k-file settle 3.99 s with stock `forceCollide` (3.1–3.2 s locally; file tier is 99% of it) |
| GPU timing in the browser pane (RTX 2080 Ti) | GPU ms only; the pane caps rAF at 15 fps (table below). Real frame rates are in the next section. |

GPU runner on this machine (GPU ms per frame at 1920×1080, avg / p95; 120 frames):

| Files | Edges drawn | GPU ms avg | GPU ms p95 |
|---|---|---|---|
| 1,000 | 1,500 | 1.31 | 4.59 (warm-up) |
| 10,000 | 1,500 | 0.71 | 1.91 |
| 10,000 | 50,000 | 2.85 | 3.61 |
| 100,000 | 1,500 | 1.81 | 8.45 |
| 100,000 | 50,000 | 2.99 | 3.68 |
| 100,000 | 150,000 | 6.74 | 7.12 |

The "real fps" column was capped at 15 fps for every scene: the Claude desktop browser pane throttles `requestAnimationFrame` even when visible. Real frame rate must be measured in a normal Chrome or Edge window.

## GPU runner in normal Chrome 156 (real frame rate)

Live = 5 s of `requestAnimationFrame` at the window's own size and pixel ratio (display-capped). GPU = timer-query ms per frame. Sync = 120 frames back to back at 1920×1080, DPR 1.

| Files | Edges drawn | RTX 2080 Ti desktop (DPR 1.5, 60 Hz): live fps | live GPU ms avg | sync GPU ms avg | Apple M5 Max (DPR 2, 120 Hz): live fps | live GPU ms avg | sync GPU ms avg |
|---|---|---|---|---|---|---|---|
| 1,000 | 1,500 | 58.6 | 1.68 | 1.39 | 120 | 1.99 | 0.58 |
| 10,000 | 1,500 | 58.8 | 2.86 | 1.74 | 120 | 2.32 | 0.58 |
| 10,000 | 50,000 | 60.0 | 6.11 | 2.97 | 120 | 4.20 | 3.14 |
| 100,000 | 1,500 | **4.1** (see below) | 3.50 | 1.22 | 120 | 4.09 | 0.86 |
| 100,000 | 50,000 | 59.0 | 5.27 | 4.00 | 120 | 4.12 | 3.63 |
| 100,000 | 150,000 | 58.6 | 6.63 | 6.96 | 117.7 | 16.18 | 9.64 |

- **10k files hold the display refresh on both machines**, including 50,000 drawn edges (the plan's default is 1,500).
- **M5 Max holds 120 fps up to 100k files with 50,000 edges.** At 150,000 edges its GPU time (9.6–16 ms) exceeds the 8.3 ms budget for 120 Hz, which fits the M0 finding that edges are the cost.
- **Anomaly, desktop 100k / 1,500 edges:** median frame 16.7 ms but one 33.5 s stall (max frame 33,452 ms) and a 133 ms CPU submit spike. The sync run and the heavier 100k configs are clean, so this looks like a one-off (likely GC or shader compile after building the 1M-edge scene, or the window losing focus), not a render cost. Worth one re-run before treating it as noise.
- **Not covered:** a low-end integrated GPU (Intel UHD/Iris, AMD APU). The M5 Max is an integrated GPU but performs like a discrete one, so it does not answer the M0 question for typical laptops.

## Folder reads + fast scan from a picked folder (Chrome 156, react, 4,590 code files, 26.4 MB)

| Workers | Browser wall | Browser handle+read (summed) | Browser scan (summed) | Node wall (spike 1) |
|---|---|---|---|---|
| 1 | 10.82 s | 9.98 s (≈2.2 ms per file) | 0.81 s | 5.55 s |
| 14 | **3.48 s** | 43.75 s | 1.23 s | 0.81 s |

- **Reading is the whole cost.** Scanning is under 1.3 s either way; resolving the handle and reading each file is about 2.2 ms per file on one worker.
- **Parallel reads scale poorly:** 14 workers give 3.1× (Node gave 6.9×), and summed read time rises 4.4×, so File System Access reads largely serialise in the browser. The fast pass is 4.3× slower than Node at 14 workers.
- **Projection for M:** at this rate, reading ~10k files costs about 7–8 s of wall time before any parsing. That still fits the 30 s reveal budget with spike 2's slow pass, but only if **each file is read once** and its bytes feed both the fast scan and tree-sitter.
- **Untested ideas, recommended for Round 1:** several reads in flight per worker instead of more workers; a smaller read pool (4–6) separate from parse workers; caching file bytes in OPFS by blob OID so return visits skip handle resolution.
- No files failed to read. Earlier attempts appeared to hang; the old page showed no progress during the 11 s single-worker run, so it was likely copied before finishing. The page now logs progress and reports per-file errors.

## Git walk from a picked folder (Chrome 156, react, disk-backed `File` + `FileReaderSync`)

Folder picking does not work in the Claude desktop browser pane (the picker throws `AbortError` after a folder is chosen); this was run in normal Chrome.

| Measure | Browser | Node (spike 3) |
|---|---|---|
| Setup: list `.git` files | 66 ms (82 files) | – |
| Walk, 21,800 commits | **7.08 s** (3,079 commits/s) | 2.5–3.5 s across spike 3 runs |
| Reads | 280 calls, 73 MB, 0.80 s (≈2.9 ms per 256 KB read) | – |
| Inflate | 1.53 s | – |
| Paths / HEAD coverage | 26,713 / 100% | 26,713 / 100% |

- **Correct:** same path count as the Node run, which matched `git log` exactly.
- **2–2.8× slower than Node**, and 2.7× slower than spike 3's browser estimate (~2.6 s). Disk reads are only 0.8 s of it, so the gap is CPU in the browser worker (inflate, tree parsing, maps), not I/O. Not profiled yet.
- **Effect on the plan:** at ~3,000 commits/s, `history.maxCommits` 50,000 takes ~16 s, inside the planned ~20 s budget, but the full flutter (~93k) and tensorflow (~204k) histories would take roughly 30 s and 70–150 s. Keep the 50,000 default and the "Load full history" action; profile the worker before raising it.

## Not yet verified


- **Grammar and WASM serving on Vercel.** The Round 0 commit has no grammar files (they arrive with Round 1). Re-check `Content-Type: application/wasm` and the COEP header on `/grammars/*.wasm` after Round 1 merges.
- **Low-end integrated graphics** (Intel UHD/Iris, AMD APU): not tested. Decided 2026-11-21 that the M5 Max result is enough for Round 1; the runner remains at https://gitmap-m0-bench.vercel.app/bench/gpu.html for later.
- Safari and Firefox.
