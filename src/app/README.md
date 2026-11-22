# The app shell (`src/app`)

Three screens over one background: **landing → waiting → map** (PLAN.md §17). The shell owns the store, the theme, the chrome primitives and the regions; every feature is a folder with a `mount.tsx`. Read this before adding a legend, pills, tooltips, the sidebar, overlays, search or the tour.

Try it: `/?fake=2000` plays the whole flow on a synthetic model. Extras: `&wait=<ms>` (time on the waiting screen), `&refined=<ms>` (raise "Refined structure ready" after the reveal), `&seed=<n>`, `&appearance=dark|light|system` (this visit only). In a dev build `window.__starmapApp` is `{ store, open(source), close() }`.

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
| `pills/`, `inspect/`, `selected/`, `legend/`, `controls/` | The map's chrome (package 2G); see "The map's chrome" below |
| `selectionState.ts` | Selection as pure transitions (click, Shift+click, marquee, remove, clear); the store's selection actions call them |
| `anchor.ts` | `useAnchor` / `followAnchor`: keep an element beside a node of the scene, frame by frame |
| `units.ts` | Reading units out of the replica: `unitSummary`, `unitDetails`, `unitName`, `languageName` |
| `keys.ts` | The keyboard's plumbing: `isTyping(target)` for window-level shortcuts, what Escape closes (`useDismissable`), and the Tab order of the regions; see "Keys" below |
| `tunables.ts` | `APP_LOCAL`: chrome numbers that have no key in `config.json` yet |

## Adding a feature: mounts

Create `src/app/<feature>/mount.tsx` and default-export an `AppMount` or an array of them (`contracts/app.ts`). Nothing else needs editing; `mounts.tsx` finds it with `import.meta.glob('./*/mount.tsx')`.

```tsx
import type { AppMount } from '../../contracts/app';
import { Pill } from '../ui';

function ResetView() { return <Pill blur>Reset view</Pill>; }

const mount: AppMount = { region: 'bottomLeft', order: 10, Component: ResetView };
export default mount;
```

- `order`: lower comes first within a region. In use: title pill `topLeft` 0, search `topLeft` 1 (beside the title), selection pills `topLeft` 10; progress `topCenter` 20, action pills `topCenter` 30; settings gear `topRight` 1000 (overlay pills go before it); controls key `bottomLeft` 0, "Reset view" `bottomLeft` 10; legend `bottomRight` 10; in `scene`, the pill layer 0, the detail card 10, the tooltip 20 (later lies on top).
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

`useApp` is the one zustand store. Read with a selector (`useApp((s) => s.minBytes)`) or a hook below; change it with the action functions, which are plain exports and can be called from anywhere.

| State | Type | Notes |
|---|---|---|
| `phase` | `'landing' \| 'waiting' \| 'map'` | |
| `session` | `Session \| null` | the open map, from "waiting" onwards |
| `render` | `RenderApi \| null` | null until the canvas is attached, and while the renderer is a stub |
| `stage` | `StageInfo` | the waiting screen's line |
| `progress` | per `Subsystem`: `{ done, total, label? }` | latest report from each |
| `notices` | `Notice[]` without `'cleared'` | what the action pills show |
| `message` | `string \| null` | the quiet line under "Choose a folder" |
| `settings` | `{ appearance, particles }` | saved in `localStorage` under `starmap.settings` |
| `mode` | `'dark' \| 'light'` | `appearance` resolved against the system setting |
| `reducedMotion` | `boolean` | follows `prefers-reduced-motion` |
| `selection` | `NodeRef[]` | pushed to `render.setSelection` |
| `focus` | `NodeRef \| null` | the selected node whose detail card is open; always a member of `selection` |
| `hover` | `NodeRef \| null` | set from the renderer's `hover` event |
| `activeOverlay` | `string \| null` | pushed to `session.setSelectedOverlay` |
| `typeFilter` | `string[]` | language ids, empty = all; pushed to `render.setTypeFilter` |
| `minBytes` | `number` | starts at `config.legend.minBytesDefault`; pushed to `render.setMinBytes` |
| `openFile` | `NodeRef \| null` | set on double-click; the sidebar reads it |

View state resets when a map is opened or closed.

