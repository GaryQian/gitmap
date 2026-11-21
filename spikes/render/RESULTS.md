# M0 spike 4: render

Question: can three.js draw the §8 scene at 60 fps for about 10k file-spheres (S/M), and usably at 100k (L)?

**Answer on this machine: yes, with a lot of headroom. But this machine has a discrete RTX 2080 Ti, not integrated graphics, so the integrated-GPU question from §15 is still open.** At 10k the whole scene costs about 1.1 ms of GPU time per frame with a 50k edge budget, and about 2.1 ms with all ~99k edges. At 100k it costs about 3.8 ms with a 150k edge budget. Edges account for almost all of that cost. Spheres, particles and the territory pass are close to free.

## Setup

- GPU / renderer string (`WEBGL_debug_renderer_info`): `Google Inc. (NVIDIA) | ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti (0x00001E07) Direct3D11 vs_5_0 ps_5_0, D3D11)`. This is a **discrete desktop GPU**. The §15 target is integrated graphics, which is probably 5–10× slower on fill-bound work like this. That was not measured.
- Browser: the Claude desktop app's built-in browser pane (Chromium, ANGLE/D3D11, WebGL2, `EXT_disjoint_timer_query_webgl2` available). The pane was **hidden** for the whole session (per `tabs_context`). Partway through, another agent's tab (`localhost:5182`) became the active tab in the same pane, so some runs may have shared the GPU with it.
- three@0.187.0, `WebGLRenderer({ antialias: true })` (MSAA on), `ShaderMaterial` in GLSL 3.00 es.
- Synthetic repo with a seeded RNG: 12 cities, each with 6–12 districts. Lines of code are log-normal (median ≈100, σ=1.1). Each file has about 10 out-edges (65% in the same district, 25% in the same city, 10% anywhere), with targets picked by a tournament on attractiveness, so in-degree is skewed. Importance is the in-degree percentile. Radius follows §8.1: `0.7·clamp(0.8·lines^(1/3), 0.8, 12) + 0.3·(0.8 + 11.2·pct)`. Files sit in a sunflower layout inside each district, and districts and cities are spiral-packed. Spheres rest on the plane (centre y = r).

## Method

The `requestAnimationFrame` timing that was asked for **could not be used**. In the hidden pane, rAF was throttled to about 20 fps with quantised intervals (p50 33 ms, p95 167 ms, max 300 ms, for a scene whose GPU time was 1–8 ms). Once the tab was no longer the active tab in the pane, rAF stopped completely: a 5 s `__bench()` timed out with zero frames. rAF numbers from this session measure the throttling, not the renderer.

Every number below comes from a **synchronous benchmark** (`window.__benchSync`):

- The scene is rendered back to back for 120–300 frames, plus 10 warm-up frames, at a fixed canvas of 1920×1080 (DPR 1, MSAA). Two rows use DPR 2, which is 3840×2160.
- Each frame advances the time uniform and the orbiting camera by 1/60 s, so the camera does orbit and pulses, shimmer and particles all animate.
- Each frame is timed two ways:
  1. **CPU wall time** for `renderer.render()` + `gl.finish()` + a 1-pixel `readPixels`, which forces a full sync. This is an upper bound and includes driver overhead.
  2. **GPU time** from `EXT_disjoint_timer_query_webgl2` around the frame.
- Each configuration ran in a fresh same-origin iframe, driven from a near-empty page with its canvas hidden.
- Default camera: an overview orbit at distance 0.85 × scene extent, 0.55 elevation, with the whole map in view. "close" means `dist=0.12`: inside one city, with large spheres filling the screen.
- Run-to-run noise is about ±0.5 ms. The first run after a page load sometimes shows a warm-up p95 spike of 3–7 ms (visible in a few rows).

Default render configuration for the main table: `split=1` (sphere bodies in one draw, coronas in a second draw; see the visual findings), `fd=1` (`gl_FragDepth` gives true sphere depth), territory footprint pass rendered once, 16-segment arcs, and N particles as stated.

## Results (1920×1080, MSAA, DPR 1, overview orbit)

| N | edges requested → drawn | particles | CPU render+sync avg / p95 ms | GPU avg / p95 ms |
|---|---|---|---|---|
| 1k | 50k → 9,627 (all) | 0 | 1.04 / 5.1 * | 0.54 / 2.92 * |
| 1k | 50k → 9,627 (all) | 4,000 | 0.62 / 0.9 | 0.24 / 0.25 |
| 1k | 150k → 9,627 (all) | 0 | 0.72 / 1.1 | 0.23 / 0.24 |
| 1k | 150k → 9,627 (all) | 4,000 | 0.85 / 1.3 | 0.36 / 0.39 |
| 10k | 50k → 50,000 | 0 | 1.68 / 2.1 | 1.15 / 1.23 |
| 10k | 50k → 50,000 | 4,000 | 1.69 / 2.0 | 1.11 / 1.15 |
| 10k | 150k → 98,605 (all) | 0 | 2.70 / 3.1 | 2.09 / 2.16 |
| 10k | 150k → 98,605 (all) | 4,000 | 2.73 / 3.1 | 2.09 / 2.17 |
| 100k | 50k → 50,000 | 0 | 2.77 / 6.0 * | 1.92 / 2.15 |
| 100k | 50k → 50,000 | 4,000 | 2.39 / 3.6 | 1.79 / 2.89 |
| 100k | 150k → 150,000 | 0 | 4.43 / 4.8 | 3.74 / 4.07 |
| 100k | 150k → 150,000 | 4,000 | 4.50 / 5.0 | 3.78 / 4.32 |

