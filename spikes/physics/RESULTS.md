# M0 spike 5: physics worker (d3-force tiers, SAB, settle cost)

Date: 2026-11-21. Machine: Windows 11, 16 logical cores. Browser: the Claude desktop browser pane (Chromium 156) on `http://localhost:5182`
served by Vite 8 with COOP `same-origin` and COEP `require-corp`. Node: v24.13.0 via `tsx`. d3-force 3.0.1.

## Answers

| Question | Answer |
|---|---|
| (a) d3-force + d3-timer construct and tick manually in a Web Worker without rAF? | **Yes.** No errors. Details below. |
| (b) SharedArrayBuffer under COOP/COEP, worker writes, main reads? | **Yes, on localhost.** `crossOriginIsolated === true` in page and worker; SAB-backed `Float32Array`s posted to main, read each rAF under a seqlock, 0 torn reads seen. **Vercel preview not tested** (no deploy). `vercel.json` must set both headers on every route, including the worker script. |
| (c) Settle time at 1k / 10k / 100k | **~0.16-0.19 s / ~3.1-3.4 s / ~67-71 s** with stock `forceCollide`. **10k does not fit the 3 s `settleMaxMs`** (it misses by 3-14%). With a spatial-hash collide (same force contract): **0.07-0.1 s / ~0.72 s / ~11-13 s**. |

## (a) d3-timer in a worker

d3-timer picks its frame scheduler as `typeof window === "object" && window.requestAnimationFrame ? rAF : setTimeout(f, 17)`.
A dedicated worker in Chromium does expose `requestAnimationFrame`, but `window` is undefined, so **d3 always takes the `setTimeout(17)` path in a worker** (and in Node).

`timer-probe.ts` wraps `setTimeout`/`setInterval`/`clear*`/`requestAnimationFrame` before d3 loads. Constructing all 109 simulations (1 city + 12 district + 96 file), each followed immediately by `.stop()`:

