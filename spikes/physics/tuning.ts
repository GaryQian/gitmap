// Is the residual overlap a tuning problem? Vary radial strength and packing (grid collide, spiral init).
import { buildAndSettle } from "./experiments.ts";
import { CFG } from "./layout.ts";
const n = Number(process.argv[2] ?? 10000);
for (const [base, packing, ticks] of [[0.1, 0.5, 150], [0.02, 0.5, 150], [0.1, 0.35, 150], [0.02, 0.35, 150], [0.02, 0.35, 300]] as const) {
  CFG.file.baseStrength = base; CFG.packing = packing;
  const { report: r } = buildAndSettle(n, 1, { init: "spiral", collide: "grid", fileTicks: ticks });
  const q = r.quality;
  console.log(`${n}\tradial base ${base}\tpacking ${packing}\tticks ${ticks}\tfile ${r.settle.file.ms.toFixed(0)} ms\toverlap nodes ${q.fileOverlapNodePct.toFixed(2)}% depth ${q.fileMeanOverlapDepthPct.toFixed(1)}%\tresid v/r ${q.fileMeanResidualSpeedPerRadius.toFixed(4)}`);
}
