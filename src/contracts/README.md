# How the code is organised

Read this before working on any package. The design is in [plan/PLAN.md](../../plan/PLAN.md); the work breakdown is in [plan/IMPLEMENTATION.md](../../plan/IMPLEMENTATION.md).

## Layout

| Folder | What it is | Owner |
|---|---|---|
| `src/contracts/` | Interfaces every module codes against | lead |
| `src/model/types.ts` | The data model and the patch protocol | lead |
| `src/config/` + `config.json` | Typed config; every tunable value lives in `config.json` | lead |
| `src/shared/` | Small pure helpers (seeded RNG, `unitRadius`, paths, `Emitter`, colours) | lead |
| `src/testing/` | Fakes and generators so a package runs alone | lead |
| `src/lang/index.ts` | Language plug-in registry (discovers `src/lang/<id>/index.ts`) | lead |
| `src/pipeline/`, `src/dev/`, `scripts/` | Integration: coordinator, `/dev` harness, Node scripts | lead |
| everything else | One work package owns each folder outright | see IMPLEMENTATION.md §6 |

Each module's `index.ts` is its public surface. Round 0 left a stub there with the agreed signatures; the owning package replaces the stub and keeps the signatures.

## Rules

1. **Stay in your folders.** Do not edit lead-owned files or another package's folder. If you need a change there (a new config value, a contract tweak, a dependency), work around it locally and list it under "Requested changes" in your final report.
2. **Import other modules only through their public files**: `index.ts` (and `node.ts`, `types.ts`, `worker.ts` where they exist). `contracts/`, `shared/`, `testing/` and `config/` may be imported file by file. ESLint enforces this (`starmap/module-boundary`).
3. **No shared registries.** Language plug-ins (`src/lang/<id>/index.ts`), pool tasks (`**/*.task.ts`, default-exporting `defineTask({...})`) and app features (`src/app/<feature>/mount.tsx`) are discovered with `import.meta.glob`.
4. **Tunables come from `config`** (`import { config } from '../config'`), never repeated as literals. Tests read them from there too.
5. **Browser-safe by default.** Anything importing `node:*` goes in a `node.ts` entry or a test/script, never in a file the browser bundle reaches.
6. **Never run `npm install`.** `node_modules` is shared. Every dependency you are likely to need is already installed (see `package.json`); if one is missing, request it.
7. **Tests are light in this pass**: a handful per package, aimed at large regressions and at anything that would silently corrupt the map. No snapshot tests, no pixel tests, no assertions on tunable values or timings. Tests sit beside the code as `*.test.ts` and run in Node with Vitest.
8. **One checkout, many hands.** Packages of a round are built at the same time in this working tree, with no branches. Never run a git command that changes state (`add`, `commit`, `stash`, `checkout`, `restore`, `reset`, `clean`); the lead commits to `main` after each round. Other packages may be half-written while you work: their `index.ts` can still be a stub that throws, and `tsc` may report errors in their folders.
9. **Done means** your scoped checks pass and the package's own "done" check holds: `npx vitest run <your folders>`, `npx eslint <your folders>`, and `npx tsc --noEmit` with no errors in your folders. The lead runs `npm run check` on the whole tree at integration.
10. **Looking at the page.** A dev server for this checkout is already running at `http://localhost:5175` (do not stop it or start another on that port). `node scripts/shot.mjs <url> out/shots/<name>.png` saves a headless-Chromium screenshot you can open, and prints console errors. `out/` is gitignored.

## The data flow in one paragraph

Producers (ingest, analysis, history, AI) *propose* `ModelPatch` operations to the one `ModelStore`. The store validates them, assigns slots and a revision, and emits a `PatchBatch`. Every consumer (the main-thread `ModelReplica`, the renderer, the physics engine) applies the same batches in the same order; a revision gap means "resync from a full batch". Positions are not patches: physics writes them into `PositionBuffers`, indexed by the same slots, and the renderer reads them. Ids are permanent strings (file id = path, unit id = its primary file's path); slots are dense per-session integers used only to index buffers.

## What exists to code against

- `createReplica()` from `src/model` — a working replica.
- `syntheticTables()`, `syntheticBatch()`, `tablesToOps()` from `src/testing/synthetic` — a plausible model of any size.
- `createStaticPhysics()` from `src/testing/staticPhysics` — positions without a simulation.
- `createFakeSession()`, `createNoopRenderer()` from `src/testing/fakeSession` — a whole fake pipeline for UI work.
- `MemoryWorkingTree`, `MemoryGitFs`, `memoryRepo()`, `MemoryContentSource`, `createFakePool()` from `src/testing/memory`.
- `buildFixtureRepo('three-lang')`, `fixtureFiles()`, `fixtureExpected()` from `src/testing/fixture` (Node only) — a real `.git` with scripted commits, part packed and part loose. Expected edges are in `fixtures/three-lang/expected.json`.
- `runQuery(grammar, query, text)` from `src/testing/treesitter` (Node only) — check a tree-sitter query.
- `/dev.html?n=10000` — the dev harness: a synthetic model straight into the renderer.
- `node scripts/run.mjs scripts/<name>.ts` — run a script with the app's module graph (`import.meta.glob` works).

## Conventions

- Ground plane is XZ, Y is up. Physics is 2D: its `(x, z)`. A sphere's centre sits at `y = radius`.
- `unitRadius(loc, importancePct, config.visual)` in `src/shared` is the one definition of sphere size.
- Paths are repo-relative with `/` separators and no leading slash, on every platform.
- Workers are ES modules: `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
- Colours and chrome: dark mode is the default; background and chrome stay neutral gray with blue and warm accents. No purple outside the visualization itself.
