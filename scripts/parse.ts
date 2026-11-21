// Run the pipeline headless on a local folder and write a snapshot.
// Usage: npm run parse -- <repo folder> [out.gitmap.json.gz] [--synthetic N]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import type { RepoSource } from '../src/contracts/pipeline';
import { encodeModel } from '../src/model';
import { runHeadless } from '../src/pipeline/node';

export default async function main(args: string[]): Promise<void> {
  const synthetic = args.indexOf('--synthetic');
  const positional = args.filter((a, i) => !a.startsWith('--') && (synthetic < 0 || i !== synthetic + 1));
  let source: RepoSource;
  let name: string;
  if (synthetic >= 0) {
    const files = Number(args[synthetic + 1] ?? 1000);
    source = { kind: 'synthetic', files };
    name = `synthetic-${files}`;
  } else {
    if (!positional[0]) throw new Error('usage: npm run parse -- <repo folder> [out.gitmap.json.gz]');
    const rootPath = path.resolve(positional[0]);
    source = { kind: 'directory', locator: { kind: 'node', rootPath } };
    name = path.basename(rootPath);
  }
  const out = path.resolve(positional[synthetic >= 0 ? 0 : 1] ?? `out/${name}.gitmap.json.gz`);

  const t0 = performance.now();
  let lastStage = '';
  const result = await runHeadless(source, config, {
    onEvent(evt, payload) {
      if (evt === 'stage') {
        const s = payload as { stage: string; label: string };
        if (s.stage !== lastStage) { lastStage = s.stage; console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s] ${s.stage} ${s.label}`); }
      } else if (evt === 'notice') console.log('notice:', JSON.stringify(payload));
    },
  });
  const { model, state } = result;
  const bytes = await encodeModel(model);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  const s = model.meta.stats;
  console.log(`${model.meta.name}: ${s.files} files, ${s.units} units, ${s.edges} edges, ${model.tables.city.ids.length} cities, ${model.tables.district.ids.length} districts`);
  console.log(`structure: ${model.meta.structure}; timings (ms): ${Object.entries(state.timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`);
  if (state.settle) console.log(`settle: ${state.settle.ms.toFixed(0)} ms, ${state.settle.ticks} ticks, at rest ${state.settle.atRest}, overlap ${(state.settle.overlapShare * 100).toFixed(1)}%`);
  if (state.analysis) console.log(`imports resolved: ${state.analysis.diagnostics.importsResolved} / ${state.analysis.diagnostics.importsTotal}`);
  console.log(`wrote ${out} (${(bytes.length / 1024).toFixed(0)} KB) in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  result.dispose();
}