\* The first run after a load showed a warm-up spike. The 1k configurations are effectively duplicates, because the 1k repo has only 9.6k edges.

### Variations

| Config | Resolution | GPU avg / p95 ms | CPU avg / p95 ms |
|---|---|---|---|
| 10k, no edges, no particles (spheres + ground + territory) | 1080p | 0.08 / 0.08 | 0.51 / 0.9 |
| 10k, 50k edges, 4k particles, **single draw** (`split=0`, as in the plan) | 1080p | 1.17 / 1.35 | 1.97 / 2.8 |
| 10k, 50k, 4k, `fd=0` (flat quad depth) | 1080p | 1.08 / 1.49 | 1.72 / 2.4 |
| 10k, 50k, 4k, territory re-rendered every frame (`terrHot=1`) | 1080p | 1.15 / 1.61 | 1.90 / 2.6 |
| 10k, 50k, 4k, close camera | 1080p | 1.28 / 1.36 | 2.15 / 3.2 |
| 10k, 50k, 4k | **4K** | 3.15 / 3.66 | 9.0 / 23.1 (readback cost) |
| 10k, all 98.6k edges, 4k, close camera | **4K** | 5.81 / 6.25 | 6.69 / 7.1 |
| 10k, 50k, **40,000** particles | 1080p | 1.15 / 1.20 | 1.72 / 2.1 |
| 100k, no edges, no particles, territory off | 1080p | 0.23–0.96 (noisy, 4 runs) | 0.64–4.4 |
| 100k, no edges, no particles, territory once | 1080p | 0.47–1.05 (4 runs) | 0.96–2.35 |
| 100k, no edges, no particles, territory every frame | 1080p | 0.40–0.76 (4 runs) | 0.88–1.61 |
| 100k, 150k edges, 4k, territory every frame | 1080p | 4.28 / 5.72 | 5.45 / 7.1 |
| 100k, 150k, 4k, single draw (`split=0`) | 1080p | 3.65 / 4.09 | 4.38 / 4.9 |
| 100k, 150k, 4k, close camera | 1080p | 4.34 / 6.07 | 5.16 / 7.9 |
| 100k, 50k, 4k, close camera | 1080p | 1.71 / 1.97 | 2.32 / 3.1 |
| 100k, 150k, 4k | **4K** | 10.54 / 11.84 | 11.6 / 13.7 |
| 100k, **500k** edges, 4k | 1080p | 11.8 / 14.8 | 12.9 / 15.7 |
| 100k, **all ~1M** edges (999,349), 4k | 1080p | 23.9 / 24.3 | 25.0 / 25.7 |
| 100k, 150k, 4k, **8-segment** arcs | 1080p | 3.91 / 5.01 | 4.84 / 6.9 |

Scene generation, including sorting all edges by weight, took about 70 ms at 10k and about 0.9 s at 100k (1M edges) on the main thread. In the real app this work is done in workers.

## Reading the numbers

- **60 fps at 10k holds easily on this GPU.** Even with every edge drawn at 4K, GPU time is about 6 ms of a 16.7 ms budget. At 1080p with the 50k budget it is about 1.1 ms. If integrated graphics is ~8× slower on this fill/blend-bound load, 10k with a 50k budget at 1080p would still be ~9 ms. That is an extrapolation, not a measurement.
- **Edges are the cost.** At 10k, spheres plus ground plus territory take about 0.1 ms, and adding 50k edges takes it to about 1.1 ms. Edge cost is close to linear in edge count: about 0.022 ms per 1k edges at 1080p overview (50k ≈ 1.1–1.9 ms, 150k ≈ 3.7 ms, 500k ≈ 12 ms, 1M ≈ 24 ms).
- Cutting arc tessellation from 16 to 8 segments did not help (3.9 vs 3.7 ms). So edges are **fill/blend bound** (many overlapping translucent ribbons, each at least 0.9 px wide, with MSAA), not vertex bound.
- **At 100k, nothing breaks as long as edges stay budgeted.** 100k spheres alone take about 0.5–1 ms. The 150k edge budget gives about 3.8 ms at 1080p and about 10.5 ms at 4K. What would break is drawing all ~1M edges: about 24 ms GPU at 1080p, which is under 40 fps even on a 2080 Ti. The edge budget / LOD in §8.3 is therefore mandatory at L and also useful at M: the 10k repo already has ~99k edges.
- Particles are negligible at both 4k and 40k: within noise.
- Re-rendering the territory every frame ("hot") is within noise at both 10k and 100k (512² half-float target, 3r footprints).
- `gl_FragDepth` (true sphere depth) costs about 0.1 ms at 10k, within noise. Keep it.
- The extra corona draw (`split=1`) costs about 0.1 ms, also within noise.
- At 4K, the CPU-side `readPixels` sync dominates the CPU column, so use the GPU column there.