**Hooks:** `usePhase()`, `useSession()`, `useRender()`, `useStage()`, `useNotices()`, `useSettings()`, `useThemeMode()`, `useReducedMotion()`, `useSelection()`, `useFocus()`, `useHover()`, `useRepoName()`, and for the model:

- `useReplicaVersion()` returns the replica's revision and re-renders the caller after the replica applies a batch, at most once per frame.
- `useReplica()` returns `session.replica` with the same re-rendering.

**Selection actions** (each is one transition from `selectionState.ts`, so `focus` can never point outside `selection`): `selectOnly(ref | null)` (click: replace and focus; null clears), `toggleSelection(ref)` (Shift+click), `addToSelection(refs)` (marquee), `removeFromSelection(ref)`, `clearSelection()`, `setFocus(ref | null)` (open or close the detail card), and `setSelection(refs)` (replace; a single node is also focused, which is what search and the tour want).

**Other actions:** `setHover`, `setActiveOverlay`, `setTypeFilter`, `setMinBytes`, `setOpenFile`, `setParticles`, `setMessage`, `pushNotice`, `dismissNotice` (from `store.ts`); `openSource(source)`, `closeSession(message?)` (from `session.ts`).

**What is already wired** (`session.ts`):

- Store → renderer: `mode`, `settings.particles`, `selection`, `typeFilter`, `minBytes`, all pushed once when the renderer appears and then on change. `activeOverlay` → `session.setSelectedOverlay`. Building the `OverlayView` and calling `render.setOverlay` is left to the overlays feature.
- Renderer → store: `hover` → `hover`; `click` → `selection` and `focus` (plain click replaces and focuses, Shift adds or removes, a click on empty space clears); `marquee` adds to `selection`; `dblclick` → `openFile`. For `frame` and `camera`, subscribe yourself: `useRender()?.on('frame', …)`.
- Left to the renderer's interaction module, so do not repeat them here: the select and open bursts (`render.burst`), easing the camera to a clicked sphere, and redrawing a selected file that the size slider hides. Flying is the shell's job only for its own controls: a city or district pill, a selection pill, a name in the detail card, a search result.
- Keys: Escape clears the selection (`selected/`) once everything lying over it has closed, and Home resets the view (`controls/`). Both leave text fields alone (`isTyping`). **Nothing listens for Escape itself**: whatever closes on Escape registers with `useDismissable`; see "Keys" below.
- Session → store: `stage`, `progress`, `reveal` (phase becomes `map`), `notice`, `error` (fatal: back to the landing page with the message; otherwise an info pill).

## Keys (`keys.ts`)

**Escape closes one thing per press, the topmost.** A feature never listens for Escape and never stops the key for others. While something of its own is open, it puts it on the stack:

```tsx
import { LAYER, useDismissable } from '../keys';

useDismissable(open, () => {
  setOpen(false);
  button.current?.focus(); // closing gives the focus back to what opened it
}, { layer: LAYER.card });
```

- **The order** is by layer, highest first: `LAYER.list` (an open list or picker: the search field, the contributor picker), `LAYER.card` (a card or popover: settings, the detail card, a point of interest; the default), `LAYER.tour`, `LAYER.sidebar`, `LAYER.selection`. Within a layer, the one opened most recently closes first. So with everything open, six presses close the search list, the settings card, the detail card, the tour, the sidebar and then the selection.
- **Registering:** `useDismissable(isOpen, close, { layer, owns })` in a component, or `registerDismissable({ close, layer, owns })` outside React, which returns the function that takes it off the stack again (call it when the thing closes, however it was closed). The place among layers opened at other times is fixed when it opens.
- **Text fields.** Escape pressed in a field the user is typing in closes only a layer that owns the field: pass `owns: (field) => …` (the search field owns its input; the sidebar owns the editor inside it). In a field nothing owns, Escape does nothing.
- A control that uses Escape itself (the code editor closing its search bar) prevents the default, and the stack leaves that press alone. The key is not consumed by the stack, so the renderer still drops its hover on the same press.

**Tab walks the regions in reading order**, not in the order the shell lays them out in the document (where the scene comes first and the sidebar last): `TAB_REGIONS` is top left → top centre → top right → scene → right edge → bottom left → bottom centre → bottom right → overlay, and document order within a region. `installTabOrder()` does it on the map screen (it is installed once, by `<Region>`); past either end the focus leaves the page as usual. Nothing in a feature needs to know, with two conditions:

