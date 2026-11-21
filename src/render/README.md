# src/render

A raw three.js renderer (no React inside). `index.ts` exports `createRenderer(init): RenderApi` and `createBackground(canvas, opts): BackgroundApi`; the contract is `src/contracts/render.ts`.

| Folder | What it holds | Package |
|---|---|---|
| `core/` | WebGLRenderer, resize, render loop, theme, batch projection, position textures, camera, pointer routing, the module host | 1G |
| `spheres/` | The star look: three instanced draws over one instance per unit slot | 1G |
| `background/` | Wisp background (scene and standalone), ground grid | 1G |
| `territory/`, `edges/`, `particles/`, `interaction/`, `overlay/`, `poi/` | Added by later packages as scene modules | 2E, 2F, 4C, 5D |

## Scene modules: how to add a feature

Everything that draws is a **scene module**. To add one, create `src/render/<feature>/module.ts` that default-exports a factory. The core finds it with `import.meta.glob('../*/module.ts')`; no core file is edited.

```ts
// src/render/edges/module.ts
import * as THREE from 'three';
import { GLSL_POSITIONS } from '../core/glsl';
import type { SceneContext, SceneModule } from '../core/types';

export default function createEdges(): SceneModule {
  let ctx!: SceneContext;
  return {
    name: 'edges',
    init(c) { ctx = c; /* build geometry and ShaderMaterial({ uniforms: { ...ctx.uniforms, ...own } }), ctx.scene.add(mesh) */ },
    applyBatch(batch, { rebuild }) { /* write buffers; when rebuild is true, rebuild them from ctx.replica */ },
    frame(f) { /* per-frame uniforms, offscreen passes */ },
    setTheme(mode) { /* blend modes only; shared theme uniforms are already updated */ },
    dispose() { /* remove from ctx.scene; dispose geometry, materials, textures; unsubscribe */ },
  };
}
```

The factory is called once per renderer, so keep state inside it, not at module scope.

**Hooks** (`core/types.ts` → `SceneModule`; all but `name`, `init`, `dispose` are optional). Hooks run in ascending `order` (default 0; background is −10, spheres 10).

| Hook | When |
|---|---|
| `init(ctx)` | Once, when the renderer is created |
| `applyBatch(batch, { rebuild })` | For every batch, between frames. The only place model-derived buffers are written. `rebuild` is true for a `full` batch, a revision gap or a failed handler: ignore the ops and rebuild from `ctx.replica` |
| `onPositions()` | Position textures were re-uploaded this frame, or physics applied a new revision |
| `frame(frameState)` | Once per rendered frame, before the scene is drawn |
| `setTheme(mode)` | Theme changed. Uniforms and blend modes only; never rebuild |
| `resize(w, h, pixelRatio)` | Canvas size (CSS pixels) or pixel ratio changed |
| `reveal(info)` | `RenderApi.reveal()` was called |
| `dispose()` | Free every GPU resource and listener the module created |

A hook that throws is logged and skipped, except `applyBatch`: a throw there makes the core rebuild every module from the replica and count a resync.

**`SceneContext`** (`core/types.ts`):

- `renderer`, `scene`, `camera`, `canvas`, `config`, `reducedMotion`, `theme`.
- `replica` — read only. It has already applied the batch when `applyBatch` runs.
- `uniforms` — shared `{ value }` objects; spread them into your material. `uTime` (seconds), `uPixelRatio`, `uViewport` (device pixels), `uPixelWorld` (world units per device pixel at depth 1), `uDark`, the theme tokens `uVoid uDustCool uDustWarm uText uHalo uWarm` (sRGB vec3), the position textures and the unit lookup textures. Spreading keeps the same objects, so texture swaps and theme changes reach every material.
- `positions` — `positions.buffers` is the current `PositionBuffers`; `rev()` is the revision physics has applied; `hot()` is true while a simulation runs.
- `units` — per-unit lookup arrays and textures, by unit slot: `info = [radius, district slot, city slot, glow]`, `color = [r, g, b, alive]`.
- `rig` — camera state and maths: `view`, `groundAt(x, y)`, `project(x, y, z)`, `worldPerPixel(depth)`, `panStart/panMove`, `orbitStart/orbitMove`, `zoomAt`, `flyTo`, `bounds`.
- `pointer` — pointer routing (below).
- `state` — view state set through `RenderApi`: `revealed`, `selection`, `highlights`, `typeFilter`, `minLines`, `overlay`, `particles`. Refs are permanent ids, never slots.
- `bus` — internal events, fired after the matching `state` field changed: `selection`, `highlights`, `typeFilter`, `minLines`, `overlay`, `particles`, `theme`, `reveal`, `camera`, and `burst` (`RenderApi.burst()`; a particles module draws it).
- `emit(evt, payload)` — emit a public `RenderEvents` event (`hover`, `click`, `dblclick`, `marquee`).
- `anchor(ref)` — world anchor of a node. `now()` — scene time in seconds.
- `invalidate()` / `animate(ms)` — the loop idles at a reduced rate when nothing moves (not at all under reduced motion). Call `invalidate()` after changing something visible; call `animate(ms)` to keep the full rate for a while.
- `counters` — `edgesDrawn` and `quality`, reported by `RenderApi.stats()`.
- `provide(name, api)` / `service<T>(name)` — share an API between modules. The spheres module provides `'spheres'` (`SpheresApi` in `spheres/module.ts`): `setHover(slot)`, `setNudge(slot, x, y, z)` for jiggle, `isShown(slot)`, `visibleCounts()`.