## What to degrade first at 100k (on this evidence)

1. **Edge budget and edge LOD.** This is the only thing that scales badly. Cap file↔file edges at about 50k–150k, and add city/district ribbons (§8.3) for the rest. Edges are fill-bound, so also consider narrower minimum pixel width and lower opacity at far zoom, or skip MSAA on the edge pass, rather than fewer segments.
2. **Pixel ratio.** 4K roughly triples the cost of an edge-heavy frame (3.8 → 10.5 ms).
3. Particles, corona and territory resolution matter little for frame time. The §8.5 order (particles first) is harmless but buys almost nothing here. For this renderer the order should be **edge budget, then pixel ratio, then the rest**. This conflicts with §8.5, which lists edge budget last.

## Visual-approach findings

- **Single-draw corona has a real depth artifact.** With body and corona in one draw (plan §8.1/§8.6) and depth writes on, a corona's translucent halo writes depth and cuts **white crescents** out of any sphere behind it that is drawn later. This is very visible inside dense districts: see `closeup-10k-single-draw-corona-artifact.png`. Fix used here: two draws over the same instanced geometry and data textures. The body pass discards outside r=1 and writes depth; the corona pass has depth writes off, collapses non-glowing instances to degenerate quads in the vertex shader, and is drawn after the bodies. See `closeup-10k-split.png`. Cost: within noise. **Recommendation: change §8.6 from "still one draw call" to "two draws over one instance buffer".** The alternative, per-frame sorting of 10k–100k instances, is worse.
- **The white-hot core reads as a specular highlight, not a star.** On a white background, a white centre on a coloured ball looks like a glossy marble (see the close-ups). To read as emitted light, it probably needs a slightly larger, warmer (yellow-white) core with a visible gradient into a **brighter-than-body** ring of the type colour, plus a soft darker rim. Otherwise the "star" metaphor relies entirely on the corona and ground light.
- **The corona barely shows on white.** A tinted halo at about 0.55 alpha that falls off quadratically is a faint coloured haze around the top 30% of spheres. It is noticeable up close and invisible at overview zoom. Ground light (not built here) and a stronger, more saturated near-silhouette band will matter more than the halo.
- **Edges dominate the picture at 10k.** At overview zoom, 50k translucent arcs form a coloured canopy over everything. City and district structure is readable, but the territory fill on the ground is hidden beneath it. This supports the §8.3 LOD (city ribbons far out, file edges only near), as a readability fix even more than a performance fix. Pulses show as short brighter dashes. Direction is readable up close but not at overview.
- Ground grid and vignette: fine. Territory tint and contours: visible when looking along the ground, mostly covered by edges from the overview.
- Fixed during the spike: arcs passing near the camera became wide translucent bands. Ribbon width is now clamped to 0.9–3 px.

## What was not measured

- **Integrated graphics** (the actual §15 target). Every number here is from an RTX 2080 Ti.
- **Real rAF frame pacing / vsync behaviour**, because the pane was hidden and then backgrounded (see Method). The sync benchmark measures cost, not delivered frame rate or jank from compositing, GC or main-thread work.
- The `rAF`-loop timings (`__bench`) that were captured only reflect throttling: about 20 fps while the tab was active but the pane was hidden, and zero frames once the tab was backgrounded.
- Interaction cost: hover, picking, DOM pills, burst particles, POI beams, ground light, Voronoi edges, district ids in the territory texture, the minimum-size slider, overlays.
- Not built: edge LOD ribbons, adaptive pixel ratio. Districts are not tagged in the territory pass (only cities).
- Physics or worker uploads competing with rendering (a texture re-upload per sim tick at 100k).
- Memory and upload size, and context-loss behaviour.
- A different camera path: only an overview orbit and one close static framing were used.

## Files

- `main.ts`: the scene. URL params: `n`, `edges`, `particles`, `terr`, `terrHot`, `fd`, `split`, `orbit`, `dist`, `seg`, `dpr`, `seed`. Exposes `__benchSync(frames, w, h, dpr)`, `__bench(sec)` (rAF) and `__snap(name)`.
- `index.html`, `vite.config.ts`. Run from `spikes/` with `npx vite --config render/vite.config.ts`, then open `http://localhost:5181/?n=10000&edges=50000&split=1`. The config includes a dev-only `/__save` endpoint used to write screenshots into this folder.
- `screenshot-10k.png`: overview at 10k, 50k edges.
- `closeup-10k-split.png`: close view with the two-draw corona.
- `closeup-10k-single-draw-corona-artifact.png`: the same view with the plan's single draw, showing the crescent artifact.
