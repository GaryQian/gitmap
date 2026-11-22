# Implementation plan: M1–M6

How to build what [PLAN.md](PLAN.md) describes, as fast as possible, using parallel subagents. The aim is a working app early that we then iterate on, not a finished one late.

## 1. Approach

1. **Contracts first, then fan out.** One short serial round freezes the shared types and module interfaces. After that, every work package codes against an interface and a fake, never against another package's unfinished code.
2. **One owner per folder.** Each package owns a set of folders outright. No two agents edit the same file in the same round.
3. **Thin end to end before wide.** M1 ends with a real folder turning into settled spheres on screen. Everything later widens that path.
4. **Schedule by dependency, not by milestone number.** Language plug-ins, the history walker and the AI server depend only on contracts, so they start while M2 is still being built (§7).
5. **Integrate after every round.** The lead session merges, wires, runs the checks and fixes seams before the next round starts.
6. **Minimum tests now, hardening later.** Tests cover what must be true for the app to be correct. Anything we expect to tune is left untested on purpose (§3).

## 2. How parallel work is run

- **One subagent per work package**, each in its own git worktree on a branch named `wp/<id>` (for example `wp/1c-git`). The lead merges branches in the order given per round.
- **Each agent's brief contains:** the goal in two sentences; the folders it owns; the contracts it implements and consumes; spike code to port, by path; the tests it must add; what is out of scope; and "done" as an observable check.
- **Shared files belong to the lead:** `package.json`, `config.json`, `src/contracts/**`, `src/model/types.ts`. An agent that needs a change there writes it to `CHANGES.md` in its worktree and codes against a local shim; the lead applies it at integration.
- **No shared registries.** Language plug-ins and overlay definitions are discovered with `import.meta.glob`, so adding one never touches a common file.
- **Every contract ships with a fake** (in-memory store, synthetic model, scripted pool, canned provider) in `src/testing/`, so a package runs and tests alone.
- **Done means:** `npm run check` (typecheck, lint with the folder-boundary rule, unit tests) passes in the worktree, and the package's own "done" check holds.
- **Concurrency:** rounds below list up to about 20 packages. They can all run at once or in batches of 6–8; the grouping does not change.

## 3. Test policy for this pass

**Go light in this pass (decided 2026-11-21).** The aim is to stay nimble and catch large regressions, not to pin behaviour. Each package ships a handful of tests: one or two that prove its main path works end to end, plus any property that would silently corrupt the map if it broke. The table below is the menu to pick from, not a checklist to complete. The fuller suite is written in the final step after M6 (§6, "Final step").

**Tools:** Vitest for unit and pipeline tests in Node. Playwright for one browser smoke test per milestone, from M1.

**The pipeline runs headless in Node** (parse → resolve → cluster → settle → snapshot). This is what makes tests fast, and the demo build script needs it anyway. Browser-only pieces sit behind `ContentSource`, `GitFs` and the pool, each with a Node implementation.

**Test now — things that are facts, not taste:**

| Area | Core tests |
|---|---|
| Git access | Index parse (v2 and v4) equals `git ls-files`; packed blob equals the committed file; delta chains resolve |
| Scanners and resolvers | Per language, a small fixture repo with the expected import and call edges |
| Bridges | JNI name mangling round-trips; one Java↔C++ fixture; one Protobuf stub fixture |
| Model | Applying patch batches one by one equals a rebuild from scratch (property test); a revision gap triggers resync; invalid proposals are rejected; snapshot round-trips |
| Clustering | Districts nest inside cities; same seed gives same result; orphan files join their folder's community |
| Importance | Percentiles are monotonic in rank; a file with more dependents never ranks below one with a subset of them |
| Physics | Every sim reaches rest; districts stay inside their city; same input gives same layout; Reset returns to home positions |
| Scheduler | Higher lane always wins; idle workers take lower-lane tasks; parse keeps its floor |
| Reveal gate | State machine transitions, including the 30-second escape hatch, with a fake clock |
| History | Per-file last-modified, commit count and author counts equal values derived from `git log` on a scripted fixture repo |
| Overlays | Layer values from fixture facts; Reach hop counts; test-file classification |
| Content | Demo zip entry read by range equals the original file; hash verification catches a mismatch |
| AI | Schema validation, unknown-reference filtering, digest budget shares, deterministic selection — all against a canned provider, no network |

