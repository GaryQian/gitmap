# The app shell (`src/app`)

Three screens over one background: **landing → waiting → map** (PLAN.md §17). The shell owns the store, the theme, the chrome primitives and the regions; every feature is a folder with a `mount.tsx`. Read this before adding a legend, pills, tooltips, the sidebar, overlays, search or the tour.

Try it: `/?fake=2000` plays the whole flow on a synthetic model. Extras: `&wait=<ms>` (time on the waiting screen), `&refined=<ms>` (raise "Refined structure ready" after the reveal), `&seed=<n>`, `&appearance=dark|light|system` (this visit only). In a dev build `window.__gitmapApp` is `{ store, open(source), close() }`.

## Files

| File | What it is |
|---|---|
| `main.tsx` | Entry: fonts, styles, theme, `<App />`, the `?fake` start |
| `App.tsx` | Background, map canvas, the current screen, the regions |
| `store.ts` | The zustand store, its actions and hooks |
| `session.ts` | `openSource`, `closeSession`, and the wiring between store, `Session` and renderer |
| `theme.ts` | `config.theme` → CSS custom properties; contrast maths |
| `mounts.tsx` | Mount discovery and `<Region>` |
| `Background.tsx` | Static dust in CSS, plus the wisp shader when `createBackground` exists |
| `ui/` | Chrome primitives and `ui.css` |
| `landing/`, `waiting/` | The two screens before the map; `landing/acquire.ts` turns a pick or a drop into a `RepoSource` |
| `title/`, `progress/`, `settings/` | The shell's own mounts: title pill, progress and action pills, settings gear and card |

## Adding a feature: mounts

Create `src/app/<feature>/mount.tsx` and default-export an `AppMount` or an array of them (`contracts/app.ts`). Nothing else needs editing; `mounts.tsx` finds it with `import.meta.glob('./*/mount.tsx')`.

```tsx
import type { AppMount } from '../../contracts/app';
import { Pill } from '../ui';

function ResetView() { return <Pill blur>Reset view</Pill>; }

const mount: AppMount = { region: 'bottomLeft', order: 10, Component: ResetView };
export default mount;
```

- `order`: lower comes first within a region. In use: title pill `topLeft` 0; progress `topCenter` 20, action pills `topCenter` 30 (search belongs before them); settings gear `topRight` 1000 (overlay pills go before it).
- `phases`: which screens show the mount. Default `['map']`; in the `landing` region the default is `['landing']`.
- Each mount renders inside an error boundary, so a feature that throws disappears instead of taking the map down.
- Import a feature's CSS from its own `mount.tsx`.

| Region | Where | Layout |
|---|---|---|
| `topLeft` | top row, left | column, so selection pills stack under the title pill |
| `topCenter` | top row, centre | row, wraps when crowded |
| `topRight` | top row, right | row, right-aligned |
| `bottomLeft` | bottom row, left | row, bottom-aligned |
| `bottomCenter` | bottom row, centre | column, centred |
| `bottomRight` | bottom row, right | column, right-aligned |
| `rightEdge` | full height, right | the opaque sidebar; it sets its own width, and the six regions above shrink to make room |
| `scene` | full bleed over the canvas | for elements positioned with `render.project()`; coordinates match the canvas |
| `overlay` | full bleed, above everything | consent prompt, dialogs |
| `landing` | under "Choose a folder" | centred, wrapping row of repo pills |

**Pointer events.** Every region is `pointer-events: none`, so the canvas underneath stays draggable. `Pill`, `PillButton` and `Card` turn them back on for themselves. A tooltip or any element of your own that should not catch the pointer must say so; an interactive element that is not one of the primitives must set `pointer-events: auto`.

## The store

`useApp` is the one zustand store. Read with a selector (`useApp((s) => s.minLines)`) or a hook below; change it with the action functions, which are plain exports and can be called from anywhere.

| State | Type | Notes |
|---|---|---|
| `phase` | `'landing' \| 'waiting' \| 'map'` | |
| `session` | `Session \| null` | the open map, from "waiting" onwards |
| `render` | `RenderApi \| null` | null until the canvas is attached, and while the renderer is a stub |
| `stage` | `StageInfo` | the waiting screen's line |
| `progress` | per `Subsystem`: `{ done, total, label? }` | latest report from each |
| `notices` | `Notice[]` without `'cleared'` | what the action pills show |
| `message` | `string \| null` | the quiet line under "Choose a folder" |
| `settings` | `{ appearance, particles }` | saved in `localStorage` under `gitmap.settings` |
| `mode` | `'dark' \| 'light'` | `appearance` resolved against the system setting |
| `reducedMotion` | `boolean` | follows `prefers-reduced-motion` |
| `selection` | `NodeRef[]` | pushed to `render.setSelection` |
| `hover` | `NodeRef \| null` | set from the renderer's `hover` event |
| `activeOverlay` | `string \| null` | pushed to `session.setSelectedOverlay` |
| `typeFilter` | `string[]` | language ids, empty = all; pushed to `render.setTypeFilter` |
| `minLines` | `number` | starts at `config.legend.minLinesDefault`; pushed to `render.setMinLines` |
| `openFile` | `NodeRef \| null` | set on double-click; the sidebar reads it |

View state resets when a map is opened or closed.

**Hooks:** `usePhase()`, `useSession()`, `useRender()`, `useStage()`, `useNotices()`, `useSettings()`, `useThemeMode()`, `useReducedMotion()`, `useSelection()`, `useHover()`, `useRepoName()`, and for the model:

- `useReplicaVersion()` returns the replica's revision and re-renders the caller after the replica applies a batch, at most once per frame.
- `useReplica()` returns `session.replica` with the same re-rendering.

