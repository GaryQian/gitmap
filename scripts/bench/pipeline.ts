// Pipeline benchmark (IMPLEMENTATION.md 6E): the whole headless pipeline on local repos, timed per
// stage. It runs parse → resolve → cluster → settle exactly as "npm run parse" does, a few times
// per repo, and prints the median of each stage with the size of the result. Nothing fails on a
// threshold: the numbers are for comparing machines and for comparing before and after a change.
//
// Usage: node scripts/run.mjs scripts/bench/pipeline.ts <repo folder> [more folders…]
//          [--runs n]      runs per repo (default 3; the first also warms the OS file cache)
//          [--workers n]   simulated workers of the in-process pool (default 1)
//          [--json file]   also write the raw numbers as JSON
// These are single-process Node numbers. The browser adds worker start-up and File System Access
// reads and spreads the parse over the pool; see spikes/fsa and plan/M0-RESULTS.md for those.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config';
import { runHeadless } from '../../src/pipeline/node';

interface Run {
  totalMs: number;
  stages: Record<string, number>;
  files: number;
  units: number;
  edges: number;
  cities: number;
  districts: number;
  largestDistrict: number;
  largestCity: number;
  structure: string;
  settleMs: number;
  atRest: boolean;
  overlapShare: number;
  importsResolved: number;
  importsTotal: number;
}

const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const ms = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);

async function once(rootPath: string, workers: number): Promise<Run> {
  const t0 = performance.now();
  const result = await runHeadless({ kind: 'directory', locator: { kind: 'node', rootPath } }, config, { workers });
  const totalMs = performance.now() - t0;
  const { model, state } = result;
  const districtCity = new Map(model.tables.district.ids.map((id, i) => [id, model.tables.district.cols.city![i]]));
  const perDistrict = new Map<string, number>(), perCity = new Map<string, number>();
  for (const d of model.tables.unit.cols.district!) {
    perDistrict.set(d, (perDistrict.get(d) ?? 0) + 1);
    const c = districtCity.get(d) ?? '';
    perCity.set(c, (perCity.get(c) ?? 0) + 1);
  }
  const run: Run = {
    totalMs,
    stages: { ...state.timings },
    files: model.meta.stats.files, units: model.meta.stats.units, edges: model.meta.stats.edges,
    cities: model.tables.city.ids.length, districts: model.tables.district.ids.length,
    largestDistrict: Math.max(0, ...perDistrict.values()), largestCity: Math.max(0, ...perCity.values()),
    structure: model.meta.structure,
    settleMs: state.settle?.ms ?? 0, atRest: state.settle?.atRest ?? true, overlapShare: state.settle?.overlapShare ?? 0,
    importsResolved: state.analysis?.diagnostics.importsResolved ?? 0, importsTotal: state.analysis?.diagnostics.importsTotal ?? 0,
  };
  result.dispose();
  return run;
}

export default async function main(args: string[]): Promise<void> {
  const flag = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const valued = new Set(['--runs', '--workers', '--json']);
  const repos = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  if (!repos.length) throw new Error('usage: node scripts/run.mjs scripts/bench/pipeline.ts <repo folder> [more…] [--runs n] [--workers n] [--json file]');
  const runs = Math.max(1, Number(flag('runs', '3')));
  const workers = Math.max(1, Number(flag('workers', '1')));
  const all: Record<string, Run[]> = {};

  for (const repo of repos) {
    const rootPath = path.resolve(repo);
    const name = path.basename(rootPath);
    const results: Run[] = [];
    for (let k = 0; k < runs; k++) {
      results.push(await once(rootPath, workers));
      console.log(`  ${name} run ${k + 1}/${runs}: ${ms(results[k].totalMs)}`);
    }
    all[name] = results;
    const last = results[results.length - 1];
    const stageNames = [...new Set(results.flatMap((r) => Object.keys(r.stages)))];
    console.log(`${name}: ${last.files.toLocaleString('en-US')} files, ${last.edges.toLocaleString('en-US')} edges, structure ${last.structure}`);
    console.log(`  total (median of ${runs}): ${ms(median(results.map((r) => r.totalMs)))}`);
    console.log(`  stages: ${stageNames.map((s) => `${s} ${ms(median(results.map((r) => r.stages[s] ?? 0)))}`).join(' · ')}`);
    console.log(`  imports resolved: ${last.importsResolved.toLocaleString('en-US')} / ${last.importsTotal.toLocaleString('en-US')}`);
    console.log(`  cities ${last.cities} (largest ${last.largestCity.toLocaleString('en-US')} files) · districts ${last.districts} (largest ${last.largestDistrict.toLocaleString('en-US')} files)`);
    console.log(`  settle ${ms(median(results.map((r) => r.settleMs)))} · at rest ${last.atRest} · overlap ${(last.overlapShare * 100).toFixed(1)}%`);
  }

  const jsonFile = flag('json', '');
  if (jsonFile) {
    mkdirSync(path.dirname(path.resolve(jsonFile)), { recursive: true });
    writeFileSync(jsonFile, JSON.stringify({ at: new Date().toISOString(), node: process.version, runs, workers, results: all }, null, 1));
    console.log(`wrote ${jsonFile}`);
  }
}
