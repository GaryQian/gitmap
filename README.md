# Starmap

Starmap draws a codebase as a 3D star map in the browser. Each file is a star resting on a plane, sized by its length and importance. Files that depend on each other are grouped into districts, and districts into cities, so the map shows how the code is actually organised rather than how its folders are named. Connections between files are drawn as arcs carrying pulses from the file that depends to the file it depends on.

On top of the map you can switch on overlays (how recently each file changed, who owns it, where knowledge is concentrated, what the tests cover, what a selection reaches), search for files, read them in a sidebar, and optionally have an AI model write city summaries, points of interest, a guided tour and answer questions about the repo.

Everything heavy runs in your browser, in background workers. Your code is read from the folder you choose and is not uploaded, with one exception: the optional AI notes, which send excerpts to a model provider only after you allow it for that repo.

## Quick start

You need Node.js (developed and tested on Node 24) and a Chromium-based browser (Chrome, Edge, Arc, Brave).

```bash
npm install
npm run dev
```

Open the URL the dev server prints (http://localhost:5173 unless that port is taken), click **Choose a folder**, and pick a folder that contains a `.git` directory. The map appears once the files are parsed and the layout has settled; nothing is drawn while it parses.

Things worth knowing:

- **Chromium first.** Choosing a folder uses the File System Access API. In Firefox and Safari you can drag a folder onto the page instead; the folder cannot be remembered between visits there.
- **Git repos work best.** The file list and file contents come from `.git`, and the history overlays need it. A plain folder still maps, without history overlays.
- **Return visits are instant.** A parsed map is saved in the browser. Reopening the same repo shows the saved map and offers "N files changed · Update" if the repo moved on.
- **Desktop only.** Mouse and keyboard; there is no touch layout.
- **Reload after a dev-server restart.** If a tab is open when the dev server restarts or rebuilds its dependencies, background workers can fail to load ("compute worker failed" or "The background worker stopped unexpectedly"). Reload the page.

### Controls

| Input | Action |
|---|---|
| Drag | Pan |
| Wheel | Zoom toward the cursor |
| Middle-drag or Space+drag | Orbit |
| Hover a star | Tooltip and that file's connections |
| Click | Select; Shift+click adds or removes |
| Shift+drag | Select a rectangle |
| Double-click | Open the file in the sidebar |
| Drag a city or district label | Move it |
| Home, or "Reset view" | Return the camera and the layout to where they settled |

## AI notes (optional)

AI features need a model provider key on the server side. Without one the app works normally and the AI features stay off.

1. Copy `.env.example` to `.env.local` in the repo root.
2. Set a key:
   - Anthropic (the default): `ANTHROPIC_API_KEY=...`
   - OpenAI: `VITE_AI_PROVIDER=openai` and `OPENAI_API_KEY=...`
3. Restart the dev server.

`.env.local` is git-ignored, and the key is only read by the server routes under `/api/ai`; it is never sent to the browser. Model names per task are in `config.json` under `ai`.

The app asks once per repo before sending anything. **Allowing it makes paid API calls** with your key: one small call per city for summaries, then points of interest and the tour, and one call each time you open a detail card or send a chat message. It can be switched off per repo in the settings card.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server (also serves `/api/ai/*` locally) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run check` | Typecheck, lint and unit tests |
| `npm run test` | Unit tests only (Vitest) |
| `npm run e2e` | Browser smoke tests (Playwright). Run `npx playwright install chromium` once first |
| `npm run parse -- <folder>` | Run the whole pipeline headless in Node and write a snapshot to `out/` |
| `npm run build-demo -- <clone>` | Package a local clone as a demo file, without AI notes |
| `npm run bench:pipeline -- <folder>…` | Per-stage timings of the headless pipeline |
| `npm run bench:layout -- <snapshot>` | Cluster sizes and layout quality for a snapshot |

For working on visuals without parsing anything, open `/dev.html?n=10000` on the dev server: it loads a synthetic model of that many files straight into the renderer.

## Demos

A demo is one packaged file, `<name>.starmap.zip`, holding the map and the text of its files. Demos are listed in `config.json` under `demo.repos` and served from `public/demo/`. They are produced by the **Export** action in the app's settings card, which finishes the AI notes first so a demo makes no model calls. Dropping a package on the landing page opens it as an ordinary import. The design is in [plan/DEMO-MODE.md](plan/DEMO-MODE.md).

## Configuration

Every tunable value lives in [config.json](config.json): theme colours, parser limits, clustering targets, physics, visual constants, overlays and AI model names. It is typed and validated at load by `src/config`. Secrets never go there.

## How it works

1. **Manifest.** The tracked file list, blob ids and sizes are read from `.git/index`. Ignored folders are never opened.
2. **Fast pass.** File contents are read from the git packfile and scanned for imports, across a pool of workers.
3. **Slow pass.** tree-sitter (WebAssembly) extracts definitions and call sites, so files that use each other without importing each other are still linked.
4. **Analysis.** Imports and references are resolved into dependencies between files; PageRank gives each file an importance; Louvain community detection forms cities and districts.
5. **Layout.** A tiered force simulation settles cities, districts and files off screen. The map is then revealed already settled, and it only reorganises when you ask (Apply, Update, or dragging a label).
6. **After the reveal.** Git history is walked in the background for the overlays, and the map is saved locally.

Supported languages: TypeScript, JavaScript, Python, C, C++, Objective-C, Java, Kotlin, Scala, C#, Go, Rust, Dart, Swift, PHP, Ruby, Vue, Svelte, Astro, CSS/SCSS and HTML. Other files still get a star and join their folder's community.

The full design is in [plan/PLAN.md](plan/PLAN.md), and the build breakdown in [plan/IMPLEMENTATION.md](plan/IMPLEMENTATION.md).

## Project layout

| Path | Contents |
|---|---|
| `src/app/` | React shell: landing page, map chrome, legend, sidebar, overlays, search, tour, AI prompts |
| `src/render/` | three.js scene: stars, edges, territories, particles, picking, camera |
| `src/physics/` | Tiered force layout, in a worker |
| `src/pipeline/` | Coordinator worker, session, reveal gate, update flow, headless Node entry |
| `src/ingest/`, `src/lang/` | Manifest, fast and slow parse passes; one plug-in folder per language |
| `src/analysis/` | Import resolution, symbol linking, importance, clustering, overlay layers |
| `src/git/`, `src/history/` | Git index, packfile and object reading; the history walk |
| `src/model/` | Data model, patch protocol, store, snapshot format |
| `src/compute/` | Worker pool with priority lanes |
| `src/ai/`, `api/ai/` | Digest builder, client, provider adapters; serverless routes |
| `src/persist/`, `src/content/`, `src/search/` | Local storage, file content sources and packages, fuzzy search |
| `src/contracts/` | Interfaces between modules. Start with [src/contracts/README.md](src/contracts/README.md) |
| `fixtures/` | Small per-language repos with expected edges, used by tests |
| `spikes/` | The measurement spikes that preceded the build |

## Deploying

The app is a static single-page app plus serverless functions under `api/`, set up for Vercel (`vercel.json`).

- **Cross-origin isolation is required.** The app shares memory between workers, which browsers only allow when every response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. `vercel.json` and the dev server set both; any other host must do the same, and every asset must be served from the app's own origin.
- **AI on a deployment:** set the provider key as an environment variable for the functions. If you use OpenAI, set `VITE_AI_PROVIDER=openai` for both the build and the functions.

## Licence

MIT. See [LICENSE](LICENSE).