- A group that exists in numbers is **one tab stop** with a roving `tabindex` and arrow keys inside (the overlay toolbar, city and district pills, point-of-interest pills, a segmented control), so Tab does not walk 150 pills.
- A control that uses Tab itself (the code editor, where Tab indents) prevents the default and is left alone; it must say how to leave (the editor's `aria-description` names Control+M).

Other keys, each in its feature: "/" and Ctrl/Cmd+K reach the search; Home resets the view, except in a toolbar, tab row, list, slider or splitter, where it has its own meaning; on a city or district pill, arrows move between pills, Enter flies there and Shift+arrow moves the city or district (the keyboard's drag); Delete or Backspace on a selection pill removes it; ← → and Space step the tour.

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
| `.gm-icon-button` (class) | a bare round icon button inside a pill or card; give it an `aria-label` |
| `.gm-lang-dot` (class) | the colour dot of a file type; set `background` to `languageColor(lang, config.visual, meta.languages[lang]?.color)` |

Rules from PLAN.md §17 that the primitives already follow, and yours should too:

- **`blur` is rationed.** Pass it only on the fixed chrome (about ten elements). In-scene pills and anything that exists in numbers use the flat translucent fill.
- **No drop shadows.** The only glow is the faint halo on active or hovered elements in dark mode.
- **No purple, indigo or violet** in chrome or background. Use the tokens; do not write colours.
- **Sentence case, plain verbs.** No all-caps labels.
- **Type.** Jost Regular 12–13 px on pills, Medium for emphasis, Light for titles. Commit Mono (`.gm-code`, or `var(--gm-font-code)`) only where the text is code; file paths stay in Jost. Jost held up at 12–13 px on a translucent pill in both modes, so Figtree has not been needed.
- **Focus** rings are global (`:focus-visible`, halo colour); do not remove outlines.
- **Motion** only in answer to an action. `prefers-reduced-motion` already cuts every CSS transition and animation short; check `useReducedMotion()` before animating in script.

## The map's chrome (package 2G)

| Folder | Region | What it is |
|---|---|---|
| `pills/` | `scene` | City pills (name and file count, "visible / total" when the size slider hides some) and smaller district pills for cities near the camera. `layer.ts` is the pooled, imperative DOM layer; `place.ts` holds the pure rules (priority, overlap, distance fade, when districts show). |
| `inspect/` | `scene` | The tooltip for `hover` and the detail card for `focus`, both anchored to their sphere. |
| `selected/` | `topLeft` | One removable pill per selected file, "+N more", "Clear all". Escape clears. |
| `legend/` | `bottomRight` | File-type rows (click isolates, Shift+click for several) and the minimum-file-size slider. `slider.ts` is the pure part: the logarithmic mapping (bytes), the hidden count with the glow exemption, the filter transitions. |
| `controls/` | `bottomLeft` | The controls key (opens on hover or focus) and "Reset view" (also the Home key). |

**Following the scene.** Anything that tracks a node does it outside React: subscribe to `render.on('frame')` and write `transform` on the element. For one element, use `useAnchor(ref, elementRef, place, rev, obstacle?)` from `anchor.ts`: `place(at, box, view, render)` returns the top-left corner for the projected anchor `at`, or null to hide; the element is absolutely positioned at the scene's top left and starts `visibility: hidden`. Its size is measured once per anchoring, so pass something in `rev` that changes when the content does. `groundToPixels(render, at, world, 'x' | 'y')` converts a ground distance at a projected point to CSS pixels (a sphere's radius on screen, the far edge of a territory). The renderer draws at a reduced rate when nothing moves, and not at all under reduced motion, so place once immediately as well as on `frame` (`followAnchor` does).

**The pill layer** (`pills/layer.ts`) is the model for anything that exists in numbers (point-of-interest pills next):

- Elements are pooled and bound to a `NodeRef`; a pass projects the candidates, keeps them in priority order without overlaps (`keepPills`, capped at `config.render.maxPills`), then writes `transform` and `opacity` only where they changed. Label widths are measured once per distinct text on a hidden ruler element, never per frame.
- A pill sits just above the far edge of its territory, so it does not cover the stars inside. Pills fade with distance; a dropped pill fades out where it is before its element returns to the pool.
- Pills stay out from under the fixed chrome and the open detail card: the layer reads the chrome's rectangles (`.gm-frame .gm-pill, .gm-card`) every `APP_LOCAL.pills.chromeReadMs`, and anchored cards register their box in `sceneObstacles` (`anchor.ts`) with `useAnchor(…, true)`.
- Pointer: press and drag moves the city or district (`session.physics.drag(ref, x, z)` with the ground point under the pill's anchor from `render.screenToGround`, then `release(ref)`); a press without a drag is a click and calls `render.flyTo(ref)`. The pills are DOM elements above the canvas, so the canvas never sees these events and does not pan; the wheel is forwarded to the canvas so zooming works over a pill.
- Keyboard: the layer is one tab stop (roving `tabindex`); arrow keys move between pills, Enter flies to one. A focused or dragged pill is never dropped.

**Counts are units.** One sphere is one unit (a header + implementation pair is a single unit), so the legend's counts, the slider's "Hiding N of M files" and the city pills all count units and call them files. Language names come from `replica.meta.languages` (the id is shown when the model has none, as on the synthetic map); nothing in the app imports `src/lang`.

**For the next features.** The sidebar reads `openFile`; note that the canvas and the `scene` region stay full-bleed under the sidebar, so an anchored card can end up beneath it (the pills already avoid `rightEdge`). Overlay pills go in `topRight` before 1000; the legend should give way to an overlay's own legend while one is active (not done). Search sits in `topLeft` beside the title and calls `setSelection([ref])` then `render.flyTo(ref)`. The tour goes in `bottomCenter` and can use `render.setHighlights` plus `useAnchor` for its step card.

## The other feature folders

Each is one folder with a `mount.tsx`; region and order are as that file declares them.

| Folder | Region · order | What it is |
|---|---|---|
| `repos/` | `landing` 10; `topLeft` 5 | The landing page's repo pills (saved repos, demos), and on the map the repo info pill under the title pill, with its card (for a demo: source, commit, licence, export date). Demos are listed from `config.demo.repos`, sorted in with the saved repos by last opened, each with a "Demo" tag. Export lives in the settings card (`settings/ExportRow.tsx`): "Map and files" writes a package, "Map only" the `.starmap.json.gz`. |
| `search/` | `topLeft` 1 | The search pill, beside the title: widens into a field on focus, "/" or Ctrl/Cmd+K, and lists matching files from `session.search`; choosing one selects it and flies to it. |
| `overlays/` | `topRight` 100 | One pill per overlay before the settings gear, and under them the active overlay's legend and parameters; builds the `OverlayView` and calls `render.setOverlay`. |
| `sidebar/` | `rightEdge` 0; `topRight` 1100 | The opaque sidebar editor for `openFile`, read (and saved) through `session.content`, and the small button that brings it back while it is closed. |
| `poi/` | `scene` 20 | A label pill on every point of interest's beam, and the detail card a pill opens, with its detail buttons. |
| `summaries/` | `scene` 30 | The AI summary of a city on a card under its pill, while the pointer rests there or the pill has focus. |
| `tour/` | `bottomCenter` 10 | The "Tour the repo" pill, and the step card that takes its place while a tour plays. |
| `status/` | `overlay` 0, 1 and 20 | Error and empty states that belong to no other feature: the line for a map opened without its folder, a small card while the graphics context is lost, and "The app was updated" when a part of the app can no longer be fetched. |
| `devreload/` | `topCenter` 5; `landing` −10 | Development only: "Code changed · Reload" when the dev server held back a reload, and "Reopen <folder>" on the landing page. |
| `ai/` | `bottomCenter` 5 (failure line) and 7 (prompt) | The "Add AI notes" prompt, always present while AI notes are off for a repo; it starts generation through `session.ai` once the answer is yes, and shows one quiet line when something fails. The settings card has the per-repo "AI notes" On / Off row. |

## CSS custom properties

`theme.ts` writes these on `:root` from `config.theme` for the active mode, and sets `data-theme="dark|light"` on `<html>`. They change in place when the appearance changes; nothing reloads.

| Variable | Value |
|---|---|
| `--gm-void`, `--gm-dust-cool`, `--gm-dust-warm` | background base and the two dust colours |
| `--gm-text` | Starlight (dark) or Ink (light) |
| `--gm-text-dim` | secondary text: an opaque mix of the text colour (72%) and the surface colour, so it holds over any backdrop |
| `--gm-text-quiet` | the quietest text on the sidebar (comments, line numbers), kept at 4.5:1 there |
| `--gm-halo` | focus rings, active state, marks (a progress line, a slider's fill). As text, use `--gm-link` |
| `--gm-link` | the halo as text (a link, the action of an action pill): the halo itself where that reads at 4.5:1 on a card, otherwise moved toward the text colour until it does |
| `--gm-warm` | selection, tour, importance: the only warm thing in the chrome |
| `--gm-sidebar` | the opaque sidebar surface |
| `--gm-surface` | pill material: the void colour (dark) or white (light) |
| `--gm-pill-bg` | the surface at pill opacity |
| `--gm-card-bg` | the surface at card opacity: what `<Card>` uses, and a pill that holds a `PillSegment` |
| `--gm-pill-bg-strong` | the most opaque of the three: hover and active, the cards anchored in the scene, district pills |
| `--gm-pill-opacity`, `--gm-pill-border-opacity` | the numbers behind them |
| `--gm-hairline` | the one-pixel border: text colour at low opacity |
| `--gm-pill-blur`, `--gm-card-radius` | lengths |
| `--gm-wisp-contrast` | drives the static background |
| `--gm-font-ui`, `--gm-font-code` | font stacks |
| `--gm-text-faint`, `--gm-halo-soft`, `--gm-ease` | derived in `ui.css`: faint fills, soft halo, the easing curve |
| `--gm-focus-band` | set in `ui.css`: what the focus ring is drawn on, a 5 px band of the surface colour so the halo has 3:1 whatever the scene shows behind it. `transparent` inside a card and the sidebar, where the ring already lies on their material; set it to `transparent` on an element whose ring is drawn inside it (a negative `outline-offset`) |
| `--gm-overlay-accent`, `--gm-overlay-tint`, `--gm-overlay-mark` | written by `overlays/` while an overlay is on, from `accentVariables()` in `theme.ts`: the overlay's own colour, its share in the fill of the active pill, and that colour as the pill's dot and ring (nudged toward the text colour where it would not stand out 3:1) |

`.gm-visually-hidden` (class, `ui.css`) is for text a screen reader needs and the page already shows another way: the map's `h1` (`#gm-map-heading`, in the title pill), and a status line that announces less often than the visible one changes.

**Opacity is set by contrast** (`theme.ts`, checked for both modes by `theme.test.ts` through `contrastChecks()` and `accentChecks()`). Every ratio is measured over the worst thing the scene can put behind a translucent element: white in dark mode (the core of a bright star saturates), black in light mode.

- **Pill** (`pillOpacity`): `config.theme.pill.opacity` (0.6), raised until text keeps 4.5:1 and a dim icon 3:1. That is 0.70 in both modes.
- **Card** (`cardOpacity`): raised further until dim text keeps 4.5:1, since cards hold secondary text. 0.82 dark, 0.85 light.
- **Strong** (`strongOpacity`): 60% of the way from the pill to opaque, and never less than a card. 0.88 in both modes.
- **In-scene pills** fade with distance, but only down to `sceneFadeFloor(mode)` (0.76 dark, 0.67 light), where a district's name and a city's count are still at 4.5:1.

The rule that follows: **no dim text and no link-coloured text on a bare pill.** A pill at 0.70 carries full-strength text and dim icons only. Secondary text and `--gm-link` text need the card material or stronger; fade nothing that is still a button (use `--gm-text-dim` for a row that recedes, not `opacity`).

## Things worth knowing

- **The background is continuous.** `.gm-bg` (static dust) is always there. The wisp canvas runs over it on the landing and waiting screens. The map canvas is attached as soon as a session exists, sits at opacity 0, and fades in at the reveal; then the wisp canvas is disposed, because the renderer draws the same background itself.
- **No `<StrictMode>`.** Its double-run of effects would create and dispose WebGL renderers twice on one canvas.
- **Stubs are tolerated.** `createSession` throwing "not implemented" falls back to `createFakeSession`; so does `?fake`. `createBackground` or `createRenderer` throwing it leaves the static background, and the chrome still appears.
- **Leaving the map.** The app title in the title pill returns to the landing page; `closeSession()` disposes the session.
- `store.ts` and `session.ts` hold state, so editing them reloads the page instead of hot-swapping.
