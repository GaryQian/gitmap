// Headless settle + incremental-add benchmark. Run: npx tsx physics/bench-node.ts [sizes...]
import { buildAndSettle, incrementalAdd, pickDistrict } from "./experiments.ts";

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const list = sizes.length ? sizes : [1000, 10000, 100000];
const out: any[] = [];
for (const n of list) {
  const { L, report } = buildAndSettle(n);
  const s = report.settle;
  console.log(`\n== ${n} files  (${report.districts} districts, ${report.fileEdges} intra-district edges, files/district ${report.minFilesPerDistrict}..${report.maxFilesPerDistrict})`);
  console.log(`gen ${report.genMs.toFixed(0)} ms, build sims ${report.buildMs.toFixed(0)} ms`);
  console.log(`settle: city ${s.city.ms.toFixed(1)} ms (${s.city.ticks} ticks) | district ${s.district.ms.toFixed(1)} ms (${s.district.ticks} ticks, ${s.district.sims} sims) | file ${s.file.ms.toFixed(1)} ms (${s.file.ticks} ticks, ${s.file.sims} sims, slowest sim ${s.file.maxSimMs.toFixed(1)} ms) | total ${s.totalMs.toFixed(0)} ms`);
  console.log("quality", report.quality, "checksum", report.checksum, "timer tick events", report.timerTickEvents);
  const d = pickDistrict(L);
  const add = incrementalAdd(L, d, 200, "plan");
  console.log("add(plan)", JSON.stringify(add));
  // stable-mode on a fresh layout
  const { L: L2 } = buildAndSettle(n);
  const add2 = incrementalAdd(L2, d, 200, "stable");
  console.log("add(stable)", JSON.stringify(add2));
  out.push({ report, add, add2 });
}
// d3-timer leaves nothing pending? If the process hangs here, a timer is still alive.
const t = performance.now();
process.on("exit", () => console.log(`\nprocess exit ${(performance.now() - t).toFixed(0)} ms after last line`));
import("node:fs").then((fs) => fs.writeFileSync(new URL("./results-node.json", import.meta.url), JSON.stringify(out, null, 1)));