## Positions in shaders

Three float data textures, 1024 texels wide, indexed by slot: unit `[x, z]` (local to its district), district `[x, z, r]` (local to its city), city `[x, z, r]` (world). They are re-uploaded from `PositionBuffers` when the generation counters change: the city texture on `GEN_CITY`, the district and unit textures when any district counter moved. Include `GLSL_POSITIONS` from `core/glsl.ts`:

- `gmGround(vec3(unitSlot, districtSlot, citySlot))` → world `(x, z)`, for instances that carry their slots as an attribute.
- `gmUnitCenter(int unitSlot, out vec4 info)` → world centre of any unit (y = radius), through the lookup texture. Use it for edge endpoints and particle hosts. `gmUnitColor(slot)` gives its language colour.

A sphere's centre sits at `y = radius`. Colours are sRGB values written straight to `gl_FragColor` (no three.js colour management), as in the render spike.

## Batches and positions

- `applyBatch` expects the replica to have applied the batch already (`replica.apply(batch)` first, then `render.applyBatch(batch)`). If a batch arrives early, the renderer waits and rebuilds once the replica has caught up.
- A revision gap (`batch.baseRev` ≠ the last applied `rev`, not `full`) rebuilds from the replica and adds one to `stats().resyncs`.
- A unit added after the reveal stays hidden until physics reports that revision (`gen[GEN_REV] >= batch.rev`), then grows in.

## Draw order

three.js draws opaque objects first, then transparent ones by `renderOrder`.

| `renderOrder` | What | Notes |
|---|---|---|
| −10 | Wisp background | opaque, no depth |
| −1 | Ground grid | transparent |
| 0 | Ground light | transparent |
| 1 | Sphere bodies | opaque, writes depth |
| 1.5 | Sphere glows | transparent, no depth write; additive in dark mode |
| 2, 3 | Suggested for edges, particles | as in the spike |

Emitted light is additive in dark mode and normal-blended in light mode. Switch `material.blending` in `setTheme`; it needs no recompile.

## Pointer input

`ctx.pointer.add(handler)` registers a `PointerHandler` (`core/pointer.ts`). Handlers are offered each event in descending `priority`; the camera is priority 0.

- `down(p)` — return `true` to capture the gesture: that handler alone then receives `move(p, true)` and `up`.
- `move(p, false)` — hover moves, offered to every handler until one returns `true`.
- `click(p)` / `dblclick(p)` — a press and release without a drag (movement under `pointer.clickSlopPx` in `core/tunables.ts`), offered until one returns `true`. Sent whichever handler captured the press, so picking can sit above the camera without stealing its drags.
- `wheel(w)`, `leave()`.

`PointerInfo` has canvas-relative `x`, `y`, the button, modifier keys and `space` (Space held). The camera leaves Shift+left-drag unhandled, for the marquee.

## Camera

Left-drag pans (the grabbed ground point stays under the cursor), wheel zooms toward the cursor, middle-drag or Space+drag orbits around the ground point under the pointer. The default framing fits the cities' bounding circle at `camera.defaultTilt` (height over ground distance, as in the spike). The camera follows the default framing until the reveal or the first user input.

## Notes

- The canvas must be sized by CSS. The renderer sets only its drawing-buffer size.
- `FrameInfo.time` on the public `frame` event is the `performance.now()` timestamp of the frame, in ms. `FrameInfo.frameMs` and `stats().frameMs` measure the interval between animation frames, so they stay meaningful while the loop idles.
- Tunables with no key in `config.json` yet are collected in `core/tunables.ts`.
- Tests cover pure functions only (`*.test.ts` beside the code); nothing in them needs WebGL.
