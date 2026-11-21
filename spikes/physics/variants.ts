// Settle variants at the file tier + reheat control. Run: npx tsx physics/variants.ts 10000
import { buildAndSettle, incrementalAdd, pickDistrict } from "./experiments.ts";
import type { LayoutOpts } from "./layout.ts";
const n = Number(process.argv[2] ?? 10000);
const only = process.argv[3];
const variants: [string, LayoutOpts][] = [
  ["baseline (jitter, d3 collide, 150 ticks)", {}],
  ["spiral init, d3 collide, 150", { init: "spiral" }],
  ["jitter, grid collide, 150", { collide: "grid" }],
  ["spiral, grid collide, 150", { init: "spiral", collide: "grid" }],
  ["spiral, grid collide, 60 ticks", { init: "spiral", collide: "grid", fileTicks: 60 }],
  ["spiral, d3 collide, 60 ticks", { init: "spiral", fileTicks: 60 }],
];
for (const [name, o] of variants) {
  if (only && !name.includes(only)) continue;
  const { report: r } = buildAndSettle(n, 1, o);
  const q = r.quality;
  console.log(`${n}\t${name}\tfile ${r.settle.file.ms.toFixed(0)} ms (slowest sim ${r.settle.file.maxSimMs.toFixed(0)})\ttotal ${r.settle.totalMs.toFixed(0)} ms\toverlap nodes ${q.fileOverlapNodePct.toFixed(2)}% depth ${q.fileMeanOverlapDepthPct.toFixed(1)}%\toutside ${q.fileOutsideDistrictPct.toFixed(2)}%\tresid v/r ${q.fileMeanResidualSpeedPerRadius.toFixed(4)}`);
}
if (!only || only === "reheat") {
  // control: reheat with ZERO added nodes -> how much does a settled layout move just from reheating?
  const { L } = buildAndSettle(n, 1, { init: "spiral" });
  const d = pickDistrict(L);
  console.log("reheat-only control (spiral):", JSON.stringify(incrementalAdd(L, d, 0, "stable")));
  const { L: L2 } = buildAndSettle(n, 1, { init: "spiral" });
  console.log("add 200 (spiral, stable):", JSON.stringify(incrementalAdd(L2, d, 200, "stable")));
  const { L: L3 } = buildAndSettle(n);
  console.log("reheat-only control (baseline):", JSON.stringify(incrementalAdd(L3, d, 0, "stable")));
}