**Deliberately not tested yet** (we expect to change these):

- Any visual constant: colours, radii, opacities, timings, particle counts, font sizes.
- Exact layout coordinates, exact city and district names, exact city counts (tests read the formula from config and allow a tolerance).
- Force strengths and other tuning values. Overlap after settling is *reported* by the physics test, not asserted.
- Copy and labels. No DOM snapshot tests, no pixel comparisons.
- Performance numbers. Benchmarks print results; nothing fails on a threshold until the hardening pass.

Tests read tunable values from `config.json` instead of repeating them, so retuning does not break the suite.

## 4. M0 findings built in from the start

From [M0-RESULTS.md](M0-RESULTS.md). PLAN.md was updated to match these on 2026-11-21.

| Finding | What we build |
|---|---|
| 14 workers gave ~7× on 8 physical cores | Pool size defaults to half of `hardwareConcurrency`, with a memory cap |
| Stock `forceCollide` misses the settle budget (3.2 s at 10k); spatial-hash collide takes 0.7 s | Port the spike's spatial-hash collide; do not use `forceCollide` |
| tree-sitter leaked ~700 MB without cleanup | Call `tree.delete()` after every file |
| Grammar sources | `web-tree-sitter` 0.27 with `@repomix/tree-sitter-wasms`; Kotlin and Obj-C grammars from another source; parse Flow-typed `.js` with the TSX grammar |
| Corona drawn in one pass cuts into spheres behind | Three draws over the same instances: bodies, then glows, then ground light (PLAN.md §8.6) |
| White core read as a glossy marble | Superseded by the star look in `spikes/render/main.ts` (PLAN.md §8.6): no light direction, highlight or silhouette; an exposure-curve core; glow that starts at the edge; ground light. Port that shader as is. |
| 50,000 ambient connections buried the stars | Ambient file-to-file edges default to 1,500 (`render.ambientEdges`); hover and selection draw the rest |
| Edge budget is the real performance lever | Degradation order: edge budget, then pixel ratio; particles and corona are nearly free |
| A "hot" sim must count `alphaTarget` | Scheduler treats a sim as hot while `alpha` or `alphaTarget` is above the minimum |
| Reheating everything on an update is wasteful | On Apply or Update, pin unaffected cities and districts |
| Re-simulation is not reproducible across engines | Always persist positions; never rely on re-simulating to restore a layout |
| Browser working-tree reads cost ~2.2 ms per file, and 14 workers gave only 3.1× (react: 10.8 s on 1 worker, 3.5 s on 14) | Pack-first blob reading (1C); each file read once and shared by the fast and slow passes (2B) |
| History defaults | `history.maxCommits` 50,000 with a ~20 s time budget and a "Load full history" action; 256 KB page cache |

Three findings need a decision from you and have a working default meanwhile (§8).

## 5. Round 0 — contracts (lead, serial)

Small on purpose. Nothing here is clever; it exists so sixteen agents can start at once.

| Deliverable | Contents |
|---|---|
| Scaffold | Vite + React + TypeScript strict, Vitest, Playwright, ESLint with the folder-boundary rule, `vercel.json` with COOP/COEP headers, `npm run check` |
| `config.json` + `src/config/` | The config from PLAN.md §13 with a typed, validated loader |
| `src/model/types.ts` | `RepoModel`, `NodeRef`, `ModelPatch`, `PatchBatch`, `Layer`, annotation shapes |
| `src/contracts/` | `ModelStore`, `ComputePool` and task/lane types, `LanguagePlugin`, `GitFs`, `ContentSource`, `PhysicsApi`, `RenderApi`, `PipelineEvents`, `AiProvider` |
| `src/testing/` | Synthetic model generator (from `spikes/physics/graph.ts`), in-memory `GitFs` and `ContentSource`, scripted pool, a script that builds tiny fixture repos with a real `.git` and scripted commits |
| Dev harness | A `/dev` page that loads a synthetic model or a saved snapshot straight into the renderer, so visuals can be iterated without parsing anything |

**Exit:** `npm run check` passes on the empty skeleton; the fixture script produces a three-language repo; `/dev` shows a blank canvas.

