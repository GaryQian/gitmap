// What clustering.pathBias does to a real repo: the whole headless pipeline is run once per bias
// value and the resulting cities are measured two ways.
//
//   together   how well directories are kept in one city. For every directory at that depth holding
//              at least MIN files, the share of its files in its most common city; file-weighted mean.
//   kept       how much of the dependency structure the cities still respect: the share of code-edge
//              weight (weight × confidence, unbiased) whose two ends are in the same city.
//
// A higher bias should raise `together`; the cost shows up as a lower `kept`.
//
// Usage: node scripts/run.mjs scripts/bench/pathbias.ts <repo folder> [more folders…] [--bias 0,0.5,1,2,4]
//          [--key pathBias|mergePathBias]   which clustering value to vary (default pathBias); the other stays as configured
import path from 'node:path';
import { config } from '../../src/config';
import { runHeadless } from '../../src/pipeline/node';

const MIN = 8;

export default async function main(args: string[]): Promise<void> {
  const at = args.indexOf('--bias');
  const biases = (at >= 0 ? args[at + 1] : '0,0.5,1,2,4').split(',').map(Number);
  const keyAt = args.indexOf('--key');
  const key = keyAt >= 0 ? args[keyAt + 1] : 'pathBias';
  if (!(key in config.clustering)) throw new Error(`--key must be a clustering value; got ${key}`);
  const repos = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1) && (keyAt < 0 || i !== keyAt + 1));
  if (!repos.length) throw new Error('usage: node scripts/run.mjs scripts/bench/pathbias.ts <repo folder> [--bias 0,1,2]');

  for (const repo of repos) {
    const rootPath = path.resolve(repo);
    console.log(`\n${path.basename(rootPath)}   (varying clustering.${key})`);
    console.log('bias   cities  largest  together@1  together@2  together@3  kept(city)  kept(district)  districts');
    for (const pathBias of biases) {
      const cfg = { ...config, clustering: { ...config.clustering, [key]: pathBias } };
      const { model } = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath } }, cfg, { history: false });
      const t = model.tables;
      const cityOfDistrict = new Map(t.district.ids.map((id, i) => [id, t.district.cols.city![i]]));
      const district = new Map(t.unit.ids.map((id, i) => [id, t.unit.cols.district![i]]));
      const city = new Map(t.unit.ids.map((id) => [id, cityOfDistrict.get(district.get(id)!)!]));

      const sizes = new Map<string, number>();
      for (const c of city.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
      const largest = Math.max(...sizes.values()) / t.unit.ids.length;

      const together = (depth: number): number => {
        const byDir = new Map<string, Map<string, number>>();
        for (const id of t.unit.ids) {
          const parts = id.split('/');
          if (parts.length - 1 < depth) continue;
          const dir = parts.slice(0, depth).join('/');
          let m = byDir.get(dir);
          if (!m) byDir.set(dir, (m = new Map()));
          const c = city.get(id)!;
          m.set(c, (m.get(c) ?? 0) + 1);
        }
        let inModal = 0, all = 0;
        for (const m of byDir.values()) {
          let n = 0, top = 0;
          for (const v of m.values()) { n += v; if (v > top) top = v; }
          if (n < MIN) continue;
          inModal += top; all += n;
        }
        return all ? inModal / all : NaN;
      };

      let total = 0, sameCity = 0, sameDistrict = 0;
      const e = t.edge.cols;
      for (let i = 0; i < t.edge.ids.length; i++) {
        const w = e.weight![i] * e.confidence![i];
        total += w;
        if (city.get(e.src![i]) === city.get(e.dst![i])) sameCity += w;
        if (district.get(e.src![i]) === district.get(e.dst![i])) sameDistrict += w;
      }

      const f = (x: number) => (Number.isNaN(x) ? '   –  ' : x.toFixed(3).padStart(6));
      console.log(
        `${String(pathBias).padEnd(6)} ${String(t.city.ids.length).padStart(6)}  ${f(largest)}   ${f(together(1))}      ${f(together(2))}      ${f(together(3))}      ${f(sameCity / total)}      ${f(sameDistrict / total)}        ${String(t.district.ids.length).padStart(5)}`,
      );
    }
  }
}