| Observed | Value |
|---|---|
| Errors in the worker (`error`, `unhandledrejection`) | 0 |
| `setTimeout(17)` calls from d3-timer `setFrame` | 2 |
| `setInterval(1000)` (d3-timer's `poke` clock-skew interval) | 1, cleared once (`clearInterval` 1) when the first wake found no live timers |
| `requestAnimationFrame` calls | 0 |
| `'tick'` events dispatched (listener on every sim) | 0, so d3's internal timer never stepped any sim |

So there is a small, self-cleaning burst of timer activity on construction; nothing remains scheduled. Manual `tick()` works as documented (no events, no `alphaMin` check). Identical behaviour in Node.

## (b) SharedArrayBuffer data path

- Page: `crossOriginIsolated === true`, `typeof SharedArrayBuffer === "function"`. Worker: `self.crossOriginIsolated === true`.
- Buffers: city `(x, y, r)` x 12, district `(x, y, r)` x 96 (local), file `(x, y)` x (N + 2000 spare for adds), plus an `Int32Array` holding three tier seqlocks, a per-district generation counter, hot-sim counts per tier and a loop counter.
- Writer: `Atomics.add(seq, k, 1)` (odd = writing), write floats, `Atomics.add` again (even). Reader: load seq, skip if odd or unchanged, copy, re-load seq, discard if changed. **0 torn-read retries** in all runs.
- Main thread reads only the changed tiers: read cost **under 0.02 ms per frame** at 1k/10k, about 0.2 ms per frame at 100k when files changed. Drawing a 2D-canvas dot per file (ImageData) costs about 1 ms (1k-10k) to 3.5 ms (100k) per frame. World position = city + district + file local, so a city drag moves its files without the file tier ticking.
- **Not tested:** a negative control (headers off, transferable fallback at 30 Hz), Safari/Firefox, and the Vercel preview.

## (c) Settle benchmark (PLAN 6.8 step 4)

Synthetic graph (`graph.ts`, seeded): 12 cities x 8 districts = 96 districts. District sizes are log-normal (at 100k: 88-4627 files per district). Radii 0.6-12 with a cubic tail (most small). About 2.4 intra-district links per file with preferential attachment (hubs), plus 15% intra-city and 5% inter-city edges aggregated into district/city link weights.

Forces as in PLAN 7.1: city has link, collide(r + gap/2), weak manyBody(-60), forceX/Y(0.02). District has link, collide, custom `forceContain` (city radius) and custom `forceExternalPull`. File has forceRadial (size-rank target), link (strength `2(1-w)/minDegree`), collide(r + 0.5) and `forceContain` (district disc). `velocityDecay 0.6`, `alphaDecay = 1 - 0.001^(1/150) = 0.0450`, so **every sim takes exactly 150 ticks** from alpha 1 (alphaTarget 0). **Voronoi/Lloyd is skipped** (d3-delaunay is not installed): containment uses the district *circle*, not a Voronoi cell.

### Baseline (stock d3 `forceCollide`), time to alpha < alphaMin for every sim

| Files | Env | City (1 sim) | District (12 sims) | File (96 sims) | Slowest single file sim | **Total** |
|---|---|---|---|---|---|---|
| 1,000 | Node | 10 ms | 16 ms | 133 ms | 7 ms | **159 ms** |
| 1,000 | Chrome worker | 9 ms | 14 ms | 170 ms | 8 ms | **193 ms** |
| 10,000 | Node (3 runs) | 13 ms | 10 ms | 3,099-3,412 ms | 188-236 ms | **3,122-3,447 ms** |
| 10,000 | Chrome worker (2 runs) | 14 ms | 17 ms | 3,093-3,135 ms | 180 ms | **3,120-3,166 ms** |
| 100,000 | Node | 4 ms | 16 ms | 66,877 ms | 4,429 ms | **66,897 ms** |
| 100,000 | Chrome worker | 22 ms | 25 ms | 70,902 ms | 3,887 ms | **70,950 ms** |

(Building the sims takes a further 7 / 23 / 180-207 ms. Single-threaded: one physics worker.)

**The file tier is effectively the whole cost, and `forceCollide` is about 95% of that.** At 10k: all forces 3,127 ms; without collide 109 ms; without link 2,130 ms (`profile-forces.ts`). Isolated `forceCollide` (`profile-collide.ts`) costs **2.0-2.8 µs per node-tick** at 100-5,000 nodes, almost independent of the radius distribution. At 100k the baseline averages ~4.5 µs per node-tick (larger, denser sims).

### Variants (Node, file tier only; `variants.ts`, `tuning*.ts`)

| Files | Variant | File-tier ms | Overlapping files* | Mean residual speed / r |
|---|---|---|---|---|
| 10k | baseline: jitter init, d3 collide, 150 ticks | 3,412 | 17.1% | 0.027 |
| 10k | spiral init at size-rank radius, d3 collide | 3,205 | 15.2% | 0.025 |
| 10k | jitter, **grid collide** | 749 | 12.7% | 0.062 |
| 10k | spiral, **grid collide** | **708** | 11.2% | 0.058 |
| 10k | spiral, grid collide, 60 ticks | 280 | 28.3% | 0.127 |
| 10k | spiral, d3 collide, 60 ticks | 1,183 | 31.0% | 0.074 |
| 10k | spiral, grid, sizeVsConnectivity 0.8 | 617 | 2.9% | 0.027 |
| 10k | spiral, grid, sizeVsConnectivity 1.0 (no file links) | 533 | **0.0%** | 0.003 |
| 100k | jitter, grid collide | 12,814 | 80.3% | 0.52 |
| 100k | spiral, grid collide | 11,110 | 79.7% | 0.51 |
| 100k | spiral, grid collide, 60 ticks | 4,657 | 91.3% | 0.95 |
| 100k | spiral, grid, sizeVsConnectivity 1.0 | 7,509 | 18.6% | 0.048 |

\* A file counts as overlapping if any same-district pair is closer than 95% of the radius sum. At 1k every variant with 150 ticks has 0% overlap. No file ends outside its district at any size, and no district or city overlaps.

`forceGridCollide` (in `layout.ts`) is a spatial hash with the same `force(alpha)` + `initialize` contract and d3's semantics (predicted positions, r² mass split, one pass). It is **4.5x faster at 10k and 5-6x faster at 100k than d3's quadtree collide**, in plain TypeScript.

### What "rest" means here

`alpha < alphaMin` after 150 ticks is a **cooling schedule, not equilibrium**:
- At 10k and especially at 100k, the layout cools with files still overlapping (17% and 80%). The cause is mainly the file-tier link force: preferential-attachment hubs whose many neighbours all want to sit at `rA + rB + gap`. The tuning sweep confirms it (overlap falls to 0% at 10k with links off). Large districts (1,000-4,600 files) also cannot finish unpacking in 150 ticks of single-pass collide, even without links (18.6% at 100k).
- Reheating a "settled" sim moves things **even when nothing changed** (see the reheat control below).

## Live mode: scheduler + pill drag (Chrome worker)

Scheduler (`worker.ts`): a loop every ~16.7 ms (`setTimeout`, not frame-synced). Each loop ticks each **hot** sim once (city, then districts, then files) until the 8 ms slice is used, then writes only the touched rows. A sim is hot when `alpha >= alphaMin` **or `alphaTarget >= alphaMin`**. The second condition is needed because a settled sim has alpha < alphaMin when a drag starts, so with the plan's rule (alpha only) the drag would never wake it.

Drag of city 0: `fx/fy` pinned, `alphaTarget 0.3`, pointer moved on a circle for 2 s via `postMessage` each main-thread rAF, then `fx/fy = null` and `alphaTarget 0`.

| Files | Loops during 2 s drag | Ticks city / district / file | Worker tick ms per loop, mean (max) | Write ms per loop | Loops to sleep after release |
|---|---|---|---|---|---|
| 1k | 121 | 121 / **0 / 0** | 0.09 (0.34) | 0.007 | 124 (2,066 ms) |
| 10k | 120 | 120 / **0 / 0** | 0.10 (0.32) | 0.006 | 124 (2,100 ms) |
| 100k | 120 | 120 / **0 / 0** | 0.12 (0.66) | 0.006 | 124 (2,067 ms) |

**Only the city sim ticks**, and the cost is negligible and independent of file count. After release the city sim keeps ticking for ~124 ticks (~2.1 s at 60 Hz), because alpha climbed to ~0.29 during the drag and decays at 0.045 per tick.

Main-thread frame counts in these runs (36-64 rAF in 2 s) are **not representative**: the browser pane was hidden, so rAF was throttled. The worker loop is unaffected by that.

## Incremental add: 200 files into one district

The target is the largest district of city 3. New nodes start beside a linked existing neighbour (distance rA + rB + pad + jitter), with 1-2 links each. Then one `nodes()`, one `links()`, district/city radii recomputed (collide radii re-initialised), and **file sim, that city's district sim and the city sim** all reheated to `max(alpha, 0.3)`. This follows PLAN 7.1: "space propagates upward". Each sim needs 124 ticks from 0.3 to rest.

| Files | Existing in district | R before → after | Compute to rest (Node, back-to-back) | Live wall time (Chrome, 1 tick/loop) | Worker tick ms per loop, mean (max) | Existing files moved, mean / max (local) | Mean as % of R | Sibling districts mean | Cities mean / max |
|---|---|---|---|---|---|---|---|---|---|
| 1k | 26 | 39.7 → 102.5 | 94 ms | 2,135 ms | 1.0 (3.4) | 27.6 / 57.4 | 70% | 78 | 37 / 72 |
| 10k | 240 | 112.8 → 146.8 | 144-153 ms | 2,134 ms | 1.6 (2.6) | 21.5 / 68.4 | 19% | 52 | 37 / 53 |
| 100k | 2,182 | 337.8 → 350.5 | 1,327 ms | 2,168 ms | **10.4 (19.5)** | 49.3 / 176 | 15% | 80 | 97 / 183 |

(The 1k case is not realistic: 26 files grow to 226. The Node and Chrome displacements differ by 5-20% because of floating-point divergence; see determinism below.)

Controls (Node, 10k):
- **Reheat with 0 files added** (same three sims to 0.3): existing files move mean 9-10 (8-9% of R), sibling districts 20, **cities mean 32**. So roughly half the file motion and most of the city motion after an add comes from reheating a sim that had cooled before reaching equilibrium, not from the 200 new files.
- "stable" radial targets (existing files keep their size-rank target; only new files get one) instead of recomputing all ranks: the mean drops only from 23.2 to 22.5 at 10k, so re-ranking is not the main source of motion.

At 100k a **single tick of one 2,382-node file sim costs ~10-20 ms**, more than the 8 ms slice. The scheduler cannot split a tick, so the slice overruns. This is with d3 collide; grid collide would be about 5x cheaper.

## Determinism

- Within one engine, results are reproducible (same checksum across runs: Node 10k `c1918f9f` x3, Chrome 10k `d1f18bc2` x2).
- **Across engines they diverge.** 1k matches exactly (Node = Chrome = `8d19e726`), but 10k and 100k differ (Node `c1918f9f` / `832cf289`, Chrome `d1f18bc2` / `fe85be66`). The overlap metrics differ in the second or third digit. The likely cause is ulp-level differences in `Math.pow`/`exp`/`hypot` between V8 versions, amplified by the chaotic dynamics. **Implication:** snapshots must store positions; never re-derive a saved layout by re-simulating on another browser or version.

## Surprises about d3-force

1. **`forceCollide` dominates and is ~2-4.5 µs per node-tick.** It alone makes the 10k settle miss 3 s and the 100k settle take over a minute. A JS spatial hash with the same contract is 4.5-6x faster, so this does not need WASM to fix the 10k case.
2. **`alpha < alphaMin` ≠ equilibrium.** With fixed 150 ticks, big districts cool with heavy overlap, and any later reheat (drag release, incremental add) releases stored tension, so things that "should not move" do move. The plan's statement "nothing moves after the reveal unless asked" holds only because sims sleep. Any user-triggered reheat will move unrelated parts (cities ~32 units mean at 10k with zero changes).
3. **Hub links fight collide.** forceLink with `distance = rA + rB + gap` on preferential-attachment hubs packs neighbours into an impossible ring. Overlap at 10k: 11% → 3% → 0% as `sizeVsConnectivity` goes 0.5 → 0.8 → 1.0.
4. **Hot rule must include `alphaTarget`** (see the live-mode section).
5. d3-timer ignores the worker's `requestAnimationFrame` because it checks `window`. This is harmless.

## Implications for the plan (for the lead to decide)

- `settleMaxMs 3000` at 10k: **fails with stock d3-force (3.1-3.4 s)**. It passes with a custom grid collide (~0.7 s), or by parallelising file sims across 2-4 workers (they are independent). At 100k neither fits in 3 s on one thread (grid collide ~11 s; 60 ticks ~4.7 s but poor quality). The L tier needs worker parallelism, fewer ticks with good initial placement, or a cap that accepts partial settling.
- Consider: pinning (fx/fy) non-affected cities and districts during a local update instead of reheating the whole city sim; a lower `alphaMin` or extra settle ticks with collide only; capping hub link pull (for example, a distance that grows with degree).

## Not measured

- Vercel preview (COOP/COEP from `vercel.json`), Safari, Firefox, mobile/integrated-GPU devices.
- Negative control without isolation (transferable fallback path).
- Camera-distance ordering and reduced-rate off-screen ticking in the scheduler (no camera here). District drag clamping.
- Voronoi territories and the Lloyd relaxation force (no d3-delaunay). Containment is a circle.
- `forceExternalPull` is a constant-bearing approximation, computed after the city tier settles.
- Real repos: the graph is synthetic, and real dependency graphs may be more or less hub-heavy.
- Multi-worker parallel settle (estimated only: the file sims are independent).
- Main-thread fps under a visible pane (the pane was hidden, so rAF was throttled).
- Layout quality was measured only as overlap/containment/residual speed, not visually judged beyond one screenshot at 1k.

## Files

- `graph.ts`: seeded synthetic clustered graph.
- `layout.ts`: three-tier sims, `forceContain`, `forceExternalPull`, `forceGridCollide`, settle, quality metrics, incremental add.
- `experiments.ts`: build+settle, round-robin run-to-rest, incremental-add measurement.
- `bench-node.ts` → `bench-node.log`, `results-node.json`: headless baseline at 1k/10k/100k.
- `variants.ts` → `variants-10k.log`, `variants-100k.log`; `tuning.ts`, `tuning2.ts`; `profile-forces.ts`, `profile-collide.ts`.
- `timer-probe.ts`, `worker.ts`, `main.ts`, `index.html`, `vite.config.ts` (port 5182, COOP/COEP): browser harness. Drive it from devtools with `await spike.init(10000); await spike.drag(0, 2000); await spike.add(200)`.
- Run: from `spikes/`, `npx vite --config physics/vite.config.ts` and `npx tsx physics/bench-node.ts [sizes]`.