**Folder layout.** The folders named below are finer-grained than the module table in PLAN.md §4 (for example `src/git/`, `src/lang/<id>/`, `src/pipeline/`, `src/content/`), so that each package owns a folder outright. The module boundaries and their rules are unchanged; PLAN.md §4 is brought in line at the first integration.

**Contract changes after Round 0** (decided 2026-11-21; `src/model/types.ts` still has the old shapes):

- `Poi.parent` is a unit ref (one file's sphere), never a district or city.
- `TourStep.target` becomes `parent`, a unit ref, and gains `frame: 'file' | 'district' | 'city'`; `highlights` are unit refs.
- `structure: 'imports-only'` is renamed `'provisional'`, since that clustering also uses whatever call edges were found.

## 6. Work packages

`Depends` lists packages whose *merged code* is needed. Everything else is consumed through contracts and fakes, and can run in parallel.

### M1 — Skeleton: a folder becomes settled spheres

| ID | Package | Owns | Ports from | Core tests |
|---|---|---|---|---|
| 1A | Model store | `src/model/` (not `types.ts`) | — | Patch equivalence, revision gap, validation, round trip |
| 1B | Compute pool | `src/compute/` | — | Lane order, work-conserving, floor (scripted workers) |
| 1C | Git access | `src/git/` | `spikes/scan/gitindex.ts`, `spikes/git/core/{odb,fs}.ts` | Index vs `ls-files`; blob vs file; deltas; loose objects; two packs with a cross-pack delta; working-tree result not cached under the index OID when the hash differs |
| 1D | Fast pass + three plug-ins | `src/ingest/`, `src/lang/{ts,python,cfamily}/` | `spikes/scan/scanner.ts` | Imports per fixture |
| 1E | Resolve, units, importance | `src/analysis/` | — | Resolved edges on fixtures; percentile properties |
| 1F | Physics core | `src/physics/` | `spikes/physics/` (worker, buffers, spatial-hash collide) | Reaches rest, no city overlap, deterministic |
| 1G | Render core | `src/render/core/`, `src/render/spheres/`, `src/render/background/` | `spikes/render/` | Radius formula, slot writes (pure functions only) |
| 1H | App shell | `src/app/` | — | None beyond typecheck |

- **1C** reads every pack plus loose objects (`spikes/git/core/odb.ts` already does both) and ports the pack-first blob reader from `spikes/io/packblobs.ts`. The working tree is a last resort and is hash-checked (PLAN.md §6.3.1).
- **1E** uses top-level folders as placeholder cities. Real clustering replaces it in 2A.
- **1G** includes the wisp background, both colour modes, the two-draw star look, basic pan and zoom, and the grow-in reveal.
- **1H** includes theme tokens, fonts, the landing page, the waiting screen, the title and progress pills, and the settings card.

**Integration 1I (lead):** `src/pipeline/` — the coordinator and its state machine (manifest → fast pass → resolve → cluster → settle → reveal), wiring store, pool, physics and renderer; `scripts/parse.ts` running the same pipeline in Node to produce a snapshot.

**Exit:** choose a real folder in Chromium and see spheres grouped by top-level folder, sized and glowing, in both modes. Playwright smoke: `/dev` with the fixture snapshot shows the expected number of spheres.

### M2 — Hierarchy and physics: first showable version

| ID | Package | Owns | Depends | Core tests |
|---|---|---|---|---|
| 2A | Clustering | `src/analysis/cluster/` | 1E | Nesting, determinism, orphan handling, count within tolerance of the config curve |
| 2B | Slow pass | `src/ingest/syntax/`, query files in the three `src/lang/*` | 1D | Definitions and references on fixtures |
| 2C | Symbol linking + header pairing | `src/analysis/link/` | 1E | Call edges on fixtures; pairs found |
| 2D | Physics tiers | `src/physics/` | 1F | District containment, Reset to home; overlap reported |
| 2E | Scene rendering | `src/render/territory/`, `src/render/edges/`, `src/render/particles/` | 1G | Level-of-detail choice, ribbon aggregation, budget ordering |
| 2F | Interaction | `src/render/interaction/` | 1G | Picking, marquee, orbit pivot, jiggle settles and clamps |
| 2G | Chrome | `src/app/` | 1H | Slider threshold with glow exemption; selection state |
| 2H | Reveal gate | `src/pipeline/gate/` | 1I | Transitions with a fake clock, including the escape hatch |

- **2B** also keeps each file's signatures and leading doc comments, which the AI digest needs in M5.
- **2B reads each file once.** The slow pass takes the bytes the fast pass already obtained (pack blob or working-tree file) instead of fetching them again: either both passes run in the same pool task per batch, or the fast pass keeps the batch's bytes for the slow-pass task. A second read of every file would cost about 3.5 s more on react and 7–8 s at 10k files when it falls back to the working tree (`spikes/bench/RESULTS.md`).
- **2D** adds district and file sims, Voronoi cells, containment, space propagation, drag and release, home positions and `resetLayout()`.
- **2G** adds the in-scene pill pool, tooltip and detail card, selection pills, the legend with its slider, the controls key and the Reset view pill.
- **2H** includes the "Refined structure ready · Apply" action and its animated re-layout.

**Integration 2I (lead):** wire real clustering and call edges into the pipeline; fixture repo end to end in the browser through a test hook; run the 10k synthetic model and record frame time and settle time.

**Exit:** the first showable version from PLAN.md: cities, districts, dragging, hover, selection, ribbons, legend and slider, for TS/JS, Python and C/C++.

### M3 — Parser breadth, persistence, demo

**Language plug-ins: one agent each, fully independent.** Each owns `src/lang/<id>/` and `fixtures/<id>/`, and delivers a scanner, a tree-sitter query, a resolver and a fixture repo with expected edges.

| ID | Languages |
|---|---|
| 3A | Java, Kotlin, Scala (one shared JVM namespace) |
| 3B | C# |
| 3C | Go |
| 3D | Rust |
| 3E | Dart |
| 3F | Swift |
| 3G | Objective-C (extends the C-family plug-in) |
| 3H | PHP |
| 3I | Ruby |
| 3J | Vue, Svelte, Astro, CSS/SCSS, HTML |

| ID | Package | Owns | Depends | Core tests |
|---|---|---|---|---|
| 3K | Bridges: JNI, Protobuf stubs | `src/bridges/` | 3A to verify | Mangling round trip; two fixtures |
| 3L | Persistence | `src/persist/` | 1A | Snapshot round trip through OPFS fake; facts cache keyed by OID |
| 3M | Update flow | `src/pipeline/update/` | 3L, 2H | Changed-OID diff yields the right re-parse set; working-tree check flags an edited file and ignores one whose timestamp changed but whose hash did not |
| 3N | Demo and export | `src/content/`, `scripts/build-demo.ts`, landing repo pills in `src/app/landing/` | 1I | Zip entry by range equals the file; hash mismatch detected |
| 3O | Sidebar reader | `src/app/sidebar/` | — | None beyond typecheck |
| 3Q | Folder walk | `src/ingest/walk/` | 1D | Gitignore matcher against `git check-ignore` on a fixture; plain folder yields the same file list as the index for a clean repo |

- **3O** moves here from M4, because viewing files in a demo needs it.
- **3Q** covers what the git index cannot: plain folders with no `.git`, the optional untracked-files setting, and the drag-and-drop path used outside Chromium.
- **3N** includes `DirectorySource`, `DemoSource`, export and import, and the repo info card.

**Integration 3P (lead):** choose the two demo repos and build them; deploy a preview and confirm range requests and the COOP/COEP headers work on Vercel; smoke test opens a demo and reads one file.

**Exit:** all planned languages parse; a repo reopens instantly; a demo loads and its files open in the sidebar.

### M4 — History and overlays

| ID | Package | Owns | Depends | Core tests |
|---|---|---|---|---|
| 4A | History walker | `src/history/` | 1B, 1C | Aggregates equal `git log` on a scripted fixture; incremental walk equals full walk |
| 4B | Scheduler upgrades | `src/compute/` | 1B | Overlay promotion, floor, parking |
| 4C | Layers and overlay rendering | `src/analysis/layers/`, `src/render/overlay/` | 1G | Layer values, Reach hops, test-file classification |
| 4D | Overlay UI | `src/app/overlays/` | 2G | Contributor ordering and fuzzy match |
| 4E | Search | `src/app/search/`, `src/search/` | 2F | Ranking sanity on a fixed path list |

- **4A** ports `spikes/git/core/history.ts` into chunked pool tasks with a planner, the commit-graph reader and `.mailmap`.
- **4C** includes layer states (pending, partial, complete) and the "not yet known" style.
- Blame for a single file is a stretch item for 4A, not required for exit.

**Exit:** Recency, Ownership, Knowledge risk, Tests and Reach work, fill in progressively, and take priority when selected.

### M5 — AI

| ID | Package | Owns | Depends | Core tests |
|---|---|---|---|---|
| 5A | Server and provider | `api/ai/`, `src/ai/server/` | — | Schema validation, reference filtering, caps (canned provider) |
| 5B | Digest builder | `src/ai/digest/` | 2B | Budget shares; determinism; exclusions; a secret-named file and a key-shaped string never appear in any output |
| 5C | Client orchestration | `src/ai/client/` | 5A, 5B contracts | Sequence with a fake server; cache hit by digest hash |
| 5D | Points of interest | `src/render/poi/`, `src/app/poi/` | 2G | None beyond typecheck |
| 5E | Tour | `src/app/tour/` | 2F | Step sequencing |
| 5F | Demo pre-generation | `scripts/build-demo.ts` | 3N, 5C | — |

- **5A** loads the `claude-api` skill before writing any SDK code, and uses structured outputs, not forced tool calls.
- **5C** includes the consent prompt and the summaries → points of interest + tour sequence. It starts only when the parse has finished, never on a provisional structure.
- **5D and 5E** attach every point of interest and tour step to a file; **5A** rejects any other parent.

**Exit:** on a consented repo, beams and a tour appear; a demo shows both with no key.

### M6 — Polish and the hardening pass

| ID | Package |
|---|---|
| 6A | Adaptive quality and the 100k-file degradation path |
| 6B | Visual tuning in both modes; reduced motion |
| 6C | Error and empty states; the non-Chromium path; permission flows |
| 6D | Keyboard access and accessibility of the DOM layer |
| 6E | Benchmarks, including integrated graphics and the browser read paths |
| 6F | Test hardening: lock the decisions that have settled |

### Final step — more tests

After M6, once behaviour has settled. Work through the "Test now" table in §3 and fill what the light first pass skipped: the per-language edge fixtures, the patch-equivalence property test at full strength, scheduler and reveal-gate edge cases, history against `git log`, content hashing, the AI validation paths, and a Playwright smoke test per milestone. 6F (locking settled decisions) folds into this step.

## 7. Launch order

Four rounds of parallel work, each followed by integration.

| Round | Runs in parallel | Why now |
|---|---|---|
| **0** | Contracts (lead only) | Everything else needs them |
| **1** | 1A–1H | The skeleton |
| **2** | 2A–2H, **plus** 3A–3J, 4A, 5A | Language plug-ins need only the plug-in contract that 1D proved; 4A needs only the pool and git access; 5A needs nothing |
| **3** | 3K–3Q, 4B–4E, 5B | Need M2's pipeline, chrome and slow pass |
| **4** | 5C–5F, then 6A–6F | Need the AI contracts filled and a complete app to polish |
| **5** | Final step: more tests | Needs settled behaviour to lock down |

The lead commits and pushes after each round's integration.

**Critical path:** Round 0 → 1D/1E/1F/1G → integration 1I → 2A/2D/2E/2F → integration 2I. That chain produces the first showable version; everything else hangs off it and cannot delay it.

**To iterate soonest:** after Round 1, the `/dev` harness plus `scripts/parse.ts` already allow tuning visuals and physics on real repos, while Round 2 is running.

## 8. Decisions that are open but do not block

Each has a default so work proceeds. All are config values.

| Question | Default for now | Why it is a question |
|---|---|---|
| File placement: size vs connectivity | `0.5`, as you specified | The spike found 0.5 leaves 11–17% of files overlapping at 10k after settling and suggests ~0.8. The physics test reports overlap so we can decide with numbers. |
| Merge commits in history | Skip them | Diffing a merge against its first parent credits it with everything the branch brought in and makes its date win "last modified". The alternatives are walking the mainline only, or keeping the double count. |
| History depth | 50,000 commits with a ~20 s budget | PLAN.md originally said 20,000; the spike recommends 50,000 plus a "Load full history" action, and PLAN.md now uses that. |
