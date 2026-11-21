// Isolate forceCollide cost: N nodes in one sim, 150 ticks, uniform vs heavy-tailed radii.
import { forceSimulation, forceCollide } from "d3-force";
import { mulberry32, fileRadiusFromU } from "./graph.ts";
for (const N of [100, 1000, 5000]) for (const kind of ["uniform r=3", "skewed 0.6..12", "skewed, iterations=1, packed loose"]) {
  const rnd = mulberry32(1);
  const nodes = Array.from({ length: N }, () => ({ r: kind.startsWith("uniform") ? 3 : fileRadiusFromU(rnd()), x: 0, y: 0 }));
  let a = 0; for (const n of nodes) a += (n.r + 0.5) ** 2;
  const R = Math.sqrt(a / (kind.includes("loose") ? 0.2 : 0.5));
  for (const n of nodes) { const t = rnd() * 6.283, rr = Math.sqrt(rnd()) * R * 0.7; n.x = Math.cos(t) * rr; n.y = Math.sin(t) * rr; }
  const s = forceSimulation(nodes as any).velocityDecay(0.6).force("c", forceCollide((n: any) => n.r + 0.5)).stop();
  const t0 = performance.now(); s.tick(150);
  const ms = performance.now() - t0;
  console.log(`N=${N} ${kind}: ${ms.toFixed(1)} ms / 150 ticks = ${(ms * 1000 / 150 / N).toFixed(2)} us per node-tick`);
}