**Actions:** `setSelection`, `toggleSelection`, `setHover`, `setActiveOverlay`, `setTypeFilter`, `setMinLines`, `setOpenFile`, `setAppearance`, `setParticles`, `setMessage`, `pushNotice`, `dismissNotice` (from `store.ts`); `openSource(source)`, `closeSession(message?)` (from `session.ts`).

**What is already wired** (`session.ts`):

- Store → renderer: `mode`, `settings.particles`, `selection`, `typeFilter`, `minLines`, all pushed once when the renderer appears and then on change. `activeOverlay` → `session.setSelectedOverlay`. Building the `OverlayView` and calling `render.setOverlay` is left to the overlays feature.
- Renderer → store: `hover` → `hover`; `click` → `selection` (plain click replaces, Shift toggles, a click on empty space clears); `marquee` adds to `selection`; `dblclick` → `openFile`. For pointer coordinates (tooltips), or `frame` and `camera`, subscribe yourself: `useRender()?.on('hover', …)`.
- Session → store: `stage`, `progress`, `reveal` (phase becomes `map`), `notice`, `error` (fatal: back to the landing page with the message; otherwise an info pill).

## Chrome primitives (`ui/`)

```tsx
import { Card, GearIcon, Pill, PillButton, PillSegment, ProgressLine, Segmented, Strong } from '../ui';
```

| Component | Use |
|---|---|
| `<Pill>` | a single-line element holding text. Props: `blur`, `active`, `size` (`small` 26 px, `medium` 34 px, `large` 46 px) |
| `<PillButton>` | a pill that is one button. Adds `round` for an icon-only circle (give it an `aria-label`) |
| `<PillSegment>` | a button at the end of a `Pill`: `<Pill><span>3 files changed</span><PillSegment>Update</PillSegment></Pill>` |
| `<ProgressLine value={0..1} />` | the thin line along a pill's lower edge; last child of a `Pill`; `null` draws nothing |
| `<Strong>` | Jost Medium, for repo names, counts and selected state |
| `<Card>` | a multi-line element, 20 px radius. Prop: `blur` |
| `<Segmented label value options onChange>` | a radio row for cards (Dark / Light / System) |
| `GearIcon`, `CloseIcon` | 16 px line icons in the text colour |

Rules from PLAN.md §17 that the primitives already follow, and yours should too:

- **`blur` is rationed.** Pass it only on the fixed chrome (about ten elements). In-scene pills and anything that exists in numbers use the flat translucent fill.
- **No drop shadows.** The only glow is the faint halo on active or hovered elements in dark mode.
- **No purple, indigo or violet** in chrome or background. Use the tokens; do not write colours.
- **Sentence case, plain verbs.** No all-caps labels.
- **Type.** Jost Regular 12–13 px on pills, Medium for emphasis, Light for titles. Commit Mono (`.gm-code`, or `var(--gm-font-code)`) only where the text is code; file paths stay in Jost. Jost held up at 12–13 px on a translucent pill in both modes, so Figtree has not been needed.
- **Focus** rings are global (`:focus-visible`, halo colour); do not remove outlines.
- **Motion** only in answer to an action. `prefers-reduced-motion` already cuts every CSS transition and animation short; check `useReducedMotion()` before animating in script.

## CSS custom properties

`theme.ts` writes these on `:root` from `config.theme` for the active mode, and sets `data-theme="dark|light"` on `<html>`. They change in place when the appearance changes; nothing reloads.

| Variable | Value |
|---|---|
| `--gm-void`, `--gm-dust-cool`, `--gm-dust-warm` | background base and the two dust colours |
| `--gm-text` | Starlight (dark) or Ink (light) |
| `--gm-halo` | focus, links, active state |
| `--gm-warm` | selection, tour, importance: the only warm thing in the chrome |
| `--gm-sidebar` | the opaque sidebar surface |
| `--gm-surface` | pill material: the void colour (dark) or white (light) |
| `--gm-pill-bg` | the surface at pill opacity; `--gm-pill-bg-strong` for hover and active |
| `--gm-pill-opacity`, `--gm-pill-border-opacity` | the numbers behind them |
| `--gm-hairline` | the one-pixel border: text colour at low opacity |
| `--gm-pill-blur`, `--gm-card-radius` | lengths |
| `--gm-wisp-contrast` | drives the static background |
| `--gm-font-ui`, `--gm-font-code` | font stacks |
| `--gm-text-dim`, `--gm-text-faint`, `--gm-halo-soft`, `--gm-ease` | derived in `ui.css`: secondary text, faint fills, soft halo, the easing curve |

**Pill opacity** is `config.theme.pill.opacity`, raised when needed so text keeps 4.5:1 over the worst thing the scene can put behind a pill: something as bright (dark mode) or as dark (light mode) as the text itself. `pillOpacity()` in `theme.ts` computes it; `theme.test.ts` checks it for both modes.

## Things worth knowing

- **The background is continuous.** `.gm-bg` (static dust) is always there. The wisp canvas runs over it on the landing and waiting screens. The map canvas is attached as soon as a session exists, sits at opacity 0, and fades in at the reveal; then the wisp canvas is disposed, because the renderer draws the same background itself.
- **No `<StrictMode>`.** Its double-run of effects would create and dispose WebGL renderers twice on one canvas.
- **Stubs are tolerated.** `createSession` throwing "not implemented" falls back to `createFakeSession`; so does `?fake`. `createBackground` or `createRenderer` throwing it leaves the static background, and the chrome still appears.
- **Leaving the map.** The app title in the title pill returns to the landing page; `closeSession()` disposes the session.
- `store.ts` and `session.ts` hold state, so editing them reloads the page instead of hot-swapping.
