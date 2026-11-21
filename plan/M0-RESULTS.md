# M0 spike results

Measured 2026-11-21 on one machine: Windows 11, Intel i9-9900K (8 cores / 16 threads), RTX 2080 Ti, Node 24.13, Chromium in the Claude desktop browser pane. Test repos: react (7.3k files, 21.8k commits), flutter (16k files, 92.7k commits), tensorflow (38k files, 204k commits), GitViz (145 files). There was no 100k-file repo; tensorflow is the large end.

All four spike agents and my own benchmark shared the CPU at times, so parallel numbers may be 10–15% pessimistic. Each spike folder has a `RESULTS.md` with method and caveats.

## Verdicts

| Spike | Question | Verdict |
|---|---|---|
| 1. Fast pass ([scan/](../spikes/scan/RESULTS.md)) | Index read + import scan across workers | **Pass.** react 0.8 s, flutter 2.2 s, tensorflow 3.0 s with 14 workers. Plain TypeScript; per-file I/O dominates, not scanning. |
| 2. Slow pass ([treesitter/](../spikes/treesitter/RESULTS.md)) | tree-sitter WASM within the 30 s reveal budget at 10k files | **Pass on this machine.** react 2.3 s, flutter (Dart) 8.3 s, tensorflow 12.7 s. Projected ~21 s for a Dart-heavy 10k repo on a 4-core laptop (not measured). |
| 3. Git history ([git/](../spikes/git/RESULTS.md)) | Pure-TS pack walker fast enough for overlays | **Pass.** Output identical to `git log` on every path of all four repos. react 2.5 s, flutter 8.8 s, tensorflow 52 s (Node). Browser estimated ~2.6 / 11 / 70 s. |
| 4. Render ([render/](../spikes/render/RESULTS.md)) | 60 fps at 10k, usable at 100k | **Pass on a discrete GPU** (~1–2 ms GPU per frame at 10k). 100k works only with the edge budget. **Integrated graphics still untested.** |
| 5. Physics ([physics/](../spikes/physics/RESULTS.md)) | d3-force in a worker, SharedArrayBuffer, settle time | **Partial.** Worker and SharedArrayBuffer work. Settle at 10k: 3.2 s with stock d3 (misses the 3 s budget), **0.7 s with a custom spatial-hash collide**. 100k: 11–13 s single-worker. |

**Rust/WASM:** not needed anywhere at S and M. The TypeScript-first decision holds.

## Plan changes these results call for

1. **Worker pool sized by physical cores**, not `hardwareConcurrency` (14 workers gave ~7×, not 14×). Add a memory cap: 14 tree-sitter workers peaked at 0.8–1.9 GB in Node.
2. **tree-sitter:** call `tree.delete()` after every file (otherwise ~700 MB on react). Use `@repomix/tree-sitter-wasms` grammars with `web-tree-sitter` 0.27; Kotlin and Obj-C grammars need another source. Parse Flow-typed `.js` with the TSX grammar (70% fewer errors on react). Budget download: all 14 grammars are 1.4 MB brotli.
3. **Edge-quality risk is concrete:** syntax errors in 29% of tensorflow C++, 16% of flutter Dart, 24% of react JS (Flow). Fixture tests for edges matter for those languages.
4. **Physics:** replace `forceCollide` with a spatial-hash collide (already written in the spike). Default `sizeVsConnectivity` to ~0.8 (0.5 leaves 11–17% of files overlapping at 10k after settling). The "hot sim" rule must include `alphaTarget`. For user-triggered updates, pin unaffected cities and districts instead of reheating them. Persist positions; re-simulation is not reproducible across engines.
5. **L-size settle:** parallelise file sims across workers or accept a partial settle; a single 2.4k-node file sim tick (10–20 ms) also overruns the 8 ms slice.
6. **Rendering:** the corona needs a second draw over the same instances (single draw cuts crescents into spheres behind). Reorder §8.5 degradation: **edge budget first, then pixel ratio**; particles, corona and territory resolution cost almost nothing. Edge level-of-detail is also needed for readability at M, not just performance.
7. **Star look:** the white core currently reads as a glossy marble on white (see `render/closeup-10k-split.png`). Needs a larger, warmer core and a ring brighter than the body; ground light matters more than corona.
8. **Git history:** default `history.maxCommits` 50,000 with a "load full history" action and a ~20 s time budget; two-generation object cache 16–32 MB; 256 KB page cache for reads; cap co-change pairs (~1M).
9. **Decision needed: merge commits.** Diffing every commit against its first parent credits a merge with everything its branch brought in (double counting, and the merge date wins "last modified"). Options: skip merges, walk the mainline only, or keep it.

## Still not measured

- Integrated graphics (the §15 render target).
- Browser File System Access read cost per file. `fsa/` is a ready page: `npx vite --config fsa/vite.config.ts`, open http://localhost:5183, pick a repo folder.
- The git walker end to end in a browser on a disk-backed file (only per-read cost was measured).
- A 4-core laptop for the slow pass; a real 100k-file repo.
- Vercel deployment with COOP/COEP headers; Safari and Firefox.
- Real repo graphs in the physics spike (graphs were synthetic).
