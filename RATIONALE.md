# Starmap: design rationale

**Theme 1, Exploration & Understanding.** Starmap draws a codebase as a 3D star map in the browser, so you can see how it is organised before you read any of it.

- Prototype: <!-- TODO: deployed URL -->
- Code: https://github.com/GaryQian/starmap
- Transcripts: [transcripts/](transcripts/)
- Time spent: <!-- TODO: confirm. Commits span 13:50 to 22:11 on 2026-11-21, about 8 hours including planning. -->

To try it, open the prototype and click one of the demo pills (Starmap itself, React, or TensorFlow). Nothing needs to be installed or supplied. To map your own code, click **Choose a folder** in a Chromium browser and pick a local git repo.

## Why this theme and this approach

The first hours in an unfamiliar codebase go to building a mental map: what the major parts are, which files everything leans on, and where to start reading. The folder tree is the usual stand-in for that map, but it shows how files are named, not how they depend on each other.

Starmap builds the map from the code itself. Each file is a star, sized by its length and by how much of the repo depends on it. Files that depend on each other are grouped into districts and cities by community detection on the dependency graph, so the layout shows the actual structure. Overlays then recolour the same map to answer other questions: what changed recently, who owns what, where knowledge sits with one person, what the tests cover, and what a selected file reaches.

## What is interesting or non-obvious

- **It runs entirely in the browser.** Parsing, clustering, git history and physics all run in web workers on the user's machine. Code is never uploaded, which is what makes it reasonable to point at a private repo. The only exception is the optional AI notes, which ask once per repo.
- **The file list comes from `.git/index`, not from crawling.** One file gives every tracked path, blob hash and size. Ignored folders are never opened, the total work is known up front, and the blob hash is a free cache key. File contents are read straight from the packfile.
- **Structure comes from the dependency graph, not the folders.** tree-sitter extracts definitions and call sites for 21 languages, so files that use each other without importing each other are still linked. PageRank gives importance; Louvain gives cities and districts.
- **The map appears settled and then stays put.** A map that reshuffles as data arrives cannot be learned. Nothing is drawn while parsing; the layout settles off screen and is revealed once, and afterwards it only moves when the user asks ("Update", "Apply", or dragging a label).
- **AI annotates the map; it does not draw it.** The structure is computed deterministically. The model writes city summaries, points of interest and a guided tour on top, each attached to a specific file, so its claims can be checked against the code beside them.

## Key decisions and tradeoffs

| Decision | Tradeoff |
|---|---|
| Client-side only, no backend except a thin AI proxy | Private by default and trivial to deploy, but needs cross-origin isolation headers and is Chromium-first (Firefox and Safari get drag-and-drop and the demos). |
| Reveal only at a stable point | The user waits behind a progress screen (seconds at 10k files) instead of watching the map form. A 30 s escape hatch shows a provisional map on slow machines. |
| Name-based call edges with a stored confidence | Architecture-grade, not compiler-exact. Good enough to cluster on; wrong in known cases, such as macro-heavy C++ and Rust. |
| Ownership by share of commits, not line blame | Line-level blame over full history is too slow in a browser. True blame would be on demand per file. |
| Design for 1k to 10k files; 100k must merely work | At 100k files the reveal takes around 30 s and edges are budgeted. Excellent at the common sizes mattered more. |
| Positions composed on the GPU as city + district + file | Dragging a city updates one texel and everything follows, at the cost of a more involved shader and data-texture pipeline. |
| TypeScript throughout, no Rust/WASM of my own | Five measurement spikes ran before the build ([plan/M0-RESULTS.md](plan/M0-RESULTS.md)) and showed TypeScript was fast enough, with one exception: stock d3 collision missed the settle budget, so it was replaced by a spatial-hash version. |
| Demos are exported packages of real repos | The reviewer sees real maps of real code with AI notes already written, and a demo makes no model calls. |

## How I used AI

I wrote the product spec and reviewed an architecture plan with Claude before any code existed ([plan/PLAN.md](plan/PLAN.md) records each decision and each conflict in my spec and how I resolved it). Risky assumptions were measured in throwaway spikes first, and the plan was changed where the numbers disagreed. The build was then split into rounds of parallel subagents, each owning one folder, coordinating only through typed contracts in `src/contracts/` and a lint rule that forbids reaching into another module. That structure is what let many agents work in one checkout without collisions. I steered throughout on scope (light tests first, stop when done), on visual taste (sizing formula, neutral background, dark by default), and on bugs I hit while using it.

## With more time

- **Finish the large-repo work.** Adaptive quality, district-level aggregates and staged scene builds are written but switched off because they were never verified. Layout settle at 100k files overruns its budget.
- **Better edges.** Known gaps: same-package calls in Go, calls inside Rust macros, and names imported from outside the repo being linked to in-repo definitions. Compiler-backed resolution per language (for example via LSIF/SCIP) would replace name matching.
- **Time as a dimension.** The history is already walked; scrubbing the map through time would show how the architecture grew.
- **Diff and review mode.** Light up the files a pull request touches and everything they reach.
- **Open a repo by URL**, so a public GitHub repo can be mapped without cloning it.
- **Light mode and a touch layout**, both currently off.
- **Verification on more hardware.** Integrated graphics, 4-core laptops, Firefox and Safari are largely untested.
