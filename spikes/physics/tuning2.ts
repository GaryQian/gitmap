// Is overlap caused by hub links? Vary sizeVsConnectivity (1.0 = no link pull).
import { buildAndSettle } from "./experiments.ts";
import { CFG } from "./layout.ts";
const n = Number(process.argv[2] ?? 10000);
for (const w of [0.5, 0.8, 1.0]) {
  CFG.file.sizeVsConnectivity = w;
  const { report: r } = buildAndSettle(n, 1, { init: "spiral", collide: "grid" });
  const q = r.quality;
  console.log(`${n}\tsizeVsConnectivity ${w}\tfile ${r.settle.file.ms.toFixed(0)} ms\toverlap nodes ${q.fileOverlapNodePct.toFixed(2)}% depth ${q.fileMeanOverlapDepthPct.toFixed(1)}%\tresid v/r ${q.fileMeanResidualSpeedPerRadius.toFixed(4)}`);
}
