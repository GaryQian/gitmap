// Per-force cost at the file tier: time 150 ticks of each district's file sim with one force removed.
import { generate } from "./graph.ts";
import { Layout } from "./layout.ts";
const n = Number(process.argv[2] ?? 10000);
for (const drop of ["none", "collide", "link", "radial", "contain", "all-but-collide"]) {
  const L = new Layout(generate({ files: n, seed: 1 }));
  const sims = L.files.map((f) => f.sim);
  for (const s of sims) {
    if (drop === "all-but-collide") { s.force("link", null); s.force("radial", null); s.force("contain", null); }
    else if (drop !== "none") s.force(drop, null);
  }
  const t = performance.now();
  for (const s of sims) Layout.runToRest(s);
  console.log(`${n} files, without ${drop}: ${(performance.now() - t).toFixed(0)} ms`);
}
